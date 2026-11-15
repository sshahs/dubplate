// An album's release in full: every track with its place, name, artist credit,
// length and recording, plus the album artist, label, date and cover. Read from
// MusicBrainz (by its release ID, or found by the album's name and artist) or
// Discogs, so a folder of tracks is tagged from the record itself rather than
// from whatever each track's own search turned up.

import type { AlbumRelease, AlbumReleaseTrack, Settings } from "../../shared/types"
import { normArtist, normTitle, titleSimilarity } from "../core/normalize"
import { mbKind } from "../core/releases"
import { releaseView } from "../discogs-code"
import { discogsRelease, discogsTracks } from "./catalog"
import { httpJson } from "./http"
import { cleanArtistName } from "./types"

type Credit = { name: string; joinphrase?: string; artist?: { id?: string; name: string } }

interface MbReleaseFull {
  id: string
  title: string
  date?: string
  country?: string
  status?: string
  barcode?: string
  "artist-credit"?: Credit[]
  "release-group"?: { id?: string; "primary-type"?: string; "secondary-types"?: string[]; genres?: { name: string; count?: number }[] }
  "label-info"?: { "catalog-number"?: string; label?: { name: string } }[]
  "cover-art-archive"?: { front?: boolean }
  genres?: { name: string; count?: number }[]
  media?: {
    position?: number
    format?: string
    tracks?: { number?: string; position?: number; title: string; length?: number; "artist-credit"?: Credit[]; recording?: { id: string; title?: string; length?: number } }[]
  }[]
}

/** An artist credit as main artists and featured guests ("A & B feat. C"). */
export function splitCredit(credit: Credit[] | undefined): { artists: string[]; featuring: string[] } {
  const artists: string[] = []
  const featuring: string[] = []
  let feat = false
  for (const c of credit ?? []) {
    ;(feat ? featuring : artists).push(c.name)
    if (/\b(?:feat\.?|ft\.?|featuring|with)\b/i.test(c.joinphrase ?? "")) feat = true
  }
  return { artists, featuring }
}

const creditText = (credit: Credit[] | undefined) => (credit ?? []).map((c) => c.name + (c.joinphrase ?? "")).join("").trim()

const yearOf = (date?: string) => {
  const y = Number(date?.slice(0, 4))
  return y > 1900 && y < 2100 ? y : undefined
}

/** A MusicBrainz release in full (kept for a month: releases rarely change). */
export async function mbAlbumRelease(id: string, signal?: AbortSignal): Promise<AlbumRelease | null> {
  const r = await httpJson<MbReleaseFull>(`https://musicbrainz.org/ws/2/release/${id}?inc=recordings+artist-credits+labels+release-groups+genres&fmt=json`, {
    signal,
    ttlMs: 30 * 86400_000,
  })
  if (!r?.id) return null
  const media = r.media ?? []
  const tracks: AlbumReleaseTrack[] = media.flatMap((m, i) =>
    (m.tracks ?? []).map((t) => {
      const credit = splitCredit(t["artist-credit"])
      const length = t.length ?? t.recording?.length
      return {
        disc: m.position ?? i + 1,
        number: t.number ?? String(t.position ?? ""),
        title: t.title,
        artists: credit.artists,
        featuring: credit.featuring,
        ...(length ? { length: Math.round(length / 1000) } : {}),
        ...(t.recording?.id ? { recordingId: t.recording.id } : {}),
      }
    })
  )
  const group = r["release-group"] ?? {}
  const genres = [...(r.genres ?? []), ...(group.genres ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).map((g) => g.name)
  const label = r["label-info"]?.find((l) => l.label?.name)
  return {
    source: "musicbrainz",
    id: r.id,
    groupId: group.id,
    url: `https://musicbrainz.org/release/${r.id}`,
    title: r.title,
    artist: creditText(r["artist-credit"]),
    year: yearOf(r.date),
    date: r.date,
    country: r.country,
    label: label?.label?.name,
    catno: label?.["catalog-number"],
    kind: mbKind(group["primary-type"], group["secondary-types"] ?? []),
    status: r.status,
    discs: Math.max(1, media.length),
    tracks,
    // Cover Art Archive has a front cover for this release.
    ...(r["cover-art-archive"]?.front !== false ? { artwork: `https://coverartarchive.org/release/${r.id}/front-1200` } : {}),
    genres: [...new Set(genres)],
  }
}

interface MbReleaseHit {
  id: string
  score?: number
  title: string
  status?: string
  date?: string
  "track-count"?: number
  "artist-credit"?: Credit[]
  "release-group"?: { "primary-type"?: string; "secondary-types"?: string[] }
}

/**
 * Find the album on MusicBrainz by its name and artist, when no track's hits
 * named a release: an official album of about as many tracks as the folder holds.
 */
export async function mbFindAlbum(title: string, artist: string | undefined, trackCount: number, signal?: AbortSignal): Promise<string | null> {
  const esc = (s: string) => s.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1")
  const q = [`release:"${esc(title)}"`, ...(artist && !/^various/i.test(artist) ? [`artist:"${esc(artist)}"`] : [])].join(" AND ")
  const j = await httpJson<{ releases?: MbReleaseHit[] }>(`https://musicbrainz.org/ws/2/release?query=${encodeURIComponent(q)}&fmt=json&limit=15`, { signal, ttlMs: 7 * 86400_000 })
  const fits = (j?.releases ?? []).filter(
    (r) => (r.score ?? 0) >= 85 && titleSimilarity(r.title, title) >= 0.9 && (!artist || /^various/i.test(artist) || normArtist(creditText(r["artist-credit"])).includes(normArtist(artist).split(" ")[0] ?? ""))
  )
  const rank = (r: MbReleaseHit) =>
    (r.status === "Official" ? 0 : 4) +
    // a track or two short of the release is a fine fit; far fewer means a different edition
    Math.min(6, Math.abs((r["track-count"] ?? trackCount) - trackCount) / 2) +
    (normTitle(r.title) === normTitle(title) ? 0 : 1) +
    (Number(r.date?.slice(0, 4)) || 9999) / 100_000
  return fits.sort((a, b) => rank(a) - rank(b))[0]?.id ?? null
}

/** A Discogs release as an album release. */
export async function discogsAlbumRelease(id: number, settings: Settings, signal?: AbortSignal): Promise<AlbumRelease | null> {
  const rel = await discogsRelease(id, settings.sources.discogs?.apiKey, signal)
  if (!rel) return null
  const view = releaseView(rel)
  const rows = discogsTracks(rel)
  let disc = 1
  const tracks: AlbumReleaseTrack[] = view.tracks.map((t, i) => {
    const pos = t.position
    const m = pos.match(/^(?:cd|dis[ck])?\s?(\d{1,2})\s?[-.]\s?(\d{1,3})$/i)
    const side = pos.match(/^([a-h])/i)?.[1]
    disc = m ? Number(m[1]) : side ? Math.floor("ABCDEFGH".indexOf(side.toUpperCase()) / 2) + 1 : disc
    const credit = rows[i]?.artists?.length ? rows[i].artists! : (rel.artists ?? [])
    return {
      disc,
      number: m ? String(Number(m[2])) : pos || String(i + 1),
      title: t.title,
      artists: credit.map((a) => cleanArtistName(a.name)).filter((a) => !/^various$/i.test(a)),
      featuring: [],
      ...(t.duration ? { length: t.duration } : {}),
    }
  })
  return {
    source: "discogs",
    id: String(rel.id),
    url: view.url,
    title: view.title,
    artist: /^various/i.test(view.artist) ? "Various Artists" : view.artist,
    year: view.year,
    date: view.released,
    country: view.country,
    label: view.label,
    catno: view.catno,
    kind: view.kind,
    discs: Math.max(1, ...tracks.map((t) => t.disc)),
    tracks,
    artwork: view.artwork,
    genres: view.genres,
  }
}

/** "musicbrainz:<id>" or "discogs:<id>" in full. */
export async function albumRelease(ref: string, settings: Settings, signal?: AbortSignal): Promise<AlbumRelease | null> {
  const [source, id] = ref.split(":")
  if (source === "musicbrainz" && id) return mbAlbumRelease(id, signal)
  if (source === "discogs" && /^\d+$/.test(id ?? "")) return discogsAlbumRelease(Number(id), settings, signal)
  return null
}
