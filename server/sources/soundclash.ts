// SoundClash Hub's sound system pages. Each sound (Killamanjaro, Stone Love,
// King Addies…) has a page of featured clash recordings, mostly soundtape.com
// uploads embedded from SoundCloud: who played, who against, and the year. For
// a clash tape that's the recording itself, so a track whose sounds have a
// page is checked against their featured clashes.

import * as cheerio from "cheerio"
import type { Candidate } from "../../shared/types"
import { collapseSpaces, normArtist } from "../core/normalize"
import { httpJson, httpText } from "./http"
import { type SourceAdapter, yearOf } from "./types"

const SITE = "https://soundclashhub.com"
/** Pages read for one track: its two sounds, and one more for a three-way clash. */
const MAX_PAGES = 3

export interface FeaturedClash {
  year?: number
  title: string
  embedId?: string
  platform?: string
  opponents: string[]
  /** a link to the recording, when the page gives one rather than an embed id */
  url?: string
}

type Sound = { name: string; slug: string }

const FILLER = new Set(["sound", "sounds", "system", "systems", "hifi", "hi", "fi", "international", "intl", "int", "crew"])
const TITLES = new Set(["king", "sir", "mighty", "lord"])
/** Names a sound goes by that its page doesn't spell out. */
const ALIASES: Record<string, string> = { jaro: "killamanjaro", "papa jaro": "killamanjaro" }

/**
 * A sound's name reduced to what tells it apart: "King Jammy's" → "jammy",
 * "Saxon Sound" → "saxon", "Volcano Hi-Power" → "volcano power".
 */
export function soundKey(name: string): string {
  const n = normArtist(name.replace(/['’]s\b/gi, ""))
  if (ALIASES[n]) return soundKey(ALIASES[n])
  const words = n.split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w))
  while (words.length > 1 && TITLES.has(words[0])) words.shift()
  return words.map((w) => (w.length > 3 ? w.replace(/s$/, "") : w)).join(" ")
}

/** The directory's sounds a track's artists name: exactly, or by a distinctive first word ("Volcano"). */
export function soundsFor(artists: string[], directory: Sound[]): Sound[] {
  const keyed = directory.map((s) => ({ s, key: soundKey(s.name) })).filter((x) => x.key)
  const out: Sound[] = []
  for (const artist of artists) {
    const k = soundKey(artist)
    if (!k) continue
    let hits = keyed.filter((x) => x.key === k)
    if (!hits.length && !k.includes(" ") && k.length >= 5) {
      const byFirst = keyed.filter((x) => x.key.split(" ")[0] === k)
      if (byFirst.length === 1) hits = byFirst
    }
    for (const h of hits) if (!out.includes(h.s)) out.push(h.s)
  }
  return out.slice(0, MAX_PAGES)
}

/** The JSON array that follows `"key":` in `text`, read with strings (and the brackets in them) skipped. */
function arrayAfter(text: string, key: string): unknown[] | null {
  const at = text.indexOf(`"${key}":`)
  if (at < 0) return null
  const start = text.indexOf("[", at)
  if (start < 0) return null
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === "\\") i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === "[") depth++
    else if (c === "]" && --depth === 0) {
      try {
        const v = JSON.parse(text.slice(start, i + 1))
        return Array.isArray(v) ? v : null
      } catch {
        return null
      }
    }
  }
  return null
}

/** The page's own data, as Next.js streams it into script tags. */
function pageData(html: string): string {
  let out = ""
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      out += JSON.parse(m[1]) as string
    } catch {
      // a chunk that isn't a plain string
    }
  }
  return out
}

/** "vs King Addies (1993)" → the opponents and the year. */
function readVs(line: string): { opponents: string[]; year?: number } {
  const m = line.match(/^\s*vs\.?\s+(.+?)\s*(?:\((\d{4})\))?\s*$/i)
  if (!m) return { opponents: [], year: yearOf(line) }
  return { opponents: m[1].split(/\s*(?:,|&|\bvs\.?)\s*/i).filter(Boolean), year: m[2] ? Number(m[2]) : undefined }
}

/** The featured clashes on a sound's page: from its data, or failing that from the players on the page. */
export function featuredClashes(html: string): FeaturedClash[] {
  const data = arrayAfter(pageData(html), "featuredClashes")
  if (data) {
    return data
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as { title?: unknown }).title === "string")
      .map((c) => ({
        title: String(c.title),
        year: typeof c.year === "number" ? c.year : yearOf(String(c.year ?? "")),
        embedId: typeof c.embedId === "string" ? c.embedId : undefined,
        platform: typeof c.platform === "string" ? c.platform : undefined,
        opponents: Array.isArray(c.opponents) ? c.opponents.filter((o): o is string => typeof o === "string") : [],
      }))
  }
  const $ = cheerio.load(html)
  const out: FeaturedClash[] = []
  $("iframe[src*='soundcloud.com/player'], iframe[src*='youtube.com/embed'], iframe[src*='youtube-nocookie.com/embed']").each((_, el) => {
    const frame = $(el)
    const card = frame.closest("[data-slot=card]")
    const title = collapseSpaces(card.find("h4").first().text() || frame.attr("title") || "")
    if (!title) return
    const vs = readVs(card.find("h4").first().next("p").text() || card.find("p").first().text())
    const link = card.find("a[href*='soundcloud.com/'], a[href*='youtube.com/watch'], a[href*='youtu.be/']").first().attr("href")
    out.push({ title, year: vs.year, opponents: vs.opponents, url: link })
  })
  return out
}

/** The ways a title may write a sound's name: "Saxon Sound" as "Saxon", "King Addies" as "Addies". */
function nameVariants(name: string): string[] {
  const plain = name.replace(/\s+(?:sound(?:\s+system)?|hi-?fi|international|intl)\.?$/i, "")
  const bare = plain.replace(/^(?:king|sir|mighty|lord)\s+/i, "")
  return [...new Set([name, plain, bare].map((n) => n.trim()).filter((n) => n.length >= 3))]
}

/** Where a featured clash can be heard. */
function linkOf(c: FeaturedClash): string | undefined {
  if (c.url) return c.url
  if (!c.embedId) return undefined
  if (c.platform === "youtube") return `https://www.youtube.com/watch?v=${encodeURIComponent(c.embedId)}`
  return `https://soundcloud.com/${c.embedId}`
}

/**
 * "Killamanjaro vs King Addies - NY (Classic)" with its sounds known: what's
 * left once they're taken off the front - "NY (Classic)". Just the sounds and
 * the year ("Killamanjaro vs Silver Hawk ft. Ninjaman") make it a clash.
 */
export function clashTitle(title: string, sounds: string[]): string {
  let rest = collapseSpaces(title)
  const names = [...new Set(sounds.flatMap(nameVariants))].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const lead = new RegExp(String.raw`^(?:(?:${names.join("|")})(?:\s*\(?(?:uk|ja|us|usa)\)?)?\s*(?:\bvs?\b\.?|\bversus\b|&|/|,|\bx\b)?\s*)+`, "i")
  if (names.length) rest = rest.replace(lead, "")
  rest = rest
    .replace(/^(?:ft|feat)\.?\s.*$/i, "")
    .replace(/^[\s\-–—:|]+/, "")
    .replace(/^\((.*)\)$/, "$1")
    .trim()
  return rest || "Clash"
}

export const soundclashSounds: SourceAdapter = {
  id: "soundclashhub",
  label: "SoundClash Hub sounds",
  unavailable: () => null,
  async search(q, { signal }) {
    if (!q.artists.length) return []
    const dir = await httpJson<{ sounds?: Sound[] }>(`${SITE}/api/sounds`, { signal })
    const sounds = soundsFor(q.artists, (dir?.sounds ?? []).filter((s) => s?.name && s?.slug))
    const out: Candidate[] = []
    const seen = new Set<string>()
    for (const sound of sounds) {
      const { status, body } = await httpText(`${SITE}/sounds/${encodeURIComponent(sound.slug)}`, { signal })
      if (status === 404) continue
      for (const c of featuredClashes(body)) {
        const key = c.embedId ?? c.url ?? c.title
        if (seen.has(key)) continue
        seen.add(key)
        const artists = [sound.name, ...c.opponents.filter((o) => soundKey(o) !== soundKey(sound.name))]
        out.push({
          source: "soundclashhub",
          sourceLabel: "SoundClash Hub",
          artist: artists.join(" vs "),
          artists,
          title: clashTitle(c.title, artists),
          year: c.year,
          url: linkOf(c) ?? `${SITE}/sounds/${sound.slug}`,
          externalId: c.embedId,
        })
      }
    }
    return out
  },
}
