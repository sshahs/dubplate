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
  /** tracks on the disc, as the tag says */
  trackTotal?: number
  /** disc number, for releases on more than one CD or record */
  disc?: number
  discTotal?: number
  label?: string
  comment?: string
  bpm?: number
  /** musical key, e.g. "Am" or "F#" */
  key?: string
  /** content hash of the embedded front cover (the key into Dubplate's artwork cache) */
  cover?: string
  /** MusicBrainz recording ID ("MusicBrainz Track Id" in most taggers) */
  mbRecordingId?: string
  /** MusicBrainz release ID ("MusicBrainz Album Id") */
  mbReleaseId?: string
  /** MusicBrainz artist ID of the main artist */
  mbArtistId?: string
  /** Discogs release ID */
  discogsReleaseId?: string
  /** MusicBrainz release group ID */
  mbReleaseGroupId?: string
  /** ReplayGain 2 track gain in dB (the -18 LUFS reference) */
  replayGainTrackGain?: number
  /** ReplayGain track peak, as a linear sample value (1 = full scale) */
  replayGainTrackPeak?: number
  /**
   * Unsynced lyrics. Written and journalled in full; the database keeps only a
   * short description (e.g. "32 lines"), enough to know the file has some.
   */
  lyrics?: string
}

/** Catalogue identifiers a source can pin a track to. */
export interface ExternalIds {
  mbRecordingId?: string
  mbReleaseId?: string
  mbReleaseGroupId?: string
  mbArtistIds?: string[]
  discogsReleaseId?: string
}

/** A picture Dubplate knows about: embedded in a file, or found online to embed on cut. */
export interface ArtRef {
  /** sha1 of the image bytes */
  hash: string
  mime: string
  bytes: number
  width?: number
  height?: number
  source: "embedded" | SourceId
  /** the source's display name, e.g. "Apple Music" */
  sourceLabel?: string
  /** where it was downloaded from */
  url?: string
  /** what a vision model said about it, when the match was in doubt */
  check?: CoverCheck
}

/** A vision model's look at a found cover. */
export interface CoverCheck {
  model: string
  matches: boolean
  confidence: number
  reason: string
  at: string
}

/** How loud a track is (EBU R128 / ITU BS.1770) and the gain that evens it out. */
export interface LoudnessMeasure {
  /** integrated loudness, LUFS */
  lufs: number
  /** sample peak, linear (1 = full scale) */
  peak: number
  /** ReplayGain 2 track gain in dB: -18 LUFS minus the loudness */
  gain: number
}

/**
 * Where the high frequencies stop, and whether that fits the file's format. An
 * encoder's low-pass leaves a sharp "brick wall"; a lossless or 320 kbps file
 * with one well below 20 kHz was probably made from a lower-quality file.
 */
export interface QualityCheck {
  /** where the high end stops, Hz; null when there's content right to the top of the band */
  cutoffHz: number | null
  /** the drop is a brick wall (an encoder) rather than a gentle roll-off (the recording) */
  sharp: boolean
  /** "ok": fits the format; "suspect": sounds made from a lower-quality file; "unknown": can't tell */
  verdict: "ok" | "suspect" | "unknown"
  /** what the audio really is, when it doesn't fit, e.g. "a ~128 kbps MP3" */
  likely?: string
  detail: string
}

/** Whether the whole file decodes, and how much silence it starts and ends with. */
export interface IntegrityCheck {
  /** seconds of audio that decoded */
  decodedSeconds: number
  /** how long the file says it is, when that can be trusted (null: can't tell) */
  expectedSeconds: number | null
  /** it stops well before its stated length (a download or copy that didn't finish) */
  truncated: boolean
  /** decoding broke off this many seconds in */
  damagedAt: number | null
  damage?: string
  /** seconds of silence before the audio starts, and after it ends */
  silenceStart: number
  silenceEnd: number
}

/** What reading the file (not its audio) found out about it. */
/** A video the scanner found in a library; the converter makes an audio file from it. */
export interface VideoFile {
  id: number
  libraryId: number
  path: string
  relDir: string
  filename: string
  ext: string
  size: number
  /** what's inside, when ffprobe could look */
  probe: MediaProbe | null
  /** "no-audio": there's nothing to pull out */
  status: "found" | "converted" | "failed" | "no-audio"
  /** the audio file made from it */
  outputPath: string | null
  error: string | null
  convertedAt: string | null
  /** where it was before it was moved to the holding folder after converting */
  asideFrom: string | null
  missing: boolean
}

/** How a video's audio becomes an audio file. */
export interface ConvertPlan {
  /** "copy": the audio as it is, nothing lost; "encode": re-encoded */
  mode: "copy" | "encode"
  /** the audio file's extension */
  ext: string
  /** in words, e.g. "AAC, kept as it is (.m4a)" */
  label: string
}

/** One audio stream inside a media file, as ffprobe sees it. */
export interface MediaAudioStream {
  /** its position among the file's audio streams */
  index: number
  /** ffmpeg's codec id, e.g. "aac", "mp3", "wmav2", "amr_nb" */
  codec: string
  /** a readable name, e.g. "AAC", "AMR (phone)" */
  codecName: string
  sampleRate: number | null
  channels: number | null
  /** bits per second */
  bitRate: number | null
  duration: number | null
}

export interface MediaProbe {
  /** ffmpeg's container name(s), e.g. "avi", "mov,mp4,m4a,3gp,3g2,mj2" */
  format: string
  duration: number | null
  /** has a picture track (not just cover art) */
  video: boolean
  audio: MediaAudioStream[]
}

export interface FileCheck {
  /** what the file really is, by its content, when its extension says otherwise (e.g. "m4a") */
  realExt?: string
  /** a readable name for that, e.g. "M4A (AAC)" */
  realFormat?: string
  /** the tags couldn't be read */
  unreadable?: string
  /** a zero-byte file */
  empty?: boolean
  /** the container itself is broken, e.g. a WMA whose header runs over its audio */
  containerDamage?: string
}

export type FileProblemKind = "format" | "unreadable" | "empty" | "damaged" | "truncated" | "silence"

export interface FileProblem {
  kind: FileProblemKind
  /** "error": the file is broken; "warn": worth fixing; "info": worth knowing */
  severity: "error" | "warn" | "info"
  label: string
  detail: string
}

/** Lyrics looked up for a track, written into it when it's cut. */
export interface LyricsFound {
  /** the artist and title they were looked up for (normalised): a different reading is looked up again */
  for: string
  found: boolean
  /** why nothing was found or looked up */
  reason?: string
  /** the source says the tune has no words */
  instrumental?: boolean
  plain?: string
  /** LRC lines, "[mm:ss.xx] words", when the source had them timed to this length of track */
  synced?: string
  source?: "lrclib"
  /** the source's own id */
  sourceId?: number
  /** you said these are the wrong words */
  rejected?: boolean
  at: string
}

/** What listening to the audio said about tempo and key. */
export interface TrackAnalysis {
  bpm: number | null
  /** 0..1, how clear the pulse was */
  bpmConfidence: number
  /** musical notation, e.g. "Am" */
  key: string | null
  /** 0..1, how far the best key stood out from the rest */
  keyConfidence: number
  /** seconds of audio listened to */
  seconds: number
  analyzedAt: string
  error?: string
  /** measured over the whole file (missing on tracks analysed before loudness existed) */
  loudness?: LoudnessMeasure | null
  quality?: QualityCheck | null
  /** whether it all decodes, and silence at the ends (missing on tracks analysed before this existed) */
  integrity?: IntegrityCheck | null
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

/** Where a track sits on its record: disc, side and number, as its name and folders say. */
export interface DiscPosition {
  /** disc (or record) number, 1-based */
  disc?: number
  /** vinyl or tape side, "A".."H" */
  side?: string
  /** number on the side (A2 is 2), or on the disc */
  number?: number
  /** as the file or folder put it: "CD2", "Side B", "B2" */
  label?: string
  /** the file is a whole side or disc (or a part of one), not one track */
  whole?: boolean
  /** which part of a side or disc split over several files ("Side B Part 2") */
  part?: number
}

export interface HeuristicParse extends TrackReading {
  cleaned: string
  trackNumber?: string
  /** disc, side and number, from the filename and folders (CD1/CD2, Side A, A1…) */
  position?: DiscPosition
  hints: string[]
  confidence: number // 0..1
  notes: string[]
}

export interface AiParse extends TrackReading {
  /** the main artist's home country, ISO code, when the model knows it */
  country?: string
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
  | "discogs-collection"
  | "soundclashhub"
  | "whocorkthedance"
  | "riddimguide"
  | "riddimid"
  | "reggaefever"
  | "riddimsworld"
  | "ravetapepacks"
  | "ravearchive"
  | "mixesdb"
  | "junglist"
  | `scraper:${string}`

/**
 * What kind of release something is, in the order an artist's own release
 * context is preferred: their album, EP, single, a standalone release, a remix
 * or re-release of their own, a mixtape or street release, then compilations,
 * DJ mixes and anything else.
 */
export type ReleaseKind = "album" | "ep" | "single" | "standalone" | "remix" | "mixtape" | "live" | "compilation" | "dj-mix" | "other"

/** A release a recording appears on, as a source describes it. */
export interface ReleaseInfo {
  source: SourceId
  title: string
  kind: ReleaseKind
  /** the release is the artist's own (not Various Artists or someone else's) */
  own: boolean | null
  /** MusicBrainz release / release group, or a Discogs release id */
  id?: string
  groupId?: string
  /** "Official", "Promotion", "Bootleg"… (MusicBrainz) */
  status?: string
  date?: string
  country?: string
  label?: string
  /** the source's own words for the type, e.g. "Album + Compilation", "Vinyl, 12\", Mixed" */
  typeText?: string
  /** the recording on it (MusicBrainz), and that recording's length in seconds */
  recordingId?: string
  length?: number
}

export interface Candidate {
  source: SourceId
  sourceLabel: string
  artist: string
  artists?: string[]
  title: string
  album?: string
  year?: number
  label?: string
  /** the riddim a tune is voiced on, where the source names it */
  riddim?: string
  genre?: string
  duration?: number // seconds
  url?: string
  externalId?: string
  /** 0..1, how well the source itself rated the hit (if exposed) */
  sourceScore?: number
  /** audio fingerprint match rather than a text search */
  fingerprint?: boolean
  /** cover art URL (the largest the source offers) */
  artwork?: string
  /** catalogue identifiers (MusicBrainz, Discogs) for writing to tags */
  ids?: ExternalIds
  /** the releases this recording appears on, where the source says (for choosing the release) */
  releases?: ReleaseInfo[]
  /** genres and styles as the source words them */
  genres?: string[]
  /** where the release came out (ISO country, e.g. "GB") */
  country?: string
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
  riddim?: string
  genre?: string
  confidence: number // 0..100
  status: Extract<TrackStatus, "matched" | "review" | "conflict" | "unmatched">
  basis: "sources" | "ai" | "heuristic" | "tags"
  factors: ConfidenceFactor[]
  clusters: CandidateCluster[]
  warnings: string[]
  /** the release chosen for the recording, and why */
  release?: ReleaseChoice | null
  /** what kind of recording this is, and whether length and fingerprint back it up */
  versionCheck?: VersionCheck
  /** which reading or source each field came from */
  provenance?: Partial<Record<ProvenanceField, string>>
  /** a second, larger model looked at it: never approved without a person */
  escalated?: Escalation
  /** genres the sources gave, as they worded them */
  sourceGenres?: string[]
  /** the one genre from the canonical list (when canonical genres are on) */
  canonicalGenre?: CanonicalGenre | null
}

export type ProvenanceField = "artists" | "title" | "version" | "year" | "album" | "label" | "genre" | "release"

export interface ReleaseChoice {
  release: ReleaseInfo
  /** in words: "the artist's own album", "the file's album tag names this compilation"… */
  reason: string
  /** how many releases were weighed */
  considered: number
  /** the best of the artist's own, when evidence kept a compilation or DJ mix instead */
  ownAlternative?: ReleaseInfo
}

export type VersionKind = "original" | "remix" | "vip" | "dubplate" | "live" | "edit" | "exclusive" | "compilation" | "dj-mix"

export interface VersionCheck {
  kind: VersionKind
  label: string
  /** the chosen release is officially the artist's (MusicBrainz status "Official" on their own release) */
  official: boolean | null
  /** the file's length is within a few seconds of the recording's */
  durationMatch: boolean | null
  /** an audio fingerprint points at this recording */
  fingerprintMatch: boolean | null
}

export interface Escalation {
  provider: string
  model: string
  at: string
  /** what the first pass had */
  before: { confidence: number; status: Decision["status"]; artists: string[]; title: string }
  /** the second model read it differently */
  changed: boolean
  reason: string
}

export interface CanonicalGenre {
  genre: string
  /** the genre's own folder: its name, unless the rule names the folder differently */
  folder: string
  /** the folder above it (e.g. "UK", "US"), empty when it has none */
  region: string
  /** what matched: a source genre, the AI, the file's tag, the title, or you */
  from: string
}

/** One rule of the canonical genre list. */
export interface GenreRule {
  /** the genre written to the tag (and the folder's name, unless `folder` says otherwise) */
  genre: string
  /** the folder's name when it isn't the genre, e.g. "House Genres" for House */
  folder?: string
  /** folder above the genre ("UK", "US"); empty for none */
  region: string
  /** source genres and styles that mean this one, e.g. "grime", "grime revival" */
  match: string[]
  /** words in the title, version or album that put a track here whatever its style, e.g. "daily duppy" */
  titles?: string[]
  /** source genres containing these words never count for it, e.g. "rock" so "garage rock" isn't UK Garage */
  exclude?: string[]
  /** only when the music's from one of these (e.g. ["UK"]); "?" allows unknown; empty = anywhere */
  regions?: string[]
}

/** How safe it is to let automation change a file, apart from how sure the identification is. */
export interface RiskAssessment {
  level: "low" | "medium" | "high"
  reasons: string[]
}

/** One step of how a track was decided, in order. */
export interface DecisionStep {
  key: "recording" | "release" | "version" | "genre" | "safety" | "verified" | "acoustid" | "musicbrainz"
  label: string
  state: "ok" | "warn" | "bad" | "info" | "pending"
  value: string
  detail?: string
}

/** A fingerprint sent to AcoustID. */
export interface AcoustIdSubmission {
  id: number
  trackId: number | null
  status: "pending" | "imported" | "failed"
  submissionId: number | null
  acoustId: string | null
  mbRecordingId: string | null
  error: string | null
  submittedAt: string
  checkedAt: string | null
}

/** What stands between a track and an AcoustID submission. */
export interface AcoustIdEligibility {
  eligible: boolean
  checks: { key: string; label: string; ok: boolean; detail?: string }[]
  submission: AcoustIdSubmission | null
}

/** A release sent to MusicBrainz's release editor for a person to check and submit. */
export interface MbSubmission {
  id: number
  trackIds: number[]
  title: string
  status: "pending" | "submitted" | "received"
  releaseMbid: string | null
  createdAt: string
  updatedAt: string
}

/** A scraper's recent health, to switch off one that's started returning login or home pages. */
export interface SourceHealth {
  sourceId: string
  badInARow: number
  lastBad: string | null
  lastOkAt: string | null
  disabledAt: string | null
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
  /** tempo in beats per minute (from the file's tags, the analyser or you) */
  bpm: number | null
  /** musical key in musical notation, e.g. "Am" */
  key: string | null
  analysis: TrackAnalysis | null
  /** the picture embedded in the file now */
  art: ArtRef | null
  /** artwork found online, embedded when the track is cut */
  artFound: ArtRef | null
  /** moved to the library's holding folder as a duplicate (the track is then hidden) */
  aside: SetAside | null
  /** what reading the file found (a wrong extension, unreadable tags…) */
  fileCheck: FileCheck | null
  /** lyrics found online, written when the track is cut */
  lyrics: LyricsFound | null
  /** Chromaprint fingerprint, kept for AcoustID (never sent anywhere else) */
  fingerprint: { duration: number; fingerprint: string; at: string } | null
  /** the file as first scanned: name, place and tags, never changed afterwards */
  original: { filename: string; path: string; tags: ExistingTags; scannedAt: string } | null
  /** IDs set by hand or by a MusicBrainz submission; they win over what sources found */
  idsOverride: ExternalIds | null
  /** a second, larger model's reading of an uncertain track (it replaces the first in scoring) */
  escalation: (Escalation & { ai: AiParse }) | null
  /** who approved it: a person, auto-approve, or a hands-off library */
  approvedBy: "person" | "auto" | "hands-off" | null
  createdAt: string
  updatedAt: string
}

/** Where a duplicate went when it was set aside, and which copy was kept. */
export interface SetAside {
  at: string
  from: string
  keptId: number | null
}

export type TrackSummary = Omit<Track, "candidates" | "decision" | "heuristic" | "ai" | "lyrics" | "fingerprint" | "original" | "escalation"> & {
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
  /** pick up new files automatically */
  watch: boolean
  /** "watching": live file events; "polling": checked every few minutes (events unavailable) */
  watchState: "watching" | "polling" | "off"
  /** this library's own settings; anything unset follows the app's */
  settings: LibrarySettings
}

/** Per-library overrides of the app settings. A missing field means "same as the app". */
export interface LibrarySettings {
  /** what's in this library's crates (empty list = any genre) */
  genres?: string[]
  sceneHint?: string
  /** filename template */
  template?: string
  /** folder template for organising */
  folderTemplate?: string
  /** move files into folders when cutting */
  organiseOnCut?: boolean
  /** hands-off: confident matches are approved and cut (and moved into place) without asking */
  handsOff?: boolean
  /** an inbox: cut tracks move into this library, into its folder layout */
  inboxFor?: number
}

export type JobKind = "convert" | "scan" | "interpret" | "scour" | "score" | "process" | "execute" | "rewind" | "analyze" | "artwork" | "organise" | "duplicates" | "sync" | "lyrics" | "upload" | "acoustid" | "retag"
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
  /** null for a file that isn't a track (cover images, cue sheets moved along with a folder) */
  trackId: number | null
  /**
   * "move": into another folder, name and tags untouched; "set-aside": a duplicate (or a converted
   * video) moved to the holding folder; "write": a new file Dubplate made (a .lrc), its contents in
   * tagsAfter.lyrics; "convert": an audio file made from the video at fromPath
   */
  kind: "rename" | "tag" | "rename+tag" | "move" | "set-aside" | "write" | "convert"
  fromPath: string
  toPath: string
  tagsBefore: ExistingTags | null
  tagsAfter: ExistingTags | null
  status: "done" | "failed" | "reverted" | "dry-run"
  error: string | null
  createdAt: string
  revertedAt: string | null
  /** the track's status before, so a rewind can put it back */
  statusBefore: TrackStatus | null
  /** folders this operation created, removed again by a rewind if they're left empty */
  createdDirs: string[]
  /** what the batch was, e.g. "Cut" or "Organise" */
  batchLabel: string | null
  /** content hash of a file Dubplate made, so a rewind only takes it away while it's unchanged */
  hashAfter: string | null
}

export interface OperationBatch {
  batchId: string
  /** "Cut", "Organise", "Set aside duplicates"… */
  label: string
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
  /** folder inside the library, before and after ("" = the library's top level) */
  fromDir: string
  toDir: string
  /** the file changes name or folder */
  rename: boolean
  /** set when the file moves into another library (an inbox feeding it) */
  toLibraryId?: number
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
  /** videos waiting to have their audio pulled out */
  videos: number
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
  /** what the provider charges per million input (prompt) tokens, for cost estimates */
  priceIn?: number
  /** per million output tokens */
  priceOut?: number
}

export interface SourceConfig {
  enabled: boolean
  weight: number
  apiKey?: string
  apiSecret?: string
  /** a multiplier per genre (crates picker names), in place of the flat ×1.2 for a good fit */
  genreWeights?: Record<string, number>
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
  /** cover image URL, e.g. `img.cover@src` */
  artwork?: string
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
  /** json only: the JSON sits inside a web page, in the element this CSS selector finds (e.g. a script tag) */
  embedded?: string
  scene: string
  notes?: string
  verified?: boolean
  /** genres this site is good for (names from the crates picker) */
  genres?: string[]
  /** a multiplier per genre, in place of the flat ×1.2 for a good fit */
  genreWeights?: Record<string, number>
  /** its hits back up other sources but never confirm a track on their own */
  supportingOnly?: boolean
  /** switched off by the health check, and why */
  disabledReason?: string
}

export interface Settings {
  llm: {
    activeProvider: string
    providers: LlmProviderConfig[]
    temperature: number
    concurrency: number
    useCorrections: boolean
    /** Genres and kinds of recording in the collection, as picked by the owner. Empty = any genre. */
    genres: string[]
    /** Free-text notes about the collection, added to what the genres say. */
    sceneHint: string
    /** stop using the AI for the rest of the month once estimated spend reaches this (0 = no limit) */
    monthlyBudget: number
    /** symbol shown with prices and costs */
    currency: string
    /**
     * A second, larger model for the uncertain ones: scores in [from, to] or sources
     * in conflict (never the "no source knows it" cap). What it reads always goes to Review.
     */
    escalation: { enabled: boolean; providerId: string; model: string; from: number; to: number }
    /** a vision model that looks at a found cover when the match is in doubt */
    vision: { enabled: boolean; providerId: string; model: string }
  }
  sources: Record<string, SourceConfig>
  scrapers: ScraperDefinition[]
  /** built-in scraper presets already offered, so ones added in later versions appear once */
  scraperPresetsSeen?: string[]
  /** the preset fixes already applied to saved scrapers */
  scraperRevision?: number
  confidence: {
    autoThreshold: number
    reviewThreshold: number
    autoApprove: boolean
    parseOnlyMax: number
    /** trust sources that suit the picked genres a little more */
    genreAware: boolean
    /** prefer the artist's own album, EP or single over compilations and DJ mixes (unless the file says otherwise) */
    preferOwnRelease: boolean
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
    /** write MusicBrainz and Discogs IDs when the sources found them */
    writeIds: boolean
    /** give a file whose extension is wrong for its format the right one when cutting */
    fixExtensions: boolean
  }
  organise: {
    /** folder template, e.g. "{artist}/[{year} - ]{album}"; "/" starts a new folder level */
    template: string
    /** move files into their folders when cutting */
    onCut: boolean
    /** a folder level with nothing to show: skip it, or name it "Unknown …" */
    missing: "skip" | "unknown"
    /** remove folders left empty by a move */
    tidy: boolean
    /** move cover images, cue sheets and the like along when a whole folder moves */
    sidecars: boolean
  }
  duplicates: {
    /** folder at each library's top level where set-aside copies go (never scanned) */
    holdingFolder: string
  }
  integrations: {
    mediaServers: MediaServerConfig[]
    discord: { enabled: boolean; webhookUrl?: string }
    telegram: { enabled: boolean; botToken?: string; chatId?: string }
    /** what to announce in Discord / Telegram */
    notify: { jobs: boolean; review: boolean }
    /** Dubplate's address as others reach it, for links in messages */
    publicUrl: string
  }
  scanner: {
    extensions: string[]
    /** videos whose audio the converter can pull out (AVI, 3GP, WMV…); scans list them, never change them */
    videoExtensions: string[]
    hashFiles: boolean
    ignore: string[]
  }
  /** pulling the audio out of videos (needs ffmpeg) */
  convert: {
    /** keep the audio exactly as it is when an audio file can hold it (AAC, MP3, WMA…): nothing lost */
    keepAudio: boolean
    /** what to make when it has to be re-encoded (AMR from old phones, AC-3, ADPCM…) */
    encodeTo: "mp3" | "m4a" | "flac"
    /** the video afterwards: left where it is, or moved to the holding folder */
    originals: "keep" | "aside"
    /** convert videos scans find straight away */
    auto: boolean
  }
  safety: {
    readOnly: boolean
  }
  artwork: {
    /** look for cover art when identifying tracks */
    fetch: boolean
    /** embed found artwork when cutting */
    embed: boolean
    /** replace artwork a file already has */
    replaceExisting: boolean
  }
  analysis: {
    /** analyse BPM and key as part of identifying tracks */
    onProcess: boolean
    /** write BPM and key to the file's tags when cutting */
    writeTags: boolean
    /** how the key is written to tags */
    keyNotation: "musical" | "camelot"
    /** BPMs are folded into [bpmMin, 2 × bpmMin) */
    bpmMin: number
    /** check whether files are really the quality they claim (spectrum cut-off) */
    quality: boolean
    /** measure loudness (EBU R128) */
    loudness: boolean
    /** write ReplayGain tags when cutting */
    writeReplayGain: boolean
    /** check the whole file decodes, and measure silence at the ends */
    integrity: boolean
  }
  automation: {
    /** identify files that watched folders or the nightly scan pick up */
    autoProcess: boolean
    /** re-check watched folders this often (minutes; 0 = only on file events) */
    pollMinutes: number
    /** rescan every library once a night */
    nightly: boolean
    /** "HH:MM", server time */
    nightlyAt: string
    /** hands-off libraries: how sure a match must be to be cut without asking */
    handsOffMin: number
  }
  exports: {
    /** rewrite paths for software on another computer, e.g. /music → D:\Music */
    pathMap: PathMapping[]
    /** Traktor's name for the drive the music is on (e.g. "Macintosh HD"; Windows paths use their drive letter) */
    traktorVolume: string
  }
  lyrics: {
    /** look lyrics up when identifying tracks */
    fetch: boolean
    /** write them into the file when cutting */
    embed: boolean
    /** put the timed (LRC) version in the tag when there is one, for players that scroll along */
    embedSynced: boolean
    /** save timed lyrics as a .lrc file next to the track */
    lrcFile: boolean
    /** replace lyrics a file already has */
    replaceExisting: boolean
  }
  uploads: {
    /** largest file accepted, in MB */
    maxMb: number
  }
  hooks: {
    /** folders as download tools see them → as Dubplate does, e.g. /downloads → /music/Downloads */
    pathMap: PathMapping[]
  }
  acoustid: {
    /** send fingerprints of verified tracks to AcoustID */
    submit: boolean
    /** your AcoustID user API key (acoustid.org, after signing in); the application key is the source's */
    userKey?: string
  }
  /** one genre per track, from your own list */
  canonicalGenres: {
    enabled: boolean
    /** write the canonical genre over whatever genre a file has (off: only into files without one) */
    overwrite: boolean
    rules: GenreRule[]
  }
  contact: string
}

/** A key for scripts and download tools to call Dubplate with. Only its hash is stored. */
export interface ApiToken {
  id: number
  name: string
  /** the first characters, to tell tokens apart */
  prefix: string
  /** "hooks": only the import hook and uploads; "full": the whole API (not sign-in or tokens) */
  scope: "hooks" | "full"
  createdAt: string
  lastUsedAt: string | null
}

/** A call to the import hook, kept for a while so a setup can be checked. */
export interface HookCall {
  at: string
  /** the token's name */
  token: string
  /** which tool it looked like: "qBittorrent", "slskd", "Lidarr"… */
  from: string
  /** a tool's "test" call */
  test: boolean
  paths: string[]
  /** libraries queued for a scan */
  libraries: string[]
  ignored: { path: string; reason: string }[]
}

/** A file saved by an upload. */
export interface UploadResult {
  /** where it went, relative to the library */
  path: string
  name: string
  size: number
  libraryId: number
}

export interface PathMapping {
  from: string
  to: string
}

export type MediaServerKind = "plex" | "jellyfin" | "navidrome"

export interface MediaServerConfig {
  id: string
  kind: MediaServerKind
  name: string
  url: string
  /** Plex token, Jellyfin/Emby API key, or the Navidrome password */
  token?: string
  /** Navidrome user */
  user?: string
  enabled: boolean
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
  /** a password is set (the rest of the fields are left out until you sign in) */
  auth?: boolean
  version: string
  dataDir: string
  readOnly: boolean
  fpcalc: boolean
  llm: { id: string; label: string; model: string; kind: LlmProviderKind } | null
  /** the server's time zone, for scheduled scans */
  timeZone: string
}

// ---------- organising ----------

export interface OrganiseMove {
  trackId: number | null
  from: string
  to: string
  /** paths inside the library */
  fromRel: string
  toRel: string
  issues: string[]
  blocked: boolean
  /** a cover image, cue sheet or similar moving along with its folder */
  sidecar?: boolean
}

export interface OrganisePreview {
  libraryId: number
  template: string
  counts: { tracks: number; moving: number; unchanged: number; blocked: number; notReady: number; sidecars: number; folders: number }
  /** the folders files will be in afterwards, with how many files each and a few names */
  folders: { path: string; count: number; samples: string[] }[]
  /** a sample of the moves */
  moves: OrganiseMove[]
  blocked: OrganiseMove[]
}

// ---------- duplicates ----------

export interface DuplicateGroup {
  key: string
  kind: "hash" | "name"
  tracks: TrackSummary[]
  /** the copy Dubplate would keep */
  best: number
  /** why each copy ranks where it does, e.g. "FLAC, already cut" */
  reasons: Record<number, string>
}

// ---------- backup ----------

export interface BackupFile {
  app: "dubplate"
  format: 1
  version: string
  exportedAt: string
  /** API keys and tokens included */
  secrets: boolean
  settings: Settings
  aliases: { alias: string; canonical: string }[]
  corrections: { filename: string; artists: string[]; title: string; version: string | null; createdAt: string }[]
  /** an inbox's target is saved by folder, since library IDs differ from one install to the next */
  libraries: { path: string; name: string; watch: boolean; settings: LibrarySettings; inboxForPath?: string }[]
  /** smart crates (a crate limited to one library names it by folder) */
  crates?: { name: string; rules: CrateRules; libraryPath?: string }[]
}

// ---------- sign-in ----------

export interface AuthStatus {
  /** a password is set */
  enabled: boolean
  authenticated: boolean
  /** set with DUBPLATE_PASSWORD, so it can't be changed here */
  fromEnv: boolean
}

// ---------- smart crates ----------

/** A saved filter. Every rule that's set must match; lists match any of their values. */
export interface CrateRules {
  genres?: string[]
  bpmMin?: number
  bpmMax?: number
  /** count tracks at half or double the range too (a 70 BPM one-drop in a 140 crate) */
  halfDouble?: boolean
  /** musical notation, e.g. "Am" */
  keys?: string[]
  /** this key and the keys that mix with it on the Camelot wheel */
  mixesWith?: string
  yearFrom?: number
  yearTo?: number
  labels?: string[]
  artists?: string[]
  libraryId?: number
  statuses?: TrackStatus[]
  /** filename, folder or tag text */
  text?: string
  quality?: "ok" | "suspect"
}

export interface Crate {
  id: number
  name: string
  rules: CrateRules
  /** tracks in it now */
  count: number
  createdAt: string
  updatedAt: string
}

/** What a library has, for picking crate rules. */
export interface CrateFacets {
  genres: { value: string; count: number }[]
  labels: { value: string; count: number }[]
  keys: { value: string; count: number }[]
  bpm: { min: number | null; max: number | null }
  years: { min: number | null; max: number | null }
}

// ---------- mixing ----------

export type KeyRelation = "same" | "up" | "down" | "relative" | "boost"

export interface MixSuggestion {
  track: TrackSummary
  /** null when this track has no key to go by */
  keyRelation: KeyRelation | null
  /** tempo difference in percent (after half/double time) */
  bpmDiff: number
  /** matched at half or double time */
  halfDouble: boolean
}

// ---------- DJ software ----------

export type DjFormat = "rekordbox" | "traktor" | "serato" | "m3u"

// ---------- AI usage ----------

export interface UsageTotals {
  input: number
  output: number
  calls: number
  /** null when the provider has no prices set */
  cost: number | null
}

export interface AiUsageReport {
  currency: string
  /** 0 = no limit */
  budget: number
  /** spend so far this calendar month (known prices only) */
  monthCost: number
  month: UsageTotals
  byProvider: (UsageTotals & { providerId: string; label: string; model: string; priced: boolean })[]
  /** the last 30 days, oldest first, quiet days included */
  byDay: (UsageTotals & { day: string })[]
  runs: (UsageTotals & { jobId: string; label: string; at: string })[]
}

// ---------- health ----------

export type CheckStatus = "ok" | "warn" | "error" | "info"

export interface HealthCheck {
  id: string
  group: "Server" | "Security" | "Libraries" | "AI" | "Sources" | "Integrations"
  label: string
  status: CheckStatus
  detail: string
  /** where to put it right */
  fix?: { label: string; to: string }
}

export interface HealthReport {
  checkedAt: string
  checks: HealthCheck[]
  system: { version: string; node: string; platform: string; uptimeSec: number; memoryMb: number; dbMb: number; dataDir: string }
}
