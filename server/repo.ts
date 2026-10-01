// Data access for the staging database.

import fs from "node:fs"
import path from "node:path"
import type { SQLInputValue } from "node:sqlite"
import type {
  Alias,
  ArtRef,
  CrateRules,
  Correction,
  ExistingTags,
  FileCheck,
  Library,
  LibrarySettings,
  LyricsFound,
  Operation,
  OperationBatch,
  SetAside,
  Stats,
  Track,
  TrackStatus,
  TrackSummary,
} from "../shared/types"
import { parseKey } from "../shared/keys"
import { lyricsSummary } from "../shared/lyrics"
import { SILENCE_END_S, SILENCE_START_S } from "../shared/problems"
import { TRACK_STATUSES } from "../shared/types"
import { normArtist } from "./core/normalize"
import { crateConditions, crateRules } from "./crates"
import { getDb, parseJson } from "./db"
import { cleanLibrarySettings, forgetLibrarySettings } from "./library-settings"
import { watchState } from "./watch-state"

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
    watch: !!r.watch,
    watchState: r.watch ? watchState(r.id as number) : "off",
    settings: cleanLibrarySettings(parseJson(r.settings_json, {})),
  }
}

export function listLibraries(): Library[] {
  return (getDb().prepare("SELECT * FROM libraries ORDER BY name").all() as Row[]).map(rowToLibrary)
}

export function getLibrary(id: number): Library | null {
  const r = getDb().prepare("SELECT * FROM libraries WHERE id = ?").get(id) as Row | undefined
  return r ? rowToLibrary(r) : null
}

export function addLibrary(p: string, name: string, extra: { watch?: boolean; settings?: LibrarySettings } = {}): Library {
  const r = getDb()
    .prepare("INSERT INTO libraries (path, name, watch, settings_json) VALUES (?, ?, ?, ?) RETURNING *")
    .get(p, name, extra.watch ? 1 : 0, extra.settings && Object.keys(extra.settings).length ? JSON.stringify(cleanLibrarySettings(extra.settings)) : null) as Row
  forgetLibrarySettings()
  return rowToLibrary(r)
}

export function updateLibrary(id: number, patch: { name?: string; watch?: boolean; settings?: LibrarySettings }) {
  if (patch.name !== undefined) getDb().prepare("UPDATE libraries SET name = ? WHERE id = ?").run(patch.name, id)
  if (patch.watch !== undefined) getDb().prepare("UPDATE libraries SET watch = ? WHERE id = ?").run(patch.watch ? 1 : 0, id)
  if (patch.settings !== undefined) {
    const clean = cleanLibrarySettings(patch.settings)
    getDb().prepare("UPDATE libraries SET settings_json = ? WHERE id = ?").run(Object.keys(clean).length ? JSON.stringify(clean) : null, id)
    forgetLibrarySettings()
  }
}

/** The library a file lives in (the deepest one containing it). */
export function libraryForPath(file: string): Library | null {
  const libs = listLibraries().filter((l) => file === l.path || file.startsWith(l.path.endsWith(path.sep) ? l.path : l.path + path.sep))
  return libs.sort((a, b) => b.path.length - a.path.length)[0] ?? null
}

export function removeLibrary(id: number) {
  getDb().prepare("DELETE FROM libraries WHERE id = ?").run(id)
  forgetLibrarySettings()
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
    bpm: (r.bpm as number) ?? null,
    key: parseKey(r.musical_key as string | null),
    analysis: parseJson(r.analysis_json, null),
    art: parseJson<ArtRef | null>(r.art_json, null),
    artFound: parseJson<ArtRef | null>(r.art_found_json, null),
    aside: parseJson<SetAside | null>(r.aside_json, null),
    fileCheck: parseJson<FileCheck | null>(r.file_check_json, null),
    lyrics: parseJson<LyricsFound | null>(r.lyrics_json, null),
    fingerprint: parseJson<Track["fingerprint"]>(r.fingerprint_json, null),
    original: parseJson<Track["original"]>(r.original_json, null),
    idsOverride: parseJson<Track["idsOverride"]>(r.ids_json, null),
    approvedBy: (r.approved_by as Track["approvedBy"]) ?? null,
    escalation: parseJson<Track["escalation"]>(r.escalation_json, null),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

export function toSummary(t: Track): TrackSummary {
  const { candidates: _c, decision, heuristic, ai, lyrics: _l, fingerprint: _f, original: _o, escalation: _e, ...rest } = t
  const reading = t.final ?? decision ?? ai ?? heuristic
  return {
    ...rest,
    proposedArtist: reading ? (reading.artists ?? []).join(", ") || null : null,
    proposedTitle: reading?.title ?? null,
    sourceCount: decision?.clusters[0]?.sources.length ?? 0,
    conflict: decision?.status === "conflict",
  }
}

/** A full track: its row plus the bulky readings/hits/decision kept in track_data. */
const FULL_TRACK =
  "SELECT t.*, d.heuristic_json, d.ai_json, d.candidates_json, d.decision_json, d.lyrics_json, d.fingerprint_json, d.original_json, d.escalation_json FROM tracks t LEFT JOIN track_data d ON d.track_id = t.id"

export function getTrack(id: number): Track | null {
  const r = getDb().prepare(`${FULL_TRACK} WHERE t.id = ?`).get(id) as Row | undefined
  return r ? rowToTrack(r) : null
}

/** Another copy of exactly the same audio (same content hash) that's already been identified. */
export function identifiedTwin(t: Pick<Track, "id" | "hash">): Track | null {
  if (!t.hash) return null
  const r = getDb()
    .prepare(`${FULL_TRACK} WHERE t.hash = ? AND t.id <> ? AND d.candidates_json IS NOT NULL AND t.aside_json IS NULL ORDER BY t.missing, t.id LIMIT 1`)
    .get(t.hash, t.id) as Row | undefined
  return r ? rowToTrack(r) : null
}

export function getTracks(ids: number[]): Track[] {
  if (!ids.length) return []
  const out: Track[] = []
  const stmt = getDb().prepare(`${FULL_TRACK} WHERE t.id = ?`)
  for (const id of ids) {
    const r = stmt.get(id) as Row | undefined
    if (r) out.push(rowToTrack(r))
  }
  return out
}

export type TrackSort = "filename" | "confidence" | "status" | "updated" | "path" | "bpm" | "key"

export interface TrackQuery {
  status?: TrackStatus[]
  libraryId?: number
  q?: string
  minConfidence?: number
  maxConfidence?: number
  includeMissing?: boolean
  /** only tracks in this smart crate */
  crateId?: number
  /** or matching these crate rules (a crate being edited) */
  rules?: CrateRules
  /** "suspect": files that sound made from something worse than they claim */
  quality?: "suspect" | "ok"
  /** only files with something wrong with the file itself (see shared/problems.ts) */
  problems?: boolean
  sort?: TrackSort
  dir?: "asc" | "desc"
  limit?: number
  offset?: number
}

/** Tracks with a file problem, the same ones fileProblems() lists. */
export const PROBLEMS_SQL = `(json_extract(file_check_json, '$.realExt') IS NOT NULL OR json_extract(file_check_json, '$.unreadable') IS NOT NULL
  OR json_extract(file_check_json, '$.empty') = 1 OR json_extract(analysis_json, '$.integrity.truncated') = 1
  OR json_extract(analysis_json, '$.integrity.damagedAt') IS NOT NULL
  OR json_extract(analysis_json, '$.integrity.silenceStart') >= ${SILENCE_START_S} OR json_extract(analysis_json, '$.integrity.silenceEnd') >= ${SILENCE_END_S})`

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
  if (q.problems) where.push(PROBLEMS_SQL)
  const rules = { ...(q.crateId ? (crateRules(q.crateId) ?? { libraryId: -1 }) : {}), ...q.rules, ...(q.quality ? { quality: q.quality } : {}) }
  if (Object.keys(rules).length) {
    const c = crateConditions(rules)
    where.push(...c.where)
    params.push(...c.params)
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params }
}

/**
 * What a list row needs: the track row plus a few fields picked out of the
 * bulky JSON by SQLite, so a page never parses whole decisions in JS.
 */
const SUMMARY = `SELECT t.*,
  d.decision_json IS NOT NULL AS has_decision,
  json_extract(d.decision_json, '$.artists') AS d_artists, json_extract(d.decision_json, '$.title') AS d_title,
  json_extract(d.decision_json, '$.status') AS d_status, json_array_length(d.decision_json, '$.clusters[0].sources') AS d_sources,
  json_extract(d.ai_json, '$.artists') AS ai_artists, json_extract(d.ai_json, '$.title') AS ai_title,
  json_extract(d.heuristic_json, '$.artists') AS h_artists, json_extract(d.heuristic_json, '$.title') AS h_title
  FROM tracks t LEFT JOIN track_data d ON d.track_id = t.id`

function rowToSummary(r: Row): TrackSummary {
  const t = rowToTrack(r)
  const { candidates: _c, decision: _d, heuristic: _h, ai: _a, lyrics: _l, fingerprint: _f, original: _o, escalation: _e, ...rest } = t
  // Same precedence as toSummary: approved → decision → AI → rule-based parser.
  const reading = t.final
    ? { artists: t.final.artists, title: t.final.title }
    : r.has_decision
      ? { artists: parseJson<string[]>(r.d_artists, []), title: r.d_title as string | undefined }
      : r.ai_title !== null || r.ai_artists !== null
        ? { artists: parseJson<string[]>(r.ai_artists, []), title: r.ai_title as string | undefined }
        : r.h_title !== null || r.h_artists !== null
          ? { artists: parseJson<string[]>(r.h_artists, []), title: r.h_title as string | undefined }
          : null
  return {
    ...rest,
    proposedArtist: reading ? reading.artists.join(", ") || null : null,
    proposedTitle: reading?.title ?? null,
    sourceCount: (r.d_sources as number) ?? 0,
    conflict: r.d_status === "conflict",
  }
}

export function summariesById(ids: number[]): TrackSummary[] {
  if (!ids.length) return []
  const rows = getDb().prepare(`${SUMMARY} WHERE t.id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[]
  const byId = new Map(rows.map((r) => [r.id as number, r]))
  return ids.flatMap((id) => (byId.has(id) ? [rowToSummary(byId.get(id)!)] : []))
}

const SORT_COLUMNS: Record<TrackSort, string> = {
  filename: "filename COLLATE NOCASE",
  confidence: "confidence",
  status: "status",
  updated: "updated_at",
  path: "path",
  bpm: "bpm",
  key: "musical_key",
}

export function queryTracks(q: TrackQuery): { items: TrackSummary[]; total: number } {
  const db = getDb()
  const { sql, params } = whereFor(q)
  const sortCol = SORT_COLUMNS[q.sort ?? "filename"] ?? SORT_COLUMNS.filename
  const dir = q.dir === "desc" ? "DESC" : "ASC"
  const limit = Math.min(q.limit ?? 100, 1000)
  const offset = q.offset ?? 0
  // Page the ids first (small rows, indexes), then fetch just that page in full.
  // Only nullable columns need NULLS LAST; leaving it off the rest lets SQLite walk the index in order.
  const nulls = q.sort === "confidence" || q.sort === "bpm" || q.sort === "key" ? " NULLS LAST" : ""
  const ids = (db.prepare(`SELECT id FROM tracks ${sql} ORDER BY ${sortCol} ${dir}${nulls}, id ${dir} LIMIT ? OFFSET ?`).all(...params, limit, offset) as { id: number }[]).map((r) => r.id)
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM tracks ${sql}`).get(...params) as { n: number }).n
  return { items: summariesById(ids), total }
}

export function queryTrackIds(q: TrackQuery): number[] {
  const { sql, params } = whereFor(q)
  return (getDb().prepare(`SELECT id FROM tracks ${sql} ORDER BY id`).all(...params) as { id: number }[]).map((r) => r.id)
}

const JSON_COLS = new Set(["tags", "heuristic", "ai", "candidates", "decision", "final", "analysis", "art", "artFound", "aside", "fileCheck", "lyrics", "fingerprint", "original", "idsOverride", "escalation"])
/** Kept in track_data rather than on the track row. */
const DATA_COLS: Record<string, string> = {
  heuristic: "heuristic_json",
  ai: "ai_json",
  candidates: "candidates_json",
  decision: "decision_json",
  lyrics: "lyrics_json",
  fingerprint: "fingerprint_json",
  original: "original_json",
  escalation: "escalation_json",
}
const COLS: Record<string, string> = {
  libraryId: "library_id",
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
  final: "final_json",
  confidence: "confidence",
  status: "status",
  proposedName: "proposed_name",
  note: "note",
  missing: "missing",
  bpm: "bpm",
  key: "musical_key",
  analysis: "analysis_json",
  art: "art_json",
  artFound: "art_found_json",
  aside: "aside_json",
  fileCheck: "file_check_json",
  idsOverride: "ids_json",
  approvedBy: "approved_by",
}

export function updateTrack(id: number, patch: Partial<Track>) {
  const sets: string[] = []
  const params: SQLInputValue[] = []
  const dataCols: string[] = []
  const dataParams: SQLInputValue[] = []
  for (const [k, raw] of Object.entries(patch)) {
    // Lyrics stay in the file; the row only says there are some.
    const v = k === "tags" && raw && (raw as ExistingTags).lyrics ? { ...(raw as ExistingTags), lyrics: lyricsSummary((raw as ExistingTags).lyrics) } : raw
    const value = JSON_COLS.has(k) ? (v === null || v === undefined ? null : JSON.stringify(v)) : typeof v === "boolean" ? (v ? 1 : 0) : ((v ?? null) as SQLInputValue)
    if (DATA_COLS[k]) {
      dataCols.push(DATA_COLS[k])
      dataParams.push(value)
      continue
    }
    const col = COLS[k]
    if (!col) continue
    sets.push(`${col} = ?`)
    params.push(value)
  }
  if (dataCols.length) {
    getDb()
      .prepare(
        `INSERT INTO track_data (track_id, ${dataCols.join(", ")}) VALUES (?, ${dataCols.map(() => "?").join(", ")})
         ON CONFLICT(track_id) DO UPDATE SET ${dataCols.map((c) => `${c} = excluded.${c}`).join(", ")}`
      )
      .run(id, ...dataParams)
  }
  if (!sets.length && !dataCols.length) return
  if ("decision" in patch) {
    sets.push("top_sources = ?")
    params.push(patch.decision?.clusters[0]?.sources.join(" ") || null)
  }
  sets.push("updated_at = datetime('now')")
  getDb().prepare(`UPDATE tracks SET ${sets.join(", ")} WHERE id = ?`).run(...params, id)
}

/** How many of these tracks are in each status. */
export function statusCounts(ids: number[]): Record<TrackStatus, number> {
  const out = Object.fromEntries(TRACK_STATUSES.map((s) => [s, 0])) as Record<TrackStatus, number>
  const stmt = getDb().prepare("SELECT status FROM tracks WHERE id = ?")
  for (const id of ids) {
    const r = stmt.get(id) as { status: TrackStatus } | undefined
    if (r) out[r.status]++
  }
  return out
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
    statusBefore: (r.status_before as TrackStatus) ?? null,
    createdDirs: parseJson<string[]>(r.created_dirs_json, []),
    batchLabel: (r.batch_label as string) ?? null,
    hashAfter: (r.hash_after as string) ?? null,
  }
}

export type NewOperation = Omit<Operation, "id" | "createdAt" | "revertedAt" | "statusBefore" | "createdDirs" | "batchLabel" | "hashAfter"> &
  Partial<Pick<Operation, "statusBefore" | "createdDirs" | "batchLabel" | "hashAfter">>

export function insertOperation(op: NewOperation): number {
  const r = getDb()
    .prepare(
      `INSERT INTO operations (batch_id, track_id, kind, from_path, to_path, tags_before_json, tags_after_json, status, error, status_before, created_dirs_json, batch_label, hash_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
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
      op.error,
      op.statusBefore ?? null,
      op.createdDirs?.length ? JSON.stringify(op.createdDirs) : null,
      op.batchLabel ?? null,
      op.hashAfter ?? null
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
        `SELECT batch_id, MIN(created_at) AS created_at, COUNT(*) AS count, MAX(batch_label) AS label,
          SUM(status = 'done') AS done, SUM(status = 'failed') AS failed,
          SUM(status = 'reverted') AS reverted, SUM(status = 'dry-run') AS dry
         FROM operations GROUP BY batch_id ORDER BY MIN(id) DESC LIMIT ?`
      )
      .all(limit) as Row[]
  ).map((r) => ({
    batchId: r.batch_id as string,
    label: (r.label as string) || "Cut",
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
  for (const r of db.prepare("SELECT top_sources, COUNT(*) AS n FROM tracks WHERE top_sources IS NOT NULL AND missing = 0 GROUP BY top_sources").all() as { top_sources: string; n: number }[]) {
    for (const s of r.top_sources.split(" ")) sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + r.n)
  }
  return {
    total,
    byStatus,
    confidenceBuckets,
    libraries,
    operations,
    duplicates,
    videos: (db.prepare("SELECT COUNT(*) AS n FROM videos WHERE missing = 0 AND status = 'found'").get() as { n: number }).n,
    sources: [...sourceCounts.entries()].map(([source, hits]) => ({ source, hits })).sort((a, b) => b.hits - a.hits),
  }
}

/** List rows matching a WHERE clause over tracks `t` (for reports like duplicates). */
export function summariesWhere(where: string, params: SQLInputValue[]): TrackSummary[] {
  return (getDb().prepare(`${SUMMARY} WHERE ${where}`).all(...params) as Row[]).map(rowToSummary)
}
