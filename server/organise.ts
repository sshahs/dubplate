// Organising: move identified tracks into a folder layout inside their library.
// The preview shows the resulting folders before anything moves; the run is
// journalled like a cut, so a whole organise can be rewound.

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Library, OrganiseMove, OrganisePreview, Settings, Track, TrackStatus } from "../shared/types"
import { followLrc, relDirOf, MoveTracker } from "./executor"
import { ensureDir, followableSidecars, isInside, moveFile, sameFile } from "./fsops"
import { getDb } from "./db"
import type { JobContext } from "./jobs"
import { settingsForLibrary } from "./library-settings"
import { proposedFilename, targetFolder } from "./placement"
import { getLibrary, getTrack, insertOperation, rowToTrack, updateTrack } from "./repo"

export interface OrganiseRequest {
  libraryId: number
  /** try a template without saving it (defaults to the library's) */
  template?: string
  missing?: "skip" | "unknown"
  /** also rename files to the naming template */
  rename?: boolean
  /** "cut": tracks already renamed and tagged; "approved": approved ones too */
  include?: "cut" | "approved"
  sidecars?: boolean
}

const PREVIEW_MOVES = 300
const PREVIEW_BLOCKED = 500
const PREVIEW_FOLDERS = 3000

function rel(lib: Library, p: string) {
  return path.relative(lib.path, p).split(path.sep).join("/")
}

/** Just the track rows (no source hits or decisions): organising only needs approved metadata. */
function readyTracks(lib: Library, statuses: TrackStatus[]): Track[] {
  const rows = getDb()
    .prepare(`SELECT * FROM tracks WHERE library_id = ? AND missing = 0 AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY path`)
    .all(lib.id, ...statuses) as Record<string, unknown>[]
  return rows.map(rowToTrack)
}

export function planOrganise(settings: Settings, req: OrganiseRequest): { preview: OrganisePreview; moves: OrganiseMove[]; lib: Library } {
  const lib = getLibrary(req.libraryId)
  if (!lib) throw new Error("Library not found")
  if (!lib.exists) throw new Error(`Library folder not found: ${lib.path}`)
  const s = settingsForLibrary(settings, lib.id)
  const template = req.template?.trim() || s.organise.template
  const missing = req.missing ?? s.organise.missing
  const statuses: TrackStatus[] = req.include === "approved" ? ["done", "approved"] : ["done"]
  const tracks = readyTracks(lib, statuses)
  const total = (getDb().prepare("SELECT COUNT(*) AS n FROM tracks WHERE library_id = ? AND missing = 0").get(lib.id) as { n: number }).n
  const holding = settings.duplicates.holdingFolder.toLowerCase()

  const moves: OrganiseMove[] = []
  let notReady = total - tracks.length
  for (const t of tracks) {
    const folder = targetFolder(t, s, { template, missing })
    if (folder === null) {
      notReady++
      continue
    }
    const name = (req.rename && proposedFilename(t, settings)) || t.filename
    const to = path.join(lib.path, ...folder.split("/").filter(Boolean), name)
    const issues: string[] = []
    if (folder.split("/")[0].toLowerCase() === holding) issues.push("Would land in the folder for duplicates set aside")
    if (!isInside(lib.path, to)) issues.push("Would end up outside the library")
    if (!fs.existsSync(t.path)) issues.push("File is missing on disk - rescan the library")
    else if (to !== t.path && fs.existsSync(to) && !sameFile(t.path, to)) issues.push(`There's already a "${name}" there`)
    moves.push({ trackId: t.id, from: t.path, to, fromRel: rel(lib, t.path), toRel: rel(lib, to), issues, blocked: false })
  }
  // Two files headed for the same place: neither goes.
  const seen = new Map<string, number>()
  for (const m of moves) if (m.to !== m.from) seen.set(m.to.toLowerCase(), (seen.get(m.to.toLowerCase()) ?? 0) + 1)
  for (const m of moves) {
    if (m.to !== m.from && (seen.get(m.to.toLowerCase()) ?? 0) > 1) m.issues.push("Another file is headed for the same name")
    m.blocked = m.issues.length > 0
  }

  // Cover images, cue sheets and so on follow a folder whose audio all goes to one place.
  const sidecars: OrganiseMove[] = []
  if (req.sidecars ?? s.organise.sidecars) {
    const bySource = new Map<string, { targets: Set<string>; audio: Set<string>; blocked: boolean }>()
    for (const m of moves) {
      const src = path.dirname(m.from)
      const e = bySource.get(src) ?? { targets: new Set<string>(), audio: new Set<string>(), blocked: false }
      e.targets.add(path.dirname(m.to))
      e.audio.add(m.from)
      e.blocked ||= m.blocked
      bySource.set(src, e)
    }
    for (const [src, e] of bySource) {
      const dst = [...e.targets][0]
      if (src === lib.path || e.blocked || e.targets.size !== 1 || dst === src) continue
      for (const file of followableSidecars(src, e.audio) ?? []) {
        const to = path.join(dst, path.basename(file))
        const issues = fs.existsSync(to) ? [`There's already a "${path.basename(file)}" there`] : []
        sidecars.push({ trackId: null, from: file, to, fromRel: rel(lib, file), toRel: rel(lib, to), issues, blocked: issues.length > 0, sidecar: true })
      }
    }
  }

  const all = [...moves, ...sidecars]
  const moving = all.filter((m) => !m.blocked && m.to !== m.from)
  // The layout afterwards: where every file will be (blocked ones stay put).
  const folders = new Map<string, { count: number; samples: string[] }>()
  for (const m of all) {
    const where = m.blocked ? m.fromRel : m.toRel
    const dir = where.includes("/") ? where.slice(0, where.lastIndexOf("/")) : ""
    const f = folders.get(dir) ?? { count: 0, samples: [] }
    f.count++
    if (f.samples.length < 3) f.samples.push(where.slice(where.lastIndexOf("/") + 1))
    folders.set(dir, f)
  }
  const preview: OrganisePreview = {
    libraryId: lib.id,
    template,
    counts: {
      tracks: moves.length,
      moving: moving.filter((m) => !m.sidecar).length,
      unchanged: moves.filter((m) => !m.blocked && m.to === m.from).length,
      blocked: all.filter((m) => m.blocked).length,
      notReady,
      sidecars: moving.filter((m) => m.sidecar).length,
      folders: folders.size,
    },
    folders: [...folders.entries()]
      .map(([p, f]) => ({ path: p, ...f }))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, PREVIEW_FOLDERS),
    moves: [...moving].sort((a, b) => a.toRel.localeCompare(b.toRel)).slice(0, PREVIEW_MOVES),
    blocked: all.filter((m) => m.blocked).slice(0, PREVIEW_BLOCKED),
  }
  return { preview, moves: all, lib }
}

/** Move everything the plan says (worked out afresh, so it's never stale), journalled for rewind. */
export async function executeOrganise(settings: Settings, req: OrganiseRequest, ctx: JobContext) {
  if (settings.safety.readOnly) throw new Error("Read-only mode is on - switch it off to move files")
  const { moves, lib } = planOrganise(settings, req)
  const runnable = moves.filter((m) => !m.blocked && m.to !== m.from)
  ctx.setTotal(runnable.length)
  const batchId = randomUUID()
  const label = "Organise"
  const tracker = new MoveTracker()
  const changed: number[] = []
  // Tracks first, then the files that follow them.
  for (const m of [...runnable.filter((x) => !x.sidecar), ...runnable.filter((x) => x.sidecar)]) {
    if (ctx.signal.aborted) break
    const t = m.trackId ? getTrack(m.trackId) : null
    const base = { batchId, trackId: m.trackId, kind: "move" as const, fromPath: m.from, toPath: m.to, tagsBefore: null, tagsAfter: null, statusBefore: t?.status ?? null, batchLabel: label }
    let createdDirs: string[] = []
    try {
      if (m.trackId && (!t || t.path !== m.from)) throw new Error("The track moved since the plan was made")
      createdDirs = await ensureDir(path.dirname(m.to))
      await moveFile(m.from, m.to)
      if (!m.sidecar) {
        tracker.add(m.from, m.to, lib.id)
        await followLrc(m.from, m.to, { batchId, label }, ctx)
      }
      if (t) {
        const st = await fs.promises.stat(m.to)
        const filename = path.basename(m.to)
        updateTrack(t.id, { path: m.to, filename, relDir: relDirOf(lib, m.to), mtimeMs: st.mtimeMs, ...(t.status === "done" || filename !== t.filename ? { proposedName: filename } : {}) })
        changed.push(t.id)
      }
      insertOperation({ ...base, status: "done", error: null, createdDirs })
      ctx.tick(true, m.toRel)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      insertOperation({ ...base, status: "failed", error: message })
      ctx.log("error", `${path.basename(m.from)}: ${message}`)
      ctx.tick(false)
    }
  }
  // Sidecars were planned already; the tracker only tidies the folders left empty.
  await tracker.finish({ ...settings, organise: { ...settings.organise, sidecars: false } }, batchId, label, ctx)
  if (ctx.job.done) ctx.filesChanged()
  ctx.tracksChanged(changed)
  ctx.log("success", `Organised ${ctx.job.done} file${ctx.job.done === 1 ? "" : "s"} in ${lib.name}${ctx.job.failed ? ` - ${ctx.job.failed} couldn't move` : ""}`)
}
