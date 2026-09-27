import type { Candidate, Settings, SourceConfig, Track, TrackReading } from "../../shared/types"
import { collapseSpaces } from "../core/normalize"
import { SOURCE_META } from "../settings"
import { acoustid } from "./acoustid"
import { mainstreamSources } from "./catalog"
import { scraperAdapter } from "./scraper"
import type { SourceAdapter, SourceQuery } from "./types"
import { undergroundSources } from "./underground"

export function allAdapters(settings: Settings): { adapter: SourceAdapter; cfg: SourceConfig }[] {
  const builtIn = [...mainstreamSources(), ...undergroundSources(), acoustid].map((adapter) => ({
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

/** ×GENRE_BOOST when the source suits any of the genres picked (and that's switched on), else ×1. */
export function genreBoost(settings: Settings, id: string): number {
  if (!settings.confidence.genreAware || !settings.llm.genres.length) return 1
  const picked = new Set(settings.llm.genres.map((g) => g.toLowerCase()))
  return suitsOf(id, settings).some((g) => picked.has(g.toLowerCase())) ? GENRE_BOOST : 1
}

export function sourceStatus(settings: Settings) {
  return allAdapters(settings).map(({ adapter, cfg }) => ({
    id: adapter.id,
    label: adapter.label,
    enabled: cfg.enabled,
    weight: cfg.weight,
    unavailable: adapter.unavailable({ cfg, settings }),
    meta: SOURCE_META[adapter.id] ?? null,
    suits: suitsOf(adapter.id, settings),
    boost: genreBoost(settings, adapter.id),
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
    filePath: track.path,
  }
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
  breaker?: SourceBreaker
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
      try {
        const hits = await adapter.search(q, { cfg, settings, signal })
        breaker?.ok(adapter.label)
        return hits
      } catch (err) {
        if (signal?.aborted) return []
        errors.push({ source: adapter.label, message: err instanceof Error ? err.message : String(err) })
        if (breaker?.fail(adapter.label)) tripped.push(adapter.label)
        return []
      }
    })
  )
  return { candidates: results.flat(), errors, skipped, tripped }
}
