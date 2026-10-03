// In-process job queue. Jobs run one at a time so rate limits and file
// operations never race each other; progress streams over SSE. A second,
// quick lane takes small jobs that only read and identify (re-running one
// track, say), so they don't wait hours behind a whole library.

import { randomUUID } from "node:crypto"
import type { Job, JobKind, LogLevel } from "../shared/types"
import { emit, inScope, runScope } from "./bus"
import { getDb } from "./db"
import { areaOfJob, errorDetail, log, type LogMeta } from "./logs"

export { emit, subscribe } from "./bus"
export { log, recentLogEvents } from "./logs"

export interface JobContext {
  job: Job
  signal: AbortSignal
  setTotal(n: number): void
  tick(ok?: boolean, message?: string): void
  message(msg: string): void
  /** written against this job; inside a track's scope it's linked to the track too */
  log(level: LogLevel, message: string, meta?: Omit<LogMeta, "jobId" | "jobLabel">): void
  tracksChanged(ids: number[]): void
  /** files on disk were renamed, moved or retagged (media servers get told to rescan) */
  filesChanged(): void
  /** counts worth announcing, e.g. how many tracks now need a listen */
  report(counts: Record<string, number>): void
}

/** What a finished job did, for anything that reacts to jobs (media servers, chat notifications). */
export interface JobOutcome {
  filesChanged: boolean
  report: Record<string, number> | null
}

type JobFn = (ctx: JobContext) => Promise<void>

interface QueuedJob {
  job: Job
  fn: JobFn
  controller: AbortController
  outcome: JobOutcome
}

type FinishListener = (job: Job, outcome: JobOutcome) => void | Promise<void>
const finishListeners = new Set<FinishListener>()

/** Run `l` after every job finishes (whatever its status). */
export function onJobFinished(l: FinishListener) {
  finishListeners.add(l)
  return () => finishListeners.delete(l)
}

type Lane = { queue: QueuedJob[]; running: QueuedJob | null }
const main: Lane = { queue: [], running: null }
const quick: Lane = { queue: [], running: null }
const lanes = [main, quick]

/** Which job the current code is running for (AI usage is booked against it). */
export function currentJobId(): string | null {
  return runScope().job?.id ?? null
}

/** Run one track's work so everything logged inside it (web requests, sources, AI) is linked to the track. */
export function forTrack<T>(trackId: number, fn: () => T): T {
  return inScope({ trackId }, fn)
}

function took(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

function rowToJob(r: Record<string, unknown>): Job {
  return {
    id: r.id as string,
    kind: r.kind as JobKind,
    status: r.status as Job["status"],
    label: r.label as string,
    total: r.total as number,
    done: r.done as number,
    failed: r.failed as number,
    message: (r.message as string) ?? null,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string) ?? null,
    finishedAt: (r.finished_at as string) ?? null,
  }
}

function persist(job: Job) {
  getDb()
    .prepare(
      `INSERT INTO jobs (id, kind, status, label, total, done, failed, message, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, total = excluded.total, done = excluded.done,
         failed = excluded.failed, message = excluded.message, started_at = excluded.started_at, finished_at = excluded.finished_at`
    )
    .run(job.id, job.kind, job.status, job.label, job.total, job.done, job.failed, job.message, job.createdAt, job.startedAt, job.finishedAt)
}

let lastEmit = new Map<string, number>()
function publish(job: Job, force = false) {
  const now = Date.now()
  if (!force && now - (lastEmit.get(job.id) ?? 0) < 200) return
  lastEmit.set(job.id, now)
  persist(job)
  emit({ type: "job", job: { ...job } })
}

export interface EnqueueOptions {
  /** a small job that doesn't move files: it may run alongside the main queue */
  quick?: boolean
}

export function enqueueJob(kind: JobKind, label: string, fn: JobFn, opts: EnqueueOptions = {}): Job {
  const job: Job = {
    id: randomUUID(),
    kind,
    status: "queued",
    label,
    total: 0,
    done: 0,
    failed: 0,
    message: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  }
  const lane = opts.quick ? quick : main
  lane.queue.push({ job, fn, controller: new AbortController(), outcome: { filesChanged: false, report: null } })
  publish(job, true)
  void pump(lane)
  return job
}

async function pump(lane: Lane) {
  if (lane.running) return
  const next = lane.queue.shift()
  if (!next) return
  lane.running = next
  const { job, fn, controller, outcome } = next
  job.status = "running"
  job.startedAt = new Date().toISOString()
  publish(job, true)
  const ctx: JobContext = {
    job,
    signal: controller.signal,
    setTotal(n) {
      job.total = n
      publish(job, true)
    },
    tick(ok = true, message) {
      if (ok) job.done++
      else job.failed++
      if (message) job.message = message
      publish(job)
    },
    message(msg) {
      job.message = msg
      publish(job)
    },
    log(level, message, meta) {
      log(level, message, { area: areaOfJob(job.kind), ...meta, jobId: job.id, jobLabel: job.label })
    },
    tracksChanged(ids) {
      if (ids.length) emit({ type: "tracks", ids })
    },
    filesChanged() {
      outcome.filesChanged = true
    },
    report(counts) {
      outcome.report = { ...outcome.report, ...counts }
    },
  }
  const said: LogMeta = { area: "jobs", jobId: job.id, jobLabel: job.label, trackId: null }
  log("info", `Started: ${job.label}`, said)
  try {
    await inScope({ job: { id: job.id, kind: job.kind, label: job.label } }, () => fn(ctx))
    job.status = controller.signal.aborted ? "cancelled" : "done"
  } catch (err) {
    job.status = controller.signal.aborted ? "cancelled" : "failed"
    job.message = err instanceof Error ? err.message : String(err)
    if (job.status === "failed") log("error", `${job.label} failed: ${job.message}`, { ...said, detail: errorDetail(err) })
  } finally {
    job.finishedAt = new Date().toISOString()
    const counts = job.total || job.done || job.failed ? ` - ${job.done} done${job.failed ? `, ${job.failed} failed` : ""}${job.total ? ` of ${job.total}` : ""}` : ""
    const time = took(Date.parse(job.finishedAt) - Date.parse(job.startedAt!))
    if (job.status === "cancelled") log("warn", `Cancelled: ${job.label} after ${time}${counts}`, said)
    else if (job.status === "done") log(job.failed ? "warn" : "success", `Finished: ${job.label} in ${time}${counts}`, said)
    publish(job, true)
    lastEmit.delete(job.id)
    emit({ type: "stats" })
    lane.running = null
    for (const l of finishListeners) {
      Promise.resolve()
        .then(() => l({ ...job }, outcome))
        .catch((err) => log("warn", `After "${job.label}": ${err instanceof Error ? err.message : err}`, { ...said, detail: errorDetail(err) }))
    }
    void pump(lane)
  }
}

export function cancelJob(id: string): boolean {
  for (const lane of lanes) {
    if (lane.running?.job.id === id) {
      lane.running.controller.abort()
      return true
    }
    const i = lane.queue.findIndex((q) => q.job.id === id)
    if (i >= 0) {
      const [q] = lane.queue.splice(i, 1)
      q.job.status = "cancelled"
      q.job.finishedAt = new Date().toISOString()
      publish(q.job, true)
      return true
    }
  }
  return false
}

export function listJobs(limit = 30): Job[] {
  const rows = getDb().prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]
  return rows.map(rowToJob)
}

export function activeJobs(): Job[] {
  return lanes.flatMap((l) => [l.running?.job, ...l.queue.map((q) => q.job)]).filter((j): j is Job => !!j)
}

/** Jobs that were mid-flight when the server stopped can never finish. */
export function markInterruptedJobs() {
  const db = getDb()
  const cut = db.prepare("SELECT id, label FROM jobs WHERE status IN ('queued', 'running')").all() as { id: string; label: string }[]
  db.prepare("UPDATE jobs SET status = 'failed', message = 'Interrupted by server restart', finished_at = datetime('now') WHERE status IN ('queued', 'running')").run()
  for (const j of cut) log("warn", `Interrupted when the server stopped: ${j.label}`, { area: "jobs", jobId: j.id, jobLabel: j.label })
}

/** Run `fn` over items with bounded concurrency, stopping early on abort. */
export async function mapLimit<T>(items: T[], limit: number, signal: AbortSignal, fn: (item: T, i: number) => Promise<void>) {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !signal.aborted) {
      const i = next++
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

export function resetJobStateForTests() {
  for (const lane of lanes) {
    lane.queue.length = 0
    lane.running = null
  }
  lastEmit = new Map()
}
