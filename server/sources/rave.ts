// UK rave, jungle and pirate radio: Rave Tape Packs, Rave Archive UK,
// MixesDB and junglist.co.uk. Tape packs and radio sets are named by the DJ
// and the night ("Grooverider - World Dance 2003"), so a hit is kept only when
// one of the track's artists actually played it.

import * as cheerio from "cheerio"
import type { Candidate } from "../../shared/types"
import { artistSimilarity, collapseSpaces, normArtist, normKey, titleSimilarity } from "../core/normalize"
import { scraperQueries } from "./scraper"
import { httpJson, httpText } from "./http"
import { enc, yearOf, type SourceAdapter, type SourceQuery } from "./types"

const MAX_HITS = 8

/** The track's artists a list of names includes ("MC Det" and "Det" are the same MC). */
export function whoPlayed(artists: string[], names: string[]): string[] {
  const bare = (s: string) => normArtist(s).replace(/^(?:dj|mc)\s+/, "")
  return names.filter((n) => artists.some((a) => bare(a) === bare(n) || artistSimilarity(a, n) >= 0.9))
}

/** "26.11.93", "28-29.8.99", "10.2.96" → the year. */
export function yearOfDate(s: string): number | undefined {
  const full = yearOf(s)
  if (full) return full
  const yy = s.match(/\b\d{1,2}(?:[–-]\d{1,2})?[./]\d{1,2}[./](\d{2})\b/)?.[1]
  if (!yy) return undefined
  const n = Number(yy)
  return n >= 80 ? 1900 + n : 2000 + n
}

/** Text with typographic dashes as plain ones, so the title compares cleanly. */
const plainDashes = (s: string) => collapseSpaces(s.replace(/\s+[–—]\s+/g, " - "))

// ---------- Rave Tape Packs ----------

const RAVETAPEPACKS = "https://www.ravetapepacks.com"

export interface TapePack {
  title: string
  url?: string
  year?: number
  /** everyone the pack is filed under: DJs, MCs and the event */
  names: string[]
}

/** The packs on a Rave Tape Packs search page. */
export function tapePacks(html: string): TapePack[] {
  const $ = cheerio.load(html)
  const out: TapePack[] = []
  $("article").each((_, el) => {
    const a = $(el).find(".entry-title a").first()
    const title = plainDashes(a.text())
    if (!title) return
    const summary = collapseSpaces($(el).find(".entry-summary").text())
    const cats = $(el)
      .find("a[rel~=category]")
      .map((_, c) => collapseSpaces($(c).text()))
      .get()
    const year = yearOf(summary.match(/\bYEAR:\s*(\d{4})/)?.[1]) ?? yearOf(cats.find((c) => /^\d{4}$/.test(c)))
    out.push({ title, url: a.attr("href"), year, names: cats.filter((c) => !/^\d{4}$/.test(c)) })
  })
  return out
}

export const raveTapePacks: SourceAdapter = {
  id: "ravetapepacks",
  label: "Rave Tape Packs",
  unavailable: () => null,
  async search(q, { signal }) {
    if (!q.artists.length) return []
    for (const query of scraperQueries(q)) {
      const { body } = await httpText(`${RAVETAPEPACKS}/?s=${enc(query)}`, { signal })
      const out: Candidate[] = []
      for (const pack of tapePacks(body)) {
        // The pack is filed under its DJs, its MCs and its event; the event isn't a person.
        const event = pack.title.split(" - ")[0]
        const people = pack.names.filter((n) => normArtist(n) !== normArtist(event))
        for (const name of whoPlayed(q.artists, people)) {
          out.push({ source: "ravetapepacks", sourceLabel: "Rave Tape Packs", artist: name, artists: [name], title: pack.title, album: pack.title, year: pack.year, url: pack.url })
        }
      }
      if (out.length) return out.slice(0, MAX_HITS)
    }
    return []
  },
}

// ---------- Rave Archive UK ----------

interface WpPost {
  link?: string
  title?: { rendered?: string }
  excerpt?: { rendered?: string }
  content?: { rendered?: string }
}

/** "Dreamscape 7 ‘Back to our Roots’ – The Sanctuary – 26.11.93" → the event, the venue and the year. */
export function readEventTitle(title: string): { event: string; venue?: string; year?: number } {
  const parts = collapseSpaces(title).split(/\s+[–—-]\s+/)
  const last = parts[parts.length - 1]
  const year = parts.length > 1 ? yearOfDate(last) : undefined
  const body = year ? parts.slice(0, -1) : parts
  return { event: body[0] ?? title, venue: body.length > 1 ? body.slice(1).join(" - ") : undefined, year: year ?? yearOfDate(title) }
}

export function raveArchiveHits(posts: WpPost[] | null, artists: string[]): Candidate[] {
  const out: Candidate[] = []
  for (const post of posts ?? []) {
    const title = cheerio.load(`<p>${post.title?.rendered ?? ""}</p>`)("p").text()
    if (!title) continue
    // A space at every tag, so "Recording 4 of 9</small><h3>Grooverider" doesn't read as "9grooverider".
    const html = `${post.excerpt?.rendered ?? ""} ${post.content?.rendered ?? ""}`.replace(/>/g, "> ")
    const text = normKey(cheerio.load(`<div>${html}</div>`)("div").first().text())
    // The search matched the words somewhere; keep the night only if the DJ is named on it.
    const played = artists.filter((a) => normArtist(a) && ` ${text} `.includes(` ${normArtist(a)} `))
    if (!played.length) continue
    const read = readEventTitle(title)
    out.push({ source: "ravearchive", sourceLabel: "Rave Archive UK", artist: played.join(" & "), artists: played, title: read.event, album: read.venue ? `${read.event} - ${read.venue}` : read.event, year: read.year, url: post.link })
  }
  return out
}

export const raveArchive: SourceAdapter = {
  id: "ravearchive",
  label: "Rave Archive UK",
  unavailable: () => null,
  async search(q, { signal }) {
    if (!q.artists.length) return []
    for (const query of scraperQueries(q)) {
      const posts = await httpJson<WpPost[]>(`https://rave-archive.com/wp-json/wp/v2/posts?search=${enc(query)}&per_page=8&_fields=title,link,excerpt,content`, { signal })
      const hits = raveArchiveHits(posts, q.artists)
      if (hits.length) return hits.slice(0, MAX_HITS)
    }
    return []
  },
}

// ---------- MixesDB ----------

/**
 * A MixesDB page title: "2007-11-18 - Grooverider - Drum'N'Bass Show",
 * "2009-11-13 - Rob Da Bank, Shut Up And Dance - Annie On One",
 * "2008-11-29 - Shut Up And Dance @ MS Connexion, Mannheim".
 */
export function readMixTitle(title: string): { artists: string[]; show: string; year?: number } | null {
  const m = collapseSpaces(title).match(/^(\d{4})(?:-\d{2}){0,2}\s+-\s+(.+)$/)
  if (!m) return null
  const rest = m[2]
  const at = rest.match(/^(.+?)\s+@\s+(.+)$/)
  const dash = rest.match(/^(.+?)\s+-\s+(.+)$/)
  const [who, show] = at && (!dash || at[1].length < dash[1].length) ? [at[1], at[2]] : dash ? [dash[1], dash[2]] : [rest, ""]
  const artists = who
    .split(/\s*(?:,|&|\bb2b\b|\bvs\.?\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean)
  return { artists, show: show || "Mix", year: Number(m[1]) }
}

export function mixesdbHits(json: { query?: { search?: { title: string }[] } } | null, artists: string[]): Candidate[] {
  const out: Candidate[] = []
  for (const r of json?.query?.search ?? []) {
    const read = readMixTitle(r.title ?? "")
    // A tracklist that plays the artist matches too: only their own sets count.
    if (!read || !whoPlayed(artists, read.artists).length) continue
    out.push({
      source: "mixesdb",
      sourceLabel: "MixesDB",
      artist: read.artists.join(", "),
      artists: read.artists,
      title: read.show,
      year: read.year,
      url: `https://www.mixesdb.com/w/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
    })
  }
  return out
}

export const mixesdb: SourceAdapter = {
  id: "mixesdb",
  label: "MixesDB",
  unavailable: () => null,
  async search(q, { signal }) {
    if (!q.artists.length) return []
    for (const query of scraperQueries(q)) {
      const j = await httpJson<{ query?: { search?: { title: string }[] } }>(
        `https://www.mixesdb.com/w/api.php?action=query&list=search&srsearch=${enc(query)}&srlimit=20&format=json`,
        { signal }
      )
      const hits = mixesdbHits(j, q.artists)
      if (hits.length) return hits.slice(0, MAX_HITS)
    }
    return []
  },
}

// ---------- junglist.co.uk ----------

/** The tracks on a junglist.co.uk search page; "Zen (MONTHS009)" loses its catalogue number. */
export function junglistTracks(html: string): { artist: string; title: string; url: string }[] {
  const $ = cheerio.load(html)
  const out: { artist: string; title: string; url: string }[] = []
  $("a[href^='/tracks/']").each((_, el) => {
    const a = $(el)
    const title = collapseSpaces(a.find("h3").first().text())
    const artist = collapseSpaces(a.find("p").first().text().replace(/\s*\([A-Z0-9 -]*\d[A-Z0-9 -]*\)\s*$/, ""))
    if (title && artist) out.push({ artist, title, url: new URL(a.attr("href")!, "https://junglist.co.uk").toString() })
  })
  return out
}

export const junglist: SourceAdapter = {
  id: "junglist",
  label: "junglist.co.uk",
  unavailable: () => null,
  async search(q: SourceQuery, { signal }) {
    if (q.descriptiveTitle || !q.title) return []
    for (const query of [...new Set([q.title, q.query])]) {
      const { body } = await httpText(`https://junglist.co.uk/tracks?search=${enc(query)}`, { signal })
      const hits = junglistTracks(body)
        // Whitelabels are often credited to "Unknown": the title alone has to carry those.
        .filter((t) => titleSimilarity(q.title, t.title) >= 0.75 && (/^(unknown|whitelabel|white label)$/i.test(t.artist) || artistSimilarity(q.artists, t.artist) >= 0.7))
        .map((t): Candidate => ({ source: "junglist", sourceLabel: "junglist.co.uk", artist: t.artist, title: t.title, url: t.url }))
      if (hits.length) return hits.slice(0, MAX_HITS)
    }
    return []
  },
}

export function raveSources(): SourceAdapter[] {
  return [raveTapePacks, raveArchive, mixesdb, junglist]
}
