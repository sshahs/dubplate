// Polite HTTP for metadata sources: per-host rate limits, response cache in
// SQLite, retries on 429/503 and a descriptive User-Agent.

import { createHash } from "node:crypto"
import { VERSION } from "../config"
import { getDb } from "../db"
import { errorText, log } from "../logs"

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
  "coverartarchive.org": 1100,
  "i.discogs.com": 1100,
  "lrclib.net": 250,
  // A small static site read page by page once a month.
  "whocorkthedance.com": 400,
  // Hobby sites and small shops: gently.
  "www.riddimguide.com": 1500,
  "riddim-id.com": 1500,
  "www.reggaefever.ch": 1500,
  "riddimsworld.com": 1500,
  "www.ravetapepacks.com": 1500,
  "rave-archive.com": 1500,
  "www.mixesdb.com": 1000,
  "junglist.co.uk": 1500,
}

const nextSlot = new Map<string, number>()

/** Keys, tokens and passwords in a URL (query or path) blanked out, so it can go in the log. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    for (const k of [...u.searchParams.keys()]) if (/key|token|secret|passw|sig|auth|session/i.test(k)) u.searchParams.set(k, "•••")
    if (u.username) u.username = "•••"
    if (u.password) u.password = "•••"
    // Telegram bots and Discord webhooks carry their secret in the path.
    return u
      .toString()
      .replace(/\/bot\d+:[\w-]+/, "/bot•••")
      .replace(/(\/webhooks\/\d+\/)[\w-]+/, "$1•••")
  } catch {
    return "(not a URL)"
  }
}

/** Host and path, readable and short, for the log line itself. */
function shortUrl(url: string): string {
  const full = redactUrl(url).replace(/^https?:\/\//, "")
  let readable = full
  try {
    readable = decodeURI(full)
  } catch {
    // leave it encoded
  }
  return readable.length > 140 ? `${readable.slice(0, 139)}…` : readable
}

const ago = (ms: number) => (ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : ms < DAY ? `${Math.round(ms / 3_600_000)} h ago` : `${Math.round(ms / DAY)} days ago`)

export async function waitForSlot(host: string, signal?: AbortSignal) {
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
  const method = opts.method ?? "GET"
  if (ttl > 0) {
    const hit = db.prepare("SELECT status, body, fetched_at FROM http_cache WHERE key = ?").get(key) as
      | { status: number; body: string; fetched_at: number }
      | undefined
    if (hit && Date.now() - hit.fetched_at < ttl) {
      log("debug", `${method} ${shortUrl(url)} - ${hit.status}, from the cache (fetched ${ago(Date.now() - hit.fetched_at)})`, { area: "http", detail: redactUrl(url) })
      return { status: hit.status, body: hit.body, cached: true }
    }
  }
  const host = new URL(url).host
  let attempt = 0
  while (true) {
    const queued = Date.now()
    await waitForSlot(host, opts.signal)
    const started = Date.now()
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000)
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers: { "user-agent": userAgent(), accept: "application/json, text/html;q=0.9, */*;q=0.5", ...opts.headers },
        body: opts.body,
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      })
    } catch (err) {
      // Cancelled with its job: nothing went wrong.
      if (!opts.signal?.aborted) {
        const why = timeout.aborted ? `no answer within ${Math.round((opts.timeoutMs ?? 20_000) / 1000)} s` : errorText(err)
        const cause = err instanceof Error && err.cause instanceof Error ? `\nCause: ${err.cause.message}` : ""
        log("debug", `${method} ${shortUrl(url)} - failed: ${why}`, { area: "http", detail: `${redactUrl(url)}${cause}` })
      }
      throw err
    }
    const ms = Date.now() - started
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      attempt++
      const retryAfter = Number(res.headers.get("retry-after"))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt
      nextSlot.set(host, Date.now() + delay)
      log("debug", `${method} ${shortUrl(url)} - ${res.status} (too busy), trying again in ${Math.round(delay / 1000)} s`, { area: "http", detail: redactUrl(url) })
      continue
    }
    // Old sites are often Latin-1 (Windows-1252) whatever they declare: decode as that when it isn't UTF-8.
    const bytes = new Uint8Array(await res.arrayBuffer())
    let body: string
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      body = new TextDecoder("windows-1252").decode(bytes)
    }
    const waited = started - queued
    log("debug", `${method} ${shortUrl(url)} - ${res.status} in ${ms} ms`, {
      area: "http",
      detail: [
        redactUrl(url),
        `${res.status} ${res.statusText}, ${bytes.length.toLocaleString("en")} bytes${res.headers.get("content-type") ? ` of ${res.headers.get("content-type")}` : ""}`,
        waited > 50 ? `Waited ${waited} ms for its turn (${host} is asked at most every ${HOST_INTERVAL_MS[host] ?? 1000} ms)` : "",
        attempt ? `Asked ${attempt + 1} times: the site said it was too busy` : "",
        !res.ok && res.status !== 404 ? `Reply: ${body.slice(0, 600)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    })
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
