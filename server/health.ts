// Health checks: one look at everything Dubplate depends on - its data folder,
// the libraries, the AI, the metadata sources and the integrations - with what's
// wrong and where to put it right. Each check is quick and read-only; nothing
// is sent anywhere that would cost money or post a message.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { HealthCheck, HealthReport, Settings } from "../shared/types"
import { activeProvider } from "./ai/interpreter"
import { listModels } from "./ai/providers"
import { monthSpend } from "./ai/usage"
import { authEnabled } from "./auth"
import { config, VERSION } from "./config"
import { getDb } from "./db"
import { testMediaServer } from "./integrations/media-servers"
import { networkMessage } from "./net"
import { listLibraries, PROBLEMS_SQL } from "./repo"
import { SOURCE_META } from "./settings"
import { allAdapters } from "./sources"
import { findFpcalc } from "./sources/acoustid"
import { collectionStatus } from "./sources/discogs-collection"
import { findFfmpeg, findFfprobe } from "./media/ffmpeg"
import { videosToConvert } from "./videos"

const GB = 1024 ** 3
const TIMEOUT_MS = 10_000

/** Where to reach each built-in source, to see it answers at all. */
const PROBES: Record<string, string> = {
  musicbrainz: "https://musicbrainz.org/ws/2/",
  discogs: "https://api.discogs.com/",
  "discogs-collection": "https://api.discogs.com/",
  lastfm: "https://ws.audioscrobbler.com/2.0/",
  spotify: "https://api.spotify.com/v1/",
  itunes: "https://itunes.apple.com/",
  deezer: "https://api.deezer.com/",
  bandcamp: "https://bandcamp.com/",
  archive: "https://archive.org/",
  mixcloud: "https://api.mixcloud.com/",
  soundclashhub: "https://soundclashhub.com/api/sounds",
  whocorkthedance: "https://whocorkthedance.com/",
  youtube: "https://www.googleapis.com/",
  acoustid: "https://api.acoustid.org/",
}

function freeSpace(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}

const gb = (bytes: number) => (bytes >= 10 * GB ? `${Math.round(bytes / GB)} GB` : `${(bytes / GB).toFixed(1)} GB`)

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function serverChecks(settings: Settings): HealthCheck[] {
  const out: HealthCheck[] = []
  const free = freeSpace(config.dataDir)
  out.push(
    writable(config.dataDir)
      ? { id: "data", group: "Server", label: "Data folder", status: "ok", detail: `Writable: ${config.dataDir}` }
      : { id: "data", group: "Server", label: "Data folder", status: "error", detail: `Dubplate can't write to ${config.dataDir} - check its permissions (or the Docker volume).` }
  )
  if (free !== null) {
    out.push({
      id: "data-space",
      group: "Server",
      label: "Space for the database",
      status: free < 0.2 * GB ? "error" : free < GB ? "warn" : "ok",
      detail: `${gb(free)} free where the database lives.`,
    })
  }
  const failed = getDb()
    .prepare("SELECT label, message FROM jobs WHERE status = 'failed' AND finished_at >= datetime('now', '-1 day') ORDER BY finished_at DESC")
    .all() as { label: string; message: string | null }[]
  out.push(
    failed.length
      ? {
          id: "jobs",
          group: "Server",
          label: "Jobs in the last day",
          status: "warn",
          detail: `${failed.length} failed - the latest, "${failed[0].label}": ${failed[0].message ?? "no reason given"}`,
        }
      : { id: "jobs", group: "Server", label: "Jobs in the last day", status: "ok", detail: "None failed." }
  )
  const acoustidOn = settings.sources.acoustid?.enabled && !!settings.sources.acoustid.apiKey
  out.push(
    findFpcalc()
      ? { id: "fpcalc", group: "Server", label: "Audio fingerprinting (fpcalc)", status: "ok", detail: "Installed." }
      : {
          id: "fpcalc",
          group: "Server",
          label: "Audio fingerprinting (fpcalc)",
          status: acoustidOn ? "warn" : "info",
          detail: acoustidOn ? "AcoustID is set up but fpcalc (Chromaprint) isn't installed, so fingerprints are skipped." : "Not installed. Only needed for AcoustID fingerprints.",
        }
  )
  const waiting = videosToConvert()
  out.push(
    findFfmpeg() && findFfprobe()
      ? { id: "ffmpeg", group: "Server", label: "Converter (ffmpeg)", status: "ok", detail: "Installed: videos can be converted, and WMA and other formats browsers can't play are previewed as MP3." }
      : {
          id: "ffmpeg",
          group: "Server",
          label: "Converter (ffmpeg)",
          status: waiting ? "warn" : "info",
          detail: `${findFfmpeg() ? "ffprobe" : "ffmpeg"} isn't installed.${waiting ? ` ${waiting} video${waiting === 1 ? " is" : "s are"} waiting to be converted.` : ""} It pulls the audio out of videos and lets the browser preview WMA, APE and AIFF; it comes with the Docker image.`,
          fix: waiting ? { label: "Videos", to: "/videos" } : undefined,
        }
  )
  return out
}

function securityChecks(settings: Settings): HealthCheck[] {
  const local = ["127.0.0.1", "localhost", "::1"].includes(config.host)
  const out: HealthCheck[] = []
  if (authEnabled()) out.push({ id: "password", group: "Security", label: "Password", status: "ok", detail: "Set - only people who sign in can use Dubplate." })
  else if (local) out.push({ id: "password", group: "Security", label: "Password", status: "info", detail: "None set. Only this computer can reach Dubplate, so that's fine.", fix: { label: "Set one", to: "/settings#safety" } })
  else
    out.push({
      id: "password",
      group: "Security",
      label: "Password",
      status: "error",
      detail: `Dubplate listens on ${config.host}, so anyone who can reach port ${config.port} can rename and move your files. Set a password.`,
      fix: { label: "Set a password", to: "/settings#safety" },
    })
  out.push({
    id: "read-only",
    group: "Security",
    label: "Read-only mode",
    status: "info",
    detail: settings.safety.readOnly ? "On: nothing on disk changes (dry runs still work)." : "Off: Dubplate can rename, tag and move files.",
    fix: { label: "Change", to: "/settings#safety" },
  })
  return out
}

function libraryChecks(settings: Settings): HealthCheck[] {
  const libs = listLibraries()
  if (!libs.length) return [{ id: "libraries", group: "Libraries", label: "Libraries", status: "warn", detail: "No music folders yet.", fix: { label: "Add one", to: "/libraries" } }]
  return libs.flatMap((l): HealthCheck[] => {
    const id = `library-${l.id}`
    if (!l.exists) return [{ id, group: "Libraries", label: l.name, status: "error", detail: `${l.path} isn't there - a drive unplugged or a volume not mounted?`, fix: { label: "Libraries", to: "/libraries" } }]
    const canWrite = writable(l.path)
    const free = freeSpace(l.path)
    const bits = [
      canWrite ? "writable" : settings.safety.readOnly ? "read-only to Dubplate (fine while read-only mode is on)" : "Dubplate can't write here",
      free !== null ? `${gb(free)} free` : null,
      l.watch ? (l.watchState === "polling" ? "checked every few minutes (file events don't work here)" : "watched") : null,
      l.settings.handsOff ? "hands-off" : null,
      l.settings.inboxFor ? `inbox for ${libs.find((x) => x.id === l.settings.inboxFor)?.name ?? "a missing library"}` : null,
    ].filter(Boolean)
    const status = !canWrite && !settings.safety.readOnly ? "error" : free !== null && free < GB ? "warn" : "ok"
    return [{ id, group: "Libraries", label: l.name, status, detail: `${bits.join(" · ")}.`, fix: status === "ok" ? undefined : { label: "Libraries", to: "/libraries" } }]
  })
}

/** Files that are broken, cut short or named as the wrong format. */
function fileChecks(): HealthCheck[] {
  const db = getDb()
  const count = (where: string) => (db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE missing = 0 AND ${where}`).get() as { n: number }).n
  const any = count(PROBLEMS_SQL)
  if (!any) return []
  const broken = count(
    "(json_extract(analysis_json, '$.integrity.truncated') = 1 OR json_extract(analysis_json, '$.integrity.damagedAt') IS NOT NULL OR json_extract(file_check_json, '$.empty') = 1)"
  )
  const wrongExt = count("json_extract(file_check_json, '$.realExt') IS NOT NULL")
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
  const bits = [broken && `${n(broken, "file")} damaged or cut short`, wrongExt && `${n(wrongExt, "file")} with the wrong extension`].filter(Boolean)
  const rest = any - broken - wrongExt
  if (rest > 0) bits.push(`${n(rest, "other")} worth a look (long silences, unreadable tags)`)
  return [
    {
      id: "files",
      group: "Libraries",
      label: "Files",
      status: broken ? "warn" : "info",
      detail: `${bits.join(", ")}.${wrongExt ? " Cutting gives files their right extension." : ""}`,
      fix: { label: "Show them", to: "/tracks?problems=1" },
    },
  ]
}

async function aiChecks(settings: Settings): Promise<HealthCheck[]> {
  const out: HealthCheck[] = []
  const p = activeProvider(settings)
  if (!p) return [{ id: "ai", group: "AI", label: "AI provider", status: "warn", detail: "None switched on - names are read by the rule-based parser only.", fix: { label: "Choose one", to: "/settings#ai" } }]
  const label = `${p.label}${p.model ? ` · ${p.model}` : ""}`
  const needsKey = ["openai", "anthropic", "ollama-cloud", "commandcode"].includes(p.kind)
  if (!p.model) out.push({ id: "ai", group: "AI", label, status: "error", detail: "No model chosen.", fix: { label: "AI settings", to: "/settings#ai" } })
  else if (needsKey && !p.apiKey) out.push({ id: "ai", group: "AI", label, status: "error", detail: "Needs an API key.", fix: { label: "AI settings", to: "/settings#ai" } })
  else {
    try {
      // Listing models is free; a test prompt would cost tokens.
      const models = await Promise.race([listModels(p), new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), TIMEOUT_MS))])
      const known = models.length === 0 || models.some((m) => m === p.model || m.startsWith(`${p.model}:`) || p.model.startsWith(m))
      out.push(
        known
          ? { id: "ai", group: "AI", label, status: "ok", detail: "Reachable." }
          : { id: "ai", group: "AI", label, status: "warn", detail: `Reachable, but ${p.model} isn't among its models${p.kind === "ollama" ? ` - run "ollama pull ${p.model}"` : ""}.`, fix: { label: "AI settings", to: "/settings#ai" } }
      )
    } catch (err) {
      out.push({ id: "ai", group: "AI", label, status: "error", detail: networkMessage(err), fix: { label: "AI settings", to: "/settings#ai" } })
    }
  }
  // The second opinion and the cover check each need a model of their own.
  for (const [which, cfg] of [
    ["Second opinion", settings.llm.escalation],
    ["Cover check", settings.llm.vision],
  ] as const) {
    if (!cfg.enabled) continue
    const prov = settings.llm.providers.find((x) => x.id === cfg.providerId)
    if (!cfg.model || !prov) out.push({ id: `ai-${which}`, group: "AI", label: which, status: "warn", detail: !prov ? "Its provider no longer exists." : "No model chosen, so it's skipped.", fix: { label: "AI settings", to: "/settings#ai" } })
    else out.push({ id: `ai-${which}`, group: "AI", label: which, status: "info", detail: `${prov.label} · ${cfg.model}` })
  }
  const budget = settings.llm.monthlyBudget
  if (budget > 0) {
    const spent = monthSpend(settings)
    const c = settings.llm.currency
    out.push({
      id: "budget",
      group: "AI",
      label: "Monthly budget",
      status: spent >= budget ? "error" : spent >= budget * 0.8 ? "warn" : "ok",
      detail: `${c}${spent.toFixed(2)} of ${c}${budget.toFixed(2)} used this month${spent >= budget ? " - the AI is off until next month" : ""}.`,
      fix: { label: "Usage", to: "/settings#ai" },
    })
  }
  return out
}

async function probe(url: string): Promise<string | null> {
  try {
    await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) })
    return null
  } catch (err) {
    return networkMessage(err)
  }
}

async function sourceChecks(settings: Settings): Promise<HealthCheck[]> {
  const out: HealthCheck[] = []
  const enabled = allAdapters(settings).filter((a) => a.cfg.enabled)
  const skipped: string[] = []
  const urls = new Map<string, string[]>()
  for (const { adapter, cfg } of enabled) {
    const reason = adapter.unavailable({ cfg, settings })
    if (reason) {
      skipped.push(`${adapter.label} (${reason})`)
      continue
    }
    const scraper = settings.scrapers.find((s) => `scraper:${s.id}` === adapter.id)
    let url = PROBES[adapter.id]
    if (scraper) {
      try {
        url = new URL(scraper.searchUrl.replace(/\{\w+\}/g, "x")).origin + "/"
      } catch {
        out.push({ id: adapter.id, group: "Sources", label: adapter.label, status: "error", detail: "Its search address isn't a valid URL.", fix: { label: "Sources", to: "/sources" } })
        continue
      }
    }
    if (url) urls.set(url, [...(urls.get(url) ?? []), adapter.label])
  }
  const results = await Promise.all([...urls].map(async ([url, labels]) => ({ labels, error: await probe(url) })))
  const down = results.filter((r) => r.error)
  const up = results.filter((r) => !r.error).flatMap((r) => r.labels)
  if (up.length) out.push({ id: "sources-up", group: "Sources", label: "Reachable", status: "ok", detail: up.join(", ") })
  for (const r of down) out.push({ id: `down-${r.labels[0]}`, group: "Sources", label: r.labels.join(", "), status: "warn", detail: `Can't reach it: ${r.error}` })
  if (skipped.length) out.push({ id: "sources-skipped", group: "Sources", label: "Switched on but skipped", status: "info", detail: skipped.join("; "), fix: { label: "Sources", to: "/sources" } })
  if (!enabled.length) out.push({ id: "sources", group: "Sources", label: "Sources", status: "warn", detail: "Every source is switched off.", fix: { label: "Sources", to: "/sources" } })
  for (const sc of settings.scrapers.filter((x) => !x.enabled && x.disabledReason)) {
    out.push({ id: `scraper-off-${sc.id}`, group: "Sources", label: sc.name, status: "warn", detail: `${sc.disabledReason}. Test it and switch it back on once it works.`, fix: { label: "Sources", to: "/sources#scrapers" } })
  }
  if (settings.acoustid.submit && !settings.acoustid.userKey) {
    out.push({ id: "acoustid-submit", group: "Sources", label: "Sending to AcoustID", status: "warn", detail: "Switched on, but there's no AcoustID user key, so nothing is sent.", fix: { label: "Add it", to: "/sources#fingerprint" } })
  }
  if (settings.sources.musicbrainz?.enabled && !settings.contact.trim()) {
    out.push({ id: "contact", group: "Sources", label: "Contact for MusicBrainz", status: "warn", detail: "MusicBrainz asks every app for a contact address; without one it may slow or block requests.", fix: { label: "Add one", to: "/settings#safety" } })
  }
  const coll = collectionStatus()
  if (settings.sources["discogs-collection"]?.enabled && settings.sources.discogs?.apiKey && !coll.count) {
    out.push({ id: "collection", group: "Sources", label: SOURCE_META["discogs-collection"].label, status: "info", detail: "Not synced yet.", fix: { label: "Sync it", to: "/sources" } })
  }
  return out
}

async function integrationChecks(settings: Settings): Promise<HealthCheck[]> {
  const out: HealthCheck[] = []
  const servers = settings.integrations.mediaServers.filter((m) => m.enabled)
  const results = await Promise.all(servers.map(async (m) => ({ m, r: await testMediaServer(m) })))
  for (const { m, r } of results) {
    out.push({ id: `media-${m.id}`, group: "Integrations", label: m.name, status: r.ok ? "ok" : "error", detail: r.message, fix: r.ok ? undefined : { label: "Media servers", to: "/settings#servers" } })
  }
  const { discord, telegram, publicUrl } = settings.integrations
  const chats = [discord.enabled && discord.webhookUrl && "Discord", telegram.enabled && telegram.botToken && telegram.chatId && "Telegram"].filter(Boolean)
  if (chats.length) {
    out.push({
      id: "chat",
      group: "Integrations",
      label: chats.join(" & "),
      status: publicUrl ? "ok" : "info",
      detail: publicUrl ? "Set up (use Send test in Settings to check delivery)." : "Set up. Add Dubplate's address in Settings so messages link back to it.",
      fix: { label: "Notifications", to: "/settings#notifications" },
    })
  }
  if (!out.length) out.push({ id: "integrations", group: "Integrations", label: "Integrations", status: "info", detail: "No media servers or chat apps set up.", fix: { label: "Set one up", to: "/settings#servers" } })
  return out
}

function dbSize(): number {
  let bytes = 0
  for (const f of ["dubplate.db", "dubplate.db-wal"]) {
    try {
      bytes += fs.statSync(path.join(config.dataDir, f)).size
    } catch {
      // not there
    }
  }
  return bytes
}

let cached: { at: number; report: HealthReport } | null = null

export async function healthReport(settings: Settings, fresh = false): Promise<HealthReport> {
  if (!fresh && cached && Date.now() - cached.at < 30_000) return cached.report
  const [ai, sources, integrations] = await Promise.all([aiChecks(settings), sourceChecks(settings), integrationChecks(settings)])
  const report: HealthReport = {
    checkedAt: new Date().toISOString(),
    checks: [...serverChecks(settings), ...securityChecks(settings), ...libraryChecks(settings), ...fileChecks(), ...ai, ...sources, ...integrations],
    system: {
      version: VERSION,
      node: process.version,
      platform: `${os.type()} ${os.release()} (${process.arch})`,
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      dbMb: Math.round((dbSize() / 1048576) * 10) / 10,
      dataDir: config.dataDir,
    },
  }
  cached = { at: Date.now(), report }
  return report
}
