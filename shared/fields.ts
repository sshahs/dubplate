// What each field may hold. Everything Dubplate fills in - a reading of the
// filename, the AI's answer, a source's hit, the decision, a person's edit -
// goes through checkFields before it's used: what's plainly in the wrong place
// is put right ("Seasons Riddim" as the artist, the title inside the artist,
// "reggae" as the album), and what can't be put right is flagged so the track
// waits for a person instead of being approved or cut. The track editor runs
// the same checks as you type.

import { KNOWN_GENRES, STARTER_GENRE_RULES } from "./genres"
import type { FieldNote } from "./types"

export type { FieldNote }

const collapse = (s: string) => s.replace(/\s+/g, " ").trim()

/** For comparing: no accents, case, punctuation, "&" spelt out, and nothing in brackets. */
function fold(s: string | undefined | null): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[([][^)\]]*[)\]]/g, " ")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/^the /, "")
    .trim()
}

const same = (a: string | undefined | null, b: string | undefined | null) => !!fold(a) && fold(a) === fold(b)

// ---------- riddims ----------

/** A whole riddim mix or medley names many tunes, not the riddim of one. */
const RIDDIM_MIX = /\briddim\s+(?:mix|medley|megamix|mixtape|selection|juggling|instrumental|version)\b|\b(?:mix|medley|megamix)\b/i
const YEAR = /\b((?:19[5-9]|20[0-4])\d)\b/

/**
 * The riddim a piece of a name is, when that's all it is: "Seasons Riddim",
 * "Seasons riddim 2009", "Riddim: Seasons" → "Seasons" (and the year). Never
 * a riddim mix, and never something longer that only mentions one.
 */
export function riddimIn(s: string): { name: string; year?: number } | null {
  const year = s.match(YEAR)?.[1]
  const t = collapse(s.replace(/[([]\s*(?:19[5-9]|20[0-4])\d\s*[)\]]|\b(?:19[5-9]|20[0-4])\d\b/g, " "))
  if (RIDDIM_MIX.test(t)) return null
  const m = t.match(/^(?:the\s+)?(.+?)\s+riddim$/i) ?? t.match(/^riddim\s*[:\-–]\s*(.+)$/i)
  const name = m?.[1].trim().replace(/^the\s+/i, "")
  if (!name || name.length > 40 || name.split(" ").length > 5 || /\s[-–—~|]\s|[([\]]/.test(name) || !/\p{L}/u.test(name)) return null
  return { name, ...(year ? { year: Number(year) } : {}) }
}

/** "Seasons Riddim" → "Seasons": the word is added back wherever it's shown. */
export function bareRiddim(s: string | undefined): string | undefined {
  const t = collapse((s ?? "").replace(/^riddim\s*[:\-–]\s*/i, "").replace(/\s+riddim$/i, ""))
  return t || undefined
}

// ---------- placeholders ----------

const GENRE_WORDS = new Set([
  ...KNOWN_GENRES,
  ...STARTER_GENRE_RULES.map((r) => r.genre.toLowerCase()),
  "hip hop",
  "hiphop",
  "rap",
  "rnb",
  "r and b",
  "r n b",
  "roots reggae",
  "roots and culture",
  "roots & culture",
  "dancehall reggae",
  "dub reggae",
  "lovers",
  "ska",
  "rocksteady",
  "rock steady",
  "bashment",
  "ragga",
  "drum and bass",
  "dnb",
  "d&b",
  "garage",
  "ukg",
  "2 step",
  "2-step",
  "afrobeat",
  "afroswing",
  "dance",
  "electronica",
  "edm",
  "world music",
  "drill",
  "trap",
  "reggaeton",
  "calypso",
  "instrumental",
  "instrumentals",
  "riddims",
  "oldies",
  "old school",
  "classics",
])

/** "reggae", "Reggae / Dancehall", "reggae music": a genre, with nothing else to it. */
export function isGenreName(s: string | undefined): boolean {
  const t = collapse((s ?? "").toLowerCase().replace(/\s+(?:music|songs|tunes|tracks)$/, ""))
  if (!t) return false
  if (GENRE_WORDS.has(t)) return true
  const parts = t.split(/\s*(?:\/|,|;|\+|\||&(?!\s*b\b)|\band\b)\s*/).filter(Boolean)
  return parts.length > 1 && parts.every((p) => GENRE_WORDS.has(p))
}

const SITES = /^(?:www\.)?[a-z0-9-]+\.(?:com|net|org|co\.uk|ru|info|biz|to|cc|me|fm|io|xyz|ws|in|pk)\b|^(?:youtube(?:\s+music)?|soundcloud|spotify|deezer|tidal|apple music|itunes|bandcamp|audiomack|mixcloud)$/i
const ARTIST_PLACEHOLDER = /^(?:unknown(?:\s+artists?)?|various(?:\s+artists)?|va|v\.a\.?|artist|artists|n\/?a|none|null|undefined|untitled|-+|\?+|track\s*\d*|\d+)$/i
const TITLE_PLACEHOLDER = /^(?:untitled|unknown(?:\s+title)?|no\s+title|track\s*\d*|audio(?:\s*\d+)?|title|n\/?a|none|null|undefined|-+|\?+)$/i
const ALBUM_PLACEHOLDER = /^(?:unknown(?:\s+album)?|untitled(?:\s+album)?|no\s+album|album|music|songs?|tracks?|tunes|audio|mp3s?|downloads?|single|singles|misc(?:ellaneous)?|various|va|n\/?a|none|null|other|new(?:\s+folder)?|my\s+music|-+|\?+|(?:19|20)\d{2})$/i
const LABEL_PLACEHOLDER = /^(?:unknown(?:\s+label)?|label|records?|n\/?a|none|null|other|-+|\?+|(?:19|20)\d{2})$/i
const GENRE_PLACEHOLDER = /^(?:other|others|unknown|genre|misc|none|n\/?a|null|default|music|blank|-+|\?+|\(?\d{1,3}\)?)$/i

/** A value that only holds a field's place: a genre as the album, "Unknown Artist", "(17)" as the genre… */
export function isPlaceholder(field: "artist" | "title" | "album" | "label" | "genre", value: string | undefined | null): boolean {
  const v = collapse(value ?? "")
  if (!v) return false
  switch (field) {
    case "artist":
      return ARTIST_PLACEHOLDER.test(v) || SITES.test(v)
    case "title":
      return TITLE_PLACEHOLDER.test(v) || SITES.test(v)
    case "album":
      return ALBUM_PLACEHOLDER.test(v) || isGenreName(v) || SITES.test(v)
    case "label":
      return LABEL_PLACEHOLDER.test(v) || isGenreName(v) || SITES.test(v)
    case "genre":
      return GENRE_PLACEHOLDER.test(v)
  }
}

// ---------- noise ----------

const NOISE: RegExp[] = [
  /\s*[([]\s*(?:official\s+)?(?:music\s+|lyric(?:s)?\s+|hd\s+|hq\s+)?(?:video|audio|visuali[sz]er)(?:\s+(?:hd|hq))?\s*[)\]]/gi,
  /\s+(?:-\s+)?official\s+(?:music\s+)?(?:video|audio)$/gi,
  /\s*[([]\s*(?:lyrics?|hq|hd|high quality|full song|free download|free dl|out now|explicit|clean|mp3|flac|wav|audio only|\d{2,3}\s?kbps)\s*[)\]]/gi,
  /\s+\d{2,3}\s?kbps$/gi,
  /\s*[([]?\s*\b(?:www\.)?[a-z0-9-]+\.(?:com|net|org|co\.uk|ru|info|biz|to|cc|io|xyz)\b\s*[)\]]?/gi,
  /\.(?:mp3|m4a|flac|wav|wma|ogg|opus|aac|aiff?)$/i,
]

/** What came out, for saying so: the trailing part when that's all it was. */
const removed = (before: string, after: string) => (before.startsWith(after) ? `"${collapse(before.slice(after.length))}"` : "video and download noise")

function withoutNoise(s: string): string {
  let out = s
  for (const re of NOISE) out = out.replace(re, " ")
  return collapse(out.replace(/[([]\s*[)\]]/g, " "))
}

// ---------- the check ----------

export interface Fields {
  artists: string[]
  featuring?: string[]
  title: string
  version?: string
  year?: number
  album?: string
  label?: string
  riddim?: string
  genre?: string
}

const FEAT = /\s+[([]?(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[)\]]?\s*$/i
const DASH = /^(.+?)\s+[-–—]+\s+(.+)$/

/**
 * Put right what's plainly in the wrong field, and say what can't be.
 * `names: false` leaves out "no artist" / "no title" (the decision says those itself).
 * `feat: false` leaves "feat." where it is (a source's hit has no featuring field: its guests travel in its artist).
 */
export function checkFields<T extends Fields>(input: T, opts: { names?: boolean; feat?: boolean; now?: Date } = {}): { fields: T; notes: FieldNote[] } {
  const notes: FieldNote[] = []
  const fixed = (field: FieldNote["field"], message: string) => notes.push({ field, fixed: true, message })
  const look = (field: FieldNote["field"], message: string) => notes.push({ field, fixed: false, message })

  let title = collapse(input.title ?? "")
  let riddim = bareRiddim(input.riddim)
  if (input.riddim && riddim !== collapse(input.riddim)) fixed("riddim", `Riddim "${collapse(input.riddim)}" written as "${riddim}" (the word riddim is added where it's shown)`)
  const featuring = (input.featuring ?? []).map(collapse).filter(Boolean)
  let year = input.year

  // ---- title ----
  if (title) {
    const quiet = withoutNoise(title)
    if (quiet !== title && quiet) {
      fixed("title", `Took ${removed(title, quiet)} out of the title`)
      title = quiet
    }
    const num = title.match(/^(?:\d{1,3}|[A-Da-d]\d{1,2})\s*[-._)]\s+(?=\S)/)
    if (num) {
      fixed("title", `Took the track number "${num[0].trim()}" off the title`)
      title = title.slice(num[0].length)
    }
    title = collapse(
      title.replace(/\s*[([]([^()[\]]{2,60})[)\]]/g, (m, inner: string) => {
        const r = riddimIn(inner)
        if (!r) return m
        fixed("riddim", `"${collapse(inner)}" moved out of the title to Riddim`)
        riddim ??= r.name
        year ??= r.year
        return " "
      })
    )
    const feat = opts.feat === false ? null : title.match(FEAT)
    if (feat) {
      fixed("featuring", `Featured artist moved out of the title ("${collapse(feat[1])}")`)
      featuring.push(...feat[1].split(/\s*(?:,|&|\band\b)\s*/).map(collapse).filter(Boolean))
      title = collapse(title.slice(0, feat.index))
    }
  }

  // ---- artists ----
  const artists: string[] = []
  for (const raw of input.artists ?? []) {
    let a = collapse(raw)
    if (!a) continue
    const quiet = withoutNoise(a)
    if (quiet !== a && quiet) {
      fixed("artists", `Took ${removed(a, quiet)} out of the artist`)
      a = quiet
    }
    const r = riddimIn(a)
    if (r) {
      fixed("riddim", `"${a}" is the riddim, not an artist - moved to Riddim`)
      riddim ??= r.name
      year ??= r.year
      continue
    }
    if (isPlaceholder("artist", a)) {
      fixed("artists", `"${a}" isn't an artist's name - taken out`)
      continue
    }
    const feat = opts.feat === false ? null : a.match(FEAT)
    if (feat) {
      fixed("featuring", `Featured artist moved out of the artist ("${collapse(feat[1])}")`)
      featuring.push(...feat[1].split(/\s*(?:,|&|\band\b)\s*/).map(collapse).filter(Boolean))
      a = collapse(a.slice(0, feat.index))
    }
    const dash = a.match(DASH)
    if (dash) {
      const [, who, what] = dash
      if (title && (same(what, title) || fold(title).startsWith(fold(what)) || fold(what).startsWith(fold(title)))) {
        fixed("artists", `The artist had the title in it ("${a}")`)
        a = collapse(who)
      } else if (!title || isPlaceholder("title", title)) {
        fixed("title", `"${a}" was an artist and a title together - split`)
        title = collapse(what)
        a = collapse(who)
      } else if (riddimIn(who)) {
        fixed("riddim", `"${collapse(who)}" is the riddim, not an artist - moved to Riddim`)
        riddim ??= riddimIn(who)!.name
        a = collapse(what)
      } else {
        look("artists", `"${a}" looks like an artist and a title together`)
      }
    }
    if (a && !artists.some((x) => same(x, a))) artists.push(a)
  }

  // "Seasons Riddim" took the artist's place, and the title holds "Gyptian - Is There A Place".
  if (!artists.length && title) {
    const dash = title.match(DASH)
    if (dash && !riddimIn(dash[1]) && !isPlaceholder("artist", dash[1])) {
      fixed("artists", `"${title}" was an artist and a title together - split`)
      artists.push(collapse(dash[1]))
      title = collapse(dash[2])
    }
  }

  // ---- title against the artists ----
  if (title && artists.length) {
    const names = [artists.join(" & "), artists.join(" and "), ...artists]
    const dash = title.match(DASH)
    if (dash && names.some((n) => same(dash[1], n))) {
      fixed("title", `The title started with the artist ("${collapse(dash[1])}")`)
      title = collapse(dash[2])
    } else if (dash && names.some((n) => same(dash[2], n))) {
      fixed("title", `The title ended with the artist ("${collapse(dash[2])}")`)
      title = collapse(dash[1])
    } else if (dash && riddimIn(dash[1])) {
      fixed("riddim", `"${collapse(dash[1])}" is the riddim, not part of the title - moved to Riddim`)
      riddim ??= riddimIn(dash[1])!.name
      title = collapse(dash[2])
    }
  }

  if (opts.names !== false) {
    if (!artists.length) look("artists", "No artist")
    if (!title || isPlaceholder("title", title)) look("title", title ? `"${title}" isn't a song's name` : "No title")
  }
  if (title && artists.length === 1 && same(artists[0], title) && !riddimIn(title)) look("title", `The artist and the title are the same ("${title}")`)

  // ---- featuring: no main artists, no repeats ----
  const feats: string[] = []
  for (const f of featuring) {
    if (artists.some((a) => same(a, f)) || feats.some((x) => same(x, f)) || isPlaceholder("artist", f)) continue
    feats.push(f)
  }

  // ---- version ----
  let version = input.version ? collapse(input.version.replace(/^[([]\s*|\s*[)\]]$/g, "")) : undefined
  if (version && title && same(version, title)) {
    fixed("version", `Version "${version}" was the title again - taken out`)
    version = undefined
  }
  if (version && riddimIn(version)) {
    fixed("riddim", `"${version}" is the riddim, not the version - moved to Riddim`)
    riddim ??= riddimIn(version)!.name
    version = undefined
  }

  // ---- album, label, genre ----
  let album = input.album ? collapse(input.album) : undefined
  if (album && isPlaceholder("album", album)) {
    fixed("album", isGenreName(album) ? `Album "${album}" is a genre, not an album - left empty` : `Album "${album}" isn't an album's name - left empty`)
    album = undefined
  }
  // A riddim compilation is named after its riddim: a riddim worth knowing.
  if (album && !riddim && riddimIn(album)) {
    riddim = riddimIn(album)!.name
    fixed("riddim", `Riddim "${riddim}" from the album`)
  }
  let label = input.label ? collapse(input.label) : undefined
  if (label && isPlaceholder("label", label)) {
    fixed("label", isGenreName(label) ? `Label "${label}" is a genre, not a label - left empty` : `Label "${label}" isn't a label's name - left empty`)
    label = undefined
  }
  let genre = input.genre ? collapse(input.genre) : undefined
  if (genre && isPlaceholder("genre", genre)) {
    fixed("genre", `Genre "${genre}" isn't a genre's name - left empty`)
    genre = undefined
  }

  // ---- year ----
  const latest = (opts.now ?? new Date()).getFullYear() + 1
  if (year !== undefined && (!Number.isInteger(year) || year < 1900 || year > latest)) {
    fixed("year", `Year ${year} can't be right - left empty`)
    year = undefined
  }

  if (riddim && artists.some((a) => same(a, riddim))) look("riddim", `The riddim "${riddim}" is also named as an artist`)

  const fields = {
    ...input,
    artists,
    title,
    ...(input.featuring !== undefined || feats.length ? { featuring: feats } : {}),
    version,
    year,
    album,
    label,
    riddim,
    genre,
  }
  return { fields, notes }
}

/** The notes a person needs to act on. */
export const needsALook = (notes: FieldNote[] | undefined) => (notes ?? []).filter((n) => !n.fixed)

// ---------- versions need evidence ----------

/** Words that say what kind of recording something is, each with the one name it's checked by. */
const KINDS: [RegExp, string][] = [
  [/\bdub\s?plates?\b/gi, "dubplate"],
  [/\bspecials?\b/gi, "special"],
  [/\b(?:re-?mix(?:es|ed)?|rmx)\b/gi, "remix"],
  [/\brefix\b/gi, "refix"],
  [/\bvip\b/gi, "vip"],
  [/\bbootleg\b/gi, "bootleg"],
  [/\b(?:acapella|a\s?cappella|acca)\b/gi, "acapella"],
  [/\b(?:instrumental|inst)\b/gi, "instrumental"],
  [/\bfreestyle\b/gi, "freestyle"],
  [/\blive\b/gi, "live"],
  [/\bedit\b/gi, "edit"],
  [/\bextended\b/gi, "extended"],
  [/\brework\b/gi, "rework"],
  [/\bacoustic\b/gi, "acoustic"],
  [/\bdemo\b/gi, "demo"],
  [/\bdub\b/gi, "dub"],
]

/** The kinds of recording a text names ("Skepta Remix" → remix, "Dub Plate Special" → dubplate, special). */
function kindsIn(s: string): Set<string> {
  const out = new Set<string>()
  // Longest first: "dubplate" isn't also a "dub".
  let rest = s.replace(/_/g, " ")
  for (const [re, kind] of KINDS) {
    if (re.test(rest)) out.add(kind)
    re.lastIndex = 0
    rest = rest.replace(re, " ")
  }
  return out
}

/**
 * A version that says what kind of recording this is ("Dubplate", "Special",
 * "Skepta Remix", "Live") only stands when the evidence (the filename, its
 * folders, its tags, a source that matched it) says the same. A version that
 * names no kind ("Side A", "Part 2") always stands.
 */
export function versionBacked(version: string, evidence: (string | undefined | null)[]): boolean {
  const want = kindsIn(version)
  if (!want.size) return true
  const have = kindsIn(evidence.filter(Boolean).join(" \u0000 "))
  return [...want].every((k) => have.has(k))
}

/** A title without the bracketed versions the evidence doesn't back: "Eye For An Eye (Remix)" for a file that never says remix. */
export function withoutUnbackedVersions(title: string, evidence: (string | undefined | null)[]): { title: string; removed: string[] } {
  const removed: string[] = []
  const out = title.replace(/\s*([([])([^()[\]]{1,60})[)\]]/g, (m, _open: string, inner: string) => {
    if (versionBacked(inner, evidence)) return m
    removed.push(m.trim())
    return ""
  })
  return { title: removed.length ? collapse(out) || title : title, removed: out.trim() ? removed : [] }
}

// ---------- what the AI may only say when the file does ----------

/** For finding one text in another: no accents, case or punctuation, "&" spelt out. Brackets kept. */
const flat = (s: string) =>
  ` ${s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `

/** Everything a file says about itself: its name, its folders and its own tags. */
export function fileSays(t: { filename: string; relDir?: string; tags?: object }): string[] {
  const tags = (t.tags ?? {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : "")
  return [t.filename, t.relDir ?? "", ...["title", "artist", "album", "albumArtist", "comment", "grouping", "label", "year", "genre", "riddim"].map((k) => text(tags[k]))].filter(Boolean)
}

/** The year, as written in a filename: "1993", "'93", "live 93", "26.11.93". */
function yearStated(year: number, evidence: string): boolean {
  const yy = String(year).slice(2)
  return new RegExp(`\\b${year}\\b|['’‘]${yy}\\b|\\blive(?:\\s+(?:in|at))?\\s+${yy}\\b|\\b\\d{1,2}[./-]\\d{1,2}[./-]${yy}\\b`, "i").test(evidence)
}

/**
 * A reading with only what the file states in the fields the AI may never fill
 * from anything else: version, year, label, riddim and event. Whatever it gave
 * that the file doesn't say is left out, and named in `unsupported`. The version
 * is held to its own, narrower evidence when given: what the file itself is
 * called, not the folders and tags round it.
 */
export function groundReading<T extends { version?: string; year?: number; label?: string; riddim?: string; event?: string }>(
  r: T,
  evidence: string[],
  versionEvidence: string[] = evidence
): { reading: T; unsupported: string[] } {
  const all = evidence.join(" \u0000 ")
  const text = flat(all)
  const has = (v: string) => text.includes(flat(v))
  const out: T = { ...r }
  const unsupported: string[] = []
  if (r.version && !versionBacked(r.version, versionEvidence)) {
    unsupported.push(`version "${r.version}"`)
    out.version = undefined
  }
  if (r.year && !yearStated(r.year, all)) {
    unsupported.push(`year ${r.year}`)
    out.year = undefined
  }
  if (r.label && !has(r.label)) {
    unsupported.push(`label "${r.label}"`)
    out.label = undefined
  }
  if (r.riddim && !has(r.riddim)) {
    unsupported.push(`riddim "${r.riddim}"`)
    out.riddim = undefined
  }
  if (r.event && !has(r.event)) {
    unsupported.push(`event "${r.event}"`)
    out.event = undefined
  }
  return { reading: out, unsupported }
}
