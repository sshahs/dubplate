// The converter: pulls the audio out of videos (AVI, 3GP, WMV, MP4…) into an
// audio file next to them, with ffmpeg. The audio is kept exactly as it is
// where an audio file can hold it (AAC, MP3, WMA…); otherwise it's re-encoded.
// The new file is made under a hidden name and only takes its real one once
// it's complete and checked - never over an existing file. The video stays
// where it is, or moves to the holding folder. Rewind takes the new file away
// again (while it's exactly as made) and puts the video back.

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { planConversion } from "../shared/convert"
import type { ConvertPlan, MediaAudioStream, MediaProbe, Settings } from "../shared/types"
import { getDb } from "./db"
import { holdingPath } from "./duplicates"
import { claimFreeName, ensureDir, moveFile } from "./fsops"
import { enqueueJob, type JobContext } from "./jobs"
import { findFfmpeg, probeMedia, runFfmpeg } from "./media/ffmpeg"
import { getLibrary, insertOperation } from "./repo"
import { partialHash } from "./scanner"
import { settingsNow } from "./settings"
import { getVideo, updateVideo, videoMoved } from "./videos"

/** The muxer for each audio file Dubplate makes. */
const MUXER: Record<string, string> = { m4a: "ipod", mp3: "mp3", wma: "asf", flac: "flac", ogg: "ogg", opus: "ogg" }

/** ffmpeg's arguments for making `out` from the first audio stream of `file`. */
export function ffmpegArgs(file: string, out: string, plan: ConvertPlan, stream: MediaAudioStream): string[] {
  const codec =
    plan.mode === "copy"
      ? ["-c:a", "copy"]
      : plan.ext === "flac"
        ? ["-c:a", "flac"]
        : plan.ext === "m4a"
          ? ["-c:a", "aac", "-b:a", "256k"]
          : ["-c:a", "libmp3lame", "-q:a", "0"]
  // Phone audio (AMR is 8 kHz): re-encoded at a rate every player and DJ program takes.
  const rate = plan.mode === "encode" && plan.ext !== "flac" && stream.sampleRate && stream.sampleRate < 32000 ? ["-ar", "44100"] : []
  const faststart = plan.ext === "m4a" ? ["-movflags", "+faststart"] : []
  return ["-i", file, "-map", `0:a:${stream.index}`, "-vn", "-sn", "-dn", "-map_metadata", "0", ...codec, ...rate, ...faststart, "-f", MUXER[plan.ext], out]
}

/** Close enough to the video's own length that nothing was lost (a frame or two either way). */
function sameLength(a: number | null, b: number | null): boolean {
  if (!a || !b) return true
  return Math.abs(a - b) <= Math.max(2, a * 0.01)
}

async function makeAudio(file: string, tmp: string, plan: ConvertPlan, stream: MediaAudioStream, probe: MediaProbe, signal: AbortSignal): Promise<MediaProbe> {
  await runFfmpeg(ffmpegArgs(file, tmp, plan, stream), signal)
  const made = await probeMedia(tmp, signal)
  if (!made.audio.length || !made.duration) throw new Error("The audio file came out empty")
  if (!sameLength(stream.duration ?? probe.duration, made.duration)) {
    throw new Error(`The audio file came out ${Math.round(made.duration)} s long, not ${Math.round((stream.duration ?? probe.duration)!)} s`)
  }
  return made
}

/**
 * Convert these videos. Returns the libraries that got new audio files (scan
 * them to pick the files up).
 */
export async function convertVideos(ids: number[], settings: Settings, ctx: JobContext): Promise<number[]> {
  if (!findFfmpeg()) throw new Error("ffmpeg isn't installed - it's what pulls the audio out of videos")
  ctx.setTotal(ids.length)
  const batchId = randomUUID()
  const label = "Convert videos"
  const libraries = new Set<number>()
  let keptInPlace = false
  for (const id of ids) {
    if (ctx.signal.aborted) break
    const v = getVideo(id)
    const lib = v ? getLibrary(v.libraryId) : null
    if (!v || !lib) {
      ctx.tick(false)
      continue
    }
    if (v.status === "converted" && v.outputPath && fs.existsSync(v.outputPath)) {
      ctx.log("info", `${v.filename}: already converted to ${path.basename(v.outputPath)}`)
      ctx.tick(true)
      continue
    }
    let tmp: string | null = null
    try {
      if (!fs.existsSync(v.path)) throw new Error("It's missing on disk - rescan the library")
      const probe = await probeMedia(v.path, ctx.signal)
      const stream = probe.audio[0]
      if (!stream) {
        updateVideo(v.id, { probe, status: "no-audio", error: null })
        ctx.log("warn", `${v.filename}: there's no audio in it`)
        ctx.tick(false)
        continue
      }
      const dir = path.dirname(v.path)
      const stem = path.basename(v.path, path.extname(v.path))
      tmp = path.join(dir, `.${stem}.${randomUUID().slice(0, 8)}.converting`)
      let plan = planConversion(stream, settings.convert)
      try {
        await makeAudio(v.path, tmp, plan, stream, probe, ctx.signal)
      } catch (err) {
        // Some videos hold their audio in a way an audio file can't take as it is: re-encode it.
        if (plan.mode !== "copy" || ctx.signal.aborted) throw err
        fs.rmSync(tmp, { force: true })
        plan = planConversion(stream, { ...settings.convert, keepAudio: false })
        if (plan.mode === "copy") plan = { mode: "encode", ext: plan.ext, label: `${stream.codecName} re-encoded` }
        ctx.log("info", `${v.filename}: the audio couldn't be kept as it is (${err instanceof Error ? err.message : err}), so it's re-encoded`)
        await makeAudio(v.path, tmp, plan, stream, probe, ctx.signal)
      }
      const out = await claimFreeName(tmp, dir, `${stem}.${plan.ext}`)
      tmp = null
      const st = await fs.promises.stat(out)
      insertOperation({
        batchId,
        trackId: null,
        kind: "convert",
        fromPath: v.path,
        toPath: out,
        tagsBefore: null,
        tagsAfter: null,
        status: "done",
        error: null,
        batchLabel: label,
        hashAfter: await partialHash(out, st.size),
      })
      updateVideo(v.id, { probe, status: "converted", outputPath: out, convertedAt: new Date().toISOString(), error: null })
      libraries.add(lib.id)
      ctx.log("success", `${v.filename} → ${path.basename(out)} (${plan.label})`)

      // The video afterwards: set aside if asked (and files may be moved).
      if (settings.convert.originals === "aside") {
        if (settings.safety.readOnly) keptInPlace = true
        else {
          const to = holdingPath(lib.path, settings.duplicates.holdingFolder, v.path)
          const createdDirs = await ensureDir(path.dirname(to))
          await moveFile(v.path, to)
          insertOperation({ batchId, trackId: null, kind: "set-aside", fromPath: v.path, toPath: to, tagsBefore: null, tagsAfter: null, status: "done", error: null, batchLabel: label, createdDirs })
          videoMoved(v.path, to, v.path)
        }
      }
      ctx.tick(true, v.filename)
    } catch (err) {
      if (tmp) fs.rmSync(tmp, { force: true })
      const message = err instanceof Error ? err.message : String(err)
      if (!ctx.signal.aborted) {
        updateVideo(v.id, { status: "failed", error: message })
        ctx.log("error", `${v.filename}: ${message}`)
      }
      ctx.tick(false)
    }
  }
  if (keptInPlace) ctx.log("info", "Read-only mode is on, so the videos stay where they are (the audio files are new, nothing was changed)")
  if (libraries.size) ctx.filesChanged()
  return [...libraries]
}

/** Queue a conversion; `after` gets the libraries with new audio files, to scan them. */
export function enqueueConversion(ids: number[], label: string, after?: (libraryIds: number[]) => void) {
  return enqueueJob("convert", label, async (ctx) => {
    const libs = await convertVideos(ids, settingsNow(), ctx)
    after?.(libs)
  })
}

/**
 * Rewind a conversion: the audio file goes again while it's exactly as made.
 * One that's been cut since (renamed or tagged) has to be rewound first.
 */
export async function rewindConversion(op: { fromPath: string; toPath: string; hashAfter: string | null }) {
  const db = getDb()
  if (fs.existsSync(op.toPath)) {
    const st = await fs.promises.stat(op.toPath)
    if (op.hashAfter && (await partialHash(op.toPath, st.size)) !== op.hashAfter) {
      throw new Error(`${path.basename(op.toPath)} has changed since it was made - rewind its cut first`)
    }
    await fs.promises.unlink(op.toPath)
  } else {
    // Gone: cut to another name (rewind that first), or removed by hand (nothing to take away).
    const moved = db.prepare("SELECT path FROM tracks WHERE original_path = ? AND path <> original_path AND missing = 0").get(op.toPath) as { path: string } | undefined
    if (moved && fs.existsSync(moved.path)) throw new Error(`${path.basename(op.toPath)} was cut to ${path.basename(moved.path)} - rewind that first`)
  }
  db.prepare("UPDATE tracks SET missing = 1 WHERE path = ?").run(op.toPath)
  db.prepare("UPDATE videos SET status = 'found', output_path = NULL, converted_at = NULL WHERE output_path = ?").run(op.toPath)
}
