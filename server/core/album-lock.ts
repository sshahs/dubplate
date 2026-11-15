// A track kept together with its album: the album's details (name, album artist,
// year, label, genre and release) win over what the track's own hits said, so
// every track of one album is tagged the same. The track's own place on that
// release is used for its number where its hits know it.

import type { AlbumLock, Candidate, Decision, ReleaseInfo } from "../../shared/types"
import { normTitle } from "./normalize"

/** The track's own listing on the album's release (its position and recording), where a hit has it. */
export function ownListing(lock: AlbumLock, candidates: Candidate[]): ReleaseInfo | undefined {
  const rel = lock.release
  const same = (r: ReleaseInfo) => (rel?.id && r.id ? r.source === rel.source && r.id === rel.id : normTitle(r.title) === normTitle(lock.title))
  const all = candidates.flatMap((c) => c.releases ?? [])
  return all.find((r) => same(r) && r.position) ?? all.find(same)
}

export function applyAlbumLock(d: Decision, lock: AlbumLock | null | undefined, candidates: Candidate[]): Decision {
  if (!lock?.title) return d
  const own = ownListing(lock, candidates)
  // Another track's recording, length and place on it aren't this one's.
  // The album's release IDs on every track; only its own recording and place come from its own hit.
  const release = lock.release
    ? { ...lock.release, recordingId: own?.recordingId, length: own?.length, position: own?.position }
    : own
  const out: Decision = {
    ...d,
    album: lock.title,
    ...(lock.albumArtist ? { albumArtist: lock.albumArtist } : {}),
    year: lock.year ?? d.year,
    label: lock.label ?? d.label,
    genre: lock.genre ?? d.genre,
    provenance: {
      ...d.provenance,
      album: `the album (${lock.trackIds.length} tracks kept together${lock.by === "person" ? " by you" : ""})`,
      ...(lock.year ? { year: "the album" } : {}),
      ...(lock.label ? { label: "the album" } : {}),
      ...(lock.genre ? { genre: "the album" } : {}),
    },
  }
  if (release) {
    out.release = { release: { ...release, title: lock.title }, reason: `the album its ${lock.trackIds.length} tracks share`, considered: d.release?.considered ?? 1 }
    out.provenance = { ...out.provenance, release: "the album" }
  }
  if (own?.position) out.position = { ...own.position, from: "the album" }
  else if (d.position && d.album && normTitle(d.album) !== normTitle(lock.title)) delete out.position
  // Its own place on the album's release: the number, recording and names as the release lists them.
  const t = lock.track
  if (t) {
    out.position = { track: t.number, ...(t.discs > 1 ? { disc: t.disc, discs: t.discs } : {}), from: "the album" }
    if (out.release) out.release = { ...out.release, release: { ...out.release.release, ...(t.recordingId ? { recordingId: t.recordingId } : {}), ...(t.length ? { length: t.length } : {}) } }
    if (t.title && t.artists.length) {
      const version = d.version && !t.title.toLowerCase().includes(d.version.toLowerCase()) ? d.version : undefined
      Object.assign(out, { title: t.title, artists: t.artists, featuring: t.featuring, artist: t.artists.join(" & "), version, relation: t.artists.length > 1 ? "&" : undefined })
      out.provenance = { ...out.provenance, artists: "the album's release", title: "the album's release" }
    }
  }
  return out
}
