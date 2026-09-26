// Synthetic music for analyser tests: a drum pattern at a known tempo over a
// chord progression in a known key, rendered as mono float samples.

export interface SynthOptions {
  bpm: number
  /** chord roots as MIDI notes with quality, e.g. [[57, "m"], [62, "m"], [64, "M"], [57, "m"]] */
  chords: [number, "m" | "M"][]
  seconds?: number
  sampleRate?: number
  /** "four" (kick on 1 & 3, snare on 2 & 4) or "onedrop" (kick + snare on 3 only) */
  pattern?: "four" | "onedrop" | "breaks"
  /** play everything this many cents sharp (a vinyl rip running fast) */
  detuneCents?: number
  seed?: number
}

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) / 4294967296) * 2 - 1
  }
}

export function synthTrack(o: SynthOptions): Float32Array {
  const sr = o.sampleRate ?? 44100
  const seconds = o.seconds ?? 40
  const out = new Float32Array(Math.round(sr * seconds))
  const beat = 60 / o.bpm
  const noise = rng(o.seed ?? 7)
  const tune = 2 ** ((o.detuneCents ?? 0) / 1200)
  const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12) * tune

  const add = (at: number, dur: number, fn: (t: number) => number) => {
    const i0 = Math.round(at * sr)
    const n = Math.round(dur * sr)
    for (let i = 0; i < n && i0 + i < out.length; i++) out[i0 + i] += fn(i / sr)
  }
  const kick = (at: number) => add(at, 0.25, (t) => Math.sin(2 * Math.PI * (50 + 70 * Math.exp(-t * 30)) * t) * Math.exp(-t * 14) * 0.9)
  const snare = (at: number) => add(at, 0.18, (t) => noise() * Math.exp(-t * 22) * 0.5)
  const hat = (at: number) => add(at, 0.04, (t) => noise() * Math.exp(-t * 90) * 0.18)
  const tone = (at: number, dur: number, midi: number, gain: number) =>
    add(at, dur, (t) => {
      const env = Math.min(1, t * 40) * Math.min(1, (dur - t) * 20)
      const f = hz(midi)
      return env * gain * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t) + 0.2 * Math.sin(6 * Math.PI * f * t))
    })

  const beats = Math.floor(seconds / beat)
  for (let b = 0; b < beats; b++) {
    const at = b * beat
    const inBar = b % 4
    if (o.pattern === "onedrop") {
      if (inBar === 2) {
        kick(at)
        snare(at)
      }
    } else if (o.pattern === "breaks") {
      if (inBar === 0 || (inBar === 2 && b % 8 === 2)) kick(at)
      if (inBar === 1 || inBar === 3) snare(at)
      if (inBar === 2 && b % 8 === 6) kick(at + beat / 2)
    } else {
      if (inBar === 0 || inBar === 2) kick(at)
      if (inBar === 1 || inBar === 3) snare(at)
    }
    hat(at)
    hat(at + beat / 2)
    // One chord per bar: pad triad plus the root in the bass.
    if (inBar === 0) {
      const [root, q] = o.chords[Math.floor(b / 4) % o.chords.length]
      const third = q === "m" ? 3 : 4
      for (const n of [root, root + third, root + 7]) tone(at, beat * 4, n, 0.12)
      tone(at, beat * 4, root - 24, 0.2)
    }
    // Off-beat skank: the chord stabbed on the "and".
    const [root, q] = o.chords[Math.floor(b / 4) % o.chords.length]
    for (const n of [root + 12, root + 12 + (q === "m" ? 3 : 4), root + 19]) tone(at + beat / 2, beat * 0.3, n, 0.05)
  }
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] /= peak
  return out
}

/** 16-bit stereo PCM WAV bytes for mono samples. */
export function toWav(samples: Float32Array, sampleRate = 44100): Buffer {
  const data = Buffer.alloc(samples.length * 4)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i])) * 32767
    data.writeInt16LE(v | 0, i * 4)
    data.writeInt16LE(v | 0, i * 4 + 2)
  }
  const h = Buffer.alloc(44)
  h.write("RIFF", 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write("WAVE", 8)
  h.write("fmt ", 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(2, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 4, 28)
  h.writeUInt16LE(4, 32)
  h.writeUInt16LE(16, 34)
  h.write("data", 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}
