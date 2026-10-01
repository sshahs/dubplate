// Disc and track numbers for the tags, from a file's name and folders when its
// tags don't say: "CD2/05" is disc 2, track 5; "1-05" the same on disc 1.
// Vinyl positions count on across a record's sides using the other files of
// the same record, so B2 after four tracks on side A is track 6 - players and
// Jellyfin then keep a multi-disc album together and in order.

import path from "node:path"
import type { DiscPosition, ExistingTags, HeuristicParse, Track } from "../shared/types"
import { isDiscFolder, sideOnDisc, sideToDisc, trackOnDisc } from "./core/discs"
import { getDb, parseJson } from "./db"

export interface Placement {
  disc?: number
  discTotal?: number
  track?: number
}

/** The record's folder: the track's folder without "CD2", "Side A" and the like at the end. */
export function recordFolder(relDir: string): string {
  const parts = relDir.split(/[\\/]/).filter(Boolean)
  while (parts.length && isDiscFolder(parts[parts.length - 1])) parts.pop()
  return parts.join("/")
}

type Sibling = { id: number; position: DiscPosition | undefined; tags: ExistingTags }

/** The files of one record: its folder, and any disc or side folders inside it. */
function recordFiles(libraryId: number, folder: string): Sibling[] {
  const db = getDb()
  const native = folder.split("/").join(path.sep)
  // The record's own folder, and its disc or side folders (at the top of a library: only those).
  const dirs = [native]
  const like = folder ? `${native.replace(/[\\%_]/g, (c) => `\\${c}`)}${path.sep.replace("\\", "\\\\")}%` : null
  const sub = like
    ? (db.prepare("SELECT DISTINCT rel_dir FROM tracks WHERE library_id = ? AND rel_dir LIKE ? ESCAPE '\\'").all(libraryId, like) as { rel_dir: string }[])
    : (db.prepare("SELECT DISTINCT rel_dir FROM tracks WHERE library_id = ? AND rel_dir <> ''").all(libraryId) as { rel_dir: string }[]).filter((r) => !/[\\/]/.test(r.rel_dir))
  for (const r of sub) if (recordFolder(r.rel_dir) === folder) dirs.push(r.rel_dir)
  const rows = db
    .prepare(
      `SELECT t.id, t.rel_dir, t.tags_json, d.heuristic_json FROM tracks t LEFT JOIN track_data d ON d.track_id = t.id
       WHERE t.library_id = ? AND t.missing = 0 AND t.rel_dir IN (${dirs.map(() => "?").join(", ")})`
    )
    .all(libraryId, ...dirs) as { id: number; rel_dir: string; tags_json: string; heuristic_json: string | null }[]
  return rows
    .filter((r) => recordFolder(r.rel_dir) === folder)
    .map((r) => ({ id: r.id, position: parseJson<HeuristicParse | null>(r.heuristic_json, null)?.position, tags: parseJson<ExistingTags>(r.tags_json, {}) }))
}

/** Disc and track numbers for each of these tracks, where their names or folders give them. */
export function placementsFor(tracks: Pick<Track, "id" | "libraryId" | "relDir" | "heuristic" | "tags">[]): Map<number, Placement> {
  const out = new Map<number, Placement>()
  const records = new Map<string, Sibling[]>()
  for (const t of tracks) {
    const p = t.heuristic?.position
    if (!p) continue
    const folder = recordFolder(t.relDir)
    const key = `${t.libraryId}\0${folder}`
    if (!records.has(key)) records.set(key, recordFiles(t.libraryId, folder))
    const siblings = records.get(key)!.filter((s) => s.id !== t.id)
    // How many discs: the numbers the files and folders show, or what a tag already says.
    const discs = [p, ...siblings.map((s) => s.position)].map((x) => x?.disc ?? (x?.side ? sideToDisc(x.side) : undefined)).filter((d): d is number => !!d)
    const tagged = [t.tags.discTotal, ...siblings.map((s) => s.tags.discTotal)].filter((d): d is number => !!d)
    const discTotal = Math.max(1, ...discs, ...tagged)
    const disc = p.disc ?? (p.side ? sideToDisc(p.side) : undefined)
    const place: Placement = {}
    if (disc && discTotal > 1) {
      place.disc = disc
      place.discTotal = discTotal
    }
    if (p.whole) {
      // A whole side: the first or second part of its record (a side split into parts can't be numbered).
      if (p.side && !p.part) place.track = sideOnDisc(p.side)
    } else {
      const sameDisc = siblings.map((s) => s.position).filter((s): s is DiscPosition => !!s && (s.disc ?? (s.side ? sideToDisc(s.side) : 1)) === (disc ?? 1))
      const n = trackOnDisc(p, sameDisc)
      if (n) place.track = n
    }
    if (Object.keys(place).length) out.set(t.id, place)
  }
  return out
}
