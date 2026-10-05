// {position} for files that don't say where they sit: the track number the matched
// release lists ("05", "A2"), when the file is going into that same album.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AiParse, Candidate, Decision, Settings } from "../../shared/types"
import { scoreTrack } from "../core/confidence"
import { placeValues, releasePosition } from "../core/discs"
import { parseFilename } from "../core/filename-parser"
import { openDb, setDb } from "../db"
import { buildPlan } from "../executor"
import type { JobContext } from "../jobs"
import { proposedFilename } from "../placement"
import * as repo from "../repo"
import { scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS } from "../settings"
import { discogs, itunes, musicbrainz } from "../sources/catalog"
import { writeMp3 } from "./fixtures"

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-position-"))
  setDb(openDb(":memory:"))
})
afterEach(() => vi.unstubAllGlobals())

const q = { artists: ["Gregory Isaacs"], artist: "Gregory Isaacs", title: "Night Nurse", query: "Gregory Isaacs Night Nurse", extraQueries: [], duration: null, descriptiveTitle: false, filePath: "" }
const opts = (apiKey?: string) => ({ cfg: { enabled: true, weight: 1, apiKey }, settings: DEFAULT_SETTINGS })

describe("a source's track position", () => {
  it("is read however a release prints it", () => {
    expect(releasePosition("5")).toEqual({ track: "5" })
    expect(releasePosition("05", 2, 2)).toEqual({ track: "5", disc: 2, discs: 2 })
    expect(releasePosition("a2")).toEqual({ track: "A2" })
    expect(releasePosition("B 3")).toEqual({ track: "B3" })
    expect(releasePosition("1-05")).toEqual({ track: "5", disc: 1 })
    expect(releasePosition("CD2-3")).toEqual({ track: "3", disc: 2 })
    expect(releasePosition(7, 1, 1)).toEqual({ track: "7", disc: 1, discs: 1 })
    for (const junk of ["", "Video", "0", "1a-b", undefined]) expect(releasePosition(junk)).toBeNull()
  })

  it("fills {position} only where the file says nothing itself", () => {
    // The file's own track tag, or a number or vinyl position in its name, wins.
    expect(placeValues({ track: 3 }, null, { track: "5" })).toEqual({ position: "03", track: "03", disc: undefined })
    expect(placeValues({}, parseFilename("A1 Night Nurse.mp3").position, { track: "5" }).position).toBe("A1")
    // Saying nothing: what the release lists.
    expect(placeValues({}, null, { track: "5" })).toEqual({ position: "05", track: "05", disc: undefined })
    expect(placeValues({}, null, { track: "B2" })).toEqual({ position: "B2", track: undefined, disc: undefined })
    // The disc only for a release on more than one.
    expect(placeValues({}, null, { track: "3", disc: 2, discs: 2 }).disc).toBe("2")
    expect(placeValues({}, null, { track: "3", disc: 1, discs: 1 }).disc).toBeUndefined()
  })

  it("comes from MusicBrainz, Discogs and Apple Music", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url)
        if (u.includes("musicbrainz.org"))
          return Response.json({
            recordings: [
              {
                id: "rec",
                title: "Night Nurse",
                "artist-credit": [{ name: "Gregory Isaacs" }],
                releases: [{ id: "rel", title: "Night Nurse", "medium-count": 1, media: [{ position: 1, format: "Vinyl", track: [{ number: "A1", position: 1 }] }] }],
              },
            ],
          })
        if (u.includes("database/search")) return Response.json({ results: [{ id: 42, type: "release", title: "Gregory Isaacs - Night Nurse" }] })
        if (u.includes("api.discogs.com/releases/42"))
          return Response.json({
            id: 42,
            title: "Night Nurse",
            artists: [{ name: "Gregory Isaacs" }],
            tracklist: [
              { position: "1-01", title: "Night Nurse" },
              { position: "2-01", title: "Night Nurse (Dub)" },
            ],
          })
        if (u.includes("itunes.apple.com")) return Response.json({ results: [{ trackId: 1, trackName: "Night Nurse", artistName: "Gregory Isaacs", collectionName: "Night Nurse", trackNumber: 1, discNumber: 1, discCount: 1 }] })
        return new Response("{}", { status: 404 })
      })
    )
    const [mb] = await musicbrainz.search(q, opts())
    expect(mb.position).toEqual({ track: "A1", disc: 1, discs: 1 })
    expect(mb.releases?.[0].position).toEqual({ track: "A1", disc: 1, discs: 1 })
    const [dg] = await discogs.search(q, opts("token"))
    expect(dg.position).toEqual({ track: "1", disc: 1, discs: 2 })
    expect(dg.releases?.[0].position).toEqual({ track: "1", disc: 1, discs: 2 })
    const [it] = await itunes.search(q, opts())
    expect(it.position).toEqual({ track: "1", disc: 1, discs: 1 })
  })
})

const ai = (p: Partial<AiParse>): AiParse => ({ artists: [], featuring: [], title: "", confidence: 0.9, reasoning: "", alternatives: [], searchQueries: [], provider: "t", model: "m", ...p })
const hit = (source: Candidate["source"], album: string, extra: Partial<Candidate> = {}): Candidate => ({ source, sourceLabel: source === "musicbrainz" ? "MusicBrainz" : source, artist: "Gregory Isaacs", title: "Night Nurse", album, ...extra })
const decide = (candidates: Candidate[], filename = "Gregory Isaacs - Night Nurse.mp3") =>
  scoreTrack({
    heuristic: parseFilename(filename),
    ai: ai({ artists: ["Gregory Isaacs"], title: "Night Nurse" }),
    tags: {},
    candidates,
    duration: null,
    weights: { musicbrainz: 1, deezer: 0.8, itunes: 0.85 },
    thresholds: { autoThreshold: 90, reviewThreshold: 60, parseOnlyMax: 75 },
    context: { filename, folders: [], preferOwnRelease: true },
  })

describe("the decision", () => {
  it("notes where the track sits on the album it's given", () => {
    const album = { source: "musicbrainz" as const, title: "Night Nurse", kind: "album" as const, own: true, position: { track: "1", disc: 1, discs: 1 } }
    const d = decide([hit("musicbrainz", "Night Nurse", { releases: [album] }), hit("deezer", "Night Nurse"), hit("itunes", "Night Nurse", { position: { track: "9" } })])
    expect(d.album).toBe("Night Nurse")
    expect(d.position).toEqual({ track: "1", disc: 1, discs: 1, from: "MusicBrainz" })
    // No number on the chosen release: a hit on the same album that has one.
    const d2 = decide([hit("musicbrainz", "Night Nurse"), hit("deezer", "Night Nurse"), hit("itunes", "Night Nurse", { position: { track: "9" } })])
    expect(d2.position).toEqual({ track: "9", from: "itunes" })
    // A number from another album is never used.
    expect(decide([hit("musicbrainz", "Night Nurse"), hit("deezer", "Night Nurse"), hit("itunes", "Reggae Greats", { position: { track: "4" } })]).position).toBeUndefined()
  })
})

describe("Dee's {position} - {title}", () => {
  it("numbers the files that don't say, from the release, and leaves the ones that do", async () => {
    for (const f of ["Gregory Isaacs - Night Nurse.mp3", "Gregory Isaacs - Cool Down The Pace.mp3"]) writeMp3(path.join(dir, f))
    const ctx = { job: { id: "j" }, log: () => {}, signal: new AbortController().signal, setTotal: () => {}, tick: () => {}, message: () => {}, tracksChanged: () => {}, filesChanged: () => {}, report: () => {} } as unknown as JobContext
    const settings: Settings = structuredClone({ ...DEFAULT_SETTINGS, safety: { readOnly: false }, naming: { ...DEFAULT_SETTINGS.naming, template: "{position} - {title}" } })
    await scanLibrary(repo.addLibrary(dir, "Dad's records"), settings, ctx)
    const [cool, nurse] = repo.queryTracks({ sort: "filename", dir: "asc" }).items.map((t) => t.id)
    const decision = (title: string, track: string) => ({ artists: ["Gregory Isaacs"], featuring: [], artist: "Gregory Isaacs", title, album: "Night Nurse", position: { track, from: "MusicBrainz" }, confidence: 95, status: "matched", basis: "sources", factors: [], clusters: [], warnings: [] }) as unknown as Decision
    repo.updateTrack(nurse, { decision: decision("Night Nurse", "1"), status: "approved", final: { artists: ["Gregory Isaacs"], featuring: [], title: "Night Nurse", album: "Night Nurse" } })
    // This one's file already says it's track 7: that stays.
    repo.updateTrack(cool, { decision: decision("Cool Down The Pace", "2"), status: "approved", final: { artists: ["Gregory Isaacs"], featuring: [], title: "Cool Down The Pace", album: "Night Nurse" }, tags: { track: 7 } })

    expect(proposedFilename(repo.getTrack(nurse)!, settings)).toBe("01 - Night Nurse.mp3")
    expect(proposedFilename(repo.getTrack(cool)!, settings)).toBe("07 - Cool Down The Pace.mp3")
    // The track number goes into the file too, where it has none.
    const plan = buildPlan(repo.getTracks([nurse, cool]), settings)
    expect(plan[0].tags.track).toBe(1)
    expect(plan[1].tagChanges.map((c) => c.field)).not.toContain("track")

    // Filed under another album than the release the number comes from: no number.
    repo.updateTrack(nurse, { final: { artists: ["Gregory Isaacs"], featuring: [], title: "Night Nurse", album: "Reggae Greats" } })
    expect(proposedFilename(repo.getTrack(nurse)!, settings)).toBe("Night Nurse.mp3")
  })
})
