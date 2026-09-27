// Per-library overrides: a library can have its own crates (genres), filename
// template and folder layout. Anything it doesn't set follows the app's settings.

import type { LibrarySettings, Settings } from "../shared/types"
import { getDb, parseJson } from "./db"
import { cleanGenres } from "./settings"

/** Only the fields a library may override, each checked and trimmed. */
export function cleanLibrarySettings(input: unknown): LibrarySettings {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const out: LibrarySettings = {}
  if (Array.isArray(i.genres)) out.genres = cleanGenres(i.genres)
  if (typeof i.sceneHint === "string") out.sceneHint = i.sceneHint.trim().slice(0, 500)
  if (typeof i.template === "string" && i.template.trim()) out.template = i.template.trim().slice(0, 200)
  if (typeof i.folderTemplate === "string" && i.folderTemplate.trim()) out.folderTemplate = i.folderTemplate.trim().slice(0, 200)
  if (typeof i.organiseOnCut === "boolean") out.organiseOnCut = i.organiseOnCut
  if (i.handsOff === true) out.handsOff = true
  const inbox = Number(i.inboxFor)
  if (Number.isInteger(inbox) && inbox > 0) out.inboxFor = inbox
  return out
}

/** The app settings with a library's own choices laid over them. */
export function withLibrary(settings: Settings, ls: LibrarySettings | null | undefined): Settings {
  if (!ls || !Object.keys(ls).length) return settings
  const s: Settings = { ...settings, llm: { ...settings.llm }, naming: { ...settings.naming }, organise: { ...settings.organise } }
  if (ls.genres) s.llm.genres = ls.genres
  if (ls.sceneHint !== undefined) s.llm.sceneHint = ls.sceneHint
  if (ls.template) s.naming.template = ls.template
  if (ls.folderTemplate) s.organise.template = ls.folderTemplate
  if (ls.organiseOnCut !== undefined) s.organise.onCut = ls.organiseOnCut
  return s
}

// Library settings are read for every track a job touches, so they're cached per
// database (tests swap databases) and dropped whenever a library changes.
const cache = new WeakMap<object, Map<number, LibrarySettings>>()

export function librarySettings(libraryId: number | null | undefined): LibrarySettings {
  if (!libraryId) return {}
  const db = getDb()
  let byId = cache.get(db)
  if (!byId) cache.set(db, (byId = new Map()))
  let ls = byId.get(libraryId)
  if (!ls) {
    const row = db.prepare("SELECT settings_json FROM libraries WHERE id = ?").get(libraryId) as { settings_json: string | null } | undefined
    ls = cleanLibrarySettings(parseJson(row?.settings_json, {}))
    byId.set(libraryId, ls)
  }
  return ls
}

export function forgetLibrarySettings() {
  cache.delete(getDb())
}

/** Settings as they apply to a track in `libraryId`. */
export function settingsForLibrary(settings: Settings, libraryId: number | null | undefined): Settings {
  return withLibrary(settings, librarySettings(libraryId))
}

/**
 * The library a track's name and folder are worked out for: an inbox's tracks
 * are headed for the library it feeds, so that library's templates apply.
 */
export function placementLibraryId(libraryId: number): number {
  const target = librarySettings(libraryId).inboxFor
  if (!target || target === libraryId) return libraryId
  return getDb().prepare("SELECT 1 FROM libraries WHERE id = ?").get(target) ? target : libraryId
}
