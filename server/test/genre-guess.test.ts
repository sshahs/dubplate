// The AI's genre is never used on its own: a small model asked for a genre it
// doesn't know gives the one the collection is mostly ("Reggae" for every UK rap
// tune). The genre comes from the recording's hits, else the artist's genres on
// MusicBrainz (then Last.fm), else the genre tag the file came with - and a
// "Reggae" an earlier cut wrote from the guess is put right.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AiParse, Candidate, Decision, Settings } from "../../shared/types"
import { collectionContext, systemPrompt } from "../ai/interpreter"
import { scoreTrack } from "../core/confidence"
import { parseFilename } from "../core/filename-parser"
import { tagsFor } from "../core/naming"
import { getDb, openDb, setDb } from "../db"
import { resetJobStateForTests, type JobContext } from "../jobs"
import { recheckFields } from "../pipeline"
import * as repo from "../repo"
import { scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS } from "../settings"
import { knownArtistGenres, lookUpArtistGenres } from "../sources/artist-genres"
import { writeMp3 } from "./fixtures"

const ai = (p: Partial<AiParse>): AiParse => ({ artists: [], featuring: [], title: "", confidence: 0.9, reasoning: "", alternatives: [], searchQueries: [], provider: "t", model: "qwen3:8b", ...p })

function score(reading: Partial<AiParse>, opts: { candidates?: Candidate[]; artistGenres?: string[]; fileGenre?: string[] } = {}): Decision {
  const filename = `${reading.artists?.[0]} - ${reading.title}.mp3`
  return scoreTrack({
    heuristic: parseFilename(filename),
    ai: ai(reading),
    tags: {},
    candidates: opts.candidates ?? [],
    duration: null,
    weights: { deezer: 0.8, spotify: 0.8, musicbrainz: 1 },
    thresholds: { autoThreshold: 90, reviewThreshold: 60, parseOnlyMax: 75 },
    context: { filename, folders: [], preferOwnRelease: true },
    artistGenres: () => (opts.artistGenres ? { genres: opts.artistGenres, source: "MusicBrainz" } : null),
    fileGenre: opts.fileGenre,
  })
}

const deezer = (artist: string, title: string): Candidate => ({ source: "deezer", sourceLabel: "Deezer", artist, title })

function settings(lastfmKey?: string): Settings {
  const s = structuredClone(DEFAULT_SETTINGS)
  s.sources = Object.fromEntries(Object.entries(s.sources).map(([k, v]) => [k, { ...v, enabled: k === "musicbrainz" || (k === "lastfm" && !!lastfmKey) }]))
  if (lastfmKey) s.sources.lastfm = { ...s.sources.lastfm, enabled: true, apiKey: lastfmKey }
  s.scrapers = []
  return s
}

type Reply = (url: string) => unknown
function stub(reply: Reply) {
  const calls: string[] = []
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const out = reply(url)
    if (out instanceof Error) throw out
    if (out === undefined) return new Response("{}", { status: 404 })
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } })
  })
  return calls
}

/** MusicBrainz: one Dave from GB with UK rap genres, another Dave from the US. */
const mb: Reply = (url) => {
  if (url.includes("/ws/2/artist?")) {
    if (url.includes("Dave"))
      return {
        artists: [
          { id: "dave-gb", name: "Dave", score: 100, country: "GB" },
          { id: "dave-us", name: "Dave", score: 100, country: "US" },
        ],
      }
    if (url.includes("Headie"))
      return { artists: [{ id: "headie", name: "Headie One", score: 100, country: "GB" }] }
    return { artists: [] }
  }
  if (url.includes("/ws/2/artist/dave-gb")) return { id: "dave-gb", name: "Dave", genres: [{ name: "hip hop", count: 2 }, { name: "uk hip hop", count: 5 }, { name: "grime", count: 1 }] }
  if (url.includes("/ws/2/artist/headie")) return { id: "headie", name: "Headie One", genres: [{ name: "uk drill", count: 4 }] }
  return undefined
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-genre-"))
  setDb(openDb(":memory:"))
  resetJobStateForTests()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe("the genre", () => {
  it("is never the AI's guess on its own", () => {
    const reading = { artists: ["Headie One"], title: "Both", genre: "Reggae" }
    expect(score(reading, { candidates: [deezer("Headie One", "Both")] }).genre).toBeUndefined()
    expect(score(reading).genre).toBeUndefined()
  })

  it("comes from the artist's genres when the recording's hits give none, then the file's own tag", () => {
    const reading = { artists: ["Headie One"], title: "Both", genre: "Reggae" }
    const d = score(reading, { candidates: [deezer("Headie One", "Both")], artistGenres: ["uk drill", "drill"] })
    expect(d.genre).toBe("UK Drill")
    expect(d.provenance?.genre).toBe("MusicBrainz (the artist's genres)")
    expect(d.artistGenres).toEqual({ genres: ["uk drill", "drill"], source: "MusicBrainz" })
    expect(score(reading, { fileGenre: ["Grime"] })).toMatchObject({ genre: "Grime", provenance: { genre: "the file's own tag" } })
    // the recording's own hits come first
    const tagged = { ...deezer("Headie One", "Both"), source: "itunes" as const, sourceLabel: "Apple Music", genre: "Hip-Hop/Rap" }
    expect(score(reading, { candidates: [tagged], artistGenres: ["uk drill"] }).genre).toBe("Hip-Hop/Rap")
  })

  it("isn't steered by the collection or the app: the prompt says so", () => {
    const p = systemPrompt(collectionContext({ genres: ["Reggae", "Dancehall"], sceneHint: "" }))
    expect(p).toContain("Mostly Reggae, Dancehall.")
    expect(p).toMatch(/says nothing about any one file's genre/)
    expect(p).toMatch(/- genre: null unless you genuinely know this artist/)
    expect(p).toMatch(/a UK rapper is "UK Rap" or "Grime", not "Reggae"/)
    // the genres it knows aren't led by reggae
    expect(p.indexOf("reggae")).toBeGreaterThan(p.indexOf("hip-hop"))
  })
})

describe("artists' genres", () => {
  it("asks MusicBrainz, picks the right one of several same-named artists, and keeps the answer", async () => {
    const calls = stub(mb)
    // Two Daves: the British one, since the AI says the artist is from GB.
    expect(await lookUpArtistGenres(["Dave"], settings(), { country: "GB" })).toEqual({ artist: "Dave", genres: ["uk hip hop", "hip hop", "grime"], source: "MusicBrainz" })
    expect(await lookUpArtistGenres(["Headie One"], settings())).toMatchObject({ genres: ["uk drill"] })
    const asked = calls.length
    expect(knownArtistGenres(["Dave"])).toMatchObject({ genres: ["uk hip hop", "hip hop", "grime"] })
    expect(await lookUpArtistGenres(["Dave"], settings())).toMatchObject({ source: "MusicBrainz" })
    expect(calls.length).toBe(asked)
  })

  it("leaves an artist it can't place, uses Last.fm's tags where MusicBrainz has none, and asks again after a failure", async () => {
    stub((url) => (url.includes("musicbrainz.org") ? mb(url) : { toptags: { tag: [{ name: "seen live", count: 100 }, { name: "UK Rap", count: 80 }, { name: "british", count: 60 }, { name: "grime", count: 5 }] } }))
    // Without knowing where he's from, two Daves is no answer.
    expect(await lookUpArtistGenres(["Dave"], settings())).toBeNull()
    expect(await lookUpArtistGenres(["Nobody Known"], settings("lfm-key"))).toEqual({ artist: "Nobody Known", genres: ["uk rap"], source: "Last.fm" })

    stub(() => new Error("offline"))
    expect(await lookUpArtistGenres(["Ghetts"], settings())).toBeNull()
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM artist_genres WHERE key = 'ghetts'").get()).toEqual({ n: 0 })
  })
})

describe("a genre already guessed", () => {
  const naming = DEFAULT_SETTINGS.naming
  const m = { artists: ["Headie One"], featuring: [], title: "Both" }

  it("is put right in the file: the real genre, or the file's own back", () => {
    expect(tagsFor({ ...m, genre: "UK Drill" }, { genre: ["Reggae"] }, naming, { aiGenre: ["Reggae"], fileGenre: [] }).genre).toEqual(["UK Drill"])
    expect(tagsFor(m, { genre: ["Reggae"] }, naming, { aiGenre: ["reggae"], fileGenre: ["Hip-Hop"] }).genre).toEqual(["Hip-Hop"])
    expect(tagsFor(m, { genre: ["Reggae"] }, naming, { aiGenre: ["Reggae"], fileGenre: [] }).genre).toEqual([])
    // A Reggae the file came with is its own, and a genre that isn't the AI's guess is left alone.
    expect(tagsFor({ ...m, genre: "UK Drill" }, { genre: ["Reggae"] }, naming, { aiGenre: ["Reggae"], fileGenre: ["Reggae"] }).genre).toBeUndefined()
    expect(tagsFor({ ...m, genre: "UK Drill" }, { genre: ["Grime"] }, naming, { aiGenre: ["Reggae"], fileGenre: [] }).genre).toBeUndefined()
  })

  it("is replaced once after upgrading: the artist's genre, or none", async () => {
    stub(mb)
    writeMp3(path.join(dir, "Headie One - Both.mp3"))
    writeMp3(path.join(dir, "Nobody Known - Tune.mp3"))
    writeMp3(path.join(dir, "Tenor Saw - Ring The Alarm.mp3"))
    const lib = repo.addLibrary(dir, "Crate")
    const ctx = { job: { id: "j" }, log: () => {}, signal: new AbortController().signal, setTotal: () => {}, tick: () => {}, message: () => {}, tracksChanged: () => {}, filesChanged: () => {}, report: () => {} } as unknown as JobContext
    await scanLibrary(lib, settings(), ctx)
    const [headie, nobody, tenor] = repo.queryTracks({ sort: "filename", dir: "asc" }).items
    const approve = (id: number, artist: string, title: string, genre: string, typed?: string) => {
      const reading = ai({ artists: [artist], title, genre })
      const decision = { artists: [artist], featuring: [], artist, title, genre, confidence: 70, status: "review", basis: "ai", factors: [], clusters: [], warnings: [], provenance: { genre: "AI (qwen3:8b)" } } as unknown as Decision
      repo.updateTrack(id, { ai: reading, decision, status: "approved", final: { artists: [artist], featuring: [], title, genre: typed ?? genre } })
    }
    approve(headie.id, "Headie One", "Both", "Reggae")
    approve(nobody.id, "Nobody Known", "Tune", "Reggae")
    // A person typed their own genre over the AI's.
    approve(tenor.id, "Tenor Saw", "Ring The Alarm", "Dancehall", "Roots")
    await recheckFields([headie.id, nobody.id, tenor.id], settings(), ctx)
    expect(repo.getTrack(headie.id)!.final!.genre).toBe("UK Drill")
    expect(repo.getTrack(headie.id)!.decision).toMatchObject({ genre: "UK Drill", provenance: { genre: "MusicBrainz (the artist's genres)" } })
    expect(repo.getTrack(nobody.id)!.final!.genre).toBeUndefined()
    // A genre a person chose that isn't the AI's stays.
    expect(repo.getTrack(tenor.id)!.final!.genre).toBe("Roots")
  })
})
