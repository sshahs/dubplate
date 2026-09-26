// AI interpreter: asks an LLM to read a messy filename the way a selector
// would, returning a structured reading plus alternatives and search queries.

import type { AiParse, Correction, LlmProviderConfig, Settings, Track } from "../../shared/types"
import { collapseSpaces, normArtist, normKey } from "../core/normalize"
import { completeJson } from "./providers"

const nullable = (type: string) => ({ type: [type, "null"] })

export const AI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "artists",
    "featuring",
    "relation",
    "title",
    "version",
    "year",
    "riddim",
    "event",
    "label",
    "genre",
    "confidence",
    "reasoning",
    "alternatives",
    "searchQueries",
  ],
  properties: {
    artists: { type: "array", items: { type: "string" } },
    featuring: { type: "array", items: { type: "string" } },
    relation: { type: ["string", "null"], enum: ["&", "vs", "x", null] },
    title: { type: "string" },
    version: nullable("string"),
    year: nullable("integer"),
    riddim: nullable("string"),
    event: nullable("string"),
    label: nullable("string"),
    genre: nullable("string"),
    confidence: { type: "number" },
    reasoning: { type: "string" },
    alternatives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["artists", "title"],
        properties: { artists: { type: "array", items: { type: "string" } }, title: { type: "string" } },
      },
    },
    searchQueries: { type: "array", items: { type: "string" } },
  },
} as const

export function systemPrompt(sceneHint: string) {
  return `You are the music librarian inside "Dubplate", a tagger for sound-system collections. You know Jamaican and UK sound-system culture deeply — reggae, roots, dub, dancehall, lovers rock, sound clash, UK grime, garage, jungle, drum & bass, dubstep, bassline and UK funky — and you are expert at untangling messy digital filenames.

Collection context: ${sceneHint || "general music library"}

Given one audio file's name, folder path and any embedded tags, work out who performed it and what it is.

Rules:
- artists: the main performer(s) in their commonly credited spelling and capitalisation (e.g. "Buju Banton", "Beenie Man", "Dizzee Rascal", "JME", "Sizzla"). Featured guests go in "featuring", not "artists".
- relation: "vs" for clashes / versus, "&" for collaborations, "x" when the name uses " x ", null for a single artist.
- title: the song name only — no version, year, bitrate or featuring text. If there is no song name (a live clash, radio set or session), write a short descriptive title such as "Live Clash" or "Live at Sting".
- version: e.g. "Dubplate", "Special", "Live", "Remix", "Skepta Remix", "VIP", "Dub", "Instrumental", "Refix", "Freestyle". null for the original release.
- riddim: the riddim name if referenced (e.g. "Sleng Teng", "Diwali"), else null.
- year: four-digit year if stated or clearly implied ("live 93" means 1993), else null.
- event: clash, session or show name if relevant (e.g. "Sting", "Fire in the Booth", "Rinse FM"), else null.
- Ignore rip-site names, bitrates, track numbers, "official video" and similar noise.
- Never invent facts. When a filename is genuinely ambiguous (e.g. order could be Title - Artist), give your best reading in the main fields and the others in "alternatives".
- confidence: 0 to 1 — how sure you are of artists + title together.
- searchQueries: 1 to 3 short queries you would type into MusicBrainz or Discogs to verify this.
- reasoning: one or two short sentences.`
}

function fmtDuration(sec: number | null) {
  if (!sec) return "unknown"
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}

/** Pick past corrections that look like this filename, as few-shot examples. */
export function similarCorrections(filename: string, corrections: Correction[], max = 5): Correction[] {
  const tokens = new Set(normKey(filename.replace(/\.[^.]+$/, "")).split(" ").filter((t) => t.length > 2))
  if (!tokens.size) return []
  return corrections
    .map((c) => {
      const ct = normKey(c.filename).split(" ")
      let score = 0
      for (const t of ct) if (tokens.has(t)) score++
      return { c, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.c)
}

export function buildUserPrompt(track: Track, corrections: Correction[]): string {
  const t = track.tags
  const tagLine = [
    t.artist && `artist="${t.artist}"`,
    t.title && `title="${t.title}"`,
    t.album && `album="${t.album}"`,
    t.year && `year=${t.year}`,
    t.genre?.length && `genre="${t.genre.join(", ")}"`,
    t.label && `label="${t.label}"`,
    t.comment && `comment="${t.comment.slice(0, 120)}"`,
  ]
    .filter(Boolean)
    .join(", ")
  const h = track.heuristic
  const lines = [
    `Filename: ${track.filename}`,
    `Folder: ${track.relDir || "(library root)"}`,
    `Embedded tags: ${tagLine || "none"}`,
    `Duration: ${fmtDuration(track.duration)}`,
  ]
  if (h) {
    lines.push(
      `Rule-based first pass (may be wrong): artists=${JSON.stringify(h.artists)}, title=${JSON.stringify(h.title)}` +
        (h.version ? `, version=${JSON.stringify(h.version)}` : "") +
        (h.year ? `, year=${h.year}` : "") +
        (h.hints.length ? `, hints=${JSON.stringify(h.hints)}` : "")
    )
  }
  if (corrections.length) {
    lines.push("", "The owner previously confirmed these readings of similar files — follow their spelling and style:")
    for (const c of corrections) lines.push(`- "${c.filename}" → ${c.artists.join(" & ")} - ${c.title}${c.version ? ` (${c.version})` : ""}`)
  }
  return lines.join("\n")
}

const str = (v: unknown) => (typeof v === "string" ? collapseSpaces(v) : "")
const strOrUndef = (v: unknown) => str(v) || undefined
const strArr = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])

/** Coerce whatever the model returned into a well-formed AiParse. */
export function sanitizeAi(raw: unknown, provider: LlmProviderConfig, aliases: Map<string, string>): AiParse {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const canon = (a: string) => aliases.get(normArtist(a)) ?? a
  const year = typeof r.year === "number" ? r.year : Number.parseInt(String(r.year ?? ""), 10)
  const rel = r.relation === "&" || r.relation === "vs" || r.relation === "x" ? r.relation : undefined
  let confidence = typeof r.confidence === "number" ? r.confidence : Number.parseFloat(String(r.confidence ?? "0.5"))
  if (confidence > 1) confidence = confidence / 100
  if (!Number.isFinite(confidence)) confidence = 0.5
  const alternatives = Array.isArray(r.alternatives)
    ? r.alternatives
        .map((a) => {
          const o = (a ?? {}) as Record<string, unknown>
          return { artists: strArr(o.artists).map(canon), title: str(o.title) }
        })
        .filter((a) => a.title || a.artists.length)
        .slice(0, 4)
    : []
  return {
    artists: strArr(r.artists).map(canon),
    featuring: strArr(r.featuring).map(canon),
    relation: rel,
    title: str(r.title),
    version: strOrUndef(r.version),
    year: Number.isFinite(year) && year > 1900 && year < 2100 ? year : undefined,
    riddim: strOrUndef(r.riddim),
    event: strOrUndef(r.event),
    label: strOrUndef(r.label),
    genre: strOrUndef(r.genre),
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoning: str(r.reasoning).slice(0, 600),
    alternatives,
    searchQueries: strArr(r.searchQueries).slice(0, 3),
    provider: provider.label,
    model: provider.model,
  }
}

export function activeProvider(settings: Settings): LlmProviderConfig | null {
  return settings.llm.providers.find((p) => p.id === settings.llm.activeProvider && p.enabled) ?? null
}

export async function interpretTrack(
  track: Track,
  settings: Settings,
  opts: { corrections: Correction[]; aliases: Map<string, string>; signal?: AbortSignal }
): Promise<AiParse> {
  const provider = activeProvider(settings)
  if (!provider) throw new Error("No AI provider is enabled — pick one in Settings")
  const examples = settings.llm.useCorrections ? similarCorrections(track.filename, opts.corrections) : []
  const raw = await completeJson(provider, {
    system: systemPrompt(settings.llm.sceneHint),
    user: buildUserPrompt(track, examples),
    schema: AI_SCHEMA as unknown as Record<string, unknown>,
    schemaName: "identify_track",
    temperature: settings.llm.temperature,
    signal: opts.signal,
  })
  return sanitizeAi(raw, provider, opts.aliases)
}

