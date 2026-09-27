// Decode a track and estimate its tempo and key - and, over the whole file, its
// loudness and whether it's really the quality it claims. Runs inside the
// analysis worker thread (see worker.ts), never on the server's main thread.

import { parseFile } from "music-metadata"
import type { TrackAnalysis } from "../../shared/types"
import { decodeInto, decodeWindow, WindowCollector, type PcmSink } from "./decode"
import { estimateKey } from "./key"
import { LoudnessMeter } from "./loudness"
import { judgeQuality, SpectrumCollector } from "./quality"
import { estimateTempo } from "./tempo"

export interface AnalyseRequest {
  file: string
  ext: string
  duration: number | null
  bpmMin: number
  /** check the spectrum against what the file claims to be */
  quality?: boolean
  /** measure loudness for ReplayGain */
  loudness?: boolean
  codec?: string | null
  /** bits per second, as the file claims */
  bitrate?: number | null
  sampleRate?: number | null
}

/** Channels the file says it has (the decoder can hide one - see LoudnessMeter). */
async function channelCount(file: string): Promise<number> {
  try {
    return (await parseFile(file, { duration: false, skipCovers: true })).format.numberOfChannels ?? 0
  } catch {
    return 0
  }
}

/** Skip the intro and listen to up to 90 s from the body of the track. */
export function listenWindow(duration: number | null): { from: number; seconds: number } {
  if (!duration || duration < 45) return { from: 0, seconds: 90 }
  const from = Math.min(45, duration * 0.2)
  return { from, seconds: Math.min(90, duration - from) }
}

export async function analyseFile(req: AnalyseRequest): Promise<TrackAnalysis> {
  const { from, seconds } = listenWindow(req.duration)
  const window = new WindowCollector(from, seconds)
  const meter = req.loudness ? new LoudnessMeter(await channelCount(req.file)) : null
  const spectrum = req.quality ? new SpectrumCollector(req.duration) : null
  // One pass over the file feeds everything; without loudness or quality it stops after the window.
  await decodeInto(req.file, req.ext, [window, meter, spectrum].filter((s): s is PcmSink & NonNullable<typeof s> => !!s))
  let audio = window.result()
  // Duration from the tags can be wrong; if the window missed, start from the top.
  if (audio.seconds < 10 && from > 0) audio = await decodeWindow(req.file, req.ext, 0, seconds)
  if (audio.seconds < 8) throw new Error("Too short to analyse")
  const tempo = estimateTempo(audio.samples, audio.sampleRate, req.bpmMin)
  const key = estimateKey(audio.samples, audio.sampleRate)
  const out: TrackAnalysis = {
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    key: key.key,
    keyConfidence: key.confidence,
    seconds: Math.round(audio.seconds),
    analyzedAt: new Date().toISOString(),
  }
  if (meter) out.loudness = meter.result()
  if (spectrum) out.quality = judgeQuality(spectrum.result(), { ext: req.ext, codec: req.codec ?? null, bitrate: req.bitrate ?? null, sampleRate: req.sampleRate ?? null })
  return out
}
