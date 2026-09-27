// Integrated loudness per ITU-R BS.1770-4 / EBU R128: K-weighting, 400 ms blocks
// every 100 ms, an absolute gate at -70 LUFS and a relative gate 10 LU below.
// ReplayGain 2 aims every track at -18 LUFS.

import type { LoudnessMeasure } from "../../shared/types"
import type { PcmSink } from "./decode"

export const REPLAYGAIN_REFERENCE = -18

/** One biquad section, transposed direct form II. */
interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** The two K-weighting stages for any sample rate (the constants libebur128 uses). */
function kWeighting(rate: number): [Biquad, Biquad] {
  // Stage 1: high shelf, about +4 dB above 2 kHz (the head's acoustic effect).
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * f0) / rate)
  const Vh = 10 ** (G / 20)
  const Vb = Vh ** 0.4996667741545416
  let a0 = 1 + K / Q + K * K
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  // Stage 2: the RLB high-pass at ~38 Hz.
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / rate)
  a0 = 1 + K / Q + K * K
  const highPass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 }
  return [shelf, highPass]
}

const ABSOLUTE_GATE = -70
const RELATIVE_GATE = -10

export class LoudnessMeter implements PcmSink {
  readonly done = false
  /**
   * `fileChannels`: how many channels the file really has. The decoder hands back
   * identical stereo (dual mono, or a silent intro) as a single channel for MP3,
   * AAC and WMA; BS.1770 still counts both, so that channel counts twice.
   */
  constructor(private fileChannels = 0) {}
  private rate = 0
  private stages: [Biquad, Biquad] | null = null
  /** per channel: [s1, s2] state for each stage */
  private state: Float64Array[] = []
  /** 100 ms of samples per step, and the energy of the step being filled */
  private stepLen = 0
  private stepFill = 0
  private stepEnergy = 0
  /** the last four steps make one 400 ms block */
  private steps: number[] = []
  private blocks: number[] = []
  private peak = 0

  push(channels: Float32Array[], sampleRate: number) {
    if (!channels.length || !channels[0].length) return
    if (!this.stages || sampleRate !== this.rate) this.reset(sampleRate)
    const n = channels[0].length
    const width = channels.length === 1 && this.fileChannels >= 2 ? 2 : channels.length
    // The channel count can change mid-stream (a collapsed intro, then real stereo).
    while (this.state.length < width) this.state.push(new Float64Array(4))
    const [s1, s2] = this.stages!
    for (let i = 0; i < n; i++) {
      let energy = 0
      for (let c = 0; c < width; c++) {
        const x = channels[Math.min(c, channels.length - 1)][i]
        const ax = x < 0 ? -x : x
        if (ax > this.peak) this.peak = ax
        const st = this.state[c]
        // Stage 1
        const y1 = s1.b0 * x + st[0]
        st[0] = s1.b1 * x - s1.a1 * y1 + st[1]
        st[1] = s1.b2 * x - s1.a2 * y1
        // Stage 2
        const y2 = s2.b0 * y1 + st[2]
        st[2] = s2.b1 * y1 - s2.a1 * y2 + st[3]
        st[3] = s2.b2 * y1 - s2.a2 * y2
        energy += y2 * y2
      }
      this.stepEnergy += energy
      if (++this.stepFill === this.stepLen) this.endStep()
    }
  }

  private reset(rate: number) {
    this.rate = rate
    this.stages = kWeighting(rate)
    // Music files are mono or stereo; surround channels would carry weights, which files here don't need.
    this.state = []
    this.stepLen = Math.max(1, Math.round(rate / 10))
    this.stepFill = 0
    this.stepEnergy = 0
    this.steps = []
  }

  private endStep() {
    this.steps.push(this.stepEnergy)
    this.stepEnergy = 0
    this.stepFill = 0
    if (this.steps.length > 4) this.steps.shift()
    if (this.steps.length === 4) this.blocks.push((this.steps[0] + this.steps[1] + this.steps[2] + this.steps[3]) / (4 * this.stepLen))
  }

  /** Integrated loudness and sample peak, or null for under 400 ms of audio or silence. */
  result(): LoudnessMeasure | null {
    if (!this.blocks.length) return null
    const lufs = (z: number) => -0.691 + 10 * Math.log10(z)
    const aboveAbsolute = this.blocks.filter((z) => z > 0 && lufs(z) > ABSOLUTE_GATE)
    // Silence (or near it): nothing to even out.
    if (!aboveAbsolute.length) return null
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const relative = lufs(mean(aboveAbsolute)) + RELATIVE_GATE
    const gated = aboveAbsolute.filter((z) => lufs(z) > relative)
    const integrated = lufs(mean(gated.length ? gated : aboveAbsolute))
    return {
      lufs: Math.round(integrated * 100) / 100,
      peak: Math.round(this.peak * 1e6) / 1e6,
      gain: Math.round((REPLAYGAIN_REFERENCE - integrated) * 100) / 100,
    }
  }
}
