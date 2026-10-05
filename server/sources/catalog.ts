// Mainstream catalogue APIs: MusicBrainz, Discogs, Last.fm, Spotify,
// Apple Music (iTunes Search) and Deezer.

import type { Candidate, ReleaseInfo, ReleasePosition } from "../../shared/types"
import { releasePosition } from "../core/discs"
import { titleSimilarity } from "../core/normalize"
import { discogsKind, isOwnRelease, mbKind, spotifyKind } from "../core/releases"
import { HttpError, httpJson } from "./http"
import { cleanArtistName, enc, yearOf, type SourceAdapter, type SourceQuery } from "./types"

function luceneEscape(s: string) {
  return s.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1")
}

// ---------- MusicBrainz ----------

interface MbRecording {
  id: string
  score?: number
  title: string
  length?: number
  "first-release-date"?: string
  "artist-credit"?: { name: string; joinphrase?: string; artist?: { id?: string; name: string } }[]
  releases?: MbRelease[]
  tags?: { name: string; count?: number }[]
}

interface MbRelease {
  id?: string
  title: string
  date?: string
  status?: string
  country?: string
  "artist-credit"?: { name: string; artist?: { name: string } }[]
  "release-group"?: { id?: string; "primary-type"?: string; "secondary-types"?: string[] }
  /** the medium this recording is on, with the track's place on it */
  media?: { position?: number; format?: string; track?: { number?: string; position?: number }[] }[]
  "medium-count"?: number
}

/** Where the recording sits on a MusicBrainz release: its track number ("5", "A2") and disc. */
function mbPosition(rel: MbRelease): ReleasePosition | undefined {
  const medium = rel.media?.[0]
  const track = medium?.track?.[0]
  return releasePosition(track?.number ?? track?.position, medium?.position, rel["medium-count"]) ?? undefined
}

/** A recording's releases as ReleaseInfo, each typed by its release group. */
function mbReleases(r: MbRecording, artists: string[]): ReleaseInfo[] {
  return (r.releases ?? []).map((rel): ReleaseInfo => {
    const group = rel["release-group"] ?? {}
    const credit = rel["artist-credit"]?.map((c) => c.name)
    return {
      source: "musicbrainz",
      title: rel.title,
      kind: mbKind(group["primary-type"], group["secondary-types"] ?? []),
      // Without a credit of its own, a release is credited like its recording.
      own: credit?.length ? isOwnRelease(credit, artists) : null,
      id: rel.id,
      groupId: group.id,
      status: rel.status,
      date: rel.date,
      country: rel.country,
      typeText: [group["primary-type"], ...(group["secondary-types"] ?? [])].filter(Boolean).join(" + ") || undefined,
      recordingId: r.id,
      length: r.length ? r.length / 1000 : undefined,
      position: mbPosition(rel),
    }
  })
}

export const musicbrainz: SourceAdapter = {
  id: "musicbrainz",
  label: "MusicBrainz",
  unavailable: () => null,
  async search(q, { signal }) {
    if (!q.title || q.descriptiveTitle) return []
    const parts = [`recording:"${luceneEscape(q.title)}"`]
    if (q.artist) parts.push(`artist:"${luceneEscape(q.artists[0] ?? q.artist)}"`)
    const url = `https://musicbrainz.org/ws/2/recording?query=${enc(parts.join(" AND "))}&fmt=json&limit=8`
    const j = await httpJson<{ recordings?: MbRecording[] }>(url, { signal })
    return (j?.recordings ?? []).map((r): Candidate => {
      const credits = r["artist-credit"] ?? []
      const releases = mbReleases(
        r,
        credits.map((c) => c.name)
      )
      return {
        source: "musicbrainz",
        sourceLabel: "MusicBrainz",
        artist: credits.map((c) => c.name + (c.joinphrase ?? "")).join("").trim(),
        artists: credits.map((c) => c.name),
        title: r.title,
        album: r.releases?.[0]?.title,
        position: r.releases?.[0] ? mbPosition(r.releases[0]) : undefined,
        year: yearOf(r["first-release-date"] ?? r.releases?.[0]?.date),
        duration: r.length ? r.length / 1000 : undefined,
        url: `https://musicbrainz.org/recording/${r.id}`,
        externalId: r.id,
        ids: {
          mbRecordingId: r.id,
          mbReleaseId: r.releases?.[0]?.id,
          mbArtistIds: credits.map((c) => c.artist?.id).filter((id): id is string => !!id),
        },
        sourceScore: r.score !== undefined ? r.score / 100 : undefined,
        // Cover Art Archive answers 404 when a release has no front cover; the fetcher moves on.
        artwork: r.releases?.[0]?.id ? `https://coverartarchive.org/release/${r.releases[0].id}/front-1200` : undefined,
        releases,
        genres: r.tags?.length ? [...r.tags].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).map((t) => t.name) : undefined,
        country: r.releases?.[0]?.country,
      }
    })
  },
}

// ---------- Discogs ----------

interface DiscogsSearch {
  results?: { id: number; type: string; title: string; year?: string; label?: string[]; genre?: string[]; style?: string[]; uri?: string }[]
}
export interface DiscogsRelease {
  id: number
  title: string
  year?: number
  uri?: string
  country?: string
  released?: string
  formats?: { name: string; descriptions?: string[] }[]
  artists?: { name: string; join?: string }[]
  labels?: { name: string }[]
  genres?: string[]
  styles?: string[]
  images?: { type?: string; uri?: string }[]
  tracklist?: { title: string; position?: string; duration?: string; type_?: string; artists?: { name: string; join?: string }[] }[]
}

/** Where a track sits on a Discogs release ("A2", "3", "1-05"), with how many discs its tracklist runs to. */
function discogsPosition(rel: DiscogsRelease, position?: string): ReleasePosition | undefined {
  const discs = new Set((rel.tracklist ?? []).map((t) => releasePosition(t.position)?.disc).filter((d): d is number => !!d))
  return releasePosition(position, undefined, discs.size > 1 ? discs.size : undefined) ?? undefined
}

function discogsDuration(d?: string) {
  const m = d?.match(/^(\d+):(\d{2})$/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined
}

function joinDiscogsArtists(list: { name: string; join?: string }[]) {
  return list
    .map((a, i) => cleanArtistName(a.name) + (i < list.length - 1 ? ` ${a.join?.trim() || "&"} ` : ""))
    .join("")
    .replace(/\s+,/g, ",")
    .trim()
}

export const discogs: SourceAdapter = {
  id: "discogs",
  label: "Discogs",
  unavailable: ({ cfg }) => (cfg.apiKey ? null : "needs a personal access token"),
  async search(q, { cfg, signal }) {
    if (!q.title || q.descriptiveTitle) return []
    const headers = { authorization: `Discogs token=${cfg.apiKey}` }
    const params = new URLSearchParams({ type: "release", per_page: "5", track: q.title })
    if (q.artist) params.set("artist", q.artists[0] ?? q.artist)
    const found = await httpJson<DiscogsSearch>(`https://api.discogs.com/database/search?${params}`, { headers, signal })
    const out: Candidate[] = []
    // The search only returns releases; open the top two to find the actual track.
    for (const r of (found?.results ?? []).slice(0, 2)) {
      const rel = await discogsRelease(r.id, cfg.apiKey!, signal)
      const hit = rel && releaseCandidate(rel, q.title, { source: "discogs", label: "Discogs", year: yearOf(r.year) })
      if (hit) out.push(hit)
    }
    return out
  },
}

/** A release in full (cached for a month: releases rarely change). */
export function discogsRelease(id: number, token: string, signal?: AbortSignal) {
  return httpJson<DiscogsRelease>(`https://api.discogs.com/releases/${id}`, { headers: { authorization: `Discogs token=${token}` }, signal, ttlMs: 30 * 86400_000 })
}

/** The release's track that best matches `title`, as a candidate (null when none is close enough). */
export function releaseCandidate(rel: DiscogsRelease, title: string, opts: { source: Candidate["source"]; label: string; year?: number; minSimilarity?: number }): Candidate | null {
  if (!rel.tracklist?.length) return null
  const best = rel.tracklist
    .filter((t) => (t.type_ ?? "track") === "track")
    .map((t) => ({ t, sim: titleSimilarity(t.title, title) }))
    .sort((a, b) => b.sim - a.sim)[0]
  if (!best || best.sim < (opts.minSimilarity ?? 0.5)) return null
  const credits = best.t.artists?.length ? best.t.artists : (rel.artists ?? [])
  return {
    source: opts.source,
    sourceLabel: opts.label,
    artist: joinDiscogsArtists(credits),
    artists: credits.map((a) => cleanArtistName(a.name)),
    title: best.t.title,
    album: rel.title,
    position: discogsPosition(rel, best.t.position),
    year: rel.year || opts.year,
    label: rel.labels?.[0]?.name,
    genre: [...(rel.genres ?? []), ...(rel.styles ?? [])].join(", ") || undefined,
    genres: [...(rel.genres ?? []), ...(rel.styles ?? [])],
    country: rel.country,
    duration: discogsDuration(best.t.duration),
    url: rel.uri ?? `https://www.discogs.com/release/${rel.id}`,
    externalId: String(rel.id),
    ids: { discogsReleaseId: String(rel.id) },
    artwork: (rel.images?.find((i) => i.type === "primary") ?? rel.images?.[0])?.uri || undefined,
    releases: [{ ...discogsReleaseInfo(rel, credits.map((a) => cleanArtistName(a.name)), discogsDuration(best.t.duration)), position: discogsPosition(rel, best.t.position) }],
  }
}

/** A Discogs release as ReleaseInfo, typed by its format descriptions. */
export function discogsReleaseInfo(rel: DiscogsRelease, trackArtists: string[], length?: number): ReleaseInfo {
  const descriptions = (rel.formats ?? []).flatMap((f) => f.descriptions ?? [])
  const names = (rel.formats ?? []).map((f) => f.name)
  return {
    source: "discogs",
    title: rel.title,
    kind: discogsKind(descriptions, names),
    own: isOwnRelease(rel.artists?.map((a) => cleanArtistName(a.name)), trackArtists),
    id: String(rel.id),
    date: rel.released || (rel.year ? String(rel.year) : undefined),
    country: rel.country,
    label: rel.labels?.[0]?.name,
    typeText: [...names, ...descriptions].join(", ") || undefined,
    length,
  }
}

// ---------- Last.fm ----------

export const lastfm: SourceAdapter = {
  id: "lastfm",
  label: "Last.fm",
  unavailable: ({ cfg }) => (cfg.apiKey ? null : "needs an API key"),
  async search(q, { cfg, signal }) {
    if (!q.title || q.descriptiveTitle) return []
    const params = new URLSearchParams({ method: "track.search", track: q.title, api_key: cfg.apiKey!, format: "json", limit: "8" })
    if (q.artist) params.set("artist", q.artists[0] ?? q.artist)
    const j = await httpJson<{ results?: { trackmatches?: { track?: { name: string; artist: string; url: string; listeners?: string }[] } } }>(
      `https://ws.audioscrobbler.com/2.0/?${params}`,
      { signal }
    )
    const tracks = j?.results?.trackmatches?.track ?? []
    const maxListeners = Math.max(1, ...tracks.map((t) => Number(t.listeners ?? 0)))
    return tracks.map((t) => ({
      source: "lastfm" as const,
      sourceLabel: "Last.fm",
      artist: t.artist,
      title: t.name,
      url: t.url,
      sourceScore: Number(t.listeners ?? 0) / maxListeners,
    }))
  },
}

// ---------- Spotify ----------

let spotifyToken: { value: string; expires: number; key: string } | null = null

/** Sign in again next time (the token was refused, or tests). */
export function forgetSpotifyToken() {
  spotifyToken = null
}

async function spotifyAuth(id: string, secret: string, signal?: AbortSignal) {
  if (spotifyToken && spotifyToken.key === id && spotifyToken.expires > Date.now() + 30_000) return spotifyToken.value
  // Through the polite client: a timeout, the log, and no hanging when Spotify says to wait.
  const j = await httpJson<{ access_token: string; expires_in: number }>("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    ttlMs: 0,
    signal,
  }).catch((err) => {
    throw new Error(`Spotify sign-in failed: ${err instanceof Error ? err.message : String(err)}`)
  })
  if (!j?.access_token) throw new Error("Spotify sign-in failed: no token came back")
  spotifyToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1000, key: id }
  return j.access_token
}

export const spotify: SourceAdapter = {
  id: "spotify",
  label: "Spotify",
  unavailable: ({ cfg }) => (cfg.apiKey && cfg.apiSecret ? null : "needs a client ID and secret"),
  async search(q, { cfg, signal }) {
    if (!q.title || q.descriptiveTitle) return []
    const token = await spotifyAuth(cfg.apiKey!, cfg.apiSecret!, signal)
    const query = q.artist ? `track:${q.title} artist:${q.artists[0] ?? q.artist}` : q.title
    const j = await httpJson<{
      tracks?: {
        items?: {
          id: string
          name: string
          popularity?: number
          duration_ms: number
          track_number?: number
          disc_number?: number
          artists: { name: string }[]
          album: { name: string; album_type?: string; artists?: { name: string }[]; release_date?: string; images?: { url: string; width?: number }[] }
          external_urls?: { spotify?: string }
        }[]
      }
    }>(`https://api.spotify.com/v1/search?type=track&limit=8&q=${enc(query)}`, { headers: { authorization: `Bearer ${token}` }, signal }).catch((err) => {
      // A token Spotify no longer takes: sign in afresh for the next track.
      if (err instanceof HttpError && err.status === 401) forgetSpotifyToken()
      throw err
    })
    return (j?.tracks?.items ?? []).map((t) => ({
      source: "spotify" as const,
      sourceLabel: "Spotify",
      artist: t.artists.map((a) => a.name).join(", "),
      artists: t.artists.map((a) => a.name),
      title: t.name,
      album: t.album.name,
      position: releasePosition(t.track_number, t.disc_number) ?? undefined,
      year: yearOf(t.album.release_date),
      duration: t.duration_ms / 1000,
      url: t.external_urls?.spotify,
      externalId: t.id,
      sourceScore: t.popularity !== undefined ? t.popularity / 100 : undefined,
      artwork: t.album.images?.[0]?.url,
      releases: [
        {
          source: "spotify" as const,
          title: t.album.name,
          kind: spotifyKind(t.album.album_type),
          own: isOwnRelease(
            t.album.artists?.map((a) => a.name),
            t.artists.map((a) => a.name)
          ),
          date: t.album.release_date,
          typeText: t.album.album_type,
          length: t.duration_ms / 1000,
          position: releasePosition(t.track_number, t.disc_number) ?? undefined,
        },
      ],
    }))
  },
}

// ---------- Apple Music / iTunes Search ----------

export const itunes: SourceAdapter = {
  id: "itunes",
  label: "Apple Music",
  unavailable: () => null,
  async search(q, { signal }) {
    if (q.descriptiveTitle && !q.artist) return []
    const term = q.descriptiveTitle ? q.artist : q.query
    const j = await httpJson<{
      results?: {
        trackId: number
        trackName: string
        artistName: string
        collectionName?: string
        releaseDate?: string
        trackTimeMillis?: number
        trackViewUrl?: string
        primaryGenreName?: string
        artworkUrl100?: string
        trackNumber?: number
        discNumber?: number
        discCount?: number
      }[]
    }>(`https://itunes.apple.com/search?media=music&entity=song&limit=10&term=${enc(term)}`, { signal })
    return (j?.results ?? []).map((r) => ({
      source: "itunes" as const,
      sourceLabel: "Apple Music",
      artist: r.artistName,
      title: r.trackName,
      album: r.collectionName,
      position: releasePosition(r.trackNumber, r.discNumber, r.discCount) ?? undefined,
      year: yearOf(r.releaseDate),
      genre: r.primaryGenreName,
      genres: r.primaryGenreName ? [r.primaryGenreName] : undefined,
      duration: r.trackTimeMillis ? r.trackTimeMillis / 1000 : undefined,
      url: r.trackViewUrl,
      externalId: String(r.trackId),
      // The search returns a 100px thumbnail; the same path serves any size.
      artwork: r.artworkUrl100?.replace(/\/\d+x\d+bb\./, "/1000x1000bb."),
    }))
  },
}

// ---------- Deezer ----------

interface DeezerTrack {
  id: number
  title: string
  title_short?: string
  duration?: number
  link?: string
  rank?: number
  artist: { name: string }
  album?: { title: string; cover_xl?: string; cover_big?: string }
}

export const deezer: SourceAdapter = {
  id: "deezer",
  label: "Deezer",
  unavailable: () => null,
  async search(q, { signal }) {
    if (!q.title || q.descriptiveTitle) return []
    const advanced = q.artist ? `artist:"${q.artists[0] ?? q.artist}" track:"${q.title}"` : q.title
    let j = await httpJson<{ data?: DeezerTrack[] }>(`https://api.deezer.com/search?limit=10&q=${enc(advanced)}`, { signal })
    if (!j?.data?.length && q.artist) {
      j = await httpJson<{ data?: DeezerTrack[] }>(`https://api.deezer.com/search?limit=10&q=${enc(q.query)}`, { signal })
    }
    return (j?.data ?? []).map((t) => ({
      source: "deezer" as const,
      sourceLabel: "Deezer",
      artist: t.artist.name,
      title: t.title,
      album: t.album?.title,
      duration: t.duration,
      url: t.link,
      externalId: String(t.id),
      artwork: t.album?.cover_xl ?? t.album?.cover_big,
    }))
  },
}

export function mainstreamSources(): SourceAdapter[] {
  return [musicbrainz, discogs, lastfm, spotify, itunes, deezer]
}

export type { SourceQuery }
