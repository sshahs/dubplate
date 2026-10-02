// Custom scrapers against what their sites really answer (trimmed copies of
// live pages and API replies, October 2026), saved presets brought up to date,
// and scrapers switched on mid-run counting from the next track.
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ScraperDefinition } from "../../shared/types"
import { openDb, setDb } from "../db"
import { activeJobs, enqueueJob, resetJobStateForTests } from "../jobs"
import { liveSources } from "../pipeline"
import { loadSettings, SCRAPER_PRESETS, SCRAPER_REVISION, saveSettings } from "../settings"
import { scourTrack } from "../sources"
import { runScraper, scraperAdapter, scraperQueries } from "../sources/scraper"
import type { SourceQuery } from "../sources/types"
import type { Track } from "../../shared/types"

const asset = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "assets", "scrapers", name), "utf8")
const preset = (id: string) => structuredClone(SCRAPER_PRESETS.find((p) => p.id === id)!)

/** Answers every request with `reply(url)`, and records the URLs asked. */
function mockFetch(reply: (url: string) => string | unknown, status = 200) {
  const urls: string[] = []
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    urls.push(String(url))
    const body = reply(String(url))
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  })
  return urls
}

beforeEach(() => setDb(openDb(":memory:")))
afterEach(() => {
  vi.unstubAllGlobals()
  resetJobStateForTests()
})

const query = (q: string) => ({ query: q, artist: q, title: q })

describe("the presets read their sites' real answers", () => {
  it("Hype Machine: the tracks a logged-out page carries as JSON", async () => {
    const urls = mockFetch(() => asset("hypem.html"))
    const r = await runScraper(preset("hypem"), query("buju banton"))
    expect(urls[0]).toBe("https://hypem.com/search/buju%20banton/1/")
    expect(r.itemCount).toBe(3)
    expect(r.candidates[0]).toMatchObject({ artist: "Buju Banton", title: "Steppa", url: "https://www.musiclikedirt.com/2020/01/16/top-200-tracks-of-2019-51-100/", source: "scraper:hypem" })
    expect(r.candidates[1]).toMatchObject({ artist: "Wayne Wonder & Buju Banton", title: "Bonafide Love" })
  })

  it("says so when the page has no JSON where the scraper looks", async () => {
    mockFetch(() => "<html><body>Log in to view 33 matching tracks.</body></html>")
    await expect(runScraper(preset("hypem"), query("buju banton"))).rejects.toThrow(/nothing on the page matches "script#displayList-data"/)
  })

  it("Grime Archive: its real search address and table rows", async () => {
    const urls = mockFetch(() => asset("grime-archive.html"))
    const r = await runScraper(preset("grime-archive"), query("wiley"))
    expect(urls[0]).toBe("https://www.grimearchive.org/search?title=wiley")
    expect(r.itemCount).toBe(2)
    // "Unknown DJ" isn't a name: the first MC stands in.
    expect(r.candidates[0]).toMatchObject({ title: "Sidewinder Awards Dizzie B2B Wiley", artist: "Dizzee Rascal", year: 2002, url: "https://www.grimearchive.org/mix/4537731" })
    expect(r.candidates[1]).toMatchObject({ title: "Kode9 & Wiley", artist: "Kode9", year: 2006 })
  })

  it("Traxsource: track rows from the store's search", async () => {
    mockFetch(() => asset("traxsource.html"))
    const r = await runScraper(preset("traxsource"), query("masters at work"))
    expect(r.candidates[0]).toMatchObject({ title: "Nightmovin' Track", artist: "Masters At Work", label: "MAW Records", year: 2026, url: "https://www.traxsource.com/track/14894682/nightmovin-track-original-mix" })
    expect(r.candidates).toHaveLength(2)
  })

  it("Regime Radio and BritishHipHop: WordPress post titles", async () => {
    mockFetch(() => [
      { date: "2026-09-04T09:47:11", link: "https://regimeradio.com/2026/09/04/stone-love-champion-sound-vol-2/", title: { rendered: "STONE LOVE CHAMPION SOUND &#8211; VOL.2" } },
    ])
    expect((await runScraper(preset("regime-radio"), query("stone love"))).candidates[0]).toMatchObject({ artist: "Stone Love Champion Sound", title: "VOL.2", year: 2026 })
    mockFetch(() => [
      { date: "2026-03-28T20:28:53", link: "https://www.britishhiphop.co.uk/downloads/audio/charlie-sloth-ft-skinnyman-and-rodney-p-hip-hop-audio.html", title: { rendered: "Charlie Sloth ft. Skinnyman and Rodney P - Hip Hop [Audio]" } },
    ])
    expect((await runScraper(preset("britishhiphop"), query("skinnyman"))).candidates[0]).toMatchObject({ artist: "Charlie Sloth", title: expect.stringMatching(/^Hip Hop/) })
  })

  it("Genius and Audius: their search APIs", async () => {
    mockFetch(() => ({
      meta: { status: 200 },
      response: { sections: [{ type: "song", hits: [{ type: "song", result: { title: "Murderer", url: "https://genius.com/Buju-banton-murderer-lyrics", release_date_components: { year: 1995, month: 7, day: 18 }, primary_artist: { name: "Buju Banton" }, song_art_image_url: "https://images.genius.com/x.png" } }] }] },
    }))
    expect((await runScraper(preset("genius"), query("buju banton murderer"))).candidates[0]).toMatchObject({ artist: "Buju Banton", title: "Murderer", year: 1995, url: "https://genius.com/Buju-banton-murderer-lyrics" })
    mockFetch(() => ({ data: [{ title: "Love Dem Bad", release_date: "2022-06-09T16:46:55Z", user: { name: "Dj Zent" }, artwork: { "480x480": "https://audius.example/480x480.jpg" } }] }))
    expect((await runScraper(preset("audius"), query("buju banton"))).candidates[0]).toMatchObject({ artist: "Dj Zent", title: "Love Dem Bad", year: 2022, artwork: "https://audius.example/480x480.jpg" })
  })

  it("only ships presets that answered when checked, plus the untested Juno and the template", () => {
    const ids = SCRAPER_PRESETS.map((p) => p.id)
    for (const gone of ["allmusic", "reggaerecord", "grm-daily", "soundclash-hub"]) expect(ids).not.toContain(gone)
    expect(SCRAPER_PRESETS.filter((p) => !p.verified).map((p) => p.id)).toEqual(["juno", "wordpress-template"])
  })
})

describe("searching", () => {
  const q: SourceQuery = {
    artists: ["Killamanjaro", "Stone Love"],
    artist: "Killamanjaro Stone Love",
    title: "Prison Oval Spanish Town Ja- (Both Sounds) Charlie Chaplin-Wick 21-3-1992",
    query: "Killamanjaro Prison Oval Spanish Town Ja- (Both Sounds) Charlie Chaplin-Wick 21-3-1992",
    extraQueries: [],
    duration: 2700,
    year: 1992,
    descriptiveTitle: false,
    filePath: "",
  }

  it("asks again with just the names when the full title finds nothing", async () => {
    expect(scraperQueries(q)).toEqual([q.query, "Killamanjaro Stone Love"])
    expect(scraperQueries({ ...q, descriptiveTitle: true })).toEqual(["Killamanjaro Stone Love"])
    const urls = mockFetch((url) =>
      url.includes("Prison") ? [] : [{ title: { rendered: "Killamanjaro vs Stone Love &#8211; Prison Oval 1992" }, link: "https://regimeradio.com/k-v-s", date: "2026-01-01" }]
    )
    const hits = await scraperAdapter(preset("regime-radio")).search(q, { cfg: { enabled: true, weight: 0.45 }, settings: loadSettings() })
    expect(urls).toHaveLength(2)
    expect(hits[0]).toMatchObject({ title: expect.stringContaining("Prison Oval"), source: "scraper:regime-radio" })
  })

  it("keeps lookups per recipe, so a fixed scraper asks again", async () => {
    const before = preset("grime-archive")
    const after = { ...before, items: "tr.mix" }
    expect(scraperAdapter(before).cacheKey).not.toBe(scraperAdapter(after).cacheKey)

    const s = loadSettings()
    for (const k of Object.keys(s.sources)) s.sources[k].enabled = false
    s.scrapers = [{ ...before, enabled: true }]
    const track = { id: 1, path: "/x.mp3", duration: 3000, filename: "x.mp3" } as Track
    const reading = { artists: ["Wiley"], featuring: [], title: "Rinse FM 2005" }
    let calls = 0
    vi.stubGlobal("fetch", async () => (calls++, new Response(asset("grime-archive.html"))))
    expect((await scourTrack(track, reading, s, [])).candidates).toHaveLength(2)
    await scourTrack(track, reading, s, [])
    expect(calls).toBe(1)
    s.scrapers = [{ ...after, items: "tr.mix-row", fields: { ...after.fields, year: ".td-date, .td-uploaded" }, enabled: true }]
    await scourTrack(track, reading, s, [])
    expect(calls).toBe(1) // same page from the HTTP cache, but read afresh: no stale "nothing found"
  })
})

/** The presets as they shipped before October 2026. */
const OLD_GRIME_ARCHIVE: ScraperDefinition = {
  id: "grime-archive",
  name: "Grime Archive",
  enabled: false,
  weight: 0.5,
  kind: "html",
  searchUrl: "https://grimearchive.org/search?q={query}",
  items: ".mix, .result, li",
  fields: { combined: ".title, a", url: "a@href", year: ".date" },
  scene: "Grime radio sets and mixes (Rinse, Deja Vu, Kiss…)",
  notes: "Untested: a guess at the search address.",
  verified: false,
  genres: ["Grime", "Radio rips"],
}
const OLD_ALLMUSIC: ScraperDefinition = {
  id: "allmusic",
  name: "AllMusic",
  enabled: true,
  weight: 0.7,
  kind: "html",
  searchUrl: "https://www.allmusic.com/search/songs/{query}",
  items: ".song",
  fields: { title: ".title a", artist: ".performers a", url: ".title a@href" },
  scene: "Jazz, soul, blues, rock and classical",
  verified: false,
}

describe("saved presets", () => {
  const store = (scrapers: ScraperDefinition[]) => saveSettings({ scrapers, scraperRevision: 0 })

  it("are brought up to date when nobody edited them, keeping the owner's choices", () => {
    store([
      { ...OLD_GRIME_ARCHIVE, weight: 0.65, enabled: false, disabledReason: "Switched off by the health check: grimearchive.org replied 503 (5 times in a row)" },
      { ...OLD_ALLMUSIC },
      // Edited by hand: theirs to keep.
      { ...OLD_GRIME_ARCHIVE, id: "my-grime", name: "My grime", searchUrl: "https://grime.example/?s={query}", enabled: true },
      { ...preset("genius"), enabled: true },
    ])
    const s = loadSettings()
    const grime = s.scrapers.find((x) => x.id === "grime-archive")!
    expect(grime).toMatchObject({ searchUrl: "https://www.grimearchive.org/search?title={query}", items: "tr.mix-row", verified: true, weight: 0.65, enabled: false })
    expect(grime.disabledReason).toMatch(/fixed in an update/)
    expect(s.scrapers.find((x) => x.id === "allmusic")).toMatchObject({ enabled: false, disabledReason: expect.stringContaining("403") })
    expect(s.scrapers.find((x) => x.id === "my-grime")).toMatchObject({ searchUrl: "https://grime.example/?s={query}", enabled: true })
    expect(s.scrapers.find((x) => x.id === "genius")).toMatchObject({ enabled: true, verified: true })
    expect(s.scraperRevision).toBe(SCRAPER_REVISION)
  })

  it("once: switched back on by hand, a retired preset stays on", () => {
    store([{ ...OLD_ALLMUSIC }])
    const s = loadSettings()
    saveSettings({ scrapers: s.scrapers.map((x) => (x.id === "allmusic" ? { ...x, enabled: true } : x)) })
    expect(loadSettings().scrapers.find((x) => x.id === "allmusic")).toMatchObject({ enabled: true })
    expect(loadSettings().scrapers.find((x) => x.id === "allmusic")?.disabledReason).toBeUndefined()
  })

  it("a new install doesn't get the retired ones at all", () => {
    expect(loadSettings().scrapers.map((s) => s.id)).not.toContain("allmusic")
  })
})

describe("changing sources during a run", () => {
  it("counts a scraper switched on mid-run from the next track", () => {
    const start = loadSettings()
    const said: string[][] = []
    const now = liveSources(start, (names) => said.push(names))
    expect(now()).toBe(start)
    saveSettings({ scrapers: start.scrapers.map((x) => (x.id === "grime-archive" ? { ...x, enabled: true } : x)) })
    expect(now().scrapers.find((x) => x.id === "grime-archive")?.enabled).toBe(true)
    expect(said).toEqual([["Grime Archive"]])
    // Everything else stays as the run started.
    expect(now().llm).toBe(start.llm)
  })

  it("runs a small job alongside a long one instead of behind it", async () => {
    let finishBig!: () => void
    const big = new Promise<void>((r) => (finishBig = r))
    enqueueJob("process", "Identify 1985 tracks", () => big)
    enqueueJob("process", "Identify 1950 tracks", async () => {})
    let reran = false
    const small = enqueueJob("process", "Re-run 1 track", async () => void (reran = true), { quick: true })
    await vi.waitFor(() => expect(reran).toBe(true))
    expect(small.status).toBe("done")
    // The second big run still waits its turn behind the first.
    expect(activeJobs().map((j) => [j.label, j.status])).toEqual([
      ["Identify 1985 tracks", "running"],
      ["Identify 1950 tracks", "queued"],
    ])
    finishBig()
    await vi.waitFor(() => expect(activeJobs()).toHaveLength(0))
  })
})
