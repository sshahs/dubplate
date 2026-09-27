// What an audio file really is, from its first bytes rather than its name: a
// .mp3 that's really an M4A from a YouTube ripper, a "FLAC" that's an MP3.
// Also reads the length the header states - an MP3's Xing/Info/VBRI frame count,
// a WAV's data size, an AIFF's frame count - so a download that stopped short
// can be told apart from a short tune.

import fs from "node:fs"
import path from "node:path"

export interface Sniffed {
  /** the extension this content should have */
  ext: string
  /** formats that share it: "mpeg", "mp4", "ogg", "flac", "wav", "aiff", "asf", "ape", "wv", "mpc", "adts" */
  family: string
  label: string
  /** the MIME type the tag reader knows it by */
  mime: string
  /** the length its header states (MP3 with a VBR header, WAV, AIFF), even if the file stops sooner */
  statedSeconds?: number
}

/** Which family each extension belongs to; anything not here isn't judged. */
const FAMILY_OF_EXT: Record<string, string> = {
  mp3: "mpeg",
  mp2: "mpeg",
  m4a: "mp4",
  mp4: "mp4",
  m4b: "mp4",
  alac: "mp4",
  ogg: "ogg",
  oga: "ogg",
  opus: "ogg",
  flac: "flac",
  wav: "wav",
  aif: "aiff",
  aiff: "aiff",
  aifc: "aiff",
  wma: "asf",
  asf: "asf",
  ape: "ape",
  wv: "wv",
  mpc: "mpc",
  aac: "adts",
}

export function familyOfExt(ext: string): string | undefined {
  return FAMILY_OF_EXT[ext.toLowerCase().replace(/^\./, "")]
}

const HEAD = 64 * 1024

const MPEG_RATES = [
  [11025, 12000, 8000], // 2.5
  [0, 0, 0],
  [22050, 24000, 16000], // 2
  [44100, 48000, 32000], // 1
]
const BITRATES: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}

interface MpegFrame {
  version: number // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  layer: number // 1, 2, 3
  sampleRate: number
  length: number
  samples: number
  mono: boolean
}

function mpegFrame(b: Buffer, i: number): MpegFrame | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null
  const version = (b[i + 1] >> 3) & 3
  const layerBits = (b[i + 1] >> 1) & 3
  if (version === 1 || layerBits === 0) return null
  const layer = 4 - layerBits
  const brIndex = b[i + 2] >> 4
  const srIndex = (b[i + 2] >> 2) & 3
  if (brIndex === 0 || brIndex === 15 || srIndex === 3) return null
  const bitrate = BITRATES[`${version === 3 ? 1 : 2}-${layer}`][brIndex] * 1000
  const sampleRate = MPEG_RATES[version][srIndex]
  const pad = (b[i + 2] >> 1) & 1
  const samples = layer === 1 ? 384 : layer === 3 && version !== 3 ? 576 : 1152
  const length = layer === 1 ? (Math.floor((12 * bitrate) / sampleRate) + pad) * 4 : Math.floor(((samples / 8) * bitrate) / sampleRate) + pad
  return length > 4 ? { version, layer, sampleRate, length, samples, mono: b[i + 3] >> 6 === 3 } : null
}

/** An ADTS (raw AAC) frame header: its length, or 0. */
function adtsFrame(b: Buffer, i: number): number {
  if (i + 7 > b.length || b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return 0
  return ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5)
}

/** The exact length from a Xing/Info or VBRI header in the first frame, if it has one. */
function vbrSeconds(b: Buffer, i: number, f: MpegFrame): number | undefined {
  const side = f.version === 3 ? (f.mono ? 17 : 32) : f.mono ? 9 : 17
  const x = i + 4 + side
  const tag = b.toString("latin1", x, x + 4)
  if ((tag === "Xing" || tag === "Info") && x + 12 <= b.length && b[x + 7] & 1) {
    const frames = b.readUInt32BE(x + 8)
    if (frames > 0) return (frames * f.samples) / f.sampleRate
  }
  const v = i + 36
  if (b.toString("latin1", v, v + 4) === "VBRI" && v + 18 <= b.length) {
    const frames = b.readUInt32BE(v + 14)
    if (frames > 0) return (frames * f.samples) / f.sampleRate
  }
  return undefined
}

/** A WAV's length as its data chunk's size states it. */
function wavSeconds(b: Buffer): number | undefined {
  let byteRate = 0
  for (let o = 12; o + 8 <= b.length; ) {
    const id = b.toString("latin1", o, o + 4)
    const size = b.readUInt32LE(o + 4)
    if (id === "fmt " && o + 20 <= b.length) byteRate = b.readUInt32LE(o + 16)
    // 0 and 0xFFFFFFFF: written while streaming, before the size was known.
    if (id === "data") return byteRate && size && size !== 0xffffffff ? size / byteRate : undefined
    o += 8 + size + (size & 1)
  }
  return undefined
}

/** An AIFF's length from its COMM chunk (frames over an 80-bit float sample rate). */
function aiffSeconds(b: Buffer): number | undefined {
  for (let o = 12; o + 8 <= b.length; ) {
    const id = b.toString("latin1", o, o + 4)
    const size = b.readUInt32BE(o + 4)
    if (id === "COMM" && o + 26 <= b.length) {
      const frames = b.readUInt32BE(o + 10)
      const r = o + 16
      const exponent = ((b[r] & 0x7f) << 8) | b[r + 1]
      const rate = (b.readUInt32BE(r + 2) * 2 ** 32 + b.readUInt32BE(r + 6)) * 2 ** (exponent - 16383 - 63)
      return frames && rate > 0 ? frames / rate : undefined
    }
    o += 8 + size + (size & 1)
  }
  return undefined
}

function sniffBuffer(b: Buffer): Sniffed | null {
  const at = (o: number, s: string) => b.toString("latin1", o, o + s.length) === s
  if (at(0, "fLaC")) return { ext: "flac", family: "flac", label: "FLAC", mime: "audio/flac" }
  if (at(0, "OggS")) {
    const head = b.toString("latin1", 0, Math.min(b.length, 256))
    if (head.includes("OpusHead")) return { ext: "opus", family: "ogg", label: "Opus", mime: "audio/ogg" }
    if (head.includes("\x7fFLAC")) return { ext: "oga", family: "ogg", label: "Ogg FLAC", mime: "audio/ogg" }
    return { ext: "ogg", family: "ogg", label: "Ogg Vorbis", mime: "audio/ogg" }
  }
  if ((at(0, "RIFF") || at(0, "RF64")) && at(8, "WAVE")) return { ext: "wav", family: "wav", label: "WAV", mime: "audio/wav", statedSeconds: at(0, "RIFF") ? wavSeconds(b) : undefined }
  if (at(0, "FORM") && (at(8, "AIFF") || at(8, "AIFC"))) return { ext: "aiff", family: "aiff", label: "AIFF", mime: "audio/aiff", statedSeconds: aiffSeconds(b) }
  if (at(4, "ftyp")) return { ext: "m4a", family: "mp4", label: "M4A (AAC or ALAC)", mime: "audio/mp4" }
  if (b.length >= 16 && b.subarray(0, 16).equals(Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex"))) return { ext: "wma", family: "asf", label: "WMA", mime: "audio/ms-wma" }
  if (at(0, "MAC ")) return { ext: "ape", family: "ape", label: "Monkey's Audio", mime: "audio/ape" }
  if (at(0, "wvpk")) return { ext: "wv", family: "wv", label: "WavPack", mime: "audio/wavpack" }
  if (at(0, "MPCK") || at(0, "MP+")) return { ext: "mpc", family: "mpc", label: "Musepack", mime: "audio/musepack" }
  // MPEG audio or ADTS: find a frame that's followed by another one where its length says.
  for (let i = 0; i < b.length - 4; i++) {
    if (b[i] !== 0xff) continue
    const f = mpegFrame(b, i)
    if (f) {
      const next = i + f.length
      const n = next + 4 <= b.length ? mpegFrame(b, next) : null
      if ((n && n.version === f.version && n.layer === f.layer && n.sampleRate === f.sampleRate) || next >= b.length) {
        const statedSeconds = vbrSeconds(b, i, f)
        return f.layer === 2 ? { ext: "mp2", family: "mpeg", label: "MP2", mime: "audio/mpeg", statedSeconds } : { ext: "mp3", family: "mpeg", label: "MP3", mime: "audio/mpeg", statedSeconds }
      }
      continue
    }
    const len = adtsFrame(b, i)
    if (len > 7 && (i + len >= b.length || adtsFrame(b, i + len) > 7)) return { ext: "aac", family: "adts", label: "AAC (ADTS)", mime: "audio/aacp" }
  }
  return null
}

function readHead(fd: number): Sniffed | null {
  const first = Buffer.alloc(10)
  const got = fs.readSync(fd, first, 0, 10, 0)
  let offset = 0
  if (got === 10 && first.toString("latin1", 0, 3) === "ID3") {
    const size = ((first[6] & 0x7f) << 21) | ((first[7] & 0x7f) << 14) | ((first[8] & 0x7f) << 7) | (first[9] & 0x7f)
    offset = 10 + size + (first[5] & 0x10 ? 10 : 0)
  }
  const b = Buffer.alloc(HEAD)
  const read = fs.readSync(fd, b, 0, HEAD, offset)
  return sniffBuffer(b.subarray(0, read))
}

/** Sniff a file's format from its content (an ID3v2 tag in front is skipped). Two small reads. */
export function sniffFileSync(file: string): Sniffed | null {
  const fd = fs.openSync(file, "r")
  try {
    return readHead(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export async function sniffFile(file: string): Promise<Sniffed | null> {
  return sniffFileSync(file)
}

/**
 * The format a file really is, when its extension says something else (and
 * both are formats Dubplate knows); null when they agree or it can't tell.
 */
export function mismatch(file: string, sniffed: Sniffed | null): Sniffed | null {
  if (!sniffed) return null
  const fam = familyOfExt(path.extname(file))
  return fam && fam !== sniffed.family ? sniffed : null
}
