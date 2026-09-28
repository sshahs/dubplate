// Adding a release to MusicBrainz. There's no API for creating releases, and
// MusicBrainz asks that bots don't make mass edits, so Dubplate never submits
// one itself: it pre-fills the release editor from its evidence (a form a
// person opens, checks and submits on musicbrainz.org). The editor sends the
// person back with the new release's ID, which Dubplate stores so the next
// tag update writes it - that's what lets Jellyfin, Navidrome and Symphonium
// recognise the release.

import type { FinalMeta, MbSubmission, Track } from "../shared/types"
import { formatTitle } from "./core/naming"
import { getDb, parseJson } from "./db"
import { metaFor } from "./placement"
import { getTracks, updateTrack } from "./repo"
import { settingsNow } from "./settings"
import { httpJson } from "./sources/http"

export const MB_RELEASE_EDITOR = "https://musicbrainz.org/release/add"

type Row = { id: number; track_ids_json: string; title: string; status: string; release_mbid: string | null; created_at: string; updated_at: string }

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

/** Start a submission: returns it with the fields for the release editor. */
export function startMbSubmission(trackIds: number[], redirectBase: string): { submission: MbSubmission; action: string; fields: Record<string, string> } {
  const tracks = getTracks(trackIds)
  const ordered = inOrder(tracks).filter((t) => metaFor(t))
  if (!ordered.length) throw new Error("Approve an artist and title first")
  const first = metaFor(ordered[0])!
  const title = ordered.length === 1 ? `${first.artists.join(" & ")} - ${first.title}` : (first.album ?? ordered[0].decision?.album ?? `${ordered.length} tracks by ${first.artists.join(" & ")}`)
  const r = getDb().prepare("INSERT INTO mb_submissions (track_ids_json, title) VALUES (?, ?) RETURNING *").get(JSON.stringify(ordered.map((t) => t.id)), title) as Row
  const redirect = `${redirectBase.replace(/\/+$/, "")}/musicbrainz/done?submission=${r.id}`
  return { submission: toSubmission(r), action: MB_RELEASE_EDITOR, fields: seedFields(ordered, redirect, r.id) }
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
  let recordings = 0
  getTracks(sub.trackIds).forEach((t, i) => {
    const rec = mediumTracks[i]?.recording?.id
    if (rec) recordings++
    updateTrack(t.id, { idsOverride: { ...(t.idsOverride ?? {}), mbReleaseId: mbid, ...(release?.["release-group"]?.id ? { mbReleaseGroupId: release["release-group"].id } : {}), ...(rec ? { mbRecordingId: rec } : {}) } })
  })
  getDb().prepare("UPDATE mb_submissions SET status = 'received', release_mbid = ?, updated_at = datetime('now') WHERE id = ?").run(mbid, id)
  return { submission: getMbSubmission(id)!, recordings }
}
