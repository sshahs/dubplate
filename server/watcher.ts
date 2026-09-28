// Automation: watched library folders, a periodic re-check for folders whose
// file events can't be trusted (network shares, some Docker mounts), and an
// optional nightly rescan. New files are scanned and, if enabled, identified.

import fs from "node:fs"
import path from "node:path"
import type { Library } from "../shared/types"
import { enqueueJob, log } from "./jobs"
import { checkSubmissions, pendingSubmissions } from "./acoustid-submit"
import { processTracks } from "./pipeline"
import { getLibrary, listLibraries } from "./repo"
import { libraryHasChanges, scanLibrary } from "./scanner"
import { settingsNow } from "./settings"
import { setWatchState } from "./watch-state"

/** Wait for a burst of file events to settle (a folder being copied in) before looking. */
const SETTLE_MS = 8_000
/** Folders without working file events are still re-checked this often, even if polling is off. */
const FALLBACK_POLL_MINUTES = 15

interface Watched {
  watcher: fs.FSWatcher | null
  settle?: ReturnType<typeof setTimeout>
  lastPoll: number
}

const watched = new Map<number, Watched>()
/** Libraries with an automatic scan already queued, so events don't pile up duplicates. */
const queued = new Set<number>()
/** Libraries whose next scan identifies what it finds whatever the setting (files someone just sent in). */
const identifyNext = new Set<number>()
/** Scans asked for by uploads and download tools, held a moment so a batch becomes one scan. */
const soon = new Map<number, ReturnType<typeof setTimeout>>()
let clock: ReturnType<typeof setInterval> | null = null
let lastNightly = ""
/** Refreshed every minute; file events can arrive by the thousand during a copy. */
let extensions = new Set<string>()

function interesting(filename: string) {
  const base = path.basename(filename)
  if (base.startsWith(".")) return false
  const ext = path.extname(base).slice(1).toLowerCase()
  // No extension: usually a folder being created or moved in.
  return !ext || extensions.has(ext)
}

function start(lib: Library) {
  const entry: Watched = { watcher: null, lastPoll: Date.now() }
  watched.set(lib.id, entry)
  try {
    entry.watcher = fs.watch(lib.path, { recursive: true, persistent: false }, (_event, filename) => {
      if (filename && !interesting(filename.toString())) return
      clearTimeout(entry.settle)
      entry.settle = setTimeout(() => void check(lib.id, "watch"), SETTLE_MS)
    })
    entry.watcher.on("error", () => {
      entry.watcher?.close()
      entry.watcher = null
      setWatchState(lib.id, "polling")
    })
    setWatchState(lib.id, "watching")
  } catch {
    setWatchState(lib.id, "polling")
  }
}

function stop(id: number) {
  const w = watched.get(id)
  if (!w) return
  clearTimeout(w.settle)
  w.watcher?.close()
  watched.delete(id)
  setWatchState(id, "off")
}

/** Start or stop watchers to match the libraries' watch switches. */
export function syncWatchers() {
  const libs = listLibraries()
  for (const id of [...watched.keys()]) if (!libs.some((l) => l.id === id && l.watch)) stop(id)
  for (const lib of libs) if (lib.watch && lib.exists && !watched.has(lib.id)) start(lib)
}

async function check(libraryId: number, reason: "watch" | "poll" | "nightly") {
  if (queued.has(libraryId)) return
  const lib = getLibrary(libraryId)
  if (!lib?.exists) return
  try {
    if (!(await libraryHasChanges(lib, settingsNow()))) return
  } catch (err) {
    log("warn", `Couldn't check ${lib.name} for new files: ${err instanceof Error ? err.message : err}`)
    return
  }
  queueScan(lib, reason === "nightly" ? `Nightly scan of ${lib.name}` : `New files in ${lib.name}`)
}

function queueScan(lib: Library, label: string) {
  if (queued.has(lib.id)) return
  queued.add(lib.id)
  enqueueJob("scan", label, async (ctx) => {
    queued.delete(lib.id)
    const identify = identifyNext.delete(lib.id)
    const settings = settingsNow()
    const fresh = getLibrary(lib.id)
    if (!fresh) return
    const { added } = await scanLibrary(fresh, settings, ctx)
    if (added.length && (settings.automation.autoProcess || identify)) {
      enqueueJob("process", `Identify ${added.length} new track${added.length === 1 ? "" : "s"} in ${fresh.name}`, (c) =>
        processTracks(added, settingsNow(), { interpret: true, scour: true, force: false }, c)
      )
    }
  })
}

/**
 * Scan a library shortly and identify whatever's new in it, whatever the
 * automation setting says - for files someone just sent in (an upload, a
 * download tool's hook). Calls within a few seconds of each other make one scan.
 */
export function scanSoon(libraryId: number, label: string, delayMs = 3000) {
  identifyNext.add(libraryId)
  clearTimeout(soon.get(libraryId))
  const timer = setTimeout(() => {
    soon.delete(libraryId)
    const lib = getLibrary(libraryId)
    if (lib?.exists) queueScan(lib, label)
  }, delayMs)
  timer.unref?.()
  soon.set(libraryId, timer)
}

let lastAcoustIdCheck = 0

function minuteTick() {
  const s = settingsNow()
  // Pending AcoustID submissions: ask how they got on every 20 minutes.
  if (Date.now() - lastAcoustIdCheck > 20 * 60_000 && pendingSubmissions()) {
    lastAcoustIdCheck = Date.now()
    void checkSubmissions(s, (level, m) => log(level, m))
  }
  extensions = new Set(s.scanner.extensions)
  const now = new Date()
  // Periodic re-check of watched folders (and a fallback for ones without file events).
  for (const [id, w] of watched) {
    const minutes = s.automation.pollMinutes > 0 ? s.automation.pollMinutes : w.watcher ? 0 : FALLBACK_POLL_MINUTES
    if (minutes && Date.now() - w.lastPoll >= minutes * 60_000) {
      w.lastPoll = Date.now()
      void check(id, "poll")
    }
  }
  // Nightly rescan of every library, once per day at the chosen time (server clock).
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
  const today = now.toDateString()
  if (s.automation.nightly && hhmm === s.automation.nightlyAt && lastNightly !== today) {
    lastNightly = today
    for (const lib of listLibraries()) void check(lib.id, "nightly")
  }
}

export function startAutomation() {
  extensions = new Set(settingsNow().scanner.extensions)
  syncWatchers()
  if (!clock) {
    clock = setInterval(minuteTick, 60_000)
    clock.unref()
  }
}

export function stopAutomation() {
  for (const id of [...watched.keys()]) stop(id)
  if (clock) clearInterval(clock)
  clock = null
}
