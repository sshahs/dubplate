// Videos in a library (AVI, 3GP, WMV…): scans list them - a stat and an
// ffprobe look, nothing written - so the converter can pull their audio out.

import fs from "node:fs"
import path from "node:path"
import type { Library, MediaProbe, VideoFile } from "../shared/types"
import { getDb, parseJson } from "./db"
import type { JobContext } from "./jobs"
import { mapLimit } from "./jobs"
import { findFfprobe, probeMedia } from "./media/ffmpeg"

type Row = {
  id: number
  library_id: number
  path: string
  rel_dir: string
  filename: string
  ext: string
  size: number
  mtime_ms: number
  probe_json: string | null
  status: string
  output_path: string | null
  error: string | null
  converted_at: string | null
  aside_from: string | null
  missing: number
}

function toVideo(r: Row): VideoFile {
  return {
    id: r.id,
    libraryId: r.library_id,
    path: r.path,
    relDir: r.rel_dir,
    filename: r.filename,
    ext: r.ext,
    size: r.size,
    probe: parseJson<MediaProbe | null>(r.probe_json, null),
    status: (["found", "converted", "failed", "no-audio"].includes(r.status) ? r.status : "found") as VideoFile["status"],
    outputPath: r.output_path,
    error: r.error,
    convertedAt: r.converted_at,
    asideFrom: r.aside_from,
    missing: !!r.missing,
  }
}

export function listVideos(opts: { libraryId?: number } = {}): VideoFile[] {
  const rows = (
    opts.libraryId
      ? getDb().prepare("SELECT * FROM videos WHERE library_id = ? AND missing = 0 ORDER BY rel_dir, filename").all(opts.libraryId)
      : getDb().prepare("SELECT * FROM videos WHERE missing = 0 ORDER BY library_id, rel_dir, filename").all()
  ) as Row[]
  return rows.map(toVideo)
}

export function getVideo(id: number): VideoFile | null {
  const r = getDb().prepare("SELECT * FROM videos WHERE id = ?").get(id) as Row | undefined
  return r ? toVideo(r) : null
}

/** Videos still waiting to be converted (with audio in them, not tried and failed). */
export function videosToConvert(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM videos WHERE missing = 0 AND status = 'found'").get() as { n: number }).n
}

const COLS: Partial<Record<keyof VideoFile, string>> = {
  path: "path",
  relDir: "rel_dir",
  filename: "filename",
  probe: "probe_json",
  status: "status",
  outputPath: "output_path",
  error: "error",
  convertedAt: "converted_at",
  asideFrom: "aside_from",
  missing: "missing",
}

export function updateVideo(id: number, patch: Partial<VideoFile>) {
  const sets: string[] = []
  const vals: (string | number | null)[] = []
  for (const [k, v] of Object.entries(patch)) {
    const col = COLS[k as keyof VideoFile]
    if (!col) continue
    sets.push(`${col} = ?`)
    vals.push(k === "probe" ? (v ? JSON.stringify(v) : null) : k === "missing" ? (v ? 1 : 0) : ((v as string | number | null) ?? null))
  }
  if (sets.length) getDb().prepare(`UPDATE videos SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id)
}

/** A video moved (set aside, or put back by a rewind): follow it. */
export function videoMoved(from: string, to: string, asideFrom: string | null) {
  getDb().prepare("UPDATE videos SET path = ?, filename = ?, aside_from = ?, missing = 0 WHERE path = ?").run(to, path.basename(to), asideFrom, from)
}

/** What's inside, or null when ffprobe isn't installed or can't read it (it's looked at again at conversion). */
async function look(file: string, signal: AbortSignal): Promise<{ probe: MediaProbe | null; error: string | null }> {
  if (!findFfprobe()) return { probe: null, error: null }
  try {
    return { probe: await probeMedia(file, signal), error: null }
  } catch (err) {
    return { probe: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Record the videos a scan walked past: new ones are looked into, changed ones
 * looked at again, gone ones flagged missing (except those set aside after
 * converting - they live in the holding folder scans skip). Returns the ids of
 * new or changed videos with audio in them.
 */
export async function recordVideos(lib: Library, files: string[], ctx: JobContext): Promise<number[]> {
  const db = getDb()
  const existing = new Map((db.prepare("SELECT * FROM videos WHERE library_id = ?").all(lib.id) as Row[]).map((r) => [r.path, r]))
  const onDisk = new Set(files)
  for (const r of existing.values()) if (!onDisk.has(r.path) && !r.aside_from && !r.missing) db.prepare("UPDATE videos SET missing = 1 WHERE id = ?").run(r.id)
  const fresh: number[] = []
  const insert = db.prepare(
    "INSERT INTO videos (library_id, path, rel_dir, filename, ext, size, mtime_ms, probe_json, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  )
  await mapLimit(files, 4, ctx.signal, async (file) => {
    try {
      const st = await fs.promises.stat(file)
      const prev = existing.get(file)
      if (prev && prev.size === st.size && Math.round(prev.mtime_ms) === Math.round(st.mtimeMs)) {
        if (prev.missing) db.prepare("UPDATE videos SET missing = 0 WHERE id = ?").run(prev.id)
        return
      }
      const { probe, error } = await look(file, ctx.signal)
      const status = probe && !probe.audio.length ? "no-audio" : "found"
      if (prev) {
        // Changed since: a new download over the old one, say. It's a video to convert again.
        db.prepare("UPDATE videos SET size = ?, mtime_ms = ?, probe_json = ?, status = ?, error = ?, output_path = NULL, converted_at = NULL, missing = 0 WHERE id = ?").run(
          st.size,
          st.mtimeMs,
          probe ? JSON.stringify(probe) : null,
          status,
          error,
          prev.id
        )
        if (status === "found") fresh.push(prev.id)
      } else {
        const r = insert.get(lib.id, file, path.relative(lib.path, path.dirname(file)), path.basename(file), path.extname(file).slice(1).toLowerCase(), st.size, st.mtimeMs, probe ? JSON.stringify(probe) : null, status, error) as {
          id: number
        }
        if (status === "found") fresh.push(r.id)
      }
    } catch (err) {
      ctx.log("warn", `Could not look at ${file}: ${err instanceof Error ? err.message : err}`)
    }
  })
  return fresh
}
