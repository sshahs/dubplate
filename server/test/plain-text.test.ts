// No web page markup in any field: what sources send, what the AI says, what's typed, and what's already stored.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Candidate, Settings } from "../../shared/types"
import { sanitizeAi } from "../ai/interpreter"
import { createApp } from "../app"
import { tagsFor } from "../core/naming"
import { cleanCandidate, cleanFinal, hasMarkup, plainText } from "../core/plain-text"
import { openDb, setDb } from "../db"
import { resetJobStateForTests, type JobContext } from "../jobs"
import { repairMarkup, tracksWithMarkup } from "../pipeline"
import * as repo from "../repo"
import { scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS } from "../settings"
import { scourTrack } from "../sources"
import { riddimId, riddimIdRows } from "../sources/riddims"
import { writeMp3 } from "./fixtures"

// As Riddim-ID's search sends it: every artist, label and riddim is a link to its page.
const RIDDIM_ID_LIVE = {
  data: [
    {
      id: 30211,
      title: "Rude Bwoy (Dreadlocks No Rudeboy)",
      year: 1980,
      relArtists: ' <a href="/artists/271/linval-thompson">Linval Thompson</a>',
      relRiddims: '<a href="/riddims/1182/shank-i-sheck">Shank I Sheck</a>',
      relLabels: '<a href="/labels/59/thompson-sound">Thompson Sound</a>',
    },
    {
      id: 30212,
      title: "Rude Bwoy",
      year: 1980,
      relArtists: ' [<a href="/artists/9/dub">Dub</a>]',
      relRiddims: '<a href="/riddims/1182/shank-i-sheck">Shank I Sheck</a>',
      relLabels: "",
    },
    {
      id: 2060,
      title: "Ring The Alarm Quick",
      year: null,
      relArtists: ' <a href="/artists/1/tenor-saw">Tenor Saw</a> &amp; <a href="/artists/2/buju-banton">Buju Banton</a>',
      relRiddims: '<a href="/riddims/7/stalag">Stalag</a>',
      relLabels: '<a href="/labels/3/techniques">Techniques</a>',
    },
  ],
}

describe("plain text", () => {
  it("takes the tags out and turns entities back into characters", () => {
    expect(plainText('<a href="/artists/271/linval-thompson">Linval Thompson</a>')).toBe("Linval Thompson")
    expect(plainText("Sly &amp; Robbie")).toBe("Sly & Robbie")
    expect(plainText("Dreadlocks &#8211; Dub &#x2014; Version")).toBe("Dreadlocks – Dub — Version")
    expect(plainText("Dennis Brown &quot;Crown Prince&quot; &nbsp; Live")).toBe('Dennis Brown "Crown Prince" Live')
    expect(plainText("<td>Stalag</td><td>Techniques</td>")).toBe("Stalag Techniques")
    expect(plainText("Linval <b>Thom</b>pson")).toBe("Linval Thompson")
    expect(plainText('<span class="x">King</span> <i>Tubby</i><br/>')).toBe("King Tubby")
    expect(plainText("Tubby<script>alert(1)</script>")).toBe("Tubby")
    // escaped once on the way, still markup
    expect(plainText("&lt;a href=&quot;/x&quot;&gt;Big Youth&lt;/a&gt;")).toBe("Big Youth")
  })

  it("leaves text that only looks a little like markup alone", () => {
    for (const s of ["Rude Boy <Remix>", "I <3 Dub", "Tom & Jerry", "AT&T Riddim", "Track &#1", "Fish & Chips;", "a < b > c", "Sound System 7\""]) {
      expect(plainText(s)).toBe(s)
      expect(hasMarkup(s)).toBe(false)
    }
    expect(hasMarkup("<a href='/labels/5'>Studio One</a>")).toBe(true)
    expect(hasMarkup("Sly &amp; Robbie")).toBe(true)
  })

  it("cleans every field of a hit a person sees, and keeps the same object when there's nothing to do", () => {
    const dirty: Candidate = {
      source: "riddimid",
      sourceLabel: "Riddim-ID",
      artist: "<a href='/a'>Linval Thompson</a>",
      artists: ["<a href='/a'>Linval Thompson</a>"],
      title: "Rude Bwoy &amp; Dub",
      label: "<a href='/labels/5'>Thompson Sound</a>",
      riddim: "<a>Shank I Sheck</a>",
      genres: ["Roots &amp; Culture"],
      releases: [{ source: "musicbrainz", title: "Rude Bwoy &amp; Dub", kind: "single", own: true }],
      url: "https://riddim-id.com/search?term=a&amp;b",
    }
    const c = cleanCandidate(dirty)
    expect([c.artist, c.artists, c.title, c.label, c.riddim, c.genres, c.releases?.[0].title]).toEqual([
      "Linval Thompson",
      ["Linval Thompson"],
      "Rude Bwoy & Dub",
      "Thompson Sound",
      "Shank I Sheck",
      ["Roots & Culture"],
      "Rude Bwoy & Dub",
    ])
    // links are links: left as they came
    expect(c.url).toBe(dirty.url)
    const clean: Candidate = { source: "deezer", sourceLabel: "Deezer", artist: "Tenor Saw", title: "Ring The Alarm" }
    expect(cleanCandidate(clean)).toBe(clean)
    expect(cleanFinal({ artists: ["<b>Big Youth</b>"], featuring: [], title: "S.90 Skank", label: "&lt;i&gt;Gussie&lt;/i&gt;" })).toMatchObject({ artists: ["Big Youth"], label: "Gussie" })
  })
})

describe("no markup gets in", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-plain-"))
    setDb(openDb(":memory:"))
    resetJobStateForTests()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("reads Riddim-ID's linked names as plain names", async () => {
    const rows = riddimIdRows(RIDDIM_ID_LIVE, "Rude Bwoy")
    expect(rows.map((r) => [r.artist, r.title, r.riddim, r.label])).toEqual([
      ["Linval Thompson", "Rude Bwoy (Dreadlocks No Rudeboy)", "Shank I Sheck", "Thompson Sound"],
      // a dub with no one credited
      ["", "Rude Bwoy (Dub)", "Shank I Sheck", undefined],
      ["Tenor Saw & Buju Banton", "Ring The Alarm Quick", "Stalag", "Techniques"],
    ])
    expect(rows.every((r) => !/[<>]/.test(`${r.artist}${r.title}${r.riddim ?? ""}${r.label ?? ""}`))).toBe(true)
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(RIDDIM_ID_LIVE))))
    const q = { artist: "Linval Thompson", artists: ["Linval Thompson"], featuring: [], title: "Rude Bwoy (Dreadlocks No Rudeboy)", query: "Linval Thompson Rude Bwoy", extraQueries: [] }
    const hits = await riddimId.search(q as never, { cfg: { enabled: true, weight: 1 }, settings: DEFAULT_SETTINGS, signal: new AbortController().signal })
    expect(hits[0]).toMatchObject({ artist: "Linval Thompson", label: "Thompson Sound", riddim: "Shank I Sheck" })
  })

  it("cleans whatever any source sends, and what was remembered from before", async () => {
    // A scraper preset that hands back a link as the artist, and an "&amp;" in the title.
    const settings: Settings = structuredClone({
      ...DEFAULT_SETTINGS,
      sources: Object.fromEntries(Object.entries(DEFAULT_SETTINGS.sources).map(([id, c]) => [id, { ...c, enabled: id === "deezer" }])),
      scrapers: [],
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [{ title: "Ring The Alarm &amp; Dub", duration: 200, artist: { name: '<a href="/a/1">Tenor Saw</a>' }, album: { title: "<i>Fever</i>" } }] })))
    )
    writeMp3(path.join(dir, "Tenor Saw - Ring The Alarm.mp3"))
    const lib = repo.addLibrary(dir, "Crate")
    const ctx = { log: () => {}, signal: new AbortController().signal, setTotal: () => {}, tick: () => {}, message: () => {}, tracksChanged: () => {}, filesChanged: () => {}, report: () => {}, job: {} } as unknown as JobContext
    await scanLibrary(lib, settings, ctx)
    const track = repo.getTrack(repo.queryTrackIds({})[0])!
    const { candidates } = await scourTrack(track, { artists: ["Tenor Saw"], featuring: [], title: "Ring The Alarm" }, settings, [])
    expect(candidates.map((c) => [c.artist, c.title, c.album])).toEqual([["Tenor Saw", "Ring The Alarm & Dub", "Fever"]])
  })

  it("keeps markup out of what's typed or picked, and out of what the AI says", async () => {
    writeMp3(path.join(dir, "a.mp3"))
    const lib = repo.addLibrary(dir, "Crate")
    const ctx = { log: () => {}, signal: new AbortController().signal, setTotal: () => {}, tick: () => {}, message: () => {}, tracksChanged: () => {}, filesChanged: () => {}, report: () => {}, job: {} } as unknown as JobContext
    await scanLibrary(lib, DEFAULT_SETTINGS, ctx)
    const id = repo.queryTrackIds({})[0]
    const app = createApp()
    const res = await app.request(`http://localhost/api/tracks/${id}`, {
      method: "PATCH",
      headers: { "x-dubplate": "1", "content-type": "application/json" },
      body: JSON.stringify({ final: { artists: ['<a href="/artists/271/linval-thompson">Linval Thompson</a>'], featuring: [], title: "Rude Bwoy", label: '<a href="/labels/59">Thompson Sound</a>' } }),
    })
    expect(res.status).toBeLessThan(300)
    expect(repo.getTrack(id)!.final).toMatchObject({ artists: ["Linval Thompson"], label: "Thompson Sound" })
    const provider = { id: "t", kind: "ollama" as const, label: "Test", baseUrl: "", model: "m", enabled: true }
    const ai = sanitizeAi({ artists: ["<b>Linval Thompson</b>"], title: "Rude Bwoy &amp; Dub", label: "<a href='/l'>Thompson Sound</a>" }, provider, new Map())
    expect([ai.artists, ai.title, ai.label]).toEqual([["Linval Thompson"], "Rude Bwoy & Dub", "Thompson Sound"])
  })

  it("puts right a tag that was written with markup in it, even where it only fills gaps", () => {
    const naming = DEFAULT_SETTINGS.naming
    const out = tagsFor({ artists: ["Linval Thompson"], featuring: [], title: "Rude Bwoy", label: "Thompson Sound", album: "Dread Are The Roots" }, { label: '<a href="/labels/59">Thompson Sound</a>', album: "Kept Album" }, naming)
    expect(out.label).toBe("Thompson Sound")
    expect(out.album).toBeUndefined()
  })

  it("cleans tracks identified before, once, and names files cut with it", async () => {
    writeMp3(path.join(dir, "Linval Thompson - Rude Boy.mp3"))
    writeMp3(path.join(dir, "Tenor Saw - Ring The Alarm.mp3"))
    const lib = repo.addLibrary(dir, "Crate")
    const logs: [string, string][] = []
    const ctx = {
      log: (l: string, m: string) => void logs.push([l, m]),
      signal: new AbortController().signal,
      setTotal: () => {},
      tick: () => {},
      message: () => {},
      tracksChanged: () => {},
      filesChanged: () => {},
      report: () => {},
      job: {},
    } as unknown as JobContext
    await scanLibrary(lib, DEFAULT_SETTINGS, ctx)
    const [a, b] = repo.queryTracks({ sort: "filename", dir: "asc" }).items
    const hit: Candidate = { source: "riddimid", sourceLabel: "Riddim-ID", artist: '<a href="/artists/271/linval-thompson">Linval Thompson</a>', title: "Rude Bwoy", label: '<a href="/labels/59">Thompson Sound</a>' }
    repo.updateTrack(a.id, { candidates: [hit], status: "scoured" })
    // already cut, with the markup in the file's tags
    repo.updateTrack(b.id, { status: "done", tags: { artist: "Tenor Saw", title: "Ring The Alarm", label: "<a href='/labels/3'>Techniques</a>" } })
    expect(tracksWithMarkup().sort()).toEqual([a.id, b.id].sort())
    await repairMarkup([a.id, b.id], DEFAULT_SETTINGS, ctx)
    const fixed = repo.getTrack(a.id)!
    expect(fixed.candidates![0]).toMatchObject({ artist: "Linval Thompson", label: "Thompson Sound" })
    expect(fixed.decision!.artists).toEqual(["Linval Thompson"])
    expect(fixed.decision!.label).toBe("Thompson Sound")
    expect(logs).toContainEqual(["success", `Cleaned web page markup (links, "&amp;") out of 1 track's details`])
    expect(logs.find(([l]) => l === "warn")?.[1]).toMatch(/^1 file was already cut with web page markup in its tags - pick it in Tracks and use Update tags/)
    expect(tracksWithMarkup()).toEqual([b.id])
  })
})
