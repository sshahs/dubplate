import type {
  AiParse,
  Alias,
  Correction,
  FinalMeta,
  HealthInfo,
  HeuristicParse,
  Job,
  Library,
  Operation,
  OperationBatch,
  PlanItem,
  ScraperDefinition,
  Settings,
  Stats,
  Track,
  TrackStatus,
  TrackSummary,
  Candidate,
} from "@shared/types"

export class ApiError extends Error {
  /** HTTP status; 0 when the server couldn't be reached at all */
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
  get offline() {
    return this.status === 0
  }
  /** The Host header guard (DUBPLATE_ALLOWED_HOSTS) turned the request away. */
  get hostBlocked() {
    return this.status === 403 && /not allowed/i.test(this.message)
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        "x-dubplate": "1",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, "Can't reach the Dubplate server - is it running?")
  }
  const text = await res.text()
  let data: { error?: string } | null = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // A proxy's HTML error page, a half-restarted server…: say what happened instead of a JSON parse error.
    if (!res.ok) throw new ApiError(res.status, `The server replied ${res.status} ${res.statusText}`.trim())
    throw new ApiError(res.status, "The server sent something unexpected - try reloading")
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText)
  return data as T
}

const get = <T,>(url: string) => request<T>("GET", url)
const post = <T,>(url: string, body?: unknown) => request<T>("POST", url, body ?? {})
const put = <T,>(url: string, body: unknown) => request<T>("PUT", url, body)
const patch = <T,>(url: string, body: unknown) => request<T>("PATCH", url, body)
const del = <T,>(url: string) => request<T>("DELETE", url)

export interface TrackFilter {
  status?: TrackStatus[]
  libraryId?: number
  q?: string
  min?: number
  max?: number
  sort?: "filename" | "confidence" | "status" | "updated" | "path" | "bpm" | "key"
  dir?: "asc" | "desc"
  limit?: number
  offset?: number
}

export function filterToQuery(f: TrackFilter): string {
  const p = new URLSearchParams()
  if (f.status?.length) p.set("status", f.status.join(","))
  if (f.libraryId) p.set("libraryId", String(f.libraryId))
  if (f.q) p.set("q", f.q)
  if (f.min !== undefined) p.set("min", String(f.min))
  if (f.max !== undefined) p.set("max", String(f.max))
  if (f.sort) p.set("sort", f.sort)
  if (f.dir) p.set("dir", f.dir)
  if (f.limit) p.set("limit", String(f.limit))
  if (f.offset) p.set("offset", String(f.offset))
  return p.toString()
}

/** Server-side filter shape for bulk actions. */
function serverFilter(f: TrackFilter) {
  return {
    status: f.status,
    libraryId: f.libraryId,
    q: f.q,
    minConfidence: f.min,
    maxConfidence: f.max,
  }
}

export type Selection = { ids: number[] } | { filter: TrackFilter }

function sel(s: Selection) {
  return "ids" in s ? { ids: s.ids } : { filter: serverFilter(s.filter) }
}

export type PublicSettings = Settings & { secretsFromEnv: string[]; zdrFromEnv: boolean }

/** What a settings save may send: any top-level part, and objects only in part (the server merges them). */
export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends unknown[] ? Settings[K] : Settings[K] extends object ? Partial<Settings[K]> : Settings[K] }

export interface SourceStatus {
  id: string
  label: string
  enabled: boolean
  weight: number
  unavailable: string | null
  meta: { label: string; needs: ("apiKey" | "apiSecret")[]; keyLabel?: string; secretLabel?: string; about: string; signup?: string } | null
}

/** Fields bulk edit can set; null or "" clears. */
export interface BulkChanges {
  artists?: string[]
  featuring?: string[]
  version?: string | null
  album?: string | null
  year?: number | null
  label?: string | null
  genre?: string | null
  bpm?: number | null
  key?: string | null
}

type Undoable = { undoId: string | null }

export interface DuplicateGroup {
  key: string
  kind: "hash" | "name"
  tracks: TrackSummary[]
}

export const api = {
  health: () => get<HealthInfo>("/api/health"),
  stats: () => get<Stats>("/api/stats"),

  libraries: () => get<Library[]>("/api/libraries"),
  addLibrary: (path: string, name?: string) => post<Library>("/api/libraries", { path, name }),
  updateLibrary: (id: number, body: { name?: string; watch?: boolean }) => patch<Library>(`/api/libraries/${id}`, body),
  removeLibrary: (id: number) => del<{ ok: true }>(`/api/libraries/${id}`),
  scanLibrary: (id: number) => post<Job>(`/api/libraries/${id}/scan`),
  scanAll: () => post<Job[]>("/api/libraries/scan-all"),
  browse: (path?: string) => get<{ path: string; parent: string | null; dirs: { name: string; path: string }[]; audioCount: number }>(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),

  tracks: (f: TrackFilter) => get<{ items: TrackSummary[]; total: number }>(`/api/tracks?${filterToQuery(f)}`),
  track: (id: number) => get<Track>(`/api/tracks/${id}`),
  updateTrack: (id: number, body: { final?: Partial<FinalMeta>; note?: string; bpm?: number | null; key?: string | null }) => patch<Track>(`/api/tracks/${id}`, body),
  approve: (id: number, final?: Partial<FinalMeta>, learn = true) => post<Track & Undoable>(`/api/tracks/${id}/approve`, { final, learn }),
  bulk: (s: Selection, action: "approve" | "reject" | "reset" | "unapprove") => post<{ changed: number } & Undoable>("/api/tracks/bulk", { ...sel(s), action }),
  bulkEdit: (s: Selection, changes: BulkChanges) => post<{ changed: number; skipped: number } & Undoable>("/api/tracks/bulk-edit", { ...sel(s), changes }),
  undo: (undoId: string) => post<{ restored: number; label: string }>(`/api/undo/${undoId}`),
  analyze: (s: Selection, force = false) => post<Job>("/api/analyze", { ...sel(s), force }),
  findArtwork: (s: Selection, force = false) => post<Job>("/api/artwork", { ...sel(s), force }),
  findTrackArtwork: (id: number) => post<Track>(`/api/tracks/${id}/artwork/find`),
  dropFoundArtwork: (id: number) => del<Track>(`/api/tracks/${id}/artwork/found`),
  /** Thumbnail URL; the hash in it keeps the browser cache honest. */
  artUrl: (t: { id: number; art: { hash: string } | null; artFound: { hash: string } | null }, which: "current" | "found", size = 160) => {
    const ref = which === "found" ? t.artFound : t.art
    return ref ? `/api/tracks/${t.id}/art?which=${which}&size=${size}&h=${ref.hash.slice(0, 12)}` : null
  },
  rescoreOne: (id: number) => post<Track>(`/api/tracks/${id}/rescore`),
  audioUrl: (id: number) => `/api/tracks/${id}/audio`,

  process: (s: Selection | null, opts: { interpret?: boolean; scour?: boolean; force?: boolean }) => post<Job>("/api/process", { ...(s ? sel(s) : {}), ...opts }),
  rescore: (s?: Selection) => post<Job>("/api/rescore", s ? sel(s) : {}),
  plan: (s?: Selection) => post<PlanItem[]>("/api/plan", s ? sel(s) : {}),
  execute: (s: Selection, dryRun: boolean) => post<Job>("/api/execute", { ...sel(s), dryRun }),
  batches: () => get<OperationBatch[]>("/api/operations/batches"),
  operations: (batchId: string) => get<Operation[]>(`/api/operations?batchId=${encodeURIComponent(batchId)}`),
  rewind: (body: { batchId?: string; opIds?: number[] }) => post<Job>("/api/rewind", body),

  jobs: () => get<{ active: Job[]; recent: Job[] }>("/api/jobs"),
  cancelJob: (id: string) => post<{ ok: boolean }>(`/api/jobs/${id}/cancel`),

  settings: () => get<PublicSettings>("/api/settings"),
  saveSettings: (patch: SettingsPatch) => put<PublicSettings>("/api/settings", patch),

  models: (provider: string) => get<{ models: string[]; error?: string }>(`/api/llm/models?provider=${encodeURIComponent(provider)}`),
  testLlm: (providerId: string) => post<{ ok: boolean; message: string; latencyMs: number }>("/api/llm/test", { providerId }),
  playground: (filename: string, ai: boolean) => post<{ heuristic: HeuristicParse; ai?: AiParse; error?: string }>("/api/playground", { filename, ai }),

  sources: () => get<SourceStatus[]>("/api/sources"),
  testSource: (id: string, artist: string, title: string) => post<{ candidates?: Candidate[]; error?: string; ms: number }>("/api/sources/test", { id, artist, title }),
  testScraper: (definition: ScraperDefinition, query: string) => post<{ candidates: Candidate[]; itemCount: number; error?: string }>("/api/scrapers/test", { definition, query }),
  clearCache: () => post<{ cleared: number }>("/api/cache/clear"),

  aliases: () => get<Alias[]>("/api/aliases"),
  addAlias: (alias: string, canonical: string) => post<Alias[]>("/api/aliases", { alias, canonical }),
  deleteAlias: (id: number) => del<{ ok: true }>(`/api/aliases/${id}`),
  corrections: () => get<Correction[]>("/api/corrections"),
  deleteCorrection: (id: number) => del<{ ok: true }>(`/api/corrections/${id}`),

  duplicates: () => get<DuplicateGroup[]>("/api/duplicates"),
  exportUrl: (f: TrackFilter, format: "csv" | "json") => `/api/export?${filterToQuery(f)}&format=${format}`,
}
