import type { LlmProviderConfig, ScraperDefinition, Settings, SourceConfig } from "../shared/types"
import { getDb } from "./db"
import { setContact } from "./sources/http"

export const SOURCE_META: Record<
  string,
  { label: string; needs: ("apiKey" | "apiSecret")[]; keyLabel?: string; secretLabel?: string; env?: [string, string?]; about: string; signup?: string }
> = {
  musicbrainz: { label: "MusicBrainz", needs: [], about: "Open music encyclopaedia. Free, 1 request/second.", signup: "https://musicbrainz.org" },
  discogs: { label: "Discogs", needs: ["apiKey"], keyLabel: "Personal access token", env: ["DISCOGS_TOKEN"], about: "Vinyl-first database - strong on reggae 7\"s, white labels and grime 12\"s.", signup: "https://www.discogs.com/settings/developers" },
  lastfm: { label: "Last.fm", needs: ["apiKey"], keyLabel: "API key", env: ["LASTFM_API_KEY"], about: "Scrobble data incl. spelling corrections. Crowd-sourced, so weighted lower.", signup: "https://www.last.fm/api/account/create" },
  spotify: { label: "Spotify", needs: ["apiKey", "apiSecret"], keyLabel: "Client ID", secretLabel: "Client secret", env: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"], about: "Streaming catalogue search (client-credentials flow).", signup: "https://developer.spotify.com/dashboard" },
  itunes: { label: "Apple Music / iTunes", needs: [], about: "iTunes Search API - no key needed, ~20 requests/minute." },
  deezer: { label: "Deezer", needs: [], about: "Open search API with durations - no key needed." },
  bandcamp: { label: "Bandcamp", needs: [], about: "Scrapes Bandcamp search - home of independent dub, grime and sound-system releases." },
  archive: { label: "Internet Archive", needs: [], about: "Advanced search over archive.org - clash tapes, pirate radio sets and dubplate rips." },
  mixcloud: { label: "Mixcloud", needs: [], about: "Radio shows and sets - useful for clash and pirate-radio recordings." },
  youtube: { label: "YouTube", needs: ["apiKey"], keyLabel: "Data API v3 key", env: ["YOUTUBE_API_KEY"], about: "Many specials and dubplates only exist as uploads. Low weight - titles are messy.", signup: "https://console.cloud.google.com/apis/library/youtube.googleapis.com" },
  acoustid: { label: "AcoustID fingerprint", needs: ["apiKey"], keyLabel: "Application API key", env: ["ACOUSTID_API_KEY"], about: "Identifies audio by fingerprint (needs fpcalc / Chromaprint installed). Strongest signal when it hits.", signup: "https://acoustid.org/new-application" },
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
 * Community scraper presets. Site markup drifts, so these ship disabled and
 * unverified - use "Test" in Sources to check them before switching on.
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
  },
  {
    id: "regime-radio",
    name: "Regime Radio clash archive",
    enabled: false,
    weight: 0.45,
    kind: "json",
    searchUrl: "https://regimeradio.com/wp-json/wp/v2/posts?search={query}&per_page=10&_fields=title,link,date",
    items: "",
    fields: { combined: "title.rendered", url: "link", year: "date" },
    scene: "Sound clash recordings",
    notes: "WordPress REST search over a sound-clash archive.",
    verified: false,
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
]

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
  },
  sources: DEFAULT_SOURCES,
  scrapers: SCRAPER_PRESETS,
  confidence: {
    autoThreshold: 90,
    reviewThreshold: 60,
    autoApprove: false,
    parseOnlyMax: 75,
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
  },
  scanner: {
    extensions: ["mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "aif", "aiff", "wma", "ape", "wv", "mpc"],
    hashFiles: true,
    ignore: [".AppleDouble", "@eaDir", ".Trash*", "$RECYCLE.BIN"],
  },
  safety: { readOnly: true },
  artwork: { fetch: true, embed: true, replaceExisting: false },
  analysis: { onProcess: true, writeTags: true, keyNotation: "musical", bpmMin: 88 },
  automation: { autoProcess: true, pollMinutes: 15, nightly: false, nightlyAt: "03:00" },
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

function mergeProviders(stored: LlmProviderConfig[] | undefined): LlmProviderConfig[] {
  const byId = new Map((stored ?? []).map((p) => [p.id, p]))
  const merged = DEFAULT_PROVIDERS.map((d) => ({ ...d, ...byId.get(d.id) }))
  for (const p of stored ?? []) if (!DEFAULT_PROVIDERS.some((d) => d.id === p.id)) merged.push(p)
  return merged
}

export function loadSettings(): Settings {
  const row = getDb().prepare("SELECT value_json FROM settings WHERE key = 'app'").get() as { value_json: string } | undefined
  const stored = row ? (JSON.parse(row.value_json) as Partial<Settings>) : {}
  // Clone the defaults: callers (effectiveSettings) mutate the result.
  const s = deepMerge(structuredClone(DEFAULT_SETTINGS), stored)
  s.llm.providers = mergeProviders(stored.llm?.providers)
  s.scrapers = stored.scrapers ?? structuredClone(SCRAPER_PRESETS)
  s.sources = deepMerge(structuredClone(DEFAULT_SOURCES), stored.sources ?? {})
  // Installs saved before genres existed still carry the old sound-system note; keep that
  // behaviour, but as picked genres the owner can now see and change.
  if (stored.llm && stored.llm.genres === undefined && stored.llm.sceneHint?.trim() === LEGACY_SCENE_HINT) {
    s.llm.genres = [...LEGACY_GENRES]
    s.llm.sceneHint = ""
  }
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
  return { ...s, secretsFromEnv: fromEnv, zdrFromEnv: zdrForcedByEnv() }
}

function keepSecret(incoming: string | undefined, previous: string | undefined) {
  if (incoming === undefined) return previous
  if (incoming.startsWith(MASK)) return previous
  return incoming.trim() || undefined
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const current = loadSettings()
  const next = deepMerge(current, patch)
  if (patch.llm?.providers) {
    next.llm.providers = patch.llm.providers.map((p) => {
      const prev = current.llm.providers.find((c) => c.id === p.id)
      return { ...prev, ...p, apiKey: keepSecret(p.apiKey, prev?.apiKey) }
    })
  }
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
  if (patch.scrapers) next.scrapers = patch.scrapers
  if (patch.llm && "genres" in patch.llm) next.llm.genres = cleanGenres(patch.llm.genres)
  // Guard against inverted thresholds.
  next.confidence.reviewThreshold = Math.min(next.confidence.reviewThreshold, next.confidence.autoThreshold)
  getDb()
    .prepare("INSERT INTO settings (key, value_json) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(JSON.stringify(next))
  return next
}
