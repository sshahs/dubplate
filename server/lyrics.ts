// Lyrics from LRCLIB (lrclib.net: free, no key, timed lyrics where it has
// them). Looked up for the song a track was identified as, kept per track, and
// written into the file (and optionally a .lrc next to it) when it's cut.

import type { FinalMeta, LyricsFound, Settings, Track } from "../shared/types"

export { lyricsKey } from "../shared/lyrics"
import { lyricsKey, plainFromTimed } from "../shared/lyrics"
import { artistSimilarity, titleSimilarity } from "./core/normalize"
import type { JobContext } from "./jobs"
import { mapLimit } from "./jobs"
import { metaFor } from "./placement"
import { getTrack, updateTrack } from "./repo"
import { httpJson } from "./sources/http"

const API = "https://lrclib.net/api"
const DAY = 24 * 60 * 60 * 1000

export interface LrclibHit {
  id: number
  trackName: string
  artistName: string
  albumName?: string | null
  duration?: number | null
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

/** Cuts with no words, and cuts whose words aren't the original's. */
function versionSays(version: string | undefined): { instrumental?: true; reason: string } | null {
  const v = (version ?? "").trim()
  if (!v) return null
  if (/^version$/i.test(v) || /\b(dub|instrumental|riddim)\b/i.test(v)) return { instrumental: true, reason: "A dub or instrumental cut" }
  if (/\b(dubplate|special|clash)\b/i.test(v)) return { reason: "Dubplates, specials and clashes have their own words" }
  return null
}

/**
 * The best hit for this song: artist and title have to agree, and a hit more
 * than 20 s off is a different cut. Timed lyrics are only kept when the
 * lengths agree to within 3 s, so the words land on time.
 */
export function pickLyrics(hits: LrclibHit[], meta: Pick<FinalMeta, "artists" | "title">, duration: number | null): { hit: LrclibHit; timed: boolean } | null {
  let best: { hit: LrclibHit; timed: boolean; score: number } | null = null
  for (const h of hits) {
    const a = artistSimilarity(meta.artists, h.artistName)
    const t = titleSimilarity(meta.title, h.trackName)
    if (a < 0.75 || t < 0.8) continue
    const off = duration && h.duration ? Math.abs(h.duration - duration) : null
    if (off !== null && off > 20) continue
    if (!h.instrumental && !h.plainLyrics?.trim() && !h.syncedLyrics?.trim()) continue
    const timed = !!h.syncedLyrics?.trim() && off !== null && off <= 3
    const score = a + t + (timed ? 0.3 : 0) + (off === null ? 0 : (20 - off) / 100) + (h.instrumental ? -0.05 : 0)
    if (!best || score > best.score) best = { hit: h, timed, score }
  }
  return best ? { hit: best.hit, timed: best.timed } : null
}

/** `fresh`: ask LRCLIB now rather than going by an answer from the last two weeks (someone may have added the words since). */
async function search(params: Record<string, string>, signal?: AbortSignal, fresh = false): Promise<LrclibHit[]> {
  const hits = await httpJson<LrclibHit[]>(`${API}/search?${new URLSearchParams(params)}`, { signal, ttlMs: fresh ? 0 : 14 * DAY })
  return Array.isArray(hits) ? hits : []
}

/** Look up the words for a track as it's identified now. Null when there's no artist and title yet. */
export async function findLyrics(t: Track, signal?: AbortSignal, fresh = false): Promise<LyricsFound | null> {
  const meta = metaFor(t)
  if (!meta?.title || !meta.artists.length) return null
  const base = { for: lyricsKey(meta), at: new Date().toISOString() }
  const skip = versionSays(meta.version)
  if (skip) return { ...base, found: false, ...skip }
  let hits = await search({ track_name: meta.title, artist_name: meta.artists[0] }, signal, fresh)
  let pick = pickLyrics(hits, meta, t.duration)
  if (!pick) {
    // The artist field on LRCLIB can be "A & B" or "A feat. B": a free-text search catches those.
    hits = await search({ q: `${meta.artists.join(" ")} ${meta.title}` }, signal, fresh)
    pick = pickLyrics(hits, meta, t.duration)
  }
  if (!pick) return { ...base, found: false, reason: "LRCLIB doesn't have it" }
  const { hit, timed } = pick
  if (hit.instrumental && !hit.plainLyrics?.trim()) return { ...base, found: false, instrumental: true, reason: "LRCLIB lists it as an instrumental", source: "lrclib", sourceId: hit.id }
  const synced = timed ? hit.syncedLyrics!.trim() : undefined
  const plain = hit.plainLyrics?.trim() || (hit.syncedLyrics ? plainFromTimed(hit.syncedLyrics) : "")
  return { ...base, found: true, plain, ...(synced ? { synced } : {}), source: "lrclib", sourceId: hit.id }
}

/** The track's lyrics, if they were found for what it's identified as now and you haven't turned them down. */
export function usableLyrics(t: Track): LyricsFound | null {
  const meta = metaFor(t)
  const l = t.lyrics
  if (!meta || !l?.found || l.rejected || l.for !== lyricsKey(meta)) return null
  return l
}

/** What goes in the lyrics tag when cutting, per the settings. */
export function lyricsToEmbed(t: Track, settings: Settings): string | null {
  if (!settings.lyrics.embed) return null
  const l = usableLyrics(t)
  if (!l) return null
  return (settings.lyrics.embedSynced && l.synced) || l.plain || null
}

/** Not looked up yet for what the track is identified as now (a turned-down answer stands). */
export function needsLyrics(t: Track): boolean {
  const meta = metaFor(t)
  if (!meta?.title || !meta.artists.length) return false
  return !t.lyrics || t.lyrics.for !== lyricsKey(meta)
}

/** Look up and save one track's lyrics; returns what was saved. */
export async function lyricsForTrack(t: Track, signal?: AbortSignal, fresh = false): Promise<LyricsFound | null> {
  const found = await findLyrics(t, signal, fresh)
  if (found) updateTrack(t.id, { lyrics: found })
  return found
}

/** A job: look lyrics up for these tracks (all of them, asking LRCLIB afresh, with `force`; else only where they're missing or stale). */
export async function lyricsTracks(ids: number[], opts: { force: boolean }, ctx: JobContext) {
  ctx.setTotal(ids.length)
  const changed: number[] = []
  let found = 0
  await mapLimit(ids, 3, ctx.signal, async (id) => {
    const t = getTrack(id)
    if (!t || t.missing) return ctx.tick(false)
    if (!opts.force && !needsLyrics(t)) return ctx.tick(true)
    try {
      const l = await lyricsForTrack(t, ctx.signal, opts.force)
      if (!l) return ctx.tick(true, `${t.filename} → not identified yet`)
      changed.push(id)
      if (l.found) found++
      ctx.tick(true, `${t.filename} → ${l.found ? (l.synced ? "timed lyrics" : "lyrics") : l.instrumental ? "instrumental" : "none found"}`)
    } catch (err) {
      if (ctx.signal.aborted) return
      ctx.log("warn", `Lyrics for ${t.filename}: ${err instanceof Error ? err.message : err}`)
      ctx.tick(false)
    }
  })
  ctx.tracksChanged(changed)
  ctx.log("success", `Found lyrics for ${found} of ${ids.length} track${ids.length === 1 ? "" : "s"}`)
}

/**
 * Before a cut: look up lyrics for tracks whose reading changed since (an
 * edited title, say), so what's written fits. Failures only log.
 */
export async function topUpLyrics(tracks: Track[], settings: Settings, ctx: Pick<JobContext, "log" | "signal">): Promise<number> {
  if (!settings.lyrics.fetch || (!settings.lyrics.embed && !settings.lyrics.lrcFile)) return 0
  const stale = tracks.filter((t) => needsLyrics(t))
  let n = 0
  await mapLimit(stale, 3, ctx.signal, async (t) => {
    try {
      if (await lyricsForTrack(t, ctx.signal)) n++
    } catch (err) {
      if (!ctx.signal.aborted) ctx.log("warn", `Lyrics for ${t.filename}: ${err instanceof Error ? err.message : err}`)
    }
  })
  return n
}
