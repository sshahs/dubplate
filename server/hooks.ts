// The import hook: download tools say "this finished downloading" and Dubplate
// scans the library it landed in and identifies what's new (then hands-off
// libraries file it). Takes what qBittorrent, slskd and Lidarr send as they
// are, plus a plain {"path": "…"} from anything else.

import path from "node:path"
import type { HookCall, Library, PathMapping } from "../shared/types"
import { libraryForPath, listLibraries } from "./repo"
import { scanSoon } from "./watcher"

export interface HookRequest {
  paths: string[]
  /** a whole library, by id or name */
  library?: string
  /** a tool's "does this work?" call */
  test: boolean
  /** which tool it looks like */
  from: string
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter((x): x is string => !!x) : [])

/** Everything a tool might put a path under, in its own words. */
function pathsIn(b: Record<string, unknown>): string[] {
  const out = [str(b.path), ...list(b.paths), str(b.file), str(b.folder), str(b.dir), str(b.directory)]
  // slskd: DownloadFileComplete / DownloadDirectoryComplete events (camelCase, or PascalCase from older versions).
  out.push(str(b.localFilename), str(b.LocalFilename), str(b.localDirectoryName), str(b.LocalDirectoryName))
  // Lidarr: the files a release import brought in.
  for (const key of ["trackFiles", "renamedTrackFiles"]) {
    if (Array.isArray(b[key])) for (const f of b[key] as Record<string, unknown>[]) out.push(str(f?.path))
  }
  return [...new Set(out.filter((x): x is string => !!x))]
}

function toolOf(b: Record<string, unknown>, userAgent: string, named?: string): string {
  if (named) return named.slice(0, 40)
  if (/lidarr/i.test(userAgent) || ("eventType" in b && ("instanceName" in b || "trackFiles" in b))) return "Lidarr"
  const type = str(b.type) ?? str(b.Type)
  if (/slskd/i.test(userAgent) || (type && /^Download(File|Directory)Complete$/.test(type))) return "slskd"
  if (/qbittorrent/i.test(userAgent)) return "qBittorrent"
  const product = userAgent.split(/[\s/]/)[0]
  return product || "Unknown"
}

/** Read a hook call, whatever shape it came in. */
export function readHook(body: unknown, query: Record<string, string>, userAgent = ""): HookRequest {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  const paths = [...pathsIn(query), ...pathsIn(b)]
  // A bare path as the whole body (curl --data "/downloads/Album").
  if (typeof body === "string" && /^(\/|[a-z]:[\\/])/i.test(body.trim()) && !body.includes("\n")) paths.push(body.trim())
  const eventType = str(b.eventType) ?? str(b.EventType) ?? str(b.type)
  const library = str(query.library) ?? (typeof b.library === "number" ? String(b.library) : str(b.library))
  return { paths: [...new Set(paths)], library, test: !!eventType && /^test$/i.test(eventType), from: toolOf(b, userAgent, str(query.from)) }
}

/**
 * A path as the tool sees it → as Dubplate does: the first folder mapping
 * whose "from" it starts with is swapped for the "to". Windows paths compare
 * without case and with either slash.
 */
export function mapHookPath(p: string, map: PathMapping[]): string {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "")
  const from = norm(p)
  for (const m of map) {
    const f = norm(m.from)
    if (!f) continue
    const win = /^[a-z]:/i.test(f)
    const a = win ? from.toLowerCase() : from
    const b = win ? f.toLowerCase() : f
    if (a === b || a.startsWith(`${b}/`)) {
      const rest = from.slice(f.length).replace(/^\//, "")
      return path.resolve(m.to, ...rest.split("/").filter(Boolean))
    }
  }
  return path.resolve(norm(p) || "/")
}

const recent: HookCall[] = []

export function recentHookCalls(): HookCall[] {
  return [...recent]
}

export function clearHookCalls() {
  recent.length = 0
}

export interface HookResult {
  queued: { id: number; name: string }[]
  ignored: { path: string; reason: string }[]
}

/** Queue scans for the libraries these paths are in. */
export function runHook(req: HookRequest, map: PathMapping[], token: string): HookResult {
  const queued = new Map<number, Library>()
  const ignored: HookResult["ignored"] = []
  if (req.library) {
    const libs = listLibraries()
    const lib = libs.find((l) => String(l.id) === req.library) ?? libs.find((l) => l.name.toLowerCase() === req.library!.toLowerCase())
    if (lib) queued.set(lib.id, lib)
    else ignored.push({ path: req.library, reason: "No library with that name or number" })
  }
  for (const p of req.paths) {
    const here = mapHookPath(p, map)
    const lib = libraryForPath(here)
    if (!lib) {
      ignored.push({
        path: p,
        reason:
          here === path.resolve(p)
            ? "Not inside any library - add its folder as a library (an inbox, say), or say where Dubplate sees it under Download tools"
            : `Maps to ${here}, which isn't inside any library`,
      })
    } else if (!lib.exists) ignored.push({ path: p, reason: `${lib.name}'s folder isn't there` })
    else queued.set(lib.id, lib)
  }
  if (!req.test) for (const lib of queued.values()) scanSoon(lib.id, `New downloads in ${lib.name}`, 5000)
  recent.unshift({
    at: new Date().toISOString(),
    token,
    from: req.from,
    test: req.test,
    paths: req.paths.slice(0, 20),
    libraries: [...queued.values()].map((l) => l.name),
    ignored: ignored.slice(0, 20),
  })
  recent.length = Math.min(recent.length, 20)
  return { queued: [...queued.values()].map((l) => ({ id: l.id, name: l.name })), ignored }
}
