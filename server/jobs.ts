// In-process job queue + event bus. Jobs run one at a time so rate limits
// and file operations never race each other; progress streams over SSE.

import { randomUUID } from "node:crypto"
import type { Job, JobKind, ServerEvent } from "../shared/types"
import { getDb } from "./db"

type Listener = (e: ServerEvent) => void
const listeners = new Set<Listener>()
const recentLogs: ServerEvent[] = []

export function emit(e: ServerEvent) {
  if (e.type === "log") {
    recentLogs.push(e)
    if (recentLogs.length > 300) recentLogs.shift()
  }
  for (const l of listeners) {
    try {
      l(e)
    } catch {
      // a broken SSE client must not break the job
    }
  }
}

export function subscribe(l: Listener) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function recentLogEvents() {
  return [...recentLogs]
}

export function log(level: "info" | "warn" | "error" | "success", message: string, jobId?: string) {
  emit({ type: "log", level, message, jobId, at: new Date().toISOString() })
  if (level === "error") console.error(`[dubplate] ${message}`)
}

export interface JobContext {
  job: Job
  signal: AbortSignal
  setTotal(n: number): void
  tick(ok?: boolean, message?: string): void
  message(msg: string): void
  log(level: "info" | "warn" | "error" | "success", message: string): void
  tracksChanged(ids: number[]): void
}

type JobFn = (ctx: JobContext) => Promise<void>

interface QueuedJob {
  job: Job
  fn: JobFn
  controller: AbortController
}

const queue: QueuedJob[] = []
let running: QueuedJob | null = null

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

export function enqueueJob(kind: JobKind, label: string, fn: JobFn): Job {
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
  queue.push({ job, fn, controller: new AbortController() })
  publish(job, true)
  void pump()
  return job
}

async function pump() {
  if (running) return
  const next = queue.shift()
  if (!next) return
  running = next
  const { job, fn, controller } = next
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
    log(level, message) {
      log(level, message, job.id)
    },
    tracksChanged(ids) {
      if (ids.length) emit({ type: "tracks", ids })
    },
  }
  try {
    await fn(ctx)
    job.status = controller.signal.aborted ? "cancelled" : "done"
  } catch (err) {
    job.status = controller.signal.aborted ? "cancelled" : "failed"
    job.message = err instanceof Error ? err.message : String(err)
    log("error", `${job.label} failed: ${job.message}`, job.id)
  } finally {
    job.finishedAt = new Date().toISOString()
    publish(job, true)
    lastEmit.delete(job.id)
    emit({ type: "stats" })
    running = null
    void pump()
  }
}

export function cancelJob(id: string): boolean {
  if (running?.job.id === id) {
    running.controller.abort()
    return true
  }
  const i = queue.findIndex((q) => q.job.id === id)
  if (i >= 0) {
    const [q] = queue.splice(i, 1)
    q.job.status = "cancelled"
    q.job.finishedAt = new Date().toISOString()
    publish(q.job, true)
    return true
  }
  return false
}

export function listJobs(limit = 30): Job[] {
  const rows = getDb().prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]
  return rows.map(rowToJob)
}

export function activeJobs(): Job[] {
  return [running?.job, ...queue.map((q) => q.job)].filter((j): j is Job => !!j)
}

/** Jobs that were mid-flight when the server stopped can never finish. */
export function markInterruptedJobs() {
  getDb()
    .prepare("UPDATE jobs SET status = 'failed', message = 'Interrupted by server restart', finished_at = datetime('now') WHERE status IN ('queued', 'running')")
    .run()
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
  queue.length = 0
  running = null
  lastEmit = new Map()
}
