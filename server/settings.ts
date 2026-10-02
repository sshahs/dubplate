import type { GenreRule, LlmProviderConfig, MediaServerConfig, PathMapping, ScraperDefinition, Settings, SourceConfig } from "../shared/types"
import { STARTER_GENRE_RULES } from "../shared/genres"
import { sanitizeFilename } from "./core/naming"
import { getDb } from "./db"
import { setContact } from "./sources/http"
import { recipeKey } from "./sources/recipe"

export { STARTER_GENRE_RULES }

/** Streaming stores: strongest for anything that's had a proper digital release. */
const STORE_GENRES = ["Pop", "Rock", "Indie", "Hip-hop", "R&B", "Afrobeats", "Amapiano", "Latin", "Country", "Soundtracks", "Electronic", "Metal", "Punk", "Folk", "Classical", "Gospel", "Soca"]

export const SOURCE_META: Record<
  string,
  {
    label: string
    needs: ("apiKey" | "apiSecret")[]
    keyLabel?: string
    secretLabel?: string
    env?: [string, string?]
    about: string
    signup?: string
    /** genres (crates picker names) the source is especially good for; none = good for everything */
    suits?: string[]
  }
> = {
  musicbrainz: { label: "MusicBrainz", needs: [], about: "Open music encyclopaedia. Free, 1 request/second.", signup: "https://musicbrainz.org" },
  discogs: { label: "Discogs", needs: ["apiKey"], keyLabel: "Personal access token", env: ["DISCOGS_TOKEN"], about: "Vinyl-first database - strong on reggae 7\"s, white labels and grime 12\"s.", signup: "https://www.discogs.com/settings/developers", suits: ["Reggae", "Roots", "Dub", "Dancehall", "Lovers rock", "Ska & rocksteady", "Soul", "Funk", "Jazz", "Disco", "House", "Techno", "Jungle", "Drum & bass", "UK garage", "Grime", "Dubstep", "Dubplates & specials"] },
  lastfm: { label: "Last.fm", needs: ["apiKey"], keyLabel: "API key", env: ["LASTFM_API_KEY"], about: "Scrobble data incl. spelling corrections. Crowd-sourced, so weighted lower.", signup: "https://www.last.fm/api/account/create" },
  spotify: { label: "Spotify", needs: ["apiKey", "apiSecret"], keyLabel: "Client ID", secretLabel: "Client secret", env: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"], about: "Streaming catalogue search (client-credentials flow).", signup: "https://developer.spotify.com/dashboard", suits: STORE_GENRES },
  itunes: { label: "Apple Music / iTunes", needs: [], about: "iTunes Search API - no key needed, ~20 requests/minute.", suits: STORE_GENRES },
  deezer: { label: "Deezer", needs: [], about: "Open search API with durations - no key needed.", suits: STORE_GENRES },
  bandcamp: { label: "Bandcamp", needs: [], about: "Scrapes Bandcamp search - home of independent dub, grime and sound-system releases.", suits: ["Dub", "Roots", "Jungle", "Drum & bass", "Dubstep", "Grime", "UK garage", "Techno", "House", "Electronic", "Ambient", "Indie", "Punk", "Metal", "Folk", "Edits & bootlegs"] },
  archive: { label: "Internet Archive", needs: [], about: "Advanced search over archive.org - clash tapes, pirate radio sets and dubplate rips.", suits: ["Sound clashes", "Radio rips", "Live sets", "DJ mixes", "Dubplates & specials", "Blues", "Jazz"] },
  mixcloud: { label: "Mixcloud", needs: [], about: "Radio shows and sets - useful for clash and pirate-radio recordings.", suits: ["DJ mixes", "Radio rips", "Live sets", "Sound clashes"] },
  youtube: { label: "YouTube", needs: ["apiKey"], keyLabel: "Data API v3 key", env: ["YOUTUBE_API_KEY"], about: "Many specials and dubplates only exist as uploads. Low weight - titles are messy.", signup: "https://console.cloud.google.com/apis/library/youtube.googleapis.com", suits: ["Dubplates & specials", "Sound clashes", "Edits & bootlegs", "Radio rips", "Live sets", "Afrobeats", "Amapiano", "Soca"] },
  acoustid: { label: "AcoustID fingerprint", needs: ["apiKey"], keyLabel: "Application API key", env: ["ACOUSTID_API_KEY"], about: "Identifies audio by fingerprint (needs fpcalc / Chromaprint installed). Strongest signal when it hits.", signup: "https://acoustid.org/new-application" },
  "discogs-collection": {
    label: "Your Discogs collection",
    needs: [],
    about: "Releases you own on Discogs. A track that matches a record in your collection is trusted highly - ideal for vinyl rips. Uses the Discogs token above.",
    signup: "https://www.discogs.com/settings/developers",
  },
}

const DEFAULT_SOURCES: Record<string, SourceConfig> = {
  musicbrainz: { enabled: true, weight: 1 },
  discogs: { enabled: true, weight: 0.95 },
  lastfm: { enabled: true, weight: 0.6 },
  spotify: { enabled: true, weight: 0.85 },
  itunes: { enabled: true, weight: 0.85 },
  deezer: { enabled: true, weight: 0.8 },
  bandcamp: { enabled: true, weight: 0.75 },
  archive: { enabled: true, weight: 0.5 },
  mixcloud: { enabled: true, weight: 0.45 },
  youtube: { enabled: true, weight: 0.4 },
  acoustid: { enabled: true, weight: 1.3 },
  "discogs-collection": { enabled: true, weight: 1.2 },
}

const DEFAULT_PROVIDERS: LlmProviderConfig[] = [
  { id: "ollama", kind: "ollama", label: "Ollama (local)", baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434", model: process.env.OLLAMA_MODEL ?? "qwen3:8b", enabled: true },
  { id: "ollama-cloud", kind: "ollama-cloud", label: "Ollama Cloud", baseUrl: "https://ollama.com", model: "gpt-oss:120b", enabled: true },
  { id: "openai", kind: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", enabled: true },
  { id: "anthropic", kind: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", model: "claude-haiku-4-5", enabled: true },
  { id: "commandcode", kind: "commandcode", label: "Command Code", baseUrl: "https://api.commandcode.ai/provider/v1", model: "", enabled: true, zdr: false },
  { id: "custom", kind: "openai-compatible", label: "OpenAI-compatible (LM Studio, OpenRouter, Groq…)", baseUrl: "http://localhost:1234/v1", model: "", enabled: true },
]

const PROVIDER_ENV: Partial<Record<LlmProviderConfig["kind"], string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  "ollama-cloud": "OLLAMA_API_KEY",
  commandcode: "COMMANDCODE_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
}

/** CMD_ZDR=1 (or true) forces Command Code's Zero Data Retention on, whatever the UI says. */
export function zdrForcedByEnv(): boolean {
  return process.env.CMD_ZDR === "1" || process.env.CMD_ZDR === "true"
}

/**
 * Community scraper presets. They ship switched off; the ones marked verified
 * answered with real results when checked against the live site (the month is
 * in their notes). Site markup drifts, so Test one before trusting it.
 */
export const SCRAPER_PRESETS: ScraperDefinition[] = [
  {
    id: "juno",
    name: "Juno Download",
    enabled: false,
    weight: 0.7,
    kind: "html",
    searchUrl: "https://www.junodownload.com/search/?q%5Ball%5D%5B%5D={query}&solrorder=relevancy",
    items: ".jd-listing-item-track, .juno-product",
    fields: {
      artist: ".juno-artist, .jd-listing-artist",
      title: ".juno-title, .jd-listing-title",
      url: "a.juno-title@href, a@href",
      label: ".juno-label, .jd-listing-label",
    },
    scene: "Grime, dubstep, jungle, UK garage, dancehall 12\"s",
    notes: "UK dance-music store with deep grime/UKG/jungle back catalogue.",
    verified: false,
    genres: ["Grime", "UK garage", "Jungle", "Drum & bass", "Dubstep", "House", "Techno", "Dancehall", "Electronic"],
  },
  {
    id: "regime-radio",
    name: "Regime Radio Sound Tapes",
    enabled: false,
    weight: 0.45,
    kind: "json",
    searchUrl: "https://regimeradio.com/wp-json/wp/v2/posts?search={query}&per_page=10&_fields=title,link,date",
    items: "",
    fields: { combined: "title.rendered", url: "link", year: "date" },
    scene: "Sound clash recordings and sound tapes",
    notes: "WordPress REST search over a sound-clash and sound-tape archive. Checked October 2026.",
    verified: true,
    genres: ["Sound clashes", "Dancehall", "Reggae", "Dubplates & specials"],
    genreWeights: { "Sound clashes": 1.3, "Dubplates & specials": 1.3, Dancehall: 1.1, Reggae: 1.1 },
  },
  {
    id: "wordpress-template",
    name: "WordPress blog (template)",
    enabled: false,
    weight: 0.4,
    kind: "json",
    searchUrl: "https://example.com/wp-json/wp/v2/posts?search={query}&per_page=10&_fields=title,link,date",
    items: "",
    fields: { combined: "title.rendered", url: "link", year: "date" },
    scene: "Any WordPress-based grime / reggae blog",
    notes: "Duplicate this and point it at a blog that posts tracks as 'Artist - Title'.",
    verified: false,
  },
  {
    id: "traxsource",
    name: "Traxsource",
    enabled: false,
    weight: 0.75,
    kind: "html",
    searchUrl: "https://www.traxsource.com/search/tracks?term={query}",
    items: ".trk-row",
    fields: { title: ".title a", artist: ".artists a", label: ".label a", url: ".title a@href", year: ".r-date" },
    scene: "House, techno, disco and afro house downloads",
    notes: "DJ download store with deep house, soulful and afro catalogues. Checked October 2026.",
    verified: true,
    genres: ["House", "Techno", "Disco", "Electronic", "Afrobeats", "Amapiano", "Soul", "Funk"],
  },
  {
    id: "genius",
    name: "Genius",
    enabled: false,
    weight: 0.6,
    kind: "json",
    searchUrl: "https://genius.com/api/search/song?q={query}&per_page=5",
    items: "response.sections.0.hits",
    fields: {
      title: "result.title",
      artist: "result.primary_artist.name",
      url: "result.url",
      year: "result.release_date_components.year",
      artwork: "result.song_art_image_url",
    },
    scene: "Hip-hop, R&B, pop and afrobeats",
    notes: "The lyrics site's own search: good on credits and spellings for rap and R&B. Checked October 2026.",
    verified: true,
    genres: ["Hip-hop", "R&B", "Pop", "Afrobeats", "Amapiano", "Latin", "Grime", "Soul", "Gospel", "Rock", "Indie", "Country"],
  },
  {
    id: "audius",
    name: "Audius",
    enabled: false,
    weight: 0.45,
    kind: "json",
    searchUrl: "https://discoveryprovider.audius.co/v1/tracks/search?query={query}&app_name=dubplate",
    items: "data",
    fields: { title: "title", artist: "user.name", year: "release_date", url: "https://audius.co{permalink}", artwork: "artwork.480x480" },
    scene: "Independent electronic and hip-hop uploads",
    notes: "Open music platform with a public search API. Uploads are self-published, so it's weighted low. Checked October 2026.",
    verified: true,
    genres: ["Electronic", "Hip-hop", "House", "Techno", "Drum & bass", "Dubstep", "Ambient", "Edits & bootlegs"],
  },
  {
    id: "hypem",
    name: "Hype Machine",
    enabled: false,
    weight: 0.45,
    kind: "json",
    searchUrl: "https://hypem.com/search/{query}/1/",
    // The list itself is behind a login now; the page carries the same tracks as JSON.
    embedded: "script#displayList-data",
    items: "tracks",
    fields: { artist: "artist", title: "song", url: "posturl" },
    scene: "Indie, electronic and remixes from music blogs",
    notes: "Blog aggregator: good for remixes and edits that never got a store release. Checked October 2026.",
    verified: true,
    genres: ["Indie", "Electronic", "Pop", "House", "Hip-hop", "Edits & bootlegs"],
  },
  {
    id: "grime-archive",
    name: "Grime Archive",
    enabled: false,
    weight: 0.5,
    kind: "html",
    searchUrl: "https://www.grimearchive.org/search?title={query}",
    items: "tr.mix-row",
    fields: { title: "a.mix-link", artist: ".td-dj a, .td-mcs a", url: "a.mix-link@href", year: ".td-date" },
    scene: "Grime radio sets and mixes (Rinse, Deja Vu, Kiss…)",
    notes: "Sets rather than tracks, so it backs up clash and set recordings more than singles. Checked October 2026.",
    verified: true,
    genres: ["Grime", "Radio rips"],
    genreWeights: { Grime: 1.2, "Radio rips": 1.3 },
  },
  {
    id: "britishhiphop",
    name: "BritishHipHop.co.uk",
    enabled: false,
    weight: 0.55,
    kind: "json",
    searchUrl: "https://www.britishhiphop.co.uk/wp-json/wp/v2/posts?search={query}&per_page=10&_fields=title,link,date",
    items: "",
    fields: { combined: "title.rendered", url: "link", year: "date" },
    scene: "UK hip-hop reviews and releases",
    notes: "The site's WordPress search; posts are titled \"Artist - Title [Video]\". Checked October 2026.",
    verified: true,
    genres: ["UK rap", "Hip-hop"],
    genreWeights: { "UK rap": 1.25, "Hip-hop": 1.1 },
  },  {
    id: "soundclash-hub",
    name: "SoundClash Hub",
    enabled: false,
    weight: 0.3,
    kind: "json",
    // Its search wants one name: "Killamanjaro" finds the events, "Killamanjaro Stone Love" none.
    searchUrl: "https://soundclashhub.com/api/events?q={artist1}&tab=past",
    items: "events",
    fields: { title: "title", artist: "soundsInvolved", year: "startAt", url: "/events/{slug}" },
    scene: "Sound clash and hardcore juggling events, with the sounds that played",
    notes: "Past events from the clash calendar: the event is the recording, so a clash tape matches its listing by the sounds and the year. Its listings start around 2025. Checked October 2026.",
    verified: true,
    genres: ["Sound clashes"],
    genreWeights: { "Sound clashes": 1.3 },
  },
]

/**
 * The fingerprint of every recipe each preset has shipped with: a saved copy
 * that still matches one was never edited, so it's brought up to date (or
 * switched off when its site stopped working) without losing anyone's changes.
 */
const SHIPPED_RECIPES: Record<string, string[]> = {
  juno: ["399b51bdc0"],
  "regime-radio": ["baf415bd3b"],
  "wordpress-template": ["25a48be63a"],
  traxsource: ["97b47bda29"],
  genius: ["9aeb25979f"],
  audius: ["9ef3954bde"],
  hypem: ["f2baf035f1"],
  allmusic: ["64a1bbece9"],
  reggaerecord: ["5aec77695a"],
  "grime-archive": ["12f3cb96f6"],
  "grm-daily": ["f07973d152"],
  britishhiphop: ["10973f33e4"],
  "soundclash-hub": ["51609b272f"],
}

/** Presets taken out because their site can't be searched from a server, and why. */
const RETIRED_PRESETS: Record<string, string> = {
  allmusic: "AllMusic turns away searches that don't come from a web browser (it answers 403), so Dubplate can't use it.",
  reggaerecord: "ReggaeRecord's search turns away requests that don't come from a web browser (403), so Dubplate can't use it.",
  "grm-daily": "GRM Daily's site is in maintenance mode and its search returns nothing. Switch it back on if the site returns.",
}

/** Presets that shipped as supporting only; an update may change that unless the owner did. */
const SHIPPED_SUPPORTING_ONLY = new Set(["soundclash-hub"])

/** Bumped whenever presets are fixed or retired, so saved copies are brought up to date once. */
export const SCRAPER_REVISION = 2

/** The presets every install already had before newer ones were added. */
const ORIGINAL_PRESET_IDS = ["juno", "regime-radio", "wordpress-template"]

export const DEFAULT_SETTINGS: Settings = {
  llm: {
    activeProvider: "ollama",
    providers: DEFAULT_PROVIDERS,
    temperature: 0.1,
    concurrency: 2,
    useCorrections: true,
    // Nothing picked: the AI doesn't assume a genre. Owners narrow it in onboarding or Settings.
    genres: [],
    sceneHint: "",
    monthlyBudget: 0,
    currency: "$",
    escalation: { enabled: false, providerId: "ollama", model: "", from: 60, to: 89 },
    vision: { enabled: false, providerId: "ollama", model: "" },
  },
  sources: DEFAULT_SOURCES,
  scrapers: SCRAPER_PRESETS,
  confidence: {
    autoThreshold: 90,
    reviewThreshold: 60,
    autoApprove: false,
    parseOnlyMax: 75,
    genreAware: true,
    preferOwnRelease: true,
  },
  naming: {
    template: "{artist} - {title}",
    featuring: "artist",
    appendVersion: true,
    artistJoiner: " & ",
    clashJoiner: " vs ",
    renameFiles: true,
    writeTags: true,
    tagComment: false,
    writeIds: true,
    fixExtensions: true,
  },
  organise: { template: "{artist}", onCut: false, missing: "skip", tidy: true, sidecars: true },
  duplicates: { holdingFolder: "Duplicates set aside" },
  integrations: {
    mediaServers: [],
    discord: { enabled: false },
    telegram: { enabled: false },
    notify: { jobs: true, review: true },
    publicUrl: "",
  },
  scanner: {
    extensions: ["mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "aif", "aiff", "wma", "ape", "wv", "mpc"],
    videoExtensions: ["avi", "3gp", "3g2", "wmv", "asf", "mp4", "m4v", "mov", "mkv", "webm", "flv", "mpg", "mpeg", "vob"],
    hashFiles: true,
    ignore: [".AppleDouble", "@eaDir", ".Trash*", "$RECYCLE.BIN"],
  },
  safety: { readOnly: true },
  convert: { keepAudio: true, encodeTo: "mp3", originals: "keep", auto: false },
  artwork: { fetch: true, embed: true, replaceExisting: false },
  analysis: { onProcess: true, writeTags: true, keyNotation: "musical", bpmMin: 88, quality: true, loudness: true, writeReplayGain: true, integrity: true },
  automation: { autoProcess: true, pollMinutes: 15, nightly: false, nightlyAt: "03:00", handsOffMin: 95 },
  exports: { pathMap: [], traktorVolume: "Macintosh HD" },
  lyrics: { fetch: true, embed: true, embedSynced: false, lrcFile: false, replaceExisting: false },
  uploads: { maxMb: 2048 },
  hooks: { pathMap: [] },
  acoustid: { submit: false },
  canonicalGenres: { enabled: false, overwrite: true, rules: STARTER_GENRE_RULES },
  contact: "",
}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T
  const out: Obj = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v
  }
  return out as T
}

/** The collection note every install shipped with before genres could be picked. */
const LEGACY_SCENE_HINT = "Reggae, dancehall, dub, sound clash, grime, UK garage, jungle and dubstep collections."
const LEGACY_GENRES = ["Reggae", "Dancehall", "Dub", "Sound clashes", "Grime", "UK garage", "Jungle", "Dubstep"]

/** Trimmed, de-duplicated and bounded: these go into every AI prompt. */
export function cleanGenres(genres: unknown): string[] {
  if (!Array.isArray(genres)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const g of genres) {
    if (typeof g !== "string") continue
    const name = g.replace(/\s+/g, " ").trim().slice(0, 40)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(name)
  }
  return out.slice(0, 40)
}

/** A preset's recipe and description, copied onto a saved copy of it. */
function presetRecipe(p: ScraperDefinition): Partial<ScraperDefinition> {
  return { kind: p.kind, searchUrl: p.searchUrl, items: p.items, fields: structuredClone(p.fields), embedded: p.embedded, scene: p.scene, notes: p.notes, verified: p.verified }
}

/**
 * A saved copy of a preset brought up to date: a fixed search address or
 * selectors, or switched off with the reason when its site stopped working.
 * Only copies nobody edited are touched; everything else of theirs is kept.
 */
function upgradeScraper(s: ScraperDefinition): ScraperDefinition {
  if (!SHIPPED_RECIPES[s.id]?.includes(recipeKey(s))) return s
  const retired = RETIRED_PRESETS[s.id]
  if (retired) return { ...s, enabled: false, disabledReason: retired }
  const preset = SCRAPER_PRESETS.find((p) => p.id === s.id)
  if (!preset || recipeKey(preset) === recipeKey(s)) return s
  const next: ScraperDefinition = { ...s, ...presetRecipe(preset) }
  if (!next.embedded) delete next.embedded
  if (!!s.supportingOnly === SHIPPED_SUPPORTING_ONLY.has(s.id)) {
    if (preset.supportingOnly) next.supportingOnly = true
    else delete next.supportingOnly
  }
  // Switched off for failing under the old recipe: the reason no longer holds.
  if (!s.enabled && s.disabledReason) next.disabledReason = "Its search was fixed in an update - switch it back on to use it."
  return next
}

/**
 * Saved scrapers, plus any preset added since this install last saw the list (switched
 * off, like every preset). Presets you deleted stay deleted; presets you kept learn
 * which genres they suit, and once per revision the fixes to their recipes.
 */
function mergeScrapers(stored: ScraperDefinition[] | undefined, seen: string[] | undefined, revision = 0): ScraperDefinition[] {
  if (!stored) return structuredClone(SCRAPER_PRESETS)
  const offered = new Set(seen ?? ORIGINAL_PRESET_IDS)
  const out = stored.map((s) => {
    const preset = SCRAPER_PRESETS.find((p) => p.id === s.id)
    const kept = preset && !s.genres ? { ...s, genres: preset.genres } : s
    return revision < SCRAPER_REVISION ? upgradeScraper(kept) : kept
  })
  for (const p of SCRAPER_PRESETS) if (!offered.has(p.id) && !out.some((s) => s.id === p.id)) out.push(structuredClone(p))
  return out
}

function mergeProviders(stored: LlmProviderConfig[] | undefined): LlmProviderConfig[] {
  const byId = new Map((stored ?? []).map((p) => [p.id, p]))
  const merged = DEFAULT_PROVIDERS.map((d) => ({ ...d, ...byId.get(d.id) }))
  for (const p of stored ?? []) if (!DEFAULT_PROVIDERS.some((d) => d.id === p.id)) merged.push(p)
  return merged
}

/** The example canonical genre list shipped before the built-in one followed Dee's folders. */
const OLD_EXAMPLE_GENRES = "UK Grime|UK Garage|UK Rap|UK R&B|Hip Hop|Reggae|Dancehall"

export function loadSettings(): Settings {
  const row = getDb().prepare("SELECT value_json FROM settings WHERE key = 'app'").get() as { value_json: string } | undefined
  const stored = row ? (JSON.parse(row.value_json) as Partial<Settings>) : {}
  // Clone the defaults: callers (effectiveSettings) mutate the result.
  const s = deepMerge(structuredClone(DEFAULT_SETTINGS), stored)
  s.llm.providers = mergeProviders(stored.llm?.providers)
  s.scrapers = mergeScrapers(stored.scrapers, stored.scraperPresetsSeen, stored.scraperRevision)
  s.scraperPresetsSeen = SCRAPER_PRESETS.map((p) => p.id)
  s.scraperRevision = SCRAPER_REVISION
  s.sources = deepMerge(structuredClone(DEFAULT_SOURCES), stored.sources ?? {})
  // Installs saved before genres existed still carry the old sound-system note; keep that
  // behaviour, but as picked genres the owner can now see and change.
  if (stored.llm && stored.llm.genres === undefined && stored.llm.sceneHint?.trim() === LEGACY_SCENE_HINT) {
    s.llm.genres = [...LEGACY_GENRES]
    s.llm.sceneHint = ""
  }
  // Settings are saved whole, so an install that saved anything while the old example genre list was
  // the default still carries it. Never switched on, it was never chosen: the built-in list replaces it.
  const cg = stored.canonicalGenres
  if (cg && !cg.enabled && cg.rules?.map((r) => r.genre).join("|") === OLD_EXAMPLE_GENRES) s.canonicalGenres.rules = structuredClone(STARTER_GENRE_RULES)
  return s
}

/** Settings with environment-variable credentials filled in (server-side only). */
export function effectiveSettings(): Settings {
  const s = loadSettings()
  for (const p of s.llm.providers) {
    const env = PROVIDER_ENV[p.kind]
    if (!p.apiKey && env && process.env[env]) p.apiKey = process.env[env]
    if (p.kind === "commandcode" && zdrForcedByEnv()) p.zdr = true
  }
  for (const [id, meta] of Object.entries(SOURCE_META)) {
    const cfg = s.sources[id]
    if (!cfg || !meta.env) continue
    const [keyEnv, secretEnv] = meta.env
    if (!cfg.apiKey && process.env[keyEnv]) cfg.apiKey = process.env[keyEnv]
    if (secretEnv && !cfg.apiSecret && process.env[secretEnv]) cfg.apiSecret = process.env[secretEnv]
  }
  return s
}

/** Effective settings for a job or request, with the contact address applied to outgoing requests. */
export function settingsNow(): Settings {
  const s = effectiveSettings()
  setContact(s.contact)
  return s
}

const MASK = "••••"

export function mask(value: string | undefined): string | undefined {
  if (!value) return value
  return MASK + value.slice(-4)
}

/** Settings safe to send to the browser. */
export function publicSettings(): Settings & { secretsFromEnv: string[]; zdrFromEnv: boolean } {
  const stored = loadSettings()
  const eff = effectiveSettings()
  const fromEnv: string[] = []
  const s = structuredClone(eff)
  s.llm.providers = s.llm.providers.map((p, i) => {
    if (p.apiKey && !stored.llm.providers[i]?.apiKey) fromEnv.push(`llm:${p.id}`)
    // Report the saved ZDR choice; CMD_ZDR is surfaced separately as zdrFromEnv.
    return { ...p, apiKey: mask(p.apiKey), zdr: stored.llm.providers[i]?.zdr }
  })
  for (const [id, cfg] of Object.entries(s.sources)) {
    if (cfg.apiKey && !stored.sources[id]?.apiKey) fromEnv.push(`source:${id}`)
    cfg.apiKey = mask(cfg.apiKey)
    cfg.apiSecret = mask(cfg.apiSecret)
  }
  s.integrations.mediaServers = s.integrations.mediaServers.map((m) => ({ ...m, token: mask(m.token) }))
  s.integrations.discord.webhookUrl = mask(s.integrations.discord.webhookUrl)
  s.integrations.telegram.botToken = mask(s.integrations.telegram.botToken)
  s.acoustid.userKey = mask(s.acoustid.userKey)
  return { ...s, secretsFromEnv: fromEnv, zdrFromEnv: zdrForcedByEnv() }
}

function cleanMediaServer(m: MediaServerConfig, prev: MediaServerConfig | undefined): MediaServerConfig {
  const kind = m.kind === "jellyfin" || m.kind === "navidrome" ? m.kind : "plex"
  return {
    id: String(m.id || prev?.id || `${kind}-${Date.now().toString(36)}`),
    kind,
    name: (m.name ?? "").trim() || (kind === "plex" ? "Plex" : kind === "jellyfin" ? "Jellyfin" : "Navidrome"),
    url: (m.url ?? "").trim().replace(/\/+$/, ""),
    token: keepSecret(m.token, prev?.token),
    user: m.user?.trim() || undefined,
    enabled: m.enabled !== false,
  }
}

/** A value the browser only ever sees masked. */
export function isMasked(v: string | undefined): boolean {
  return !!v?.startsWith(MASK)
}

/** A price per million tokens: a positive number, or unset. */
function price(v: unknown): number | undefined {
  const n = Number(v)
  return v === undefined || v === null || v === "" || !Number.isFinite(n) || n < 0 ? undefined : Math.round(n * 10000) / 10000
}

function keepSecret(incoming: string | undefined, previous: string | undefined) {
  if (incoming === undefined) return previous
  if (incoming.startsWith(MASK)) return previous
  return incoming.trim() || undefined
}

/** Genre rules as typed: names trimmed, match terms lower-cased, empty ones dropped, one rule per genre. */
export function cleanGenreRules(rules: GenreRule[] | undefined): GenreRule[] {
  const seen = new Set<string>()
  const out: GenreRule[] = []
  for (const r of Array.isArray(rules) ? rules : []) {
    const genre = String(r?.genre ?? "").replace(/\s+/g, " ").trim().slice(0, 60)
    if (!genre || seen.has(genre.toLowerCase())) continue
    seen.add(genre.toLowerCase())
    const words = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map((m) => String(m).toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 60)
    const match = words(r.match)
    const titles = words(r.titles)
    const exclude = words(r.exclude)
    const regions = (Array.isArray(r.regions) ? r.regions : []).map((x) => String(x).trim().toUpperCase().replace(/^UNKNOWN$/, "?")).filter(Boolean)
    const folder = sanitizeFilename(String(r.folder ?? "").replace(/\s+/g, " ").trim()).slice(0, 60)
    out.push({
      genre,
      ...(folder && folder !== genre ? { folder } : {}),
      region: sanitizeFilename(String(r.region ?? "")).slice(0, 40),
      match,
      ...(titles.length ? { titles } : {}),
      ...(exclude.length ? { exclude } : {}),
      ...(regions.length ? { regions } : {}),
    })
  }
  return out.slice(0, 200)
}

function cleanPathMap(map: PathMapping[] | undefined): PathMapping[] {
  return (Array.isArray(map) ? map : [])
    .map((m) => ({ from: String(m?.from ?? "").trim(), to: String(m?.to ?? "").trim() }))
    .filter((m) => m.from)
    .slice(0, 10)
}

let saves = 0

/** Goes up on every save, so a running job can tell when the settings changed under it. */
export function settingsSaves(): number {
  return saves
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const current = loadSettings()
  const next = deepMerge(current, patch)
  if (patch.llm?.providers) {
    next.llm.providers = patch.llm.providers.map((p) => {
      const prev = current.llm.providers.find((c) => c.id === p.id)
      return { ...prev, ...p, apiKey: keepSecret(p.apiKey, prev?.apiKey), priceIn: price(p.priceIn), priceOut: price(p.priceOut) }
    })
  }
  if (patch.llm) {
    next.llm.monthlyBudget = Math.max(0, Number(next.llm.monthlyBudget) || 0)
    next.llm.currency = String(next.llm.currency ?? "").trim().slice(0, 4) || "$"
  }
  if (patch.automation) next.automation.handsOffMin = Math.min(100, Math.max(50, Math.round(Number(next.automation.handsOffMin) || DEFAULT_SETTINGS.automation.handsOffMin)))
  if (patch.exports) {
    next.exports.pathMap = cleanPathMap(next.exports.pathMap)
    next.exports.traktorVolume = String(next.exports.traktorVolume ?? "").trim() || DEFAULT_SETTINGS.exports.traktorVolume
  }
  if (patch.hooks) next.hooks.pathMap = cleanPathMap(next.hooks.pathMap)
  if (patch.acoustid) next.acoustid.userKey = keepSecret(patch.acoustid.userKey, current.acoustid.userKey)
  if (patch.llm?.escalation) {
    const e = next.llm.escalation
    const bound = (v: unknown, d: number) => Math.min(100, Math.max(0, Math.round(Number(v) || d)))
    e.from = bound(e.from, 60)
    e.to = Math.max(e.from, bound(e.to, 89))
    e.model = String(e.model ?? "").trim()
  }
  if (patch.llm?.vision) next.llm.vision.model = String(next.llm.vision.model ?? "").trim()
  if (patch.canonicalGenres) next.canonicalGenres.rules = cleanGenreRules(next.canonicalGenres.rules)
  if (patch.scanner) {
    const exts = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map((e) => String(e).trim().toLowerCase().replace(/^\./, "")).filter((e) => /^[a-z0-9]{1,8}$/.test(e)))]
    next.scanner.extensions = exts(next.scanner.extensions)
    // A format listed as audio is read as audio, never converted.
    next.scanner.videoExtensions = exts(next.scanner.videoExtensions).filter((e) => !next.scanner.extensions.includes(e))
  }
  if (patch.convert) {
    const c = next.convert
    if (!["mp3", "m4a", "flac"].includes(c.encodeTo)) c.encodeTo = DEFAULT_SETTINGS.convert.encodeTo
    if (!["keep", "aside"].includes(c.originals)) c.originals = DEFAULT_SETTINGS.convert.originals
    c.keepAudio = c.keepAudio !== false
    c.auto = !!c.auto
  }
  if (patch.uploads) next.uploads.maxMb = Math.min(20_000, Math.max(1, Math.round(Number(next.uploads.maxMb) || DEFAULT_SETTINGS.uploads.maxMb)))
  if (patch.sources) {
    for (const [id, cfg] of Object.entries(patch.sources)) {
      const prev = current.sources[id]
      next.sources[id] = {
        ...prev,
        ...cfg,
        apiKey: keepSecret(cfg.apiKey, prev?.apiKey),
        apiSecret: keepSecret(cfg.apiSecret, prev?.apiSecret),
      }
    }
  }
  // A scraper switched back on loses the health check's note.
  if (patch.scrapers) next.scrapers = patch.scrapers.map(({ disabledReason, ...s }) => (s.enabled ? s : { ...s, ...(disabledReason ? { disabledReason } : {}) }))
  if (patch.llm && "genres" in patch.llm) next.llm.genres = cleanGenres(patch.llm.genres)
  if (patch.integrations) {
    const cur = current.integrations
    if (patch.integrations.mediaServers) {
      next.integrations.mediaServers = patch.integrations.mediaServers.map((m) => cleanMediaServer(m, cur.mediaServers.find((c) => c.id === m.id)))
    }
    next.integrations.discord.webhookUrl = keepSecret(patch.integrations.discord?.webhookUrl, cur.discord.webhookUrl)
    next.integrations.telegram.botToken = keepSecret(patch.integrations.telegram?.botToken, cur.telegram.botToken)
    next.integrations.publicUrl = (next.integrations.publicUrl ?? "").trim().replace(/\/+$/, "")
  }
  if (patch.duplicates) next.duplicates.holdingFolder = sanitizeFilename(next.duplicates.holdingFolder ?? "") || DEFAULT_SETTINGS.duplicates.holdingFolder
  if (patch.organise) next.organise.template = next.organise.template?.trim() || DEFAULT_SETTINGS.organise.template
  // Guard against inverted thresholds.
  next.confidence.reviewThreshold = Math.min(next.confidence.reviewThreshold, next.confidence.autoThreshold)
  getDb()
    .prepare("INSERT INTO settings (key, value_json) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(JSON.stringify(next))
  saves++
  return next
}
