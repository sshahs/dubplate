// AI interpreter: asks an LLM to read a messy filename the way a selector
// would, returning a structured reading plus alternatives and search queries.

import type { AiParse, Correction, LlmProviderConfig, Settings, Track } from "../../shared/types"
import { collapseSpaces, normArtist, normKey } from "../core/normalize"
import { settingsForLibrary } from "../library-settings"
import { completeJson } from "./providers"
import { versionSays } from "../core/evidence"
import { plainText } from "../core/plain-text"
import { checkFields, fileSays, groundReading, versionBacked } from "../../shared/fields"
import { log } from "../logs"

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
    "country",
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
    country: nullable("string"),
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

/** What the owner told us about the collection, as one line for the prompt. */
export function collectionContext(llm: Pick<Settings["llm"], "genres" | "sceneHint">): string {
  const genres = llm.genres ?? []
  const note = llm.sceneHint?.trim() ?? ""
  if (!genres.length) return note || "Any genre. Don't assume a particular scene; go by what the file says."
  return `Mostly ${genres.join(", ")}.${note ? ` ${note}` : ""}`
}

/** How names are joined and written, from the naming settings, so the AI's reading fits what gets written. */
export function metadataRulebook(naming?: Pick<Settings["naming"], "artistJoiner" | "clashJoiner" | "featuring">): string {
  const join = naming?.artistJoiner?.trim() || "&"
  const clash = naming?.clashJoiner?.trim() || "vs"
  const feat = naming?.featuring === "title" ? 'after the title as "(feat. Name)"' : naming?.featuring === "drop" ? "not at all (they're dropped)" : 'after the artists as "feat. Name"'
  return `Metadata rulebook - follow it exactly:
- Artist separator: list each main artist separately in "artists". The app joins them with "${join}", and clashes with "${clash}". Never join names yourself.
- Featured artists: only in "featuring", never "feat."/"ft." inside artists or title. The app writes them ${feat}.
- Dubplates and specials: only when this file's own name or title tag says "dubplate", "dub plate" or "special". Never because a folder, album, genre or comment mentions dubplates (that describes the collection the file sits in, not this recording), because the artist or sound suggests it, or because similar files had one. Most files are not dubplates. Then version "Dubplate", or "Dubplate for <Sound>" / "<Sound> Special" when the sound it was cut for is named. Never put "dubplate" or "special" in the title.
- VIPs and remixes: version "VIP" (or "<Artist> VIP"), "<Remixer> Remix", "Refix", "Edit". The title stays the song's own name.
- Never invent an album, year, label or catalogue number. Give year or label only when the filename, folder or embedded tags state them; otherwise null. Never fill them from memory - the sources supply those.
- Keep an artist's own spelling and capitalisation ("JME", "Ms. Dynamite", "D Double E").
- Discs and sides: "CD1", "Disc 2", "LP2", "Side A" (folders or filename parts) and positions like "A1", "B2", "1-05" say where a track sits on its record. They are never the artist, album or title - an album folder above a "CD1" folder is the album. A file that's just "Side A" or "CD2" (or ends with it) is that whole side or disc of a longer recording: title it as the recording (the album, the clash, the mix) and put "Side A" / "CD2" in version.`
}

export function systemPrompt(context: string, naming?: Pick<Settings["naming"], "artistJoiner" | "clashJoiner" | "featuring">) {
  return `You are the music librarian inside a tagger for DJ and collector libraries. You know music across every genre (reggae, dub and dancehall, UK grime, garage, jungle and dubstep, house, techno and disco, hip-hop, R&B and soul, jazz, rock, pop, Latin, African and classical), Jamaican and UK sound-system culture especially deeply, and you are expert at untangling messy digital filenames.

Collection context: ${context}

Given one audio file's name, folder path and any embedded tags, work out who performed it and what it is.

Rules:
- artists: the main performer(s) in their commonly credited spelling and capitalisation (e.g. "Buju Banton", "Dizzee Rascal", "JME", "Daft Punk", "Beyoncé", "A Tribe Called Quest"). Featured guests go in "featuring", not "artists".
- relation: "vs" for clashes / versus, "&" for collaborations, "x" when the name uses " x ", null for a single artist.
- title: the song name only - no version, year, bitrate or featuring text. If there is no song name (a live clash, DJ set, radio show or session), write a short descriptive title such as "Live Clash" or "Live at Sting".
- version: e.g. "Remix", "Skepta Remix", "Live", "Extended Mix", "Radio Edit", "VIP", "Dub", "Instrumental", "Acoustic", "Demo", "Freestyle", "Dubplate", "Special" - only when this file's own name or title tag says so (a folder, album, genre or comment doesn't). null for the original release, and null when nothing says otherwise.
- riddim: the riddim name if referenced (e.g. "Sleng Teng", "Diwali"), else null. A part like "Seasons Riddim" is always the riddim, never the artist or the title: dancehall files are often named "Riddim - Artist - Title" ("Seasons Riddim - Gyptian - Is There A Place" is Gyptian's "Is There A Place" on the Seasons riddim), or carry it in brackets ("Title (Diwali Riddim)") or in their folder.
- Every field holds only its own thing. The artist never contains the title (embedded tags like artist "Bounty Killer & Baby Cham - Another Level" are a mistake: the artists are Bounty Killer and Baby Cham). The title never contains the artist, "(Official Video)", a site name or a track number. A genre ("Reggae") or "Unknown Album" is never an album.
- year: four-digit year if stated or clearly implied ("live 93" means 1993), else null.
- event: clash, session, show or festival name if relevant (e.g. "Sting", "Fire in the Booth", "Rinse FM", "Boiler Room", "Glastonbury"), else null.
- Ignore rip-site names, bitrates, track numbers, "official video" and similar noise.
- Never invent facts. When a filename is genuinely ambiguous (e.g. order could be Title - Artist), give your best reading in the main fields and the others in "alternatives".

Where your answer comes from:
- Everything you return describes this one file, read from its own name, folder and embedded tags (and the right spelling of names you know). Nothing else.
- You may be shown other files the owner approved before. They are examples for context only: they show how the owner spells and writes names. They are different recordings - never copy anything from them into your answer: no artist, title words, version, year, album, label or riddim that this file doesn't give.
- Before you answer, check each of version, year, label, riddim and event: if this file's name, folder or tags don't state it, it's null. The version needs the file's own name or title to state it.
- country: the main artist's home country as an ISO code ("GB", "US", "JM") if you genuinely know it, else null.
- confidence: 0 to 1 - how sure you are of artists + title together.
- searchQueries: 1 to 3 short queries you would type into MusicBrainz or Discogs to verify this.
- reasoning: one or two short sentences.

${metadataRulebook(naming)}`
}

function fmtDuration(sec: number | null) {
  if (!sec) return "unknown"
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}

/** Pick past corrections that look like this filename, as few-shot examples. */
export function similarCorrections(filename: string, corrections: Correction[], max = 5): Correction[] {
  // Words that name something: not "track", "remix" or a bare number ("Track 101" is no kin of another "Track 101").
  const tokens = new Set(normKey(filename.replace(/\.[^.]+$/, "")).split(" ").filter((t) => t.length > 2 && !COMMON_WORDS.has(t) && !/^\d+$/.test(t)))
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

/** Words too common to make two filenames alike ("remix", "dubplate", "official"…). */
const COMMON_WORDS = new Set(
  "the and feat featuring with mix remix rmx dub dubplate plate special specials version original official video audio lyrics live edit vip riddim radio extended instrumental freestyle track part prod mp3 flac wav m4a wma"
    .split(" ")
)

export function buildUserPrompt(track: Track, corrections: Correction[]): string {
  const t = track.tags
  const tagLine = [
    t.artist && `artist="${t.artist}"`,
    t.title && `title="${t.title}"`,
    t.album && `album="${t.album}"`,
    t.year && `year=${t.year}`,
    t.genre?.length && `genre="${t.genre.join(", ")}"`,
    t.label && `label="${t.label}"`,
    // (not the note this app may have written itself)
    t.comment && !/^identified by dubplate$/i.test(t.comment.trim()) && `comment="${t.comment.slice(0, 120)}"`,
  ]
    .filter(Boolean)
    .join(", ")
  const h = track.heuristic
  const firstName = versionSays(track)[0]
  const lines: string[] = []
  if (corrections.length) {
    lines.push(
      "EXAMPLES - other files the owner approved, for context only.",
      "They show how the owner spells and writes names. They are different recordings: never copy anything from them into your answer.",
    )
    // An example's version is shown only when this file says the same kind of thing ("dubplate", "remix"…),
    // or every similar file would be read as one.
    const says = versionSays(track)
    for (const c of corrections) lines.push(`- "${c.filename}" → ${c.artists.join(" & ")} - ${c.title}${c.version && versionBacked(c.version, says) ? ` (${c.version})` : ""}`)
    lines.push("")
  }
  lines.push(
    "THIS FILE - your answer is about this file only:",
    `Filename: ${track.filename}`,
    // Renamed by this app before: the name it came with is what the file itself says.
    ...(firstName && firstName !== track.filename ? [`Filename it came with (before this app renamed it): ${firstName}`] : []),
    `Folder: ${track.relDir || "(library root)"}`,
    `Embedded tags: ${tagLine || "none"}`,
    `Duration: ${fmtDuration(track.duration)}`,
  )
  if (h) {
    lines.push(
      `Rule-based first pass (may be wrong): artists=${JSON.stringify(h.artists)}, title=${JSON.stringify(h.title)}` +
        (h.version ? `, version=${JSON.stringify(h.version)}` : "") +
        (h.year ? `, year=${h.year}` : "") +
        (h.hints.length ? `, hints=${JSON.stringify(h.hints)}` : "")
    )
    const p = h.position
    if (p?.whole) lines.push(`Position: the whole of ${p.label ?? (p.side ? `side ${p.side}` : `disc ${p.disc}`)} - one part of a longer recording, not a track`)
    else if (p?.side || p?.disc) lines.push(`Position: ${p.side ? `side ${p.side}, ${p.side}${p.number ?? ""}` : `disc ${p.disc}${p.number ? `, track ${p.number}` : ""}`} (a position on the record, not part of any name)`)
  }
  if (corrections.length) {
    lines.push("", "Answer for THIS FILE. The examples above are context only - nothing in your answer may come from them.")
  }
  return lines.join("\n")
}

const str = (v: unknown) => (typeof v === "string" ? collapseSpaces(plainText(v)) : "")
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
  const reading: AiParse = {
    artists: strArr(r.artists).map(canon),
    featuring: strArr(r.featuring).map(canon),
    relation: rel,
    title: str(r.title),
    version: strOrUndef(r.version),
    year: Number.isFinite(year) && year > 1900 && year < 2100 ? year : undefined,
    // "Diwali Riddim" → "Diwali": the app adds the word where it says it.
    riddim: strOrUndef(r.riddim)?.replace(/(?:^|\s+)riddim$/i, "") || undefined,
    event: strOrUndef(r.event),
    label: strOrUndef(r.label),
    genre: strOrUndef(r.genre),
    country: /^[A-Za-z]{2}$/.test(str(r.country)) ? str(r.country).toUpperCase() : undefined,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoning: str(r.reasoning).slice(0, 600),
    alternatives,
    searchQueries: strArr(r.searchQueries).slice(0, 3),
    provider: provider.label,
    model: provider.model,
  }
  // A small model can still put a riddim in the artist or the title in it: the same checks as everything else.
  const { fields } = checkFields(reading, { names: false })
  return { ...fields, artists: fields.artists.map(canon) }
}

/** A configured provider with another model (for escalation or vision), or null when it isn't usable. */
export function providerWithModel(settings: Settings, providerId: string, model: string): LlmProviderConfig | null {
  const base = settings.llm.providers.find((p) => p.id === providerId)
  if (!base || !(model || base.model)) return null
  return { ...base, model: model || base.model }
}

export function activeProvider(settings: Settings): LlmProviderConfig | null {
  return settings.llm.providers.find((p) => p.id === settings.llm.activeProvider && p.enabled) ?? null
}

export async function interpretTrack(
  track: Track,
  settings: Settings,
  opts: { corrections: Correction[]; aliases: Map<string, string>; signal?: AbortSignal; provider?: LlmProviderConfig }
): Promise<AiParse> {
  const provider = opts.provider ?? activeProvider(settings)
  if (!provider) throw new Error("No AI provider is enabled - pick one in Settings")
  const examples = settings.llm.useCorrections ? similarCorrections(track.filename, opts.corrections) : []
  const raw = await completeJson(provider, {
    system: systemPrompt(collectionContext(settingsForLibrary(settings, track.libraryId).llm), settingsForLibrary(settings, track.libraryId).naming),
    user: buildUserPrompt(track, examples),
    schema: AI_SCHEMA as unknown as Record<string, unknown>,
    schemaName: "identify_track",
    temperature: settings.llm.temperature,
    signal: opts.signal,
  })
  const ai = sanitizeAi(raw, provider, opts.aliases)
  // Whatever the prompt says, a model can still borrow from the examples or guess: what only the
  // file can state (version, year, label, riddim, event) is kept only where the file does state it.
  const { reading, unsupported } = groundReading(ai, fileSays(track), versionSays(track))
  if (!unsupported.length) return ai
  log("debug", `${provider.label} said ${unsupported.join(", ")} for ${track.filename}, which nothing about the file states - left out`, { area: "ai" })
  return { ...reading, unsupported }
}

