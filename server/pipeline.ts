// Orchestrates interpret → scour → score for batches of tracks.

import type { Settings, Track, TrackStatus } from "../shared/types"
import { interpretTrack } from "./ai/interpreter"
import { analyseTrack } from "./analysis"
import { findArtwork } from "./art"
import { scoreTrack } from "./core/confidence"
import { parseFilename } from "./core/filename-parser"
import { decisionToFinal } from "./core/naming"
import { proposedFilename } from "./executor"
import type { JobContext } from "./jobs"
import { mapLimit } from "./jobs"
import { aliasMap, getTrack, knownArtists, listCorrections, updateTrack } from "./repo"
import { folderContext } from "./scanner"
import { scourTrack, SourceBreaker } from "./sources"

/** Statuses a human set - automated passes must not overwrite them. */
const HUMAN_STATUSES: TrackStatus[] = ["approved", "done", "rejected"]

export function weightsFrom(settings: Settings): Record<string, number> {
  const w: Record<string, number> = {}
  for (const [id, cfg] of Object.entries(settings.sources)) w[id] = cfg.weight
  for (const s of settings.scrapers) w[`scraper:${s.id}`] = s.weight
  return w
}

export function scoreAndSave(track: Track, settings: Settings): Track {
  const decision = scoreTrack({
    heuristic: track.heuristic,
    ai: track.ai,
    tags: track.tags,
    candidates: track.candidates ?? [],
    duration: track.duration,
    weights: weightsFrom(settings),
    thresholds: settings.confidence,
  })
  const keepStatus = HUMAN_STATUSES.includes(track.status)
  let status: TrackStatus = keepStatus ? track.status : decision.status
  let final = track.final
  if (!keepStatus && settings.confidence.autoApprove && decision.status === "matched") {
    status = "approved"
    final = decisionToFinal(decision)
  }
  const next: Track = { ...track, decision, confidence: decision.confidence, status, final }
  next.proposedName = proposedFilename(next, settings)
  updateTrack(track.id, { decision, confidence: decision.confidence, status, final, proposedName: next.proposedName })
  return next
}

export interface ProcessOptions {
  interpret: boolean
  scour: boolean
  force: boolean
}

export async function processTracks(ids: number[], settings: Settings, opts: ProcessOptions, ctx: JobContext) {
  ctx.setTotal(ids.length)
  const corrections = listCorrections()
  const aliases = aliasMap()
  const known = knownArtists()
  let aiFailures = 0
  let lastAiError = ""
  let aiDisabled = false
  const changed: number[] = []
  const breaker = new SourceBreaker()

  const concurrency = opts.interpret ? Math.max(1, settings.llm.concurrency) : 3
  await mapLimit(ids, concurrency, ctx.signal, async (id) => {
    let track = getTrack(id)
    if (!track || track.missing) {
      ctx.tick(false)
      return
    }
    try {
      // Rule-based pass is cheap; refresh it so new aliases/corrections apply.
      const heuristic = parseFilename(track.filename, { folders: folderContext(track.relDir), tagArtist: track.tags.artist, knownArtists: known })
      track = { ...track, heuristic }
      updateTrack(id, { heuristic })

      if (opts.interpret && !aiDisabled && (opts.force || !track.ai)) {
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

      if (opts.scour && (opts.force || !track.candidates)) {
        const reading = track.ai?.title || track.ai?.artists.length ? track.ai : track.heuristic
        if (reading) {
          const result = await scourTrack(track, reading, settings, track.ai?.searchQueries ?? [], ctx.signal, breaker)
          for (const e of result.errors) ctx.log("warn", `${e.source}: ${e.message}`)
          for (const s of result.tripped) ctx.log("error", `${s} keeps failing - skipping it for the rest of this run`)
          track = { ...track, candidates: result.candidates }
          updateTrack(id, { candidates: result.candidates, status: HUMAN_STATUSES.includes(track.status) ? track.status : "scoured" })
        }
      }

      if (ctx.signal.aborted) return
      const scored = scoreAndSave(track, settings)
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
}

/** The optional steps after scoring: cover art and BPM/key. Failures only log. */
async function extras(track: Track, settings: Settings, opts: ProcessOptions, ctx: JobContext) {
  const wantArt = settings.artwork.fetch && opts.scour && (opts.force || !track.artFound) && (!track.art || settings.artwork.replaceExisting)
  if (wantArt && track.decision && track.decision.status !== "unmatched") {
    try {
      const art = await findArtwork(track, settings, ctx.signal)
      if (art && art.hash !== track.art?.hash) updateTrack(track.id, { artFound: art })
    } catch (err) {
      if (!ctx.signal.aborted) ctx.log("warn", `Artwork for ${track.filename}: ${err instanceof Error ? err.message : err}`)
    }
  }
  if (settings.analysis.onProcess && (!track.analysis || (opts.force && track.analysis.error))) {
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
