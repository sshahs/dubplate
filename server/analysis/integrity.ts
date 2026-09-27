// Does the whole file decode, and how long is it silent at each end? Fed from
// the same decoding pass as loudness and the quality check.

import type { IntegrityCheck } from "../../shared/types"
import type { PcmSink } from "./decode"

/** Quieter than this (peak, -50 dBFS) counts as silence: below vinyl crackle and tape hiss. */
const SILENT = 10 ** (-50 / 20)
/** Silence is measured in blocks of this long. */
const BLOCK_S = 0.02

export class IntegrityCollector implements PcmSink {
  readonly done = false
  private frames = 0
  private rate = 0
  private blockLen = 0
  private blockFill = 0
  private blockPeak = 0
  private blocks = 0
  /** first and last block with sound in it */
  private firstSound = -1
  private lastSound = -1

  push(channels: Float32Array[], sampleRate: number) {
    const len = channels[0]?.length ?? 0
    if (!len) return
    if (!this.rate) {
      this.rate = sampleRate
      this.blockLen = Math.max(1, Math.round(sampleRate * BLOCK_S))
    }
    for (let i = 0; i < len; i++) {
      let peak = 0
      for (const ch of channels) {
        const v = Math.abs(ch[i])
        if (v > peak) peak = v
      }
      if (peak > this.blockPeak) this.blockPeak = peak
      if (++this.blockFill === this.blockLen) this.closeBlock()
    }
    this.frames += len
  }

  private closeBlock() {
    if (this.blockPeak > SILENT) {
      if (this.firstSound < 0) this.firstSound = this.blocks
      this.lastSound = this.blocks
    }
    this.blocks++
    this.blockFill = 0
    this.blockPeak = 0
  }

  /** Seconds decoded so far. */
  get seconds(): number {
    return this.rate ? this.frames / this.rate : 0
  }

  /**
   * `expected`: the length the file states, when it can be trusted. `damage`:
   * the error decoding stopped with, if it did.
   */
  result(expected: number | null, damage?: string): IntegrityCheck {
    if (this.blockFill) this.closeBlock()
    const decoded = this.seconds
    const round = (s: number) => Math.round(s * 10) / 10
    const blockS = this.blockLen / (this.rate || 1)
    // A file with no sound at all is silent from the start to the end.
    const silenceStart = this.firstSound < 0 ? decoded : this.firstSound * blockS
    const silenceEnd = this.firstSound < 0 ? 0 : Math.max(0, decoded - (this.lastSound + 1) * blockS)
    // Short by more than 2 s and more than 1% (encoder padding and priming are milliseconds).
    const missing = expected ? expected - decoded : 0
    const truncated = !damage && !!expected && missing > 2 && missing > expected * 0.01
    return {
      decodedSeconds: round(decoded),
      expectedSeconds: expected ? round(expected) : null,
      truncated,
      damagedAt: damage ? round(decoded) : null,
      ...(damage ? { damage } : {}),
      silenceStart: round(silenceStart),
      silenceEnd: round(silenceEnd),
    }
  }
}
