// User-defined scrapers for specialist sites. Two flavours:
//  - html: CSS selectors over a search results page
//  - json: dot-paths over a JSON search API (e.g. WordPress /wp-json), or over
//    JSON a page carries inside it (a script tag, as Hype Machine does)

import * as cheerio from "cheerio"
import type { Candidate, ScraperDefinition } from "../../shared/types"
import { collapseSpaces } from "../core/normalize"
import { HttpError, httpJson, httpText } from "./http"
import { recipeKey } from "./recipe"
import type { SourceAdapter, SourceQuery } from "./types"
import { enc, yearOf } from "./types"
import { readCombined } from "./underground"

type ScraperQuery = Pick<SourceQuery, "query" | "artist" | "title"> & { artists?: string[] }

/** {query}, {artist}, {title}, and {artist1}: the first artist alone, for sites that search one name at a time. */
export function fillTemplate(tpl: string, q: ScraperQuery) {
  return tpl
    .replace(/\{query\}/g, enc(q.query))
    .replace(/\{artist\}/g, enc(q.artist))
    .replace(/\{artist1\}/g, enc(q.artists?.[0] ?? q.artist))
    .replace(/\{title\}/g, enc(q.title))
}

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj
  let cur: unknown = obj
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined) return undefined
    cur = Array.isArray(cur) && /^\d+$/.test(key) ? cur[Number(key)] : (cur as Record<string, unknown>)[key]
  }
  return cur
}

function decodeHtml(s: string) {
  return collapseSpaces(cheerio.load(`<p>${s}</p>`)("p").text())
}

type RawHit = { artist?: string; artists?: string[]; title?: string; combined?: string; url?: string; year?: string; label?: string; album?: string; artwork?: string }

function absolute(url: string | undefined, baseUrl: string) {
  if (!url) return undefined
  try {
    return new URL(url, baseUrl).toString()
  } catch {
    return undefined
  }
}

function toCandidate(def: ScraperDefinition, raw: RawHit, baseUrl: string): Candidate | null {
  let artists = raw.artists?.map(decodeHtml).filter(Boolean)
  if (!artists?.length) artists = undefined
  let artist = artists ? artists.join(", ") : raw.artist ? decodeHtml(raw.artist) : ""
  let title = raw.title ? decodeHtml(raw.title) : ""
  if ((!artist || !title) && raw.combined) {
    const read = readCombined(decodeHtml(raw.combined))
    artist ||= read.artist
    artists = read.artists
    title ||= read.title
  }
  artist = artist.replace(/^by\s+/i, "")
  if (!title) return null
  const url = absolute(raw.url, baseUrl)
  return {
    source: `scraper:${def.id}`,
    sourceLabel: def.name,
    artist,
    artists,
    title,
    album: raw.album ? decodeHtml(raw.album) : undefined,
    label: raw.label ? decodeHtml(raw.label) : undefined,
    year: yearOf(raw.year),
    url,
    artwork: absolute(raw.artwork, baseUrl),
  }
}

/** JSON a web page carries inside one of its elements. */
async function embeddedJson(url: string, selector: string, signal?: AbortSignal): Promise<unknown> {
  const { status, body } = await httpText(url, { signal })
  if (status === 404) return null
  const el = cheerio.load(body)(selector).first()
  if (!el.length) throw new HttpError(status, `${new URL(url).host}: nothing on the page matches "${selector}"`)
  try {
    return JSON.parse(el.html() ?? "")
  } catch {
    throw new HttpError(status, `${new URL(url).host}: "${selector}" doesn't hold JSON`)
  }
}

/**
 * A JSON field: a dot path ("title.rendered"), or text with paths in braces
 * ("/events/{slug}") - null when a path in it is missing.
 */
export function jsonField(item: unknown, field: string | undefined): string | undefined {
  if (!field) return undefined
  if (!field.includes("{")) {
    const v = getPath(item, field)
    return v === undefined || v === null || typeof v === "object" ? undefined : String(v)
  }
  let missing = false
  const out = field.replace(/\{([^{}]+)\}/g, (_, path: string) => {
    const v = getPath(item, path.trim())
    if (v === undefined || v === null || v === "" || typeof v === "object") missing = true
    return missing ? "" : String(v)
  })
  return missing ? undefined : out
}

/** A JSON field holding a list of names (a lineup): the names, or null when it's a single value. */
function jsonList(item: unknown, field: string | undefined): string[] | undefined {
  if (!field || field.includes("{")) return undefined
  const v = getPath(item, field)
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" || typeof x === "number").map(String) : undefined
}

export async function runScraper(def: ScraperDefinition, q: ScraperQuery, signal?: AbortSignal): Promise<{ candidates: Candidate[]; itemCount: number }> {
  const url = fillTemplate(def.searchUrl, q)
  const out: Candidate[] = []
  let itemCount = 0
  if (def.kind === "json") {
    const j = def.embedded?.trim() ? await embeddedJson(url, def.embedded.trim(), signal) : await httpJson(url, { signal })
    const items = getPath(j, def.items)
    const list = Array.isArray(items) ? items : []
    itemCount = list.length
    for (const item of list.slice(0, 10)) {
      const pick = (p?: string) => jsonField(item, p)
      const c = toCandidate(
        def,
        { artist: pick(def.fields.artist), artists: jsonList(item, def.fields.artist), title: pick(def.fields.title), combined: pick(def.fields.combined), url: pick(def.fields.url), year: pick(def.fields.year), label: pick(def.fields.label), album: pick(def.fields.album), artwork: pick(def.fields.artwork) },
        url
      )
      if (c) out.push(c)
    }
  } else {
    const { body } = await httpText(url, { signal })
    const $ = cheerio.load(body)
    const items = $(def.items)
    itemCount = items.length
    items.slice(0, 10).each((_, el) => {
      const pick = (sel?: string) => {
        if (!sel) return undefined
        for (const alt of sel.split(",").map((s) => s.trim())) {
          const [css, attr] = alt.split("@")
          const node = css ? $(el).find(css).first() : $(el)
          const v = attr ? node.attr(attr) : node.text()
          if (v && v.trim()) return v.trim()
        }
        return undefined
      }
      const c = toCandidate(
        def,
        { artist: pick(def.fields.artist), title: pick(def.fields.title), combined: pick(def.fields.combined), url: pick(def.fields.url), year: pick(def.fields.year), label: pick(def.fields.label), album: pick(def.fields.album), artwork: pick(def.fields.artwork) },
        url
      )
      if (c) out.push(c)
    })
  }
  return { candidates: out, itemCount }
}

/**
 * What a scraper searches for, in order: the usual query, then just the
 * artists. Site searches mostly want every word to match, so a long title
 * ("Prison Oval Spanish Town (Both Sounds) 21-3-1992") finds nothing where the
 * names alone find the recording.
 */
export function scraperQueries(q: Pick<SourceQuery, "query" | "artist" | "artists" | "descriptiveTitle">): string[] {
  const first = q.descriptiveTitle ? q.artist : q.query
  const names = collapseSpaces(q.artists.join(" "))
  return [...new Set([first, names].map((s) => collapseSpaces(s ?? "")).filter(Boolean))]
}

export function scraperAdapter(def: ScraperDefinition): SourceAdapter {
  return {
    id: `scraper:${def.id}`,
    label: def.name,
    // Lookups are kept per recipe: a fixed search address or selector asks again.
    cacheKey: `scraper:${def.id}@${recipeKey(def)}`,
    unavailable: () => (def.searchUrl.includes("example.com") ? "template - set a real URL first" : null),
    async search(q, { signal }) {
      const asked = new Set<string>()
      for (const query of scraperQueries(q)) {
        // An address without {query} ({artist1}, say) is the same for every try: ask once.
        const url = fillTemplate(def.searchUrl, { ...q, query })
        if (asked.has(url)) continue
        asked.add(url)
        const { candidates } = await runScraper(def, { ...q, query }, signal)
        if (candidates.length) return candidates
      }
      return []
    },
  }
}
