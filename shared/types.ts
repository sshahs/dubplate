// Types shared by the Dubplate server and web client.

export type TrackStatus =
  | "new" // scanned, nothing else done
  | "interpreted" // AI/heuristic parse available
  | "scoured" // metadata sources queried
  | "matched" // high confidence consensus, ready to approve
  | "review" // medium confidence, needs a human look
  | "conflict" // sources disagree with each other
  | "unmatched" // nothing trustworthy found
  | "approved" // human (or auto-approve) signed off
  | "done" // renamed and/or tagged on disk
  | "rejected" // human said no
  | "error"

export const TRACK_STATUSES: TrackStatus[] = [
  "new",
  "interpreted",
  "scoured",
  "matched",
  "review",
  "conflict",
  "unmatched",
  "approved",
  "done",
  "rejected",
  "error",
]

export interface ExistingTags {
  artist?: string
  artists?: string[]
  title?: string
  album?: string
  albumArtist?: string
  year?: number
  genre?: string[]
  track?: number
  label?: string
  comment?: string
}

/** A reading of "who and what" a file is, from any parser. */
export interface TrackReading {
  artists: string[]
  featuring: string[]
  /** "vs" for clashes, "&" for collaborations */
  relation?: "&" | "vs" | "x"
  title: string
  version?: string
  year?: number
  album?: string
  label?: string
  riddim?: string
  event?: string
  genre?: string
}

export interface HeuristicParse extends TrackReading {
  cleaned: string
  trackNumber?: string
  hints: string[]
  confidence: number // 0..1
  notes: string[]
}

export interface AiParse extends TrackReading {
  confidence: number // 0..1
  reasoning: string
  alternatives: { artists: string[]; title: string }[]
  searchQueries: string[]
  provider: string
  model: string
}

export type SourceId =
  | "musicbrainz"
  | "discogs"
  | "lastfm"
  | "spotify"
  | "itunes"
  | "deezer"
  | "bandcamp"
  | "archive"
  | "mixcloud"
  | "youtube"
  | "acoustid"
  | `scraper:${string}`

export interface Candidate {
  source: SourceId
  sourceLabel: string
  artist: string
  artists?: string[]
  title: string
  album?: string
  year?: number
  label?: string
  genre?: string
  duration?: number // seconds
  url?: string
  externalId?: string
  /** 0..1, how well the source itself rated the hit (if exposed) */
  sourceScore?: number
  /** audio fingerprint match rather than a text search */
  fingerprint?: boolean
}

export interface ConfidenceFactor {
  key: string
  label: string
  score: number // 0..1
  weight: number
  detail: string
}

export interface CandidateCluster {
  artist: string
  title: string
  sources: SourceId[]
  support: number
  relevance: number
  candidates: Candidate[]
}

export interface Decision {
  artists: string[]
  featuring: string[]
  relation?: "&" | "vs" | "x"
  artist: string
  title: string
  version?: string
  year?: number
  album?: string
  label?: string
  genre?: string
  confidence: number // 0..100
  status: Extract<TrackStatus, "matched" | "review" | "conflict" | "unmatched">
  basis: "sources" | "ai" | "heuristic" | "tags"
  factors: ConfidenceFactor[]
  clusters: CandidateCluster[]
  warnings: string[]
}

/** The metadata a track will be renamed/tagged to. */
export interface FinalMeta {
  artists: string[]
  featuring: string[]
  relation?: "&" | "vs" | "x"
  title: string
  version?: string
  year?: number
  album?: string
  label?: string
  genre?: string
}

export interface Track {
  id: number
  libraryId: number
  path: string
  originalPath: string
  relDir: string
  filename: string
  ext: string
  size: number
  mtimeMs: number
  hash: string | null
  duration: number | null
  bitrate: number | null
  sampleRate: number | null
  codec: string | null
  tags: ExistingTags
  heuristic: HeuristicParse | null
  ai: AiParse | null
  candidates: Candidate[] | null
  decision: Decision | null
  final: FinalMeta | null
  confidence: number | null
  status: TrackStatus
  proposedName: string | null
  note: string | null
  missing: boolean
  createdAt: string
  updatedAt: string
}

export type TrackSummary = Omit<Track, "candidates" | "decision" | "heuristic" | "ai"> & {
  proposedArtist: string | null
  proposedTitle: string | null
  sourceCount: number
  conflict: boolean
}

export interface Library {
  id: number
  path: string
  name: string
  createdAt: string
  lastScanAt: string | null
  fileCount: number
  exists: boolean
}

export type JobKind = "scan" | "interpret" | "scour" | "score" | "process" | "execute" | "rewind"
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled"

export interface Job {
  id: string
  kind: JobKind
  status: JobStatus
  label: string
  total: number
  done: number
  failed: number
  message: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type ServerEvent =
  | { type: "job"; job: Job }
  | { type: "log"; level: "info" | "warn" | "error" | "success"; message: string; jobId?: string; at: string }
  | { type: "tracks"; ids: number[] }
  | { type: "stats" }

export interface Operation {
  id: number
  batchId: string
  trackId: number | null
  kind: "rename" | "tag" | "rename+tag"
  fromPath: string
  toPath: string
  tagsBefore: ExistingTags | null
  tagsAfter: ExistingTags | null
  status: "done" | "failed" | "reverted" | "dry-run"
  error: string | null
  createdAt: string
  revertedAt: string | null
}

export interface OperationBatch {
  batchId: string
  createdAt: string
  count: number
  done: number
  failed: number
  reverted: number
  dryRun: boolean
}

export interface PlanItem {
  trackId: number
  fromPath: string
  toPath: string
  fromName: string
  toName: string
  rename: boolean
  tags: ExistingTags
  tagChanges: { field: keyof ExistingTags; before: unknown; after: unknown }[]
  issues: string[]
  blocked: boolean
  confidence: number | null
}

export interface Stats {
  total: number
  byStatus: Record<TrackStatus, number>
  confidenceBuckets: { bucket: string; count: number }[]
  libraries: number
  operations: number
  duplicates: number
  sources: { source: string; hits: number }[]
}

// ---------- Settings ----------

export type LlmProviderKind = "ollama" | "ollama-cloud" | "openai" | "anthropic" | "commandcode" | "openai-compatible"

export interface LlmProviderConfig {
  id: string
  kind: LlmProviderKind
  label: string
  baseUrl: string
  model: string
  apiKey?: string
  enabled: boolean
  /** Command Code only: ask for Zero Data Retention (`x-cmd-zdr: 1`) on every request. */
  zdr?: boolean
}

export interface SourceConfig {
  enabled: boolean
  weight: number
  apiKey?: string
  apiSecret?: string
}

export interface ScraperField {
  /** CSS selector (optionally `selector@attr`) for html, dot path for json */
  artist?: string
  title?: string
  /** a combined "Artist - Title" string to be split */
  combined?: string
  url?: string
  year?: string
  label?: string
  album?: string
}

export interface ScraperDefinition {
  id: string
  name: string
  enabled: boolean
  weight: number
  kind: "html" | "json"
  /** URL template: {query} {artist} {title} are URL-encoded */
  searchUrl: string
  /** CSS selector for each result (html) or dot path to the results array (json) */
  items: string
  fields: ScraperField
  scene: string
  notes?: string
  verified?: boolean
}

export interface Settings {
  llm: {
    activeProvider: string
    providers: LlmProviderConfig[]
    temperature: number
    concurrency: number
    useCorrections: boolean
    sceneHint: string
  }
  sources: Record<string, SourceConfig>
  scrapers: ScraperDefinition[]
  confidence: {
    autoThreshold: number
    reviewThreshold: number
    autoApprove: boolean
    parseOnlyMax: number
  }
  naming: {
    template: string
    featuring: "artist" | "title" | "drop"
    appendVersion: boolean
    artistJoiner: string
    clashJoiner: string
    renameFiles: boolean
    writeTags: boolean
    tagComment: boolean
  }
  scanner: {
    extensions: string[]
    hashFiles: boolean
    ignore: string[]
  }
  safety: {
    readOnly: boolean
  }
  contact: string
}

export interface Alias {
  id: number
  alias: string
  canonical: string
}

export interface Correction {
  id: number
  filename: string
  artists: string[]
  title: string
  version: string | null
  createdAt: string
}

export interface HealthInfo {
  version: string
  dataDir: string
  readOnly: boolean
  fpcalc: boolean
  llm: { id: string; label: string; model: string; kind: LlmProviderKind } | null
}
