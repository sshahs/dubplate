// Polite HTTP for metadata sources: per-host rate limits, response cache in
// SQLite, retries on 429/503 and a descriptive User-Agent.

import { createHash } from "node:crypto"
import { VERSION } from "../config"
import { getDb } from "../db"

const HOST_INTERVAL_MS: Record<string, number> = {
  "musicbrainz.org": 1100,
  "api.discogs.com": 1100,
  "itunes.apple.com": 3100,
  "api.deezer.com": 150,
  "ws.audioscrobbler.com": 250,
  "api.spotify.com": 120,
  "accounts.spotify.com": 120,
  "bandcamp.com": 1200,
  "archive.org": 600,
  "api.mixcloud.com": 400,
  "www.googleapis.com": 120,
  "api.acoustid.org": 350,
}

const nextSlot = new Map<string, number>()

async function waitForSlot(host: string, signal?: AbortSignal) {
  const interval = HOST_INTERVAL_MS[host] ?? 1000
  const now = Date.now()
  const at = Math.max(now, nextSlot.get(host) ?? 0)
  nextSlot.set(host, at + interval)
  const wait = at - now
  if (wait > 0) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, wait)
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t)
          reject(signal.reason ?? new Error("aborted"))
        },
        { once: true }
      )
    })
  }
}

let contact = ""
export function setContact(c: string) {
  contact = c
}

export function userAgent() {
  return `Dubplate/${VERSION} ( ${contact || "https://github.com/sshahs/dubplate"} )`
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface HttpOptions {
  method?: "GET" | "POST"
  headers?: Record<string, string>
  body?: string
  /** cache lifetime; 0 disables caching */
  ttlMs?: number
  signal?: AbortSignal
  timeoutMs?: number
}

const DAY = 24 * 60 * 60 * 1000

function cacheKey(url: string, opts: HttpOptions) {
  // Hashed so API keys embedded in URLs never sit in the cache in clear text.
  return createHash("sha256").update(`${opts.method ?? "GET"} ${url} ${opts.body ?? ""}`).digest("hex")
}

export async function httpText(url: string, opts: HttpOptions = {}): Promise<{ status: number; body: string; cached: boolean }> {
  const ttl = opts.ttlMs ?? 7 * DAY
  const key = cacheKey(url, opts)
  const db = getDb()
  if (ttl > 0) {
    const hit = db.prepare("SELECT status, body, fetched_at FROM http_cache WHERE key = ?").get(key) as
      | { status: number; body: string; fetched_at: number }
      | undefined
    if (hit && Date.now() - hit.fetched_at < ttl) return { status: hit.status, body: hit.body, cached: true }
  }
  const host = new URL(url).host
  let attempt = 0
  while (true) {
    await waitForSlot(host, opts.signal)
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000)
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: { "user-agent": userAgent(), accept: "application/json, text/html;q=0.9, */*;q=0.5", ...opts.headers },
      body: opts.body,
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    })
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      attempt++
      const retryAfter = Number(res.headers.get("retry-after"))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt
      nextSlot.set(host, Date.now() + delay)
      continue
    }
    const body = await res.text()
    if (!res.ok && res.status !== 404) throw new HttpError(res.status, `${host} replied ${res.status}: ${body.slice(0, 160)}`)
    if (ttl > 0) {
      db.prepare(
        "INSERT INTO http_cache (key, status, body, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET status = excluded.status, body = excluded.body, fetched_at = excluded.fetched_at"
      ).run(key, res.status, body, Date.now())
    }
    return { status: res.status, body, cached: false }
  }
}

export async function httpJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T | null> {
  const { status, body } = await httpText(url, opts)
  if (status === 404) return null
  try {
    return JSON.parse(body) as T
  } catch {
    throw new HttpError(status, `${new URL(url).host} returned invalid JSON`)
  }
}

export function clearHttpCache() {
  return Number(getDb().prepare("DELETE FROM http_cache").run().changes)
}

export function pruneHttpCache(maxAgeMs = 30 * DAY) {
  getDb().prepare("DELETE FROM http_cache WHERE fetched_at < ?").run(Date.now() - maxAgeMs)
}
