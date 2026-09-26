// User-defined scrapers for specialist sites. Two flavours:
//  - html: CSS selectors over a search results page
//  - json: dot-paths over a JSON search API (e.g. WordPress /wp-json)

import * as cheerio from "cheerio"
import type { Candidate, ScraperDefinition } from "../../shared/types"
import { collapseSpaces } from "../core/normalize"
import { httpJson, httpText } from "./http"
import type { SourceAdapter, SourceQuery } from "./types"
import { enc, yearOf } from "./types"
import { readCombined } from "./underground"

export function fillTemplate(tpl: string, q: Pick<SourceQuery, "query" | "artist" | "title">) {
  return tpl.replace(/\{query\}/g, enc(q.query)).replace(/\{artist\}/g, enc(q.artist)).replace(/\{title\}/g, enc(q.title))
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

function toCandidate(def: ScraperDefinition, raw: { artist?: string; title?: string; combined?: string; url?: string; year?: string; label?: string; album?: string }, baseUrl: string): Candidate | null {
  let artist = raw.artist ? decodeHtml(raw.artist) : ""
  let title = raw.title ? decodeHtml(raw.title) : ""
  let artists: string[] | undefined
  if ((!artist || !title) && raw.combined) {
    const read = readCombined(decodeHtml(raw.combined))
    artist ||= read.artist
    artists = read.artists
    title ||= read.title
  }
  artist = artist.replace(/^by\s+/i, "")
  if (!title) return null
  let url = raw.url
  if (url) {
    try {
      url = new URL(url, baseUrl).toString()
    } catch {
      url = undefined
    }
  }
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
  }
}

export async function runScraper(def: ScraperDefinition, q: Pick<SourceQuery, "query" | "artist" | "title">, signal?: AbortSignal): Promise<{ candidates: Candidate[]; itemCount: number }> {
  const url = fillTemplate(def.searchUrl, q)
  const out: Candidate[] = []
  let itemCount = 0
  if (def.kind === "json") {
    const j = await httpJson(url, { signal })
    const items = getPath(j, def.items)
    const list = Array.isArray(items) ? items : []
    itemCount = list.length
    for (const item of list.slice(0, 10)) {
      const pick = (p?: string) => {
        if (!p) return undefined
        const v = getPath(item, p)
        return v === undefined || v === null ? undefined : String(v)
      }
      const c = toCandidate(
        def,
        { artist: pick(def.fields.artist), title: pick(def.fields.title), combined: pick(def.fields.combined), url: pick(def.fields.url), year: pick(def.fields.year), label: pick(def.fields.label), album: pick(def.fields.album) },
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
        { artist: pick(def.fields.artist), title: pick(def.fields.title), combined: pick(def.fields.combined), url: pick(def.fields.url), year: pick(def.fields.year), label: pick(def.fields.label), album: pick(def.fields.album) },
        url
      )
      if (c) out.push(c)
    })
  }
  return { candidates: out, itemCount }
}

export function scraperAdapter(def: ScraperDefinition): SourceAdapter {
  return {
    id: `scraper:${def.id}`,
    label: def.name,
    unavailable: () => (def.searchUrl.includes("example.com") ? "template — set a real URL first" : null),
    async search(q, { signal }) {
      const query = q.descriptiveTitle ? q.artist : q.query
      if (!query) return []
      return (await runScraper(def, { ...q, query }, signal)).candidates
    },
  }
}
