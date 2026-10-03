// Everything Dubplate does, written down. Each line is kept in SQLite for the
// Console page (for Settings → logs.keepDays), streamed live over SSE, and
// once the server's started, printed to its output from DUBPLATE_LOG_LEVEL up,
// so `docker logs` tells the same story.

import { format } from "node:util"
import type { SQLInputValue, StatementSync } from "node:sqlite"
import type { JobKind, LogArea, LogEntry, LogLevel, LogSummary, ServerEvent } from "../shared/types"
import { LOG_LEVELS } from "../shared/types"
import { emit, runScope } from "./bus"
import { getDb, type Db } from "./db"

const AREA_OF_JOB: Record<JobKind, LogArea> = {
  convert: "files",
  scan: "scan",
  interpret: "identify",
  scour: "identify",
  score: "identify",
  process: "identify",
  execute: "files",
  rewind: "files",
  analyze: "analysis",
  artwork: "identify",
  organise: "files",
  duplicates: "files",
  sync: "sources",
  lyrics: "identify",
  upload: "files",
  acoustid: "sources",
  retag: "files",
}

export function areaOfJob(kind: JobKind): LogArea {
  return AREA_OF_JOB[kind] ?? "jobs"
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, success: 1, warn: 2, error: 3 }
/** How a level reads in a text log. */
export const LEVEL_WORD: Record<LogLevel, string> = { debug: "DETAIL", info: "INFO", success: "DONE", warn: "WARN", error: "ERROR" }
const MAX_MESSAGE = 4_000
const MAX_DETAIL = 20_000
/** However long lines are kept, the log never grows past this many. */
export const MAX_LOG_ROWS = 250_000
const DAY = 24 * 60 * 60 * 1000

export function clampDays(v: unknown): number {
  return Math.min(365, Math.max(1, Math.round(Number(v) || 14)))
}

let options = { detail: true, keepDays: 14 }

/** Settings call this whenever they're read, so a change applies straight away. */
export function configureLogs(o: { detail?: boolean; keepDays?: number } | undefined) {
  options = { detail: o?.detail !== false, keepDays: clampDays(o?.keepDays) }
}

export function logOptions() {
  return { ...options }
}

export interface LogMeta {
  area?: LogArea
  jobId?: string
  jobLabel?: string
  /** null: not about a track, even when written while working on one */
  trackId?: number | null
  /** a stack trace, a full request, what was read and decided */
  detail?: string | null
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters)` : s)

const inserts = new WeakMap<Db, StatementSync>()
let unsaved = 0

function store(e: LogEntry): number {
  try {
    const db = getDb()
    let st = inserts.get(db)
    if (!st) {
      st = db.prepare("INSERT INTO logs (at, level, area, message, job_id, track_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      inserts.set(db, st)
    }
    return Number(st.run(e.at, e.level, e.area, e.message, e.jobId ?? null, e.trackId ?? null, e.detail ?? null).lastInsertRowid)
  } catch {
    // The database is busy or gone: the line still goes out live, just not kept.
    return -++unsaved
  }
}

/** The latest lines that aren't step-by-step detail, for a browser that's just connected. */
const recent: LogEntry[] = []

export function recentLogEvents(): ServerEvent[] {
  return recent.map((e) => ({ type: "log" as const, ...e }))
}

// The server's own output, untouched by the console capture below.
const out = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) }
/** From this level up, lines are printed too; null until startLogging(), so tests stay quiet. */
let echoFrom: number | null = null

export function log(level: LogLevel, message: string, meta: LogMeta = {}, echo = true): LogEntry | null {
  if (level === "debug" && !options.detail) return null
  const scope = runScope()
  const job = meta.jobId ? { id: meta.jobId, label: meta.jobLabel } : scope.job
  const entry: LogEntry = {
    id: 0,
    at: new Date().toISOString(),
    level,
    area: meta.area ?? (scope.job ? areaOfJob(scope.job.kind) : "server"),
    message: clip(message, MAX_MESSAGE),
  }
  if (job) {
    entry.jobId = job.id
    if (job.label) entry.jobLabel = job.label
  }
  const trackId = meta.trackId === null ? undefined : (meta.trackId ?? scope.trackId)
  if (trackId) entry.trackId = trackId
  if (meta.detail) entry.detail = clip(meta.detail, MAX_DETAIL)
  entry.id = store(entry)
  if (level !== "debug") {
    recent.push(entry)
    if (recent.length > 300) recent.shift()
  }
  emit({ type: "log", ...entry })
  if (echo && echoFrom !== null && RANK[level] >= echoFrom) print(entry)
  return entry
}

/** One line of a text log (with its detail indented underneath). */
export function formatLine(e: LogEntry, withDetail = true): string {
  const job = e.jobLabel && e.area !== "jobs" ? `  [${e.jobLabel}]` : ""
  const head = `${e.at} ${LEVEL_WORD[e.level].padEnd(6)} ${e.area.padEnd(12)} ${e.message}${job}${e.trackId ? `  (track ${e.trackId})` : ""}`
  return withDetail && e.detail ? `${head}\n${e.detail.replace(/^/gm, "    ")}` : head
}

function print(e: LogEntry) {
  const line = formatLine(e, e.level === "error")
  if (e.level === "error") out.error(line)
  else if (e.level === "warn") out.warn(line)
  else out.log(line)
}

/** An error's stack trace (and what caused it), for a line's detail. */
export function errorDetail(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const cause = err.cause instanceof Error ? `\nCaused by: ${err.cause.stack ?? err.cause.message}` : ""
  return `${err.stack ?? err.message}${cause}`
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function echoLevel(v: string | undefined): number | null {
  const s = (v ?? "").trim().toLowerCase()
  if (s === "off" || s === "none" || s === "silent") return null
  if (s === "detail" || s === "debug") return RANK.debug
  if (s === "warn" || s === "warning") return RANK.warn
  if (s === "error") return RANK.error
  return RANK.info
}

let started = false

/** For the running server (not tests): print lines, catch what others write, and keep the log trimmed. */
export function startLogging() {
  if (started) return
  started = true
  echoFrom = echoLevel(process.env.DUBPLATE_LOG_LEVEL)
  // Whatever else writes a warning or an error (a library, Node itself) lands in the Console too.
  const capture = (level: "warn" | "error", args: unknown[]) => {
    const text = format(...args)
    const [first, ...rest] = text.split("\n")
    log(level, first || "(empty message)", { area: "server", trackId: null, detail: rest.length ? text : undefined }, false)
  }
  console.warn = (...args: unknown[]) => {
    out.warn(...args)
    capture("warn", args)
  }
  console.error = (...args: unknown[]) => {
    out.error(...args)
    capture("error", args)
  }
  process.on("warning", (w) => log("warn", `${w.name}: ${w.message}`, { area: "server", trackId: null, detail: w.stack }, false))
  // Node prints the crash itself; this keeps it in the Console for afterwards.
  process.on("uncaughtExceptionMonitor", (err, origin) =>
    log("error", `Dubplate stopped on ${origin === "unhandledRejection" ? "a failed promise nobody handled" : "an error nobody handled"}: ${errorText(err)}`, { area: "server", trackId: null, detail: errorDetail(err) }, false)
  )
  pruneLogs()
  setInterval(pruneLogs, 60 * 60 * 1000).unref()
}

/** Drop lines older than the keep period, and the oldest past MAX_LOG_ROWS. */
export function pruneLogs(now = Date.now()): number {
  try {
    const db = getDb()
    let n = Number(db.prepare("DELETE FROM logs WHERE at < ?").run(new Date(now - options.keepDays * DAY).toISOString()).changes)
    const edge = db.prepare("SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?").get(MAX_LOG_ROWS) as { id: number } | undefined
    if (edge) n += Number(db.prepare("DELETE FROM logs WHERE id <= ?").run(edge.id).changes)
    return n
  } catch {
    return 0
  }
}

export function clearLogs(): number {
  recent.length = 0
  return Number(getDb().prepare("DELETE FROM logs").run().changes)
}

// ---------- reading it back ----------

export interface LogFilter {
  levels?: LogLevel[]
  areas?: LogArea[]
  jobId?: string
  trackId?: number
  /** words in the message or its detail */
  q?: string
}

function where(f: LogFilter, extra: string[] = [], extraParams: SQLInputValue[] = []) {
  const clauses = [...extra]
  const params = [...extraParams]
  if (f.levels?.length) {
    clauses.push(`l.level IN (${f.levels.map(() => "?").join(", ")})`)
    params.push(...f.levels)
  }
  if (f.areas?.length) {
    clauses.push(`l.area IN (${f.areas.map(() => "?").join(", ")})`)
    params.push(...f.areas)
  }
  if (f.jobId) {
    clauses.push("l.job_id = ?")
    params.push(f.jobId)
  }
  if (f.trackId) {
    clauses.push("l.track_id = ?")
    params.push(f.trackId)
  }
  const q = f.q?.trim()
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    clauses.push("(l.message LIKE ? ESCAPE '\\' OR l.detail LIKE ? ESCAPE '\\')")
    params.push(like, like)
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params }
}

type Row = { id: number; at: string; level: LogLevel; area: LogArea; message: string; job_id: string | null; job_label: string | null; track_id: number | null; detail: string | null }

function rowToEntry(r: Row): LogEntry {
  const e: LogEntry = { id: r.id, at: r.at, level: r.level, area: r.area, message: r.message }
  if (r.job_id) e.jobId = r.job_id
  if (r.job_label) e.jobLabel = r.job_label
  if (r.track_id) e.trackId = r.track_id
  if (r.detail) e.detail = r.detail
  return e
}

const SELECT = "SELECT l.*, j.label AS job_label FROM logs l LEFT JOIN jobs j ON j.id = l.job_id"

/**
 * A page of lines, oldest first. By default the newest `limit`; with `before`, the
 * ones just older than that line; with `after`, the ones just newer. `more` says
 * whether there are further lines in the direction asked.
 */
export function queryLogs(f: LogFilter & { before?: number; after?: number; limit?: number }): { entries: LogEntry[]; more: boolean } {
  const limit = Math.min(2000, Math.max(1, Math.round(f.limit ?? 500)))
  const db = getDb()
  if (f.after !== undefined) {
    const { sql, params } = where(f, ["l.id > ?"], [f.after])
    const rows = db.prepare(`${SELECT} ${sql} ORDER BY l.id ASC LIMIT ?`).all(...params, limit + 1) as Row[]
    return { entries: rows.slice(0, limit).map(rowToEntry), more: rows.length > limit }
  }
  const { sql, params } = f.before !== undefined ? where(f, ["l.id < ?"], [f.before]) : where(f)
  const rows = db.prepare(`${SELECT} ${sql} ORDER BY l.id DESC LIMIT ?`).all(...params, limit + 1) as Row[]
  return { entries: rows.slice(0, limit).reverse().map(rowToEntry), more: rows.length > limit }
}

/** Counts for the filters: by level within the areas picked, and by area within the levels picked. */
export function logSummary(f: LogFilter): LogSummary {
  const db = getDb()
  const byLevel = Object.fromEntries(LOG_LEVELS.map((l) => [l, 0])) as Record<LogLevel, number>
  const lv = where({ ...f, levels: undefined })
  for (const r of db.prepare(`SELECT l.level, COUNT(*) AS n FROM logs l ${lv.sql} GROUP BY l.level`).all(...lv.params) as { level: LogLevel; n: number }[]) {
    if (r.level in byLevel) byLevel[r.level] = r.n
  }
  const byArea: LogSummary["byArea"] = {}
  const ar = where({ ...f, areas: undefined })
  for (const r of db.prepare(`SELECT l.area, COUNT(*) AS n FROM logs l ${ar.sql} GROUP BY l.area`).all(...ar.params) as { area: LogArea; n: number }[]) byArea[r.area] = r.n
  const { total, oldest } = db.prepare("SELECT COUNT(*) AS total, MIN(at) AS oldest FROM logs").get() as { total: number; oldest: string | null }
  const jobs = (
    db
      .prepare("SELECT j.id, j.label, j.kind, j.status, j.created_at FROM jobs j WHERE EXISTS (SELECT 1 FROM logs WHERE job_id = j.id) ORDER BY j.created_at DESC LIMIT 60")
      .all() as { id: string; label: string; kind: JobKind; status: LogSummary["jobs"][number]["status"]; created_at: string }[]
  ).map((j) => ({ id: j.id, label: j.label, kind: j.kind, status: j.status, createdAt: j.created_at }))
  return { total, byLevel, byArea, oldest, jobs }
}

/** Every matching line as text, oldest first, for a download. */
export function* logText(f: LogFilter): Generator<string> {
  const { sql, params } = where(f)
  for (const r of getDb()
    .prepare(`${SELECT} ${sql} ORDER BY l.id ASC`)
    .iterate(...params)) {
    yield `${formatLine(rowToEntry(r as Row))}\n`
  }
}
