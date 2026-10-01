// How a video's audio becomes an audio file: kept exactly as it is when an
// audio format can hold it (no quality lost), otherwise re-encoded. Shared so
// the Videos page shows what will happen before anything runs.

import type { ConvertPlan, MediaAudioStream, Settings } from "./types"

/** Codecs an audio file can hold as they are, and the extension that holds them. */
const KEEPS: Record<string, string> = {
  aac: "m4a",
  alac: "m4a",
  mp3: "mp3",
  wmav1: "wma",
  wmav2: "wma",
  wmapro: "wma",
  wmalossless: "wma",
  flac: "flac",
  vorbis: "ogg",
  opus: "opus",
}

/** The codec each re-encode target is, so a stream already in it is still just copied. */
const TARGET_CODEC: Record<Settings["convert"]["encodeTo"], string> = { mp3: "mp3", m4a: "aac", flac: "flac" }

const TARGET_LABEL: Record<Settings["convert"]["encodeTo"], string> = { mp3: "MP3 (VBR V0)", m4a: "AAC 256 kbps (.m4a)", flac: "FLAC" }

export function planConversion(stream: MediaAudioStream, opts: Settings["convert"]): ConvertPlan {
  const target = opts.encodeTo
  if (stream.codec === TARGET_CODEC[target]) return { mode: "copy", ext: target, label: `${stream.codecName}, kept as it is (.${target})` }
  if (opts.keepAudio && KEEPS[stream.codec]) return { mode: "copy", ext: KEEPS[stream.codec], label: `${stream.codecName}, kept as it is (.${KEEPS[stream.codec]})` }
  // Uncompressed: lossless FLAC holds it exactly, in a fraction of the space.
  if (opts.keepAudio && stream.codec.startsWith("pcm_")) return { mode: "encode", ext: "flac", label: `${stream.codecName} to FLAC (lossless)` }
  return { mode: "encode", ext: target, label: `${stream.codecName} re-encoded to ${TARGET_LABEL[target]}` }
}
