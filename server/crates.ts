// Smart crates: saved filters over the library (genre, tempo, key, era, label…)
// that fill themselves as tracks come in. Each rule narrows the crate; a list in
// a rule matches any of its values.

import type { SQLInputValue } from "node:sqlite"
import { mixingKeys, parseKey } from "../shared/keys"
import type { Crate, CrateFacets, CrateRules, KeyRelation, MixSuggestion, TrackStatus } from "../shared/types"
import { TRACK_STATUSES } from "../shared/types"
import { getDb, parseJson } from "./db"

type Row = Record<string, unknown>

const list = (v: unknown, max = 30) =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, max)
    : undefined
const num = (v: unknown, lo: number, hi: number) => {
  const n = Number(v)
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : Math.min(hi, Math.max(lo, n))
}

/** Only known rules, each checked; empty ones are dropped. */
export function cleanRules(input: unknown): CrateRules {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const out: CrateRules = {}
  const genres = list(i.genres)
  if (genres?.length) out.genres = genres
  out.bpmMin = num(i.bpmMin, 30, 300)
  out.bpmMax = num(i.bpmMax, 30, 300)
  if (out.bpmMin !== undefined && out.bpmMax !== undefined && out.bpmMin > out.bpmMax) [out.bpmMin, out.bpmMax] = [out.bpmMax, out.bpmMin]
  if (i.halfDouble === true && (out.bpmMin !== undefined || out.bpmMax !== undefined)) out.halfDouble = true
  const keys = list(i.keys, 24)
    ?.map((k) => parseKey(k))
    .filter((k): k is string => !!k)
  if (keys?.length) out.keys = [...new Set(keys)]
  const mixes = parseKey(typeof i.mixesWith === "string" ? i.mixesWith : null)
  if (mixes) out.mixesWith = mixes
  out.yearFrom = num(i.yearFrom, 1900, 2100)
  out.yearTo = num(i.yearTo, 1900, 2100)
  if (out.yearFrom !== undefined && out.yearTo !== undefined && out.yearFrom > out.yearTo) [out.yearFrom, out.yearTo] = [out.yearTo, out.yearFrom]
  const labels = list(i.labels)
  if (labels?.length) out.labels = labels
  const artists = list(i.artists)
  if (artists?.length) out.artists = artists
  const lib = num(i.libraryId, 1, Number.MAX_SAFE_INTEGER)
  if (lib) out.libraryId = Math.round(lib)
  const statuses = Array.isArray(i.statuses) ? i.statuses.filter((s): s is TrackStatus => TRACK_STATUSES.includes(s as TrackStatus)) : []
  if (statuses.length) out.statuses = [...new Set(statuses)]
  if (typeof i.text === "string" && i.text.trim()) out.text = i.text.trim().slice(0, 100)
  if (i.quality === "ok" || i.quality === "suspect") out.quality = i.quality
  for (const k of Object.keys(out) as (keyof CrateRules)[]) if (out[k] === undefined) delete out[k]
  return out
}

// The expressions a crate filters on, over the tracks table. Tags in the file come
// first (as tagging leaves them), then the approved metadata.
const GENRE_TEXT = `lower('|' || coalesce(json_extract(final_json, '$.genre'), '') || '|' || coalesce((SELECT group_concat(value, '|') FROM json_each(tags_json, '$.genre')), '') || '|')`
const YEAR = `coalesce(json_extract(tags_json, '$.year'), json_extract(final_json, '$.year'))`
const LABEL = `lower(coalesce(json_extract(tags_json, '$.label'), json_extract(final_json, '$.label'), ''))`
const ARTIST_TEXT = `lower(coalesce((SELECT group_concat(value, '|') FROM json_each(final_json, '$.artists')), '') || '|' || coalesce(json_extract(tags_json, '$.artist'), ''))`

const like = (s: string) => `%${s.toLowerCase().replace(/[%_\\]/g, (m) => "\\" + m)}%`

/** SQL conditions (ANDed) for a crate's rules, on the tracks table. */
export function crateConditions(rules: CrateRules): { where: string[]; params: SQLInputValue[] } {
  const where: string[] = []
  const params: SQLInputValue[] = []
  const anyLike = (expr: string, values: string[]) => {
    where.push(`(${values.map(() => `${expr} LIKE ? ESCAPE '\\'`).join(" OR ")})`)
    params.push(...values.map(like))
  }
  if (rules.genres?.length) anyLike(GENRE_TEXT, rules.genres)
  if (rules.bpmMin !== undefined || rules.bpmMax !== undefined) {
    const lo = rules.bpmMin ?? 0
    const hi = rules.bpmMax ?? 1000
    if (rules.halfDouble) {
      where.push("(bpm BETWEEN ? AND ? OR bpm * 2 BETWEEN ? AND ? OR bpm / 2 BETWEEN ? AND ?)")
      params.push(lo, hi, lo, hi, lo, hi)
    } else {
      where.push("bpm BETWEEN ? AND ?")
      params.push(lo, hi)
    }
  }
  const keys = new Set(rules.keys ?? [])
  if (rules.mixesWith) for (const m of mixingKeys(rules.mixesWith)) keys.add(m.key)
  if (keys.size) {
    where.push(`musical_key IN (${[...keys].map(() => "?").join(",")})`)
    params.push(...keys)
  }
  if (rules.yearFrom !== undefined) {
    where.push(`${YEAR} >= ?`)
    params.push(rules.yearFrom)
  }
  if (rules.yearTo !== undefined) {
    where.push(`${YEAR} <= ?`)
    params.push(rules.yearTo)
  }
  if (rules.labels?.length) anyLike(LABEL, rules.labels)
  if (rules.artists?.length) anyLike(ARTIST_TEXT, rules.artists)
  if (rules.libraryId) {
    where.push("library_id = ?")
    params.push(rules.libraryId)
  }
  if (rules.statuses?.length) {
    where.push(`status IN (${rules.statuses.map(() => "?").join(",")})`)
    params.push(...rules.statuses)
  }
  if (rules.text) {
    where.push("(filename LIKE ? ESCAPE '\\' OR rel_dir LIKE ? ESCAPE '\\' OR proposed_name LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\')")
    const l = like(rules.text)
    params.push(l, l, l, l)
  }
  if (rules.quality) {
    where.push(rules.quality === "suspect" ? "json_extract(analysis_json, '$.quality.verdict') = 'suspect'" : "coalesce(json_extract(analysis_json, '$.quality.verdict'), '') <> 'suspect'")
  }
  return { where, params }
}

function countFor(rules: CrateRules): number {
  const { where, params } = crateConditions(rules)
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM tracks WHERE missing = 0${where.map((w) => ` AND ${w}`).join("")}`).get(...params) as { n: number }).n
}

function rowToCrate(r: Row): Crate {
  const rules = cleanRules(parseJson(r.rules_json, {}))
  return { id: r.id as number, name: r.name as string, rules, count: countFor(rules), createdAt: r.created_at as string, updatedAt: r.updated_at as string }
}

export function listCrates(): Crate[] {
  return (getDb().prepare("SELECT * FROM crates ORDER BY name COLLATE NOCASE").all() as Row[]).map(rowToCrate)
}

export function getCrate(id: number): Crate | null {
  const r = getDb().prepare("SELECT * FROM crates WHERE id = ?").get(id) as Row | undefined
  return r ? rowToCrate(r) : null
}

export function crateRules(id: number): CrateRules | null {
  const r = getDb().prepare("SELECT rules_json FROM crates WHERE id = ?").get(id) as { rules_json: string } | undefined
  return r ? cleanRules(parseJson(r.rules_json, {})) : null
}

function cleanName(name: unknown) {
  const n = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, 80) : ""
  if (!n) throw new Error("Give the crate a name")
  return n
}

export function createCrate(name: unknown, rules: unknown): Crate {
  const r = getDb().prepare("INSERT INTO crates (name, rules_json) VALUES (?, ?) RETURNING *").get(cleanName(name), JSON.stringify(cleanRules(rules))) as Row
  return rowToCrate(r)
}

export function updateCrate(id: number, patch: { name?: unknown; rules?: unknown }): Crate | null {
  if (patch.name !== undefined) getDb().prepare("UPDATE crates SET name = ?, updated_at = datetime('now') WHERE id = ?").run(cleanName(patch.name), id)
  if (patch.rules !== undefined) getDb().prepare("UPDATE crates SET rules_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(cleanRules(patch.rules)), id)
  return getCrate(id)
}

export function deleteCrate(id: number) {
  getDb().prepare("DELETE FROM crates WHERE id = ?").run(id)
}

/** What's in the library to pick rules from: genres, labels and keys by use, and the tempo and year ranges. */
export function crateFacets(libraryId?: number): CrateFacets {
  const db = getDb()
  const libWhere = libraryId ? " AND library_id = ?" : ""
  const params: SQLInputValue[] = libraryId ? [libraryId] : []
  const genres = new Map<string, { value: string; count: number }>()
  const labels = new Map<string, { value: string; count: number }>()
  const rows = db
    .prepare(
      `SELECT json_extract(final_json, '$.genre') AS fg, json_extract(tags_json, '$.genre') AS tg, ${LABEL} AS label,
        coalesce(json_extract(tags_json, '$.label'), json_extract(final_json, '$.label')) AS label_raw
       FROM tracks WHERE missing = 0${libWhere}`
    )
    .all(...params) as { fg: string | null; tg: string | null; label: string; label_raw: string | null }[]
  const bump = (m: Map<string, { value: string; count: number }>, raw: string) => {
    const v = raw.replace(/\s+/g, " ").trim()
    if (!v || v.length > 60) return
    const k = v.toLowerCase()
    const e = m.get(k) ?? { value: v, count: 0 }
    e.count++
    m.set(k, e)
  }
  for (const r of rows) {
    const names = new Set<string>()
    for (const g of [r.fg ?? "", ...parseJson<string[]>(r.tg, [])]) for (const part of g.split(/[,;/]/)) if (part.trim()) names.add(part.trim())
    for (const g of names) bump(genres, g)
    if (r.label_raw) bump(labels, r.label_raw)
  }
  const top = (m: Map<string, { value: string; count: number }>, n: number) => [...m.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, n)
  const keys = db.prepare(`SELECT musical_key AS value, COUNT(*) AS count FROM tracks WHERE missing = 0 AND musical_key IS NOT NULL${libWhere} GROUP BY musical_key ORDER BY count DESC`).all(...params) as {
    value: string
    count: number
  }[]
  const bpm = db.prepare(`SELECT MIN(bpm) AS min, MAX(bpm) AS max FROM tracks WHERE missing = 0 AND bpm IS NOT NULL${libWhere}`).get(...params) as { min: number | null; max: number | null }
  const years = db.prepare(`SELECT MIN(${YEAR}) AS min, MAX(${YEAR}) AS max FROM tracks WHERE missing = 0 AND ${YEAR} > 1900${libWhere}`).get(...params) as { min: number | null; max: number | null }
  return { genres: top(genres, 60), labels: top(labels, 60), keys, bpm, years }
}

// ---------- mixing ----------

const RELATION_COST: Record<KeyRelation, number> = { same: 0, up: 1, down: 1, relative: 1.5, boost: 2 }
/** How far apart two tempos can be and still mix (pitch faders go about ±6-8 %). */
const BPM_TOLERANCE = 0.06

/**
 * Tracks that mix well after this one: a compatible key on the Camelot wheel and
 * a tempo within reach (half or double time counts). Either alone works when the
 * track has only a key or only a tempo.
 */
export function mixSuggestionIds(track: { id: number; bpm: number | null; key: string | null }, limit = 30): (Omit<MixSuggestion, "track"> & { id: number })[] {
  const keys = mixingKeys(track.key)
  if (!keys.length && !track.bpm) return []
  const where = ["missing = 0", "id <> ?"]
  const params: SQLInputValue[] = [track.id]
  if (keys.length) {
    where.push(`musical_key IN (${keys.map(() => "?").join(",")})`)
    params.push(...keys.map((k) => k.key))
  }
  if (track.bpm) {
    const lo = track.bpm * (1 - BPM_TOLERANCE)
    const hi = track.bpm * (1 + BPM_TOLERANCE)
    where.push("(bpm BETWEEN ? AND ? OR bpm * 2 BETWEEN ? AND ? OR bpm / 2 BETWEEN ? AND ?)")
    params.push(lo, hi, lo, hi, lo, hi)
  }
  const rows = getDb()
    .prepare(`SELECT id, bpm, musical_key FROM tracks WHERE ${where.join(" AND ")} LIMIT 2000`)
    .all(...params) as { id: number; bpm: number | null; musical_key: string | null }[]
  const relationOf = new Map(keys.map((k) => [k.key, k.relation]))
  return rows
    .map((r) => {
      const keyRelation = relationOf.get(parseKey(r.musical_key) ?? "") ?? null
      let bpmDiff = 0
      let halfDouble = false
      if (track.bpm && r.bpm) {
        const options = [r.bpm, r.bpm * 2, r.bpm / 2].map((b) => (b - track.bpm!) / track.bpm!)
        const best = options.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a))
        halfDouble = best !== options[0]
        bpmDiff = Math.round(best * 1000) / 10
      }
      const cost = (keyRelation ? RELATION_COST[keyRelation] : 0) + Math.abs(bpmDiff) / 2 + (halfDouble ? 0.5 : 0)
      return { id: r.id, keyRelation, bpmDiff, halfDouble, cost }
    })
    .sort((a, b) => a.cost - b.cost || a.id - b.id)
    .slice(0, limit)
    .map(({ cost: _cost, ...rest }) => rest)
}
