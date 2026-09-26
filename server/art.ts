// Cover art: a content-addressed cache in the data folder (so a cover shared by
// a whole release is stored once), polite downloads, thumbnails, and finding
// artwork for a track from the sources that identified it.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parseFile } from "music-metadata"
import type { ArtRef, Candidate, Settings, SourceId, Track, TrackReading } from "../shared/types"
import { sniffImage } from "./art-image"
import { ensureDataDir } from "./config"
import { artistSimilarity, titleSimilarity } from "./core/normalize"
import { deezer, itunes } from "./sources/catalog"
import { userAgent, waitForSlot } from "./sources/http"
import { buildQuery } from "./sources"
import { runTask } from "./worker-pool"

const MAX_BYTES = 10 * 1024 * 1024
const THUMB_SIZES = [64, 160, 320]
/** Preferred sources for artwork: label/official scans first, streaming stores next. */
const SOURCE_ORDER: SourceId[] = ["musicbrainz", "discogs", "bandcamp", "itunes", "deezer", "spotify"]

function dir(...parts: string[]) {
  const d = path.join(ensureDataDir(), "art", ...parts)
  fs.mkdirSync(d, { recursive: true })
  return d
}

export const hashBytes = (b: Uint8Array) => createHash("sha1").update(b).digest("hex")

export function describeArt(bytes: Uint8Array, source: ArtRef["source"], url?: string, sourceLabel?: string): ArtRef | null {
  const info = sniffImage(bytes)
  if (!info) return null
  return { hash: hashBytes(bytes), mime: info.mime, bytes: bytes.length, width: info.width, height: info.height, source, sourceLabel, url }
}

/** Keep a copy of a picture in the cache and describe it. */
export function storeArt(bytes: Uint8Array, source: ArtRef["source"], url?: string, sourceLabel?: string): ArtRef | null {
  const ref = describeArt(bytes, source, url, sourceLabel)
  if (!ref) return null
  const file = path.join(dir(), ref.hash)
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes)
  return ref
}

export function cachedArt(hash: string): Buffer | null {
  if (!/^[a-f0-9]{40}$/.test(hash)) return null
  const file = path.join(dir(), hash)
  return fs.existsSync(file) ? fs.readFileSync(file) : null
}

/** The front cover (or failing that, the first picture) from music-metadata's list. */
export function pickFrontCover<P extends { type?: string; data: Uint8Array }>(pictures?: P[]): P | null {
  if (!pictures?.length) return null
  return pictures.find((p) => /front/i.test(p.type ?? "")) ?? pictures[0]
}

export async function readEmbeddedArt(file: string): Promise<Uint8Array | null> {
  const meta = await parseFile(file, { duration: false, skipCovers: false })
  return pickFrontCover(meta.common.picture)?.data ?? null
}

/** A picture's bytes: from the cache, or straight out of the track's file. */
export async function artBytes(track: Track, ref: ArtRef): Promise<Uint8Array | null> {
  const cached = cachedArt(ref.hash)
  if (cached) return cached
  if (track.art?.hash !== ref.hash) return null
  try {
    const bytes = await readEmbeddedArt(track.path)
    return bytes && hashBytes(bytes) === ref.hash ? bytes : null
  } catch {
    return null
  }
}

/** A square JPEG thumbnail, cached on disk; WebP/GIF come back as-is for the browser to scale. */
export async function thumbnail(track: Track, ref: ArtRef, size: number): Promise<{ body: Uint8Array; mime: string } | null> {
  const s = THUMB_SIZES.find((x) => x >= size) ?? THUMB_SIZES.at(-1)!
  const file = path.join(dir("thumbs"), `${ref.hash}-${s}.jpg`)
  if (fs.existsSync(file)) return { body: fs.readFileSync(file), mime: "image/jpeg" }
  const bytes = await artBytes(track, ref)
  if (!bytes) return null
  const thumb = await runTask<Uint8Array | null>({ type: "thumbnail", bytes, size: s }).catch(() => null)
  if (!thumb) return { body: bytes, mime: ref.mime }
  fs.writeFileSync(file, thumb)
  return { body: thumb, mime: "image/jpeg" }
}

/** Download an image (paced per host, size-capped) into the cache. */
export async function fetchArt(url: string, source: SourceId, signal?: AbortSignal, sourceLabel?: string): Promise<ArtRef | null> {
  const host = new URL(url).host
  await waitForSlot(host, signal)
  const timeout = AbortSignal.timeout(20_000)
  const res = await fetch(url, {
    headers: { "user-agent": userAgent(), accept: "image/*" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!res.ok) return null
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return null
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length > MAX_BYTES || bytes.length < 1024) return null
  return storeArt(bytes, source, url, sourceLabel)
}

function sourceRank(s: SourceId) {
  const i = SOURCE_ORDER.indexOf(s)
  return i < 0 ? SOURCE_ORDER.length : i
}

function fits(c: Pick<Candidate, "artist" | "artists" | "title">, meta: Pick<TrackReading, "artists" | "title">) {
  return titleSimilarity(c.title, meta.title) >= 0.8 && artistSimilarity(c.artists?.length ? c.artists : c.artist, meta.artists) >= 0.7
}

type ArtLead = { url: string; source: SourceId; label: string }

/** Artwork URLs from the candidates that back the decision, best first. */
export function artworkCandidates(track: Track): ArtLead[] {
  const meta = track.final ?? track.decision
  const clusters = track.decision?.clusters ?? []
  // Only covers from hits that agree with what the track is (it may have been edited since).
  const hits = clusters
    .flatMap((cl) => cl.candidates)
    .filter((c) => c.artwork && (!meta?.title || fits(c, meta)))
    .sort((a, b) => sourceRank(a.source) - sourceRank(b.source) || (b.sourceScore ?? 0) - (a.sourceScore ?? 0))
  const seen = new Set<string>()
  const out: ArtLead[] = []
  for (const c of hits) {
    if (seen.has(c.artwork!)) continue
    seen.add(c.artwork!)
    out.push({ url: c.artwork!, source: c.source, label: c.sourceLabel })
  }
  return out
}

/** Ask the keyless stores (Apple Music, Deezer) directly - for tracks you've re-identified by hand. */
async function searchArtwork(track: Track, meta: TrackReading, settings: Settings, signal?: AbortSignal) {
  const q = buildQuery(track, meta)
  const found: Candidate[] = []
  for (const adapter of [deezer, itunes]) {
    try {
      found.push(...(await adapter.search(q, { cfg: settings.sources[adapter.id] ?? { enabled: true, weight: 1 }, settings, signal })))
    } catch {
      // a store being down just means fewer options
    }
  }
  return found.filter((c) => c.artwork && fits(c, meta)).map((c) => ({ url: c.artwork!, source: c.source, label: c.sourceLabel }))
}

/**
 * Find a cover for a track: first from the sources that identified it, then by
 * searching the stores for its approved artist and title.
 */
export async function findArtwork(track: Track, settings: Settings, signal?: AbortSignal): Promise<ArtRef | null> {
  const tried = new Set<string>()
  const attempt = async (list: ArtLead[]) => {
    for (const { url, source, label } of list.slice(0, 4)) {
      if (tried.has(url)) continue
      tried.add(url)
      try {
        const ref = await fetchArt(url, source, signal, label)
        if (ref) return ref
      } catch {
        if (signal?.aborted) return null
      }
    }
    return null
  }
  const fromSources = await attempt(artworkCandidates(track))
  if (fromSources) return fromSources
  const meta = track.final ?? (track.decision?.title ? track.decision : null)
  if (!meta?.title || !meta.artists.length) return null
  return attempt(await searchArtwork(track, meta, settings, signal))
}

/** Whether a found cover would actually be written when the track is cut. */
export function artToEmbed(track: Track, settings: Settings): ArtRef | null {
  if (!settings.artwork.embed || !track.artFound) return null
  if (track.art && !settings.artwork.replaceExisting) return null
  if (track.art?.hash === track.artFound.hash) return null
  return track.artFound
}
