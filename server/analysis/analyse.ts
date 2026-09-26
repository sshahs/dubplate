// Decode a slice of a track and estimate its tempo and key. Runs inside the
// analysis worker thread (see worker.ts), never on the server's main thread.

import type { TrackAnalysis } from "../../shared/types"
import { decodeWindow } from "./decode"
import { estimateKey } from "./key"
import { estimateTempo } from "./tempo"

export interface AnalyseRequest {
  file: string
  ext: string
  duration: number | null
  bpmMin: number
}

/** Skip the intro and listen to up to 90 s from the body of the track. */
export function listenWindow(duration: number | null): { from: number; seconds: number } {
  if (!duration || duration < 45) return { from: 0, seconds: 90 }
  const from = Math.min(45, duration * 0.2)
  return { from, seconds: Math.min(90, duration - from) }
}

export async function analyseFile(req: AnalyseRequest): Promise<TrackAnalysis> {
  const { from, seconds } = listenWindow(req.duration)
  let audio = await decodeWindow(req.file, req.ext, from, seconds)
  // Duration from the tags can be wrong; if the window missed, start from the top.
  if (audio.seconds < 10 && from > 0) audio = await decodeWindow(req.file, req.ext, 0, seconds)
  if (audio.seconds < 8) throw new Error("Too short to analyse")
  const tempo = estimateTempo(audio.samples, audio.sampleRate, req.bpmMin)
  const key = estimateKey(audio.samples, audio.sampleRate)
  return {
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    key: key.key,
    keyConfidence: key.confidence,
    seconds: Math.round(audio.seconds),
    analyzedAt: new Date().toISOString(),
  }
}
