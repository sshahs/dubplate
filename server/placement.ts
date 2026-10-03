// Where an approved track ends up: its filename (naming template) and its folder
// inside the library (folder template), with each library's own settings applied.

import { checkFields } from "../shared/fields"
import { formatKey } from "../shared/keys"
import type { FinalMeta, Settings, Track } from "../shared/types"
import { bpmRange, decadeOf, initialOf, renderFolderTemplate, type FolderValues } from "./core/folders"
import { placeValues } from "./core/discs"
import { decisionToFinal, formatArtist, renderTemplate } from "./core/naming"
import { canonicalGenre } from "./genres"
import { placementLibraryId, settingsForLibrary } from "./library-settings"

export function metaFor(t: Track): FinalMeta | null {
  const meta = t.final ?? (t.decision && t.decision.title && t.decision.artists.length ? decisionToFinal(t.decision) : null)
  // Checked again on the way out, so nothing approved before the checks existed is written wrong.
  return meta ? checkFields(meta, { names: false }).fields : null
}

/** The name the track would be cut to, under its library's naming template (an inbox: the library it feeds). */
export function proposedFilename(t: Track, settings: Settings): string | null {
  const meta = metaFor(t)
  if (!meta || !meta.title || !meta.artists.length) return null
  const s = settingsForLibrary(settings, placementLibraryId(t.libraryId))
  const base = renderTemplate(s.naming.template, meta, s.naming, placeValues(t.tags, t.heuristic?.position))
  return base ? `${base}.${extFor(t, settings)}` : null
}

/**
 * The extension a track is cut with: its own, or - when it's really another
 * format and fixing that is on - the right one (if scans still pick that up).
 */
export function extFor(t: Pick<Track, "ext" | "fileCheck">, settings: Settings): string {
  const real = t.fileCheck?.realExt
  if (real && settings.naming.fixExtensions && settings.scanner.extensions.includes(real)) return real
  return t.ext.toLowerCase()
}

/**
 * The values a folder template can use. Album, year, genre, label and riddim
 * follow the file's own tags first, just as tagging leaves them.
 */
export function folderValues(t: Track, meta: FinalMeta, settings: Settings): FolderValues {
  const artist = formatArtist(meta, settings.naming, false)
  const year = t.tags.year || meta.year
  // Canonical genres on: the folder follows the one genre from your list (and its region folder).
  const canonical = settings.canonicalGenres?.enabled ? canonicalGenre(t, t.decision, settings) : null
  const genre = settings.canonicalGenres?.enabled ? (canonical?.folder ?? "") : (t.tags.genre?.[0] || meta.genre || "").split(/[,;/]/)[0].trim()
  const bpm = t.bpm ? Math.round(t.bpm) : null
  return {
    artist,
    firstartist: meta.artists[0] ?? "",
    albumartist: t.tags.albumArtist || artist,
    album: t.tags.album || meta.album || "",
    disc: placeValues(t.tags, t.heuristic?.position).disc ?? "",
    year: year ? String(year) : "",
    decade: decadeOf(year),
    label: t.tags.label || meta.label || "",
    riddim: t.tags.riddim || meta.riddim || "",
    genre,
    region: canonical?.region ?? "",
    version: meta.version ?? "",
    initial: initialOf(meta.artists[0] ?? artist),
    bpm: bpm ? String(bpm) : "",
    bpmrange: bpmRange(bpm),
    key: formatKey(t.key, settings.analysis.keyNotation) ?? "",
    camelot: formatKey(t.key, "camelot") ?? "",
    format: t.ext.toUpperCase(),
  }
}

/**
 * The folder (inside the library, "/" between levels, "" = top level) a track
 * belongs in, or null when there's no approved artist and title to go by.
 * `settings` should already be the track's library settings.
 */
export function targetFolder(t: Track, settings: Settings, opts: { template?: string; missing?: "skip" | "unknown" } = {}): string | null {
  const meta = metaFor(t)
  if (!meta?.title || !meta.artists.length) return null
  return renderFolderTemplate(opts.template ?? settings.organise.template, folderValues(t, meta, settings), { missing: opts.missing ?? settings.organise.missing })
}
