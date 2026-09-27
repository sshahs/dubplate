// Turns approved metadata into a filename and a set of tags.

import type { Decision, ExistingTags, ExternalIds, FinalMeta, LoudnessMeasure, Settings } from "../../shared/types"
import { collapseSpaces } from "./normalize"

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
  if (withFeaturing && naming.featuring === "artist" && meta.featuring.length) a += ` feat. ${joinList(meta.featuring, " & ")}`
  return collapseSpaces(a)
}

export function formatTitle(meta: FinalMeta, naming: Naming): string {
  let t = meta.title
  if (naming.featuring === "title" && meta.featuring.length) t += ` (feat. ${joinList(meta.featuring, " & ")})`
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
export function renderTemplate(template: string, meta: FinalMeta, naming: Naming): string {
  const values: Record<string, string> = {
    artist: formatArtist(meta, naming),
    artists: formatArtist(meta, naming, false),
    title: formatTitle(meta, naming),
    song: meta.title,
    version: meta.version ?? "",
    year: meta.year ? String(meta.year) : "",
    album: meta.album ?? "",
    label: meta.label ?? "",
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
    label: d.label,
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
}

/**
 * Tags to write. Artist and title are always set; album/year/genre/label only
 * fill gaps. BPM, key and cover come from `extras` when there's something to say.
 */
export function tagsFor(meta: FinalMeta, current: ExistingTags, naming: Naming, extras: TagExtras = {}): ExistingTags {
  const out: ExistingTags = {
    artist: formatArtist(meta, naming),
    title: formatTitle(meta, naming),
  }
  if (!current.album && meta.album) out.album = meta.album
  if (!current.year && meta.year) out.year = meta.year
  if (!current.genre?.length && meta.genre) out.genre = [meta.genre]
  if (!current.label && meta.label) out.label = meta.label
  if (naming.tagComment) out.comment = "Identified by Dubplate"
  if (extras.bpm && Math.round(extras.bpm) !== Math.round(current.bpm ?? 0)) out.bpm = Math.round(extras.bpm)
  if (extras.key && extras.key !== current.key) out.key = extras.key
  if (extras.cover && extras.cover !== current.cover) out.cover = extras.cover
  const ids = extras.ids ?? {}
  if (ids.mbRecordingId && ids.mbRecordingId !== current.mbRecordingId) out.mbRecordingId = ids.mbRecordingId
  if (ids.mbReleaseId && ids.mbReleaseId !== current.mbReleaseId) out.mbReleaseId = ids.mbReleaseId
  if (ids.mbArtistIds?.[0] && ids.mbArtistIds[0] !== current.mbArtistId) out.mbArtistId = ids.mbArtistIds[0]
  if (ids.discogsReleaseId && ids.discogsReleaseId !== current.discogsReleaseId) out.discogsReleaseId = ids.discogsReleaseId
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
