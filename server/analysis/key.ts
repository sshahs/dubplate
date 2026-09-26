// Key from a tuning-corrected chromagram matched against Krumhansl–Kessler
// major/minor profiles.

import { keyName } from "../../shared/keys"
import { stft } from "./dsp"

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const F_MIN = 50
const F_MAX = 2000

interface Peak {
  midi: number
  mag: number
}

function framePeaks(mag: Float64Array, binHz: number): Peak[] {
  const lo = Math.max(2, Math.floor(F_MIN / binHz))
  const hi = Math.min(mag.length - 2, Math.ceil(F_MAX / binHz))
  let max = 0
  for (let b = lo; b <= hi; b++) if (mag[b] > max) max = mag[b]
  if (max <= 0) return []
  const out: Peak[] = []
  for (let b = lo; b <= hi; b++) {
    const m = mag[b]
    if (m < max * 0.05 || m <= mag[b - 1] || m < mag[b + 1]) continue
    // Parabolic interpolation for the true peak frequency.
    const a = mag[b - 1]
    const c = mag[b + 1]
    const denom = a - 2 * m + c
    const shift = denom === 0 ? 0 : (0.5 * (a - c)) / denom
    const freq = (b + shift) * binHz
    out.push({ midi: 69 + 12 * Math.log2(freq / 440), mag: m })
  }
  return out
}

function pearson(x: number[], y: number[]) {
  const n = x.length
  const mx = x.reduce((a, b) => a + b, 0) / n
  const my = y.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my)
    sxx += (x[i] - mx) ** 2
    syy += (y[i] - my) ** 2
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0
}

export interface KeyEstimate {
  key: string | null
  confidence: number
  /** cents the recording sits away from A440 (vinyl rips drift) */
  tuningCents: number
}

export function estimateKey(x: Float32Array, sampleRate: number): KeyEstimate {
  // ~0.75 s frames give ~1.3 Hz bins at 11 kHz: enough to separate bass notes.
  const n = sampleRate > 16000 ? 16384 : 8192
  const hop = n / 2
  const binHz = sampleRate / n
  const frames: Peak[][] = []
  const energies: number[] = []
  stft(x, n, hop, (mag) => {
    let e = 0
    for (let b = 0; b < mag.length; b++) e += mag[b] * mag[b]
    energies.push(e)
    frames.push(framePeaks(mag, binHz))
  })
  if (!frames.length) return { key: null, confidence: 0, tuningCents: 0 }

  // Tuning: where peaks sit relative to the equal-tempered grid, as a weighted circular mean.
  let sr = 0
  let si = 0
  for (const peaks of frames) {
    for (const p of peaks) {
      const dev = p.midi - Math.round(p.midi)
      sr += p.mag * Math.cos(2 * Math.PI * dev)
      si += p.mag * Math.sin(2 * Math.PI * dev)
    }
  }
  const tuning = Math.atan2(si, sr) / (2 * Math.PI)

  // Chroma: each audible frame votes equally, so loud passages don't drown out the rest.
  const sorted = [...energies].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0
  const chroma = new Array<number>(12).fill(0)
  frames.forEach((peaks, i) => {
    if (energies[i] <= floor || !peaks.length) return
    const c = new Array<number>(12).fill(0)
    for (const p of peaks) {
      const m = p.midi - tuning
      const note = Math.round(m)
      const off = Math.abs(m - note)
      if (off > 0.4) continue
      c[((note % 12) + 12) % 12] += p.mag * Math.cos(Math.PI * off)
    }
    const total = c.reduce((a, b) => a + b, 0)
    if (total > 0) for (let k = 0; k < 12; k++) chroma[k] += c[k] / total
  })
  if (chroma.every((v) => v === 0)) return { key: null, confidence: 0, tuningCents: Math.round(tuning * 100) }

  // MIDI note 0 is a C, so chroma index = pitch class with C = 0.
  const scored: { key: string; r: number }[] = []
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = Array.from({ length: 12 }, (_, i) => chroma[(i + tonic) % 12])
    scored.push({ key: keyName(tonic, false), r: pearson(rotated, KK_MAJOR) })
    scored.push({ key: keyName(tonic, true), r: pearson(rotated, KK_MINOR) })
  }
  scored.sort((a, b) => b.r - a.r)
  const [first, second] = scored
  const confidence = Math.max(0, Math.min(1, ((first.r - second.r) / 0.12) * Math.min(1, first.r / 0.6)))
  return { key: first.r > 0.2 ? first.key : null, confidence: Math.round(confidence * 100) / 100, tuningCents: Math.round(tuning * 100) }
}
