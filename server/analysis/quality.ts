// Is a file really the quality it claims? Encoders low-pass the audio - a 128 kbps
// MP3 has nothing above about 16 kHz - so a FLAC or 320 kbps file made from one
// still stops there, and stops like a brick wall. A recording that's just dull
// rolls off gently instead, which is why the steepness matters as much as the
// frequency.

import type { QualityCheck } from "../../shared/types"
import type { PcmSink } from "./decode"
import { fft, hann } from "./dsp"

const N = 4096
/** Frames looked at across a track, spread evenly. */
const MAX_FRAMES = 400
/** Frames quieter than this (about -80 dBFS RMS) say nothing about the high end. */
const QUIET_RMS = 1e-4
const BAND_HZ = 100
/** Bands this far below the music's mid-range level (3-10 kHz) no longer count as content. */
const CONTENT_DB = 45
/** An encoder's filter drops this much within a few hundred Hz; a dull recording fades over kHz. */
const SHARP_DB = 30

export interface Spectrum {
  sampleRate: number
  /** average power per FFT bin, in dB */
  levels: Float64Array
  frames: number
}

/** Averages the power spectrum of frames spread across the whole file. */
export class SpectrumCollector implements PcmSink {
  readonly done = false
  private rate = 0
  private stride = N
  private buf = new Float32Array(N)
  private fill = 0
  private skip = 0
  private power: Float64Array | null = null
  private frames = 0
  private win = hann(N)
  private re = new Float64Array(N)
  private im = new Float64Array(N)

  /** `durationHint` (seconds) spreads the frames over the track; without it, over five minutes. */
  constructor(private durationHint: number | null) {}

  push(channels: Float32Array[], sampleRate: number) {
    if (!channels.length || !channels[0].length) return
    if (!this.power) {
      this.rate = sampleRate
      this.power = new Float64Array(N / 2 + 1)
      const total = (this.durationHint && this.durationHint > 0 ? this.durationHint : 300) * sampleRate
      this.stride = Math.max(N, Math.round(total / MAX_FRAMES))
    }
    const nch = channels.length
    const n = channels[0].length
    for (let i = 0; i < n; i++) {
      if (this.skip > 0) {
        this.skip--
        continue
      }
      let v = 0
      for (let c = 0; c < nch; c++) v += channels[c][i]
      this.buf[this.fill++] = v / nch
      if (this.fill === N) {
        this.frame()
        this.fill = 0
        this.skip = this.stride - N
      }
    }
  }

  private frame() {
    let sum = 0
    for (let i = 0; i < N; i++) sum += this.buf[i] * this.buf[i]
    if (Math.sqrt(sum / N) < QUIET_RMS) return
    for (let i = 0; i < N; i++) {
      this.re[i] = this.buf[i] * this.win[i]
      this.im[i] = 0
    }
    fft(this.re, this.im)
    for (let b = 0; b <= N / 2; b++) this.power![b] += this.re[b] * this.re[b] + this.im[b] * this.im[b]
    this.frames++
  }

  result(): Spectrum | null {
    if (!this.power || !this.frames) return null
    const levels = new Float64Array(this.power.length)
    for (let b = 0; b < levels.length; b++) levels[b] = 10 * Math.log10(this.power[b] / this.frames + 1e-20)
    return { sampleRate: this.rate, levels, frames: this.frames }
  }
}

/** Levels in BAND_HZ-wide bands (power-averaged), index i covering [i*BAND_HZ, (i+1)*BAND_HZ). */
function bands(s: Spectrum): number[] {
  const binHz = s.sampleRate / N
  const out: number[] = []
  for (let lo = 0; lo + BAND_HZ <= s.sampleRate / 2; lo += BAND_HZ) {
    let p = 0
    let k = 0
    for (let b = Math.ceil(lo / binHz); b * binHz < lo + BAND_HZ && b < s.levels.length; b++, k++) p += 10 ** (s.levels[b] / 10)
    out.push(k ? 10 * Math.log10(p / k + 1e-20) : -200)
  }
  return out
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

export interface Cutoff {
  /** Hz; null when content reaches the top of the band */
  hz: number | null
  sharp: boolean
  /** the drop across the edge, dB */
  drop: number
}

/** Where the content stops, and whether it stops like an encoder's filter. */
export function findCutoff(s: Spectrum): Cutoff | null {
  const lv = bands(s)
  const nyq = s.sampleRate / 2
  const band = (hz: number) => Math.floor(hz / BAND_HZ)
  const reference = median(lv.slice(band(3000), band(10000)))
  if (!(reference > -150)) return null
  const top = band(nyq - 300)
  const lowest = band(2000)
  let h = -1
  for (let i = Math.min(top, lv.length - 1); i >= lowest; i--) {
    if (lv[i] > reference - CONTENT_DB) {
      h = i
      break
    }
  }
  if (h < 0) return null
  if ((h + 1) * BAND_HZ >= nyq - 1500) return { hz: null, sharp: false, drop: 0 }
  const hz = h * BAND_HZ
  // 400 Hz of music just below the edge against 400 Hz starting 200 Hz above it.
  const below = mean(lv.slice(Math.max(lowest, h - 4), h))
  const above = mean(lv.slice(h + 2, Math.min(lv.length, h + 6)))
  const drop = below - above
  return { hz, sharp: drop >= SHARP_DB, drop: Math.round(drop * 10) / 10 }
}

const LOSSLESS = /flac|alac|pcm|wav|aiff|ape|monkey|wavpack|tta|lossless/i
const LOSSLESS_EXT = new Set(["flac", "wav", "aif", "aiff", "ape", "wv", "alac"])

export interface Claimed {
  ext: string
  codec: string | null
  /** bits per second */
  bitrate: number | null
  sampleRate: number | null
}

function claimedLabel(c: Claimed, lossless: boolean) {
  if (lossless) return c.ext.toUpperCase() === "WV" ? "WavPack" : c.ext.toUpperCase()
  const kbps = c.bitrate ? Math.round(c.bitrate / 1000) : null
  return kbps ? `${kbps} kbps ${c.ext.toUpperCase()}` : c.ext.toUpperCase()
}

/** The bitrate a lossy file with this cut-off most likely had, going by common encoder low-passes. */
export function estimatedKbps(hz: number): number {
  if (hz < 11500) return 64
  if (hz < 15000) return 96
  // LAME low-passes 128 kbps at about 17 kHz; older encoders and streams at 16.
  if (hz < 17200) return 128
  if (hz < 17800) return 160
  if (hz < 19300) return 192
  if (hz < 20300) return 256
  return 320
}

export function likelySource(hz: number): string {
  const kbps = estimatedKbps(hz)
  return kbps === 64 ? "a 64 kbps (or lower) file" : kbps === 320 ? "a 320 kbps file" : `a ~${kbps} kbps file`
}

const kHz = (hz: number) => (hz / 1000).toFixed(1).replace(/\.0$/, "")

/** Below this cut-off, a file claiming to be this good was made from something worse. */
function expectedAtLeast(c: Claimed, lossless: boolean): number | null {
  if (lossless) return 19800
  const kbps = (c.bitrate ?? 0) / 1000
  if (kbps >= 300) return 18500
  if (kbps >= 224) return 17200
  if (kbps >= 160) return 15800
  return null
}

export function judgeQuality(s: Spectrum | null, claimed: Claimed): QualityCheck {
  if (!s || s.frames < 20) return { cutoffHz: null, sharp: false, verdict: "unknown", detail: "Too quiet or too short to tell." }
  const cut = findCutoff(s)
  if (!cut) return { cutoffHz: null, sharp: false, verdict: "unknown", detail: "Too quiet or too short to tell." }
  const lossless = LOSSLESS_EXT.has(claimed.ext.toLowerCase()) || LOSSLESS.test(claimed.codec ?? "")
  const label = claimedLabel(claimed, lossless)
  const rate = claimed.sampleRate ?? s.sampleRate
  const nyq = s.sampleRate / 2
  // A hi-res file with nothing above CD bandwidth was upsampled.
  if (rate >= 88200 && (cut.hz === null ? nyq : cut.hz) <= 22500) {
    const hz = cut.hz ?? nyq
    return {
      cutoffHz: hz,
      sharp: cut.sharp,
      verdict: "suspect",
      likely: cut.sharp && hz < 20300 ? likelySource(hz) : "a CD-quality (44.1 or 48 kHz) file",
      detail: `A ${kHz(rate)} kHz file with nothing above ${kHz(hz)} kHz - it was upsampled from ${cut.sharp && hz < 20300 ? likelySource(hz) : "CD quality"}.`,
    }
  }
  if (cut.hz === null) return { cutoffHz: null, sharp: false, verdict: "ok", detail: `Full range, right up to ${kHz(Math.floor(nyq / 500) * 500)} kHz.` }
  if (!cut.sharp) {
    return { cutoffHz: cut.hz, sharp: false, verdict: "ok", detail: `Rolls off gently from about ${kHz(cut.hz)} kHz - that's the recording, not an encoder.` }
  }
  const min = expectedAtLeast(claimed, lossless)
  if (min !== null && cut.hz < min) {
    const likely = likelySource(cut.hz)
    return {
      cutoffHz: cut.hz,
      sharp: true,
      verdict: "suspect",
      likely,
      detail: `Nothing above ${kHz(cut.hz)} kHz, and it stops like an encoder's filter - a ${label} file like this was probably made from ${likely}.`,
    }
  }
  return { cutoffHz: cut.hz, sharp: true, verdict: "ok", detail: `Stops at ${kHz(cut.hz)} kHz, which fits a ${label} file.` }
}
