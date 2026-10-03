// The riddim databases: Riddimguide, Riddim-ID, Reggae Fever's catalogue and
// Riddims World. Between them they know which riddim a reggae or dancehall tune
// is voiced on, with its label and year - the 7" detail the big
// catalogues leave out. Each is asked for the song, and only the rows by the
// track's own artists are kept: "Ring The Alarm" is a dozen different tunes.

import * as cheerio from "cheerio"
import type { Candidate, SourceId } from "../../shared/types"
import { artistSimilarity, collapseSpaces, titleSimilarity } from "../core/normalize"
import { httpJson, httpText } from "./http"
import { enc, yearOf, type SourceAdapter, type SourceQuery } from "./types"
import { plainText } from "../core/plain-text"

/** Rows kept per track. */
const MAX_HITS = 8

/** The song a track is, for asking a riddim database: nothing when the title only describes a recording. */
function songOf(q: SourceQuery): string {
  return q.descriptiveTitle ? "" : collapseSpaces(q.title.replace(/\s*[([][^)\]]*[)\]]\s*/g, " "))
}

/** A row is the track when its artist is one of the track's and its title the same song. */
export function sameTune(q: Pick<SourceQuery, "artists" | "title">, artist: string, title: string): boolean {
  if (!artist || !title) return false
  return artistSimilarity(q.artists, artist) >= 0.8 && titleSimilarity(q.title, title) >= 0.75
}

/**
 * How a riddim database writes a dub or a version: "[Dub King Tubby]" or
 * "[Dub]" as the artist. The engineer is the artist, and the title says it's
 * the dub.
 */
export function readDubCredit(artist: string, title: string): { artist: string; title: string } {
  const m = artist.match(/^\[(?:dub|version|instrumental)\b\s*(.*?)\]$/i)
  if (!m) return { artist: artist.replace(/^\[|\]$/g, ""), title }
  return { artist: m[1].trim(), title: /\b(dub|version)\b/i.test(title) ? title : `${title} (Dub)` }
}

/** "Stormy Weather (1)" → "Stormy Weather"; "Sleng Teng / Sleng Teng Refuelled" → "Sleng Teng". */
export function riddimName(s: string | null | undefined): string | undefined {
  const name = collapseSpaces((s ?? "").split(/\s+\/\s+|,\s*/)[0].replace(/\s*\(\d+\)$/, "").replace(/\s+riddim$/i, ""))
  return name || undefined
}

function hit(source: SourceId, sourceLabel: string, c: Omit<Candidate, "source" | "sourceLabel">): Candidate {
  return { source, sourceLabel, ...c }
}

// ---------- Riddimguide ----------

const RIDDIMGUIDE = "https://www.riddimguide.com"

/** The tunes in a Riddimguide results table. */
export function riddimguideRows(html: string): Omit<Candidate, "source" | "sourceLabel">[] {
  const $ = cheerio.load(html)
  const out: Omit<Candidate, "source" | "sourceLabel">[] = []
  $("div.results tr").each((_, el) => {
    const cells = $(el).children("td")
    if (cells.length < 6) return
    const text = (i: number) => collapseSpaces(cells.eq(i).text())
    // "Junior Wilson credited as Junior Willow Wilson": the name on the record is the second.
    const credited = text(0).match(/credited as\s+(.+)$/i)?.[1]
    const read = readDubCredit(credited ?? text(0), text(1))
    if (!read.title) return
    const link = cells.last().find("a").attr("href")
    out.push({
      artist: read.artist,
      title: read.title,
      riddim: riddimName(cells.eq(2).find("a").first().text() || text(2)),
      year: yearOf(text(3)),
      label: text(4) || undefined,
      url: link ? new URL(link, RIDDIMGUIDE).toString() : undefined,
    })
  })
  return out
}

export const riddimguide: SourceAdapter = {
  id: "riddimguide",
  label: "Riddimguide",
  unavailable: () => null,
  async search(q, { signal }) {
    const song = songOf(q)
    if (!song || !q.artists.length) return []
    // Searching everything at once wants every word in one field, so ask for the song by name.
    const { body } = await httpText(`${RIDDIMGUIDE}/tunes?q=${enc(song)}&c=song`, { signal })
    let rows = riddimguideRows(body).filter((r) => sameTune(q, r.artist, r.title))
    if (!rows.length) {
      // A title spelt differently: the artist's tunes, matched on the title here.
      const byArtist = await httpText(`${RIDDIMGUIDE}/tunes?q=${enc(q.artists[0])}&c=artist`, { signal })
      rows = riddimguideRows(byArtist.body).filter((r) => sameTune(q, r.artist, r.title))
    }
    return rows.slice(0, MAX_HITS).map((r) => hit("riddimguide", "Riddimguide", r))
  },
}

// ---------- Riddim-ID ----------

interface RiddimIdTune {
  id: number
  title: string
  year: number | null
  relArtists?: string | null
  relProducers?: string | null
  relRiddims?: string | null
  relLabels?: string | null
}

export function riddimIdRows(json: { data?: RiddimIdTune[] } | null, term: string): Omit<Candidate, "source" | "sourceLabel">[] {
  // Artists, riddims and labels come as links to their pages: <a href="/artists/271/…">Linval Thompson</a>.
  const text = (s: string | null | undefined) => collapseSpaces(plainText(s ?? ""))
  return (json?.data ?? [])
    .filter((t) => t?.title)
    .map((t) => {
      const read = readDubCredit(text(t.relArtists), text(t.title))
      return {
        artist: read.artist,
        title: read.title,
        riddim: riddimName(text(t.relRiddims)),
        year: yearOf(t.year ?? undefined),
        label: text(t.relLabels) || undefined,
        // Tunes have no page of their own; the search shows the row.
        url: `https://riddim-id.com/search?term=${enc(term)}`,
        externalId: String(t.id),
      }
    })
}

export const riddimId: SourceAdapter = {
  id: "riddimid",
  label: "Riddim-ID",
  unavailable: () => null,
  async search(q, { signal }) {
    const song = songOf(q)
    if (!song || !q.artists.length) return []
    const j = await httpJson<{ data?: RiddimIdTune[] }>(`https://riddim-id.com/search/tunes?term=${enc(song)}`, { signal })
    return riddimIdRows(j, song)
      .filter((r) => sameTune(q, r.artist, r.title))
      .slice(0, MAX_HITS)
      .map((r) => hit("riddimid", "Riddim-ID", r))
  },
}

// ---------- Reggae Fever ----------

const REGGAEFEVER = "https://www.reggaefever.ch"

/** "Techniques VPALWR52273" → "Techniques": the label without its catalogue number (or "blank" for a blank label). */
function labelOf(s: string): string | undefined {
  const words = collapseSpaces(s).split(" ")
  while (words.length > 1 && /\d|^blank$/i.test(words[words.length - 1])) words.pop()
  const label = words.join(" ")
  return label && !/^\d+$/.test(label) ? label : undefined
}

/**
 * Every tune in a Reggae Fever catalogue page: each record's A side and the
 * sides below it, which share its label, year and pressing. A side holding two
 * tunes is written "A / B" in both artist and title.
 */
export function reggaeFeverRows(html: string): Omit<Candidate, "source" | "sourceLabel">[] {
  const $ = cheerio.load(html)
  const out: Omit<Candidate, "source" | "sourceLabel">[] = []
  let record: { label?: string; year?: number; country?: string; url?: string } = {}
  $("tr.articleListUpper, tr.articleListLower").each((_, el) => {
    const row = $(el)
    const cell = (cls: string) => collapseSpaces(row.children(`td.${cls}`).text().replace(/ /g, " "))
    if (row.hasClass("articleListUpper")) {
      const link = row.find("td.artist a, td.title a").first().attr("href")
      record = {
        label: labelOf(cell("label")),
        year: yearOf(cell("year")),
        country: cell("country") || undefined,
        url: link ? new URL(link, `${REGGAEFEVER}/`).toString() : undefined,
      }
    }
    // "Tenor Saw?" - the shop isn't sure of the credit, but it's still the best guess.
    const unsure = (s: string) => s.replace(/\s*\?+$/, "")
    const artists = cell("artist").split(/\s+\/\s+/).map(unsure)
    const titles = cell("title").split(/\s+\/\s+/).map(unsure)
    const riddims = cell("riddim").split(/\s*\/\s*/)
    titles.forEach((title, i) => {
      // "Babylon Brutalize / Version" by "Junior Bowens / Sly & Robbie": one artist per tune.
      const artist = artists.length === titles.length ? artists[i] : artists[0]
      if (!artist || !title || /^version$/i.test(title)) return
      out.push({ artist, title, riddim: riddimName(riddims[i] ?? riddims[0]), ...record })
    })
  })
  return out
}

export const reggaeFever: SourceAdapter = {
  id: "reggaefever",
  label: "Reggae Fever",
  unavailable: () => null,
  async search(q, { signal }) {
    const song = songOf(q)
    if (!song || !q.artists.length) return []
    const { body } = await httpText(`${REGGAEFEVER}/catalog?artist=${enc(q.artists[0])}&title=${enc(song)}`, { signal })
    const seen = new Set<string>()
    return reggaeFeverRows(body)
      .filter((r) => sameTune(q, r.artist, r.title))
      .filter((r) => {
        const key = `${r.url}|${r.title}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, MAX_HITS)
      .map((r) => hit("reggaefever", "Reggae Fever", r))
  },
}

// ---------- Riddims World ----------

interface WpPost {
  link?: string
  date?: string
  title?: { rendered?: string }
  content?: { rendered?: string }
}

/** Text of WordPress HTML, a line per line break or paragraph. */
export function wpText(html: string): string {
  const $ = cheerio.load(`<div>${html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|h\d|div)>/gi, "$&\n")}</div>`)
  return $("div").first().text()
}

/** "Sleng Teng Riddim – Various Labels", "Unsolved Mystery Riddim (2014) – Snowhite Production|Kimichi Records". */
export function readRiddimPost(title: string): { riddim?: string; label?: string; year?: number } {
  const [name, ...rest] = collapseSpaces(title).split(/\s+[–—-]\s+/)
  const riddim = name.match(/^(.+?)\s+riddim\b/i)?.[1]
  const label = rest.join(" - ").split("|")[0].trim()
  return { riddim, label: label && !/^various\b/i.test(label) ? label : undefined, year: yearOf(name) }
}

/** The tunes a Riddims World post lists: "Tenor Saw – Pumpkin Belly (1985)". */
export function riddimsWorldRows(post: WpPost): Omit<Candidate, "source" | "sourceLabel">[] {
  const head = readRiddimPost(cheerio.load(`<p>${post.title?.rendered ?? ""}</p>`)("p").text())
  if (!head.riddim) return []
  const out: Omit<Candidate, "source" | "sourceLabel">[] = []
  for (const line of wpText(post.content?.rendered ?? "").split("\n")) {
    const m = collapseSpaces(line).match(/^(.+?)\s+[–—]\s+(.+?)(?:\s+\((\d{4})\))?$/)
    if (!m) continue
    const read = /^dub$/i.test(m[1]) ? { artist: "", title: m[2] } : readDubCredit(m[1], m[2])
    if (!read.artist) continue
    out.push({ artist: read.artist, title: read.title, riddim: head.riddim, label: head.label, year: m[3] ? Number(m[3]) : head.year, url: post.link })
  }
  return out
}

export const riddimsWorld: SourceAdapter = {
  id: "riddimsworld",
  label: "Riddims World",
  unavailable: () => null,
  async search(q, { signal }) {
    const song = songOf(q)
    // Its search reads post titles only, which are riddim names: it can confirm a riddim the reading names, not find one.
    if (!song || !q.artists.length || !q.riddim) return []
    const riddim = collapseSpaces(q.riddim.replace(/\s+riddim$/i, ""))
    const posts = await httpJson<WpPost[]>(`https://riddimsworld.com/wp-json/wp/v2/posts?search=${enc(riddim)}&per_page=5&_fields=title,link,date,content`, { signal })
    const seen = new Set<string>()
    const out: Candidate[] = []
    for (const post of posts ?? []) {
      for (const r of riddimsWorldRows(post)) {
        const key = `${r.riddim}|${r.artist}|${r.title}`.toLowerCase()
        if (seen.has(key) || !sameTune(q, r.artist, r.title)) continue
        seen.add(key)
        out.push(hit("riddimsworld", "Riddims World", r))
      }
    }
    return out.slice(0, MAX_HITS)
  },
}

export function riddimSources(): SourceAdapter[] {
  return [riddimguide, riddimId, reggaeFever, riddimsWorld]
}
