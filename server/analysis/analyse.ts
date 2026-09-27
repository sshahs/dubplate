// Decode a track and estimate its tempo and key - and, over the whole file, its
// loudness and whether it's really the quality it claims. Runs inside the
// analysis worker thread (see worker.ts), never on the server's main thread.

import { parseFile } from "music-metadata"
import type { TrackAnalysis } from "../../shared/types"
import { familyOfExt, mismatch, sniffFile, type Sniffed } from "../sniff"
import { decodeInto, decodeWindow, WindowCollector, type PcmSink } from "./decode"
import { IntegrityCollector } from "./integrity"
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
  /** check the whole file decodes, and measure silence at the ends */
  integrity?: boolean
}

/**
 * How long the file says it is, when that's exact: what the header states for
 * WAV, AIFF and an MP3 with a VBR header; the tag reader's length for FLAC, MP4
 * and the like (also from their headers). Never a guess from the bitrate, and
 * never for raw AAC.
 */
function statedLength(sniffed: Sniffed | null, ext: string, duration: number | null): number | null {
  if (sniffed?.statedSeconds) return sniffed.statedSeconds
  const family = sniffed?.family ?? familyOfExt(ext)
  // No VBR header: the reader's length is a guess. WAV/AIFF without a readable size: its length is what's there.
  if (!family || family === "mpeg" || family === "adts" || family === "wav" || family === "aiff") return null
  return duration && duration > 0 ? duration : null
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
  const sniffed = await sniffFile(req.file).catch(() => null)
  // A file named as something it isn't is decoded as what it is.
  const ext = mismatch(req.file, sniffed)?.ext ?? req.ext
  const { from, seconds } = listenWindow(req.duration)
  const window = new WindowCollector(from, seconds)
  const meter = req.loudness ? new LoudnessMeter(await channelCount(req.file)) : null
  const spectrum = req.quality ? new SpectrumCollector(req.duration) : null
  const integrity = req.integrity ? new IntegrityCollector() : null
  // One pass over the file feeds everything; with only tempo and key wanted it stops after the window.
  let damage: string | undefined
  try {
    await decodeInto(req.file, ext, [window, meter, spectrum, integrity].filter((s): s is PcmSink & NonNullable<typeof s> => !!s))
  } catch (err) {
    // Broke off partway: that's the finding, and what did decode is still worth listening to.
    if (!integrity || integrity.seconds < 1) throw err
    damage = err instanceof Error ? err.message : String(err)
  }
  let audio = window.result()
  // Duration from the tags can be wrong; if the window missed, start from the top.
  if (audio.seconds < 10 && from > 0) audio = await decodeWindow(req.file, ext, 0, seconds).catch(() => audio)
  const check = integrity?.result(statedLength(sniffed, ext, req.duration), damage) ?? null
  if (audio.seconds < 8) {
    // A broken file still gets its findings, just no tempo or key.
    if (check && (check.damagedAt !== null || check.truncated)) {
      return { bpm: null, bpmConfidence: 0, key: null, keyConfidence: 0, seconds: Math.round(audio.seconds), analyzedAt: new Date().toISOString(), integrity: check }
    }
    throw new Error("Too short to analyse")
  }
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
  if (spectrum) out.quality = judgeQuality(spectrum.result(), { ext, codec: req.codec ?? null, bitrate: req.bitrate ?? null, sampleRate: req.sampleRate ?? null })
  if (check) out.integrity = check
  return out
}
