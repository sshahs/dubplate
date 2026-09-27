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
