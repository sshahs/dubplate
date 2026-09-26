// Tiny but valid audio files for tests (no ffmpeg needed).
import fs from "node:fs"

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, silent frames. */
export function writeMp3(file: string, frames = 60) {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x64])
  const frameLen = Math.floor((144 * 128000) / 44100) // 417
  const frame = Buffer.alloc(frameLen)
  header.copy(frame, 0)
  fs.writeFileSync(file, Buffer.concat(Array.from({ length: frames }, () => frame)))
}

/** 16-bit mono PCM WAV of silence. */
export function writeWav(file: string, seconds = 1) {
  const rate = 8000
  const data = Buffer.alloc(rate * 2 * seconds)
  const h = Buffer.alloc(44)
  h.write("RIFF", 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write("WAVE", 8)
  h.write("fmt ", 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write("data", 36)
  h.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([h, data]))
}
