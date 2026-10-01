// Decodes just the part of a file the analysers need, as mono at ~11 kHz.
// Pure JS/WASM decoders; streamed where the format allows, so a long FLAC
// never sits in memory as a full float buffer. Where they can't read a file at
// all, ffmpeg does (when it's installed).

import fs from "node:fs"
import decode, { decodeChunked } from "@audio/decode"
import { decodeWithFfmpeg, findFfmpeg } from "../media/ffmpeg"

type ChunkFormat = Parameters<typeof decodeChunked>[1]

const CHUNKED: Record<string, ChunkFormat> = {
  mp3: "mp3",
  mp2: "mp3",
  flac: "flac",
  wav: "wav",
  aif: "aiff",
  aiff: "aiff",
  m4a: "m4a",
  mp4: "m4a",
  alac: "m4a",
  aac: "aac",
  opus: "opus",
  oga: "oga",
  wma: "wma",
}

/** Whole-file decoding reads everything into memory; skip anything bigger. */
const MAX_WHOLE_FILE = 400 * 1024 * 1024
const TARGET_RATE = 11025

export interface DecodedWindow {
  samples: Float32Array
  sampleRate: number
  seconds: number
}

/** Something that wants the decoded audio, chunk by chunk, from the start of the file. */
export interface PcmSink {
  push(channels: Float32Array[], sampleRate: number): void
  /** has everything it needs, so decoding can stop early once every sink is done */
  readonly done: boolean
}

/** Downmixes, decimates (box filter) and keeps only [from, from + seconds). */
export class WindowCollector implements PcmSink {
  private out: Float32Array | null = null
  private filled = 0
  private factor = 1
  private rate = 0
  private pos = 0 // input frames seen
  private acc = 0
  private accN = 0
  constructor(
    private from: number,
    private seconds: number
  ) {}

  get done() {
    return !!this.out && this.filled >= this.out.length
  }

  push(channels: Float32Array[], sampleRate: number) {
    if (!channels.length || !channels[0].length) return
    if (!this.out) {
      this.factor = Math.max(1, Math.round(sampleRate / TARGET_RATE))
      this.rate = sampleRate / this.factor
      this.out = new Float32Array(Math.ceil(this.seconds * this.rate))
    }
    const start = this.from * sampleRate
    const end = (this.from + this.seconds) * sampleRate
    const len = channels[0].length
    const nch = channels.length
    for (let i = 0; i < len && this.filled < this.out.length; i++, this.pos++) {
      if (this.pos < start || this.pos >= end) continue
      let v = 0
      for (let c = 0; c < nch; c++) v += channels[c][i]
      this.acc += v / nch
      if (++this.accN === this.factor) {
        this.out[this.filled++] = this.acc / this.factor
        this.acc = 0
        this.accN = 0
      }
    }
  }

  result(): DecodedWindow {
    const samples = this.out ? this.out.subarray(0, this.filled) : new Float32Array(0)
    return { samples, sampleRate: this.rate || TARGET_RATE, seconds: this.rate ? samples.length / this.rate : 0 }
  }
}

async function oggFlavour(file: string): Promise<ChunkFormat> {
  const fh = await fs.promises.open(file, "r")
  try {
    const head = Buffer.alloc(128)
    await fh.read(head, 0, head.length, 0)
    return head.includes("OpusHead") ? "opus" : "oga"
  } finally {
    await fh.close()
  }
}

/**
 * Decode the file, handing every chunk to each sink until they're all done (or
 * the file ends). Streamed where the format allows. When the built-in decoders
 * get nothing out of it - a format they don't know, or one they stumble on from
 * the start - ffmpeg has a go. A file that breaks off partway isn't retried:
 * that's a finding, not a decoder problem.
 */
export async function decodeInto(file: string, ext: string, sinks: PcmSink[]): Promise<void> {
  let pushed = false
  const counted: PcmSink[] = sinks.map((s) => ({
    get done() {
      return s.done
    },
    push(channels: Float32Array[], sampleRate: number) {
      if (channels[0]?.length) pushed = true
      s.push(channels, sampleRate)
    },
  }))
  try {
    await decodeBuiltIn(file, ext, counted)
  } catch (err) {
    if (pushed || !findFfmpeg()) throw err
    return decodeViaFfmpeg(file, sinks)
  }
  if (!pushed && findFfmpeg()) await decodeViaFfmpeg(file, sinks)
}

async function decodeViaFfmpeg(file: string, sinks: PcmSink[]): Promise<void> {
  for await (const pcm of decodeWithFfmpeg(file)) {
    for (const sink of sinks) if (!sink.done) sink.push(pcm.channelData, pcm.sampleRate)
    if (sinks.every((s) => s.done)) break
  }
}

async function decodeBuiltIn(file: string, ext: string, sinks: PcmSink[]): Promise<void> {
  const e = ext.toLowerCase()
  const format = e === "ogg" ? await oggFlavour(file) : CHUNKED[e]
  if (format) {
    const stream = fs.createReadStream(file, { highWaterMark: 256 * 1024 })
    try {
      for await (const pcm of decodeChunked(stream, format)) {
        for (const sink of sinks) if (!sink.done) sink.push(pcm.channelData, pcm.sampleRate)
        if (sinks.every((s) => s.done)) break
      }
    } finally {
      stream.destroy()
    }
  } else {
    const { size } = await fs.promises.stat(file)
    if (size > MAX_WHOLE_FILE) throw new Error(`Too large to analyse (${Math.round(size / 1048576)} MB .${e})`)
    const pcm = await decode(await fs.promises.readFile(file))
    for (const sink of sinks) sink.push(pcm.channelData, pcm.sampleRate)
  }
}

/**
 * Decode `seconds` of audio starting `from` seconds in. If the file is shorter
 * than that, whatever exists after `from` comes back.
 */
export async function decodeWindow(file: string, ext: string, from: number, seconds: number): Promise<DecodedWindow> {
  const collector = new WindowCollector(from, seconds)
  await decodeInto(file, ext, [collector])
  return collector.result()
}
