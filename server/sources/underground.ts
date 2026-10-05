// Specialist / underground sources: Bandcamp, Internet Archive, Mixcloud
// and YouTube. These carry the dubplates, specials, clash tapes and pirate
// radio rips the big catalogues never list.

import * as cheerio from "cheerio"
import type { Candidate } from "../../shared/types"
import { parseFilename } from "../core/filename-parser"
import { collapseSpaces } from "../core/normalize"
import { httpJson, httpText } from "./http"
import { enc, yearOf, type SourceAdapter } from "./types"

/** Split a free-form "Artist - Title (Official Video)" string with the filename parser. */
export function readCombined(text: string): { artist: string; artists: string[]; title: string; year?: number; riddim?: string } {
  // A dummy extension stops the parser from treating e.g. "Vol.2" as one.
  const p = parseFilename(`${text}.txt`)
  const artist = p.artists.join(p.relation === "vs" ? " vs " : " & ")
  // "Killamanjaro vs Stone Love 1994": a clash, named by its sounds and the year.
  const title = p.title || (p.relation === "vs" ? "Clash" : "")
  // "Seasons Riddim - Gyptian - Is There A Place": the riddim comes off the name, and stays known.
  return { artist, artists: p.artists, title: title + (p.version && !/^(live|dubplate|special)$/i.test(p.version) ? ` (${p.version})` : ""), year: p.year, ...(p.riddim ? { riddim: p.riddim } : {}) }
}

// ---------- Bandcamp ----------

interface BcAutoResult {
  type: string
  name: string
  band_name?: string
  album_name?: string
  item_url_path?: string
  item_url_root?: string
  id?: number
  img?: string
}

/** Bandcamp image URLs end in a size code; _10 is the 1200px original. */
function bandcampArt(url?: string) {
  return url && /bcbits\.com\/img\//.test(url) ? url.replace(/_\d+\.(jpg|png)$/, "_10.$1") : undefined
}

async function bandcampHtml(query: string, signal?: AbortSignal): Promise<Candidate[]> {
  const { body } = await httpText(`https://bandcamp.com/search?item_type=t&q=${enc(query)}`, { signal })
  const $ = cheerio.load(body)
  const out: Candidate[] = []
  $("li.searchresult").each((_, el) => {
    const item = $(el)
    const title = collapseSpaces(item.find(".heading a").first().text())
    const sub = collapseSpaces(item.find(".subhead").first().text())
    const by = sub.match(/\bby\s+(.+)$/i)?.[1]
    const album = sub.match(/^from\s+(.+?)\s+by\s+/i)?.[1]
    const url = item.find(".itemurl a").first().attr("href") ?? item.find(".heading a").first().attr("href")
    const released = item.find(".released").first().text()
    const art = item.find(".art img").first().attr("src")
    if (title && by) {
      out.push({ source: "bandcamp", sourceLabel: "Bandcamp", artist: by, title, album, year: yearOf(released), url: url?.split("?")[0], artwork: bandcampArt(art) })
    }
  })
  return out.slice(0, 8)
}

export const bandcamp: SourceAdapter = {
  id: "bandcamp",
  label: "Bandcamp",
  unavailable: () => null,
  async search(q, { signal }) {
    const query = q.descriptiveTitle ? q.artist : q.query
    if (!query) return []
    try {
      const j = await httpJson<{ auto?: { results?: BcAutoResult[] } }>("https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ search_text: query, search_filter: "t", full_page: false, fan_id: null }),
        signal,
      })
      const results = (j?.auto?.results ?? []).filter((r) => r.type === "t" && r.band_name)
      if (results.length) {
        return results.slice(0, 8).map((r) => ({
          source: "bandcamp" as const,
          sourceLabel: "Bandcamp",
          artist: r.band_name!,
          title: r.name,
          album: r.album_name,
          url: r.item_url_path ?? r.item_url_root,
          externalId: r.id ? String(r.id) : undefined,
          artwork: bandcampArt(r.img),
        }))
      }
    } catch {
      // the JSON endpoint is unofficial - fall back to the HTML search page
    }
    return bandcampHtml(query, signal)
  },
}

// ---------- Internet Archive ----------

export const archive: SourceAdapter = {
  id: "archive",
  label: "Internet Archive",
  unavailable: () => null,
  async search(q, { signal }) {
    const terms = [q.query, ...q.extraQueries].filter(Boolean)[0]
    if (!terms) return []
    const clean = terms.replace(/["():]/g, " ")
    const iaq = `(${clean}) AND mediatype:(audio OR etree)`
    const fields = ["identifier", "title", "creator", "date"].map((f) => `fl[]=${f}`).join("&")
    const j = await httpJson<{ response?: { docs?: { identifier: string; title?: string; creator?: string | string[]; date?: string }[] } }>(
      `https://archive.org/advancedsearch.php?q=${enc(iaq)}&${fields}&rows=8&output=json`,
      { signal }
    )
    return (j?.response?.docs ?? [])
      .filter((d) => d.title)
      .map((d) => {
        const creator = Array.isArray(d.creator) ? d.creator.join(" & ") : d.creator
        const read = creator ? { artist: creator, title: d.title! } : readCombined(d.title!)
        return {
          source: "archive" as const,
          sourceLabel: "Internet Archive",
          artist: read.artist,
          title: read.title,
          year: yearOf(d.date),
          url: `https://archive.org/details/${d.identifier}`,
          externalId: d.identifier,
        }
      })
  },
}

// ---------- Mixcloud ----------

export const mixcloud: SourceAdapter = {
  id: "mixcloud",
  label: "Mixcloud",
  unavailable: () => null,
  async search(q, { signal }) {
    const query = q.descriptiveTitle ? [q.artist, q.year].filter(Boolean).join(" ") : q.query
    if (!query) return []
    const j = await httpJson<{ data?: { name: string; url: string; audio_length?: number; created_time?: string; key?: string }[] }>(
      `https://api.mixcloud.com/search/?type=cloudcast&limit=8&q=${enc(query)}`,
      { signal }
    )
    return (j?.data ?? []).map((c) => {
      const read = readCombined(c.name)
      return {
        source: "mixcloud" as const,
        sourceLabel: "Mixcloud",
        artist: read.artist,
        artists: read.artists,
        title: read.title,
        riddim: read.riddim,
        duration: c.audio_length,
        year: yearOf(c.created_time),
        url: c.url,
        externalId: c.key,
      }
    })
  },
}

// ---------- YouTube ----------
// Asked the way youtube.com's own search box asks (the "Innertube" API the site itself
// runs on): no Google Cloud project, no API key and no daily quota to run out of.

const INNERTUBE_SEARCH = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false"
const INNERTUBE_CLIENT = { clientName: "WEB", clientVersion: "2.20250925.01.00", hl: "en", gl: "GB" }
/** The search page's "Type: Video" filter. */
const VIDEOS_ONLY = "EgIQAQ=="

interface YtText {
  simpleText?: string
  runs?: { text: string }[]
}

interface YtVideo {
  videoId?: string
  title?: YtText
  ownerText?: YtText
  longBylineText?: YtText
  lengthText?: YtText
  publishedTimeText?: YtText
}

const ytText = (t?: YtText) => (t?.simpleText ?? t?.runs?.map((r) => r.text).join("") ?? "").trim()

/** "1:02:03" or "3:45" as seconds. */
export function ytLength(text: string): number | undefined {
  if (!/^\d+(:\d{1,2}){1,2}$/.test(text)) return undefined
  return text.split(":").reduce((total, part) => total * 60 + Number(part), 0)
}

/** Every video in a search answer, wherever YouTube has nested it this month. */
export function ytVideos(node: unknown, out: YtVideo[] = []): YtVideo[] {
  if (Array.isArray(node)) for (const n of node) ytVideos(n, out)
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "videoRenderer" && v && typeof v === "object" && (v as YtVideo).videoId) out.push(v as YtVideo)
      else ytVideos(v, out)
    }
  }
  return out
}

/** One video as a candidate: "Artist - Topic" channels carry clean catalogue data; other titles are read like a filename. */
export function youtubeCandidate(v: YtVideo): Candidate | null {
  const title = ytText(v.title)
  if (!v.videoId || !title) return null
  const channel = ytText(v.ownerText) || ytText(v.longBylineText)
  const topic = channel.match(/^(.+?) - Topic$/)
  const read: { artist: string; artists: string[]; title: string; riddim?: string } = topic ? { artist: topic[1], artists: [topic[1]], title } : readCombined(title)
  if (!read.artist || !read.title) return null
  return {
    source: "youtube",
    sourceLabel: "YouTube",
    artist: read.artist,
    artists: read.artists,
    title: read.title,
    riddim: read.riddim,
    duration: ytLength(ytText(v.lengthText)),
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
    externalId: v.videoId,
    sourceScore: topic ? 0.9 : undefined,
  }
}

export const youtube: SourceAdapter = {
  id: "youtube",
  label: "YouTube",
  unavailable: () => null,
  async search(q, { signal }) {
    const query = q.descriptiveTitle ? [q.artist, q.title].join(" ") : q.query
    if (!query) return []
    const j = await httpJson<unknown>(INNERTUBE_SEARCH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://www.youtube.com",
        "x-youtube-client-name": "1",
        "x-youtube-client-version": INNERTUBE_CLIENT.clientVersion,
        // Past the cookie-consent page some countries get first.
        cookie: "SOCS=CAI",
      },
      body: JSON.stringify({ context: { client: INNERTUBE_CLIENT }, query, params: VIDEOS_ONLY }),
      signal,
    })
    return ytVideos(j)
      .flatMap((v) => youtubeCandidate(v) ?? [])
      .slice(0, 8)
  },
}

export function undergroundSources(): SourceAdapter[] {
  return [bandcamp, archive, mixcloud, youtube]
}
