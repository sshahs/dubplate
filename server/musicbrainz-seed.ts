// Adding a release to MusicBrainz. There's no API for creating releases, and
// MusicBrainz asks that bots don't make mass edits, so Dubplate never submits
// one itself: it pre-fills the release editor from its evidence (a form a
// person opens, checks and submits on musicbrainz.org). The editor sends the
// person back with the new release's ID, which Dubplate stores so the next
// tag update writes it - that's what lets Jellyfin, Navidrome and Symphonium
// recognise the release.

import type { FinalMeta, MbSubmission, ReleaseKind, Settings, Track } from "../shared/types"
import { releasePosition, sideToDisc } from "./core/discs"
import { formatTitle } from "./core/naming"
import { getDb, parseJson } from "./db"
import { countryCode, fetchDiscogsRelease, matchTracks, parseDiscogsCode, releaseView } from "./discogs-code"
import { metaFor } from "./placement"
import { getTracks, updateTrack } from "./repo"
import { settingsNow } from "./settings"
import { discogsRelease, discogsTracks, type DiscogsRelease } from "./sources/catalog"
import { httpJson } from "./sources/http"
import { cleanArtistName } from "./sources/types"

export const MB_RELEASE_EDITOR = "https://musicbrainz.org/release/add"

type Row = { id: number; track_ids_json: string; slots_json: string | null; title: string; status: string; release_mbid: string | null; created_at: string; updated_at: string }

function toSubmission(r: Row): MbSubmission {
  return {
    id: r.id,
    trackIds: parseJson<number[]>(r.track_ids_json, []),
    title: r.title,
    status: r.status === "received" ? "received" : r.status === "submitted" ? "submitted" : "pending",
    releaseMbid: r.release_mbid,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function listMbSubmissions(limit = 30): MbSubmission[] {
  return (getDb().prepare("SELECT * FROM mb_submissions ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(toSubmission)
}

export function getMbSubmission(id: number): MbSubmission | null {
  const r = getDb().prepare("SELECT * FROM mb_submissions WHERE id = ?").get(id) as Row | undefined
  return r ? toSubmission(r) : null
}

/** The order tracks go on the release: their track numbers, then as given. */
function inOrder(tracks: Track[]): Track[] {
  return tracks.map((t, i) => ({ t, i })).sort((a, b) => (a.t.tags.track ?? 999) - (b.t.tags.track ?? 999) || a.i - b.i).map((x) => x.t)
}

/** An artist credit as the release editor's fields, main artists joined like the file's name, then featured guests. */
function creditFields(prefix: string, meta: FinalMeta, mbids: string[] = []): Record<string, string> {
  const s = settingsNow().naming
  const out: Record<string, string> = {}
  const names = [...meta.artists, ...meta.featuring]
  names.forEach((name, i) => {
    const p = `${prefix}.names.${i}`
    out[`${p}.name`] = name
    out[`${p}.artist.name`] = name
    if (i < meta.artists.length && mbids[i]) out[`${p}.mbid`] = mbids[i]
    const last = i === names.length - 1
    if (!last) {
      const nextIsFeat = i + 1 === meta.artists.length && meta.featuring.length
      out[`${p}.join_phrase`] = nextIsFeat ? " feat. " : i < meta.artists.length - 1 ? (meta.relation === "vs" ? ` ${s.clashJoiner.trim()} ` : ` ${s.artistJoiner.trim()} `) : " & "
    }
  })
  return out
}

const EVIDENCE_HOSTS = /(?:discogs\.com|bandcamp\.com|junodownload\.com|beatport\.com|traxsource\.com)/i

/** What the release editor is pre-filled with. A person checks all of it before submitting. */
export function seedFields(tracks: Track[], redirectUri: string, submissionId: number): Record<string, string> {
  const ordered = inOrder(tracks).filter((t) => metaFor(t))
  if (!ordered.length) throw new Error("Approve an artist and title first")
  const first = metaFor(ordered[0])!
  const naming = settingsNow().naming
  const album = first.album ?? ordered[0].decision?.album ?? ordered[0].tags.album
  const single = ordered.length === 1
  const fields: Record<string, string> = {
    name: single ? formatTitle({ ...first, featuring: [] }, { ...naming, featuring: "drop" }) : (album ?? formatTitle(first, naming)),
    type: single ? "single" : ordered.length <= 6 ? "ep" : "album",
    status: "official",
    "mediums.0.format": "Digital Media",
    redirect_uri: redirectUri,
    ...creditFields("artist_credit", { ...first, featuring: [] }, ordered[0].decision?.clusters[0]?.candidates.find((c) => c.ids?.mbArtistIds?.length)?.ids?.mbArtistIds),
  }
  if (first.year) fields["events.0.date.year"] = String(first.year)
  if (first.label) fields["labels.0.name"] = first.label
  const evidence: string[] = []
  ordered.forEach((t, n) => {
    const meta = metaFor(t)!
    const p = `mediums.0.track.${n}`
    fields[`${p}.name`] = formatTitle({ ...meta, featuring: [] }, { ...naming, featuring: "drop", appendVersion: true })
    fields[`${p}.number`] = String(n + 1)
    if (t.duration) fields[`${p}.length`] = String(Math.round(t.duration * 1000))
    const rec = t.idsOverride?.mbRecordingId ?? t.decision?.clusters[0]?.candidates.find((c) => c.ids?.mbRecordingId)?.ids?.mbRecordingId
    if (rec) fields[`${p}.recording`] = rec
    Object.assign(fields, creditFields(`${p}.artist_credit`, meta))
    for (const c of t.decision?.clusters[0]?.candidates ?? []) if (c.url && EVIDENCE_HOSTS.test(c.url) && !evidence.includes(c.url)) evidence.push(c.url)
  })
  evidence.slice(0, 5).forEach((url, i) => (fields[`urls.${i}.url`] = url))
  fields.edit_note = [
    `Pre-filled by Dubplate (a tagger) from the files and the sources that identified them; checked by the person submitting it (Dubplate submission ${submissionId}).`,
    ...ordered.map((t, n) => `Track ${n + 1}: "${t.original?.filename ?? t.filename}"${t.duration ? `, ${Math.floor(t.duration / 60)}:${String(Math.round(t.duration % 60)).padStart(2, "0")}` : ""}${t.decision?.clusters[0]?.sources.length ? ` - found on ${t.decision.clusters[0].sources.join(", ")}` : ""}`),
    ...(evidence.length ? ["Sources:", ...evidence.slice(0, 8)] : []),
  ].join("\n")
  return fields
}

/** The whole release a seed was filled from, when it was. */
export interface MbSeedRelease {
  source: "discogs"
  id: number
  url: string
  title: string
  /** how many tracks the release has, and which of them (their place, from 0) are the chosen files */
  tracks: number
  yours: number[]
}

/** A seed: the submission, and the fields for the release editor. */
export interface MbSeedResult {
  submission: MbSubmission
  action: string
  fields: Record<string, string>
  /** filled in from the whole release, not only the chosen files */
  release: MbSeedRelease | null
  /** a whole release Dubplate knows these tracks are on, offered when only the files were used */
  wholeAvailable: { id: number; title: string } | null
}

/**
 * The Discogs release the tracks are on, as far as Dubplate knows: one a person
 * named by its code, the release chosen for the first track, or a Discogs hit on
 * the album it's given.
 */
export function knownDiscogsRelease(tracks: Track[]): { id: number; title?: string } | null {
  for (const t of tracks) {
    const pinned = t.candidates?.find((c) => c.pinned && c.ids?.discogsReleaseId)
    if (pinned) return { id: Number(pinned.ids!.discogsReleaseId), title: pinned.album }
    if (t.idsOverride?.discogsReleaseId) return { id: Number(t.idsOverride.discogsReleaseId) }
  }
  for (const t of tracks) {
    const chosen = t.decision?.release?.release
    if (chosen?.source === "discogs" && chosen.id && /^\d+$/.test(chosen.id)) return { id: Number(chosen.id), title: chosen.title }
    const album = metaFor(t)?.album ?? t.decision?.album
    const hit = album && t.decision?.clusters[0]?.candidates.find((c) => c.ids?.discogsReleaseId && c.album && c.album.toLowerCase() === album.toLowerCase())
    if (hit) return { id: Number(hit.ids!.discogsReleaseId), title: hit.album }
  }
  return null
}

/** Discogs formats as MusicBrainz's medium formats. */
function mediumFormat(rel: DiscogsRelease): string | undefined {
  const f = rel.formats?.[0]
  if (!f) return undefined
  const d = (f.descriptions ?? []).join(" ")
  switch (f.name.toLowerCase()) {
    case "vinyl":
      return /12"/.test(d) ? '12" Vinyl' : /10"/.test(d) ? '10" Vinyl' : /7"/.test(d) ? '7" Vinyl' : "Vinyl"
    case "cd":
      return "CD"
    case "cdr":
      return "CD-R"
    case "file":
      return "Digital Media"
    case "cassette":
      return "Cassette"
    case "acetate":
      return "Acetate"
    case "dat":
      return "DAT"
    case "shellac":
      return "Shellac"
    case "minidisc":
      return "MiniDisc"
    default:
      return undefined
  }
}

/** MusicBrainz's primary release type for a kind of release (compilations and mixes are albums there). */
function mbType(kind: ReleaseKind, tracks: number): string {
  if (kind === "single" || kind === "ep") return kind
  if (kind === "other") return "other"
  if (kind === "standalone" || kind === "remix") return tracks <= 3 ? "single" : tracks <= 6 ? "ep" : "album"
  return "album"
}

const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377"

/** A Discogs artist credit as the release editor's fields. */
function discogsCreditFields(prefix: string, artists: { name: string; join?: string }[]): Record<string, string> {
  const out: Record<string, string> = {}
  artists.forEach((a, i) => {
    const p = `${prefix}.names.${i}`
    const various = /^various$/i.test(a.name.trim())
    const name = various ? "Various Artists" : cleanArtistName(a.name)
    out[`${p}.name`] = name
    out[`${p}.artist.name`] = name
    if (various) out[`${p}.mbid`] = VARIOUS_ARTISTS_MBID
    if (i < artists.length - 1) {
      const join = a.join?.trim() || "&"
      out[`${p}.join_phrase`] = join === "," ? ", " : ` ${join} `
    }
  })
  return out
}

/**
 * The release editor filled in from a whole Discogs release: every track on it,
 * across its discs, with the chosen files' lengths and recordings in their places.
 */
export function seedFromRelease(rel: DiscogsRelease, tracks: Track[], redirectUri: string, submissionId: number): { fields: Record<string, string>; slots: (number | null)[] } {
  const view = releaseView(rel)
  const rows = discogsTracks(rel)
  if (!rows.length) throw new Error("That Discogs release has no tracklist")
  // Where each chosen file sits on the release.
  const matched = matchTracks(view, tracks)
  const slots = tracks.map((t) => {
    const pinned = t.candidates?.find((c) => c.pinned && c.ids?.discogsReleaseId === String(rel.id) && c.position)
    const byPosition = pinned ? view.tracks.find((r) => releasePosition(r.position)?.track === pinned.position!.track && (releasePosition(r.position)?.disc ?? 1) === (pinned.position!.disc ?? 1)) : undefined
    return byPosition?.index ?? matched.find((m) => m.trackId === t.id)?.index ?? null
  })
  const fileAt = new Map<number, Track>()
  slots.forEach((slot, i) => slot !== null && !fileAt.has(slot) && fileAt.set(slot, tracks[i]))

  const date = (rel.released ?? "").match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/)
  const fields: Record<string, string> = {
    name: rel.title,
    type: mbType(view.kind, rows.length),
    status: /promo|test pressing/i.test(view.format ?? "") ? "promotion" : /unofficial/i.test(view.format ?? "") ? "bootleg" : "official",
    redirect_uri: redirectUri,
    ...discogsCreditFields("artist_credit", rel.artists?.length ? rel.artists : [{ name: "Various" }]),
  }
  const year = date?.[1] ?? (rel.year ? String(rel.year) : undefined)
  if (year && year !== "0000") fields["events.0.date.year"] = year
  if (date?.[2] && date[2] !== "00") fields["events.0.date.month"] = String(Number(date[2]))
  if (date?.[3] && date[3] !== "00") fields["events.0.date.day"] = String(Number(date[3]))
  const country = countryCode(rel.country)
  if (country) fields["events.0.country"] = country
  if (view.label) fields["labels.0.name"] = view.label
  if (view.catno) fields["labels.0.catalog_number"] = view.catno
  if (view.barcode) fields.barcode = view.barcode

  // Discs: "1-05", "CD2-3", side C (the second record)… and in order, a track with no position on the disc before it.
  const format = mediumFormat(rel)
  let disc = 1
  const discOf = rows.map((r) => {
    const p = r.position?.trim() ?? ""
    const pos = releasePosition(p)
    const side = p.match(/^([a-h])/i)?.[1]
    disc = pos?.disc ?? (side ? sideToDisc(side) : disc)
    return disc
  })
  const discs = [...new Set(discOf)].sort((a, b) => a - b)
  const onDisc = new Map<number, number>()
  rows.forEach((r, i) => {
    const m = discs.indexOf(discOf[i])
    const n = onDisc.get(m) ?? 0
    onDisc.set(m, n + 1)
    const p = `mediums.${m}.track.${n}`
    fields[`${p}.name`] = r.title
    if (r.position?.trim()) fields[`${p}.number`] = r.position.trim().replace(/^(?:cd|dis[ck])?\s?\d{1,2}\s?[-.]\s?(\d{1,3})$/i, "$1")
    const file = fileAt.get(i)
    const length = view.tracks[i].duration ?? file?.duration ?? undefined
    if (length) fields[`${p}.length`] = String(Math.round(length * 1000))
    const rec = file && (file.idsOverride?.mbRecordingId ?? file.decision?.clusters[0]?.candidates.find((c) => c.ids?.mbRecordingId)?.ids?.mbRecordingId)
    if (rec) fields[`${p}.recording`] = rec
    if (r.artists?.length) Object.assign(fields, discogsCreditFields(`${p}.artist_credit`, r.artists))
    else Object.assign(fields, discogsCreditFields(`${p}.artist_credit`, rel.artists?.length ? rel.artists : [{ name: "Various" }]))
  })
  discs.forEach((_, m) => {
    if (format) fields[`mediums.${m}.format`] = format
  })

  const evidence = [view.url]
  for (const t of tracks)
    for (const c of t.decision?.clusters[0]?.candidates ?? []) if (c.url && EVIDENCE_HOSTS.test(c.url) && !/discogs\.com/i.test(c.url) && !evidence.includes(c.url)) evidence.push(c.url)
  evidence.slice(0, 5).forEach((url, i) => (fields[`urls.${i}.url`] = url))
  const yours = slots.flatMap((slot, i) => (slot === null ? [] : [`${view.tracks[slot].position || slot + 1}: "${tracks[i].original?.filename ?? tracks[i].filename}"`]))
  fields.edit_note = [
    `Pre-filled by Dubplate (a tagger) from Discogs release ${rel.id} (${view.url}); checked against the record by the person submitting it (Dubplate submission ${submissionId}).`,
    view.format ? `Format on Discogs: ${view.format}.` : "",
    view.kind === "compilation" || view.kind === "dj-mix" ? `Discogs lists it as a ${view.kind === "dj-mix" ? "DJ mix" : "compilation"}: the secondary type may need adding.` : "",
    yours.length ? `The submitter has ${yours.length === 1 ? "this track" : "these tracks"} from it: ${yours.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n")
  return { fields, slots }
}

/** Start a submission: returns it with the fields for the release editor. */
export async function startMbSubmission(
  trackIds: number[],
  redirectBase: string,
  opts: { whole?: boolean; discogs?: string } = {},
  settings: Settings = settingsNow()
): Promise<MbSeedResult> {
  const tracks = getTracks(trackIds)
  const ordered = inOrder(tracks).filter((t) => metaFor(t) || opts.discogs)
  if (!ordered.length) throw new Error("Approve an artist and title first")
  // The whole release: one named here by its code, else the one the tracks are known to be on.
  let rel: DiscogsRelease | null = null
  if (opts.discogs) {
    const code = parseDiscogsCode(opts.discogs)
    if (!code || code.kind === "catno") throw new Error("Paste the Discogs release's link or its code like [r1234567]")
    rel = await fetchDiscogsRelease(code, settings)
    if (!rel) throw new Error("Discogs doesn't have that release")
  }
  const known = rel ? null : knownDiscogsRelease(ordered)
  if (!rel && known && opts.whole !== false) rel = await discogsRelease(known.id, settings.sources.discogs?.apiKey).catch(() => null)
  if (rel && !discogsTracks(rel).length) rel = null
  if (!rel && !ordered.some((t) => metaFor(t))) throw new Error("Approve an artist and title first")

  const first = metaFor(ordered[0])
  const title = rel
    ? rel.title
    : ordered.length === 1
      ? `${first!.artists.join(" & ")} - ${first!.title}`
      : (first!.album ?? ordered[0].decision?.album ?? `${ordered.length} tracks by ${first!.artists.join(" & ")}`)
  const r = getDb().prepare("INSERT INTO mb_submissions (track_ids_json, title) VALUES (?, ?) RETURNING *").get(JSON.stringify(ordered.map((t) => t.id)), title) as Row
  const redirect = `${redirectBase.replace(/\/+$/, "")}/musicbrainz/done?submission=${r.id}`
  if (rel) {
    const { fields, slots } = seedFromRelease(rel, ordered, redirect, r.id)
    getDb().prepare("UPDATE mb_submissions SET slots_json = ? WHERE id = ?").run(JSON.stringify(slots), r.id)
    return {
      submission: toSubmission(r),
      action: MB_RELEASE_EDITOR,
      fields,
      release: { source: "discogs", id: rel.id, url: `https://www.discogs.com/release/${rel.id}`, title: rel.title, tracks: discogsTracks(rel).length, yours: slots.filter((s): s is number => s !== null) },
      wholeAvailable: null,
    }
  }
  const withMeta = ordered.filter((t) => metaFor(t))
  return { submission: toSubmission(r), action: MB_RELEASE_EDITOR, fields: seedFields(withMeta, redirect, r.id), release: null, wholeAvailable: known ? { id: known.id, title: known.title ?? `Discogs release ${known.id}` } : null }
}

export function markMbSubmitted(id: number): MbSubmission | null {
  getDb().prepare("UPDATE mb_submissions SET status = 'submitted', updated_at = datetime('now') WHERE id = ? AND status = 'pending'").run(id)
  return getMbSubmission(id)
}

interface MbReleaseReply {
  id: string
  title: string
  "release-group"?: { id: string }
  media?: { tracks?: { position: number; title: string; recording?: { id: string; title: string } }[] }[]
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The release exists: store its IDs on the tracks (they win over what the
 * sources found), with each track's recording when MusicBrainz can be asked.
 */
export async function completeMbSubmission(id: number, releaseMbid: string): Promise<{ submission: MbSubmission; recordings: number }> {
  const sub = getMbSubmission(id)
  if (!sub) throw new Error("No such submission")
  const mbid = releaseMbid.trim().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]
  if (!mbid || !MBID.test(mbid)) throw new Error("That isn't a MusicBrainz release ID")
  let release: MbReleaseReply | null = null
  try {
    release = await httpJson<MbReleaseReply>(`https://musicbrainz.org/ws/2/release/${mbid}?inc=recordings+release-groups&fmt=json`, { ttlMs: 0 })
  } catch {
    // MusicBrainz unreachable: the release ID alone is still worth writing.
  }
  const mediumTracks = release?.media?.flatMap((m) => m.tracks ?? []) ?? []
  // A release filled in whole has each file at its own place on it.
  const slots = parseJson<(number | null)[] | null>((getDb().prepare("SELECT slots_json FROM mb_submissions WHERE id = ?").get(id) as { slots_json: string | null } | undefined)?.slots_json ?? null, null)
  let recordings = 0
  const byId = new Map(getTracks(sub.trackIds).map((t) => [t.id, t]))
  sub.trackIds.forEach((trackId, i) => {
    const t = byId.get(trackId)
    if (!t) return
    const slot = slots ? slots[i] : i
    const rec = slot === null || slot === undefined ? undefined : mediumTracks[slot]?.recording?.id
    if (rec) recordings++
    updateTrack(t.id, { idsOverride: { ...(t.idsOverride ?? {}), mbReleaseId: mbid, ...(release?.["release-group"]?.id ? { mbReleaseGroupId: release["release-group"].id } : {}), ...(rec ? { mbRecordingId: rec } : {}) } })
  })
  getDb().prepare("UPDATE mb_submissions SET status = 'received', release_mbid = ?, updated_at = datetime('now') WHERE id = ?").run(mbid, id)
  return { submission: getMbSubmission(id)!, recordings }
}
