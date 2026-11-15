// Turns approved metadata into a filename and a set of tags.

import type { Decision, ExistingTags, ExternalIds, FinalMeta, LoudnessMeasure, Settings } from "../../shared/types"
import { lyricsSummary } from "../../shared/lyrics"
import { collapseSpaces, normKey } from "./normalize"
import { hasMarkup } from "./plain-text"
import { isPlaceholder } from "../../shared/fields"

type Naming = Settings["naming"]

function joinList(names: string[], joiner: string) {
  if (names.length <= 2) return names.join(joiner)
  // "A, B & C" for three or more collaborators
  if (joiner.trim() === "&") return `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`
  return names.join(joiner)
}

export function formatArtist(meta: FinalMeta, naming: Naming, withFeaturing = true): string {
  const joiner = meta.relation === "vs" ? naming.clashJoiner : meta.relation === "x" ? " x " : naming.artistJoiner
  let a = joinList(meta.artists.filter(Boolean), joiner)
  const guests = newNames(meta.featuring, a)
  if (withFeaturing && naming.featuring === "artist" && guests.length) a += ` feat. ${joinList(guests, " & ")}`
  return collapseSpaces(a)
}

/** Featured artists the text doesn't already name ("Jah Shaka feat. Max Romeo" never gets Max Romeo twice). */
function newNames(names: string[], text: string): string[] {
  const have = ` ${normKey(text)} `
  return names.filter((n, i) => normKey(n) && !have.includes(` ${normKey(n)} `) && names.findIndex((m) => normKey(m) === normKey(n)) === i)
}

export function formatTitle(meta: FinalMeta, naming: Naming): string {
  let t = meta.title
  const guests = newNames(meta.featuring, `${meta.title} ${meta.artists.join(" ")}`)
  if (naming.featuring === "title" && guests.length) t += ` (feat. ${joinList(guests, " & ")})`
  if (naming.appendVersion && meta.version && !t.toLowerCase().includes(meta.version.toLowerCase())) t += ` (${meta.version})`
  return collapseSpaces(t)
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

export function sanitizeFilename(s: string, maxLength = 180): string {
  let out = s
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s*:\s*/g, " - ")
    .replace(/[/\\|]/g, "-")
    .replace(/"/g, "'")
    .replace(/[<>]/g, "")
    .replace(/[*?]/g, "")
  out = collapseSpaces(out).replace(/^[\s.-]+|[\s.]+$/g, "")
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`
  if (out.length > maxLength) out = out.slice(0, maxLength).replace(/[\s.-]+$/, "")
  return out
}

/** Render a naming template like "{artist} - {title}" (without extension). */
export function renderTemplate(template: string, meta: FinalMeta, naming: Naming, place: { position?: string; track?: string; disc?: string } = {}): string {
  const values: Record<string, string> = {
    position: place.position ?? "",
    track: place.track ?? "",
    disc: place.disc ?? "",
    artist: formatArtist(meta, naming),
    artists: formatArtist(meta, naming, false),
    title: formatTitle(meta, naming),
    song: meta.title,
    version: meta.version ?? "",
    year: meta.year ? String(meta.year) : "",
    album: meta.album ?? "",
    label: meta.label ?? "",
    riddim: meta.riddim ?? "",
    featuring: meta.featuring.join(" & "),
    genre: meta.genre ?? "",
  }
  let out = template.replace(/\{(\w+)\}/g, (_, k: string) => (Object.hasOwn(values, k.toLowerCase()) ? values[k.toLowerCase()] : ""))
  // Drop empty bracket groups and dangling separators left by missing values.
  out = out
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/(\s-\s)+(?=\s*$)/g, "")
    .replace(/^\s*-\s/, "")
    .replace(/\s-\s(\s*-\s)+/g, " - ")
  return sanitizeFilename(out)
}

export function decisionToFinal(d: Decision): FinalMeta {
  return {
    artists: d.artists,
    featuring: d.featuring,
    relation: d.relation,
    title: d.title,
    version: d.version,
    year: d.year,
    album: d.album,
    ...(d.albumArtist ? { albumArtist: d.albumArtist } : {}),
    label: d.label,
    riddim: d.riddim,
    genre: d.genre,
  }
}

/** Values that live on the track rather than in the approved metadata. */
export interface TagExtras {
  bpm?: number | null
  /** already in the notation to write */
  key?: string | null
  /** artwork cache hash of a cover to embed */
  cover?: string | null
  /** MusicBrainz / Discogs IDs to write */
  ids?: ExternalIds
  /** measured loudness, written as ReplayGain */
  replayGain?: LoudnessMeasure | null
  /** lyrics to write */
  lyrics?: string | null
  /** replace lyrics the file already has */
  replaceLyrics?: boolean
  /**
   * Canonical genres are on: only this genre is ever written (never a source's
   * or the AI's), over whatever the file has when `overwrite` is set.
   */
  canonicalGenre?: { genre: string | null; overwrite: boolean }
  /**
   * The genre the AI guessed, and the genre tag the file came with: a genre tag that's
   * only the AI's guess (written by an earlier cut, not the file's own) is put right.
   */
  aiGenre?: string[]
  fileGenre?: string[]
  /**
   * Kept together with its album: album, year and label are the album's on every
   * track, written over whatever each file had (so one album never shows as several).
   */
  albumLocked?: boolean
  /** placed on its album's release: the release's track and disc numbers go over the file's */
  placedOnRelease?: boolean
  /** disc and track numbers from the file's name and folders, for a file whose tags don't have them */
  placement?: { disc?: number; discTotal?: number; track?: number }
}

/**
 * Fields only ever written into an empty tag. When cutting they're checked
 * against the file itself: a track scanned before Dubplate read a field (the
 * riddim, Grouping) doesn't know the file already has one.
 */
export const FILL_ONLY: ReadonlySet<keyof ExistingTags> = new Set(["album", "year", "label", "riddim", "grouping"])

/** A tag that holds nothing worth keeping: web page markup, or a placeholder like "reggae" as the album or "(17)" as the genre. */
export function emptyish(field: keyof ExistingTags, v: unknown): boolean {
  if (typeof v === "string") return hasMarkup(v) || ((field === "album" || field === "label") && isPlaceholder(field, v))
  if (field === "genre" && Array.isArray(v)) return v.length > 0 && v.every((g) => typeof g === "string" && isPlaceholder("genre", g))
  return false
}

/**
 * Tags to write. Artist and title are always set; album/year/genre/label and
 * the riddim only fill gaps. BPM, key and cover come from `extras` when there's
 * something to say.
 */
export function tagsFor(meta: FinalMeta, current: ExistingTags, naming: Naming, extras: TagExtras = {}): ExistingTags {
  const out: ExistingTags = {
    artist: formatArtist(meta, naming),
    title: formatTitle(meta, naming),
  }
  // A field holding web page markup, or only a placeholder ("reggae" as the album), counts as empty, so it's put right.
  const was = current
  current = Object.fromEntries(Object.entries(current).filter(([k, v]) => !emptyish(k as keyof ExistingTags, v))) as ExistingTags
  if (extras.albumLocked) {
    // The album's own details on every track of it, over each file's own.
    for (const f of ["album", "year", "label"] as const) if (meta[f] && meta[f] !== current[f]) (out as Record<string, unknown>)[f] = meta[f]
    current = { ...current, album: meta.album ?? current.album, year: meta.year ?? current.year, label: meta.label ?? current.label }
  }
  if (!current.album && meta.album) out.album = meta.album
  // The album artist keeps an album together in players (a "feat." track included): always the album's.
  if (meta.albumArtist && meta.albumArtist !== current.albumArtist) out.albumArtist = meta.albumArtist
  // …and with nothing better to put there, the placeholder goes (Rewind puts it back).
  for (const f of ["album", "label"] as const) if (was[f] && !current[f] && !out[f]) out[f] = ""
  // A genre an earlier cut wrote from the AI's guess (every UK rap tune "Reggae") isn't the file's own:
  // it's put right, or the file's own genre goes back.
  const lower = (gs?: string[]) => (gs ?? []).map((g) => g.trim().toLowerCase()).join("|")
  const onFile = was.genre
  const guessed = !!onFile?.length && !!extras.aiGenre?.some((g) => lower([g]) === lower(onFile)) && lower(onFile) !== lower(extras.fileGenre)
  if (guessed) current = { ...current, genre: extras.fileGenre?.length ? extras.fileGenre : undefined }
  if (was.genre?.length && !current.genre?.length && !meta.genre && !extras.canonicalGenre) out.genre = []
  if (!current.year && meta.year) out.year = meta.year
  if (extras.canonicalGenre) {
    const g = extras.canonicalGenre.genre
    const same = current.genre?.length === 1 && current.genre[0] === g
    if (g && !same && (extras.canonicalGenre.overwrite || !current.genre?.length)) out.genre = [g]
  } else if (!current.genre?.length && meta.genre) out.genre = [meta.genre]
  if (guessed && !out.genre) out.genre = current.genre ?? []
  if (out.genre && lower(out.genre) === lower(onFile)) delete out.genre
  if (!current.label && meta.label) out.label = meta.label
  if (!current.riddim && meta.riddim) out.riddim = meta.riddim
  // Grouping is where DJ software shows it; only an empty one is used.
  if (naming.riddimGrouping && meta.riddim && !current.grouping) out.grouping = meta.riddim
  // Where it sits on its record, only where the file doesn't say already.
  const place = extras.placement
  // An album's tracks get their numbers on its release, over whatever the files had.
  const over = !!extras.placedOnRelease
  if (place?.track && (!current.track || (over && place.track !== current.track))) out.track = place.track
  if (place?.disc && (!current.disc || (over && place.disc !== current.disc))) out.disc = place.disc
  if (place?.discTotal && (!current.discTotal || (over && place.discTotal !== current.discTotal))) out.discTotal = place.discTotal
  if (naming.tagComment) out.comment = "Identified by Dubplate"
  if (extras.bpm && Math.round(extras.bpm) !== Math.round(current.bpm ?? 0)) out.bpm = Math.round(extras.bpm)
  if (extras.key && extras.key !== current.key) out.key = extras.key
  if (extras.cover && extras.cover !== current.cover) out.cover = extras.cover
  const ids = extras.ids ?? {}
  if (ids.mbRecordingId && ids.mbRecordingId !== current.mbRecordingId) out.mbRecordingId = ids.mbRecordingId
  if (ids.mbReleaseId && ids.mbReleaseId !== current.mbReleaseId) out.mbReleaseId = ids.mbReleaseId
  if (ids.mbReleaseGroupId && ids.mbReleaseGroupId !== current.mbReleaseGroupId) out.mbReleaseGroupId = ids.mbReleaseGroupId
  if (ids.mbArtistIds?.[0] && ids.mbArtistIds[0] !== current.mbArtistId) out.mbArtistId = ids.mbArtistIds[0]
  if (ids.discogsReleaseId && ids.discogsReleaseId !== current.discogsReleaseId) out.discogsReleaseId = ids.discogsReleaseId
  // Lyrics go into a file without any, unless replacing is allowed (the stored value is only a summary).
  if (extras.lyrics && (!current.lyrics || (extras.replaceLyrics && lyricsSummary(extras.lyrics) !== current.lyrics))) out.lyrics = extras.lyrics
  const rg = extras.replayGain
  if (rg && Number.isFinite(rg.gain) && Number.isFinite(rg.peak)) {
    const gain = Math.round(rg.gain * 100) / 100
    const peak = Math.round(rg.peak * 1e6) / 1e6
    // Already there to the precision taggers write: leave the file alone.
    if (Math.abs(gain - (current.replayGainTrackGain ?? Infinity)) >= 0.01 || Math.abs(peak - (current.replayGainTrackPeak ?? Infinity)) >= 1e-5) {
      out.replayGainTrackGain = gain
      out.replayGainTrackPeak = peak
    }
  }
  return out
}

export function tagDiff(before: ExistingTags, after: ExistingTags) {
  const changes: { field: keyof ExistingTags; before: unknown; after: unknown }[] = []
  for (const [k, v] of Object.entries(after) as [keyof ExistingTags, unknown][]) {
    const b = before[k]
    if (JSON.stringify(b ?? null) !== JSON.stringify(v ?? null)) changes.push({ field: k, before: b ?? null, after: v })
  }
  return changes
}
