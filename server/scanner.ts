// Read-only library scanner. It only ever stats, lists and reads files -
// nothing here opens a file for writing.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parseFile } from "music-metadata"
import type { ArtRef, ExistingTags, Library, Settings } from "../shared/types"
import { parseKey } from "../shared/keys"
import { describeArt, pickFrontCover } from "./art"
import { parseFilename } from "./core/filename-parser"
import { getDb } from "./db"
import type { JobContext } from "./jobs"
import { mapLimit } from "./jobs"
import { getTrack, knownArtists, touchLibraryScan, updateTrack } from "./repo"
import type { Track } from "../shared/types"

const HASH_CHUNK = 64 * 1024
/** Bump when readAudio starts collecting something new, so unchanged files get re-read once. */
export const TAGS_VERSION = 3

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

/**
 * Every audio file under `root`. `skipAtRoot` names top-level folders to leave out
 * (the holding folder for duplicates that were set aside).
 */
export async function* walk(root: string, extensions: Set<string>, ignore: RegExp[], signal?: AbortSignal, skipAtRoot: string[] = []): AsyncGenerator<string> {
  const stack = [root]
  const skip = new Set(skipAtRoot.map((n) => n.toLowerCase()))
  while (stack.length) {
    if (signal?.aborted) return
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue // unreadable directory - skip, never fail the whole scan
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || ignore.some((re) => re.test(e.name))) continue
      if (dir === root && e.isDirectory() && skip.has(e.name.toLowerCase())) continue
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
    const meta = await parseFile(file, { duration: false, skipCovers: false })
    const c = meta.common
    // Only a description of the cover is kept (hash, size); the bytes stay in the file.
    const cover = pickFrontCover(c.picture)
    const art: ArtRef | null = cover ? describeArt(cover.data, "embedded") : null
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
      bpm: c.bpm && c.bpm > 0 ? Math.round(c.bpm * 10) / 10 : undefined,
      key: firstString(c.key),
      cover: art?.hash,
      mbRecordingId: c.musicbrainz_recordingid || undefined,
      mbReleaseId: c.musicbrainz_albumid || undefined,
      mbArtistId: c.musicbrainz_artistid?.[0] || undefined,
      discogsReleaseId: c.discogs_release_id ? String(c.discogs_release_id) : undefined,
      replayGainTrackGain: Number.isFinite(c.replaygain_track_gain?.dB) ? Math.round(c.replaygain_track_gain!.dB * 100) / 100 : undefined,
      replayGainTrackPeak: Number.isFinite(c.replaygain_track_peak?.ratio) ? Math.round(c.replaygain_track_peak!.ratio * 1e6) / 1e6 : undefined,
    }
    return {
      tags,
      art,
      duration: meta.format.duration ?? null,
      bitrate: meta.format.bitrate ? Math.round(meta.format.bitrate) : null,
      sampleRate: meta.format.sampleRate ?? null,
      codec: meta.format.codec ?? meta.format.container ?? null,
      error: null as string | null,
    }
  } catch (err) {
    return { tags: {}, art: null, duration: null, bitrate: null, sampleRate: null, codec: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Tempo/key from a re-read file's tags. Tags win over an earlier analysis, but
 * values you typed in (neither from the old tags nor the analyser) are kept.
 */
function tempoAndKeyFromTags(t: Track, tags: ExistingTags): Partial<Track> {
  const out: Partial<Track> = {}
  const mine = (field: "bpm" | "key") => {
    const v = t[field]
    const fromOldTags = field === "bpm" ? v === t.tags.bpm : v === parseKey(t.tags.key)
    return v !== null && !fromOldTags && v !== t.analysis?.[field]
  }
  if (tags.bpm && !mine("bpm")) out.bpm = tags.bpm
  const key = parseKey(tags.key)
  if (key && !mine("key")) out.key = key
  return out
}

export function folderContext(relDir: string): string[] {
  return relDir.split(/[\\/]/).filter(Boolean).reverse()
}

export interface ScanResult {
  /** ids of tracks seen for the first time */
  added: number[]
  changed: number[]
}

/**
 * Top-level folders scans leave alone: the holding folder for duplicates, and any
 * older one that still has set-aside copies in it (if the name was changed since).
 */
export function holdingFolders(lib: Library, settings: Settings): string[] {
  const out = new Set([settings.duplicates.holdingFolder])
  for (const r of getDb().prepare("SELECT path FROM tracks WHERE library_id = ? AND aside_json IS NOT NULL").all(lib.id) as { path: string }[]) {
    const first = path.relative(lib.path, r.path).split(path.sep)[0]
    if (first && first !== ".." && !path.isAbsolute(first)) out.add(first)
  }
  return [...out]
}

export async function scanLibrary(lib: Library, settings: Settings, ctx: JobContext): Promise<ScanResult> {
  const db = getDb()
  if (!fs.existsSync(lib.path)) throw new Error(`Library folder not found: ${lib.path}`)
  const extensions = new Set(settings.scanner.extensions.map((e) => e.toLowerCase().replace(/^\./, "")))
  const ignore = settings.scanner.ignore.map(globToRegex)

  ctx.message("Walking folders…")
  const files: string[] = []
  for await (const f of walk(lib.path, extensions, ignore, ctx.signal, holdingFolders(lib, settings))) {
    files.push(f)
    if (files.length % 500 === 0) ctx.message(`Found ${files.length} files…`)
  }
  ctx.setTotal(files.length)
  ctx.log("info", `${lib.name}: found ${files.length} audio files`)

  const existing = new Map<string, { id: number; size: number; mtime: number; tagsVersion: number }>()
  for (const r of db.prepare("SELECT id, path, size, mtime_ms, tags_version FROM tracks WHERE library_id = ?").all(lib.id) as {
    id: number
    path: string
    size: number
    mtime_ms: number
    tags_version: number
  }[]) {
    existing.set(r.path, { id: r.id, size: r.size, mtime: r.mtime_ms, tagsVersion: r.tags_version })
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
  const addedIds: number[] = []
  let moved = 0

  // (duplicates set aside are missing on purpose - a new copy of the same audio is a new track)
  const findMissingByHash = db.prepare("SELECT id FROM tracks WHERE hash = ? AND missing = 1 AND aside_json IS NULL LIMIT 1")
  const insert = db.prepare(
    `INSERT INTO tracks (library_id, path, original_path, rel_dir, filename, ext, size, mtime_ms, hash, duration, bitrate, sample_rate, codec, tags_json, status, note, art_json, bpm, musical_key, tags_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ${TAGS_VERSION}) RETURNING id`
  )
  const markRead = db.prepare(`UPDATE tracks SET tags_version = ${TAGS_VERSION} WHERE id = ?`)
  const insertData = db.prepare("INSERT INTO track_data (track_id, heuristic_json) VALUES (?, ?)")
  const prevTrack = (id: number) => getTrack(id)!

  await mapLimit(files, 8, ctx.signal, async (file) => {
    try {
      const st = await fs.promises.stat(file)
      const prev = existing.get(file)
      if (prev && prev.size === st.size && Math.round(prev.mtime) === Math.round(st.mtimeMs) && prev.tagsVersion >= TAGS_VERSION) {
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
          art: audio.art,
          ...tempoAndKeyFromTags(prevTrack(prev.id), audio.tags),
          heuristic,
          missing: false,
        })
        markRead.run(prev.id)
        seen.add(prev.id)
        changed.push(prev.id)
      } else {
        // A file that disappeared from its old path and reappeared here was moved.
        const movedRow = hash ? (findMissingByHash.get(hash) as { id: number } | undefined) : undefined
        // (a moved file's tags are re-read below, like any new path)
        const movedTrack = movedRow ? getTrack(movedRow.id) : null
        if (movedTrack) {
          const t = movedTrack
          updateTrack(t.id, { path: file, filename, ext, relDir, mtimeMs: st.mtimeMs, missing: false, heuristic, tags: audio.tags, art: audio.art, ...tempoAndKeyFromTags(t, audio.tags) })
          markRead.run(t.id)
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
            audio.error ? `Tag read failed: ${audio.error}` : null,
            audio.art ? JSON.stringify(audio.art) : null,
            audio.tags.bpm ?? null,
            parseKey(audio.tags.key)
          ) as { id: number }
          insertData.run(r.id, JSON.stringify(heuristic))
          seen.add(r.id)
          changed.push(r.id)
          addedIds.push(r.id)
        }
      }
      ctx.tick(true)
    } catch (err) {
      ctx.tick(false)
      ctx.log("warn", `Could not read ${file}: ${err instanceof Error ? err.message : err}`)
    }
  })

  if (ctx.signal.aborted) return { added: addedIds, changed }

  const added = addedIds.length
  missing -= moved
  touchLibraryScan(lib.id)
  ctx.tracksChanged(changed)
  ctx.log("success", `${lib.name}: ${added} new, ${changed.length - added - moved} updated, ${moved} moved, ${missing} missing`)
  return { added: addedIds, changed }
}

/**
 * A cheap look for changes without touching the job queue: walks the folders
 * and compares sizes and times with what's stored. Used by folder watching so
 * a quiet library never fills the job history with empty scans.
 */
export async function libraryHasChanges(lib: Library, settings: Settings, signal?: AbortSignal): Promise<boolean> {
  if (!fs.existsSync(lib.path)) return false
  const extensions = new Set(settings.scanner.extensions.map((e) => e.toLowerCase().replace(/^\./, "")))
  const ignore = settings.scanner.ignore.map(globToRegex)
  const stale = getDb().prepare("SELECT 1 FROM tracks WHERE library_id = ? AND missing = 0 AND tags_version < ? LIMIT 1").get(lib.id, TAGS_VERSION)
  if (stale) return true
  const known = new Map<string, { size: number; mtime: number; missing: number }>()
  for (const r of getDb().prepare("SELECT path, size, mtime_ms, missing FROM tracks WHERE library_id = ?").all(lib.id) as { path: string; size: number; mtime_ms: number; missing: number }[]) {
    known.set(r.path, { size: r.size, mtime: r.mtime_ms, missing: r.missing })
  }
  let present = 0
  for await (const file of walk(lib.path, extensions, ignore, signal, holdingFolders(lib, settings))) {
    const k = known.get(file)
    if (!k || k.missing) return true
    const st = await fs.promises.stat(file).catch(() => null)
    if (!st || st.size !== k.size || Math.round(st.mtimeMs) !== Math.round(k.mtime)) return true
    present++
  }
  const stillKnown = [...known.values()].filter((k) => !k.missing).length
  return present !== stillKnown
}
