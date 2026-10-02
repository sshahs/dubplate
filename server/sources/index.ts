import type { Candidate, Settings, SourceConfig, Track, TrackReading } from "../../shared/types"
import { collapseSpaces, normArtist, normTitle } from "../core/normalize"
import { getDb, parseJson } from "../db"
import { SOURCE_META } from "../settings"
import { junkResults, recordScraperAnswer, sourceHealth } from "../source-health"
import { acoustid } from "./acoustid"
import { mainstreamSources } from "./catalog"
import { discogsCollection } from "./discogs-collection"
import { scraperAdapter } from "./scraper"
import type { SourceAdapter, SourceQuery } from "./types"
import { undergroundSources } from "./underground"

export function allAdapters(settings: Settings): { adapter: SourceAdapter; cfg: SourceConfig }[] {
  const builtIn = [...mainstreamSources(), discogsCollection, ...undergroundSources(), acoustid].map((adapter) => ({
    adapter,
    cfg: settings.sources[adapter.id] ?? { enabled: false, weight: 0.5 },
  }))
  const scrapers = settings.scrapers.map((def) => ({ adapter: scraperAdapter(def), cfg: { enabled: def.enabled, weight: def.weight } }))
  return [...builtIn, ...scrapers]
}

/** How much more a source that suits the picked genres counts. */
export const GENRE_BOOST = 1.2

/** Genres a source is especially good for (built-in list, or a scraper's own). */
export function suitsOf(id: string, settings: Settings): string[] {
  if (id.startsWith("scraper:")) return settings.scrapers.find((s) => `scraper:${s.id}` === id)?.genres ?? []
  return SOURCE_META[id]?.suits ?? []
}

/** A source's own multiplier per genre, when it has one set (instead of the flat ×1.2). */
export function genreWeightsOf(id: string, settings: Settings): Record<string, number> | undefined {
  const w = id.startsWith("scraper:") ? settings.scrapers.find((s) => `scraper:${s.id}` === id)?.genreWeights : settings.sources[id]?.genreWeights
  return w && Object.keys(w).length ? w : undefined
}

/**
 * How much more a source counts for the genres picked (when that's switched
 * on): its own multiplier for the best-fitting picked genre if it has them,
 * else ×1.2 when it suits any of them.
 */
export function genreBoost(settings: Settings, id: string): number {
  if (!settings.confidence.genreAware || !settings.llm.genres.length) return 1
  const picked = new Set(settings.llm.genres.map((g) => g.toLowerCase()))
  const weights = genreWeightsOf(id, settings)
  if (weights) {
    const hits = Object.entries(weights).filter(([g]) => picked.has(g.toLowerCase())).map(([, m]) => m)
    return hits.length ? Math.max(0.5, Math.min(2, Math.max(...hits))) : 1
  }
  return suitsOf(id, settings).some((g) => picked.has(g.toLowerCase())) ? GENRE_BOOST : 1
}

export function sourceStatus(settings: Settings) {
  const health = new Map(sourceHealth().map((h) => [h.sourceId, h]))
  return allAdapters(settings).map(({ adapter, cfg }) => ({
    id: adapter.id,
    label: adapter.label,
    enabled: cfg.enabled,
    weight: cfg.weight,
    unavailable: adapter.unavailable({ cfg, settings }),
    meta: SOURCE_META[adapter.id] ?? null,
    suits: suitsOf(adapter.id, settings),
    boost: genreBoost(settings, adapter.id),
    genreWeights: genreWeightsOf(adapter.id, settings) ?? null,
    // Switched back on by hand since the health check switched it off: that count no longer applies.
    health: ((h) => (h && !(h.disabledAt && cfg.enabled) ? h : null))(health.get(adapter.id)),
  }))
}

const DESCRIPTIVE = /^(?:live(?: clash| at .+| in .+)?|clash|sound ?clash|dubplate(?:s| session| mix)?|special(?:s)?|session|set|mix|radio (?:set|show)|untitled|unknown)(?: \d{4})?$/i

export function buildQuery(track: Track, reading: TrackReading, extraQueries: string[] = []): SourceQuery {
  const artists = reading.artists
  const artist = artists.join(" ")
  const title = reading.title
  const descriptiveTitle = !title || DESCRIPTIVE.test(title.trim()) || (reading.relation === "vs" && /\b(?:live|clash)\b/i.test(title))
  const query = collapseSpaces(descriptiveTitle ? `${artists.join(" ")} ${reading.year ?? ""}` : `${artists[0] ?? ""} ${title}`)
  return {
    artists,
    artist,
    title,
    query,
    extraQueries,
    duration: track.duration,
    year: reading.year,
    descriptiveTitle,
    version: reading.version,
    filePath: track.path,
  }
}

const DAY = 86_400_000

/**
 * Lookups are also kept by normalised artist, title, version and length, so
 * the same song from a differently-named file (or with other AI search
 * suggestions) doesn't ask every source again. AcoustID is keyed by the audio.
 */
export function lookupKey(sourceId: string, q: SourceQuery): string {
  const bucket = q.duration ? Math.round(q.duration / 5) : "-"
  return [sourceId, q.artists.map(normArtist).join("|"), normTitle(q.title), normTitle(q.version ?? ""), bucket].join("::")
}

function cachedLookup(key: string): Candidate[] | null {
  const r = getDb().prepare("SELECT candidates_json, fetched_at FROM lookup_cache WHERE key = ?").get(key) as { candidates_json: string; fetched_at: number } | undefined
  if (!r) return null
  const hits = parseJson<Candidate[]>(r.candidates_json, [])
  // Nothing found is asked again sooner than a hit.
  const ttl = hits.length ? 14 * DAY : 2 * DAY
  return Date.now() - r.fetched_at < ttl ? hits : null
}

function storeLookup(key: string, hits: Candidate[]) {
  getDb()
    .prepare("INSERT INTO lookup_cache (key, candidates_json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET candidates_json = excluded.candidates_json, fetched_at = excluded.fetched_at")
    .run(key, JSON.stringify(hits), Date.now())
}

export function clearLookupCache() {
  return Number(getDb().prepare("DELETE FROM lookup_cache").run().changes)
}

export interface ScourResult {
  candidates: Candidate[]
  errors: { source: string; message: string }[]
  skipped: { source: string; reason: string }[]
}

/** Per-job record of failing sources, so a dead API isn't hit for every track. */
export class SourceBreaker {
  private failures = new Map<string, number>()
  readonly tripped = new Set<string>()
  constructor(private limit = 3) {}
  ok(source: string) {
    this.failures.set(source, 0)
  }
  fail(source: string): boolean {
    const n = (this.failures.get(source) ?? 0) + 1
    this.failures.set(source, n)
    if (n >= this.limit && !this.tripped.has(source)) {
      this.tripped.add(source)
      return true
    }
    return false
  }
}

export async function scourTrack(
  track: Track,
  reading: TrackReading,
  settings: Settings,
  extraQueries: string[],
  signal?: AbortSignal,
  breaker?: SourceBreaker,
  /** results already fetched this run (AcoustID, before the AI), so they aren't asked twice */
  precomputed: Partial<Record<string, Candidate[]>> = {},
  opts: { fresh?: boolean } = {}
): Promise<ScourResult & { tripped: string[] }> {
  const q = buildQuery(track, reading, extraQueries)
  const errors: ScourResult["errors"] = []
  const skipped: ScourResult["skipped"] = []
  const tripped: string[] = []
  const jobs = allAdapters(settings)
    .filter(({ cfg }) => cfg.enabled)
    .filter(({ adapter }) => !breaker?.tripped.has(adapter.label))
    .filter(({ adapter, cfg }) => {
      const reason = adapter.unavailable({ cfg, settings })
      if (reason) skipped.push({ source: adapter.label, reason })
      return !reason
    })
  const results = await Promise.all(
    jobs.map(async ({ adapter, cfg }) => {
      if (precomputed[adapter.id]) return precomputed[adapter.id]!
      const key = adapter.id === "acoustid" ? null : lookupKey(adapter.cacheKey ?? adapter.id, q)
      const cached = key && !opts.fresh ? cachedLookup(key) : null
      if (cached) return cached
      const scraper = adapter.id.startsWith("scraper:")
      try {
        const hits = await adapter.search(q, { cfg, settings, signal })
        breaker?.ok(adapter.label)
        // A scraper whose "results" are its login or home page is broken, however quietly.
        const junk = scraper ? junkResults(hits) : null
        if (scraper && recordScraperAnswer(adapter.id, junk, hits)) tripped.push(adapter.label)
        if (junk) {
          errors.push({ source: adapter.label, message: `Ignored: ${junk}` })
          return []
        }
        if (key) storeLookup(key, hits)
        return hits
      } catch (err) {
        if (signal?.aborted) return []
        if (scraper && recordScraperAnswer(adapter.id, err instanceof Error ? err.message.slice(0, 160) : String(err), [])) tripped.push(adapter.label)
        errors.push({ source: adapter.label, message: err instanceof Error ? err.message : String(err) })
        if (breaker?.fail(adapter.label)) tripped.push(adapter.label)
        return []
      }
    })
  )
  return { candidates: results.flat(), errors, skipped, tripped }
}
