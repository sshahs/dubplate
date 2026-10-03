// Every field holds only its own thing: riddims aren't artists, titles aren't in artists,
// genres aren't albums, a guest is named once - whoever filled the field in.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkFields, isGenreName, isPlaceholder, riddimIn } from "../../shared/fields"
import { riskOf } from "../../shared/risk"
import type { Candidate, Decision, FinalMeta, Settings } from "../../shared/types"
import { sanitizeAi } from "../ai/interpreter"
import { parseFilename } from "../core/filename-parser"
import { formatArtist, tagsFor } from "../core/naming"
import { checkCandidate } from "../core/plain-text"
import { openDb, setDb } from "../db"
import { activeJobs, resetJobStateForTests, type JobContext } from "../jobs"
import { recheckFields } from "../pipeline"
import { metaFor } from "../placement"
import * as repo from "../repo"
import { scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS } from "../settings"
import { writeMp3 } from "./fixtures"

const meta = (m: Partial<FinalMeta>): FinalMeta => ({ artists: [], featuring: [], title: "", ...m })
const fixedFields = (m: Partial<FinalMeta>) => checkFields(meta(m)).fields
const messages = (m: Partial<FinalMeta>) => checkFields(meta(m)).notes.map((n) => `${n.fixed ? "fixed" : "look"}: ${n.message}`)

describe("riddim names", () => {
  it("knows a riddim's name, and a riddim mix when it sees one", () => {
    expect(riddimIn("Seasons Riddim")).toEqual({ name: "Seasons" })
    expect(riddimIn("seasons riddim 2009")).toEqual({ name: "seasons", year: 2009 })
    expect(riddimIn("Riddim: Stalag")).toEqual({ name: "Stalag" })
    expect(riddimIn("The Answer Riddim")).toEqual({ name: "Answer" })
    for (const s of ["Seasons Riddim Mix", "Diwali Riddim Medley", "Gyptian", "Slave To The Rhythm", "Riddim", "Gyptian - Seasons Riddim", "Sleng Teng Riddim Instrumental"]) expect(riddimIn(s)).toBeNull()
  })
})

describe("the filename parser", () => {
  const read = (f: string, ctx = {}) => {
    const p = parseFilename(f, ctx)
    return { artists: p.artists, title: p.title, riddim: p.riddim, ...(p.year ? { year: p.year } : {}) }
  }

  it("never takes a riddim for the artist, wherever it sits", () => {
    const gyptian = { artists: ["Gyptian"], title: "Is There A Place", riddim: "Seasons" }
    expect(read("Seasons Riddim - Gyptian - Is There A Place.mp3")).toEqual(gyptian)
    expect(read("Seasons_Riddim_-_Gyptian_-_Is_There_A_Place.mp3")).toEqual(gyptian)
    expect(read("Gyptian - Is There A Place (Seasons Riddim).mp3")).toEqual(gyptian)
    expect(read("Gyptian - Is There A Place - Seasons Riddim.mp3")).toEqual(gyptian)
    expect(read("Gyptian - Seasons Riddim - Is There A Place.mp3")).toEqual(gyptian)
    expect(read("Seasons Riddim 2009 - Gyptian - Is There A Place.mp3")).toEqual({ ...gyptian, year: 2009 })
    expect(read("Gyptian - Is There A Place [Seasons Riddim 2009].mp3")).toEqual({ ...gyptian, year: 2009 })
    expect(read("Answer Riddim - Gregory Isaacs & Dennis Brown - Let Off Supm.mp3")).toEqual({ artists: ["Gregory Isaacs", "Dennis Brown"], title: "Let Off Supm", riddim: "Answer" })
  })

  it("reads the riddim from its folder or the album tag", () => {
    const gyptian = { artists: ["Gyptian"], title: "Is There A Place", riddim: "Seasons" }
    expect(read("03 - Gyptian - Is There A Place.mp3", { folders: ["Seasons Riddim (2009)"] })).toEqual({ ...gyptian, year: 2009 })
    expect(read("Gyptian - Is There A Place.mp3", { folders: ["VA - Seasons Riddim [Don Corleon Records]"] })).toEqual(gyptian)
    expect(read("Gyptian - Is There A Place.mp3", { folders: ["Seasons", "Riddims"] })).toEqual(gyptian)
    expect(read("Gyptian - Is There A Place.mp3", { tagAlbum: "Seasons Riddim" })).toEqual(gyptian)
    // an artist tag that's really the riddim isn't used as the artist
    expect(read("Is There A Place.mp3", { tagArtist: "Seasons Riddim" })).toEqual({ artists: [], title: "Is There A Place", riddim: "Seasons" })
  })

  it("leaves a riddim's own cut, a riddim mix and songs about rhythm alone", () => {
    expect(read("Steelie & Clevie - Sleng Teng Riddim.mp3")).toEqual({ artists: ["Steelie", "Clevie"], title: "Sleng Teng Riddim", riddim: undefined })
    expect(read("Seasons Riddim Mix - DJ Smiley.mp3")).toEqual({ artists: ["DJ Smiley"], title: "Seasons Riddim Mix", riddim: undefined })
    expect(read("Grace Jones - Slave To The Rhythm.mp3")).toEqual({ artists: ["Grace Jones"], title: "Slave To The Rhythm", riddim: undefined })
  })

  it("takes the title back out of an artist tag", () => {
    expect(read("Another Level.mp3", { tagArtist: "Bounty Killer & Baby Cham - Another level" })).toEqual({ artists: ["Bounty Killer", "Baby Cham"], title: "Another Level", riddim: undefined })
    expect(read("Track 01.mp3", { tagArtist: "Bounty Killer & Baby Cham - Another level" })).toEqual({ artists: ["Bounty Killer", "Baby Cham"], title: "Another level", riddim: undefined })
  })
})

describe("the field check", () => {
  it("moves a riddim out of the artist, and splits an artist and title that came together", () => {
    expect(fixedFields({ artists: ["Seasons Riddim"], title: "Gyptian - Is There A Place" })).toMatchObject({ artists: ["Gyptian"], title: "Is There A Place", riddim: "Seasons" })
    expect(fixedFields({ artists: ["Seasons Riddim", "Gyptian"], title: "Is There A Place" })).toMatchObject({ artists: ["Gyptian"], riddim: "Seasons" })
    expect(fixedFields({ artists: ["Gyptian"], title: "Seasons Riddim - Is There A Place" })).toMatchObject({ title: "Is There A Place", riddim: "Seasons" })
    expect(fixedFields({ artists: ["Gyptian"], title: "Is There A Place", version: "Seasons Riddim" })).toMatchObject({ version: undefined, riddim: "Seasons" })
  })

  it("takes the title out of the artist, and the artist out of the title", () => {
    expect(fixedFields({ artists: ["Bounty Killer & Baby Cham - Another level"], title: "Another Level" })).toMatchObject({ artists: ["Bounty Killer & Baby Cham"], title: "Another Level" })
    expect(fixedFields({ artists: ["Bounty Killer", "Baby Cham - Another level"], title: "Another Level" }).artists).toEqual(["Bounty Killer", "Baby Cham"])
    expect(fixedFields({ artists: ["Bounty Killer & Baby Cham - Another level"], title: "" })).toMatchObject({ artists: ["Bounty Killer & Baby Cham"], title: "Another level" })
    expect(fixedFields({ artists: ["Bounty Killer", "Baby Cham"], title: "Bounty Killer & Baby Cham - Another Level" }).title).toBe("Another Level")
    expect(fixedFields({ artists: ["Tenor Saw"], title: "Ring The Alarm - Tenor Saw" }).title).toBe("Ring The Alarm")
  })

  it("names a guest once, outside the artist", () => {
    expect(fixedFields({ artists: ["Jah Shaka feat. Max Romeo"], featuring: ["Max Romeo"], title: "African Woman Dub" })).toMatchObject({ artists: ["Jah Shaka"], featuring: ["Max Romeo"] })
    expect(fixedFields({ artists: ["Mavado"], title: "Real McKoy (feat. Busy Signal)" })).toMatchObject({ title: "Real McKoy", featuring: ["Busy Signal"] })
    expect(fixedFields({ artists: ["Jah Shaka", "Max Romeo"], featuring: ["Max Romeo", "max romeo"], title: "x" }).featuring).toEqual([])
  })

  it("leaves genres and placeholders out of the album, label and genre", () => {
    expect(fixedFields({ artists: ["A"], title: "B", album: "reggae" }).album).toBeUndefined()
    expect(fixedFields({ artists: ["A"], title: "B", album: "Reggae / Dancehall" }).album).toBeUndefined()
    expect(fixedFields({ artists: ["A"], title: "B", album: "Unknown Album" }).album).toBeUndefined()
    expect(fixedFields({ artists: ["A"], title: "B", album: "1999" }).album).toBeUndefined()
    expect(fixedFields({ artists: ["A"], title: "B", album: "www.reggaeworld.com" }).album).toBeUndefined()
    expect(fixedFields({ artists: ["A"], title: "B", label: "Dancehall" }).label).toBeUndefined()
    expect(fixedFields({ artists: ["A"], title: "B", genre: "Other" }).genre).toBeUndefined()
    expect(fixedFields({ artists: ["A"], title: "B", genre: "(17)" }).genre).toBeUndefined()
    // real names are kept, even ones with a genre in them
    for (const album of ["Reggae Gold 2009", "Dub Salute 4", "Strictly The Best 40", "Dancehall Queen"]) expect(fixedFields({ artists: ["A"], title: "B", album }).album).toBe(album)
    expect(messages({ artists: ["A"], title: "B", album: "reggae" })).toEqual(['fixed: Album "reggae" is a genre, not an album - left empty'])
    // a riddim compilation tells you the riddim
    expect(fixedFields({ artists: ["Gyptian"], title: "Is There A Place", album: "Seasons Riddim" })).toMatchObject({ album: "Seasons Riddim", riddim: "Seasons" })
  })

  it("takes video and download noise and track numbers off, and drops impossible years", () => {
    expect(fixedFields({ artists: ["Sean Paul (Official Video)"], title: "Get Busy (Official Video) [HD]" })).toMatchObject({ artists: ["Sean Paul"], title: "Get Busy" })
    expect(fixedFields({ artists: ["A"], title: "01 - Another Level" }).title).toBe("Another Level")
    expect(fixedFields({ artists: ["A"], title: "B1. Ring The Alarm" }).title).toBe("Ring The Alarm")
    expect(fixedFields({ artists: ["A"], title: "Ring The Alarm.mp3" }).title).toBe("Ring The Alarm")
    expect(fixedFields({ artists: ["A"], title: "B", year: 2091 }).year).toBeUndefined()
    expect(fixedFields({ artists: ["A"], title: "B", year: 1985 }).year).toBe(1985)
    // titles that are numbers or years are songs too
    expect(fixedFields({ artists: ["Prince"], title: "1999" }).title).toBe("1999")
  })

  it("takes placeholders out of the artists, and says what needs a person", () => {
    expect(fixedFields({ artists: ["Unknown Artist", "Gyptian"], title: "x" }).artists).toEqual(["Gyptian"])
    expect(messages({ artists: ["Various Artists"], title: "Track 01" })).toEqual([
      `fixed: "Various Artists" isn't an artist's name - taken out`,
      "look: No artist",
      `look: "Track 01" isn't a song's name`,
    ])
    expect(messages({ artists: ["Gyptian - Hold Yuh"], title: "Is There A Place" })).toEqual([`look: "Gyptian - Hold Yuh" looks like an artist and a title together`])
    expect(messages({ artists: ["Gyptian"], title: "gyptian" })).toEqual([`look: The artist and the title are the same ("gyptian")`])
    expect(messages({ artists: ["Tenor Saw"], title: "Ring The Alarm", riddim: "Stalag", album: "Ring The Alarm", year: 1985 })).toEqual([])
  })

  it("knows a genre when it's all there is", () => {
    for (const g of ["reggae", "Reggae", "Roots Reggae", "reggae music", "Dancehall/Reggae", "Hip Hop", "R&B", "drum and bass"]) expect(isGenreName(g)).toBe(true)
    for (const g of ["Reggae Gold", "Dub Salute 4", "Dancehall Queen", "Original Rockers"]) expect(isGenreName(g)).toBe(false)
    expect(isPlaceholder("artist", "VA")).toBe(true)
    expect(isPlaceholder("artist", "Tenor Saw")).toBe(false)
  })
})

describe("the checks everywhere", () => {
  it("writes a guest once, however they arrived", () => {
    const naming = DEFAULT_SETTINGS.naming
    expect(formatArtist(meta({ artists: ["Jah Shaka feat. Max Romeo"], featuring: ["Max Romeo"], title: "African Woman Dub" }), naming)).toBe("Jah Shaka feat. Max Romeo")
    expect(formatArtist(meta({ artists: ["Jah Shaka"], featuring: ["Max Romeo", "Max Romeo"], title: "x" }), naming)).toBe("Jah Shaka feat. Max Romeo")
    // and what's written for an approved track is checked on the way out
    const track = { final: meta({ artists: ["Jah Shaka feat. Max Romeo"], featuring: ["Max Romeo"], title: "African Woman Dub", album: "Dub Salute 4", genre: "Other" }), decision: null }
    expect(metaFor(track as never)).toMatchObject({ artists: ["Jah Shaka"], featuring: ["Max Romeo"], genre: undefined })
  })

  it("replaces a placeholder tag, or clears it when there's nothing better", () => {
    const naming = DEFAULT_SETTINGS.naming
    const m = meta({ artists: ["Bounty Killer", "Baby Cham"], title: "Another Level" })
    expect(tagsFor(m, { album: "reggae", genre: ["Other"] }, naming)).toMatchObject({ album: "", genre: [] })
    expect(tagsFor({ ...m, album: "Another Level" }, { album: "reggae" }, naming).album).toBe("Another Level")
    expect(tagsFor({ ...m, album: "Another Level" }, { album: "Dub Salute 4" }, naming).album).toBeUndefined()
    expect(tagsFor(m, { label: "Unknown" }, naming).label).toBe("")
  })

  it("keeps a riddim from being credited by a source or the AI", () => {
    const hit = (c: Partial<Candidate>): Candidate => ({ source: "youtube", sourceLabel: "YouTube", artist: "", title: "", ...c })
    expect(checkCandidate(hit({ artist: "Seasons Riddim", title: "Before There Was Time" }))).toBeNull()
    expect(checkCandidate(hit({ artist: "Seasons Riddim", title: "Gyptian - Is There A Place" }))).toMatchObject({ artist: "Gyptian", title: "Is There A Place", riddim: "Seasons" })
    expect(checkCandidate(hit({ artist: "Bounty Killer & Baby Cham - Another Level", title: "Another Level", album: "reggae" }))).toMatchObject({ artist: "Bounty Killer & Baby Cham", album: undefined })
    // a source's guests travel in its artist: they stay there for the decision to read
    expect(checkCandidate(hit({ artist: "Mavado feat. Busy Signal - Real McKoy", title: "Real McKoy" }))).toMatchObject({ artist: "Mavado feat. Busy Signal" })
    const fine = hit({ artist: "Tenor Saw", title: "Ring The Alarm" })
    expect(checkCandidate(fine)).toBe(fine)
    const provider = { id: "t", kind: "ollama" as const, label: "Test", baseUrl: "", model: "m", enabled: true }
    expect(sanitizeAi({ artists: ["Seasons Riddim"], title: "Gyptian - Is There A Place" }, provider, new Map())).toMatchObject({ artists: ["Gyptian"], title: "Is There A Place", riddim: "Seasons" })
  })

  it("keeps automation off a track with a field that needs a person", () => {
    const d = { status: "matched", basis: "sources", clusters: [{ sources: ["discogs", "musicbrainz"] }], checks: [{ field: "artists", fixed: false, message: `"Gyptian - Hold Yuh" looks like an artist and a title together` }] } as unknown as Decision
    expect(riskOf({ decision: d, analysis: null, fileCheck: null, ext: "mp3" })).toMatchObject({ level: "high", reasons: [`"Gyptian - Hold Yuh" looks like an artist and a title together`] })
  })
})

describe("tracks read before the checks", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-fields-"))
    setDb(openDb(":memory:"))
    resetJobStateForTests()
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("are read again, searched again where the artist changed, and cut ones go back to Cut & Tag", async () => {
    // No sources: the search again finishes straight away.
    const settings: Settings = structuredClone({ ...DEFAULT_SETTINGS, sources: Object.fromEntries(Object.entries(DEFAULT_SETTINGS.sources).map(([id, c]) => [id, { ...c, enabled: false }])), scrapers: [] })
    writeMp3(path.join(dir, "Seasons Riddim - Gyptian - Is There A Place.mp3"))
    writeMp3(path.join(dir, "Jah Shaka - African Woman Dub.mp3"))
    writeMp3(path.join(dir, "Tenor Saw - Ring The Alarm.mp3"))
    const lib = repo.addLibrary(dir, "Crate")
    const logs: [string, string][] = []
    const ctx = {
      job: { id: "j" },
      log: (l: string, m: string) => void logs.push([l, m]),
      signal: new AbortController().signal,
      setTotal: () => {},
      tick: () => {},
      message: () => {},
      tracksChanged: () => {},
      filesChanged: () => {},
      report: () => {},
    } as unknown as JobContext
    await scanLibrary(lib, settings, ctx)
    const [shaka, gyptian, tenor] = repo.queryTracks({ sort: "filename", dir: "asc" }).items
    // As the old parser read it, already searched.
    repo.updateTrack(gyptian.id, { heuristic: { ...repo.getTrack(gyptian.id)!.heuristic!, artists: ["Seasons Riddim"], title: "Gyptian - Is There A Place", riddim: undefined }, candidates: [], status: "review" })
    // Cut with the guest named twice and a genre for an album.
    repo.updateTrack(shaka.id, { status: "done", final: meta({ artists: ["Jah Shaka feat. Max Romeo"], featuring: ["Max Romeo"], title: "African Woman Dub", album: "reggae" }), tags: { artist: "Jah Shaka feat. Max Romeo feat. Max Romeo", title: "African Woman Dub", album: "reggae" } })
    // Nothing wrong with this one.
    repo.updateTrack(tenor.id, { status: "done", final: meta({ artists: ["Tenor Saw"], title: "Ring The Alarm" }), tags: { artist: "Tenor Saw", title: "Ring The Alarm" } })

    await recheckFields([shaka.id, gyptian.id, tenor.id], settings, ctx)
    expect(repo.getTrack(gyptian.id)!.heuristic).toMatchObject({ artists: ["Gyptian"], title: "Is There A Place", riddim: "Seasons" })
    expect(activeJobs().map((j) => j.label)).toEqual(["Ask the sources again for 1 track read wrong before"])
    const fixed = repo.getTrack(shaka.id)!
    expect(fixed.status).toBe("approved")
    expect(fixed.final).toMatchObject({ artists: ["Jah Shaka"], featuring: ["Max Romeo"] })
    expect(fixed.final!.album).toBeUndefined()
    expect(repo.getTrack(tenor.id)!.status).toBe("done")
    expect(logs.at(-1)).toEqual(["success", "Checked every track's fields: 2 tracks put right, 1 to ask the sources about again, 1 cut file back in Cut & Tag"])
    for (let i = 0; i < 100 && activeJobs().length; i++) await new Promise((r) => setTimeout(r, 20))
    expect(repo.getTrack(gyptian.id)!.decision).toMatchObject({ artists: ["Gyptian"], title: "Is There A Place", riddim: "Seasons" })
  })
})
