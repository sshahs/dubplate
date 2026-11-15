// Albums: the tracks of one record tagged together, approved with one OK.
//
// Each track is identified on its own, so the tracks of one album could come out
// with different album names, years, labels and covers (one track's best hit is
// the single, another's a compilation). Here the tracks of a record's folder are
// looked at together: the album most of them are on is found (from their hits,
// their tags or the folder's name), read in full from MusicBrainz or Discogs, and
// each file is placed on its tracklist. The album's name, album artist, year,
// label, genre, release, track numbers and cover are then the same on every track,
// and a person approves the whole album at once.

import path from "node:path"
import type { AlbumLock, AlbumOption, Candidate, AlbumProposal, AlbumProposalTrack, AlbumRelease, AlbumSummary, AlbumTrackMatch, ArtRef, FinalMeta, ReleaseInfo, Settings, SourceId, Track } from "../shared/types"
import { isPlaceholder } from "../shared/fields"
import { artBytes, fetchArt, storeArt } from "./art"
import { genreCase } from "./core/confidence"
import { decisionToFinal } from "./core/naming"
import { artistSimilarity, normArtist, normTitle, titleSimilarity } from "./core/normalize"
import { releaseRank } from "./core/releases"
import { getDb } from "./db"
import type { JobContext } from "./jobs"
import { scoreAndSave } from "./pipeline"
import { proposedFilename } from "./placement"
import { recordFolder, recordTrackIds } from "./positions"
import { getTrack, getTracks, listLibraries, updateTrack } from "./repo"
import { albumRelease, mbFindAlbum } from "./sources/album-release"

/** Folders bigger than this are collections, not one record: they're only grouped when a person says so. */
const MAX_AUTO_TRACKS = 80

// ---------- finding the albums ----------

type LightRow = { id: number; library_id: number; rel_dir: string; status: string; album: string | null; artist: string | null; locked: number; art_hash: string | null; found_hash: string | null }

/** The album name a track goes by now: what was approved, else what was proposed, else its tag. */
const ALBUM_SQL = `coalesce(json_extract(t.final_json, '$.album'), json_extract(d.decision_json, '$.album'), json_extract(t.tags_json, '$.album'))`
const ARTIST_SQL = `coalesce(json_extract(t.final_json, '$.artists[0]'), json_extract(d.decision_json, '$.artists[0]'), json_extract(t.tags_json, '$.artist'))`

/** The most common value and how many have it. */
function mode<T>(xs: T[], key: (x: T) => string = String): { value: T; n: number } | null {
  const counts = new Map<string, { value: T; n: number }>()
  for (const x of xs) {
    const k = key(x)
    if (!k) continue
    const e = counts.get(k) ?? { value: x, n: 0 }
    e.n++
    counts.set(k, e)
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0] ?? null
}

const folderTitle = (folder: string) =>
  path
    .basename(folder)
    .replace(/^\(?\d{4}\)?\s*[-–.]\s*/, "")
    .replace(/\s*[[(]\d{4}[\])]\s*$/, "")
    .replace(/\s*[[(](?:flac|mp3|320|v0|web|cd|vinyl)[^\])]*[\])]\s*/gi, " ")
    .trim()

/** The picture to show for an album: the cover found for it, else one its files have. */
function coverOf(list: LightRow[]): AlbumSummary["cover"] {
  const found = list.find((r) => r.found_hash)
  if (found) return { trackId: found.id, which: "found", hash: found.found_hash! }
  const own = list.find((r) => r.art_hash)
  return own ? { trackId: own.id, which: "current", hash: own.art_hash! } : null
}

/**
 * The folders that hold an album: two or more tracks of one record folder, most
 * of them going by one album name, or already kept together.
 */
export function listAlbums(): AlbumSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.library_id, t.rel_dir, t.status, ${ALBUM_SQL} AS album, ${ARTIST_SQL} AS artist,
              (t.album_json IS NOT NULL) AS locked, json_extract(t.art_json, '$.hash') AS art_hash, json_extract(t.art_found_json, '$.hash') AS found_hash
       FROM tracks t LEFT JOIN track_data d ON d.track_id = t.id
       WHERE t.missing = 0 AND t.aside_json IS NULL`
    )
    .all() as LightRow[]
  const libraries = new Map(listLibraries().map((l) => [l.id, l.name]))
  const groups = new Map<string, LightRow[]>()
  for (const r of rows) {
    const key = `${r.library_id}\0${recordFolder(r.rel_dir)}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const out: AlbumSummary[] = []
  for (const [key, list] of groups) {
    if (list.length < 2) continue
    const folder = key.split("\0")[1]
    const albums = list.map((r) => r.album).filter((a): a is string => !!a && !isPlaceholder("album", a))
    const top = mode(albums, normTitle)
    const locked = list.some((r) => r.locked)
    // At the top of a library, or most tracks naming different albums: a crate of singles, not a record.
    if (!locked && (!top || top.n < Math.max(2, Math.ceil(list.length * 0.6)))) continue
    const counts = { toApprove: 0, approved: 0, done: 0 }
    for (const r of list) {
      if (r.status === "approved") counts.approved++
      else if (r.status === "done") counts.done++
      else if (r.status !== "rejected") counts.toApprove++
    }
    out.push({
      libraryId: list[0].library_id,
      library: libraries.get(list[0].library_id) ?? "",
      folder,
      title: top?.value ?? (folderTitle(folder) || folder),
      artist: mode(list.map((r) => r.artist ?? "").filter(Boolean), normArtist)?.value ?? null,
      tracks: list.length,
      ...counts,
      locked,
      cover: coverOf(list),
    })
  }
  return out.sort((a, b) => Number(b.toApprove > 0) - Number(a.toApprove > 0) || a.title.localeCompare(b.title))
}

/** The tracks of the record a track belongs to. */
export function albumTrackIds(trackId: number): number[] {
  const t = getTrack(trackId)
  if (!t) return []
  return recordTrackIds(t.libraryId, recordFolder(t.relDir))
}

// ---------- the album the tracks are on ----------

/** Where the file says it sits: disc and number ("A2" on vinyl). */
function ownPlace(t: Track): { disc: number; number: string } | null {
  const p = t.heuristic?.position
  const disc = t.tags.disc ?? p?.disc ?? 1
  if (p?.side && p.number) return { disc, number: `${p.side}${p.number}` }
  const n = t.tags.track ?? p?.number
  return n ? { disc, number: String(n) } : null
}

const placeText = (t: Track) => {
  const p = ownPlace(t)
  return p ? (p.disc > 1 ? `${p.disc}-${p.number}` : p.number) : undefined
}

/** In disc and track order, then by name. */
function inOrder(tracks: Track[]): Track[] {
  const key = (t: Track) => {
    const p = ownPlace(t)
    const n = p ? Number(p.number.replace(/^[A-H]/i, "")) + ("ABCDEFGH".indexOf(p.number[0]?.toUpperCase()) + 1) * 100 : 9999
    return [p?.disc ?? 1, Number.isFinite(n) ? n : 9999] as const
  }
  return [...tracks].sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1] || a.filename.localeCompare(b.filename))
}

const reading = (t: Track) => t.final ?? (t.decision?.title ? t.decision : null) ?? t.ai ?? t.heuristic

/** Words that make a recording a different version of the song. */
const VERSION_WORDS = /\b(?:instrumentals?|inst|live|remix(?:es)?|rmx|dub|acapella|a cappella|vip|demo|karaoke|radio edit|extended|edit|mix|version|refix|bootleg|acoustic|session|freestyle)\b/gi
const versionWords = (s: string | undefined) => new Set((s ?? "").toLowerCase().match(VERSION_WORDS) ?? [])

/**
 * A hit is this track's recording, not another version of the song: no "instrumental",
 * "live" or "remix" in its title that the file doesn't say too. (A search for "Stop Dat"
 * also finds the instrumental, the live take and remixes, each on its own albums.)
 */
function sameVersion(c: Pick<Candidate, "title">, t: Track): boolean {
  // Only what the file itself says, or a person typed: never a name an album lock gave it.
  const typed = t.approvedBy === "person" ? t.final : null
  const own = [typed?.title, typed?.version, t.ai?.title, t.ai?.version, t.heuristic?.title, t.heuristic?.version, t.filename, t.original?.filename, (t.original?.tags ?? t.tags).title]
  const says = versionWords(own.filter(Boolean).join(" "))
  return [...versionWords(c.title)].every((w) => says.has(w))
}

interface OptionWork {
  key: string
  spellings: string[]
  covers: Set<number>
  sources: Set<string>
  releases: Map<string, { info: ReleaseInfo; covers: Set<number> }>
  rank: number
  fromTags: boolean
}

const SOURCE_LABEL: Partial<Record<SourceId, string>> = { musicbrainz: "MusicBrainz", discogs: "Discogs", itunes: "Apple Music", spotify: "Spotify", deezer: "Deezer", bandcamp: "Bandcamp" }

/** The albums the tracks could be on, the one most of them are on first. */
export function albumOptions(tracks: Track[], folder: string): { options: AlbumOption[]; covers: Map<string, Set<number>> } {
  const work = new Map<string, OptionWork>()
  const add = (t: Track, title: string | undefined, source: string, info?: ReleaseInfo) => {
    if (!title || isPlaceholder("album", title)) return
    const key = normTitle(title)
    if (!key) return
    const w: OptionWork = work.get(key) ?? { key, spellings: [], covers: new Set<number>(), sources: new Set<string>(), releases: new Map(), rank: 99, fromTags: false }
    w.spellings.push(title)
    w.covers.add(t.id)
    w.sources.add(source)
    if (source === "the tags" || source === "you") w.fromTags = true
    if (info) {
      w.rank = Math.min(w.rank, releaseRank(info))
      if (info.id && (info.source === "musicbrainz" || info.source === "discogs")) {
        const rk = `${info.source}:${info.id}`
        const r = w.releases.get(rk) ?? { info, covers: new Set<number>() }
        r.covers.add(t.id)
        w.releases.set(rk, r)
      }
    }
    work.set(key, w)
  }
  for (const t of tracks) {
    const original = t.original?.tags ?? t.tags
    add(t, t.final?.album, "you")
    add(t, original.album, "the tags")
    const d = t.decision
    if (!d) continue
    // The release its own decision chose (not one an album it's already kept with put there).
    if (d.release?.release && !d.release.reason.startsWith("the album ")) add(t, d.release.release.title, SOURCE_LABEL[d.release.release.source] ?? d.release.release.source, d.release.release)
    // Every release the hits on its recording are on (the album, the single, compilations…) - this version's only.
    for (const c of (d.clusters[0]?.candidates ?? []).filter((c) => sameVersion(c, t))) {
      for (const r of c.releases ?? []) add(t, r.title, c.sourceLabel, r)
      if (!c.releases?.length) add(t, c.album, c.sourceLabel)
    }
  }
  const total = tracks.length
  // The folder's own name ("Boy In Da Corner", "2003 - Boy In Da Corner") settles a tie.
  const folderKey = normTitle(folderTitle(folder))
  const list = [...work.values()]
    .filter((w) => w.covers.size >= Math.min(2, total))
    .sort(
      (a, b) =>
        b.covers.size - a.covers.size ||
        Number(b.fromTags) - Number(a.fromTags) ||
        Number(b.key === folderKey) - Number(a.key === folderKey) ||
        a.rank - b.rank ||
        a.key.localeCompare(b.key)
    )
  const covers = new Map<string, Set<number>>()
  const options: AlbumOption[] = list.slice(0, 6).map((w) => {
    covers.set(w.key, w.covers)
    // Which edition: of those most of its tracks are on, MusicBrainz first, then official, then the
    // original (the earliest), so the 2003 UK album rather than a later US release or a reissue.
    const most = Math.max(0, ...[...w.releases.values()].map((r) => r.covers.size))
    const best = [...w.releases.entries()]
      .filter(([, r]) => r.covers.size >= Math.ceil(most / 2))
      .sort(
        ([, a], [, b]) =>
          Number(b.info.source === "musicbrainz") - Number(a.info.source === "musicbrainz") ||
          Number(/official/i.test(b.info.status ?? "")) - Number(/official/i.test(a.info.status ?? "")) ||
          (a.info.date || "9999").localeCompare(b.info.date || "9999") ||
          b.covers.size - a.covers.size
      )[0]
    const title = best?.[1].info.title ?? mode(w.spellings, (s) => s)!.value
    const year = Number(best?.[1].info.date?.slice(0, 4)) || undefined
    return {
      key: w.key,
      title,
      ...(best?.[1].info.artist ? { albumArtist: best[1].info.artist } : {}),
      ...(year ? { year } : {}),
      ...(best?.[1].info.label ? { label: best[1].info.label } : {}),
      covers: w.covers.size,
      sources: [...w.sources],
      ...(best ? { release: best[0] } : {}),
    }
  })
  // Nothing names an album: the folder's own name, for a folder below the library's top.
  const named = folderTitle(folder)
  if (!options.length && folder && named) {
    options.push({ key: `folder:${normTitle(named)}`, title: named, covers: total, sources: ["the folder name"] })
    covers.set(`folder:${normTitle(named)}`, new Set(tracks.map((t) => t.id)))
  }
  return { options, covers }
}

/** Main artists most of the tracks share, else "Various Artists". */
function albumArtistOf(tracks: Track[]): string | undefined {
  const firsts = tracks.map((t) => reading(t)?.artists?.[0]).filter((a): a is string => !!a)
  const top = mode(firsts, normArtist)
  if (!top) return undefined
  return top.n >= Math.ceil(tracks.length * 0.6) ? top.value : "Various Artists"
}

/** Each file on the release's tracklist: by the recording its hits found, its title, or its place and length. */
export function matchToRelease(release: AlbumRelease, tracks: Track[]): AlbumTrackMatch[] {
  const pairs: { trackId: number; index: number; score: number; by: AlbumTrackMatch["by"] }[] = []
  for (const t of tracks) {
    const recordings = new Set(
      (t.decision?.clusters ?? [])
        .slice(0, 1)
        .flatMap((cl) => cl.candidates)
        .filter((c) => sameVersion(c, t))
        .flatMap((c) => [c.ids?.mbRecordingId, ...(c.releases ?? []).map((r) => r.recordingId)])
        .filter((x): x is string => !!x)
    )
    const r = reading(t)
    const titles = [r?.title, t.tags.title, t.heuristic?.cleaned].filter((x): x is string => !!x)
    const place = ownPlace(t)
    // Its name matches no track of the release ("Track 03", a typo'd rip): its place and length can place it.
    const namesNone = release.tracks.every((rt) => Math.max(0, ...titles.map((x) => titleSimilarity(rt.title, x))) < 0.85)
    release.tracks.forEach((rt, index) => {
      const samePlace = !!place && place.number.toUpperCase() === rt.number.toUpperCase() && (place.disc === rt.disc || release.discs === 1)
      const lengthOff = t.duration && rt.length ? Math.abs(t.duration - rt.length) : null
      const timing = lengthOff === null ? 0 : lengthOff <= 4 ? 0.3 : lengthOff > 30 ? -0.5 : 0
      if (rt.recordingId && recordings.has(rt.recordingId)) return pairs.push({ trackId: t.id, index, score: 4 + timing, by: "recording" })
      const sim = Math.max(0, ...titles.map((x) => titleSimilarity(rt.title, x)))
      const artistOk = !r?.artists?.length || !rt.artists.length || artistSimilarity(rt.artists, r.artists) >= 0.5
      if (sim >= 0.85 && artistOk) return pairs.push({ trackId: t.id, index, score: 2 + sim + timing + (samePlace ? 0.3 : 0), by: "title" })
      // A file with no usable name ("Track 01"): its place on the record and its length.
      if (samePlace && namesNone && (lengthOff === null || lengthOff <= 6)) pairs.push({ trackId: t.id, index, score: 1 + timing, by: "place" })
    })
  }
  const out = new Map<number, AlbumTrackMatch>(tracks.map((t) => [t.id, { trackId: t.id, index: null, by: null }]))
  const taken = new Set<number>()
  for (const p of pairs.sort((a, b) => b.score - a.score)) {
    if (out.get(p.trackId)!.index !== null || taken.has(p.index)) continue
    out.set(p.trackId, { trackId: p.trackId, index: p.index, by: p.by })
    taken.add(p.index)
  }
  return tracks.map((t) => out.get(t.id)!)
}

/** Cover addresses for the album, best first: the release's own, then the tracks' hits on that album. */
function artworkFor(tracks: Track[], title: string, release: AlbumRelease | null): string[] {
  const urls: string[] = []
  if (release?.artwork) urls.push(release.artwork)
  const order: SourceId[] = ["musicbrainz", "discogs", "bandcamp", "itunes", "deezer", "spotify"]
  const hits = tracks
    .flatMap((t) => t.decision?.clusters[0]?.candidates ?? [])
    .filter((c) => c.artwork && c.album && normTitle(c.album) === normTitle(title))
    .sort((a, b) => (order.indexOf(a.source) + 1 || 99) - (order.indexOf(b.source) + 1 || 99))
  for (const c of hits) if (!urls.includes(c.artwork!)) urls.push(c.artwork!)
  return urls.slice(0, 6)
}

/**
 * The tracks as one album: the ways to see it, the release it is (read in full from
 * MusicBrainz or Discogs, found by name on MusicBrainz when no hit named one), each
 * file's place on it, and the album's fields.
 */
export async function proposeAlbum(ids: number[], settings: Settings, opts: { option?: string; release?: string | null; signal?: AbortSignal } = {}): Promise<AlbumProposal> {
  const tracks = inOrder(getTracks(ids).filter((t) => !t.missing))
  if (!tracks.length) throw new Error("Pick the tracks of the album")
  const folder = recordFolder(tracks[0].relDir)
  const { options } = albumOptions(tracks, folder)
  const chosen = options.find((o) => o.key === opts.option) ?? options[0] ?? null
  let release: AlbumRelease | null = null
  let ref = opts.release === undefined ? (chosen?.release ?? null) : opts.release
  // No hit named the release: look the album up on MusicBrainz by its name and artist.
  if (!ref && opts.release === undefined && chosen && settings.sources.musicbrainz?.enabled) {
    const id = await mbFindAlbum(chosen.title, chosen.albumArtist ?? albumArtistOf(tracks), tracks.length, opts.signal).catch(() => null)
    if (id) ref = `musicbrainz:${id}`
  }
  if (ref) release = await albumRelease(ref, settings, opts.signal).catch(() => null)
  const matches = release ? matchToRelease(release, tracks) : tracks.map((t) => ({ trackId: t.id, index: null, by: null }))
  // One genre for the album: the release's, else the one most of its tracks have (none on a compilation).
  const albumArtist = release?.artist || chosen?.albumArtist || albumArtistOf(tracks)
  const various = /^various/i.test(albumArtist ?? "")
  const trackGenre = mode(tracks.map((t) => reading(t)?.genre ?? "").filter(Boolean), (g) => g.toLowerCase())
  const genre = various ? undefined : release?.genres.length ? genreCase(release.genres[0]) : trackGenre?.value
  const years = tracks.map((t) => reading(t)?.year).filter((y): y is number => !!y)
  const title = release?.title ?? chosen?.title ?? (folderTitle(folder) || "")
  const lock = tracks.every((t) => t.albumLock && t.albumLock.title === tracks[0].albumLock?.title) ? tracks[0].albumLock : null
  return {
    libraryId: tracks[0].libraryId,
    folder,
    tracks: tracks.map((t): AlbumProposalTrack => {
      const r = reading(t)
      return { id: t.id, filename: t.filename, status: t.status, confidence: t.confidence, artists: r?.artists ?? [], title: r?.title ?? "", duration: t.duration, ...(placeText(t) ? { place: placeText(t) } : {}) }
    }),
    options,
    chosen: chosen?.key ?? null,
    release,
    matches,
    fields: {
      title,
      ...(albumArtist ? { albumArtist } : {}),
      ...((release?.year ?? chosen?.year ?? (years.length ? Math.min(...years) : undefined)) ? { year: release?.year ?? chosen?.year ?? Math.min(...years) } : {}),
      ...((release?.label ?? chosen?.label) ? { label: release?.label ?? chosen?.label } : {}),
      ...(genre ? { genre } : {}),
    },
    artwork: artworkFor(tracks, title, release),
    lock,
  }
}

// ---------- putting it on the tracks ----------

export interface ApplyAlbum {
  trackIds: number[]
  /** "musicbrainz:<id>" / "discogs:<id>": the release, read again in full */
  release?: string | null
  fields: { title: string; albumArtist?: string; year?: number; label?: string; genre?: string }
  /** each file's track on the release (as proposed, or as the person changed it) */
  matches?: { trackId: number; index: number | null }[]
  /** the cover to put on every track */
  artworkUrl?: string | null
  /** the cover replaces each file's own picture */
  replaceArt?: boolean
  /** approve every track as it now reads */
  approve: boolean
  by: "person" | "auto"
}

export interface AlbumApplied {
  tracks: number
  approved: number
  /** couldn't be approved: no artist or title */
  skipped: number
  /** cut tracks whose details changed: back in Cut & Tag to be tagged again */
  recut: number
  art: ArtRef | null
}

/** The cover for the album: the one asked for, else the picture most of its files already share. */
async function albumArt(tracks: Track[], url: string | null | undefined, signal?: AbortSignal): Promise<ArtRef | null> {
  if (url) {
    const source: SourceId = /coverartarchive/.test(url) ? "musicbrainz" : /discogs/.test(url) ? "discogs" : /mzstatic|apple/.test(url) ? "itunes" : /deezer|dzcdn/.test(url) ? "deezer" : /scdn|spotify/.test(url) ? "spotify" : "bandcamp"
    return fetchArt(url, source, signal, SOURCE_LABEL[source]).catch(() => null)
  }
  const shared = mode(tracks.map((t) => t.art).filter((a): a is ArtRef => !!a), (a) => a.hash)
  if (!shared || shared.n < Math.ceil(tracks.length / 2)) return null
  // In the cache, so it can be written into the other files.
  const owner = tracks.find((t) => t.art?.hash === shared.value.hash)!
  const bytes = await artBytes(owner, shared.value)
  return bytes ? storeArt(bytes, "embedded") : null
}

const ALBUM_FIELDS = ["album", "albumArtist", "year", "label", "genre"] as const

/**
 * Keep the tracks together as one album: the album's details on each of them (the
 * release's track names and numbers where a file was placed on it), one cover for
 * all, and - when asked - every track approved in one go.
 */
export async function applyAlbum(input: ApplyAlbum, settings: Settings, signal?: AbortSignal): Promise<AlbumApplied> {
  const tracks = getTracks(input.trackIds).filter((t) => !t.missing)
  if (!tracks.length) throw new Error("Pick the tracks of the album")
  const title = input.fields.title?.trim()
  if (!title) throw new Error("The album needs a name")
  const release = input.release ? await albumRelease(input.release, settings, signal).catch(() => null) : null
  const matches = new Map((input.matches ?? (release ? matchToRelease(release, tracks) : [])).map((m) => [m.trackId, m.index]))
  const art = await albumArt(tracks, input.artworkUrl, signal)
  const info: ReleaseInfo | undefined = release
    ? {
        source: release.source,
        title: release.title,
        artist: release.artist,
        kind: release.kind,
        own: !/^various/i.test(release.artist),
        id: release.id,
        ...(release.groupId ? { groupId: release.groupId } : {}),
        ...(release.status ? { status: release.status } : {}),
        ...(release.date ? { date: release.date } : {}),
        ...(release.country ? { country: release.country } : {}),
        ...(release.label ? { label: release.label } : {}),
      }
    : undefined
  const at = new Date().toISOString()
  const result: AlbumApplied = { tracks: tracks.length, approved: 0, skipped: 0, recut: 0, art }
  for (const t of tracks) {
    // A person's album isn't undone by Dubplate keeping a folder together.
    if (input.by === "auto" && t.albumLock?.by === "person") continue
    const index = matches.get(t.id)
    const listed = release && index !== null && index !== undefined ? release.tracks[index] : undefined
    const lock: AlbumLock = {
      trackIds: tracks.map((x) => x.id),
      title,
      ...(input.fields.albumArtist?.trim() ? { albumArtist: input.fields.albumArtist.trim() } : {}),
      ...(input.fields.year ? { year: Number(input.fields.year) } : {}),
      ...(input.fields.label?.trim() ? { label: input.fields.label.trim() } : {}),
      ...(input.fields.genre?.trim() ? { genre: input.fields.genre.trim() } : {}),
      ...(info ? { release: info } : {}),
      art,
      ...(input.replaceArt ? { replaceArt: true } : {}),
      ...(listed ? { track: { ...listed, discs: release!.discs } } : {}),
      by: input.by,
      at,
    }
    const before = t.decision
    updateTrack(t.id, { albumLock: lock })
    const scored = scoreAndSave(getTrack(t.id)!, settings)
    const d = scored.decision
    const patch: Partial<Track> = {}
    // One cover for the whole album (a picture turned down for this track isn't forced on it).
    if (art && t.art?.hash !== art.hash && !t.artDeclined.includes(art.hash) && t.artFound?.hash !== art.hash) patch.artFound = { ...art, confirmed: input.by === "person" }
    else if (art && input.by === "person" && t.artFound?.hash === art.hash && !t.artFound.confirmed) patch.artFound = { ...t.artFound, confirmed: true }
    let final: FinalMeta | null = scored.final
    if (input.approve && d?.title && d.artists.length) {
      // Approved as it now reads; a name a person typed in earlier stays, the album's details are the album's.
      const typed = t.final && t.approvedBy === "person" && before && (t.final.title !== before.title || t.final.artists.join("|") !== before.artists.join("|"))
      final = { ...decisionToFinal(d), ...(typed && !listed ? { artists: t.final!.artists, featuring: t.final!.featuring, title: t.final!.title, version: t.final!.version } : {}) }
      patch.status = t.status === "done" ? "done" : "approved"
      patch.approvedBy = "person"
      result.approved++
    } else if (input.approve) {
      result.skipped++
    } else if (final && before && (scored.status === "approved" || scored.status === "done")) {
      // Kept together automatically: an approved track's album details follow, where they were as proposed.
      const asProposed = ALBUM_FIELDS.every((f) => !final![f] || final![f] === (before as unknown as Record<string, unknown>)[f])
      if (asProposed && d) final = { ...final, album: d.album, ...(d.albumArtist ? { albumArtist: d.albumArtist } : {}), year: d.year, label: d.label, genre: d.genre }
    }
    if (JSON.stringify(final) !== JSON.stringify(scored.final)) {
      patch.final = final
      // Cut with other details: back to Cut & Tag, to be tagged again.
      if (t.status === "done") {
        patch.status = "approved"
        result.recut++
      }
    }
    if (Object.keys(patch).length) {
      updateTrack(t.id, patch)
      const next = getTrack(t.id)!
      updateTrack(t.id, { proposedName: proposedFilename(next, settings) })
    }
  }
  return result
}

/** No longer kept together: each track goes back to its own hits. */
export function releaseAlbum(ids: number[], settings: Settings): number {
  let n = 0
  for (const t of getTracks(ids)) {
    if (!t.albumLock) continue
    updateTrack(t.id, { albumLock: null })
    scoreAndSave(getTrack(t.id)!, settings)
    n++
  }
  return n
}

/**
 * After identifying: the tracks of each record folder these were in, kept together
 * as one album when most of them are clearly on it. Nothing is approved - that's a
 * person's one OK on the Albums page - and a person's own album is never changed.
 */
export async function keepAlbumsTogether(ids: number[], settings: Settings, ctx: Pick<JobContext, "signal" | "log" | "tracksChanged">): Promise<number> {
  const folders = new Map<string, { libraryId: number; folder: string }>()
  for (const row of getDb().prepare(`SELECT library_id, rel_dir FROM tracks WHERE id IN (${ids.map(() => "?").join(",") || "NULL"})`).all(...ids) as { library_id: number; rel_dir: string }[]) {
    const folder = recordFolder(row.rel_dir)
    if (folder) folders.set(`${row.library_id}\0${folder}`, { libraryId: row.library_id, folder })
  }
  let kept = 0
  for (const { libraryId, folder } of folders.values()) {
    if (ctx.signal.aborted) break
    const groupIds = recordTrackIds(libraryId, folder)
    if (groupIds.length < 2 || groupIds.length > MAX_AUTO_TRACKS) continue
    const tracks = getTracks(groupIds)
    if (tracks.some((t) => t.albumLock?.by === "person")) continue
    const { options, covers } = albumOptions(tracks, folder)
    const top = options[0]
    // Only when most of the folder is clearly one album named by the sources or the files.
    if (!top || top.key.startsWith("folder:") || top.covers < Math.max(2, Math.ceil(tracks.length * 0.6))) continue
    try {
      const proposal = await proposeAlbum(groupIds, settings, { option: top.key, signal: ctx.signal })
      // The tracks on it, and those with no album of their own; not ones clearly on another album.
      const on = covers.get(top.key) ?? new Set<number>()
      const members = tracks.filter((t) => on.has(t.id) || !reading(t)?.album || proposal.matches.some((m) => m.trackId === t.id && m.index !== null))
      if (members.length < 2) continue
      const memberIds = new Set(members.map((t) => t.id))
      await applyAlbum(
        {
          trackIds: members.map((t) => t.id),
          release: proposal.release ? `${proposal.release.source}:${proposal.release.id}` : null,
          fields: proposal.fields,
          matches: proposal.matches.filter((m) => memberIds.has(m.trackId)),
          artworkUrl: proposal.artwork[0] ?? null,
          approve: false,
          by: "auto",
        },
        settings,
        ctx.signal
      )
      kept++
      ctx.log("info", `Kept ${members.length} tracks together as "${proposal.fields.title}"${proposal.release ? ` (${proposal.release.source === "musicbrainz" ? "MusicBrainz" : "Discogs"})` : ""}`)
      ctx.tracksChanged(members.map((t) => t.id))
    } catch (err) {
      if (ctx.signal.aborted) break
      ctx.log("warn", `Couldn't keep the album in ${folder} together: ${err instanceof Error ? err.message : err}`)
    }
  }
  return kept
}
