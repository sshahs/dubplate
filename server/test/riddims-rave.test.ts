// The riddim databases and the UK rave archives against what their sites
// really answer (trimmed copies of live pages and API replies, October 2026).
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openDb, setDb } from "../db"
import { loadSettings, saveSettings } from "../settings"
import { lookupKey } from "../sources"
import { junglist, junglistTracks, mixesdb, mixesdbHits, raveArchive, raveTapePacks, readEventTitle, readMixTitle, tapePacks, whoPlayed, yearOfDate } from "../sources/rave"
import { readDubCredit, readRiddimPost, reggaeFever, reggaeFeverRows, riddimguide, riddimguideRows, riddimId, riddimIdRows, riddimName, riddimsWorld, riddimsWorldRows } from "../sources/riddims"
import type { SourceAdapter, SourceQuery } from "../sources/types"

const asset = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "assets", "scrapers", name), "utf8")

function mockFetch(reply: (url: string) => string | unknown) {
  const urls: string[] = []
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    urls.push(String(url))
    const body = reply(String(url))
    return new Response(typeof body === "string" ? body : JSON.stringify(body))
  })
  return urls
}

const tune = (artists: string[], title: string, extra: Partial<SourceQuery> = {}): SourceQuery => ({
  artists,
  artist: artists.join(" "),
  title,
  query: `${artists[0] ?? ""} ${title}`.trim(),
  extraQueries: [],
  duration: 200,
  descriptiveTitle: false,
  filePath: "",
  ...extra,
})

const ask = (adapter: SourceAdapter, q: SourceQuery) => adapter.search(q, { cfg: { enabled: true, weight: 0.7 }, settings: loadSettings() })

beforeEach(() => setDb(openDb(":memory:")))
afterEach(() => vi.unstubAllGlobals())

describe("riddim databases", () => {
  it("read a dub credit as the engineer's dub, and a riddim without its numbering", () => {
    expect(readDubCredit("[Dub King Tubby]", "Ring The Alarm")).toEqual({ artist: "King Tubby", title: "Ring The Alarm (Dub)" })
    expect(readDubCredit("[Dub]", "Sleng-Teng A Shack")).toEqual({ artist: "", title: "Sleng-Teng A Shack (Dub)" })
    expect(readDubCredit("[South Rakkas Crew]", "Sleng Teng Ver. 2.1 Riddim")).toEqual({ artist: "South Rakkas Crew", title: "Sleng Teng Ver. 2.1 Riddim" })
    expect(riddimName("Stormy Weather (1)")).toBe("Stormy Weather")
    expect(riddimName("Sleng Teng / Sleng Teng Refuelled")).toBe("Sleng Teng")
    expect(riddimName("Stalag Riddim")).toBe("Stalag")
    expect(riddimName("  ")).toBeUndefined()
  })

  it("Riddimguide: the song search's table, credits and dubs read properly", () => {
    const rows = riddimguideRows(asset("riddimguide-ring-the-alarm.html"))
    expect(rows.map((r) => [r.artist, r.title, r.riddim, r.year, r.label])).toEqual([
      ["King Tubby", "Ring The Alarm (Dub)", "Stormy Weather", undefined, undefined],
      ["Tenor Saw", "Ring The Alarm", "Stalag", 1985, "Techniques"],
      ["Tenor Saw", "Ring The Alarm (Extended Mix)", "Stalag", undefined, "Techniques"],
      ["Tenor Saw & Buju Banton", "Ring The Alarm Quick", "Stalag", undefined, "Techniques"],
      ["Junior Willow Wilson", "Ganja Man", "Sleng Teng", undefined, "World Enterprise"],
      ["Cali P", "Remix", "Sleng Teng", 2009, "Weedy G"],
    ])
    expect(rows[1].url).toBe("https://www.riddimguide.com/tunedb/3733/")
  })

  it("Riddimguide: asks for the song and keeps only the artist's own tunes", async () => {
    const urls = mockFetch(() => asset("riddimguide-ring-the-alarm.html"))
    const hits = await ask(riddimguide, tune(["Tenor Saw"], "Ring The Alarm"))
    expect(urls).toEqual(["https://www.riddimguide.com/tunes?q=Ring%20The%20Alarm&c=song"])
    expect(hits.map((h) => h.title)).toEqual(["Ring The Alarm", "Ring The Alarm (Extended Mix)", "Ring The Alarm Quick"])
    expect(hits[0]).toMatchObject({ source: "riddimguide", artist: "Tenor Saw", riddim: "Stalag", label: "Techniques", year: 1985 })
  })

  it("Riddimguide: a description isn't a song, so there's nothing to ask", async () => {
    const urls = mockFetch(() => "")
    expect(await ask(riddimguide, tune(["Killamanjaro", "Stone Love"], "Live Clash", { descriptiveTitle: true }))).toEqual([])
    expect(urls).toEqual([])
  })

  it("Riddim-ID: its tune search's JSON, the artist's rows only", async () => {
    const rows = riddimIdRows(JSON.parse(asset("riddim-id-ring-the-alarm.json")), "Ring The Alarm")
    expect(rows.map((r) => [r.artist, r.title, r.riddim, r.year, r.label])).toEqual([
      ["Tenor Saw", "Ring The Alarm", "Stalag", 1985, "Techniques"],
      ["Tenor Saw & Buju Banton", "Ring The Alarm Quick", "Stalag", undefined, "Techniques"],
      ["", "Ring The Alarm (Dub)", "Stormy Weather", undefined, undefined],
      ["Denyque", "Ring The Alarm", "Full Speed", 2015, "Dutty Rock"],
    ])
    const urls = mockFetch(() => asset("riddim-id-ring-the-alarm.json"))
    const hits = await ask(riddimId, tune(["Denyque"], "Ring The Alarm"))
    expect(urls).toEqual(["https://riddim-id.com/search/tunes?term=Ring%20The%20Alarm"])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ source: "riddimid", artist: "Denyque", riddim: "Full Speed", label: "Dutty Rock", year: 2015, url: "https://riddim-id.com/search?term=Ring%20The%20Alarm" })
  })

  it("Reggae Fever: both sides of each record, with the record's label, year and pressing", () => {
    const rows = reggaeFeverRows(asset("reggaefever-tenor-saw.html"))
    expect(rows.map((r) => [r.artist, r.title, r.riddim, r.label, r.year, r.country])).toEqual([
      ["Junior Bowens", "Babylon Brutalize", "Hypocrite", "Original International", 1985, "GB"],
      ["Tenor Saw", "House Is Not A Home", undefined, "Original International", 1985, "GB"],
      ["London Dodgers ft Tenor Saw", "Ring The Alarm", undefined, "International Rude Boy", 1999, "GB"],
      ["Tenor Saw", "I Know", "Cuss Cuss", "Night Life Posse", 1986, "GB"],
      ["Tenor Saw", "Lives On", undefined, "Sky High", 1991, "JM"],
      ["Tenor Saw", "Ring The Alarm", "Stalag", "Techniques", 1985, "US"],
      ["Ansell Collins", "Stalag 17", "Stalag", "Techniques", 1985, "US"],
      ["Tenor Saw & Buju Banton", "Ring The Alarm Quick", "Stalag", "Techniques", 1991, "JM"],
    ])
    expect(rows[3].url).toBe("https://www.reggaefever.ch/articleDetails?articleId=D-28880")
  })

  it("Reggae Fever: asks by artist and title, and keeps that tune", async () => {
    const urls = mockFetch(() => asset("reggaefever-tenor-saw.html"))
    const hits = await ask(reggaeFever, tune(["Tenor Saw"], "I Know"))
    expect(urls).toEqual(["https://www.reggaefever.ch/catalog?artist=Tenor%20Saw&title=I%20Know"])
    expect(hits).toEqual([expect.objectContaining({ source: "reggaefever", artist: "Tenor Saw", title: "I Know", riddim: "Cuss Cuss", label: "Night Life Posse", year: 1986, country: "GB" })])
  })

  it("Riddims World: a riddim post's tracklist, label and year", () => {
    expect(readRiddimPost("Stalag Riddim – Various Labels")).toEqual({ riddim: "Stalag", label: undefined, year: undefined })
    expect(readRiddimPost("Stalag Riddim / Pick Up The Pieces Riddim (2020) – Fireball Records")).toEqual({ riddim: "Stalag", label: "Fireball Records", year: 2020 })
    expect(readRiddimPost("Unsolved Mystery Riddim (2014) – Snowhite Production|Kimichi Records")).toEqual({ riddim: "Unsolved Mystery", label: "Snowhite Production", year: 2014 })
    const [various, fireball] = JSON.parse(asset("riddimsworld-stalag.json"))
    expect(riddimsWorldRows(various).map((r) => [r.artist, r.title, r.year])).toEqual([
      ["Ansell Collins", "Stalag 17", 1973],
      ["Sister Nancy", "Bam Bam", 1982],
      ["Tenor Saw", "Fever", 1988],
      ["Tenor Saw", "Ring The Alarm", 1985],
      ["Tenor Saw & Buju Banton", "Ring The Alarm Quick", undefined],
      ["Yellowman & Fathead", "One Yellowman Ina The Yard", 1982],
    ])
    expect(riddimsWorldRows(fireball)[2]).toMatchObject({ artist: "Suga Roy, Conrad Crystal", title: "Me Phone a Ring Off", riddim: "Stalag", label: "Fireball Records", year: 2020 })
  })

  it("Riddims World: only asked to confirm a riddim the reading names", async () => {
    const urls = mockFetch(() => asset("riddimsworld-stalag.json"))
    expect(await ask(riddimsWorld, tune(["Sister Nancy"], "Bam Bam"))).toEqual([])
    expect(urls).toEqual([])
    const hits = await ask(riddimsWorld, tune(["Sister Nancy"], "Bam Bam", { riddim: "Stalag Riddim" }))
    expect(urls).toEqual(["https://riddimsworld.com/wp-json/wp/v2/posts?search=Stalag&per_page=5&_fields=title,link,date,content"])
    expect(hits).toEqual([expect.objectContaining({ source: "riddimsworld", artist: "Sister Nancy", title: "Bam Bam", riddim: "Stalag", year: 1982, url: "https://riddimsworld.com/stalag-riddim-various-labels/" })])
  })

  it("a reading's riddim is part of what a lookup is kept under", () => {
    const q = tune(["Sister Nancy"], "Bam Bam")
    expect(lookupKey("riddimsworld", q)).toBe("riddimsworld::sister nancy::bam bam::::40")
    expect(lookupKey("riddimsworld", { ...q, riddim: "Stalag" })).toBe("riddimsworld::sister nancy::bam bam::::40::riddim:stalag")
  })
})

describe("rave and jungle archives", () => {
  it("knows a DJ or MC however the archive writes them", () => {
    expect(whoPlayed(["Grooverider"], ["Andy C", "Grooverider", "MC Det"])).toEqual(["Grooverider"])
    expect(whoPlayed(["Det"], ["Andy C", "MC Det"])).toEqual(["MC Det"])
    expect(whoPlayed(["DJ Hype"], ["Hype"])).toEqual(["Hype"])
    expect(yearOfDate("26.11.93")).toBe(1993)
    expect(yearOfDate("28–29.8.99")).toBe(1999)
    expect(yearOfDate("3.6.02")).toBe(2002)
    expect(yearOfDate("29.04.1995")).toBe(1995)
  })

  it("Rave Tape Packs: each pack with its year and everyone it's filed under", () => {
    const packs = tapePacks(asset("ravetapepacks-grooverider.html"))
    expect(packs.map((p) => [p.title, p.year, p.url])).toEqual([
      ["The Best Of British - The Jubilee Jam", 2002, "https://www.ravetapepacks.com/?p=2687"],
      ["World Dance - 14th Anniversary Party", 2003, "https://www.ravetapepacks.com/?p=2633"],
    ])
    expect(packs[1].names).toContain("Grooverider")
    expect(packs[1].names).toContain("MC Det")
    expect(packs[1].names).not.toContain("2003")
  })

  it("Rave Tape Packs: a set is the DJ's pack, named as the pack", async () => {
    const urls = mockFetch(() => asset("ravetapepacks-grooverider.html"))
    const hits = await ask(raveTapePacks, tune(["Grooverider"], "World Dance"))
    expect(urls).toEqual(["https://www.ravetapepacks.com/?s=Grooverider%20World%20Dance"])
    expect(hits.map((h) => [h.artist, h.title, h.year])).toEqual([
      ["Grooverider", "The Best Of British - The Jubilee Jam", 2002],
      ["Grooverider", "World Dance - 14th Anniversary Party", 2003],
    ])
    // The event's own name isn't someone who played it.
    expect(await ask(raveTapePacks, tune(["World Dance"], "2003"))).toEqual([])
  })

  it("Rave Archive UK: a night counts only when the DJ is named on it", async () => {
    expect(readEventTitle("Dreamscape 7 ‘Back to our Roots’ – The Sanctuary – 26.11.93")).toEqual({ event: "Dreamscape 7 ‘Back to our Roots’", venue: "The Sanctuary", year: 1993 })
    expect(readEventTitle("Creamfields 1999 — Liverpool Airfield — 28–29.8.99")).toEqual({ event: "Creamfields 1999", venue: "Liverpool Airfield", year: 1999 })
    const urls = mockFetch(() => asset("rave-archive-grooverider.json"))
    const hits = await ask(raveArchive, tune(["Grooverider"], "Dreamscape 7"))
    expect(urls).toEqual(["https://rave-archive.com/wp-json/wp/v2/posts?search=Grooverider%20Dreamscape%207&per_page=8&_fields=title,link,excerpt,content"])
    expect(hits).toEqual([
      expect.objectContaining({
        source: "ravearchive",
        artist: "Grooverider",
        title: "Dreamscape 7 ‘Back to our Roots’",
        album: "Dreamscape 7 ‘Back to our Roots’ - The Sanctuary",
        year: 1993,
        url: "https://rave-archive.com/dreamscape-7-back-to-our-roots-the-sanctuary-26-11-93/",
      }),
    ])
  })

  it("MixesDB: who played, which show and when - their own sets, not mixes that played their tunes", async () => {
    expect(readMixTitle("2009-11-13 - Rob Da Bank, Shut Up And Dance - Annie On One")).toEqual({ artists: ["Rob Da Bank", "Shut Up And Dance"], show: "Annie On One", year: 2009 })
    expect(readMixTitle("2008-11-29 - Shut Up And Dance @ MS Connexion, Mannheim")).toEqual({ artists: ["Shut Up And Dance"], show: "MS Connexion, Mannheim", year: 2008 })
    expect(readMixTitle("2017-06-03 - OR:LA @ Boiler Room x AVA Festival")).toEqual({ artists: ["OR:LA"], show: "Boiler Room x AVA Festival", year: 2017 })
    expect(readMixTitle("Shut Up And Dance discography")).toBeNull()
    const hits = mixesdbHits(JSON.parse(asset("mixesdb-shut-up-and-dance.json")), ["Shut Up And Dance"])
    expect(hits.map((h) => [h.artist, h.title, h.year])).toEqual([
      ["Rob Da Bank, Shut Up And Dance", "Annie On One", 2009],
      ["Shut Up And Dance", "MS Connexion, Mannheim", 2008],
      ["Carl Cox, Shut Up And Dance", "Global", 2007],
    ])
    expect(hits[1].url).toBe("https://www.mixesdb.com/w/2008-11-29_-_Shut_Up_And_Dance_%40_MS_Connexion%2C_Mannheim")
    const urls = mockFetch(() => asset("mixesdb-shut-up-and-dance.json"))
    expect(await ask(mixesdb, tune(["Grooverider"], "Drum'N'Bass Show"))).toEqual([expect.objectContaining({ source: "mixesdb", artist: "Grooverider", title: "Drum'N'Bass Show", year: 2007 })])
    expect(urls[0]).toBe("https://www.mixesdb.com/w/api.php?action=query&list=search&srsearch=Grooverider%20Drum'N'Bass%20Show&srlimit=20&format=json")
  })

  it("junglist.co.uk: the tracks its search finds, the right one kept", async () => {
    expect(junglistTracks(asset("junglist-valley.html"))).toEqual([
      { artist: "Origin Unknown", title: "Valley of the Shadows", url: "https://junglist.co.uk/tracks/origin-unknown-valley-of-the-shadows" },
      { artist: "Origin Unkown", title: "Valley of the Shadows (Awake 96 Remix)", url: "https://junglist.co.uk/tracks/origin-unkown-valley-of-the-shadows-awake-96-remix" },
    ])
    expect(junglistTracks('<a class="block" href="/tracks/zen-months009-september-b"><h3>September (B)</h3><p>Zen (MONTHS009)</p></a>')[0].artist).toBe("Zen")
    const urls = mockFetch(() => asset("junglist-valley.html"))
    const hits = await ask(junglist, tune(["Origin Unknown"], "Valley Of The Shadows"))
    expect(urls).toEqual(["https://junglist.co.uk/tracks?search=Valley%20Of%20The%20Shadows"])
    expect(hits.map((h) => [h.artist, h.title])).toEqual([
      ["Origin Unknown", "Valley of the Shadows"],
      ["Origin Unkown", "Valley of the Shadows (Awake 96 Remix)"],
    ])
  })
})

describe("the new sources are on", () => {
  it("for installs that saved their sources before they existed", () => {
    saveSettings({ sources: { mixcloud: { enabled: false, weight: 0.45 } } })
    const s = loadSettings().sources
    for (const id of ["riddimguide", "riddimid", "reggaefever", "riddimsworld", "ravetapepacks", "ravearchive", "mixesdb", "junglist"]) expect(s[id]).toMatchObject({ enabled: true })
  })
})
