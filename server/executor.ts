// Verification & execution: builds a rename/tag plan, applies it with a
// journal entry per file, and can rewind any batch.

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { ExistingTags, FinalMeta, Operation, PlanItem, Settings, Track } from "../shared/types"
import { decisionToFinal, renderTemplate, tagDiff, tagsFor } from "./core/naming"
import type { JobContext } from "./jobs"
import { getTrack, insertOperation, listOperations, markOperationReverted, updateTrack } from "./repo"
import { readManagedTags, writeTags } from "./tagger"

export function metaFor(t: Track): FinalMeta | null {
  if (t.final) return t.final
  if (t.decision && t.decision.title && t.decision.artists.length) return decisionToFinal(t.decision)
  return null
}

export function proposedFilename(t: Track, settings: Settings): string | null {
  const meta = metaFor(t)
  if (!meta || !meta.title || !meta.artists.length) return null
  const base = renderTemplate(settings.naming.template, meta, settings.naming)
  return base ? `${base}.${t.ext.toLowerCase()}` : null
}

function sameFile(a: string, b: string) {
  try {
    const sa = fs.statSync(a)
    const sb = fs.statSync(b)
    return sa.ino === sb.ino && sa.dev === sb.dev
  } catch {
    return false
  }
}

export function buildPlan(tracks: Track[], settings: Settings): PlanItem[] {
  const targets = new Map<string, number>()
  const items: PlanItem[] = tracks.map((t) => {
    const issues: string[] = []
    const meta = metaFor(t)
    const toName = proposedFilename(t, settings) ?? t.filename
    const toPath = path.join(path.dirname(t.path), toName)
    const rename = settings.naming.renameFiles && toName !== t.filename
    const tags = meta && settings.naming.writeTags ? tagsFor(meta, t.tags, settings.naming) : {}
    const tagChanges = tagDiff(t.tags, tags)
    if (!meta) issues.push("No approved artist/title yet")
    if (!fs.existsSync(t.path)) issues.push("File is missing on disk — rescan the library")
    if (rename && fs.existsSync(toPath) && !sameFile(t.path, toPath)) issues.push(`"${toName}" already exists in this folder`)
    if (rename) {
      const key = toPath.toLowerCase()
      targets.set(key, (targets.get(key) ?? 0) + 1)
    }
    if (!rename && !tagChanges.length && meta) issues.push("Already clean — nothing to change")
    return {
      trackId: t.id,
      fromPath: t.path,
      toPath: rename ? toPath : t.path,
      fromName: t.filename,
      toName: rename ? toName : t.filename,
      rename,
      tags,
      tagChanges,
      issues,
      blocked: false,
      confidence: t.confidence,
    }
  })
  for (const item of items) {
    if (item.rename && (targets.get(item.toPath.toLowerCase()) ?? 0) > 1) item.issues.push("Another file in this batch wants the same name")
    item.blocked = item.issues.some((i) => !i.startsWith("Already clean")) || (!item.rename && !item.tagChanges.length)
  }
  return items
}

async function renameSafely(from: string, to: string) {
  if (from === to) return
  if (fs.existsSync(to)) {
    if (!sameFile(from, to)) throw new Error(`Refusing to overwrite ${path.basename(to)}`)
    // Case-only rename on a case-insensitive filesystem: go via a temp name.
    const tmp = `${from}.dubplate-${process.pid}.tmp`
    await fs.promises.rename(from, tmp)
    await fs.promises.rename(tmp, to)
    return
  }
  await fs.promises.rename(from, to)
}

function pickBefore(before: ExistingTags, fields: (keyof ExistingTags)[]): ExistingTags {
  const out: ExistingTags = {}
  for (const f of fields) (out as Record<string, unknown>)[f] = before[f] ?? null
  return out
}

export async function executePlan(items: PlanItem[], settings: Settings, opts: { dryRun: boolean }, ctx: JobContext): Promise<string> {
  if (settings.safety.readOnly && !opts.dryRun) throw new Error("Read-only mode is on — switch it off in Settings to write to files")
  const batchId = randomUUID()
  const runnable = items.filter((i) => !i.blocked)
  ctx.setTotal(runnable.length)
  const changed: number[] = []
  for (const item of runnable) {
    if (ctx.signal.aborted) break
    const track = getTrack(item.trackId)
    if (!track) {
      ctx.tick(false)
      continue
    }
    const kind: Operation["kind"] = item.rename && item.tagChanges.length ? "rename+tag" : item.rename ? "rename" : "tag"
    const fields = item.tagChanges.map((c) => c.field)
    if (opts.dryRun) {
      insertOperation({ batchId, trackId: track.id, kind, fromPath: item.fromPath, toPath: item.toPath, tagsBefore: pickBefore(track.tags, fields), tagsAfter: item.tags, status: "dry-run", error: null })
      ctx.tick(true, item.toName)
      continue
    }
    let tagsBefore: ExistingTags | null = null
    try {
      const st = await fs.promises.stat(track.path)
      if (st.size !== track.size || Math.round(st.mtimeMs) !== Math.round(track.mtimeMs)) {
        throw new Error("File changed on disk since it was scanned — rescan first")
      }
      if (item.tagChanges.length) {
        tagsBefore = pickBefore(readManagedTags(track.path), fields)
        const changes: Partial<Record<keyof ExistingTags, unknown>> = {}
        for (const c of item.tagChanges) changes[c.field] = c.after
        writeTags(track.path, changes)
      }
      if (item.rename) await renameSafely(track.path, item.toPath)
      const after = await fs.promises.stat(item.toPath)
      updateTrack(track.id, {
        path: item.toPath,
        filename: path.basename(item.toPath),
        size: after.size,
        mtimeMs: after.mtimeMs,
        tags: { ...track.tags, ...item.tags },
        status: "done",
        proposedName: path.basename(item.toPath),
      })
      insertOperation({ batchId, trackId: track.id, kind, fromPath: item.fromPath, toPath: item.toPath, tagsBefore, tagsAfter: item.tags, status: "done", error: null })
      changed.push(track.id)
      ctx.tick(true, item.toName)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // If tags were written but the rename failed, put the tags back.
      if (tagsBefore && fs.existsSync(track.path)) {
        try {
          writeTags(track.path, tagsBefore)
        } catch {
          // best effort — the journal records what happened
        }
      }
      insertOperation({ batchId, trackId: track.id, kind, fromPath: item.fromPath, toPath: item.toPath, tagsBefore, tagsAfter: item.tags, status: "failed", error: message })
      updateTrack(track.id, { status: "error", note: message })
      ctx.log("error", `${track.filename}: ${message}`)
      ctx.tick(false)
    }
  }
  ctx.tracksChanged(changed)
  return batchId
}

/** Undo a batch (or selected operations), newest first. */
export async function rewind(opIds: number[] | null, batchId: string | null, ctx: JobContext) {
  const ops = (batchId ? listOperations(batchId) : listOperations(undefined, 5000).filter((o) => opIds?.includes(o.id)))
    .filter((o) => o.status === "done")
    .sort((a, b) => b.id - a.id)
  ctx.setTotal(ops.length)
  const changed: number[] = []
  for (const op of ops) {
    if (ctx.signal.aborted) break
    try {
      if (!fs.existsSync(op.toPath)) throw new Error(`${path.basename(op.toPath)} is no longer there`)
      if (op.kind !== "tag" && op.fromPath !== op.toPath && fs.existsSync(op.fromPath) && !sameFile(op.fromPath, op.toPath)) {
        throw new Error(`${path.basename(op.fromPath)} exists again — not overwriting it`)
      }
      if (op.tagsBefore && Object.keys(op.tagsBefore).length) writeTags(op.toPath, op.tagsBefore as Record<string, unknown>)
      if (op.kind !== "tag") await renameSafely(op.toPath, op.fromPath)
      markOperationReverted(op.id)
      if (op.trackId) {
        const t = getTrack(op.trackId)
        const st = await fs.promises.stat(op.fromPath)
        if (t) {
          const restored: ExistingTags = { ...t.tags }
          for (const [k, v] of Object.entries(op.tagsBefore ?? {})) (restored as Record<string, unknown>)[k] = v ?? undefined
          updateTrack(t.id, { path: op.fromPath, filename: path.basename(op.fromPath), size: st.size, mtimeMs: st.mtimeMs, tags: restored, status: "approved" })
          changed.push(t.id)
        }
      }
      ctx.tick(true, path.basename(op.fromPath))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      markOperationReverted(op.id, `Rewind failed: ${message}`)
      ctx.log("error", `Rewind ${path.basename(op.toPath)}: ${message}`)
      ctx.tick(false)
    }
  }
  ctx.tracksChanged(changed)
}
