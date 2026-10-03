// Deterministic first pass over messy filenames. It cleans the obvious junk,
// captures hints (live, dubplate, year, track number…) and makes a best-effort
// "Artist - Title" split. The AI interpreter gets this as context and the
// confidence engine uses it as an independent reading.

import type { DiscPosition, HeuristicParse } from "../../shared/types"
import { discMarker, folderPosition, leadingPosition, trailingPart, withoutDiscFolders } from "./discs"
import { collapseSpaces, normArtist, smartCase, splitArtists } from "./normalize"
import { checkFields, riddimIn as riddimText } from "../../shared/fields"

export interface ParseContext {
  /** parent folder names, closest first */
  folders?: string[]
  /** existing embedded tags */
  tagArtist?: string
  /** the album tag: a riddim compilation's is often "Seasons Riddim" */
  tagAlbum?: string
  /** normalised known artist names (aliases, corrections, library tags) */
  knownArtists?: Set<string>
}

const JUNK_PATTERNS: RegExp[] = [
  // domains / rip sites
  /[([]?\b(?:www\.)?[a-z0-9-]+\.(?:com|net|org|co\.uk|ru|info|biz|to|cc|me|fm|io|in|pk|ws|xyz)\b[)\]]?/gi,
  /\b(?:downloaded|ripped|uploaded)\s+(?:from|by)\s+\S+/gi,
  // video / upload noise
  /[([]\s*(?:official\s+)?(?:music\s+|lyric(?:s)?\s+|hd\s+|hq\s+)?(?:video|audio|visuali[sz]er)\s*[)\]]/gi,
  /\bofficial\s+(?:music\s+)?(?:video|audio)\b/gi,
  /[([]\s*(?:lyrics?|hq|hd|high quality|full song|free download|free dl|out now|explicit|clean|mp3|flac|wav)\s*[)\]]/gi,
  // quality markers
  /[([]?\s*\d{2,3}\s?kbps\s*[)\]]?/gi,
  /[([]\s*(?:128|192|256|320|v0|v2)\s*[)\]]/gi,
  /[([]\s*(?:24|16)\s?bit[^)\]]*[)\]]/gi,
  /\b(?:cdq|webrip|web|vinylrip|vinyl rip|promo only)\b/gi,
  // bracketed youtube ids
  /[([]\s*[A-Za-z0-9_-]{11}\s*[)\]]$/g,
  // "(1)" duplicate markers, "copy"
  /\s*[([]\d[)\]]\s*$/g,
  /\s+-?\s*copy(?:\s*\d+)?$/gi,
]

/** Words that describe a version/recording rather than the song. */
const VERSION_HINTS: [RegExp, string][] = [
  [/\bdub\s?plates?\b/i, "dubplate"],
  [/\bspecials?\b/i, "special"],
  [/\bsound\s?clash\b|\bclash\b/i, "clash"],
  [/\blive\b/i, "live"],
  [/\bremix(?:es)?\b|\brmx\b/i, "remix"],
  [/\brefix\b/i, "refix"],
  [/\bbootleg\b|\bboot\b/i, "bootleg"],
  [/\bvip\b/i, "vip"],
  [/\bdub\b/i, "dub"],
  [/\binstrumental\b|\binst\b/i, "instrumental"],
  [/\bacapella\b|\ba cappella\b|\bacca\b/i, "acapella"],
  [/\briddim\b/i, "riddim"],
  [/\bfreestyle\b/i, "freestyle"],
  [/\bextended\b/i, "extended"],
  [/\bradio\s?(?:edit|rip|set|show)\b/i, "radio"],
  [/\bpirate\b|\brinse\b|\bdeja\s?vu\b|\bfire in the booth\b|\bdaily duppy\b|\bmad about bars\b|\bsin city\b/i, "session"],
  [/\bmix\b|\bmixtape\b|\bset\b/i, "mix"],
  [/\bcover\b/i, "cover"],
  [/\bedit\b/i, "edit"],
]

/** A riddim mix or medley: many tunes, so the name of what it is (the title), not one tune's riddim. */
const RIDDIM_MIX = /\briddim\s+(?:mix|medley|megamix|mixtape|selection|juggling)\b/i

/** The riddim a piece of a name is, when that's all it is ("Seasons Riddim" → "Seasons"), in a readable case. */
export function riddimIn(s: string): { name: string; year?: number } | null {
  const r = riddimText(s)
  return r ? { ...r, name: smartCase(r.name) } : null
}

/** A folder that's a riddim's own: "Seasons Riddim", "VA - Seasons Riddim (2009) [Don Corleon]", or "Riddims/Seasons". */
export function riddimFolder(folders: string[]): { name: string; year?: number } | null {
  const [near, parent] = folders
  if (!near) return null
  const year = near.match(/\b((?:19[5-9]|20[0-4])\d)\b/)?.[1]
  const bare = collapseSpaces(near.replace(/^(?:va|v\.a\.|various(?:\s+artists)?)\s*[-–]\s*/i, "").replace(/[([][^)\]]*[)\]]/g, " "))
  const own = riddimIn(bare)
  if (own) return { ...own, ...(year && !own.year ? { year: Number(year) } : {}) }
  if (parent && /^riddims?(?:\s+(?:collection|selection|folder))?$/i.test(parent.trim()) && /\p{L}/u.test(bare) && !RIDDIM_MIX.test(bare)) {
    return { name: smartCase(bare.replace(/\s+riddim$/i, "")), ...(year ? { year: Number(year) } : {}) }
  }
  return null
}

const SEPARATORS = [/\s+[-–—]+\s+/, /\s*--+\s*/, /\s+~\s+/, /\s*\|\s*/, /\s+:\s+/]

function decode(raw: string): { text: string; hadUnderscores: boolean } {
  let s = raw
  try {
    if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s)
  } catch {
    // leave undecodable names alone
  }
  const hadUnderscores = /_/.test(s)
  // "artist_-_title" → "artist - title"; lone underscores → spaces
  s = s.replace(/_+-_+/g, " - ").replace(/_/g, " ")
  // "artist.-.title" and dotted names with no spaces
  if (!/\s/.test(s) && (s.match(/\./g)?.length ?? 0) >= 2) s = s.replace(/\./g, " ")
  // "A1-Tenor_Saw-Ring_The_Alarm" / "Artist-Title": with no spaced separator,
  // treat hyphens between 2+ character chunks as separators ("Jay-Z" survives).
  if (!/\s[-–—]\s/.test(s) && (hadUnderscores || !/\s/.test(raw))) {
    s = s.replace(/(?<=[\p{L}\p{N}]{2})-(?=[\p{L}\p{N}]{2})/gu, " - ")
  }
  return { text: collapseSpaces(s), hadUnderscores }
}

/** A leading track number or position, kept off the artist ("50 Cent", "112" and years stay). */
function extractTrackNumber(s: string): { rest: string; track?: string; position?: DiscPosition } {
  const lead = leadingPosition(s)
  if (!lead) return { rest: s }
  if (/^(?:cent|seconds|foot|pence)\b/i.test(lead.rest)) return { rest: s }
  return lead
}

/** The folders' disc or side, with the filename's number or position on it. */
function mergePosition(folder: DiscPosition | null, file: DiscPosition | undefined): DiscPosition | undefined {
  if (!folder) return file
  if (!file) return folder
  // "1-05", "CD2-03": the filename says it all.
  if (file.disc && !file.side) return file
  // "LP2/A1": side A of the second record.
  if (file.side) return { ...file, disc: folder.disc && !folder.side ? folder.disc : file.disc }
  // "CD2/05", "Side B/03": the folder's disc or side, the filename's number.
  return { ...folder, number: file.number }
}

function extractYear(s: string): { year?: number; rest: string } {
  // Bracketed years anywhere, or a bare year at the very end / after "live".
  // A bare year mid-string is probably part of the title ("1999", "1865").
  const full =
    s.match(/[([]\s*(19[5-9]\d|20[0-4]\d)\s*[)\]]/) ??
    s.match(/(?:\blive(?:\s+(?:in|at))?\s+)?\b(19[5-9]\d|20[0-4]\d)$/i) ??
    s.match(/\blive(?:\s+(?:in|at))?\s+(19[5-9]\d|20[0-4]\d)\b/i)
  if (full) {
    const kept = /^live/i.test(full[0].trim()) ? " live " : " "
    return { year: Number(full[1]), rest: collapseSpaces(s.replace(full[0], kept)) }
  }
  // "live 93", "'93", "live in 95"
  const short = s.match(/(?:\blive(?:\s+in)?\s+|\s')(\d{2})\b/i)
  if (short) {
    const yy = Number(short[1])
    const year = yy >= 50 ? 1900 + yy : 2000 + yy
    return { year, rest: collapseSpaces(s.replace(short[0], short[0].replace(short[1], "").replace(/'$/, ""))) }
  }
  return { rest: s }
}

function detectVersion(s: string): { hints: string[]; version?: string } {
  const hints: string[] = []
  for (const [re, name] of VERSION_HINTS) if (re.test(s)) hints.push(name)
  // Explicit bracketed version text wins: "(Skepta Remix)", "[Dubplate]"
  const bracket = s.match(/[([]([^)\]]*(?:remix|mix|dub|dubplate|special|version|edit|vip|refix|bootleg|live|instrumental|acapella|freestyle|rework|cover)[^)\]]*)[)\]]/i)
  return { hints: [...new Set(hints)], version: bracket ? collapseSpaces(bracket[1]) : undefined }
}

function isPlausibleName(s: string): boolean {
  const t = s.trim()
  if (t.length < 1) return false
  if (/^\d+$/.test(t)) return false
  if (/^(?:track|audio|unknown|untitled|new|song)\s*\d*$/i.test(t)) return false
  return true
}

/** Find a known artist at the start of an unseparated string. */
function findLeadingArtist(s: string, candidates: string[]): { artist: string; rest: string } | null {
  const words = s.split(" ")
  // Try longest prefixes first so "beenie man" beats "beenie".
  for (let n = Math.min(words.length - 1, 6); n >= 1; n--) {
    const prefix = words.slice(0, n).join(" ")
    const key = normArtist(prefix)
    if (!key) continue
    if (candidates.includes(key)) return { artist: prefix, rest: words.slice(n).join(" ") }
  }
  return null
}

const VS = /^(?:vs\.?|versus|v)$/i

/** The artist at the start of what follows a "vs": a known one, else the words up to a hint, a date or a bracket. */
function takeClashArtist(s: string, known: string[]): { artist: string; rest: string } {
  const hit = findLeadingArtist(s, known)
  if (hit) return hit
  const words = s.split(" ")
  const stopAt = words.findIndex((w, i) => i > 0 && (/^(live|dubplate|dub|special|clash|sound|at|in|'\d{2}|part|pt|side|tape|session)$/i.test(w) || /^\d/.test(w) || /^[([]/.test(w) || VS.test(w)))
  const take = stopAt === -1 ? Math.min(words.length, 2) : stopAt
  return { artist: words.slice(0, take).join(" "), rest: words.slice(take).join(" ") }
}

/**
 * Split an unseparated clash string: "buju banton vs beenie man live dubplate"
 * → artists before "vs" and the first artist-like chunk after it - and after
 * each further "vs", for a three-way clash ("Jaro vs Stone Love vs Metro Media 9-94").
 */
function splitClash(s: string, known: Set<string>): { artistPart: string; rest: string } | null {
  const m = s.match(/^(.+?)\s+(?:vs\.?|versus|v)\s+(.+)$/i)
  if (!m) return null
  const knownList = [...known]
  const names = [m[1]]
  let rest = m[2]
  for (let i = 0; i < 4; i++) {
    const next = takeClashArtist(rest, knownList)
    names.push(next.artist)
    rest = next.rest
    const more = rest.match(/^(?:vs\.?|versus|v)\s+(.+)$/i)
    if (!more) break
    rest = more[1]
  }
  return { artistPart: names.join(" vs "), rest }
}

export function parseFilename(filename: string, context: ParseContext = {}): HeuristicParse {
  const notes: string[] = []
  // "CD1", "Disc 2", "Side A" folders say where the track sits, never the album or artist.
  const folderPos = folderPosition(context.folders ?? [])
  const ctx: ParseContext = { ...context, folders: withoutDiscFolders(context.folders ?? []) }
  if (folderPos) notes.push(`folder "${folderPos.label}" is a disc or side, not the album`)
  const known = ctx.knownArtists ?? new Set<string>()
  // The riddim a tune is voiced on: from the name, else its folder or its album tag. Never the artist.
  let riddim: { name: string; year?: number } | null = null
  const base = filename.replace(/\.[a-z0-9]{2,5}$/i, "")
  const { text: decoded, hadUnderscores } = decode(base)
  if (hadUnderscores) notes.push("underscores treated as spaces")

  let s = decoded
  for (const re of JUNK_PATTERNS) s = s.replace(re, " ")
  s = collapseSpaces(s.replace(/[([]\s*[)\]]/g, " "))

  const { rest: afterTrack, track, position: filePos } = extractTrackNumber(s)
  if (track) notes.push(`leading track number "${track}" removed`)
  s = afterTrack

  // "Is There A Place (Seasons Riddim)": the riddim, out of the title.
  s = collapseSpaces(
    s.replace(/[([]([^()[\]]{2,60})[)\]]/g, (m, inner: string) => {
      const r = riddimIn(inner)
      if (!r) return m
      riddim ??= r
      return " "
    })
  )
  let position = mergePosition(folderPos, filePos)

  // A file that's just "Side A", "CD2": the whole side or disc of what its folder names.
  const whole = discMarker(s)
  if (whole) {
    const [outer, ...rest] = ctx.folders ?? []
    // "Tape 2/Side A.mp3": side A of the second tape.
    const disc = whole.side && position?.disc && !position.side ? position.disc : (whole.disc ?? position?.disc)
    const pos: DiscPosition = { ...position, ...whole, disc, whole: true }
    if (outer) {
      const inner = parseFilename(`${outer}.mp3`, { ...ctx, folders: rest })
      return {
        ...inner,
        version: whole.label,
        trackNumber: track,
        position: pos,
        notes: [...notes, `the file is ${whole.label} of "${outer}", read from the folder`, ...inner.notes],
        confidence: Math.min(inner.confidence, 0.6),
        cleaned: s,
      }
    }
    position = pos
  }

  // "Clash 1995 (Side B)", "Fabric 99 CD2", "juggling side b pt2": that part of a longer recording.
  const part = trailingPart(s)
  if (part) {
    s = part.rest
    position = { ...position, ...part.position }
    notes.push(`"${part.position.label}" is the part of the recording, not the title`)
  }

  const { hints, version: bracketVersion } = detectVersion(s)
  const { year: nameYear, rest: afterYear } = extractYear(s)
  let year = nameYear
  s = afterYear

  // --- split into artist / title ---
  let artistPart = ""
  let titlePart = s
  let confidence = 0.1
  let separator: string | undefined

  for (const sep of SEPARATORS) {
    const parts = s.split(sep).map((p) => p.trim()).filter(Boolean)
    if (parts.length < 2) continue
    separator = sep.source
    // "Seasons Riddim - Gyptian - Is There A Place": the riddim leads, or sits among the parts.
    // ("Steelie & Clevie - Sleng Teng Riddim" is the riddim's own cut: that stays the title.)
    const at = parts.findIndex((p, i) => (parts.length > 2 || i === 0) && riddimIn(p))
    if (at >= 0) {
      riddim ??= riddimIn(parts[at])
      parts.splice(at, 1)
      notes.push(`"${riddim!.name} Riddim" is the riddim, not the ${at === 0 ? "artist" : "title"}`)
      if (parts.length === 1) notes.push("only one other part: it may be the artist or the title")
    }
    const meaningful = parts.filter(isPlausibleName)
    if (meaningful.length === 2) {
      ;[artistPart, titlePart] = meaningful
      // "Seasons Riddim Mix - DJ Smiley": the mix is the title, whoever made it the artist.
      if (RIDDIM_MIX.test(artistPart) && !RIDDIM_MIX.test(titlePart)) [artistPart, titlePart] = [titlePart, artistPart]
      confidence = at >= 0 ? 0.8 : 0.85
    } else if (meaningful.length > 2) {
      // Artist - Album - Title, or Artist - Title - Version
      artistPart = meaningful[0]
      const folderAlbum = ctx.folders?.[0] ? normArtist(ctx.folders[0]) : ""
      if (folderAlbum && normArtist(meaningful[1]) === folderAlbum) {
        titlePart = meaningful.slice(2).join(" - ")
        notes.push("middle segment matches folder name — treated as album")
      } else {
        titlePart = meaningful.slice(1).join(" - ")
      }
      confidence = 0.55
    } else {
      titlePart = meaningful[0] ?? s
      confidence = 0.2
    }
    break
  }

  // "Jaro vs Stone Love 1994 - Feat. Josie Wales": the year closes the clash, not a sound's name.
  let clashYear: number | undefined
  if (separator && !year && /\s(?:vs\.?|versus|v)\s/i.test(artistPart)) {
    const y = artistPart.match(/\s[([]?((?:19[5-9]|20[0-4])\d)[)\]]?$/)
    if (y) {
      clashYear = Number(y[1])
      artistPart = artistPart.slice(0, y.index).trim()
    }
  }

  // "Title by Artist"
  if (!separator) {
    const by = s.match(/^(.+?)\s+by\s+(.+)$/i)
    if (by && isPlausibleName(by[1]) && isPlausibleName(by[2])) {
      titlePart = by[1]
      artistPart = by[2]
      confidence = 0.6
      separator = "by"
    }
  }

  if (!separator) {
    const clash = splitClash(s, known)
    if (clash) {
      artistPart = clash.artistPart
      titlePart = clash.rest
      confidence = 0.45
      notes.push("clash detected from 'vs' without a separator")
    }
  }

  // A riddim's own folder or album, or an artist tag that's really the riddim.
  const fromFolder = riddimFolder(ctx.folders ?? [])
  const tagRiddim = (ctx.tagAlbum ? riddimIn(ctx.tagAlbum) : null) ?? (ctx.tagArtist ? riddimIn(ctx.tagArtist) : null)
  if (!riddim && (fromFolder || tagRiddim)) {
    riddim = fromFolder ?? tagRiddim
    notes.push(fromFolder ? `riddim "${riddim!.name}" from the folder` : `riddim "${riddim!.name}" from the tags`)
  }
  const tagArtist = ctx.tagArtist && !riddimIn(ctx.tagArtist) ? ctx.tagArtist : undefined

  if (!separator && !artistPart) {
    const pool = [...known]
    if (tagArtist) pool.push(normArtist(tagArtist))
    for (const f of ctx.folders ?? []) if (!riddimIn(f)) pool.push(normArtist(f))
    const lead = findLeadingArtist(s, pool.filter(Boolean))
    if (lead) {
      artistPart = lead.artist
      titlePart = lead.rest
      confidence = 0.4
      notes.push("artist inferred from a known name at the start")
    } else if (tagArtist) {
      artistPart = tagArtist
      confidence = 0.25
      notes.push("no separator — artist taken from embedded tag")
    } else if (ctx.folders?.[0] && !fromFolder && !/^(?:music|downloads?|mp3s?|new folder|misc|various|unsorted|tunes|singles)$/i.test(ctx.folders[0])) {
      notes.push("no separator — the folder name may be the artist")
    }
  }

  // Strip hint words that are clearly not part of a song name from the title
  // when they trail it ("... live dubplate").
  let title = titlePart
  const trailing = /\s+(?:live|dub\s?plate|special|clash|sound\s?clash|version|tape|recording|session)$/i
  let guard = 0
  while (trailing.test(title) && guard++ < 4) title = title.replace(trailing, "")
  title = collapseSpaces(title.replace(/^[-–—:~|]+|[-–—:~|]+$/g, ""))

  // Whatever's left in the artist's place can still be a riddim ("Seasons Riddim Gyptian - …" aside).
  const leftover = riddimIn(artistPart)
  if (leftover) {
    riddim ??= leftover
    artistPart = ""
    notes.push(`"${leftover.name} Riddim" is the riddim, not the artist`)
  }
  if (riddim && !year && riddim.year) year = riddim.year
  if (riddim && !hints.includes("riddim")) hints.push("riddim")

  const { artists, featuring, relation } = splitArtists(artistPart, known)
  // Featuring credits sometimes live in the title: "Title (feat. X)"
  const titleFeat = title.match(/[([]?\b(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[)\]]?/i)
  if (titleFeat) {
    featuring.push(...splitArtists(titleFeat[1]).artists)
    title = collapseSpaces(title.replace(titleFeat[0], " "))
  }

  if (!artists.length) confidence = Math.min(confidence, 0.25)
  if (!isPlausibleName(title)) {
    confidence = Math.min(confidence, 0.2)
    notes.push("title looks generic or empty")
  }
  if (hints.includes("clash") || relation === "vs") {
    notes.push("looks like a clash recording — title may need to describe the event")
  }

  let version = bracketVersion
  if (!version) {
    if (hints.includes("dubplate")) version = "Dubplate"
    else if (hints.includes("special")) version = "Special"
    else if (hints.includes("live") && !hints.includes("clash")) version = "Live"
  }
  if (version && bracketVersion) {
    title = collapseSpaces(title.replace(new RegExp(`[([]${bracketVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[)\\]]`, "i"), " "))
  }
  if (part?.position.label) version = version ? `${version}, ${part.position.label}` : part.position.label

  // The same checks every reading gets: a title left in an artist (from a tag), noise, placeholders…
  const checked = checkFields(
    { artists: artists.map(smartCase), featuring: featuring.map(smartCase), title: smartCase(title), version: version ? smartCase(version) : undefined, riddim: riddim?.name, year: year ?? clashYear },
    { names: false }
  )
  for (const n of checked.notes) if (n.fixed) notes.push(n.message)
  const f = checked.fields
  if (!f.artists.length) confidence = Math.min(confidence, 0.25)
  return {
    artists: f.artists,
    featuring: f.featuring ?? [],
    relation: f.artists.length > 1 ? relation : undefined,
    title: f.title,
    version: f.version,
    ...(f.riddim ? { riddim: f.riddim } : {}),
    year: f.year,
    cleaned: s,
    trackNumber: track,
    ...(position ? { position } : {}),
    hints,
    confidence,
    notes,
  }
}