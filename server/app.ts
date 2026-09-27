import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { getConnInfo } from "@hono/node-server/conninfo"
import { Hono, type Context } from "hono"
import { compress } from "hono/compress"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { streamSSE } from "hono/streaming"
import { parseKey } from "../shared/keys"
import type { ApiToken, DjFormat, FinalMeta, Library, MediaServerConfig, PathMapping, ScraperDefinition, ServerEvent, Settings, Track, TrackStatus } from "../shared/types"
import { TRACK_STATUSES } from "../shared/types"
import { activeProvider, interpretTrack } from "./ai/interpreter"
import { listModels, testProvider } from "./ai/providers"
import { usageReport } from "./ai/usage"
import { analyzeTracks } from "./analysis"
import { findArtwork, thumbnail } from "./art"
import { lyricsForTrack, lyricsTracks, topUpLyrics } from "./lyrics"
import * as auth from "./auth"
import * as tokens from "./tokens"
import { readHook, recentHookCalls, runHook } from "./hooks"
import { saveUpload, UploadError } from "./uploads"
import { config, VERSION } from "./config"
import { cleanRules, crateFacets, createCrate, deleteCrate, getCrate, listCrates, mixSuggestionIds, updateCrate } from "./crates"
import { exportPlaylists, type Playlist } from "./dj-export"
import { healthReport } from "./health"
import { parseFilename } from "./core/filename-parser"
import { normArtist } from "./core/normalize"
import { buildPlan, executePlan, metaFor, proposedFilename, rewind } from "./executor"
import { activeJobs, cancelJob, emit, enqueueJob, listJobs, log, recentLogEvents, subscribe } from "./jobs"
import { isBackup, makeBackup, restoreBackup } from "./backup"
import { duplicateGroups, setAside, setAsideCount, validResolutions, type Resolution } from "./duplicates"
import { sendChat, type ChatChannel } from "./integrations/chat"
import { testMediaServer } from "./integrations/media-servers"
import { executeOrganise, planOrganise, type OrganiseRequest } from "./organise"
import { artworkTracks, processTracks, rescoreTracks, scoreAndSave } from "./pipeline"
import * as repo from "./repo"
import { scanLibrary } from "./scanner"
import { isMasked, publicSettings, saveSettings, settingsNow } from "./settings"
import { findFpcalc } from "./sources/acoustid"
import { clearHttpCache } from "./sources/http"
import { allAdapters, buildQuery, sourceStatus } from "./sources"
import { collectionStatus, syncCollection } from "./sources/discogs-collection"
import { runScraper } from "./sources/scraper"
import { restore, snapshot } from "./undo"
import { scanSoon, syncWatchers } from "./watcher"

const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  wma: "audio/x-ms-wma",
}

type Selection = { ids?: number[]; filter?: repo.TrackQuery }

function resolveIds(sel: Selection, fallback?: repo.TrackQuery): number[] {
  if (sel.ids?.length) return sel.ids.map(Number).filter(Number.isFinite)
  if (sel.filter) return repo.queryTrackIds(sel.filter)
  return fallback ? repo.queryTrackIds(fallback) : []
}

function parseQuery(c: Context): repo.TrackQuery {
  const q = c.req.query()
  const status = q.status
    ?.split(",")
    .map((s) => s.trim())
    .filter((s): s is TrackStatus => TRACK_STATUSES.includes(s as TrackStatus))
  return {
    status: status?.length ? status : undefined,
    libraryId: q.libraryId ? Number(q.libraryId) : undefined,
    q: q.q || undefined,
    minConfidence: q.min ? Number(q.min) : undefined,
    maxConfidence: q.max ? Number(q.max) : undefined,
    includeMissing: q.missing === "1",
    crateId: q.crate ? Number(q.crate) : undefined,
    quality: q.quality === "suspect" || q.quality === "ok" ? q.quality : undefined,
    problems: q.problems === "1" || undefined,
    sort: (q.sort as repo.TrackQuery["sort"]) || undefined,
    dir: q.dir === "desc" ? "desc" : "asc",
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
  }
}

/** Fields bulk edit can set; null or "" clears one. */
type BulkChanges = {
  artists?: string[]
  featuring?: string[]
  version?: string | null
  album?: string | null
  year?: number | null
  label?: string | null
  genre?: string | null
  bpm?: number | null
  key?: string | null
}
const META_FIELDS = ["artists", "featuring", "version", "album", "year", "label", "genre"] as const

/** The metadata a track would be tagged with right now, however far it's got. */
function currentMeta(t: Track): Partial<FinalMeta> | null {
  return metaFor(t) ?? (t.ai?.title ? t.ai : null) ?? (t.heuristic?.title ? t.heuristic : null)
}

function sanitizeBpm(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n >= 30 && n <= 300 ? Math.round(n * 10) / 10 : null
}

function sanitizeFinal(input: Partial<FinalMeta>): FinalMeta {
  const clean = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim()
  const list = (xs?: string[]) => (xs ?? []).map(clean).filter(Boolean)
  const rel = input.relation === "&" || input.relation === "vs" || input.relation === "x" ? input.relation : undefined
  const year = Number(input.year)
  return {
    artists: list(input.artists),
    featuring: list(input.featuring),
    relation: rel,
    title: clean(input.title),
    version: clean(input.version) || undefined,
    year: Number.isFinite(year) && year > 1900 && year < 2100 ? year : undefined,
    album: clean(input.album) || undefined,
    label: clean(input.label) || undefined,
    genre: clean(input.genre) || undefined,
  }
}

/** Reachable without signing in, even with a password set. */
const OPEN_PATHS = new Set(["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/logout"])

function isHttps(c: Context) {
  return c.req.url.startsWith("https:") || c.req.header("x-forwarded-proto")?.split(",")[0].trim() === "https"
}

/** Who's signing in, for throttling guesses (behind a proxy, everyone shares its address). */
function clientAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown"
  } catch {
    return "unknown"
  }
}

export function createApp() {
  const app = new Hono<{ Variables: { token?: ApiToken } }>()

  // ---- local-app security: DNS-rebinding + CSRF guards ----
  app.use("/api/*", async (c, next) => {
    // Scripts and download tools come with an API token instead of a browser session. The
    // Host and X-Dubplate checks guard browsers against other sites; a token can't be forged
    // by one, so it's enough on its own.
    const raw = tokens.tokenFromRequest({ authorization: c.req.header("authorization"), xToken: c.req.header("x-dubplate-token") }, c.req.query("token"))
    if (raw) {
      const tok = tokens.checkToken(raw)
      if (!tok) return c.json({ error: "That API token isn't valid - it may have been deleted" }, 401)
      if (tokens.tokensMayNotCall(c.req.path)) return c.json({ error: "API tokens can't sign in or manage tokens" }, 403)
      if (tok.scope === "hooks" && !tokens.hooksMayCall(c.req.path)) return c.json({ error: `"${tok.name}" can only report downloads and upload files` }, 403)
      c.set("token", tok)
      return next()
    }
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
    const okHosts = new Set(["localhost", "127.0.0.1", "::1", config.host, ...config.allowedHosts])
    if (host && !okHosts.has(host) && !config.allowedHosts.includes("*")) {
      return c.json({ error: `Host "${host}" not allowed - add it to DUBPLATE_ALLOWED_HOSTS` }, 403)
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-dubplate") !== "1") {
      return c.json({ error: "Missing X-Dubplate header" }, 403)
    }
    // With a password set, only signing in (and the bare health check) works without a session.
    if (!OPEN_PATHS.has(c.req.path) && auth.authEnabled() && !auth.validSession(getCookie(c, auth.SESSION_COOKIE))) {
      return c.json({ error: "Sign in to Dubplate first" }, 401)
    }
    await next()
  })

  // ---- sign-in ----
  const startSession = (c: Context) =>
    setCookie(c, auth.SESSION_COOKIE, auth.issueSession(), {
      httpOnly: true,
      sameSite: "Strict",
      secure: isHttps(c),
      path: "/",
      maxAge: auth.SESSION_DAYS * 86400,
    })

  app.get("/api/auth/status", (c) => c.json(auth.authStatus(getCookie(c, auth.SESSION_COOKIE))))

  app.post("/api/auth/login", async (c) => {
    const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }))
    const who = clientAddress(c)
    const wait = auth.lockedFor(who)
    if (wait) return c.json({ error: `Too many wrong passwords - try again in ${Math.ceil(wait / 1000)} s` }, 429)
    if (!auth.authEnabled()) return c.json({ ok: true })
    const ok = !!password && auth.checkPassword(password)
    auth.recordAttempt(who, ok)
    if (!ok) return c.json({ error: "That's not the password" }, 401)
    startSession(c)
    return c.json({ ok: true })
  })

  app.post("/api/auth/logout", (c) => {
    deleteCookie(c, auth.SESSION_COOKIE, { path: "/" })
    return c.json({ ok: true })
  })

  /** Set or change the password (the current one is needed to change it). */
  app.post("/api/auth/password", async (c) => {
    if (auth.passwordFromEnv()) return c.json({ error: "The password is set with DUBPLATE_PASSWORD - change it there" }, 409)
    const body = await c.req.json<{ current?: string; next?: string }>()
    if (auth.authEnabled() && !auth.checkPassword(body.current ?? "")) return c.json({ error: "The current password isn't right" }, 403)
    try {
      auth.setPassword(body.next ?? "")
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
    // Everyone else is signed out; this browser carries on.
    startSession(c)
    return c.json(auth.authStatus(auth.issueSession()))
  })

  app.post("/api/auth/password/remove", async (c) => {
    if (auth.passwordFromEnv()) return c.json({ error: "The password is set with DUBPLATE_PASSWORD - remove it there" }, 409)
    const body = await c.req.json<{ current?: string }>()
    if (!auth.checkPassword(body.current ?? "")) return c.json({ error: "The current password isn't right" }, 403)
    auth.removePassword()
    deleteCookie(c, auth.SESSION_COOKIE, { path: "/" })
    return c.json(auth.authStatus(undefined))
  })

  app.post("/api/auth/logout-everywhere", (c) => {
    auth.signOutEverywhere()
    startSession(c)
    return c.json({ ok: true })
  })

  // Gzip JSON (a page of tracks shrinks ~8×) - but never the event stream, audio or images.
  const gzip = compress()
  app.use("*", (c, next) => (c.req.path === "/api/events" || /\/(audio|art)$/.test(c.req.path) ? next() : gzip(c, next)))

  app.onError((err, c) => {
    console.error(err)
    return c.json({ error: err.message }, 500)
  })

  // ---- health, events, stats ----
  app.get("/api/health", (c) => {
    // Enough for a container health check; the rest waits until you've signed in.
    if (auth.authEnabled() && !auth.validSession(getCookie(c, auth.SESSION_COOKIE))) return c.json({ auth: true, version: VERSION })
    const s = settingsNow()
    const p = activeProvider(s)
    return c.json({
      auth: auth.authEnabled(),
      version: VERSION,
      dataDir: config.dataDir,
      readOnly: s.safety.readOnly,
      fpcalc: !!findFpcalc(),
      llm: p ? { id: p.id, label: p.label, model: p.model, kind: p.kind } : null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  })

  app.get("/api/health/checks", async (c) => c.json(await healthReport(settingsNow(), c.req.query("fresh") === "1")))

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: ServerEvent[] = [...recentLogEvents().slice(-50), ...activeJobs().map((job) => ({ type: "job" as const, job }))]
      let wake: (() => void) | null = null
      const unsubscribe = subscribe((e) => {
        queue.push(e)
        wake?.()
      })
      let alive = true
      stream.onAbort(() => {
        alive = false
        unsubscribe()
        wake?.()
      })
      while (alive) {
        while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) })
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, 25_000)
        })
        wake = null
        if (!queue.length && alive) await stream.writeSSE({ event: "ping", data: "" })
      }
    })
  )

  app.get("/api/stats", (c) => c.json(repo.stats()))

  // ---- libraries ----
  app.get("/api/libraries", (c) => c.json(repo.listLibraries()))

  app.post("/api/libraries", async (c) => {
    const body = await c.req.json<{ path: string; name?: string; scan?: boolean; process?: boolean; watch?: boolean }>()
    const p = path.resolve(body.path.replace(/^~(?=$|[\\/])/, os.homedir()))
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return c.json({ error: "That folder doesn't exist" }, 400)
    const overlapping = repo.listLibraries().find((l) => p.startsWith(l.path + path.sep) || l.path.startsWith(p + path.sep) || l.path === p)
    if (overlapping) return c.json({ error: `Overlaps with library "${overlapping.name}"` }, 400)
    const lib = repo.addLibrary(p, body.name?.trim() || path.basename(p), { watch: !!body.watch })
    if (body.watch) syncWatchers()
    if (body.scan !== false) enqueueScan(lib.id, { process: !!body.process })
    return c.json(lib)
  })

  app.patch("/api/libraries/:id", async (c) => {
    const id = Number(c.req.param("id"))
    if (!repo.getLibrary(id)) return c.json({ error: "Library not found" }, 404)
    const body = await c.req.json<{ name?: string; watch?: boolean; settings?: Library["settings"] }>()
    const inbox = body.settings?.inboxFor
    if (inbox !== undefined && inbox !== null) {
      const target = repo.getLibrary(Number(inbox))
      if (!target || target.id === id) return c.json({ error: "Pick another library for the inbox to feed" }, 400)
      if (target.settings.inboxFor) return c.json({ error: `${target.name} is an inbox itself - point this one at the library it feeds` }, 400)
      if (repo.listLibraries().some((l) => l.id !== id && l.settings.inboxFor === id)) return c.json({ error: "Another inbox feeds this library, so it can't be an inbox itself" }, 400)
    }
    repo.updateLibrary(id, { name: body.name?.trim() || undefined, watch: typeof body.watch === "boolean" ? body.watch : undefined, settings: body.settings })
    syncWatchers()
    return c.json(repo.getLibrary(id))
  })

  app.delete("/api/libraries/:id", (c) => {
    repo.removeLibrary(Number(c.req.param("id")))
    syncWatchers()
    return c.json({ ok: true })
  })

  /** Scan a library; `process` then identifies whatever the scan found new (first-run setup). */
  function enqueueScan(id: number, opts: { process?: boolean } = {}) {
    const lib = repo.getLibrary(id)
    if (!lib) throw new Error("Library not found")
    return enqueueJob("scan", `Scan ${lib.name}`, async (ctx) => {
      const { added } = await scanLibrary(lib, settingsNow(), ctx)
      if (opts.process && added.length) {
        enqueueJob("process", `Identify ${added.length} track${added.length === 1 ? "" : "s"} in ${lib.name}`, (c) =>
          processTracks(added, settingsNow(), { interpret: true, scour: true, force: false }, c)
        )
      }
    })
  }

  app.post("/api/libraries/:id/scan", (c) => c.json(enqueueScan(Number(c.req.param("id")))))

  app.post("/api/libraries/scan-all", (c) => c.json(repo.listLibraries().map((l) => enqueueScan(l.id))))

  // Read-only folder browser for picking library roots.
  app.get("/api/fs/browse", async (c) => {
    const requested = c.req.query("path") || os.homedir()
    const dir = path.resolve(requested.replace(/^~(?=$|[\\/])/, os.homedir()))
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      const s = settingsNow()
      const exts = new Set(s.scanner.extensions)
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
      const audioCount = entries.filter((e) => e.isFile() && exts.has(path.extname(e.name).slice(1).toLowerCase())).length
      const parent = path.dirname(dir)
      return c.json({ path: dir, parent: parent === dir ? null : parent, dirs, audioCount })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  // ---- tracks ----
  app.get("/api/tracks", (c) => c.json(repo.queryTracks(parseQuery(c))))

  app.get("/api/tracks/:id", (c) => {
    const t = repo.getTrack(Number(c.req.param("id")))
    if (!t) return c.json({ error: "Not found" }, 404)
    return c.json(t)
  })

  app.patch("/api/tracks/:id", async (c) => {
    const id = Number(c.req.param("id"))
    const t = repo.getTrack(id)
    if (!t) return c.json({ error: "Not found" }, 404)
    const body = await c.req.json<{ final?: Partial<FinalMeta>; note?: string; bpm?: number | null; key?: string | null }>()
    const s = settingsNow()
    const final = body.final ? sanitizeFinal(body.final) : t.final
    const next = { ...t, final }
    const extras: Partial<Track> = {}
    if ("bpm" in body) extras.bpm = sanitizeBpm(body.bpm)
    if ("key" in body) extras.key = parseKey(body.key)
    repo.updateTrack(id, { final, note: body.note ?? t.note, proposedName: proposedFilename(next, s), ...extras })
    return c.json(repo.getTrack(id))
  })

  app.post("/api/tracks/:id/approve", async (c) => {
    const id = Number(c.req.param("id"))
    const t = repo.getTrack(id)
    if (!t) return c.json({ error: "Not found" }, 404)
    const body = await c.req.json<{ final?: Partial<FinalMeta>; learn?: boolean }>().catch(() => ({}) as { final?: Partial<FinalMeta>; learn?: boolean })
    const s = settingsNow()
    const final = body.final ? sanitizeFinal(body.final) : t.final ?? (t.decision ? sanitizeFinal(t.decision) : null)
    if (!final?.title || !final.artists.length) return c.json({ error: "Need at least an artist and a title" }, 400)
    const learn = body.learn !== false
    const undoId = snapshot("Approve", [id], learn ? [t.filename] : [])
    const next = { ...t, final }
    repo.updateTrack(id, { final, status: "approved", proposedName: proposedFilename(next, s) })
    // Learn from the human: store as a few-shot example for the AI and as a known artist.
    if (learn) repo.addCorrection(t.filename, final.artists, final.title, final.version)
    return c.json({ ...repo.getTrack(id), undoId })
  })

  app.post("/api/tracks/bulk", async (c) => {
    const body = await c.req.json<Selection & { action: "approve" | "reject" | "reset" | "unapprove" }>()
    const ids = resolveIds(body)
    const s = settingsNow()
    const undoId = snapshot(body.action, ids)
    let changed = 0
    let skipped = 0
    for (const id of ids) {
      const t = repo.getTrack(id)
      if (!t) continue
      if (body.action === "approve") {
        const final = t.final ?? (t.decision?.title && t.decision.artists.length ? sanitizeFinal(t.decision) : null)
        if (!final || t.status === "done") {
          skipped++
          continue
        }
        repo.updateTrack(id, { final, status: "approved", proposedName: proposedFilename({ ...t, final }, s) })
      } else if (body.action === "reject") {
        repo.updateTrack(id, { status: "rejected" })
      } else if (body.action === "unapprove") {
        repo.updateTrack(id, { status: t.decision?.status ?? "new", final: null })
      } else if (body.action === "reset") {
        repo.updateTrack(id, { ai: null, candidates: null, decision: null, final: null, confidence: null, proposedName: null, status: "new", note: null })
      }
      changed++
    }
    return c.json({ changed, skipped, undoId })
  })

  // Set the same fields on many tracks at once (album, label, genre, BPM…).
  app.post("/api/tracks/bulk-edit", async (c) => {
    const body = await c.req.json<Selection & { changes: BulkChanges }>()
    const ids = resolveIds(body)
    const changes = body.changes ?? {}
    const metaKeys = META_FIELDS.filter((k) => k in changes)
    if (!ids.length) return c.json({ error: "Nothing selected" }, 400)
    if (!metaKeys.length && !("bpm" in changes) && !("key" in changes)) return c.json({ error: "Nothing to change" }, 400)
    if (metaKeys.includes("artists") && !changes.artists?.length) return c.json({ error: "Artists can't be blank" }, 400)
    const s = settingsNow()
    const undoId = snapshot("Edit", ids)
    let changed = 0
    let skipped = 0
    for (const id of ids) {
      const t = repo.getTrack(id)
      if (!t) continue
      const patch: Partial<Track> = {}
      if (metaKeys.length) {
        const base = currentMeta(t)
        if (!base?.title || !(base.artists?.length || changes.artists?.length)) {
          skipped++
        } else {
          const merged: Partial<FinalMeta> = { ...base }
          for (const k of metaKeys) (merged as Record<string, unknown>)[k] = changes[k] ?? undefined
          const final = sanitizeFinal(merged)
          patch.final = final
          patch.proposedName = proposedFilename({ ...t, final }, s)
        }
      }
      if ("bpm" in changes) patch.bpm = sanitizeBpm(changes.bpm)
      if ("key" in changes) patch.key = parseKey(changes.key)
      if (Object.keys(patch).length) {
        repo.updateTrack(id, patch)
        changed++
      }
    }
    emit({ type: "tracks", ids })
    return c.json({ changed, skipped, undoId })
  })

  app.post("/api/undo/:id", (c) => {
    const done = restore(c.req.param("id"))
    if (!done) return c.json({ error: "That can't be undone any more" }, 410)
    emit({ type: "tracks", ids: done.ids })
    emit({ type: "stats" })
    return c.json({ restored: done.ids.length, label: done.label })
  })

  // Tracks that mix well after this one (Camelot key and tempo).
  app.get("/api/tracks/:id/mixes", (c) => {
    const t = repo.getTrack(Number(c.req.param("id")))
    if (!t) return c.json({ error: "Not found" }, 404)
    const hits = mixSuggestionIds(t)
    const byId = new Map(repo.summariesById(hits.map((h) => h.id)).map((s) => [s.id, s]))
    return c.json(hits.flatMap(({ id, ...rest }) => (byId.has(id) ? [{ ...rest, track: byId.get(id)! }] : [])))
  })

  app.post("/api/tracks/:id/rescore", (c) => {
    const t = repo.getTrack(Number(c.req.param("id")))
    if (!t) return c.json({ error: "Not found" }, 404)
    return c.json(scoreAndSave(t, settingsNow()))
  })

  app.get("/api/tracks/:id/audio", async (c) => {
    const t = repo.getTrack(Number(c.req.param("id")))
    if (!t || !fs.existsSync(t.path)) return c.json({ error: "Not found" }, 404)
    const size = fs.statSync(t.path).size
    const type = AUDIO_MIME[t.ext] ?? "application/octet-stream"
    const range = c.req.header("range")?.match(/bytes=(\d*)-(\d*)/)
    if (range) {
      const start = range[1] ? Number(range[1]) : 0
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : Math.min(start + 2 * 1024 * 1024, size - 1)
      if (start >= size) return c.body(null, 416, { "content-range": `bytes */${size}` })
      const stream = Readable.toWeb(fs.createReadStream(t.path, { start, end })) as ReadableStream
      return c.body(stream, 206, {
        "content-type": type,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
      })
    }
    const stream = Readable.toWeb(fs.createReadStream(t.path)) as ReadableStream
    return c.body(stream, 200, { "content-type": type, "content-length": String(size), "accept-ranges": "bytes" })
  })

  // ---- artwork ----
  app.get("/api/tracks/:id/art", async (c) => {
    const t = repo.getTrack(Number(c.req.param("id")))
    const ref = c.req.query("which") === "found" ? t?.artFound : t?.art
    if (!t || !ref) return c.json({ error: "No artwork" }, 404)
    const img = await thumbnail(t, ref, Number(c.req.query("size")) || 160)
    if (!img) return c.json({ error: "Artwork unavailable" }, 404)
    // The URL carries the picture's hash, so a cached copy never goes stale.
    return c.body(img.body as Uint8Array<ArrayBuffer>, 200, { "content-type": img.mime, "cache-control": "private, max-age=31536000, immutable" })
  })

  app.post("/api/tracks/:id/artwork/find", async (c) => {
    const t = repo.getTrack(Number(c.req.param("id")))
    if (!t) return c.json({ error: "Not found" }, 404)
    const art = await findArtwork(t, settingsNow())
    if (!art) return c.json({ error: "No artwork found for this track" }, 404)
    repo.updateTrack(t.id, { artFound: art.hash === t.art?.hash ? null : art })
    return c.json(repo.getTrack(t.id))
  })

  app.delete("/api/tracks/:id/artwork/found", (c) => {
    const id = Number(c.req.param("id"))
    if (!repo.getTrack(id)) return c.json({ error: "Not found" }, 404)
    repo.updateTrack(id, { artFound: null })
    return c.json(repo.getTrack(id))
  })

  app.post("/api/artwork", async (c) => {
    const body = await c.req.json<Selection & { force?: boolean }>()
    const ids = resolveIds(body, { status: ["matched", "review", "conflict", "approved"] })
    if (!ids.length) return c.json({ error: "Nothing to look up" }, 400)
    return c.json(enqueueJob("artwork", `Find artwork for ${ids.length} track${ids.length === 1 ? "" : "s"}`, (ctx) => artworkTracks(ids, settingsNow(), { force: !!body.force }, ctx)))
  })

  // ---- API tokens (a browser session only: tokens can't make tokens) ----
  app.get("/api/tokens", (c) => c.json(tokens.listTokens()))

  app.post("/api/tokens", async (c) => {
    const body = await c.req.json<{ name?: string; scope?: string }>().catch(() => ({}) as { name?: string; scope?: string })
    try {
      return c.json(tokens.createToken(body.name ?? "", body.scope === "full" ? "full" : "hooks"))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.delete("/api/tokens/:id", (c) => (tokens.deleteToken(Number(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "No such token" }, 404)))

  // ---- download tools ----
  /** "This finished downloading": scan the library it's in and identify what's new. */
  app.post("/api/hooks/import", async (c) => {
    const type = c.req.header("content-type") ?? ""
    const body: unknown = type.includes("json")
      ? await c.req.json().catch(() => null)
      : type.includes("form")
        ? await c.req.parseBody().catch(() => null)
        : await c.req.text().catch(() => "")
    const req = readHook(body, c.req.query(), c.req.header("user-agent"))
    const who = c.get("token")?.name ?? "Signed-in browser"
    const res = runHook(req, settingsNow().hooks.pathMap, who)
    if (req.test) return c.json({ ok: true, test: true, ...res })
    if (!res.queued.length) return c.json({ error: res.ignored[0]?.reason ?? 'No path given - send {"path": "/where/it/downloaded"}', ...res }, 422)
    log("info", `${req.from} (${who}): new downloads in ${res.queued.map((l) => l.name).join(", ")} - scanning shortly`)
    return c.json({ ok: true, ...res }, 202)
  })

  app.get("/api/hooks/recent", (c) => c.json(recentHookCalls()))

  // ---- uploads ----
  /** The file's bytes as the body; ?library=&name= (and optionally &dir=). */
  app.put("/api/upload", async (c) => {
    const lib = repo.getLibrary(Number(c.req.query("library")))
    if (!lib) return c.json({ error: "Choose a library to upload into" }, 400)
    try {
      const result = await saveUpload({
        lib,
        name: c.req.query("name") ?? "",
        dir: c.req.query("dir"),
        body: c.req.raw.body,
        size: Number(c.req.header("content-length")) || undefined,
        settings: settingsNow(),
      })
      scanSoon(lib.id, `Uploaded files in ${lib.name}`)
      return c.json(result)
    } catch (err) {
      if (err instanceof UploadError) return c.json({ error: err.message }, err.status)
      throw err
    }
  })

  /** Sharing to the installed app lands here only without its service worker (which handles it): say so. */
  app.post("/share", (c) => c.redirect("/upload?shared=0", 303))

  // ---- lyrics ----
  app.post("/api/lyrics", async (c) => {
    const body = await c.req.json<Selection & { force?: boolean }>()
    const ids = resolveIds(body, { status: ["matched", "review", "conflict", "approved", "done"] })
    if (!ids.length) return c.json({ error: "Nothing to look up" }, 400)
    return c.json(enqueueJob("lyrics", `Find lyrics for ${ids.length} track${ids.length === 1 ? "" : "s"}`, (ctx) => lyricsTracks(ids, { force: !!body.force }, ctx)))
  })

  /** Look again now (and wait for it), or turn down the words found. */
  app.post("/api/tracks/:id/lyrics", async (c) => {
    const t = repo.getTrack(Number(c.req.param("id")))
    if (!t) return c.json({ error: "Track not found" }, 404)
    const body = await c.req.json<{ action: "find" | "reject" }>().catch(() => ({ action: "find" as const }))
    if (body.action === "reject") {
      if (!t.lyrics) return c.json({ error: "No lyrics to turn down" }, 400)
      repo.updateTrack(t.id, { lyrics: { ...t.lyrics, rejected: true } })
    } else {
      try {
        const found = await lyricsForTrack(t, undefined, true)
        if (!found) return c.json({ error: "Approve an artist and title first" }, 400)
      } catch (err) {
        return c.json({ error: `LRCLIB didn't answer: ${err instanceof Error ? err.message : err}` }, 502)
      }
    }
    emit({ type: "tracks", ids: [t.id] })
    return c.json(repo.getTrack(t.id))
  })

  // ---- BPM & key ----
  app.post("/api/analyze", async (c) => {
    const body = await c.req.json<Selection & { force?: boolean }>()
    const ids = resolveIds(body)
    if (!ids.length) return c.json({ error: "Nothing to analyse" }, 400)
    return c.json(enqueueJob("analyze", `Analyse BPM & key of ${ids.length} track${ids.length === 1 ? "" : "s"}`, (ctx) => analyzeTracks(ids, settingsNow(), { force: !!body.force }, ctx)))
  })

  // ---- pipeline ----
  app.post("/api/process", async (c) => {
    const body = await c.req.json<Selection & { interpret?: boolean; scour?: boolean; force?: boolean }>()
    const ids = resolveIds(body, { status: ["new", "interpreted", "scoured"] })
    if (!ids.length) return c.json({ error: "Nothing to process" }, 400)
    const opts = { interpret: body.interpret !== false, scour: body.scour !== false, force: !!body.force }
    const what = [opts.interpret && "interpret", opts.scour && "scour", "score"].filter(Boolean).join(" → ")
    return c.json(enqueueJob("process", `${what} ${ids.length} track${ids.length === 1 ? "" : "s"}`, (ctx) => processTracks(ids, settingsNow(), opts, ctx)))
  })

  app.post("/api/rescore", async (c) => {
    const body = await c.req.json<Selection>().catch(() => ({}) as Selection)
    const ids = resolveIds(body, { status: ["scoured", "matched", "review", "conflict", "unmatched", "interpreted"] })
    return c.json(enqueueJob("score", `Re-score ${ids.length} tracks`, (ctx) => rescoreTracks(ids, settingsNow(), ctx)))
  })

  app.post("/api/plan", async (c) => {
    const body = await c.req.json<Selection>().catch(() => ({}) as Selection)
    const ids = resolveIds(body, { status: ["approved"] })
    return c.json(buildPlan(repo.getTracks(ids), settingsNow()))
  })

  app.post("/api/execute", async (c) => {
    const body = await c.req.json<Selection & { dryRun?: boolean }>()
    const s = settingsNow()
    const dryRun = !!body.dryRun
    if (s.safety.readOnly && !dryRun) return c.json({ error: "Read-only mode is on. Turn it off in Settings → Safety to write files." }, 409)
    const ids = resolveIds(body, { status: ["approved"] })
    const plan = buildPlan(repo.getTracks(ids), s)
    const runnable = plan.filter((p) => !p.blocked).length
    if (!runnable) return c.json({ error: "Nothing runnable in this plan" }, 400)
    return c.json(
      enqueueJob("execute", `${dryRun ? "Dry run" : "Rename & tag"} ${runnable} files`, async (ctx) => {
        const settings = settingsNow()
        // Lyrics for readings edited since they were looked up, so what's written fits.
        const looked = await topUpLyrics(repo.getTracks(ids), settings, ctx)
        const batchId = await executePlan(looked ? buildPlan(repo.getTracks(ids), settings) : plan, settings, { dryRun }, ctx)
        ctx.log("success", `${dryRun ? "Dry run" : "Batch"} ${batchId.slice(0, 8)} complete - ${ctx.job.done} ok, ${ctx.job.failed} failed`)
      })
    )
  })

  app.get("/api/operations/batches", (c) => c.json(repo.listBatches()))
  app.get("/api/operations", (c) => c.json(repo.listOperations(c.req.query("batchId") || undefined)))

  app.post("/api/rewind", async (c) => {
    const body = await c.req.json<{ batchId?: string; opIds?: number[] }>()
    if (!body.batchId && !body.opIds?.length) return c.json({ error: "Nothing to rewind" }, 400)
    if (settingsNow().safety.readOnly) return c.json({ error: "Read-only mode is on - turn it off to rewind." }, 409)
    return c.json(enqueueJob("rewind", `Rewind ${body.batchId ? `batch ${body.batchId.slice(0, 8)}` : `${body.opIds!.length} operations`}`, (ctx) => rewind(body.opIds ?? null, body.batchId ?? null, ctx)))
  })

  // ---- jobs ----
  app.get("/api/jobs", (c) => c.json({ active: activeJobs(), recent: listJobs() }))
  app.post("/api/jobs/:id/cancel", (c) => c.json({ ok: cancelJob(c.req.param("id")) }))

  // ---- settings ----
  app.get("/api/settings", (c) => c.json(publicSettings()))
  app.put("/api/settings", async (c) => {
    const patch = await c.req.json<Partial<Settings>>()
    saveSettings(patch)
    return c.json(publicSettings())
  })

  // ---- AI ----
  app.get("/api/llm/models", async (c) => {
    const p = settingsNow().llm.providers.find((x) => x.id === c.req.query("provider"))
    if (!p) return c.json({ error: "Unknown provider" }, 404)
    try {
      return c.json({ models: await listModels(p) })
    } catch (err) {
      return c.json({ models: [], error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get("/api/llm/usage", (c) => c.json(usageReport(settingsNow())))

  app.post("/api/llm/test", async (c) => {
    const { providerId } = await c.req.json<{ providerId: string }>()
    const p = settingsNow().llm.providers.find((x) => x.id === providerId)
    if (!p) return c.json({ error: "Unknown provider" }, 404)
    return c.json(await testProvider(p))
  })

  // Playground: parse any filename with the rule-based parser and (optionally) the AI.
  app.post("/api/playground", async (c) => {
    const { filename, ai } = await c.req.json<{ filename: string; ai?: boolean }>()
    const known = repo.knownArtists()
    const heuristic = parseFilename(filename, { knownArtists: known })
    if (!ai) return c.json({ heuristic })
    const s = settingsNow()
    const fake = {
      id: 0,
      filename,
      relDir: "",
      tags: {},
      duration: null,
      heuristic,
    } as unknown as Parameters<typeof interpretTrack>[0]
    try {
      const result = await interpretTrack(fake, s, { corrections: repo.listCorrections(), aliases: repo.aliasMap() })
      return c.json({ heuristic, ai: result })
    } catch (err) {
      return c.json({ heuristic, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ---- sources ----
  app.get("/api/sources", (c) => c.json(sourceStatus(settingsNow())))

  app.post("/api/sources/test", async (c) => {
    const { id, artist, title } = await c.req.json<{ id: string; artist: string; title: string }>()
    const s = settingsNow()
    const entry = allAdapters(s).find((a) => a.adapter.id === id)
    if (!entry) return c.json({ error: "Unknown source" }, 404)
    const reason = entry.adapter.unavailable({ cfg: entry.cfg, settings: s })
    if (reason && id !== "acoustid") return c.json({ error: `${entry.adapter.label} ${reason}` }, 400)
    const reading = { artists: artist ? [artist] : [], featuring: [], title }
    const q = buildQuery({ path: "", duration: null } as never, reading)
    const started = Date.now()
    try {
      const candidates = await entry.adapter.search(q, { cfg: entry.cfg, settings: s })
      return c.json({ candidates, ms: Date.now() - started })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), ms: Date.now() - started })
    }
  })

  app.get("/api/sources/discogs-collection", (c) => c.json(collectionStatus()))
  app.post("/api/sources/discogs-collection/sync", (c) => {
    if (!settingsNow().sources.discogs?.apiKey) return c.json({ error: "Add your Discogs personal access token first" }, 400)
    return c.json(enqueueJob("sync", "Sync your Discogs collection", (ctx) => syncCollection(settingsNow(), ctx)))
  })

  app.post("/api/scrapers/test", async (c) => {
    const { definition, query } = await c.req.json<{ definition: ScraperDefinition; query: string }>()
    try {
      const r = await runScraper(definition, { query, artist: query, title: query })
      return c.json(r)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), candidates: [], itemCount: 0 })
    }
  })

  app.post("/api/cache/clear", (c) => c.json({ cleared: clearHttpCache() }))

  // ---- learning: aliases & corrections ----
  app.get("/api/aliases", (c) => c.json(repo.listAliases()))
  app.post("/api/aliases", async (c) => {
    const { alias, canonical } = await c.req.json<{ alias: string; canonical: string }>()
    if (!normArtist(alias) || !canonical?.trim()) return c.json({ error: "Alias and canonical name are required" }, 400)
    repo.upsertAlias(alias, canonical)
    return c.json(repo.listAliases())
  })
  app.delete("/api/aliases/:id", (c) => {
    repo.deleteAlias(Number(c.req.param("id")))
    return c.json({ ok: true })
  })
  app.get("/api/corrections", (c) => c.json(repo.listCorrections()))
  app.delete("/api/corrections/:id", (c) => {
    repo.deleteCorrection(Number(c.req.param("id")))
    return c.json({ ok: true })
  })

  // ---- smart crates ----
  app.get("/api/crates", (c) => c.json(listCrates()))
  app.get("/api/crates/facets", (c) => c.json(crateFacets(c.req.query("libraryId") ? Number(c.req.query("libraryId")) : undefined)))
  app.post("/api/crates/preview", async (c) => {
    const { rules } = await c.req.json<{ rules: unknown }>()
    return c.json(repo.queryTracks({ rules: cleanRules(rules), limit: 8, sort: "updated", dir: "desc" }))
  })
  app.post("/api/crates", async (c) => {
    const body = await c.req.json<{ name?: string; rules?: unknown }>()
    try {
      return c.json(createCrate(body.name, body.rules))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })
  app.get("/api/crates/:id", (c) => {
    const crate = getCrate(Number(c.req.param("id")))
    return crate ? c.json(crate) : c.json({ error: "No such crate" }, 404)
  })
  app.patch("/api/crates/:id", async (c) => {
    const body = await c.req.json<{ name?: string; rules?: unknown }>()
    try {
      const crate = updateCrate(Number(c.req.param("id")), body)
      return crate ? c.json(crate) : c.json({ error: "No such crate" }, 404)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })
  app.delete("/api/crates/:id", (c) => {
    deleteCrate(Number(c.req.param("id")))
    return c.json({ ok: true })
  })

  // ---- duplicates ----
  app.get("/api/duplicates", (c) => c.json({ groups: duplicateGroups(), setAside: setAsideCount(), holdingFolder: settingsNow().duplicates.holdingFolder }))

  app.post("/api/duplicates/resolve", async (c) => {
    const body = await c.req.json<{ groups: Resolution[] }>()
    const s = settingsNow()
    if (s.safety.readOnly) return c.json({ error: "Read-only mode is on - turn it off to move files." }, 409)
    const resolutions = validResolutions(body.groups ?? [])
    const n = resolutions.reduce((a, r) => a + r.aside.length, 0)
    if (!n) return c.json({ error: "Nothing to set aside" }, 400)
    return c.json(enqueueJob("duplicates", `Set aside ${n} duplicate${n === 1 ? "" : "s"}`, (ctx) => setAside(resolutions, settingsNow(), ctx)))
  })

  // ---- organise ----
  app.post("/api/organise/preview", async (c) => {
    const body = await c.req.json<OrganiseRequest>()
    try {
      return c.json(planOrganise(settingsNow(), body).preview)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post("/api/organise", async (c) => {
    const body = await c.req.json<OrganiseRequest>()
    const s = settingsNow()
    if (s.safety.readOnly) return c.json({ error: "Read-only mode is on - turn it off to move files." }, 409)
    const lib = repo.getLibrary(Number(body.libraryId))
    if (!lib) return c.json({ error: "Library not found" }, 404)
    return c.json(enqueueJob("organise", `Organise ${lib.name}`, (ctx) => executeOrganise(settingsNow(), body, ctx)))
  })

  // ---- backup ----
  app.get("/api/backup", (c) => {
    const backup = makeBackup({ secrets: c.req.query("secrets") === "1" })
    const day = backup.exportedAt.slice(0, 10)
    return c.body(JSON.stringify(backup, null, 2), 200, { "content-type": "application/json", "content-disposition": `attachment; filename="dubplate-backup-${day}.json"` })
  })

  app.post("/api/restore", async (c) => {
    const body = await c.req.json<{ backup: unknown; parts?: { settings?: boolean; learnings?: boolean; libraries?: boolean; crates?: boolean } }>()
    if (!isBackup(body.backup)) return c.json({ error: "That isn't a Dubplate backup file" }, 400)
    const result = restoreBackup(body.backup, {
      settings: body.parts?.settings !== false,
      learnings: body.parts?.learnings !== false,
      libraries: body.parts?.libraries !== false,
      crates: body.parts?.crates !== false,
    })
    syncWatchers()
    emit({ type: "stats" })
    return c.json(result)
  })

  // ---- integrations ----
  /** A draft from the settings page: masked secrets mean "the one already saved". */
  app.post("/api/integrations/media-server/test", async (c) => {
    const { server } = await c.req.json<{ server: MediaServerConfig }>()
    const saved = settingsNow().integrations.mediaServers.find((m) => m.id === server.id)
    const token = !server.token || isMasked(server.token) ? saved?.token : server.token
    return c.json(await testMediaServer({ ...server, url: (server.url ?? "").trim().replace(/\/+$/, ""), token }))
  })

  app.post("/api/integrations/chat/test", async (c) => {
    const { channel, integrations } = await c.req.json<{ channel: ChatChannel; integrations: Settings["integrations"] }>()
    const s = settingsNow()
    const draft = structuredClone(s)
    const d = integrations?.discord ?? s.integrations.discord
    const t = integrations?.telegram ?? s.integrations.telegram
    draft.integrations.discord = { enabled: true, webhookUrl: !d.webhookUrl || isMasked(d.webhookUrl) ? s.integrations.discord.webhookUrl : d.webhookUrl.trim() }
    draft.integrations.telegram = { enabled: true, chatId: t.chatId?.trim(), botToken: !t.botToken || isMasked(t.botToken) ? s.integrations.telegram.botToken : t.botToken.trim() }
    draft.integrations.publicUrl = (integrations?.publicUrl ?? s.integrations.publicUrl ?? "").trim().replace(/\/+$/, "")
    const [r] = await sendChat(draft, { title: "Dubplate is connected", lines: ["Messages about finished jobs and tracks to review will arrive here."], link: { label: "Open Dubplate", path: "/" }, tone: "ok" }, channel)
    return c.json(r ?? { channel, ok: false, message: channel === "discord" ? "Needs a webhook URL" : "Needs a bot token and a chat ID" })
  })

  // ---- DJ software ----
  app.post("/api/export/dj", async (c) => {
    const body = await c.req.json<Selection & { format?: DjFormat; name?: string; crateIds?: number[]; pathMap?: PathMapping[]; traktorVolume?: string }>()
    const s = settingsNow()
    const format: DjFormat = body.format === "rekordbox" || body.format === "traktor" || body.format === "serato" ? body.format : "m3u"
    const playlists: Playlist[] = body.crateIds?.length
      ? body.crateIds.flatMap((id) => {
          const crate = getCrate(Number(id))
          return crate ? [{ name: crate.name, tracks: repo.getTracks(repo.queryTrackIds({ crateId: crate.id })) }] : []
        })
      : [{ name: body.name?.trim() || "Dubplate", tracks: repo.getTracks(resolveIds(body)).filter((t) => !t.missing) }]
    if (!playlists.some((p) => p.tracks.length)) return c.json({ error: "Nothing to export" }, 400)
    const file = exportPlaylists(format, playlists, {
      pathMap: Array.isArray(body.pathMap) ? body.pathMap.filter((m) => m?.from?.trim()) : s.exports.pathMap,
      traktorVolume: body.traktorVolume?.trim() || s.exports.traktorVolume,
      naming: s.naming,
    })
    const ascii = file.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")
    return c.body(file.body as Uint8Array<ArrayBuffer> | string, 200, {
      "content-type": file.contentType,
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    })
  })

  // ---- reports ----

  app.get("/api/export", (c) => {
    const q = parseQuery(c)
    const ids = repo.queryTrackIds({ ...q, limit: undefined })
    const tracks = repo.getTracks(ids)
    const rows = tracks.map((t) => ({
      id: t.id,
      path: t.path,
      original_path: t.originalPath,
      filename: t.filename,
      status: t.status,
      confidence: t.confidence ?? "",
      artist: (t.final ?? t.decision)?.artists?.join(" & ") ?? "",
      title: (t.final ?? t.decision)?.title ?? "",
      version: (t.final ?? t.decision)?.version ?? "",
      proposed_name: t.proposedName ?? "",
      sources: t.decision?.clusters[0]?.sources.join(" ") ?? "",
    }))
    if (c.req.query("format") === "json") {
      return c.body(JSON.stringify(rows, null, 2), 200, { "content-type": "application/json", "content-disposition": 'attachment; filename="dubplate-report.json"' })
    }
    const cols = Object.keys(rows[0] ?? { id: "" })
    const esc = (v: unknown) => {
      const s = String(v ?? "")
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = [cols.join(","), ...rows.map((r) => cols.map((k) => esc((r as Record<string, unknown>)[k])).join(","))].join("\n")
    return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="dubplate-report.csv"' })
  })

  return app
}
