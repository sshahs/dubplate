import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { FinalMeta, ScraperDefinition, ServerEvent, Settings, TrackStatus } from "../shared/types"
import { TRACK_STATUSES } from "../shared/types"
import { activeProvider, interpretTrack } from "./ai/interpreter"
import { listModels, testProvider } from "./ai/providers"
import { config, VERSION } from "./config"
import { parseFilename } from "./core/filename-parser"
import { normArtist } from "./core/normalize"
import { buildPlan, executePlan, proposedFilename, rewind } from "./executor"
import { activeJobs, cancelJob, enqueueJob, listJobs, recentLogEvents, subscribe } from "./jobs"
import { processTracks, rescoreTracks, scoreAndSave } from "./pipeline"
import * as repo from "./repo"
import { scanLibrary } from "./scanner"
import { effectiveSettings, publicSettings, saveSettings } from "./settings"
import { findFpcalc } from "./sources/acoustid"
import { clearHttpCache, setContact } from "./sources/http"
import { allAdapters, buildQuery, sourceStatus } from "./sources"
import { runScraper } from "./sources/scraper"

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

function settingsNow(): Settings {
  const s = effectiveSettings()
  setContact(s.contact)
  return s
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
    sort: (q.sort as repo.TrackQuery["sort"]) || undefined,
    dir: q.dir === "desc" ? "desc" : "asc",
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
  }
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

export function createApp() {
  const app = new Hono()

  // ---- local-app security: DNS-rebinding + CSRF guards ----
  app.use("/api/*", async (c, next) => {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
    const okHosts = new Set(["localhost", "127.0.0.1", "::1", config.host, ...config.allowedHosts])
    if (host && !okHosts.has(host) && !config.allowedHosts.includes("*")) {
      return c.json({ error: `Host "${host}" not allowed — add it to DUBPLATE_ALLOWED_HOSTS` }, 403)
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-dubplate") !== "1") {
      return c.json({ error: "Missing X-Dubplate header" }, 403)
    }
    await next()
  })

  app.onError((err, c) => {
    console.error(err)
    return c.json({ error: err.message }, 500)
  })

  // ---- health, events, stats ----
  app.get("/api/health", (c) => {
    const s = settingsNow()
    const p = activeProvider(s)
    return c.json({
      version: VERSION,
      dataDir: config.dataDir,
      readOnly: s.safety.readOnly,
      fpcalc: !!findFpcalc(),
      llm: p ? { id: p.id, label: p.label, model: p.model, kind: p.kind } : null,
    })
  })

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
    const body = await c.req.json<{ path: string; name?: string; scan?: boolean }>()
    const p = path.resolve(body.path.replace(/^~(?=$|[\\/])/, os.homedir()))
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return c.json({ error: "That folder doesn't exist" }, 400)
    const overlapping = repo.listLibraries().find((l) => p.startsWith(l.path + path.sep) || l.path.startsWith(p + path.sep) || l.path === p)
    if (overlapping) return c.json({ error: `Overlaps with library "${overlapping.name}"` }, 400)
    const lib = repo.addLibrary(p, body.name?.trim() || path.basename(p))
    if (body.scan !== false) enqueueScan(lib.id)
    return c.json(lib)
  })

  app.delete("/api/libraries/:id", (c) => {
    repo.removeLibrary(Number(c.req.param("id")))
    return c.json({ ok: true })
  })

  function enqueueScan(id: number) {
    const lib = repo.getLibrary(id)
    if (!lib) throw new Error("Library not found")
    return enqueueJob("scan", `Scan ${lib.name}`, (ctx) => scanLibrary(lib, settingsNow(), ctx))
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
    const body = await c.req.json<{ final?: Partial<FinalMeta>; note?: string }>()
    const s = settingsNow()
    const final = body.final ? sanitizeFinal(body.final) : t.final
    const next = { ...t, final }
    repo.updateTrack(id, { final, note: body.note ?? t.note, proposedName: proposedFilename(next, s) })
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
    const next = { ...t, final }
    repo.updateTrack(id, { final, status: "approved", proposedName: proposedFilename(next, s) })
    // Learn from the human: store as a few-shot example for the AI and as a known artist.
    if (body.learn !== false) repo.addCorrection(t.filename, final.artists, final.title, final.version)
    return c.json(repo.getTrack(id))
  })

  app.post("/api/tracks/bulk", async (c) => {
    const body = await c.req.json<Selection & { action: "approve" | "reject" | "reset" | "unapprove" }>()
    const ids = resolveIds(body)
    const s = settingsNow()
    let changed = 0
    for (const id of ids) {
      const t = repo.getTrack(id)
      if (!t) continue
      if (body.action === "approve") {
        const final = t.final ?? (t.decision?.title && t.decision.artists.length ? sanitizeFinal(t.decision) : null)
        if (!final || t.status === "done") continue
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
    return c.json({ changed })
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
        const batchId = await executePlan(plan, settingsNow(), { dryRun }, ctx)
        ctx.log("success", `${dryRun ? "Dry run" : "Batch"} ${batchId.slice(0, 8)} complete — ${ctx.job.done} ok, ${ctx.job.failed} failed`)
      })
    )
  })

  app.get("/api/operations/batches", (c) => c.json(repo.listBatches()))
  app.get("/api/operations", (c) => c.json(repo.listOperations(c.req.query("batchId") || undefined)))

  app.post("/api/rewind", async (c) => {
    const body = await c.req.json<{ batchId?: string; opIds?: number[] }>()
    if (!body.batchId && !body.opIds?.length) return c.json({ error: "Nothing to rewind" }, 400)
    if (settingsNow().safety.readOnly) return c.json({ error: "Read-only mode is on — turn it off to rewind." }, 409)
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

  // ---- reports ----
  app.get("/api/duplicates", (c) => c.json(repo.duplicateGroups()))

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
