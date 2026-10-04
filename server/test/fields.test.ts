// Every field holds only its own thing: riddims aren't artists, titles aren't in artists,
// genres aren't albums, a guest is named once - whoever filled the field in.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { checkFields, isGenreName, isPlaceholder, riddimIn, versionBacked, withoutUnbackedVersions } from "../../shared/fields"
import { riskOf } from "../../shared/risk"
import type { AiParse, Candidate, Decision, FinalMeta, Settings } from "../../shared/types"
import { buildUserPrompt, sanitizeAi } from "../ai/interpreter"
import { scoreTrack } from "../core/confidence"
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

describe("versions need evidence", () => {
  it("knows when a version is backed up", () => {
    expect(versionBacked("Dubplate", ["Asco - STRAIGHT DROP .flac", "UK Rap"])).toBe(false)
    expect(versionBacked("Dubplate", ["Asco - Straight Drop (Dub Plate).flac"])).toBe(true)
    expect(versionBacked("Dubplate for Stone Love", ["Buju Banton - Murderer Dubplate.mp3"])).toBe(true)
    expect(versionBacked("Skepta Remix", ["Wiley - Wot Do U Call It (Skepta RMX).mp3"])).toBe(true)
    expect(versionBacked("Remix", ["Benny Banks - Eye for an Eye .flac"])).toBe(false)
    expect(versionBacked("Dub", ["Jah Shaka - African Woman Dub.mp3"])).toBe(true)
    // a dubplate isn't a dub, and a dub isn't a dubplate
    expect(versionBacked("Dub", ["Murderer (Dubplate).mp3"])).toBe(false)
    expect(versionBacked("Dubplate", ["King Tubby - Dub.mp3"])).toBe(false)
    // nothing about the kind of recording: nothing to back up
    expect(versionBacked("Side A", [])).toBe(true)
    expect(versionBacked("Part 2", [])).toBe(true)
    expect(withoutUnbackedVersions("Eye For An Eye (Remix)", ["Benny Banks - Eye for an Eye .flac"])).toEqual({ title: "Eye For An Eye", removed: ["(Remix)"] })
    expect(withoutUnbackedVersions("Eye For An Eye (Remix)", ["Benny Banks - Eye for an Eye (Remix).flac"]).removed).toEqual([])
    expect(withoutUnbackedVersions("Could You Be Loved (Is This Love)", []).removed).toEqual([])
  })

  const ai = (p: Partial<AiParse>): AiParse => ({ artists: [], featuring: [], title: "", confidence: 0.9, reasoning: "", alternatives: [], searchQueries: [], provider: "t", model: "m", ...p })
  const score = (filename: string, reading: Partial<AiParse>, candidates: Candidate[] = [], folders: string[] = []) =>
    scoreTrack({
      heuristic: parseFilename(filename, { folders }),
      ai: ai(reading),
      tags: {},
      candidates,
      duration: null,
      weights: { deezer: 0.8, itunes: 0.85, discogs: 0.95, acoustid: 1.3 },
      thresholds: { autoThreshold: 90, reviewThreshold: 60, parseOnlyMax: 75 },
      context: { filename, folders, preferOwnRelease: true },
    })
  const hit = (source: Candidate["source"], artist: string, title: string, extra: Partial<Candidate> = {}): Candidate => ({ source, sourceLabel: source, artist, title, ...extra })

  it("leaves out a Dubplate the AI gave a file that never says so", () => {
    const d = score("Asco - STRAIGHT DROP .flac", { artists: ["Asco"], title: "Straight Drop", version: "Dubplate" })
    expect(d.version).toBeUndefined()
    expect(d.checks).toContainEqual({ field: "version", fixed: true, message: 'Version "Dubplate" left out: nothing about the file or its sources says so' })
    expect(score("Asco - Straight Drop (Dubplate).flac", { artists: ["Asco"], title: "Straight Drop", version: "Dubplate" }).version).toBe("Dubplate")
    expect(score("Asco - Straight Drop.flac", { artists: ["Asco"], title: "Straight Drop", version: "Dubplate" }, [], ["Dubplates"]).version).toBe("Dubplate")
  })

  it("takes a source's (Remix) off the title when the file isn't one, unless the audio's fingerprint says so", () => {
    const remix = [hit("deezer", "Benny Banks", "Eye For An Eye (Remix)"), hit("itunes", "Benny Banks", "Eye For An Eye (Remix)"), hit("discogs", "Benny Banks", "Eye For An Eye (Remix)")]
    const d = score("Benny Banks - Eye for an Eye .flac", { artists: ["Benny Banks"], title: "Eye for an Eye" }, remix)
    expect(d.basis).toBe("sources")
    expect(d.title).toBe("Eye For An Eye")
    expect(d.checks?.map((n) => n.message)).toContain(`Took (Remix) off the title: a source's title says so, but nothing about the file does`)
    expect(score("Benny Banks - Eye for an Eye (Remix).flac", { artists: ["Benny Banks"], title: "Eye for an Eye", version: "Remix" }, remix).title).toBe("Eye For An Eye (Remix)")
    const heard = [...remix, hit("acoustid", "Benny Banks", "Eye For An Eye (Remix)", { fingerprint: true, sourceScore: 0.95 })]
    expect(score("Benny Banks - Eye for an Eye .flac", { artists: ["Benny Banks"], title: "Eye for an Eye" }, heard).title).toBe("Eye For An Eye (Remix)")
  })

  it("never shows the AI an example's version this file doesn't share", () => {
    const track = { filename: "Asco - STRAIGHT DROP .flac", relDir: "UK Rap/Asco", tags: {}, duration: 200, heuristic: null } as never
    const examples = [{ id: 1, filename: "Asco - Bad Boy.flac", artists: ["Asco"], title: "Bad Boy", version: "Dubplate", createdAt: "" }]
    expect(buildUserPrompt(track, examples)).toContain('- "Asco - Bad Boy.flac" → Asco - Bad Boy')
    expect(buildUserPrompt(track, examples)).not.toContain("(Dubplate)")
    const plate = { ...(track as object), filename: "Asco - Straight Drop Dubplate.flac" } as never
    expect(buildUserPrompt(plate, examples)).toContain("Asco - Bad Boy (Dubplate)")
  })
})

describe("tracks read before the checks", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-fields-"))
    setDb(openDb(":memory:"))
    resetJobStateForTests()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("are read again, searched again where the artist changed, and cut ones go back to Cut & Tag", async () => {
    // Like a real network: every request takes its time (sandboxes without one answer at once).
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => resolve(new Response("{}")), 3000)
          init?.signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))))
        })
    )
    vi.stubGlobal("fetch", fetch)
    // No sources: the search again finishes straight away, asking nothing of the network.
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
    expect(activeJobs()).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(repo.getTrack(gyptian.id)!.decision).toMatchObject({ artists: ["Gyptian"], title: "Is There A Place", riddim: "Seasons" })
  })

  it("take back a Dubplate the AI guessed from tracks approved as proposed, but not one a person typed", async () => {
    writeMp3(path.join(dir, "Asco - STRAIGHT DROP .mp3"))
    writeMp3(path.join(dir, "Asco - Straight Drop 2.mp3"))
    const lib = repo.addLibrary(dir, "Crate")
    const ctx = { job: { id: "j" }, log: () => {}, signal: new AbortController().signal, setTotal: () => {}, tick: () => {}, message: () => {}, tracksChanged: () => {}, filesChanged: () => {}, report: () => {} } as unknown as JobContext
    await scanLibrary(lib, DEFAULT_SETTINGS, ctx)
    const [guessed, typed] = repo.queryTracks({ sort: "filename", dir: "asc" }).items
    const reading = (version?: string) => ({ artists: ["Asco"], featuring: [], title: "Straight Drop", version, confidence: 0.9, reasoning: "", alternatives: [], searchQueries: [], provider: "t", model: "m" })
    const decided = (version?: string) => ({ artists: ["Asco"], featuring: [], artist: "Asco", title: "Straight Drop", version, confidence: 70, status: "review", basis: "ai", factors: [], clusters: [], warnings: [] }) as unknown as Decision
    // The AI guessed Dubplate and it was approved as proposed.
    repo.updateTrack(guessed.id, { ai: reading("Dubplate"), decision: decided("Dubplate"), status: "approved", final: meta({ artists: ["Asco"], title: "Straight Drop", version: "Dubplate" }) })
    // The AI said nothing; a person typed Dubplate in.
    repo.updateTrack(typed.id, { ai: reading(), decision: decided(), status: "approved", final: meta({ artists: ["Asco"], title: "Straight Drop 2", version: "Dubplate" }) })
    await recheckFields([guessed.id, typed.id], DEFAULT_SETTINGS, ctx)
    expect(repo.getTrack(guessed.id)!.final!.version).toBeUndefined()
    // the stored AI answer is held to the file too, and says what it lost
    expect(repo.getTrack(guessed.id)!.ai!.version).toBeUndefined()
    expect(repo.getTrack(guessed.id)!.ai!.unsupported).toEqual(['version "Dubplate"'])
    expect(repo.getTrack(guessed.id)!.proposedName).toBe("Asco - Straight Drop.mp3")
    expect(repo.getTrack(typed.id)!.final!.version).toBe("Dubplate")
  })
})
