// Where an approved track ends up: its filename (naming template) and its folder
// inside the library (folder template), with each library's own settings applied.

import { formatKey } from "../shared/keys"
import type { FinalMeta, Settings, Track } from "../shared/types"
import { bpmRange, decadeOf, initialOf, renderFolderTemplate, type FolderValues } from "./core/folders"
import { decisionToFinal, formatArtist, renderTemplate } from "./core/naming"
import { placementLibraryId, settingsForLibrary } from "./library-settings"

export function metaFor(t: Track): FinalMeta | null {
  if (t.final) return t.final
  if (t.decision && t.decision.title && t.decision.artists.length) return decisionToFinal(t.decision)
  return null
}

/** The name the track would be cut to, under its library's naming template (an inbox: the library it feeds). */
export function proposedFilename(t: Track, settings: Settings): string | null {
  const meta = metaFor(t)
  if (!meta || !meta.title || !meta.artists.length) return null
  const s = settingsForLibrary(settings, placementLibraryId(t.libraryId))
  const base = renderTemplate(s.naming.template, meta, s.naming)
  return base ? `${base}.${t.ext.toLowerCase()}` : null
}

/**
 * The values a folder template can use. Album, year, genre and label follow the
 * file's own tags first, just as tagging leaves them.
 */
export function folderValues(t: Track, meta: FinalMeta, settings: Settings): FolderValues {
  const artist = formatArtist(meta, settings.naming, false)
  const year = t.tags.year || meta.year
  const genre = (t.tags.genre?.[0] || meta.genre || "").split(/[,;/]/)[0].trim()
  const bpm = t.bpm ? Math.round(t.bpm) : null
  return {
    artist,
    firstartist: meta.artists[0] ?? "",
    albumartist: t.tags.albumArtist || artist,
    album: t.tags.album || meta.album || "",
    year: year ? String(year) : "",
    decade: decadeOf(year),
    label: t.tags.label || meta.label || "",
    genre,
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
