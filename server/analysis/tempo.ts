// Tempo from the onset envelope: spectral flux → autocorrelation → a comb
// over each candidate beat period, then folded into the DJ's preferred range.

import { fft, nextPow2, stft } from "./dsp"

const FRAME = 1024
const HOP = 128

/** Spectral-flux onset strength, one value per hop, with the slow trend removed. */
export function onsetEnvelope(x: Float32Array, sampleRate: number): { env: Float64Array; fps: number } {
  const frames = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1)
  const raw = new Float64Array(frames)
  let prev: Float64Array | null = null
  const maxBin = Math.min(FRAME / 2, Math.round((5000 * FRAME) / sampleRate))
  stft(x, FRAME, HOP, (mag, f) => {
    const cur = new Float64Array(maxBin + 1)
    let flux = 0
    for (let b = 1; b <= maxBin; b++) {
      cur[b] = Math.log1p(100 * mag[b])
      if (prev) flux += Math.max(0, cur[b] - prev[b])
    }
    raw[f] = flux
    prev = cur
  })
  const fps = sampleRate / HOP
  // Subtract a ~1 s moving average so only the bumps (onsets) remain.
  const half = Math.round(fps / 2)
  const env = new Float64Array(frames)
  let sum = 0
  let lo = 0
  let hi = -1
  for (let i = 0; i < frames; i++) {
    while (hi < Math.min(frames - 1, i + half)) sum += raw[++hi]
    while (lo < i - half) sum -= raw[lo++]
    env[i] = Math.max(0, raw[i] - sum / (hi - lo + 1))
  }
  return { env, fps }
}

/** Normalised, unbiased autocorrelation (ac[0] = 1) up to `maxLag`. */
export function autocorrelate(env: Float64Array, maxLag: number): Float64Array {
  const n = env.length
  const size = nextPow2(2 * n)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  let mean = 0
  for (let i = 0; i < n; i++) mean += env[i]
  mean /= n || 1
  for (let i = 0; i < n; i++) re[i] = env[i] - mean
  fft(re, im)
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i]
    im[i] = 0
  }
  // Inverse FFT via the forward transform of the conjugate.
  for (let i = 0; i < size; i++) im[i] = -im[i]
  fft(re, im)
  const out = new Float64Array(Math.min(maxLag, n - 1) + 1)
  const zero = re[0] / n || 1
  for (let k = 0; k < out.length; k++) out[k] = re[k] / (n - k) / zero
  return out
}

function acAt(ac: Float64Array, lag: number) {
  const i = Math.floor(lag)
  if (i + 1 >= ac.length) return 0
  const t = lag - i
  return ac[i] * (1 - t) + ac[i + 1] * t
}

/** How strongly the envelope repeats at every multiple of one beat. */
function comb(ac: Float64Array, fps: number, bpm: number, harmonics: number) {
  const lag = (60 * fps) / bpm
  let s = 0
  let n = 0
  for (let k = 1; k <= harmonics; k++) {
    if (k * lag >= ac.length - 1) break
    s += acAt(ac, k * lag)
    n++
  }
  return n ? s / n : 0
}

export interface TempoEstimate {
  bpm: number | null
  confidence: number
}

/**
 * Estimate the tempo of mono audio. The answer is folded into
 * [bpmMin, 2 × bpmMin): with the default 88 a one-drop at 75 reads 150 and
 * jungle stays at 170, the way DJ software counts them.
 */
export function estimateTempo(x: Float32Array, sampleRate: number, bpmMin = 88): TempoEstimate {
  const { env, fps } = onsetEnvelope(x, sampleRate)
  if (env.length < fps * 8) return { bpm: null, confidence: 0 }
  const ac = autocorrelate(env, Math.round(fps * 6))

  // 1. Coarse search over every plausible pulse; octaves tie, which folding resolves.
  let best = 0
  let bestScore = -Infinity
  const scores: number[] = []
  for (let bpm = 50; bpm <= 220; bpm += 0.25) {
    const s = comb(ac, fps, bpm, 4)
    scores.push(s)
    if (s > bestScore) {
      bestScore = s
      best = bpm
    }
  }
  if (bestScore <= 0) return { bpm: null, confidence: 0 }

  // 2. Fold into the preferred octave.
  const lo = Math.max(40, bpmMin)
  let folded = best
  while (folded < lo) folded *= 2
  while (folded >= lo * 2) folded /= 2

  // 3. Refine with more harmonics: long lags pin the period down to ~0.1 BPM.
  let refined = folded
  let refinedScore = -Infinity
  for (let bpm = folded * 0.97; bpm <= folded * 1.03; bpm += 0.01) {
    const s = comb(ac, fps, bpm, 12)
    if (s > refinedScore) {
      refinedScore = s
      refined = bpm
    }
  }

  const mean = scores.reduce((a, b) => a + b, 0) / scores.length
  const confidence = Math.max(0, Math.min(1, ((bestScore - mean) / Math.max(1e-6, 1 - mean)) * 1.6))
  return { bpm: Math.round(refined * 10) / 10, confidence: Math.round(confidence * 100) / 100 }
}
