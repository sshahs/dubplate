// Read-only library scanner. It only ever stats, lists and reads files —
// nothing here opens a file for writing.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parseFile } from "music-metadata"
import type { ExistingTags, Library, Settings } from "../shared/types"
import { parseFilename } from "./core/filename-parser"
import { getDb } from "./db"
import type { JobContext } from "./jobs"
import { mapLimit } from "./jobs"
import { knownArtists, rowToTrack, touchLibraryScan, updateTrack } from "./repo"

const HASH_CHUNK = 64 * 1024

/** Fast content fingerprint: size + first and last 64 KiB. Enough to spot
 *  duplicates and follow files that were moved outside Dubplate. */
export async function partialHash(file: string, size: number): Promise<string> {
  const h = createHash("sha1")
  h.update(String(size))
  const fh = await fs.promises.open(file, "r")
  try {
    const head = Buffer.alloc(Math.min(HASH_CHUNK, size))
    await fh.read(head, 0, head.length, 0)
    h.update(head)
    if (size > HASH_CHUNK * 2) {
      const tail = Buffer.alloc(HASH_CHUNK)
      await fh.read(tail, 0, HASH_CHUNK, size - HASH_CHUNK)
      h.update(tail)
    }
  } finally {
    await fh.close()
  }
  return h.digest("hex")
}

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${esc}$`, "i")
}

export async function* walk(root: string, extensions: Set<string>, ignore: RegExp[], signal?: AbortSignal): AsyncGenerator<string> {
  const stack = [root]
  while (stack.length) {
    if (signal?.aborted) return
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue // unreadable directory — skip, never fail the whole scan
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || ignore.some((re) => re.test(e.name))) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        const ext = path.extname(e.name).slice(1).toLowerCase()
        if (extensions.has(ext)) yield full
      }
    }
  }
}

function firstString(v: unknown): string | undefined {
  if (Array.isArray(v)) return firstString(v[0])
  if (typeof v === "string") return v.trim() || undefined
  if (v && typeof v === "object" && "text" in v) return firstString((v as { text: unknown }).text)
  return undefined
}

export async function readAudio(file: string) {
  try {
    const meta = await parseFile(file, { duration: false, skipCovers: true })
    const c = meta.common
    const tags: ExistingTags = {
      artist: c.artist?.trim() || undefined,
      artists: c.artists?.length ? c.artists : undefined,
      title: c.title?.trim() || undefined,
      album: c.album?.trim() || undefined,
      albumArtist: c.albumartist?.trim() || undefined,
      year: c.year || undefined,
      genre: c.genre?.length ? c.genre : undefined,
      track: c.track?.no ?? undefined,
      label: firstString(c.label),
      comment: firstString(c.comment),
    }
    return {
      tags,
      duration: meta.format.duration ?? null,
      bitrate: meta.format.bitrate ? Math.round(meta.format.bitrate) : null,
      sampleRate: meta.format.sampleRate ?? null,
      codec: meta.format.codec ?? meta.format.container ?? null,
      error: null as string | null,
    }
  } catch (err) {
    return { tags: {}, duration: null, bitrate: null, sampleRate: null, codec: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export function folderContext(relDir: string): string[] {
  return relDir.split(/[\\/]/).filter(Boolean).reverse()
}

export async function scanLibrary(lib: Library, settings: Settings, ctx: JobContext) {
  const db = getDb()
  if (!fs.existsSync(lib.path)) throw new Error(`Library folder not found: ${lib.path}`)
  const extensions = new Set(settings.scanner.extensions.map((e) => e.toLowerCase().replace(/^\./, "")))
  const ignore = settings.scanner.ignore.map(globToRegex)

  ctx.message("Walking folders…")
  const files: string[] = []
  for await (const f of walk(lib.path, extensions, ignore, ctx.signal)) {
    files.push(f)
    if (files.length % 500 === 0) ctx.message(`Found ${files.length} files…`)
  }
  ctx.setTotal(files.length)
  ctx.log("info", `${lib.name}: found ${files.length} audio files`)

  const existing = new Map<string, { id: number; size: number; mtime: number }>()
  for (const r of db.prepare("SELECT id, path, size, mtime_ms FROM tracks WHERE library_id = ?").all(lib.id) as { id: number; path: string; size: number; mtime_ms: number }[]) {
    existing.set(r.path, { id: r.id, size: r.size, mtime: r.mtime_ms })
  }
  // Files we knew about that aren't on disk any more are flagged up front, so
  // a file that merely moved can be matched back to its record by hash below.
  const onDisk = new Set(files)
  const markMissing = db.prepare("UPDATE tracks SET missing = 1 WHERE id = ? AND missing = 0")
  let missing = 0
  for (const [p, { id }] of existing) {
    if (!onDisk.has(p)) missing += Number(markMissing.run(id).changes)
  }

  const known = knownArtists()
  const seen = new Set<number>()
  const changed: number[] = []
  let added = 0
  let moved = 0

  const findMissingByHash = db.prepare("SELECT * FROM tracks WHERE hash = ? AND missing = 1 LIMIT 1")
  const insert = db.prepare(
    `INSERT INTO tracks (library_id, path, original_path, rel_dir, filename, ext, size, mtime_ms, hash, duration, bitrate, sample_rate, codec, tags_json, heuristic_json, status, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?) RETURNING id`
  )

  await mapLimit(files, 8, ctx.signal, async (file) => {
    try {
      const st = await fs.promises.stat(file)
      const prev = existing.get(file)
      if (prev && prev.size === st.size && Math.round(prev.mtime) === Math.round(st.mtimeMs)) {
        seen.add(prev.id)
        db.prepare("UPDATE tracks SET missing = 0 WHERE id = ? AND missing = 1").run(prev.id)
        ctx.tick(true)
        return
      }
      const relDir = path.relative(lib.path, path.dirname(file))
      const filename = path.basename(file)
      const ext = path.extname(filename).slice(1).toLowerCase()
      const [audio, hash] = await Promise.all([readAudio(file), settings.scanner.hashFiles ? partialHash(file, st.size) : Promise.resolve(null)])
      const heuristic = parseFilename(filename, { folders: folderContext(relDir), tagArtist: audio.tags.artist, knownArtists: known })

      if (prev) {
        updateTrack(prev.id, {
          size: st.size,
          mtimeMs: st.mtimeMs,
          hash,
          duration: audio.duration,
          bitrate: audio.bitrate,
          sampleRate: audio.sampleRate,
          codec: audio.codec,
          tags: audio.tags,
          heuristic,
          missing: false,
        })
        seen.add(prev.id)
        changed.push(prev.id)
      } else {
        // A file that disappeared from its old path and reappeared here was moved.
        const movedRow = hash ? (findMissingByHash.get(hash) as Record<string, unknown> | undefined) : undefined
        if (movedRow) {
          const t = rowToTrack(movedRow)
          updateTrack(t.id, { path: file, filename, ext, relDir, mtimeMs: st.mtimeMs, missing: false, heuristic })
          db.prepare("UPDATE tracks SET library_id = ? WHERE id = ?").run(lib.id, t.id)
          seen.add(t.id)
          changed.push(t.id)
          moved++
        } else {
          const r = insert.get(
            lib.id,
            file,
            file,
            relDir,
            filename,
            ext,
            st.size,
            st.mtimeMs,
            hash,
            audio.duration,
            audio.bitrate,
            audio.sampleRate,
            audio.codec,
            JSON.stringify(audio.tags),
            JSON.stringify(heuristic),
            audio.error ? `Tag read failed: ${audio.error}` : null
          ) as { id: number }
          seen.add(r.id)
          changed.push(r.id)
          added++
        }
      }
      ctx.tick(true)
    } catch (err) {
      ctx.tick(false)
      ctx.log("warn", `Could not read ${file}: ${err instanceof Error ? err.message : err}`)
    }
  })

  if (ctx.signal.aborted) return

  missing -= moved
  touchLibraryScan(lib.id)
  ctx.tracksChanged(changed)
  ctx.log("success", `${lib.name}: ${added} new, ${changed.length - added - moved} updated, ${moved} moved, ${missing} missing`)
}
