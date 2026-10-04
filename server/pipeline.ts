// Orchestrates interpret → scour → score for batches of tracks.

import { riskOf } from "../shared/risk"
import type { AiParse, Candidate, Settings, Track, TrackReading, TrackStatus } from "../shared/types"
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
import { checkCandidate, cleanCandidate, cleanFinal, hasMarkup } from "./core/plain-text"
import { checkFields, versionBacked } from "../shared/fields"
import { getDb } from "./db"
import { decisionToFinal, emptyish } from "./core/naming"
import { proposedFilename } from "./executor"
import type { JobContext } from "./jobs"
import { enqueueJob, forTrack, mapLimit } from "./jobs"
import { errorDetail } from "./logs"
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

const STATUS_WORD: Record<TrackStatus, string> = {
  new: "not read yet",
  interpreted: "read",
  scoured: "searched",
  matched: "matched",
  review: "needs a listen",
  conflict: "sources disagree",
  unmatched: "no match",
  approved: "approved",
  done: "cut",
  rejected: "left as it is",
  error: "error",
}

function readingText(r: Pick<TrackReading, "artists" | "featuring" | "title" | "version"> | null | undefined): string {
  if (!r || (!r.title && !r.artists.length)) return "(nothing)"
  const ft = r.featuring?.length ? ` ft. ${r.featuring.join(", ")}` : ""
  return `${r.artists.join(" & ") || "?"}${ft} - ${r.title || "?"}${r.version ? ` (${r.version})` : ""}`
}

const pct = (n: number) => `${Math.round(n * 100)}%`

/** How a track was read and decided, every step, for the log line's detail. */
export function decisionDetail(t: Track): string {
  const d = t.decision
  const lines = [`File:         ${t.path}`]
  lines.push(`Filename:     ${readingText(t.heuristic)}${t.heuristic ? ` (${pct(t.heuristic.confidence)} sure)` : ""}`)
  if (t.tags.artist || t.tags.title) lines.push(`Tags:         ${t.tags.artist ?? "?"} - ${t.tags.title ?? "?"}`)
  lines.push(`AI:           ${t.ai ? `${readingText(t.ai)} (${pct(t.ai.confidence)} sure, ${t.ai.model})` : "no reading"}`)
  if (t.ai?.reasoning) lines.push(`              "${t.ai.reasoning}"`)
  if (t.escalation) lines.push(`Second model: ${readingText(t.escalation.ai)} (${t.escalation.model}${t.escalation.changed ? ", read it differently" : ""}) - ${t.escalation.reason}`)
  const fp = t.candidates?.filter((c) => c.source === "acoustid") ?? []
  if (fp.length) lines.push(`Fingerprint:  ${fp[0].artist} - ${fp[0].title}${fp[0].sourceScore !== undefined ? ` (${pct(fp[0].sourceScore)})` : ""}`)
  lines.push(`Sources:      ${t.candidates?.length ?? 0} results from ${new Set(t.candidates?.map((c) => c.source)).size} sources`)
  if (d) {
    for (const c of d.clusters.slice(0, 3)) lines.push(`              ${c.artist} - ${c.title}: ${c.sources.join(", ")} (support ${c.support.toFixed(2)})`)
    const extra = [d.album && `album ${d.album}`, d.year && `year ${d.year}`, d.label && `label ${d.label}`, d.riddim && `riddim ${d.riddim}`, d.genre && `genre ${d.genre}`].filter(Boolean)
    lines.push(`Decided:      ${readingText(d)}${extra.length ? ` - ${extra.join(", ")}` : ""}`)
    lines.push(`Confidence:   ${d.confidence}% from ${d.basis} → ${STATUS_WORD[t.status]}`)
    for (const f of d.factors) lines.push(`              ${f.label}: ${pct(f.score)} × ${f.weight} - ${f.detail}`)
    for (const w of d.warnings) lines.push(`Warning:      ${w}`)
  }
  if (t.proposedName) lines.push(`New name:     ${t.proposedName}`)
  return lines.join("\n")
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
    // Hits stored before every source's answer was cleaned can still carry web page markup.
    candidates: (track.candidates ?? []).map(cleanCandidate),
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
  await mapLimit(ids, concurrency, ctx.signal, (id) =>
    forTrack(id, async () => {
      let track = getTrack(id)
      if (!track || track.missing) {
        ctx.tick(false)
        return
      }
      settings = sourcesNow()
      try {
        // Rule-based pass is cheap; refresh it so new aliases/corrections apply.
        const heuristic = parseFilename(track.filename, { folders: folderContext(track.relDir), tagArtist: track.tags.artist, tagAlbum: track.tags.album, knownArtists: known })
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
            ctx.log("debug", `${track.filename}: the same audio as "${twin.filename}" - reusing what was found for it`)
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
            ctx.log(
              "debug",
              fpStrong
                ? `${track.filename}: AcoustID knows the audio - ${fpStrong.artist} - ${fpStrong.title} (${pct(fpStrong.sourceScore ?? 0)})`
                : `${track.filename}: AcoustID ${pre.acoustid.length ? `has ${pre.acoustid.length} possible match${pre.acoustid.length === 1 ? "" : "es"}, none sure` : "doesn't know the audio"}`,
              { area: "sources" }
            )
          } catch (err) {
            if (ctx.signal.aborted) return
            ctx.log("warn", `Fingerprint of ${track.filename}: ${err instanceof Error ? err.message : err}`, { detail: errorDetail(err) })
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
            ctx.log("warn", `AI could not read ${track.filename}: ${message}`, { detail: errorDetail(err) })
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
            for (const e of result.errors) ctx.log("warn", `${e.source}: ${e.message}`, { area: "sources" })
            for (const s of result.tripped) ctx.log("error", `${s} keeps failing - skipping it for the rest of this run`, { area: "sources" })
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
            ctx.log("warn", `Second model on ${track.filename}: ${err instanceof Error ? err.message : err}`, { detail: errorDetail(err) })
          }
        }
        const d = scored.decision
        ctx.log("debug", `${scored.filename} → ${d ? `${readingText(d)} · ${d.confidence}%` : "nothing"} · ${STATUS_WORD[scored.status]}`, { detail: decisionDetail(scored) })
        await extras(scored, settings, opts, ctx)
        changed.push(id)
        ctx.tick(true, `${scored.filename} → ${scored.confidence ?? 0}%`)
        if (changed.length % 10 === 0) ctx.tracksChanged(changed.slice(-10))
      } catch (err) {
        if (ctx.signal.aborted) return
        const message = err instanceof Error ? err.message : String(err)
        ctx.log("error", `${track.filename}: ${message}`, { detail: errorDetail(err) })
        updateTrack(id, { note: message })
        ctx.tick(false)
      }
    })
  )
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
  await mapLimit(ids, 3, ctx.signal, (id) =>
    forTrack(id, async () => {
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
  )
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

const MARKUP_REPAIRED = "markupRepaired"
const MARKUP = ["%</%", "%&amp;%", "%&#%", "%&quot;%", "%&nbsp;%"]

/** Tracks whose stored hits, decision, approved details or file tags still carry web page markup. */
export function tracksWithMarkup(): number[] {
  const any = (col: string) => `(${MARKUP.map(() => `${col} LIKE ?`).join(" OR ")})`
  const rows = getDb()
    .prepare(`SELECT t.id FROM tracks t LEFT JOIN track_data d ON d.track_id = t.id WHERE ${any("d.candidates_json")} OR ${any("d.decision_json")} OR ${any("t.final_json")} OR ${any("t.tags_json")}`)
    .all(...MARKUP, ...MARKUP, ...MARKUP, ...MARKUP) as { id: number }[]
  return rows.map((r) => r.id)
}

/**
 * Before every source's answer was cleaned, a site's links could reach a track
 * (Riddim-ID sent "<a href=…>Linval Thompson</a>" as the artist). Their hits and
 * approved details are cleaned and decided again; files already cut with it are
 * named, for Update tags to put right.
 */
export async function repairMarkup(ids: number[], settings: Settings, ctx: JobContext) {
  ctx.setTotal(ids.length)
  const changed: number[] = []
  const cut: string[] = []
  for (const id of ids) {
    if (ctx.signal.aborted) return
    const t = getTrack(id)
    if (!t) {
      ctx.tick(false)
      continue
    }
    const candidates = t.candidates?.map(cleanCandidate) ?? null
    const final = t.final ? cleanFinal(t.final) : t.final
    const fixed = JSON.stringify(candidates) !== JSON.stringify(t.candidates) || JSON.stringify(final) !== JSON.stringify(t.final)
    if (fixed) {
      updateTrack(id, { candidates, final })
      if (t.decision || candidates?.length) scoreAndSave({ ...t, candidates, final }, settings)
      changed.push(id)
      ctx.log("debug", `Cleaned web page markup out of ${t.filename}`, { trackId: id })
    }
    if (t.status === "done" && Object.values(t.tags).some((v) => typeof v === "string" && hasMarkup(v))) cut.push(t.filename)
    ctx.tick(true)
  }
  ctx.tracksChanged(changed)
  if (changed.length) ctx.log("success", `Cleaned web page markup (links, "&amp;") out of ${changed.length} track${changed.length === 1 ? "'s" : "s'"} details`)
  if (cut.length) {
    ctx.log("warn", `${cut.length} file${cut.length === 1 ? " was" : "s were"} already cut with web page markup in ${cut.length === 1 ? "its" : "their"} tags - pick ${cut.length === 1 ? "it" : "them"} in Tracks and use Update tags to put it right`, {
      detail: cut.join("\n"),
    })
  }
  getDb().prepare("INSERT INTO settings (key, value_json) VALUES (?, 'true') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(MARKUP_REPAIRED)
}

/** Once, after the upgrade that cleans every source's answer: put right what came in before. */
export function repairMarkupOnce(): void {
  if (getDb().prepare("SELECT 1 FROM settings WHERE key = ?").get(MARKUP_REPAIRED)) return
  const ids = tracksWithMarkup()
  if (!ids.length) {
    getDb().prepare("INSERT OR IGNORE INTO settings (key, value_json) VALUES (?, 'true')").run(MARKUP_REPAIRED)
    return
  }
  enqueueJob("score", `Clean web page markup out of ${ids.length} track${ids.length === 1 ? "" : "s"}`, (ctx) => repairMarkup(ids, settingsNow(), ctx), { quick: true })
}

const FIELDS_CHECKED = "fieldsChecked"
/** Raised when the checks learn something new, so every track is checked again once. 2: versions need evidence. */
const FIELDS_CHECK_VERSION = 2

/** The reading a track goes by: the AI's, else the filename's. */
const readingOf = (ai: AiParse | null | undefined, heuristic: Track["heuristic"]) => (ai && (ai.title || ai.artists.length) ? ai : heuristic)
const readingKey = (r: Pick<TrackReading, "artists" | "title"> | null | undefined) => (r ? `${r.artists.map((a) => a.toLowerCase()).join("|")}::${r.title.toLowerCase()}` : "")

/**
 * Every track read again with the field checks: a riddim taken for the artist,
 * a title left in an artist, "reggae" as the album, a guest named twice. Tracks
 * whose artist or title changes are searched again (no AI); the rest are decided
 * again. Approved details are put right, and a cut file whose details change
 * goes back to Cut & Tag to be renamed and tagged again.
 */
export async function recheckFields(ids: number[], settings: Settings, ctx: JobContext) {
  ctx.setTotal(ids.length)
  const known = knownArtists()
  const searchAgain: number[] = []
  const changed: number[] = []
  const recut: string[] = []
  let approved = 0
  for (const id of ids) {
    if (ctx.signal.aborted) return
    const t = getTrack(id)
    if (!t || t.missing) {
      ctx.tick(true)
      continue
    }
    forTrack(id, () => {
      const heuristic = parseFilename(t.filename, { folders: folderContext(t.relDir), tagArtist: t.tags.artist, tagAlbum: t.tags.album, knownArtists: known })
      const ai = t.ai ? ({ ...t.ai, ...checkFields(t.ai, { names: false }).fields } as AiParse) : t.ai
      const candidates = t.candidates ? t.candidates.flatMap((c) => checkCandidate(cleanCandidate(c)) ?? []) : t.candidates
      let final = t.final ? checkFields(t.final, { names: false }).fields : t.final
      const readingChanged = readingKey(readingOf(ai, heuristic)) !== readingKey(readingOf(t.ai, t.heuristic))
      const anyChange = readingChanged || JSON.stringify(candidates) !== JSON.stringify(t.candidates) || JSON.stringify(ai) !== JSON.stringify(t.ai)
      // A file cut with a placeholder left in its tags ("reggae" as the album, "Other" as the genre).
      const tagsWrong = t.status === "done" && (["album", "label", "genre"] as const).some((f) => emptyish(f, t.tags[f]))
      if (!t.decision && !candidates?.length && !anyChange && JSON.stringify(final) === JSON.stringify(t.final) && JSON.stringify(heuristic) === JSON.stringify(t.heuristic)) return
      const next: Track = { ...t, heuristic, ai, candidates, final }
      if (t.status === "rejected") return updateTrack(id, { heuristic, ai, candidates })
      if (t.status === "approved" || t.status === "done") {
        // Decided again under today's checks (the status a person gave it stays).
        const now = t.decision ? scoreAndSave(next, settings).decision : null
        if (final && now && t.decision) {
          const asProposed = readingKey(t.final) === readingKey(t.decision) && (t.final?.version ?? "") === (t.decision.version ?? "")
          if (asProposed) {
            // Approved as Dubplate proposed it: what it proposes now ("Straight Drop", not "Straight Drop (Dubplate)").
            final = { ...final, title: now.title, version: now.version }
          } else if (final.version && final.version === t.ai?.version && !now.version && !versionBacked(final.version, [t.filename, t.relDir, t.tags.title, t.tags.album, t.tags.comment, t.tags.grouping, ...(t.candidates ?? []).map((c) => c.title)])) {
            // Edited, but the version is still the AI's guess with nothing behind it.
            final = { ...final, version: undefined }
          }
        }
        const finalChanged = JSON.stringify(final) !== JSON.stringify(t.final)
        if (!anyChange && !finalChanged && !tagsWrong && JSON.stringify(heuristic) === JSON.stringify(t.heuristic)) return
        updateTrack(id, { heuristic, ai, candidates, final, proposedName: proposedFilename({ ...next, final }, settings) })
        if (finalChanged) ctx.log("debug", `${t.filename}: approved details now ${readingText(final)}`, { trackId: id, detail: `Before: ${readingText(t.final)}` })
        if (finalChanged && t.status === "approved") approved++
        if ((finalChanged || tagsWrong) && t.status === "done") {
          // Cut with a riddim for an artist, or a title in it: ready to cut again, under its right name.
          updateTrack(id, { status: "approved", proposedName: proposedFilename({ ...next, status: "approved" }, settings) })
          recut.push(t.filename)
          ctx.log("info", `${t.filename} was cut with details in the wrong place - back in Cut & Tag to be renamed and tagged again`, { trackId: id })
        }
        changed.push(id)
        return
      }
      updateTrack(id, { heuristic, ai, candidates })
      // The sources were asked about the wrong artist or title: ask again. Otherwise decide again.
      const shown = (d: Track["decision"]) => JSON.stringify(d ? [d.artists, d.featuring, d.title, d.version, d.album, d.label, d.riddim, d.genre, d.year] : null)
      if (readingChanged && t.candidates) searchAgain.push(id)
      else if (t.decision || candidates?.length) {
        const now = scoreAndSave(next, settings).decision
        if (!anyChange && shown(now) === shown(t.decision)) return
      } else if (!anyChange) return
      changed.push(id)
      if (readingChanged) ctx.log("debug", `${t.filename}: now read as ${readingText(readingOf(ai, heuristic))} (was ${readingText(readingOf(t.ai, t.heuristic))})`, { trackId: id })
    })
    ctx.tick(true)
  }
  ctx.tracksChanged(changed)
  const parts = [
    changed.length && `${changed.length} track${changed.length === 1 ? "" : "s"} put right`,
    searchAgain.length && `${searchAgain.length} to ask the sources about again`,
    approved && `${approved} approved track${approved === 1 ? "'s" : "s'"} details corrected`,
    recut.length && `${recut.length} cut file${recut.length === 1 ? "" : "s"} back in Cut & Tag`,
  ].filter(Boolean)
  ctx.log(changed.length ? "success" : "info", `Checked every track's fields: ${parts.length ? parts.join(", ") : "nothing needed changing"}`, recut.length ? { detail: recut.join("\n") } : {})
  if (searchAgain.length) {
    enqueueJob("process", `Ask the sources again for ${searchAgain.length} track${searchAgain.length === 1 ? "" : "s"} read wrong before`, (job) =>
      // The settings this check ran with (they still follow sources switched on or off during the run).
      processTracks(searchAgain, settings, { interpret: false, scour: true, force: false, rescour: true }, job)
    )
  }
  getDb().prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(FIELDS_CHECKED, String(FIELDS_CHECK_VERSION))
}

/** Once after an upgrade that makes the field checks smarter: every track read again with them. */
export function recheckFieldsOnce(): void {
  const row = getDb().prepare("SELECT value_json FROM settings WHERE key = ?").get(FIELDS_CHECKED) as { value_json: string } | undefined
  if (Number(row?.value_json) >= FIELDS_CHECK_VERSION) return
  const ids = (getDb().prepare("SELECT id FROM tracks WHERE missing = 0 ORDER BY id").all() as { id: number }[]).map((r) => r.id)
  if (!ids.length) {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)").run(FIELDS_CHECKED, String(FIELDS_CHECK_VERSION))
    return
  }
  enqueueJob("score", `Check the fields of ${ids.length} track${ids.length === 1 ? "" : "s"}`, (ctx) => recheckFields(ids, settingsNow(), ctx))
}
