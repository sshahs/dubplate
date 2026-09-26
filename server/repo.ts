// Data access for the staging database.

import fs from "node:fs"
import type { SQLInputValue } from "node:sqlite"
import type {
  Alias,
  Correction,
  ExistingTags,
  Library,
  Operation,
  OperationBatch,
  Stats,
  Track,
  TrackStatus,
  TrackSummary,
} from "../shared/types"
import { TRACK_STATUSES } from "../shared/types"
import { normArtist } from "./core/normalize"
import { getDb, parseJson } from "./db"

type Row = Record<string, unknown>

// ---------- libraries ----------

function rowToLibrary(r: Row): Library {
  return {
    id: r.id as number,
    path: r.path as string,
    name: r.name as string,
    createdAt: r.created_at as string,
    lastScanAt: (r.last_scan_at as string) ?? null,
    fileCount: r.file_count as number,
    exists: fs.existsSync(r.path as string),
  }
}

export function listLibraries(): Library[] {
  return (getDb().prepare("SELECT * FROM libraries ORDER BY name").all() as Row[]).map(rowToLibrary)
}

export function getLibrary(id: number): Library | null {
  const r = getDb().prepare("SELECT * FROM libraries WHERE id = ?").get(id) as Row | undefined
  return r ? rowToLibrary(r) : null
}

export function addLibrary(p: string, name: string): Library {
  const r = getDb().prepare("INSERT INTO libraries (path, name) VALUES (?, ?) RETURNING *").get(p, name) as Row
  return rowToLibrary(r)
}

export function removeLibrary(id: number) {
  getDb().prepare("DELETE FROM libraries WHERE id = ?").run(id)
}

export function touchLibraryScan(id: number) {
  getDb()
    .prepare("UPDATE libraries SET last_scan_at = datetime('now'), file_count = (SELECT COUNT(*) FROM tracks WHERE library_id = ? AND missing = 0) WHERE id = ?")
    .run(id, id)
}

// ---------- tracks ----------

export function rowToTrack(r: Row): Track {
  return {
    id: r.id as number,
    libraryId: r.library_id as number,
    path: r.path as string,
    originalPath: r.original_path as string,
    relDir: r.rel_dir as string,
    filename: r.filename as string,
    ext: r.ext as string,
    size: r.size as number,
    mtimeMs: r.mtime_ms as number,
    hash: (r.hash as string) ?? null,
    duration: (r.duration as number) ?? null,
    bitrate: (r.bitrate as number) ?? null,
    sampleRate: (r.sample_rate as number) ?? null,
    codec: (r.codec as string) ?? null,
    tags: parseJson<ExistingTags>(r.tags_json, {}),
    heuristic: parseJson(r.heuristic_json, null),
    ai: parseJson(r.ai_json, null),
    candidates: parseJson(r.candidates_json, null),
    decision: parseJson(r.decision_json, null),
    final: parseJson(r.final_json, null),
    confidence: (r.confidence as number) ?? null,
    status: r.status as TrackStatus,
    proposedName: (r.proposed_name as string) ?? null,
    note: (r.note as string) ?? null,
    missing: !!r.missing,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

export function toSummary(t: Track): TrackSummary {
  const { candidates: _c, decision, heuristic, ai, ...rest } = t
  const reading = t.final ?? decision ?? ai ?? heuristic
  return {
    ...rest,
    proposedArtist: reading ? (reading.artists ?? []).join(", ") || null : null,
    proposedTitle: reading?.title ?? null,
    sourceCount: decision?.clusters[0]?.sources.length ?? 0,
    conflict: decision?.status === "conflict",
  }
}

export function getTrack(id: number): Track | null {
  const r = getDb().prepare("SELECT * FROM tracks WHERE id = ?").get(id) as Row | undefined
  return r ? rowToTrack(r) : null
}

export function getTracks(ids: number[]): Track[] {
  if (!ids.length) return []
  const out: Track[] = []
  const stmt = getDb().prepare("SELECT * FROM tracks WHERE id = ?")
  for (const id of ids) {
    const r = stmt.get(id) as Row | undefined
    if (r) out.push(rowToTrack(r))
  }
  return out
}

export interface TrackQuery {
  status?: TrackStatus[]
  libraryId?: number
  q?: string
  minConfidence?: number
  maxConfidence?: number
  includeMissing?: boolean
  sort?: "filename" | "confidence" | "status" | "updated" | "path"
  dir?: "asc" | "desc"
  limit?: number
  offset?: number
}

function whereFor(q: TrackQuery): { sql: string; params: SQLInputValue[] } {
  const where: string[] = []
  const params: SQLInputValue[] = []
  if (!q.includeMissing) where.push("missing = 0")
  if (q.status?.length) {
    where.push(`status IN (${q.status.map(() => "?").join(",")})`)
    params.push(...q.status)
  }
  if (q.libraryId) {
    where.push("library_id = ?")
    params.push(q.libraryId)
  }
  if (q.q) {
    where.push("(filename LIKE ? OR rel_dir LIKE ? OR proposed_name LIKE ? OR tags_json LIKE ?)")
    const like = `%${q.q.replace(/[%_]/g, (m) => "\\" + m)}%`
    params.push(like, like, like, like)
  }
  if (q.minConfidence !== undefined) {
    where.push("confidence >= ?")
    params.push(q.minConfidence)
  }
  if (q.maxConfidence !== undefined) {
    where.push("confidence <= ?")
    params.push(q.maxConfidence)
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params }
}

export function queryTracks(q: TrackQuery): { items: TrackSummary[]; total: number } {
  const db = getDb()
  const { sql, params } = whereFor(q)
  const sortCol = { filename: "filename COLLATE NOCASE", confidence: "confidence", status: "status", updated: "updated_at", path: "path" }[q.sort ?? "filename"]
  const dir = q.dir === "desc" ? "DESC" : "ASC"
  const limit = Math.min(q.limit ?? 100, 1000)
  const offset = q.offset ?? 0
  const rows = db.prepare(`SELECT * FROM tracks ${sql} ORDER BY ${sortCol} ${dir} NULLS LAST, id LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[]
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM tracks ${sql}`).get(...params) as { n: number }).n
  return { items: rows.map((r) => toSummary(rowToTrack(r))), total }
}

export function queryTrackIds(q: TrackQuery): number[] {
  const { sql, params } = whereFor(q)
  return (getDb().prepare(`SELECT id FROM tracks ${sql} ORDER BY id`).all(...params) as { id: number }[]).map((r) => r.id)
}

const JSON_COLS = new Set(["tags", "heuristic", "ai", "candidates", "decision", "final"])
const COLS: Record<string, string> = {
  path: "path",
  filename: "filename",
  ext: "ext",
  relDir: "rel_dir",
  size: "size",
  mtimeMs: "mtime_ms",
  hash: "hash",
  duration: "duration",
  bitrate: "bitrate",
  sampleRate: "sample_rate",
  codec: "codec",
  tags: "tags_json",
  heuristic: "heuristic_json",
  ai: "ai_json",
  candidates: "candidates_json",
  decision: "decision_json",
  final: "final_json",
  confidence: "confidence",
  status: "status",
  proposedName: "proposed_name",
  note: "note",
  missing: "missing",
}

export function updateTrack(id: number, patch: Partial<Track>) {
  const sets: string[] = []
  const params: SQLInputValue[] = []
  for (const [k, v] of Object.entries(patch)) {
    const col = COLS[k]
    if (!col) continue
    sets.push(`${col} = ?`)
    if (JSON_COLS.has(k)) params.push(v === null || v === undefined ? null : JSON.stringify(v))
    else if (typeof v === "boolean") params.push(v ? 1 : 0)
    else params.push((v ?? null) as SQLInputValue)
  }
  if (!sets.length) return
  sets.push("updated_at = datetime('now')")
  getDb().prepare(`UPDATE tracks SET ${sets.join(", ")} WHERE id = ?`).run(...params, id)
}

export function setStatus(ids: number[], status: TrackStatus) {
  const stmt = getDb().prepare("UPDATE tracks SET status = ?, updated_at = datetime('now') WHERE id = ?")
  for (const id of ids) stmt.run(status, id)
}

// ---------- known artists (feeds the heuristic parser) ----------

export function knownArtists(): Set<string> {
  const db = getDb()
  const out = new Set<string>()
  for (const r of db.prepare("SELECT alias, canonical FROM aliases").all() as { alias: string; canonical: string }[]) {
    out.add(normArtist(r.alias))
    out.add(normArtist(r.canonical))
  }
  for (const r of db.prepare("SELECT artists_json FROM corrections").all() as { artists_json: string }[]) {
    for (const a of parseJson<string[]>(r.artists_json, [])) out.add(normArtist(a))
  }
  for (const r of db.prepare("SELECT DISTINCT json_extract(tags_json, '$.artist') AS a FROM tracks WHERE a IS NOT NULL").all() as { a: string }[]) {
    const k = normArtist(r.a)
    if (k.length > 2) out.add(k)
  }
  out.delete("")
  return out
}

// ---------- aliases & corrections ----------

export function listAliases(): Alias[] {
  return getDb().prepare("SELECT id, alias, canonical FROM aliases ORDER BY canonical, alias").all() as unknown as Alias[]
}

export function upsertAlias(alias: string, canonical: string) {
  getDb()
    .prepare("INSERT INTO aliases (alias, canonical) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical")
    .run(normArtist(alias), canonical.trim())
}

export function deleteAlias(id: number) {
  getDb().prepare("DELETE FROM aliases WHERE id = ?").run(id)
}

export function aliasMap(): Map<string, string> {
  return new Map(listAliases().map((a) => [a.alias, a.canonical]))
}

export function addCorrection(filename: string, artists: string[], title: string, version?: string) {
  const db = getDb()
  db.prepare("DELETE FROM corrections WHERE filename = ?").run(filename)
  db.prepare("INSERT INTO corrections (filename, artists_json, title, version) VALUES (?, ?, ?, ?)").run(filename, JSON.stringify(artists), title, version ?? null)
}

export function listCorrections(limit = 500): Correction[] {
  return (getDb().prepare("SELECT * FROM corrections ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
    id: r.id as number,
    filename: r.filename as string,
    artists: parseJson<string[]>(r.artists_json, []),
    title: r.title as string,
    version: (r.version as string) ?? null,
    createdAt: r.created_at as string,
  }))
}

export function deleteCorrection(id: number) {
  getDb().prepare("DELETE FROM corrections WHERE id = ?").run(id)
}

// ---------- operations ----------

function rowToOperation(r: Row): Operation {
  return {
    id: r.id as number,
    batchId: r.batch_id as string,
    trackId: (r.track_id as number) ?? null,
    kind: r.kind as Operation["kind"],
    fromPath: r.from_path as string,
    toPath: r.to_path as string,
    tagsBefore: parseJson(r.tags_before_json, null),
    tagsAfter: parseJson(r.tags_after_json, null),
    status: r.status as Operation["status"],
    error: (r.error as string) ?? null,
    createdAt: r.created_at as string,
    revertedAt: (r.reverted_at as string) ?? null,
  }
}

export function insertOperation(op: Omit<Operation, "id" | "createdAt" | "revertedAt">): number {
  const r = getDb()
    .prepare(
      `INSERT INTO operations (batch_id, track_id, kind, from_path, to_path, tags_before_json, tags_after_json, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      op.batchId,
      op.trackId,
      op.kind,
      op.fromPath,
      op.toPath,
      op.tagsBefore ? JSON.stringify(op.tagsBefore) : null,
      op.tagsAfter ? JSON.stringify(op.tagsAfter) : null,
      op.status,
      op.error
    ) as { id: number }
  return r.id
}

export function markOperationReverted(id: number, error?: string) {
  if (error) getDb().prepare("UPDATE operations SET error = ? WHERE id = ?").run(error, id)
  else getDb().prepare("UPDATE operations SET status = 'reverted', reverted_at = datetime('now') WHERE id = ?").run(id)
}

export function listOperations(batchId?: string, limit = 500): Operation[] {
  const rows = batchId
    ? getDb().prepare("SELECT * FROM operations WHERE batch_id = ? ORDER BY id").all(batchId)
    : getDb().prepare("SELECT * FROM operations ORDER BY id DESC LIMIT ?").all(limit)
  return (rows as Row[]).map(rowToOperation)
}

export function listBatches(limit = 50): OperationBatch[] {
  return (
    getDb()
      .prepare(
        `SELECT batch_id, MIN(created_at) AS created_at, COUNT(*) AS count,
          SUM(status = 'done') AS done, SUM(status = 'failed') AS failed,
          SUM(status = 'reverted') AS reverted, SUM(status = 'dry-run') AS dry
         FROM operations GROUP BY batch_id ORDER BY MIN(id) DESC LIMIT ?`
      )
      .all(limit) as Row[]
  ).map((r) => ({
    batchId: r.batch_id as string,
    createdAt: r.created_at as string,
    count: r.count as number,
    done: r.done as number,
    failed: r.failed as number,
    reverted: r.reverted as number,
    dryRun: (r.dry as number) > 0,
  }))
}

// ---------- stats ----------

export function stats(): Stats {
  const db = getDb()
  const byStatus = Object.fromEntries(TRACK_STATUSES.map((s) => [s, 0])) as Record<TrackStatus, number>
  for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM tracks WHERE missing = 0 GROUP BY status").all() as { status: TrackStatus; n: number }[]) {
    byStatus[r.status] = r.n
  }
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
  const buckets = [
    { bucket: "0–39", lo: 0, hi: 39 },
    { bucket: "40–59", lo: 40, hi: 59 },
    { bucket: "60–74", lo: 60, hi: 74 },
    { bucket: "75–89", lo: 75, hi: 89 },
    { bucket: "90–100", lo: 90, hi: 100 },
  ]
  const confidenceBuckets = buckets.map((b) => ({
    bucket: b.bucket,
    count: (db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE missing = 0 AND confidence BETWEEN ? AND ?").get(b.lo, b.hi) as { n: number }).n,
  }))
  const libraries = (db.prepare("SELECT COUNT(*) AS n FROM libraries").get() as { n: number }).n
  const operations = (db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status = 'done'").get() as { n: number }).n
  const duplicates = (
    db.prepare("SELECT COUNT(*) AS n FROM (SELECT hash FROM tracks WHERE hash IS NOT NULL AND missing = 0 GROUP BY hash HAVING COUNT(*) > 1)").get() as { n: number }
  ).n
  const sourceCounts = new Map<string, number>()
  for (const r of db.prepare("SELECT decision_json FROM tracks WHERE decision_json IS NOT NULL AND missing = 0").all() as { decision_json: string }[]) {
    const d = parseJson<{ clusters?: { sources: string[] }[] }>(r.decision_json, {})
    for (const s of d.clusters?.[0]?.sources ?? []) sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1)
  }
  return {
    total,
    byStatus,
    confidenceBuckets,
    libraries,
    operations,
    duplicates,
    sources: [...sourceCounts.entries()].map(([source, hits]) => ({ source, hits })).sort((a, b) => b.hits - a.hits),
  }
}

export function duplicateGroups(): { key: string; kind: "hash" | "name"; tracks: TrackSummary[] }[] {
  const db = getDb()
  const out: { key: string; kind: "hash" | "name"; tracks: TrackSummary[] }[] = []
  const hashes = db.prepare("SELECT hash FROM tracks WHERE hash IS NOT NULL AND missing = 0 GROUP BY hash HAVING COUNT(*) > 1 LIMIT 200").all() as { hash: string }[]
  for (const { hash } of hashes) {
    const rows = db.prepare("SELECT * FROM tracks WHERE hash = ? AND missing = 0").all(hash) as Row[]
    out.push({ key: hash, kind: "hash", tracks: rows.map((r) => toSummary(rowToTrack(r))) })
  }
  const names = db
    .prepare("SELECT proposed_name FROM tracks WHERE proposed_name IS NOT NULL AND missing = 0 GROUP BY lower(proposed_name) HAVING COUNT(*) > 1 LIMIT 200")
    .all() as { proposed_name: string }[]
  for (const { proposed_name } of names) {
    const rows = db.prepare("SELECT * FROM tracks WHERE lower(proposed_name) = lower(?) AND missing = 0").all(proposed_name) as Row[]
    const tracks = rows.map((r) => toSummary(rowToTrack(r)))
    // skip groups that are already covered by an identical-hash group
    if (new Set(tracks.map((t) => t.hash)).size > 1) out.push({ key: proposed_name, kind: "name", tracks })
  }
  return out
}
