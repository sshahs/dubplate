import { createRequire } from "node:module"
import path from "node:path"
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite"
import { ensureDataDir } from "../config"

// Loaded lazily (not via a static import) so server/quiet.ts can mute
// node:sqlite's ExperimentalWarning before the module initialises.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")
type DatabaseSync = DatabaseSyncType

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE libraries (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_scan_at TEXT,
    file_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    original_path TEXT NOT NULL,
    rel_dir TEXT NOT NULL,
    filename TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    hash TEXT,
    duration REAL,
    bitrate INTEGER,
    sample_rate INTEGER,
    codec TEXT,
    tags_json TEXT NOT NULL DEFAULT '{}',
    heuristic_json TEXT,
    ai_json TEXT,
    candidates_json TEXT,
    decision_json TEXT,
    final_json TEXT,
    confidence INTEGER,
    status TEXT NOT NULL DEFAULT 'new',
    proposed_name TEXT,
    note TEXT,
    missing INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_tracks_status ON tracks(status);
  CREATE INDEX idx_tracks_library ON tracks(library_id);
  CREATE INDEX idx_tracks_hash ON tracks(hash);
  CREATE INDEX idx_tracks_confidence ON tracks(confidence);

  CREATE TABLE operations (
    id INTEGER PRIMARY KEY,
    batch_id TEXT NOT NULL,
    track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    tags_before_json TEXT,
    tags_after_json TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reverted_at TEXT
  );
  CREATE INDEX idx_operations_batch ON operations(batch_id);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    label TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE http_cache (
    key TEXT PRIMARY KEY,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE corrections (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    artists_json TEXT NOT NULL,
    title TEXT NOT NULL,
    version TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE aliases (
    id INTEGER PRIMARY KEY,
    alias TEXT NOT NULL UNIQUE,
    canonical TEXT NOT NULL
  );
  `,
  // 2: BPM & key, artwork, watched libraries - and big libraries: the bulky per-track JSON
  // (parser readings, source hits, decision) moves to its own table so track rows stay
  // small and lists, counts and stats never have to wade through it.
  `
  ALTER TABLE tracks ADD COLUMN bpm REAL;
  ALTER TABLE tracks ADD COLUMN musical_key TEXT;
  ALTER TABLE tracks ADD COLUMN analysis_json TEXT;
  ALTER TABLE tracks ADD COLUMN art_json TEXT;
  ALTER TABLE tracks ADD COLUMN art_found_json TEXT;
  -- The winning cluster's sources, space-separated, so stats don't parse every decision.
  ALTER TABLE tracks ADD COLUMN top_sources TEXT;
  -- Which scanner version last read the file's tags: files read before covers, BPM and key
  -- were collected get re-read once, even if they haven't changed on disk.
  ALTER TABLE tracks ADD COLUMN tags_version INTEGER NOT NULL DEFAULT 0;
  UPDATE tracks SET top_sources = (SELECT group_concat(value, ' ') FROM json_each(tracks.decision_json, '$.clusters[0].sources'))
    WHERE decision_json IS NOT NULL AND json_valid(decision_json);
  UPDATE tracks SET bpm = json_extract(tags_json, '$.bpm'), musical_key = json_extract(tags_json, '$.key')
    WHERE json_valid(tags_json);

  CREATE TABLE track_data (
    track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    heuristic_json TEXT,
    ai_json TEXT,
    candidates_json TEXT,
    decision_json TEXT
  );
  INSERT INTO track_data (track_id, heuristic_json, ai_json, candidates_json, decision_json)
    SELECT id, heuristic_json, ai_json, candidates_json, decision_json FROM tracks;
  ALTER TABLE tracks DROP COLUMN heuristic_json;
  ALTER TABLE tracks DROP COLUMN ai_json;
  ALTER TABLE tracks DROP COLUMN candidates_json;
  ALTER TABLE tracks DROP COLUMN decision_json;

  -- Lists always filter on missing = 0, so each sortable column is indexed behind it:
  -- a page is then read straight off the index in order instead of sorting every track.
  DROP INDEX idx_tracks_status;
  DROP INDEX idx_tracks_confidence;
  DROP INDEX idx_tracks_hash;
  CREATE INDEX idx_tracks_missing_filename ON tracks(missing, filename COLLATE NOCASE);
  CREATE INDEX idx_tracks_missing_status ON tracks(missing, status);
  CREATE INDEX idx_tracks_missing_confidence ON tracks(missing, confidence);
  CREATE INDEX idx_tracks_missing_updated ON tracks(missing, updated_at);
  CREATE INDEX idx_tracks_missing_bpm ON tracks(missing, bpm);
  CREATE INDEX idx_tracks_hash ON tracks(hash, missing);
  CREATE INDEX idx_tracks_proposed ON tracks(lower(proposed_name));

  ALTER TABLE libraries ADD COLUMN watch INTEGER NOT NULL DEFAULT 0;
  `,
  // 3: per-library settings, folder moves in the journal (with the status and folders a rewind
  // needs), and duplicates set aside in a holding folder.
  `
  ALTER TABLE libraries ADD COLUMN settings_json TEXT;
  ALTER TABLE operations ADD COLUMN status_before TEXT;
  ALTER TABLE operations ADD COLUMN created_dirs_json TEXT;
  ALTER TABLE operations ADD COLUMN batch_label TEXT;
  ALTER TABLE tracks ADD COLUMN aside_json TEXT;
  `,
  // 4: smart crates, what the AI costs, and the releases in your Discogs collection.
  `
  CREATE TABLE crates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    rules_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE ai_usage (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    job_id TEXT
  );
  CREATE INDEX idx_ai_usage_at ON ai_usage(at);
  CREATE INDEX idx_ai_usage_job ON ai_usage(job_id);

  CREATE TABLE discogs_collection (
    release_id INTEGER PRIMARY KEY,
    artist TEXT NOT NULL,
    -- every credited artist, normalised, as "|name|other name|" for lookups
    artists_key TEXT NOT NULL,
    title TEXT NOT NULL,
    title_key TEXT NOT NULL,
    year INTEGER,
    label TEXT,
    catno TEXT,
    format TEXT,
    added_at TEXT
  );
  `,
  // 5: lyrics (bulky, so with the other per-track JSON), what reading a file found out about
  // it, and keys for scripts and download tools (only their hashes).
  `
  ALTER TABLE track_data ADD COLUMN lyrics_json TEXT;
  ALTER TABLE tracks ADD COLUMN file_check_json TEXT;

  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'hooks',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
  `,
  // 6: fingerprints and each file as first scanned (kept for good), IDs set by hand or by a
  // MusicBrainz submission, what's been sent to AcoustID and MusicBrainz, a cache of lookups by
  // normalised reading, and scraper health.
  `
  ALTER TABLE track_data ADD COLUMN fingerprint_json TEXT;
  ALTER TABLE track_data ADD COLUMN original_json TEXT;
  ALTER TABLE track_data ADD COLUMN escalation_json TEXT;
  ALTER TABLE tracks ADD COLUMN ids_json TEXT;
  -- Who approved it: "person", "auto" (auto-approve) or "hands-off". Approvals from before this was
  -- recorded stay unknown (NULL): they may have been automatic, so they never count as a person's.
  ALTER TABLE tracks ADD COLUMN approved_by TEXT;
  -- Files never cut still have their first-scan name and tags: keep those as the original.
  INSERT INTO track_data (track_id) SELECT id FROM tracks WHERE id NOT IN (SELECT track_id FROM track_data);
  UPDATE track_data SET original_json = (
    SELECT json_object('filename', t.filename, 'path', t.path, 'tags', json(t.tags_json), 'scannedAt', t.created_at)
    FROM tracks t WHERE t.id = track_data.track_id AND t.status <> 'done' AND t.path = t.original_path AND json_valid(t.tags_json)
  );

  CREATE TABLE acoustid_submissions (
    id INTEGER PRIMARY KEY,
    track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
    -- sha256 of the fingerprint: the same fingerprint is never sent twice
    fingerprint_hash TEXT NOT NULL UNIQUE,
    submission_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    acoustid TEXT,
    mb_recording_id TEXT,
    error TEXT,
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    checked_at TEXT
  );
  CREATE INDEX idx_acoustid_track ON acoustid_submissions(track_id);

  CREATE TABLE mb_submissions (
    id INTEGER PRIMARY KEY,
    track_ids_json TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    release_mbid TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE lookup_cache (
    key TEXT PRIMARY KEY,
    candidates_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE source_health (
    source_id TEXT PRIMARY KEY,
    bad_in_a_row INTEGER NOT NULL DEFAULT 0,
    last_bad TEXT,
    last_ok_at TEXT,
    disabled_at TEXT
  );
  `,
  // 7: videos the scanner found (AVI, 3GP, WMV…), whose audio the converter pulls out, and the
  // content hash of a file Dubplate made, so a rewind only takes it away if it's unchanged.
  `
  CREATE TABLE videos (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    rel_dir TEXT NOT NULL,
    filename TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    probe_json TEXT,
    status TEXT NOT NULL DEFAULT 'found',
    output_path TEXT,
    error TEXT,
    converted_at TEXT,
    aside_from TEXT,
    missing INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_videos_library ON videos(library_id);
  ALTER TABLE operations ADD COLUMN hash_after TEXT;
  `,
  // 8: the console's log, kept for a while (Settings → logs.keepDays) instead of only in memory.
  `
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    level TEXT NOT NULL,
    area TEXT NOT NULL,
    message TEXT NOT NULL,
    job_id TEXT,
    track_id INTEGER,
    detail TEXT
  );
  CREATE INDEX idx_logs_job ON logs(job_id);
  CREATE INDEX idx_logs_track ON logs(track_id);
  CREATE INDEX idx_logs_at ON logs(at);
  `,
]

export type Db = DatabaseSync

let instance: DatabaseSync | null = null

export function openDb(file?: string): DatabaseSync {
  const db = new DatabaseSync(file ?? path.join(ensureDataDir(), "dubplate.db"))
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
  migrate(db)
  return db
}

function migrate(db: DatabaseSync) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number }
  let version = row.user_version
  const from = version
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN")
    try {
      db.exec(MIGRATIONS[version])
      version++
      db.exec(`PRAGMA user_version = ${version}`)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
  }
  // Migration 2 moves the bulky JSON out of the tracks table; hand the freed space back once.
  if (from >= 1 && from < 2 && version >= 2) db.exec("VACUUM")
}

export function getDb(): DatabaseSync {
  if (!instance) instance = openDb()
  return instance
}

/** Swap the singleton (tests use an in-memory database). */
export function setDb(db: DatabaseSync) {
  instance = db
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN")
  try {
    const out = fn()
    db.exec("COMMIT")
    return out
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

export type Params = Record<string, SQLInputValue>

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
