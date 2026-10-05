import type {
  AcoustIdEligibility,
  AcoustIdSubmission,
  AiParse,
  AiUsageReport,
  Alias,
  ApiToken,
  AuthStatus,
  BackupFile,
  Correction,
  Crate,
  CrateFacets,
  DecisionStep,
  CrateRules,
  DjFormat,
  DuplicateGroup,
  FinalMeta,
  HealthInfo,
  HealthReport,
  HeuristicParse,
  HookCall,
  Job,
  Library,
  LibrarySettings,
  LogArea,
  LogEntry,
  LogLevel,
  LogSummary,
  MbSubmission,
  MediaServerConfig,
  MixSuggestion,
  Operation,
  OperationBatch,
  OrganisePreview,
  PathMapping,
  PlanItem,
  RiskAssessment,
  ScraperDefinition,
  Settings,
  SourceHealth,
  Stats,
  Track,
  TrackStatus,
  TrackSummary,
  Candidate,
  ConvertPlan,
  UploadResult,
  VideoFile,
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
  // Signed out (or the password changed): the sign-in screen takes over.
  if (res.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event(SIGNED_OUT))
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

/** Fired when the server says the session is gone. */
export const SIGNED_OUT = "dubplate:signed-out"

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
  /** a smart crate's tracks */
  crate?: number
  quality?: "suspect"
  /** only files with something wrong with them (damaged, wrong extension…) */
  problems?: boolean
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
  if (f.crate) p.set("crate", String(f.crate))
  if (f.quality) p.set("quality", f.quality)
  if (f.problems) p.set("problems", "1")
  if (f.sort) p.set("sort", f.sort)
  if (f.dir) p.set("dir", f.dir)
  if (f.limit) p.set("limit", String(f.limit))
  if (f.offset) p.set("offset", String(f.offset))
  return p.toString()
}

/** What the Console shows: every part is optional, and nothing set means every line. */
export interface LogFilter {
  levels?: LogLevel[]
  areas?: LogArea[]
  job?: string
  track?: number
  q?: string
}

export function logFilterQuery(f: LogFilter, extra: Record<string, number | undefined> = {}): string {
  const p = new URLSearchParams()
  if (f.levels?.length) p.set("levels", f.levels.join(","))
  if (f.areas?.length) p.set("areas", f.areas.join(","))
  if (f.job) p.set("job", f.job)
  if (f.track) p.set("track", String(f.track))
  if (f.q?.trim()) p.set("q", f.q.trim())
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v))
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
    crateId: f.crate,
    quality: f.quality,
    problems: f.problems,
  }
}

/**
 * Upload one file into a library, reporting progress (fetch can't, so XHR).
 * `signal` cancels it.
 */
export function uploadFile(file: File, libraryId: number, onProgress: (sent: number) => void, signal?: AbortSignal): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const q = new URLSearchParams({ library: String(libraryId), name: file.name })
    xhr.open("PUT", `/api/upload?${q}`)
    xhr.setRequestHeader("x-dubplate", "1")
    xhr.setRequestHeader("content-type", "application/octet-stream")
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () => {
      if (xhr.status === 401) window.dispatchEvent(new Event(SIGNED_OUT))
      let data: { error?: string } | null = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        // not JSON: a proxy's error page, say
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data as UploadResult)
      else reject(new ApiError(xhr.status, data?.error ?? (xhr.status === 413 ? "Too big for the server (or a proxy in front of it)" : `The server replied ${xhr.status}`)))
    }
    xhr.onerror = () => reject(new ApiError(0, "Lost the connection to Dubplate"))
    xhr.onabort = () => reject(new ApiError(0, "Cancelled"))
    signal?.addEventListener("abort", () => xhr.abort(), { once: true })
    xhr.send(file)
  })
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
  /** genres the source is especially good for */
  suits: string[]
  /** ×1.2 when it suits the picked genres, else 1 (or its own weight for that genre) */
  boost: number
  /** its own weight per genre, when it has them */
  genreWeights: Record<string, number> | null
  /** scrapers: how its recent answers went */
  health: SourceHealth | null
}

/** How a track was decided, step by step. */
export interface TrackInsight {
  steps: DecisionStep[]
  risk: RiskAssessment
  acoustid: AcoustIdEligibility
  musicbrainz: MbSubmission | null
}

export interface AcoustIdSubmissions {
  items: AcoustIdSubmission[]
  counts: Record<AcoustIdSubmission["status"], number>
  submit: boolean
}

/** A video in a library, what's inside, and what converting it will make. */
export type VideoItem = VideoFile & { library: string; plan: ConvertPlan | null }

/** The release editor's address and the fields to post to it. */
export interface MbSeed {
  submission: MbSubmission
  action: string
  fields: Record<string, string>
}

/** Fields bulk edit can set; null or "" clears. */
export interface BulkChanges {
  artists?: string[]
  featuring?: string[]
  version?: string | null
  album?: string | null
  year?: number | null
  label?: string | null
  riddim?: string | null
  genre?: string | null
  bpm?: number | null
  key?: string | null
}

type Undoable = { undoId: string | null }

export type { DuplicateGroup }

export interface OrganiseRequest {
  libraryId: number
  template?: string
  missing?: "skip" | "unknown"
  rename?: boolean
  include?: "cut" | "approved"
  sidecars?: boolean
}

export interface DjExportRequest {
  format: DjFormat
  /** playlist name, for a selection */
  name?: string
  selection?: Selection
  /** export these crates, one playlist each */
  crateIds?: number[]
  pathMap?: PathMapping[]
  traktorVolume?: string
}

export interface CollectionStatus {
  username: string | null
  count: number
  syncedAt: string | null
}

/** POST, then save the reply as a file the browser downloads. */
async function download(url: string, body: unknown): Promise<string> {
  let res: Response
  try {
    res = await fetch(url, { method: "POST", headers: { "x-dubplate": "1", "content-type": "application/json" }, body: JSON.stringify(body) })
  } catch {
    throw new ApiError(0, "Can't reach the Dubplate server - is it running?")
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event(SIGNED_OUT))
    const j = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, j?.error ?? res.statusText)
  }
  const cd = res.headers.get("content-disposition") ?? ""
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i)
  const plain = cd.match(/filename="([^"]+)"/i)
  const filename = star ? decodeURIComponent(star[1]) : (plain?.[1] ?? "dubplate-export")
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
  return filename
}

export interface RestoreResult {
  settings: boolean
  aliases: number
  corrections: number
  libraries: { added: number; updated: number; skipped: { path: string; reason: string }[] }
  crates: number
}

export const api = {
  authStatus: () => get<AuthStatus>("/api/auth/status"),
  login: (password: string) => post<{ ok: true }>("/api/auth/login", { password }),
  logout: () => post<{ ok: true }>("/api/auth/logout"),
  logoutEverywhere: () => post<{ ok: true }>("/api/auth/logout-everywhere"),
  setPassword: (current: string | undefined, next: string) => post<AuthStatus>("/api/auth/password", { current, next }),
  removePassword: (current: string) => post<AuthStatus>("/api/auth/password/remove", { current }),

  health: () => get<HealthInfo>("/api/health"),
  healthChecks: (fresh = false) => get<HealthReport>(`/api/health/checks${fresh ? "?fresh=1" : ""}`),
  stats: () => get<Stats>("/api/stats"),

  libraries: () => get<Library[]>("/api/libraries"),
  addLibrary: (path: string, name?: string, opts: { process?: boolean; watch?: boolean } = {}) => post<Library>("/api/libraries", { path, name, ...opts }),
  updateLibrary: (id: number, body: { name?: string; watch?: boolean; settings?: LibrarySettings }) => patch<Library>(`/api/libraries/${id}`, body),
  removeLibrary: (id: number) => del<{ ok: true }>(`/api/libraries/${id}`),
  scanLibrary: (id: number) => post<Job>(`/api/libraries/${id}/scan`),
  scanAll: () => post<Job[]>("/api/libraries/scan-all"),
  browse: (path?: string) => get<{ path: string; parent: string | null; dirs: { name: string; path: string }[]; audioCount: number }>(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),

  tracks: (f: TrackFilter) => get<{ items: TrackSummary[]; total: number }>(`/api/tracks?${filterToQuery(f)}`),
  track: (id: number) => get<Track>(`/api/tracks/${id}`),
  updateTrack: (id: number, body: { final?: Partial<FinalMeta>; note?: string; bpm?: number | null; key?: string | null }) => patch<Track>(`/api/tracks/${id}`, body),
  approve: (id: number, final?: Partial<FinalMeta>, learn = true) => post<Track & Undoable>(`/api/tracks/${id}/approve`, { final, learn }),
  bulk: (s: Selection, action: "approve" | "reject" | "reset" | "unapprove") => post<{ changed: number; skipped: number } & Undoable>("/api/tracks/bulk", { ...sel(s), action }),
  bulkEdit: (s: Selection, changes: BulkChanges) => post<{ changed: number; skipped: number } & Undoable>("/api/tracks/bulk-edit", { ...sel(s), changes }),
  undo: (undoId: string) => post<{ restored: number; label: string }>(`/api/undo/${undoId}`),
  analyze: (s: Selection, force = false) => post<Job>("/api/analyze", { ...sel(s), force }),
  findLyrics: (s: Selection, force = false) => post<Job>("/api/lyrics", { ...sel(s), force }),
  trackLyrics: (id: number, action: "find" | "reject") => post<Track>(`/api/tracks/${id}/lyrics`, { action }),
  findArtwork: (s: Selection, force = false) => post<Job>("/api/artwork", { ...sel(s), force }),
  findTrackArtwork: (id: number) => post<Track>(`/api/tracks/${id}/artwork/find`),
  dropFoundArtwork: (id: number) => del<Track>(`/api/tracks/${id}/artwork/found`),
  /** Thumbnail URL; the hash in it keeps the browser cache honest. */
  artUrl: (t: { id: number; art: { hash: string } | null; artFound: { hash: string } | null }, which: "current" | "found", size = 160) => {
    const ref = which === "found" ? t.artFound : t.art
    return ref ? api.artUrlFor(t.id, which, ref.hash, size) : null
  },
  /** "original": the picture the file came with, kept when a cut replaced it. */
  artUrlFor: (trackId: number, which: "current" | "found" | "original", hash: string, size = 160) => `/api/tracks/${trackId}/art?which=${which}&size=${size}&h=${hash.slice(0, 12)}`,
  /** Use the found artwork (written when cut), or keep the file's own picture. */
  chooseArtwork: (ids: number[], use: boolean) => post<{ changed: number; tracks?: Track }>("/api/artwork/choose", { ids, use }),
  rescoreOne: (id: number) => post<Track>(`/api/tracks/${id}/rescore`),
  /** Identify a track by its sound alone (AcoustID): what it heard, best first. */
  listen: (id: number) => post<{ suggestions: Candidate[]; unnamed: number; track: Track }>(`/api/tracks/${id}/listen`),
  insight: (id: number) => get<TrackInsight>(`/api/tracks/${id}/insight`),
  retag: (s: Selection) => post<Job>("/api/retag", sel(s)),
  mixes: (id: number) => get<MixSuggestion[]>(`/api/tracks/${id}/mixes`),
  audioUrl: (id: number) => `/api/tracks/${id}/audio`,

  process: (s: Selection | null, opts: { interpret?: boolean; scour?: boolean; force?: boolean; rescour?: boolean }) => post<Job>("/api/process", { ...(s ? sel(s) : {}), ...opts }),
  rescore: (s?: Selection) => post<Job>("/api/rescore", s ? sel(s) : {}),
  plan: (s?: Selection) => post<PlanItem[]>("/api/plan", s ? sel(s) : {}),
  execute: (s: Selection, dryRun: boolean) => post<Job>("/api/execute", { ...sel(s), dryRun }),
  batches: () => get<OperationBatch[]>("/api/operations/batches"),
  operations: (batchId: string) => get<Operation[]>(`/api/operations?batchId=${encodeURIComponent(batchId)}`),
  rewind: (body: { batchId?: string; opIds?: number[] }) => post<Job>("/api/rewind", body),

  jobs: () => get<{ active: Job[]; recent: Job[] }>("/api/jobs"),
  /** oldest first; `more` says there's more in the direction asked (older by default, newer with `after`) */
  logs: (f: LogFilter, page: { before?: number; after?: number; limit?: number } = {}) => get<{ entries: LogEntry[]; more: boolean }>(`/api/logs?${logFilterQuery(f, page)}`),
  logSummary: (f: LogFilter) => get<LogSummary & { detail: boolean; keepDays: number }>(`/api/logs/summary?${logFilterQuery(f)}`),
  logDownloadUrl: (f: LogFilter) => `/api/logs/download?${logFilterQuery(f)}`,
  clearLogs: () => del<{ cleared: number }>("/api/logs"),
  cancelJob: (id: string) => post<{ ok: boolean }>(`/api/jobs/${id}/cancel`),

  settings: () => get<PublicSettings>("/api/settings"),
  saveSettings: (patch: SettingsPatch) => put<PublicSettings>("/api/settings", patch),

  models: (provider: string) => get<{ models: string[]; error?: string }>(`/api/llm/models?provider=${encodeURIComponent(provider)}`),
  aiUsage: () => get<AiUsageReport>("/api/llm/usage"),
  testLlm: (providerId: string) => post<{ ok: boolean; message: string; latencyMs: number }>("/api/llm/test", { providerId }),
  playground: (filename: string, ai: boolean) => post<{ heuristic: HeuristicParse; ai?: AiParse; error?: string }>("/api/playground", { filename, ai }),

  sources: () => get<SourceStatus[]>("/api/sources"),
  testSource: (id: string, artist: string, title: string) => post<{ candidates?: Candidate[]; error?: string; ms: number }>("/api/sources/test", { id, artist, title }),
  testScraper: (definition: ScraperDefinition, query: string) => post<{ candidates: Candidate[]; itemCount: number; error?: string }>("/api/scrapers/test", { definition, query }),
  clearCache: () => post<{ cleared: number }>("/api/cache/clear"),
  collection: () => get<CollectionStatus>("/api/sources/discogs-collection"),
  syncCollection: () => post<Job>("/api/sources/discogs-collection/sync"),
  tokens: () => get<ApiToken[]>("/api/tokens"),
  createToken: (name: string, scope: ApiToken["scope"]) => post<ApiToken & { token: string }>("/api/tokens", { name, scope }),
  deleteToken: (id: number) => del<{ ok: true }>(`/api/tokens/${id}`),
  hookCalls: () => get<HookCall[]>("/api/hooks/recent"),

  videos: () => get<{ items: VideoItem[]; ffmpeg: boolean; ffprobe: boolean }>("/api/videos"),
  convertVideos: (ids?: number[]) => post<Job>("/api/videos/convert", ids ? { ids } : {}),

  acoustidSubmissions: () => get<AcoustIdSubmissions>("/api/acoustid/submissions"),
  acoustidSubmit: (s?: Selection) => post<Job>("/api/acoustid/submit", s ? sel(s) : {}),
  acoustidCheck: () => post<AcoustIdSubmissions & { imported: number }>("/api/acoustid/check"),
  mbSubmissions: () => get<MbSubmission[]>("/api/musicbrainz/submissions"),
  mbSeed: (s: Selection) => post<MbSeed>("/api/musicbrainz/seed", { ...sel(s), base: window.location.origin }),
  mbSubmitted: (id: number) => post<MbSubmission>(`/api/musicbrainz/submissions/${id}/submitted`),
  mbComplete: (id: number, releaseMbid: string) => post<{ submission: MbSubmission; recordings: number }>(`/api/musicbrainz/submissions/${id}/complete`, { releaseMbid }),

  crates: () => get<Crate[]>("/api/crates"),
  crate: (id: number) => get<Crate>(`/api/crates/${id}`),
  crateFacets: (libraryId?: number) => get<CrateFacets>(`/api/crates/facets${libraryId ? `?libraryId=${libraryId}` : ""}`),
  cratePreview: (rules: CrateRules) => post<{ items: TrackSummary[]; total: number }>("/api/crates/preview", { rules }),
  createCrate: (name: string, rules: CrateRules) => post<Crate>("/api/crates", { name, rules }),
  updateCrate: (id: number, body: { name?: string; rules?: CrateRules }) => patch<Crate>(`/api/crates/${id}`, body),
  deleteCrate: (id: number) => del<{ ok: true }>(`/api/crates/${id}`),
  exportDj: (req: DjExportRequest) =>
    download("/api/export/dj", { format: req.format, name: req.name, crateIds: req.crateIds, pathMap: req.pathMap, traktorVolume: req.traktorVolume, ...(req.selection ? sel(req.selection) : {}) }),

  aliases: () => get<Alias[]>("/api/aliases"),
  addAlias: (alias: string, canonical: string) => post<Alias[]>("/api/aliases", { alias, canonical }),
  deleteAlias: (id: number) => del<{ ok: true }>(`/api/aliases/${id}`),
  corrections: () => get<Correction[]>("/api/corrections"),
  deleteCorrection: (id: number) => del<{ ok: true }>(`/api/corrections/${id}`),

  duplicates: () => get<{ groups: DuplicateGroup[]; setAside: number; holdingFolder: string }>("/api/duplicates"),
  resolveDuplicates: (groups: { keep: number; aside: number[] }[]) => post<Job>("/api/duplicates/resolve", { groups }),

  organisePreview: (req: OrganiseRequest) => post<OrganisePreview>("/api/organise/preview", req),
  organise: (req: OrganiseRequest) => post<Job>("/api/organise", req),

  backupUrl: (secrets: boolean) => `/api/backup${secrets ? "?secrets=1" : ""}`,
  restore: (backup: BackupFile, parts: { settings: boolean; learnings: boolean; libraries: boolean; crates: boolean }) => post<RestoreResult>("/api/restore", { backup, parts }),

  testMediaServer: (server: MediaServerConfig) => post<{ ok: boolean; message: string }>("/api/integrations/media-server/test", { server }),
  testChat: (channel: "discord" | "telegram", integrations: Settings["integrations"]) =>
    post<{ ok: boolean; message: string }>("/api/integrations/chat/test", { channel, integrations }),
  exportUrl: (f: TrackFilter, format: "csv" | "json") => `/api/export?${filterToQuery(f)}&format=${format}`,
}
