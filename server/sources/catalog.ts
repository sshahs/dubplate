// Mainstream catalogue APIs: MusicBrainz, Discogs, Last.fm, Spotify,
// Apple Music (iTunes Search) and Deezer.

import type { Candidate } from "../../shared/types"
import { titleSimilarity } from "../core/normalize"
import { httpJson } from "./http"
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
  releases?: { id?: string; title: string; date?: string }[]
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
      return {
        source: "musicbrainz",
        sourceLabel: "MusicBrainz",
        artist: credits.map((c) => c.name + (c.joinphrase ?? "")).join("").trim(),
        artists: credits.map((c) => c.name),
        title: r.title,
        album: r.releases?.[0]?.title,
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
      }
    })
  },
}

// ---------- Discogs ----------

interface DiscogsSearch {
  results?: { id: number; type: string; title: string; year?: string; label?: string[]; genre?: string[]; style?: string[]; uri?: string }[]
}
interface DiscogsRelease {
  id: number
  title: string
  year?: number
  uri?: string
  artists?: { name: string; join?: string }[]
  labels?: { name: string }[]
  genres?: string[]
  styles?: string[]
  images?: { type?: string; uri?: string }[]
  tracklist?: { title: string; duration?: string; type_?: string; artists?: { name: string; join?: string }[] }[]
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
      const rel = await httpJson<DiscogsRelease>(`https://api.discogs.com/releases/${r.id}`, { headers, signal, ttlMs: 30 * 86400_000 })
      if (!rel?.tracklist?.length) continue
      const best = rel.tracklist
        .filter((t) => (t.type_ ?? "track") === "track")
        .map((t) => ({ t, sim: titleSimilarity(t.title, q.title) }))
        .sort((a, b) => b.sim - a.sim)[0]
      if (!best || best.sim < 0.5) continue
      const credits = best.t.artists?.length ? best.t.artists : (rel.artists ?? [])
      out.push({
        source: "discogs",
        sourceLabel: "Discogs",
        artist: joinDiscogsArtists(credits),
        artists: credits.map((a) => cleanArtistName(a.name)),
        title: best.t.title,
        album: rel.title,
        year: rel.year || yearOf(r.year),
        label: rel.labels?.[0]?.name,
        genre: [...(rel.genres ?? []), ...(rel.styles ?? [])].join(", ") || undefined,
        duration: discogsDuration(best.t.duration),
        url: rel.uri ?? `https://www.discogs.com/release/${rel.id}`,
        externalId: String(rel.id),
        ids: { discogsReleaseId: String(rel.id) },
        artwork: (rel.images?.find((i) => i.type === "primary") ?? rel.images?.[0])?.uri || undefined,
      })
    }
    return out
  },
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

async function spotifyAuth(id: string, secret: string, signal?: AbortSignal) {
  if (spotifyToken && spotifyToken.key === id && spotifyToken.expires > Date.now() + 30_000) return spotifyToken.value
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal,
  })
  if (!res.ok) throw new Error(`Spotify auth failed (${res.status})`)
  const j = (await res.json()) as { access_token: string; expires_in: number }
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
      tracks?: { items?: { id: string; name: string; popularity?: number; duration_ms: number; artists: { name: string }[]; album: { name: string; release_date?: string; images?: { url: string; width?: number }[] }; external_urls?: { spotify?: string } }[] }
    }>(`https://api.spotify.com/v1/search?type=track&limit=8&q=${enc(query)}`, { headers: { authorization: `Bearer ${token}` }, signal })
    return (j?.tracks?.items ?? []).map((t) => ({
      source: "spotify" as const,
      sourceLabel: "Spotify",
      artist: t.artists.map((a) => a.name).join(", "),
      artists: t.artists.map((a) => a.name),
      title: t.name,
      album: t.album.name,
      year: yearOf(t.album.release_date),
      duration: t.duration_ms / 1000,
      url: t.external_urls?.spotify,
      externalId: t.id,
      sourceScore: t.popularity !== undefined ? t.popularity / 100 : undefined,
      artwork: t.album.images?.[0]?.url,
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
      results?: { trackId: number; trackName: string; artistName: string; collectionName?: string; releaseDate?: string; trackTimeMillis?: number; trackViewUrl?: string; primaryGenreName?: string; artworkUrl100?: string }[]
    }>(`https://itunes.apple.com/search?media=music&entity=song&limit=10&term=${enc(term)}`, { signal })
    return (j?.results ?? []).map((r) => ({
      source: "itunes" as const,
      sourceLabel: "Apple Music",
      artist: r.artistName,
      title: r.trackName,
      album: r.collectionName,
      year: yearOf(r.releaseDate),
      genre: r.primaryGenreName,
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
