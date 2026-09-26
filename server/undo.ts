// Short-lived undo for review decisions and bulk edits: before a change, the
// affected tracks' editable columns (and any correction it would teach) are
// snapshotted in memory; restoring puts them back exactly.

import { randomUUID } from "node:crypto"
import type { SQLInputValue } from "node:sqlite"
import { getDb, tx } from "./db"

/** Columns a review action or bulk edit can change: on the track row… */
const COLUMNS = ["status", "final_json", "proposed_name", "note", "bpm", "musical_key", "art_found_json", "top_sources", "confidence"] as const
/** …and in track_data (a reset clears these). */
const DATA_COLUMNS = ["ai_json", "candidates_json", "decision_json"] as const

type Row = Record<(typeof COLUMNS)[number] | (typeof DATA_COLUMNS)[number] | "id", SQLInputValue>

interface Snapshot {
  label: string
  at: number
  rows: Row[]
  /** filename → the correction row that existed before (null: there was none) */
  corrections: { filename: string; row: Record<string, SQLInputValue> | null }[]
}

const MAX_SNAPSHOTS = 30
const MAX_TRACKS = 5000
const MAX_BYTES = 64 * 1024 * 1024
const TTL_MS = 60 * 60 * 1000
const snapshots = new Map<string, Snapshot>()

function prune() {
  const now = Date.now()
  for (const [id, s] of snapshots) if (now - s.at > TTL_MS) snapshots.delete(id)
  while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!)
}

/**
 * Remember how `trackIds` look now. `learnFrom` lists filenames whose
 * corrections the action may overwrite. Returns null for very large selections.
 */
export function snapshot(label: string, trackIds: number[], learnFrom: string[] = []): string | null {
  if (!trackIds.length || trackIds.length > MAX_TRACKS) return null
  const db = getDb()
  const get = db.prepare(
    `SELECT t.id, ${COLUMNS.map((c) => `t.${c}`).join(", ")}, ${DATA_COLUMNS.map((c) => `d.${c}`).join(", ")}
     FROM tracks t LEFT JOIN track_data d ON d.track_id = t.id WHERE t.id = ?`
  )
  const rows: Row[] = []
  let bytes = 0
  for (const id of trackIds) {
    const r = get.get(id) as Row | undefined
    if (!r) continue
    for (const v of Object.values(r)) if (typeof v === "string") bytes += v.length
    // A reset of thousands of scoured tracks would pin a lot of memory: no undo for that.
    if (bytes > MAX_BYTES) return null
    rows.push(r)
  }
  const getCorrection = db.prepare("SELECT * FROM corrections WHERE filename = ?")
  const corrections = learnFrom.map((filename) => ({ filename, row: (getCorrection.get(filename) as Record<string, SQLInputValue> | undefined) ?? null }))
  const id = randomUUID()
  snapshots.set(id, { label, at: Date.now(), rows, corrections })
  prune()
  return id
}

/** Put the tracks back as they were. Returns the restored ids, or null if the snapshot has gone. */
export function restore(id: string): { ids: number[]; label: string } | null {
  const s = snapshots.get(id)
  if (!s) return null
  snapshots.delete(id)
  const db = getDb()
  const update = db.prepare(`UPDATE tracks SET ${COLUMNS.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`)
  const updateData = db.prepare(
    `INSERT INTO track_data (track_id, ${DATA_COLUMNS.join(", ")}) VALUES (?, ${DATA_COLUMNS.map(() => "?").join(", ")})
     ON CONFLICT(track_id) DO UPDATE SET ${DATA_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ")}`
  )
  tx(db, () => {
    for (const r of s.rows) {
      update.run(...COLUMNS.map((c) => r[c] ?? null), r.id)
      updateData.run(r.id, ...DATA_COLUMNS.map((c) => r[c] ?? null))
    }
    for (const { filename, row } of s.corrections) {
      db.prepare("DELETE FROM corrections WHERE filename = ?").run(filename)
      if (row) {
        const cols = Object.keys(row)
        db.prepare(`INSERT INTO corrections (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]))
      }
    }
  })
  return { ids: s.rows.map((r) => r.id as number), label: s.label }
}

export function resetUndoForTests() {
  snapshots.clear()
}
