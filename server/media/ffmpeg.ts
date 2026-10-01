// ffmpeg, when it's installed. It pulls the audio out of videos (the
// converter), turns formats browsers can't play (WMA, APE, AIFF…) into MP3 for
// the preview, and decodes what the built-in decoders can't. Everything else in
// Dubplate works without it.

import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { MediaProbe } from "../../shared/types"

let ffmpegPath: string | null | undefined
let ffprobePath: string | null | undefined

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Whether `bin` (a path, or a name to find on PATH) is there to run. Looked up
 * rather than started: ffmpeg takes a moment to load, and the Health page asks.
 */
function works(bin: string): boolean {
  if (bin.includes("/") || bin.includes("\\")) return executable(bin)
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) if (executable(path.join(dir, bin + ext))) return true
  }
  return false
}

/** The ffmpeg to run (FFMPEG_PATH, else the one on PATH), or null when there isn't one. */
export function findFfmpeg(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath
  for (const c of [process.env.FFMPEG_PATH, "ffmpeg"]) if (c && works(c)) return (ffmpegPath = c)
  return (ffmpegPath = null)
}

/** ffprobe: FFPROBE_PATH, next to FFMPEG_PATH, or on PATH. */
export function findFfprobe(): string | null {
  if (ffprobePath !== undefined) return ffprobePath
  const ff = process.env.FFMPEG_PATH
  const beside = ff && /^ffmpeg/i.test(path.basename(ff)) ? path.join(path.dirname(ff), path.basename(ff).replace(/^ffmpeg/i, "ffprobe")) : null
  for (const c of [process.env.FFPROBE_PATH, beside, "ffprobe"]) if (c && works(c)) return (ffprobePath = c)
  return (ffprobePath = null)
}

/** Look for them again (after installing one, and in tests). */
export function resetFfmpeg() {
  ffmpegPath = undefined
  ffprobePath = undefined
}

/** Readable names for the codecs videos carry audio in. */
const CODEC_NAMES: Record<string, string> = {
  aac: "AAC",
  mp3: "MP3",
  mp2: "MP2",
  wmav1: "WMA",
  wmav2: "WMA",
  wmapro: "WMA Pro",
  wmalossless: "WMA Lossless",
  amr_nb: "AMR (phone)",
  amr_wb: "AMR-WB (phone)",
  ac3: "Dolby Digital (AC-3)",
  eac3: "Dolby Digital Plus",
  dts: "DTS",
  flac: "FLAC",
  alac: "ALAC",
  vorbis: "Vorbis",
  opus: "Opus",
  qcelp: "QCELP (phone)",
  evrc: "EVRC (phone)",
}

export function codecName(codec: string): string {
  if (CODEC_NAMES[codec]) return CODEC_NAMES[codec]
  if (codec.startsWith("pcm_")) return "PCM (uncompressed)"
  if (codec.startsWith("adpcm_")) return "ADPCM"
  return codec.toUpperCase()
}

interface FfprobeStream {
  index: number
  codec_type?: string
  codec_name?: string
  sample_rate?: string
  channels?: number
  bit_rate?: string
  duration?: string
  disposition?: { attached_pic?: number }
}

const num = (v: string | number | undefined): number | null => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** What's inside a media file: its audio streams, whether there's video, and how long it is. */
export function probeMedia(file: string, signal?: AbortSignal): Promise<MediaProbe> {
  const bin = findFfprobe()
  if (!bin) return Promise.reject(new Error("ffprobe isn't installed"))
  return new Promise((resolve, reject) => {
    execFile(bin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { signal, maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim().split("\n").pop() || err.message))
      try {
        const j = JSON.parse(stdout) as { streams?: FfprobeStream[]; format?: { format_name?: string; duration?: string } }
        const streams = j.streams ?? []
        const audio = streams.filter((s) => s.codec_type === "audio")
        resolve({
          format: j.format?.format_name ?? "",
          duration: num(j.format?.duration),
          video: streams.some((s) => s.codec_type === "video" && !s.disposition?.attached_pic),
          audio: audio.map((s, i) => ({
            index: i,
            codec: s.codec_name ?? "unknown",
            codecName: codecName(s.codec_name ?? "unknown"),
            sampleRate: num(s.sample_rate),
            channels: s.channels ?? null,
            bitRate: num(s.bit_rate),
            duration: num(s.duration),
          })),
        })
      } catch (e) {
        reject(e)
      }
    })
  })
}

/** Run ffmpeg; rejects with its last error line. */
export function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  const bin = findFfmpeg()
  if (!bin) return Promise.reject(new Error("ffmpeg isn't installed"))
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["-hide_banner", "-nostdin", "-v", "error", ...args], { signal, stdio: ["ignore", "ignore", "pipe"] })
    let tail = ""
    p.stderr.on("data", (d: Buffer) => (tail = (tail + d.toString()).slice(-2000)))
    p.on("error", reject)
    p.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(tail.trim().split("\n").pop() || `ffmpeg stopped (exit ${code})`))
    })
  })
}

/**
 * Decode a file's first audio stream to float PCM at its own sample rate (at
 * most stereo), chunk by chunk: for analysing formats the built-in decoders
 * can't read.
 */
export async function* decodeWithFfmpeg(file: string, signal?: AbortSignal): AsyncGenerator<{ channelData: Float32Array[]; sampleRate: number }> {
  const bin = findFfmpeg()
  if (!bin) throw new Error("ffmpeg isn't installed")
  const info = await probeMedia(file, signal).catch(() => null)
  const stream = info?.audio[0]
  const rate = stream?.sampleRate ?? 44100
  const channels = Math.min(2, Math.max(1, stream?.channels ?? 2))
  const p = spawn(bin, ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-map", "0:a:0", "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-ac", String(channels), "-ar", String(rate), "pipe:1"], {
    signal,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let tail = ""
  p.stderr.on("data", (d: Buffer) => (tail = (tail + d.toString()).slice(-2000)))
  const closed = new Promise<number | null>((resolve) => p.on("close", resolve))
  const frameBytes = 4 * channels
  let rest = Buffer.alloc(0)
  try {
    for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk
      const frames = Math.floor(buf.length / frameBytes)
      rest = Buffer.from(buf.subarray(frames * frameBytes))
      if (!frames) continue
      const out = Array.from({ length: channels }, () => new Float32Array(frames))
      for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) out[c][i] = buf.readFloatLE((i * channels + c) * 4)
      yield { channelData: out, sampleRate: rate }
    }
  } finally {
    if (p.exitCode === null) p.kill()
  }
  const code = await closed
  if (code !== 0 && code !== null) throw new Error(tail.trim().split("\n").pop() || `ffmpeg stopped (exit ${code})`)
}
