// Verification & execution: builds a rename/tag plan, applies it with a
// journal entry per file, and can rewind any batch - cuts, folder moves and
// duplicates set aside alike.

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { formatKey } from "../shared/keys"
import type { ExistingTags, Library, Operation, PlanItem, Settings, Track } from "../shared/types"
import { artToEmbed, describeArt, cachedArt } from "./art"
import { idsFor } from "./core/ids"
import { tagDiff, tagsFor, type TagExtras } from "./core/naming"
import { ensureDir, followableSidecars, isInside, moveFile, removeCreatedDirs, removeEmptyDirs, sameFile } from "./fsops"
import type { JobContext } from "./jobs"
import { placementLibraryId, settingsForLibrary } from "./library-settings"
import { metaFor, proposedFilename, targetFolder } from "./placement"
import { getLibrary, getTrack, insertOperation, libraryForPath, listLibraries, listOperations, markOperationReverted, updateTrack } from "./repo"
import { readManagedTags, writeTags } from "./tagger"

export { metaFor, proposedFilename } from "./placement"

/** BPM, key, artwork and catalogue IDs to write for a track, per the settings. */
export function extrasFor(t: Track, settings: Settings): TagExtras {
  const out: TagExtras = {}
  if (settings.analysis.writeTags) {
    out.bpm = t.bpm
    out.key = formatKey(t.key, settings.analysis.keyNotation)
  }
  out.cover = artToEmbed(t, settings)?.hash ?? null
  if (settings.naming.writeIds) out.ids = idsFor(t.decision, metaFor(t))
  if (settings.analysis.writeReplayGain) out.replayGain = t.analysis?.loudness ?? null
  return out
}

/** The folder a file is in, relative to its library ("" for the top level), as the scanner records it. */
export function relDirOf(lib: Library | null | undefined, file: string): string {
  if (!lib) return path.dirname(file)
  return path.relative(lib.path, path.dirname(file))
}

export function buildPlan(tracks: Track[], settings: Settings): PlanItem[] {
  const libs = new Map(listLibraries().map((l) => [l.id, l]))
  const targets = new Map<string, number>()
  const items: PlanItem[] = tracks.map((t) => {
    const lib = libs.get(t.libraryId)
    // An inbox's tracks go to the library it feeds, into that library's layout.
    const dest = libs.get(placementLibraryId(t.libraryId)) ?? lib
    const inbox = !!dest && dest.id !== t.libraryId
    const s = settingsForLibrary(settings, dest?.id ?? t.libraryId)
    const issues: string[] = []
    const meta = metaFor(t)
    const name = (s.naming.renameFiles && proposedFilename(t, settings)) || t.filename
    let dir = path.dirname(t.path)
    // Moving into folders on cut: the folder template decides the folder, inside the library.
    if (dest && meta && (inbox || s.organise.onCut)) {
      if (inbox && !dest.exists) issues.push(`${dest.name}'s folder isn't there`)
      const folder = targetFolder(t, s)
      if (folder !== null) dir = path.join(dest.path, ...folder.split("/").filter(Boolean))
      if (folder && folder.split("/")[0].toLowerCase() === s.duplicates.holdingFolder.toLowerCase()) issues.push("Would land in the folder for duplicates set aside")
      if (!isInside(dest.path, dir)) issues.push("Would end up outside the library")
    }
    const toPath = path.join(dir, name)
    const rename = toPath !== t.path
    const tags = meta && s.naming.writeTags ? tagsFor(meta, t.tags, s.naming, extrasFor(t, s)) : {}
    const tagChanges = tagDiff(t.tags, tags)
    if (!meta) issues.push("No approved artist/title yet")
    if (!fs.existsSync(t.path)) issues.push("File is missing on disk - rescan the library")
    if (rename && fs.existsSync(toPath) && !sameFile(t.path, toPath)) {
      const where = relDirOf(dest, toPath) || (inbox ? `${dest!.name}'s top folder` : "the library's top folder")
      issues.push(dir === path.dirname(t.path) ? `"${name}" already exists in this folder` : `"${name}" already exists in ${inbox && relDirOf(dest, toPath) ? `${dest!.name}/${where}` : where}`)
    }
    if (rename) {
      const key = toPath.toLowerCase()
      targets.set(key, (targets.get(key) ?? 0) + 1)
    }
    if (!rename && !tagChanges.length && meta) issues.push("Already clean - nothing to change")
    return {
      trackId: t.id,
      fromPath: t.path,
      toPath,
      fromName: t.filename,
      toName: name,
      fromDir: relDirOf(lib, t.path),
      toDir: relDirOf(dest, toPath),
      rename,
      ...(inbox && dest ? { toLibraryId: dest.id } : {}),
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

function pickBefore(before: ExistingTags, fields: (keyof ExistingTags)[]): ExistingTags {
  const out: ExistingTags = {}
  for (const f of fields) (out as Record<string, unknown>)[f] = before[f] ?? null
  return out
}

/** Folders files left, and where their audio went, so leftovers can follow and empty folders go. */
export class MoveTracker {
  private moves = new Map<string, { targets: Set<string>; libraryId: number }>()
  add(from: string, to: string, libraryId: number) {
    const src = path.dirname(from)
    const dst = path.dirname(to)
    if (src === dst) return
    const m = this.moves.get(src) ?? { targets: new Set<string>(), libraryId }
    m.targets.add(dst)
    this.moves.set(src, m)
  }

  /**
   * After the moves: cover images, cue sheets and the like follow their folder's
   * audio when it all went to one place, then folders left empty are removed.
   */
  async finish(settings: Settings, batchId: string, label: string, ctx: JobContext) {
    let followed = 0
    for (const [src, { targets, libraryId }] of this.moves) {
      const s = settingsForLibrary(settings, libraryId)
      const lib = getLibrary(libraryId)
      if (!lib || src === lib.path || targets.size !== 1 || !s.organise.sidecars) continue
      const dst = [...targets][0]
      for (const file of followableSidecars(src, new Set()) ?? []) {
        const to = path.join(dst, path.basename(file))
        if (fs.existsSync(to)) continue
        try {
          await moveFile(file, to)
          insertOperation({ batchId, trackId: null, kind: "move", fromPath: file, toPath: to, tagsBefore: null, tagsAfter: null, status: "done", error: null, batchLabel: label })
          followed++
        } catch (err) {
          ctx.log("warn", `Couldn't bring ${path.basename(file)} along: ${err instanceof Error ? err.message : err}`)
        }
      }
    }
    for (const [src, { libraryId }] of [...this.moves].sort((a, b) => b[0].length - a[0].length)) {
      const lib = getLibrary(libraryId)
      if (lib && settingsForLibrary(settings, libraryId).organise.tidy) await removeEmptyDirs(src, lib.path)
    }
    if (followed) ctx.log("info", `Brought ${followed} cover image${followed === 1 ? "" : "s"} and other files along with their folders`)
  }
}

export async function executePlan(items: PlanItem[], settings: Settings, opts: { dryRun: boolean; label?: string }, ctx: JobContext): Promise<string> {
  if (settings.safety.readOnly && !opts.dryRun) throw new Error("Read-only mode is on - switch it off in Settings to write to files")
  const batchId = randomUUID()
  const label = opts.label ?? "Cut"
  const runnable = items.filter((i) => !i.blocked)
  ctx.setTotal(runnable.length)
  const changed: number[] = []
  const moved = new MoveTracker()
  for (const item of runnable) {
    if (ctx.signal.aborted) break
    const track = getTrack(item.trackId)
    if (!track) {
      ctx.tick(false)
      continue
    }
    const kind: Operation["kind"] = item.rename && item.tagChanges.length ? "rename+tag" : item.rename ? "rename" : "tag"
    const fields = item.tagChanges.map((c) => c.field)
    const base = { batchId, trackId: track.id, kind, fromPath: item.fromPath, toPath: item.toPath, tagsAfter: item.tags, statusBefore: track.status, batchLabel: label }
    if (opts.dryRun) {
      insertOperation({ ...base, tagsBefore: pickBefore(track.tags, fields), status: "dry-run", error: null })
      ctx.tick(true, item.toName)
      continue
    }
    let tagsBefore: ExistingTags | null = null
    let createdDirs: string[] = []
    try {
      const st = await fs.promises.stat(track.path)
      if (st.size !== track.size || Math.round(st.mtimeMs) !== Math.round(track.mtimeMs)) {
        throw new Error("File changed on disk since it was scanned - rescan first")
      }
      if (item.tagChanges.length) {
        tagsBefore = pickBefore(readManagedTags(track.path), fields)
        const changes: Partial<Record<keyof ExistingTags, unknown>> = {}
        for (const c of item.tagChanges) changes[c.field] = c.after
        writeTags(track.path, changes)
      }
      if (item.rename) {
        createdDirs = await ensureDir(path.dirname(item.toPath))
        await moveFile(track.path, item.toPath)
        moved.add(track.path, item.toPath, track.libraryId)
      }
      const after = await fs.promises.stat(item.toPath)
      const embedded = item.tags.cover && track.artFound?.hash === item.tags.cover
      updateTrack(track.id, {
        path: item.toPath,
        filename: path.basename(item.toPath),
        relDir: relDirOf(getLibrary(item.toLibraryId ?? track.libraryId), item.toPath),
        // Out of an inbox: the track now belongs to the library it went into.
        ...(item.toLibraryId ? { libraryId: item.toLibraryId } : {}),
        size: after.size,
        mtimeMs: after.mtimeMs,
        tags: { ...track.tags, ...item.tags },
        status: "done",
        proposedName: path.basename(item.toPath),
        // The found cover is now the file's own.
        ...(embedded ? { art: track.artFound, artFound: null } : {}),
      })
      insertOperation({ ...base, tagsBefore, status: "done", error: null, createdDirs })
      changed.push(track.id)
      ctx.tick(true, item.toName)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // If tags were written but the rename failed, put the tags back.
      if (tagsBefore && fs.existsSync(track.path)) {
        try {
          writeTags(track.path, tagsBefore)
        } catch {
          // best effort - the journal records what happened
        }
      }
      await removeCreatedDirs(createdDirs)
      insertOperation({ ...base, tagsBefore, status: "failed", error: message })
      updateTrack(track.id, { status: "error", note: message })
      ctx.log("error", `${track.filename}: ${message}`)
      ctx.tick(false)
    }
  }
  if (!opts.dryRun) await moved.finish(settings, batchId, label, ctx)
  if (changed.length && !opts.dryRun) ctx.filesChanged()
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
  let undone = 0
  for (const op of ops) {
    if (ctx.signal.aborted) break
    try {
      if (!fs.existsSync(op.toPath)) throw new Error(`${path.basename(op.toPath)} is no longer there`)
      const moves = op.kind !== "tag" && op.fromPath !== op.toPath
      if (moves && fs.existsSync(op.fromPath) && !sameFile(op.fromPath, op.toPath)) {
        throw new Error(`${path.basename(op.fromPath)} exists again - not overwriting it`)
      }
      if (op.tagsBefore && Object.keys(op.tagsBefore).length) writeTags(op.toPath, op.tagsBefore as Record<string, unknown>)
      if (moves) {
        // The folder it came from may have been tidied away.
        await ensureDir(path.dirname(op.fromPath))
        await moveFile(op.toPath, op.fromPath)
        await removeCreatedDirs(op.createdDirs)
      }
      markOperationReverted(op.id)
      undone++
      if (op.trackId) {
        const t = getTrack(op.trackId)
        const st = await fs.promises.stat(op.fromPath)
        if (t) {
          const restored: ExistingTags = { ...t.tags }
          for (const [k, v] of Object.entries(op.tagsBefore ?? {})) (restored as Record<string, unknown>)[k] = v ?? undefined
          const artPatch: Partial<Track> = {}
          if (op.tagsBefore && "cover" in op.tagsBefore) {
            // Put the old picture's description back, and offer the removed one again.
            const old = op.tagsBefore.cover ? cachedArt(op.tagsBefore.cover) : null
            artPatch.art = old ? describeArt(old, "embedded") : null
            if (t.art && t.art.hash === op.tagsAfter?.cover) artPatch.artFound = t.art
          }
          // Folder moves keep the track's status; a rewound cut goes back to approved.
          const status = op.statusBefore ?? (op.kind === "move" || op.kind === "set-aside" ? t.status : "approved")
          // A cut out of an inbox goes back to the inbox's library.
          const home = libraryForPath(op.fromPath) ?? getLibrary(t.libraryId)
          updateTrack(t.id, {
            path: op.fromPath,
            filename: path.basename(op.fromPath),
            relDir: relDirOf(home, op.fromPath),
            ...(home && home.id !== t.libraryId ? { libraryId: home.id } : {}),
            size: st.size,
            mtimeMs: st.mtimeMs,
            tags: restored,
            status,
            ...(op.kind === "set-aside" ? { missing: false, aside: null } : {}),
            ...artPatch,
          })
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
  if (undone) ctx.filesChanged()
  ctx.tracksChanged(changed)
}
