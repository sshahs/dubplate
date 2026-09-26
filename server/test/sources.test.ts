import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { extractJson } from "../ai/providers"
import { sanitizeAi, similarCorrections } from "../ai/interpreter"
import { openDb, setDb } from "../db"
import { runScraper } from "../sources/scraper"
import { readCombined } from "../sources/underground"
import { musicbrainz } from "../sources/catalog"
import type { ScraperDefinition } from "../../shared/types"
import { DEFAULT_SETTINGS } from "../settings"

const provider = { id: "t", kind: "ollama" as const, label: "Test", baseUrl: "", model: "m", enabled: true }

beforeEach(() => setDb(openDb(":memory:")))
afterEach(() => vi.unstubAllGlobals())

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }))
  vi.stubGlobal("fetch", fn)
  return fn
}

describe("AI reply handling", () => {
  it("extracts JSON from fenced or chatty replies and thinking blocks", () => {
    expect(extractJson('<think>hmm</think>```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('Sure! Here you go: {"title":"Murderer","x":{"y":"}"}} hope that helps')).toEqual({ title: "Murderer", x: { y: "}" } })
  })

  it("coerces sloppy model output and applies aliases", () => {
    const ai = sanitizeAi(
      { artists: ["buju", " Beenie Man "], title: " Murderer ", confidence: 87, year: "1993", relation: "VS", alternatives: [{ artists: ["Buju Banton"], title: "" }, {}] },
      provider,
      new Map([["buju", "Buju Banton"]])
    )
    expect(ai.artists).toEqual(["Buju Banton", "Beenie Man"])
    expect(ai.title).toBe("Murderer")
    expect(ai.confidence).toBeCloseTo(0.87)
    expect(ai.year).toBe(1993)
    expect(ai.relation).toBeUndefined()
    expect(ai.alternatives).toHaveLength(1)
  })

  it("picks corrections that share words with the filename", () => {
    const picked = similarCorrections("05_sizzla_praise_ye_jah.mp3", [
      { id: 1, filename: "sizzla - black woman and child.mp3", artists: ["Sizzla"], title: "Black Woman & Child", version: null, createdAt: "" },
      { id: 2, filename: "skepta - shutdown.mp3", artists: ["Skepta"], title: "Shutdown", version: null, createdAt: "" },
    ])
    expect(picked.map((c) => c.id)).toEqual([1])
  })
})

describe("source adapters", () => {
  it("maps MusicBrainz recordings to candidates", async () => {
    const fetch = mockFetch({
      recordings: [
        { id: "abc", score: 100, title: "Murderer", length: 215000, "first-release-date": "1993-05-01", "artist-credit": [{ name: "Buju Banton" }], releases: [{ title: "Voice of Jamaica" }] },
      ],
    })
    const out = await musicbrainz.search(
      { artists: ["Buju Banton"], artist: "Buju Banton", title: "Murderer", query: "Buju Banton Murderer", extraQueries: [], duration: null, descriptiveTitle: false, filePath: "" },
      { cfg: { enabled: true, weight: 1 }, settings: DEFAULT_SETTINGS }
    )
    expect(String(fetch.mock.calls[0][0])).toContain("recording%3A%22Murderer%22")
    expect(out[0]).toMatchObject({ artist: "Buju Banton", title: "Murderer", year: 1993, duration: 215, album: "Voice of Jamaica", sourceScore: 1 })
  })

  it("runs a JSON (WordPress-style) scraper and decodes entities", async () => {
    mockFetch([{ title: { rendered: "Stone Love &#8211; Clash 1995" }, link: "/stone-love", date: "1995-06-01T00:00:00" }])
    const def: ScraperDefinition = {
      id: "wp",
      name: "WP",
      enabled: true,
      weight: 0.5,
      kind: "json",
      searchUrl: "https://blog.example/wp-json/wp/v2/posts?search={query}",
      items: "",
      fields: { combined: "title.rendered", url: "link", year: "date" },
      scene: "",
    }
    const r = await runScraper(def, { query: "stone love", artist: "", title: "" })
    expect(r.itemCount).toBe(1)
    expect(r.candidates[0]).toMatchObject({ artist: "Stone Love", source: "scraper:wp", url: "https://blog.example/stone-love", year: 1995 })
  })

  it("runs an HTML scraper with selector@attr fields", async () => {
    mockFetch(`<ul><li class="r"><a class="t" href="/t/1">Ring the Alarm</a><span class="a">Tenor Saw</span></li></ul>`)
    const def: ScraperDefinition = {
      id: "html",
      name: "HTML",
      enabled: true,
      weight: 0.5,
      kind: "html",
      searchUrl: "https://shop.example/search?q={query}",
      items: "li.r",
      fields: { title: "a.t", artist: ".a", url: "a.t@href" },
      scene: "",
    }
    const r = await runScraper(def, { query: "tenor saw", artist: "", title: "" })
    expect(r.candidates[0]).toMatchObject({ artist: "Tenor Saw", title: "Ring the Alarm", url: "https://shop.example/t/1" })
  })

  it("reads 'Artist - Title (Official Video)' upload titles", () => {
    expect(readCombined("Kano - P's and Q's (Official Video)")).toMatchObject({ artist: "Kano", title: "P's and Q's" })
  })
})
