import { createRequire } from "node:module"
import path from "node:path"
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite"
import { ensureDataDir } from "../config"

// Loaded lazily (not via a static import) so server/quiet.ts can mute
// node:sqlite's ExperimentalWarning before the module initialises.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")
type DatabaseSync = DatabaseSyncType

const MIGRATIONS: string[] = [
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
