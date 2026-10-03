import type { Candidate, Settings, SourceConfig, SourceId } from "../../shared/types"

export interface SourceQuery {
  artists: string[]
  artist: string
  title: string
  /** free-text query (artist + title, or the AI's suggestion) */
  query: string
  /** extra free-text queries suggested by the AI */
  extraQueries: string[]
  duration: number | null
  year?: number
  /** true when the title is a description ("Live Clash") rather than a song name */
  descriptiveTitle: boolean
  /** the reading's version ("Dubplate", "VIP"…), for the lookup cache */
  version?: string
  filePath: string
}

export interface SourceContext {
  cfg: SourceConfig
  settings: Settings
  signal?: AbortSignal
}

export interface SourceAdapter {
  id: SourceId
  label: string
  /** what its lookups are cached under, when that's more than its id */
  cacheKey?: string
  /** answers from its own index (by file name too), so lookups aren't cached */
  local?: boolean
  /** null when usable, otherwise the reason it's skipped */
  unavailable(ctx: SourceContext): string | null
  search(q: SourceQuery, ctx: SourceContext): Promise<Candidate[]>
}

export const enc = encodeURIComponent

/** Discogs appends " (2)" to disambiguate artists; MusicBrainz sometimes uses "*". */
export function cleanArtistName(s: string): string {
  return s.replace(/\s*\(\d+\)$/, "").replace(/\*$/, "").trim()
}

export function yearOf(s: string | number | undefined | null): number | undefined {
  if (typeof s === "number") return s > 1900 ? s : undefined
  const m = String(s ?? "").match(/\b(1[89]\d{2}|20\d{2})\b/)
  return m ? Number(m[1]) : undefined
}
