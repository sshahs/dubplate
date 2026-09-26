// BPM & key analysis: the job that fills in tracks' tempo and key, using the
// worker pool for the heavy lifting.

import type { Settings, Track, TrackAnalysis } from "../../shared/types"
import type { JobContext } from "../jobs"
import { mapLimit } from "../jobs"
import { getTrack, updateTrack } from "../repo"
import { POOL_SIZE, runTask } from "../worker-pool"
import type { AnalyseRequest } from "./analyse"

/** Analyse one file off the main thread. */
export function analyse(req: AnalyseRequest): Promise<TrackAnalysis> {
  return runTask<TrackAnalysis>({ type: "analyse", req })
}

/**
 * Store an analysis and let it fill tempo/key - unless those came from the
 * file's tags or from you, which win over a machine's guess.
 */
export function applyAnalysis(t: Track, analysis: TrackAnalysis): Partial<Track> {
  const patch: Partial<Track> = { analysis }
  const fromPreviousRun = (field: "bpm" | "key") => t.analysis !== null && t[field] === t.analysis[field]
  if (analysis.bpm && (t.bpm === null || fromPreviousRun("bpm"))) patch.bpm = analysis.bpm
  if (analysis.key && (t.key === null || fromPreviousRun("key"))) patch.key = analysis.key
  return patch
}

/** Analyse one track and save the result; returns the updated fields. */
export async function analyseTrack(t: Track, settings: Settings): Promise<Partial<Track>> {
  try {
    const analysis = await analyse({ file: t.path, ext: t.ext, duration: t.duration, bpmMin: settings.analysis.bpmMin })
    const patch = applyAnalysis(t, analysis)
    updateTrack(t.id, patch)
    return patch
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const failed: TrackAnalysis = { bpm: null, bpmConfidence: 0, key: null, keyConfidence: 0, seconds: 0, analyzedAt: new Date().toISOString(), error }
    updateTrack(t.id, { analysis: failed })
    throw err
  }
}

export async function analyzeTracks(ids: number[], settings: Settings, opts: { force: boolean }, ctx: JobContext) {
  ctx.setTotal(ids.length)
  const changed: number[] = []
  await mapLimit(ids, POOL_SIZE, ctx.signal, async (id) => {
    const t = getTrack(id)
    if (!t || t.missing) return ctx.tick(false)
    if (!opts.force && t.analysis && !t.analysis.error) return ctx.tick(true)
    try {
      const patch = await analyseTrack(t, settings)
      changed.push(id)
      const a = patch.analysis!
      ctx.tick(true, `${t.filename} → ${[a.bpm && `${a.bpm} BPM`, a.key].filter(Boolean).join(" · ") || "no clear pulse or key"}`)
    } catch (err) {
      if (ctx.signal.aborted) return
      changed.push(id)
      ctx.log("warn", `Could not analyse ${t.filename}: ${err instanceof Error ? err.message : err}`)
      ctx.tick(false)
    }
    if (changed.length % 10 === 0) ctx.tracksChanged(changed.slice(-10))
  })
  ctx.tracksChanged(changed)
}
