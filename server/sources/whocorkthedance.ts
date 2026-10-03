// Who Cork The Dance (whocorkthedance.com): an archive of dancehall sound
// system tapes from the late seventies on, a hand-made page per sound or theme.
// Each session is a photo, a heading ("Addies @ Savanna La Mar, Westmoreland,
// 10th July 1992"), who was on the mic, a review, and download links. The site
// has no search, so its pages are read once into an index (and kept a month),
// and a track is matched against it by the file it was downloaded as, or by
// its sounds and year.

import path from "node:path"
import * as cheerio from "cheerio"
import type { Candidate } from "../../shared/types"
import { collapseSpaces, normArtist } from "../core/normalize"
import { parseFilename } from "../core/filename-parser"
import { httpText } from "./http"
import { soundKey } from "./soundclash"
import type { SourceAdapter } from "./types"

const SITE = "https://whocorkthedance.com/"
const MONTH = 30 * 24 * 60 * 60 * 1000
/** Pages that are about the project rather than tapes. */
const NOT_TAPES = /^(?:index|links|bookreviewsetc|videosection)\.html?$/i
/** Where the tapes are, or were, downloaded from. */
const DOWNLOAD = /dropbox\.com|mediafire\.com|mega(?:upload)?\.(?:com|co\.nz|nz)|rapidshare\.com|zippyshare|sendspace|4shared|divshare|hotfile|filefactory|depositfiles|yousendit|archive\.org\/(?:download|details)|drive\.google|\.mp3(?:[?#]|$)/i
/** Menu entries that are themes, not sounds. */
const THEME = /session|mix|tribute|review|video|link|style|classic|dancehall|sounds|aid|promotion|special/i

export interface WctdSession {
  /** the sounds that played */
  artists: string[]
  relation: "vs" | "&"
  /** where and when: "Skateland", "Savanna La Mar, Westmoreland, 10th July" */
  title: string
  year?: number
  /** "Part 2", "Volcano Side": which of a session's downloads */
  part?: string
  heading: string
  /** the file the download is named (Dropbox links carry it) */
  file?: string
  fileKey?: string
  href: string
  page: string
}

type Node = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: Node[] }
type Token = { kind: "text"; text: string } | { kind: "img" } | { kind: "link"; href: string; text: string }

const BLOCK = new Set(["p", "div", "td", "tr", "table", "li", "ul", "h1", "h2", "h3", "h4", "h5", "h6", "center", "blockquote"])

/** The page in reading order: lines of text, photos, and download links. */
function tokens(html: string): Token[] {
  const $ = cheerio.load(html)
  const out: Token[] = []
  let line = ""
  const flush = () => {
    const t = collapseSpaces(line.replace(/ /g, " "))
    if (t) out.push({ kind: "text", text: t })
    line = ""
  }
  const walk = (n: Node) => {
    if (n.type === "text") {
      line += n.data ?? ""
      return
    }
    if (n.type !== "tag" && n.type !== "root") return
    const name = n.name?.toLowerCase()
    if (name === "script" || name === "style" || name === "head" || name === "title") return
    if (name === "img") {
      flush()
      out.push({ kind: "img" })
      return
    }
    if (name === "br") return flush()
    const href = n.attribs?.href
    if (name === "a" && href && DOWNLOAD.test(href)) {
      flush()
      out.push({ kind: "link", href, text: collapseSpaces($(n as never).text()) })
      return
    }
    const block = name ? BLOCK.has(name) : false
    if (block) flush()
    for (const c of n.children ?? []) walk(c)
    if (block) flush()
  }
  walk($.root()[0] as unknown as Node)
  flush()
  return out
}

/** The name a download was saved as, from its link (Dropbox links end in it). */
function fileOf(href: string): string | undefined {
  try {
    const name = decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "")
    return /\.(?:mp3|m4a|wav|flac|ogg|wma|aac)$/i.test(name) ? name : undefined
  } catch {
    return undefined
  }
}

/** Credits the archive glues onto its file names ("…1989keithjaymandrew"). */
const CREDIT = /^(?:jay\w*|\w*jaym\w*|\w*andrew|keith\w*|keimo\w*|\w*ruffhouse|wh|redo)$/

/**
 * A file name reduced to what identifies the tape: no track number, no
 * extension, no uploader credits - "01 killamanjaro skateland august 82jayman.mp3"
 * → "killamanjaro skateland august 82".
 */
export function fileKey(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/(\d)([a-z])/g, "$1 $2")
  const words = s.split(/[^a-z0-9]+/).filter(Boolean)
  // "01 killamanjaro…", "03b arrows…": the archive's running order.
  if (words.length > 2 && /^\d{1,2}$/.test(words[0]) && /[a-z]/.test(words[1])) {
    words.shift()
    if (/^[a-z]$/.test(words[0]) && words[1].length > 1) words.shift()
  }
  while (words.length > 1 && CREDIT.test(words[words.length - 1])) words.pop()
  return words.join(" ")
}

function yearIn(s: string): number | undefined {
  const four = [...s.matchAll(/\b(19[5-9]\d|20[0-4]\d)\b/g)].pop()
  if (four) return Number(four[1])
  // "Jan 83", "skateland 82": a year written short, as the tapes are labelled.
  const two = s.match(/(?:\b|')([7-9]\d)(?:\D*$)/)
  return two ? 1900 + Number(two[1]) : undefined
}

/** "Session 3", "Part 2": a page's own numbering where the sound would be. */
const NUMBERING = /^(?:session|part|tape|dance|recording|volume|vol)\.?\s*\d*$/i

/** "STEREOPHONIC" → "Stereophonic" */
const nameCase = (s: string) => s.toLowerCase().replace(/(^|[\s(-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())

/**
 * "Addies @ Savanna La Mar, 10th July 1992" → the sounds, the place and the
 * year. On a sound's own page ("Session 5 – vs King Sturgav, Tivoli…") the
 * page's sound is the one playing.
 */
export function readHeading(heading: string, known: Set<string>, file?: string, pageSound?: string): Pick<WctdSession, "artists" | "relation" | "title" | "year"> {
  const text = collapseSpaces(heading.replace(/[.…]+$/, ""))
  const year = yearIn(text) ?? (file ? yearIn(file.replace(/\.[a-z0-9]{2,4}$/i, "")) : undefined)
  const split =
    text.match(/^(.+?)\s+@\s*(.+)$/) ??
    text.match(/^(.+?)\s+[-–—]\s+(.+)$/) ??
    text.match(/^(.+?)@\s*(.+)$/) ??
    // "King Sturgav Hi Fi vs Stereophonic, Tivoli Gardens Centre…": the comma ends the clash.
    text.match(/^(.*\s(?:vs?\.?|versus)\s[^,]+?),\s*(.+)$/i)
  // "African Love Hi Fi Brooklyn March 1984": the sound's name ends at its Hi Fi, Sound or Disco
  // (unless it's a clash, "Graphic Superpower vs. Java 1989", read as one below).
  const clash = /\s(?:vs?\.?|versus)\s/i.test(text)
  const named = split || clash ? null : text.match(/^(.+?\b(?:hi[\s-]?fi|hi[\s-]?power|superpower|sound(?:\s+system)?|disco|international|intl|movement)\b)\s+(.+)$/i)
  let artists: string[]
  let place: string
  if (named) {
    artists = named[1].split(/\s+(?:vs?\.?|versus)\s+/i).map((a) => a.trim()).filter(Boolean)
    place = named[2]
  } else if (split) {
    artists = split[1].split(/\s+(?:vs?\.?|versus|&|and)\s+|\s*[,/]\s*/i).map((a) => a.trim()).filter(Boolean)
    place = split[2]
  } else {
    const p = parseFilename(`${text}.txt`, { knownArtists: known })
    artists = p.artists
    place = p.artists.length ? p.title : text
  }
  let relation: "vs" | "&" = /\s(?:vs?\.?|versus)\s/i.test(split ? split[1] : named ? named[1] : text) ? "vs" : "&"
  if (pageSound && (!artists.length || NUMBERING.test(artists[0]))) {
    artists = [pageSound, ...artists.slice(1)]
    // "Session 5 – vs King Sturgav, Tivoli Gardens Centre…"
    const vs = place.match(/^(?:vs?\.?|versus)\s+([^,]+?)(?:,\s*(.*))?$/i)
    if (vs) {
      artists.push(vs[1].trim())
      place = vs[2] ?? ""
      relation = "vs"
    }
  }
  const title = collapseSpaces(place.replace(/\b(19[5-9]\d|20[0-4]\d)\b/g, " ").replace(/\s*,\s*$/, "").replace(/^[\s,–—-]+|[\s,–—-]+$/g, ""))
  return { artists, relation, title: title || (relation === "vs" ? "Clash" : "Session"), year }
}

/** Lines that list who played or thank someone, rather than name the session. */
const INFO_LINE = /^(?:featuring|feauring|feat|crew|selectors?|operators?|mc|mixers?|engineer|many thanks|thanks|big up|download|part \d)|\bcrew\s*[-–—:]|^[^:]{1,40}\bside\s*:/i
const YEAR = /\b(?:19[5-9]\d|20[0-4]\d)\b/

/** A line that could be a session's heading: short, not a lineup, not a sentence of the review. */
function headingLike(l: string): boolean {
  return (
    /[a-z]/i.test(l) &&
    l.length <= 140 &&
    !INFO_LINE.test(l) &&
    !/^["“‘']/.test(l) &&
    // a sentence of the review, a mix's tracklist ("01 Heavenless - Sound Dimension"), a bitrate
    !/[a-z][.!?]["”]?\s+[A-Z]/.test(l) &&
    !/^\d{1,2}[\s.)-]/.test(l) &&
    !/\d\s*kb(?:p?s)\b/i.test(l)
  )
}

/** How much a line reads like "Sound v Sound @ Venue, Date". */
function headingScore(l: string): number {
  return (/@\s*[a-z]/i.test(l) ? 3 : 0) + (/\s(?:vs?\.?|versus)\s/i.test(l) ? 2 : 0) + (YEAR.test(l) ? 2 : 0) + (/\s[-–—]\s/.test(l) ? 1 : 0) + (/\bhi[\s-]?(?:fi|power)\b|\bsound\b|\bdisco\b/i.test(l) ? 1 : 0)
}

/** The sessions on one page, each download its own entry (a two-sided clash is two). */
export function readPage(html: string, page: string, known: Set<string>, pageSound?: string): WctdSession[] {
  const out: WctdSession[] = []
  let lines: string[] = []
  // A photo or a divider since the last download: what follows is a new session.
  let fresh = true
  let current: { heading: string } | null = null
  for (const t of tokens(html)) {
    if (t.kind === "img") fresh = true
    else if (t.kind === "text") {
      if (/^[-_=*~.]{5,}$/.test(t.text)) {
        lines = []
        fresh = true
      } else lines.push(t.text)
    } else {
      let best: string | null = null
      for (const l of lines.filter(headingLike)) if (best === null || headingScore(l) > headingScore(best)) best = l
      if (best && (headingScore(best) > 0 || fresh || !current)) current = { heading: best }
      lines = []
      fresh = false
      if (!current) continue
      const file = fileOf(t.href)
      const part = collapseSpaces(t.text.replace(/\b(?:download|here|link|click|now|20[0-2]\d)\b/gi, " ")) || undefined
      out.push({ ...readHeading(current.heading, known, file, pageSound), heading: current.heading, part, file, fileKey: file ? fileKey(file) : undefined, href: t.href, page })
    }
  }
  return out
}

/** The menu: each tape page, and the sound it's about when it's a sound's page. */
export function readMenu(html: string): { url: string; sound?: string }[] {
  const $ = cheerio.load(html)
  const seen = new Set<string>()
  const out: { url: string; sound?: string }[] = []
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href")!.trim()
    if (/^(?:[a-z]+:|#|\/\/)/i.test(href) || !/\.html?$/i.test(href) || NOT_TAPES.test(href)) return
    const url = new URL(href, SITE).toString()
    if (seen.has(url)) return
    seen.add(url)
    const label = collapseSpaces($(a).text())
    out.push({ url, sound: label && !THEME.test(label) ? nameCase(label.replace(/\s*\(.*\)$/, "")) : undefined })
  })
  return out
}

let index: { at: number; sessions: WctdSession[] } | null = null
let building: Promise<WctdSession[]> | null = null

/** Every session on the site, read once and kept for a month. */
export async function wctdIndex(): Promise<WctdSession[]> {
  if (index && Date.now() - index.at < MONTH) return index.sessions
  building ??= (async () => {
    try {
      const home = await httpText(SITE, { ttlMs: MONTH })
      const menu = readMenu(home.body)
      const pages: { url: string; html: string; sound?: string }[] = []
      for (const m of menu) {
        try {
          const r = await httpText(m.url, { ttlMs: MONTH })
          if (r.status < 400) pages.push({ url: m.url, html: r.body, sound: m.sound })
        } catch {
          // a page that won't load is left out until next time
        }
      }
      // Sound names from the menu and from headings that say plainly who played,
      // to read the headings that don't ("African Love Hi Fi Brooklyn March 1984").
      const known = new Set(menu.flatMap((m) => (m.sound ? [normArtist(m.sound)] : [])))
      for (const p of pages) for (const s of readPage(p.html, p.url, new Set(), p.sound)) for (const a of s.artists) if (a.split(" ").length <= 5) known.add(normArtist(a))
      known.delete("")
      const sessions = pages.flatMap((p) => readPage(p.html, p.url, known, p.sound))
      index = { at: Date.now(), sessions }
      return sessions
    } finally {
      building = null
    }
  })()
  return building
}

export function resetWctdIndex() {
  index = null
  building = null
}

const words = (s: string) => new Set(normArtist(s).split(" ").filter((w) => w.length > 2))

function toCandidate(s: WctdSession, exact: boolean): Candidate {
  return {
    source: "whocorkthedance",
    sourceLabel: "Who Cork The Dance",
    artist: s.artists.join(s.relation === "vs" ? " vs " : " & "),
    artists: s.artists,
    title: s.part && !/^side$/i.test(s.part) ? `${s.title} (${s.part})` : s.title,
    year: s.year,
    url: s.page,
    externalId: s.file ?? s.href,
    genres: ["Dancehall"],
    ...(exact ? { sourceScore: 1 } : {}),
  }
}

/** The sessions for a track: the one it was downloaded as, then its sounds' sessions, nearest first. */
export function matchSessions(sessions: WctdSession[], q: { artists: string[]; title: string; year?: number; filePath: string }): Candidate[] {
  const key = q.filePath ? fileKey(path.basename(q.filePath)) : ""
  const exact = key ? sessions.filter((s) => s.fileKey === key) : []
  const sounds = new Set(q.artists.map(soundKey).filter(Boolean))
  const title = words(q.title)
  const related = sounds.size
    ? sessions
        .filter((s) => !exact.includes(s))
        .map((s) => {
          const shared = s.artists.filter((a) => sounds.has(soundKey(a))).length
          const near = [...words(s.title)].filter((w) => title.has(w)).length
          return { s, rank: shared * 3 + (q.year && s.year === q.year ? 2 : 0) + near }
        })
        .filter((x) => x.s.artists.some((a) => sounds.has(soundKey(a))))
        .sort((a, b) => b.rank - a.rank)
        .slice(0, 8)
        .map((x) => x.s)
    : []
  return [...exact.map((s) => toCandidate(s, true)), ...related.map((s) => toCandidate(s, false))]
}

export const whoCorkTheDance: SourceAdapter = {
  id: "whocorkthedance",
  label: "Who Cork The Dance",
  local: true,
  unavailable: () => null,
  async search(q) {
    if (!q.artists.length && !q.filePath) return []
    return matchSessions(await wctdIndex(), q)
  },
}
