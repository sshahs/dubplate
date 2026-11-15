// An artist's genres, from the music databases rather than the AI's memory.
// Most hits for a recording carry no genre (Spotify, Deezer and Last.fm's track
// search don't, and MusicBrainz often has none on a UK rap recording), and a
// small model asked to fill the gap guesses - usually whatever genre the
// collection is mostly. The artist's own genres on MusicBrainz (free, no key)
// are a much surer answer: "uk hip hop", "grime", "uk drill" for a UK rapper.
// Last.fm's top tags for the artist stand in where MusicBrainz has none, when
// a Last.fm key is set. Answers are kept in the database, so each artist is
// asked about once; scoring then reads them without the network.

import type { Settings } from "../../shared/types"
import { isPlaceholder } from "../../shared/fields"
import { normArtist } from "../core/normalize"
import { getDb, parseJson } from "../db"
import { httpJson } from "./http"

export interface ArtistGenres {
  /** the artist as asked about */
  artist: string
  /** most-used first, as the source words them */
  genres: string[]
  /** "MusicBrainz" or "Last.fm" */
  source: string
}

/** Found genres are kept 90 days; an artist with none is asked again after 14. */
const KEEP_FOUND_MS = 90 * 86400_000
const KEEP_NONE_MS = 14 * 86400_000

type Row = { key: string; name: string; genres_json: string; source: string | null; fetched_at: string }

const keyOf = (name: string) => normArtist(name)

function cached(name: string): Row | null {
  const key = keyOf(name)
  if (!key) return null
  return (getDb().prepare("SELECT * FROM artist_genres WHERE key = ?").get(key) as Row | undefined) ?? null
}

function fresh(r: Row): boolean {
  const age = Date.now() - Date.parse(`${r.fetched_at.replace(" ", "T")}Z`)
  const genres = parseJson<string[]>(r.genres_json, [])
  return age < (genres.length ? KEEP_FOUND_MS : KEEP_NONE_MS)
}

function store(name: string, genres: string[], source: string | null) {
  getDb()
    .prepare(
      `INSERT INTO artist_genres (key, name, genres_json, source, fetched_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET name = excluded.name, genres_json = excluded.genres_json, source = excluded.source, fetched_at = excluded.fetched_at`
    )
    .run(keyOf(name), name, JSON.stringify(genres), source)
}

/** The first of these artists whose genres are known (from the database only: no network). */
export function knownArtistGenres(artists: string[]): ArtistGenres | null {
  for (const a of artists) {
    const r = cached(a)
    const genres = r ? parseJson<string[]>(r.genres_json, []) : []
    if (r && genres.length) return { artist: a, genres, source: r.source ?? "MusicBrainz" }
  }
  return null
}

/** Whether these artists still need asking about (none known, and not asked lately). */
export function needsArtistGenres(artists: string[]): boolean {
  if (!artists.length || knownArtistGenres(artists)) return false
  return artists.some((a) => {
    const r = cached(a)
    return !r || !fresh(r)
  })
}

interface MbArtist {
  id: string
  name: string
  score?: number
  country?: string
  aliases?: { name: string }[]
  genres?: { name: string; count?: number }[]
}

/** MusicBrainz's artist for a name: the one exact match, or among several the one from `country`. */
async function mbArtistId(name: string, country: string | undefined, signal?: AbortSignal): Promise<string | null> {
  const q = `artist:"${name.replace(/(["\\])/g, "\\$1")}"`
  const j = await httpJson<{ artists?: MbArtist[] }>(`https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(q)}&fmt=json&limit=8`, { signal, ttlMs: 30 * 86400_000 })
  const want = normArtist(name)
  const exact = (j?.artists ?? []).filter((a) => (a.score ?? 0) >= 90 && (normArtist(a.name) === want || a.aliases?.some((x) => normArtist(x.name) === want)))
  if (exact.length === 1) return exact[0].id
  // Several with the same name (there's more than one "Dave"): only the one from the right country, if that settles it.
  const local = country ? exact.filter((a) => a.country === country) : []
  return local.length === 1 ? local[0].id : null
}

async function fromMusicBrainz(name: string, mbid: string | undefined, country: string | undefined, signal?: AbortSignal): Promise<string[]> {
  const id = mbid ?? (await mbArtistId(name, country, signal))
  if (!id) return []
  const a = await httpJson<MbArtist>(`https://musicbrainz.org/ws/2/artist/${id}?inc=genres&fmt=json`, { signal, ttlMs: 30 * 86400_000 })
  return [...(a?.genres ?? [])]
    .filter((g) => (g.count ?? 0) > 0)
    .sort((x, y) => (y.count ?? 0) - (x.count ?? 0))
    .map((g) => g.name)
}

/** Last.fm tags that aren't genres. */
const NOT_GENRES =
  /^(?:seen live|favou?rites?|favou?rite artists?|british|english|uk|united kingdom|london|american|usa|us|jamaican|jamaica|male vocalists?|female vocalists?|rapper|singer|songwriter|singer-songwriter|my music|love|awesome|beautiful|chill|\d{2,4}s?|all)$/i

async function fromLastfm(name: string, key: string, signal?: AbortSignal): Promise<string[]> {
  const params = new URLSearchParams({ method: "artist.gettoptags", artist: name, api_key: key, format: "json", autocorrect: "1" })
  const j = await httpJson<{ toptags?: { tag?: { name: string; count?: number }[] } }>(`https://ws.audioscrobbler.com/2.0/?${params}`, { signal, ttlMs: 30 * 86400_000 })
  return (j?.toptags?.tag ?? [])
    .filter((t) => (t.count ?? 0) >= 10 && !NOT_GENRES.test(t.name.trim()) && !isPlaceholder("genre", t.name))
    .slice(0, 8)
    .map((t) => t.name.toLowerCase())
}

/** Whether genres can be looked up at all with these settings. */
export function canLookUpGenres(settings: Settings): boolean {
  return !!settings.sources.musicbrainz?.enabled || !!(settings.sources.lastfm?.enabled && settings.sources.lastfm.apiKey)
}

/**
 * Ask about each artist not known yet (MusicBrainz, then Last.fm), and keep the
 * answer. `mbids` are MusicBrainz artist IDs a hit already gave, by name.
 */
export async function lookUpArtistGenres(
  artists: string[],
  settings: Settings,
  opts: { mbids?: Map<string, string>; country?: string; signal?: AbortSignal } = {}
): Promise<ArtistGenres | null> {
  for (const name of artists) {
    if (opts.signal?.aborted) return null
    const r = cached(name)
    if (r) {
      const known = parseJson<string[]>(r.genres_json, [])
      if (known.length) return { artist: name, genres: known, source: r.source ?? "MusicBrainz" }
      if (fresh(r)) continue
    }
    let genres: string[] = []
    let source: string | null = null
    // A source that couldn't be reached isn't an answer: nothing is kept, so it's asked again next time.
    let failed = false
    const ask = (p: Promise<string[]>) =>
      p.catch(() => {
        failed = true
        return [] as string[]
      })
    if (settings.sources.musicbrainz?.enabled) {
      genres = await ask(fromMusicBrainz(name, opts.mbids?.get(normArtist(name)), opts.country, opts.signal))
      if (genres.length) source = "MusicBrainz"
    }
    const lastfm = settings.sources.lastfm
    if (!genres.length && lastfm?.enabled && lastfm.apiKey) {
      genres = await ask(fromLastfm(name, lastfm.apiKey, opts.signal))
      if (genres.length) source = "Last.fm"
    }
    if (failed && !genres.length) continue
    if (opts.signal?.aborted) return null
    store(name, genres, source)
    if (genres.length) return { artist: name, genres, source: source! }
  }
  return null
}
