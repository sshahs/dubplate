// Orchestrates interpret → scour → score for batches of tracks.

import { riskOf } from "../shared/risk"
import type { AiParse, Candidate, Settings, Track, TrackStatus } from "../shared/types"
import { interpretTrack } from "./ai/interpreter"
import { escalate, shouldEscalate } from "./ai/escalation"
import { overBudget } from "./ai/usage"
import { checkCover, coverInDoubt } from "./ai/vision"
import { analyseTrack, needsAnalysis } from "./analysis"
import { handsOff } from "./autopilot"
import { findArtwork } from "./art"
import { canonicalGenre } from "./genres"
import { lyricsForTrack, needsLyrics } from "./lyrics"
import { scoreTrack } from "./core/confidence"
import { parseFilename } from "./core/filename-parser"
import { decisionToFinal } from "./core/naming"
import { proposedFilename } from "./executor"
import type { JobContext } from "./jobs"
import { mapLimit } from "./jobs"
import { settingsForLibrary } from "./library-settings"
import { settingsNow, settingsSaves } from "./settings"
import { aliasMap, getTrack, identifiedTwin, knownArtists, listCorrections, statusCounts, updateTrack } from "./repo"
import { acoustidLookup, findFpcalc, fingerprintFile } from "./sources/acoustid"
import { folderContext } from "./scanner"
import { genreBoost, scourTrack, SourceBreaker } from "./sources"

/** Statuses a human set - automated passes must not overwrite them. */
const HUMAN_STATUSES: TrackStatus[] = ["approved", "done", "rejected"]

/** Sources whose hits back others up but never confirm a track alone (scrapers marked so). */
export function supportingSources(settings: Settings): Set<string> {
  return new Set(settings.scrapers.filter((s) => s.supportingOnly).map((s) => `scraper:${s.id}`))
}

/** Each source's trust weight, a little higher for sources that suit the crates' genres. */
export function weightsFrom(settings: Settings): Record<string, number> {
  const w: Record<string, number> = {}
  for (const [id, cfg] of Object.entries(settings.sources)) w[id] = Math.min(1.5, cfg.weight * genreBoost(settings, id))
  for (const s of settings.scrapers) w[`scraper:${s.id}`] = Math.min(1.5, s.weight * genreBoost(settings, `scraper:${s.id}`))
  return w
}

/** The AI reading to score with: a second model's, when there is one, with the first model's as an alternative. */
function readingForScore(track: Track): AiParse | null {
  const e = track.escalation
  if (!e) return track.ai
  const first = track.ai
  const alt = first && (first.title || first.artists.length) ? [{ artists: first.artists, title: first.title }] : []
  return { ...e.ai, alternatives: [...e.ai.alternatives, ...alt].slice(0, 5) }
}

export function scoreAndSave(track: Track, settings: Settings): Track {
  const decision = scoreTrack({
    heuristic: track.heuristic,
    ai: readingForScore(track),
    tags: track.tags,
    candidates: track.candidates ?? [],
    duration: track.duration,
    weights: weightsFrom(settingsForLibrary(settings, track.libraryId)),
    thresholds: settings.confidence,
    context: { filename: track.filename, folders: folderContext(track.relDir), preferOwnRelease: settings.confidence.preferOwnRelease },
    supporting: supportingSources(settings),
  })
  if (track.escalation) {
    const { ai: _ai, ...e } = track.escalation
    decision.escalated = e
    // An escalated track always goes to a person.
    if (decision.status === "matched") decision.status = "review"
  }
  const keepStatus = HUMAN_STATUSES.includes(track.status)
  let status: TrackStatus = keepStatus ? track.status : decision.status
  let final = track.final
  let approvedBy = track.approvedBy
  // Auto-approve only acts on low-risk tracks: confidence and risk are separate questions.
  if (!keepStatus && settings.confidence.autoApprove && decision.status === "matched" && riskOf({ ...track, decision }).level === "low") {
    status = "approved"
    final = decisionToFinal(decision)
    approvedBy = "auto"
  }
  decision.canonicalGenre = canonicalGenre({ ...track, final }, decision, settings)
  const next: Track = { ...track, decision, confidence: decision.confidence, status, final, approvedBy }
  next.proposedName = proposedFilename(next, settings)
  updateTrack(track.id, { decision, confidence: decision.confidence, status, final, approvedBy, proposedName: next.proposedName })
  return next
}

export interface ProcessOptions {
  interpret: boolean
  scour: boolean
  force: boolean
  /** ask the sources again even where a track already has their answers (a scraper switched on since, say), without redoing the rest */
  rescour?: boolean
}

/**
 * The settings a run started with, with the sources as they are now: a source
 * or scraper switched on, off or fixed mid-run counts from the next track.
 */
export function liveSources(start: Settings, changed: (names: string[]) => void): () => Settings {
  let seen = settingsSaves()
  let current = start
  const on = (s: Settings) => new Set([...Object.entries(s.sources).filter(([, c]) => c.enabled).map(([id]) => id), ...s.scrapers.filter((x) => x.enabled).map((x) => `scraper:${x.id}`)])
  return () => {
    if (settingsSaves() === seen) return current
    seen = settingsSaves()
    const now = settingsNow()
    const before = on(current)
    const added = [...on(now)].filter((id) => !before.has(id))
    current = { ...current, sources: now.sources, scrapers: now.scrapers }
    if (added.length) changed(added.map((id) => now.scrapers.find((x) => `scraper:${x.id}` === id)?.name ?? id))
    return current
  }
}

export async function processTracks(ids: number[], startSettings: Settings, opts: ProcessOptions, ctx: JobContext) {
  ctx.setTotal(ids.length)
  const sourcesNow = liveSources(startSettings, (names) => ctx.log("info", `Switched on mid-run, asked from the next track: ${names.join(", ")}`))
  let settings = startSettings
  const corrections = listCorrections()
  const aliases = aliasMap()
  const known = knownArtists()
  let aiFailures = 0
  let lastAiError = ""
  let aiDisabled = false
  const changed: number[] = []
  const breaker = new SourceBreaker()
  let sharedCount = 0
  let skippedAi = 0
  let escalatedCount = 0

  const concurrency = opts.interpret ? Math.max(1, settings.llm.concurrency) : 3
  await mapLimit(ids, concurrency, ctx.signal, async (id) => {
    let track = getTrack(id)
    if (!track || track.missing) {
      ctx.tick(false)
      return
    }
    settings = sourcesNow()
    try {
      // Rule-based pass is cheap; refresh it so new aliases/corrections apply.
      const heuristic = parseFilename(track.filename, { folders: folderContext(track.relDir), tagArtist: track.tags.artist, knownArtists: known })
      track = { ...track, heuristic }
      updateTrack(id, { heuristic })

      // Identifying again from scratch: an earlier second opinion no longer applies.
      if (opts.force && opts.interpret && track.escalation) {
        updateTrack(id, { escalation: null })
        track = { ...track, escalation: null }
      }

      // The same audio (another copy of the file) is identified once: reuse what it found.
      let reused = false
      const scourAgain = opts.force || !!opts.rescour
      if (!scourAgain && !track.candidates) {
        const twin = identifiedTwin(track)
        if (twin) {
          const shared = { ai: twin.ai, candidates: twin.candidates, fingerprint: twin.fingerprint ?? track.fingerprint, escalation: twin.escalation }
          updateTrack(id, shared)
          track = { ...track, ...shared }
          reused = true
          sharedCount++
        }
      }

      // Fingerprint first: when the audio's already known, the AI has nothing to add.
      const pre: Partial<Record<string, Candidate[]>> = {}
      let fpStrong: Candidate | undefined
      const acoustidKey = settings.sources.acoustid?.apiKey
      if (!reused && opts.scour && (scourAgain || !track.candidates) && settings.sources.acoustid?.enabled && acoustidKey && findFpcalc()) {
        try {
          const fp = track.fingerprint ?? { ...(await fingerprintFile(track.path, ctx.signal)), at: new Date().toISOString() }
          if (!track.fingerprint) {
            updateTrack(id, { fingerprint: fp })
            track = { ...track, fingerprint: fp }
          }
          pre.acoustid = await acoustidLookup(fp, acoustidKey, ctx.signal)
          fpStrong = pre.acoustid.find((c) => (c.sourceScore ?? 0) >= 0.9 && c.ids?.mbRecordingId && c.title && c.artists?.length)
        } catch (err) {
          if (ctx.signal.aborted) return
          ctx.log("warn", `Fingerprint of ${track.filename}: ${err instanceof Error ? err.message : err}`)
        }
      }
      if (fpStrong && opts.interpret && !track.ai) skippedAi++

      if (!reused && !fpStrong && opts.interpret && !aiDisabled && (opts.force || !track.ai) && overBudget(settings)) {
        aiDisabled = true
        ctx.log("warn", `This month's AI budget (${settings.llm.currency}${settings.llm.monthlyBudget}) is used up - carrying on with the rule-based parser`)
      }
      if (!reused && !fpStrong && opts.interpret && !aiDisabled && (opts.force || !track.ai)) {
        try {
          const ai = await interpretTrack(track, settings, { corrections, aliases, signal: ctx.signal })
          track = { ...track, ai }
          const status = HUMAN_STATUSES.includes(track.status) ? track.status : "interpreted"
          updateTrack(id, { ai, status })
          track.status = status
          aiFailures = 0
        } catch (err) {
          if (ctx.signal.aborted) return
          const message = err instanceof Error ? err.message : String(err)
          aiFailures = message === lastAiError ? aiFailures + 1 : 1
          lastAiError = message
          ctx.log("warn", `AI could not read ${track.filename}: ${message}`)
          // Same error three times in a row = config problem, not the file.
          if (aiFailures >= 3) {
            aiDisabled = true
            ctx.log("error", `Stopping AI for this run after repeated errors - continuing with the rule-based parser. (${message})`)
          }
        }
      }

      if (!reused && opts.scour && (scourAgain || !track.candidates)) {
        // A strong fingerprint match names the recording; the other sources check that reading.
        const reading = fpStrong
          ? { artists: fpStrong.artists ?? [fpStrong.artist], featuring: [], title: fpStrong.title, version: track.heuristic?.version }
          : track.ai?.title || track.ai?.artists.length
            ? track.ai
            : track.heuristic
        if (reading) {
          const result = await scourTrack(track, reading, settings, track.ai?.searchQueries ?? [], ctx.signal, breaker, pre)
          for (const e of result.errors) ctx.log("warn", `${e.source}: ${e.message}`)
          for (const s of result.tripped) ctx.log("error", `${s} keeps failing - skipping it for the rest of this run`)
          track = { ...track, candidates: result.candidates }
          updateTrack(id, { candidates: result.candidates, status: HUMAN_STATUSES.includes(track.status) ? track.status : "scoured" })
        }
      }

      if (ctx.signal.aborted) return
      let scored = scoreAndSave(track, settings)

      // Uncertain (a middle score, or sources in conflict): a second model reads it, and a person decides.
      const why = opts.interpret && !aiDisabled && !overBudget(settings) ? shouldEscalate(scored, settings) : null
      if (why) {
        try {
          let up = await escalate(scored, why, settings, { corrections, aliases, signal: ctx.signal })
          updateTrack(id, { escalation: up.escalation })
          // Read differently: check the new reading with the sources too.
          if (up.escalation?.changed && opts.scour) {
            const result = await scourTrack(up, up.escalation.ai, settings, up.escalation.ai.searchQueries, ctx.signal, breaker, pre)
            const seen = new Set((up.candidates ?? []).map((c) => `${c.source}|${c.externalId ?? c.url ?? c.title}`))
            const candidates = [...(up.candidates ?? []), ...result.candidates.filter((c) => !seen.has(`${c.source}|${c.externalId ?? c.url ?? c.title}`))]
            updateTrack(id, { candidates })
            up = { ...up, candidates }
          }
          scored = scoreAndSave(up, settings)
          escalatedCount++
        } catch (err) {
          if (ctx.signal.aborted) return
          ctx.log("warn", `Second model on ${track.filename}: ${err instanceof Error ? err.message : err}`)
        }
      }
      await extras(scored, settings, opts, ctx)
      changed.push(id)
      ctx.tick(true, `${scored.filename} → ${scored.confidence ?? 0}%`)
      if (changed.length % 10 === 0) ctx.tracksChanged(changed.slice(-10))
    } catch (err) {
      if (ctx.signal.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      ctx.log("error", `${track.filename}: ${message}`)
      updateTrack(id, { note: message })
      ctx.tick(false)
    }
  })
  ctx.tracksChanged(changed)
  if (sharedCount) ctx.log("info", `${sharedCount} track${sharedCount === 1 ? " was the same audio as one" : "s were the same audio as ones"} already identified - reused that`)
  if (skippedAi) ctx.log("info", `The audio fingerprint identified ${skippedAi} track${skippedAi === 1 ? "" : "s"} outright - no AI needed`)
  if (escalatedCount) ctx.log("info", `${escalatedCount} uncertain track${escalatedCount === 1 ? "" : "s"} went to ${settings.llm.escalation.model || "the second model"} - they wait in Review`)
  if (changed.length) {
    const c = statusCounts(changed)
    const review = c.review + c.conflict
    ctx.report({ identified: changed.length, matched: c.matched, approved: c.approved, review, unmatched: c.unmatched })
    ctx.message([c.matched && `${c.matched} matched`, c.approved && `${c.approved} approved`, review && `${review} to review`, c.unmatched && `${c.unmatched} unmatched`].filter(Boolean).join(" · "))
    // Hands-off libraries: the sure matches are cut straight away.
    if (!ctx.signal.aborted) {
      const cut = handsOff(changed, settings, ctx)
      if (cut.length) ctx.log("info", `Hands-off: ${cut.length} sure match${cut.length === 1 ? "" : "es"} approved${settings.safety.readOnly ? "" : " and queued to cut"}`)
    }
  }
}

/** The optional steps after scoring: cover art, lyrics and BPM/key. Failures only log. */
async function extras(track: Track, settings: Settings, opts: ProcessOptions, ctx: JobContext) {
  const wantArt = settings.artwork.fetch && opts.scour && (opts.force || !track.artFound) && (!track.art || settings.artwork.replaceExisting)
  if (wantArt && track.decision && track.decision.status !== "unmatched") {
    try {
      const art = await findArtwork(track, settings, ctx.signal)
      if (art && art.hash !== track.art?.hash) {
        // In doubt about the match: a vision model looks before it's embedded.
        const doubt = settings.llm.vision.enabled ? coverInDoubt(track) : null
        const check = doubt ? await checkCover(track, art, settings, ctx.signal).catch((err) => (ctx.log("warn", `Cover check for ${track.filename}: ${err instanceof Error ? err.message : err}`), null)) : null
        if (check && !check.matches && check.confidence >= 0.6) ctx.log("info", `${track.filename}: ${check.model} says the cover found isn't this release (${check.reason}) - not using it`)
        else updateTrack(track.id, { artFound: check ? { ...art, check } : art })
      }
    } catch (err) {
      if (!ctx.signal.aborted) ctx.log("warn", `Artwork for ${track.filename}: ${err instanceof Error ? err.message : err}`)
    }
  }
  const identified = track.decision && track.decision.status !== "unmatched"
  if (settings.lyrics.fetch && opts.scour && identified && (opts.force || needsLyrics(track))) {
    try {
      await lyricsForTrack(getTrack(track.id) ?? track, ctx.signal)
    } catch (err) {
      if (!ctx.signal.aborted) ctx.log("warn", `Lyrics for ${track.filename}: ${err instanceof Error ? err.message : err}`)
    }
  }
  if (settings.analysis.onProcess && needsAnalysis(track, settings, opts.force)) {
    try {
      await analyseTrack(track, settings)
    } catch (err) {
      if (!ctx.signal.aborted) ctx.log("warn", `Could not analyse ${track.filename}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

/** Find cover art for tracks (a job of its own, for tracks identified before artwork existed). */
export async function artworkTracks(ids: number[], settings: Settings, opts: { force: boolean }, ctx: JobContext) {
  ctx.setTotal(ids.length)
  const changed: number[] = []
  let found = 0
  await mapLimit(ids, 3, ctx.signal, async (id) => {
    const t = getTrack(id)
    if (!t || t.missing) return ctx.tick(false)
    if (!opts.force && (t.artFound || (t.art && !settings.artwork.replaceExisting))) return ctx.tick(true)
    try {
      const art = await findArtwork(t, settings, ctx.signal)
      if (art && art.hash !== t.art?.hash) {
        updateTrack(id, { artFound: art })
        changed.push(id)
        found++
        ctx.tick(true, `${t.filename} → cover from ${art.source}`)
      } else ctx.tick(true, `${t.filename} → no cover found`)
    } catch (err) {
      if (ctx.signal.aborted) return
      ctx.log("warn", `Artwork for ${t.filename}: ${err instanceof Error ? err.message : err}`)
      ctx.tick(false)
    }
  })
  ctx.tracksChanged(changed)
  ctx.log("success", `Found artwork for ${found} of ${ids.length} tracks`)
}

/** Re-score without touching the network (e.g. after changing thresholds or weights). */
export async function rescoreTracks(ids: number[], settings: Settings, ctx: JobContext) {
  ctx.setTotal(ids.length)
  const changed: number[] = []
  for (const id of ids) {
    if (ctx.signal.aborted) break
    const t = getTrack(id)
    if (!t) continue
    scoreAndSave(t, settings)
    changed.push(id)
    ctx.tick(true)
  }
  ctx.tracksChanged(changed)
}
