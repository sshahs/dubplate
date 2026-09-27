// Duplicates: identical audio, and different files that would get the same
// name. Dubplate suggests the copy to keep and can set the others aside in a
// holding folder inside their library - never deleting anything - journalled so
// Rewind brings them back.

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { DuplicateGroup, Settings, TrackSummary } from "../shared/types"
import { getDb } from "./db"
import { MoveTracker, relDirOf } from "./executor"
import { ensureDir, moveFile } from "./fsops"
import type { JobContext } from "./jobs"
import { getLibrary, getTrack, insertOperation, summariesWhere, updateTrack } from "./repo"

const LOSSLESS = /flac|alac|pcm|wav|aiff|ape|wavpack|monkey/i
const LOSSLESS_EXT = new Set(["flac", "wav", "aif", "aiff", "ape", "wv"])

function lossless(t: TrackSummary) {
  return LOSSLESS_EXT.has(t.ext) || LOSSLESS.test(t.codec ?? "")
}

function fmtTime(sec: number) {
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`
}

/**
 * Rank copies of the same tune: lossless over lossy, then bitrate, never a
 * clipped copy, then one that's already cut and tagged, then artwork. Returns
 * the best copy and a short reason for each.
 */
export function rankCopies(tracks: TrackSummary[]): { best: number; reasons: Record<number, string>; order: number[] } {
  const longest = Math.max(0, ...tracks.map((t) => t.duration ?? 0))
  const scored = tracks.map((t) => {
    const why: string[] = []
    let score = 0
    if (lossless(t)) {
      score += 1000
      why.push(t.ext.toUpperCase())
    } else if (t.bitrate) {
      why.push(`${Math.round(t.bitrate / 1000)}k`)
    }
    score += Math.min(t.bitrate ?? 0, 3_000_000) / 1000
    if (longest && t.duration && t.duration < longest * 0.85) {
      score -= 800
      why.push(`shorter (${fmtTime(t.duration)} vs ${fmtTime(longest)})`)
    }
    if (t.status === "done") {
      score += 60
      why.push("already cut")
    } else if (t.status === "approved") {
      score += 30
      why.push("approved")
    }
    if (t.art) {
      score += 5
      why.push("has artwork")
    }
    if (t.proposedName && t.filename === t.proposedName) score += 3
    // Shallower folders are more likely to be where it belongs.
    score -= t.path.split(/[\\/]/).length * 0.1
    return { t, score, why }
  })
  scored.sort((a, b) => b.score - a.score || a.t.id - b.t.id)
  const reasons: Record<number, string> = {}
  for (const s of scored) reasons[s.t.id] = s.why.join(", ") || "same as the others"
  return { best: scored[0]?.t.id ?? 0, reasons, order: scored.map((s) => s.t.id) }
}

export function duplicateGroups(): DuplicateGroup[] {
  const db = getDb()
  const out: DuplicateGroup[] = []
  const hashes = db.prepare("SELECT hash FROM tracks WHERE hash IS NOT NULL AND missing = 0 GROUP BY hash HAVING COUNT(*) > 1 LIMIT 200").all() as { hash: string }[]
  for (const { hash } of hashes) {
    const tracks = summariesWhere("t.hash = ? AND t.missing = 0 LIMIT 50", [hash])
    const r = rankCopies(tracks)
    out.push({ key: hash, kind: "hash", tracks: r.order.map((id) => tracks.find((t) => t.id === id)!), best: r.best, reasons: r.reasons })
  }
  const names = db
    .prepare("SELECT proposed_name FROM tracks WHERE proposed_name IS NOT NULL AND missing = 0 GROUP BY lower(proposed_name) HAVING COUNT(*) > 1 LIMIT 200")
    .all() as { proposed_name: string }[]
  for (const { proposed_name } of names) {
    const tracks = summariesWhere("lower(t.proposed_name) = lower(?) AND t.missing = 0 LIMIT 50", [proposed_name])
    // skip groups that are already covered by an identical-hash group
    if (new Set(tracks.map((t) => t.hash)).size <= 1) continue
    const r = rankCopies(tracks)
    out.push({ key: proposed_name, kind: "name", tracks: r.order.map((id) => tracks.find((t) => t.id === id)!), best: r.best, reasons: r.reasons })
  }
  return out
}

/** How many copies are set aside (hidden from the library) right now. */
export function setAsideCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM tracks WHERE aside_json IS NOT NULL").get() as { n: number }).n
}

export interface Resolution {
  keep: number
  aside: number[]
}

/** Only copies of the kept track may be set aside: same audio, or the same proposed name. */
export function validResolutions(input: Resolution[]): Resolution[] {
  const out: Resolution[] = []
  for (const r of input) {
    const keep = getTrack(Number(r.keep))
    if (!keep || keep.missing) continue
    const aside = (r.aside ?? [])
      .map(Number)
      .filter((id) => id !== keep.id)
      .filter((id) => {
        const t = getTrack(id)
        if (!t || t.missing) return false
        const sameAudio = !!t.hash && t.hash === keep.hash
        const sameName = !!t.proposedName && t.proposedName.toLowerCase() === keep.proposedName?.toLowerCase()
        return sameAudio || sameName
      })
    if (aside.length) out.push({ keep: keep.id, aside })
  }
  return out
}

/** Somewhere free for `file` under the holding folder, mirroring where it lived. */
function holdingPath(libPath: string, holding: string, file: string) {
  const inside = path.relative(libPath, file)
  let to = path.join(libPath, holding, inside)
  const ext = path.extname(to)
  for (let n = 2; fs.existsSync(to); n++) to = path.join(path.dirname(to), `${path.basename(inside, ext)} (${n})${ext}`)
  return to
}

export async function setAside(resolutions: Resolution[], settings: Settings, ctx: JobContext) {
  if (settings.safety.readOnly) throw new Error("Read-only mode is on - switch it off to move files")
  const work = resolutions.flatMap((r) => r.aside.map((id) => ({ id, keep: r.keep })))
  ctx.setTotal(work.length)
  const batchId = randomUUID()
  const label = "Set aside duplicates"
  const tracker = new MoveTracker()
  const changed: number[] = []
  for (const { id, keep } of work) {
    if (ctx.signal.aborted) break
    const t = getTrack(id)
    const lib = t ? getLibrary(t.libraryId) : null
    if (!t || !lib) {
      ctx.tick(false)
      continue
    }
    if (t.aside) {
      // Another run got to it first.
      ctx.log("warn", `${t.filename}: already set aside`)
      ctx.tick(false)
      continue
    }
    const to = holdingPath(lib.path, settings.duplicates.holdingFolder, t.path)
    const base = { batchId, trackId: t.id, kind: "set-aside" as const, fromPath: t.path, toPath: to, tagsBefore: null, tagsAfter: null, statusBefore: t.status, batchLabel: label }
    let createdDirs: string[] = []
    try {
      if (!fs.existsSync(t.path)) throw new Error("File is missing on disk - rescan the library")
      createdDirs = await ensureDir(path.dirname(to))
      await moveFile(t.path, to)
      tracker.add(t.path, to, lib.id)
      updateTrack(t.id, { path: to, filename: path.basename(to), relDir: relDirOf(lib, to), missing: true, aside: { at: new Date().toISOString(), from: t.path, keptId: keep } })
      insertOperation({ ...base, status: "done", error: null, createdDirs })
      changed.push(t.id)
      ctx.tick(true, path.basename(t.path))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      insertOperation({ ...base, status: "failed", error: message })
      ctx.log("error", `${t.filename}: ${message}`)
      ctx.tick(false)
    }
  }
  // Nothing follows a duplicate into the holding folder; only emptied folders are tidied.
  await tracker.finish({ ...settings, organise: { ...settings.organise, sidecars: false } }, batchId, label, ctx)
  if (changed.length) ctx.filesChanged()
  ctx.tracksChanged(changed)
  ctx.log("success", `Set aside ${changed.length} duplicate${changed.length === 1 ? "" : "s"} in "${settings.duplicates.holdingFolder}"`)
}
