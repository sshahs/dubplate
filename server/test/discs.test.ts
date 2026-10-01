// Discs and sides: CD1/CD2, Disc 2, LP2, Side A/B and vinyl positions read
// from names and folders, whole sides in one file, and the disc and track
// numbers written for them (vinyl positions counting on across the sides).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Settings } from "../../shared/types"
import { describePosition, discMarker, multiDisc, trackOnDisc, trailingPart } from "../core/discs"
import { parseFilename } from "../core/filename-parser"
import { renderFolderTemplate } from "../core/folders"
import { pickRelease } from "../core/releases"
import { openDb, setDb } from "../db"
import { buildPlan, executePlan, rewind } from "../executor"
import type { JobContext } from "../jobs"
import { folderValues, metaFor } from "../placement"
import * as repo from "../repo"
import { folderContext, readAudio, scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS } from "../settings"
import { writeMp3 } from "./fixtures"

let dir: string

function ctx(): JobContext {
  const job = { id: "t", kind: "scan", status: "running", label: "t", total: 0, done: 0, failed: 0, message: null, createdAt: "", startedAt: null, finishedAt: null } as JobContext["job"]
  return {
    job,
    signal: new AbortController().signal,
    setTotal: (n) => void (job.total = n),
    tick: (ok = true) => void (ok ? job.done++ : job.failed++),
    message: () => {},
    log: () => {},
    tracksChanged: () => {},
    filesChanged: () => {},
    report: () => {},
  }
}

const settings: Settings = structuredClone({ ...DEFAULT_SETTINGS, safety: { readOnly: false } })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-discs-"))
  setDb(openDb(":memory:"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const parse = (file: string, folder = "") => parseFilename(file, { folders: folderContext(folder) })

describe("reading discs and sides", () => {
  it("knows a disc or side folder, and never takes it for the album or artist", () => {
    expect(discMarker("CD1")).toMatchObject({ disc: 1, label: "CD1" })
    expect(discMarker("Disc 2 - Bonus Tracks")).toMatchObject({ disc: 2 })
    expect(discMarker("CD 1 of 2")).toMatchObject({ disc: 1 })
    expect(discMarker("Disc Two")).toMatchObject({ disc: 2 })
    expect(discMarker("LP2")).toMatchObject({ disc: 2, label: "LP2" })
    expect(discMarker("Side B")).toMatchObject({ disc: 1, side: "B" })
    expect(discMarker("C-Side")).toMatchObject({ disc: 2, side: "C" })
    expect(discMarker("Side 2")).toMatchObject({ side: "B" })
    expect(discMarker("CD Collection")).toBeNull()
    expect(discMarker("Sideshow")).toBeNull()

    expect(parse("05 - Eskimo.mp3", "Wiley/Treddin On Thin Ice/CD2").position).toMatchObject({ disc: 2, number: 5 })
    expect(parse("A2 Ring The Alarm.mp3", "Tenor Saw/Side A").position).toMatchObject({ side: "A", number: 2 })
    // Side C of the second record, from "LP2/Side C".
    expect(parse("03 Track.mp3", "Album/LP2/Side C").position).toMatchObject({ disc: 2, side: "C", number: 3 })
  })

  it("reads positions at the start of a name", () => {
    expect(parse("A1-Tenor_Saw-Ring_The_Alarm.mp3")).toMatchObject({ artists: ["Tenor Saw"], title: "Ring The Alarm", position: { disc: 1, side: "A", number: 1 } })
    expect(parse("C1 - Barrington Levy - Here I Come.mp3")).toMatchObject({ artists: ["Barrington Levy"], position: { disc: 2, side: "C", number: 1 } })
    expect(parse("CD1-05 Wiley - Eskimo.mp3")).toMatchObject({ artists: ["Wiley"], title: "Eskimo", position: { disc: 1, number: 5 } })
    // Disc and track, the way many rippers write them; it used to land in the artist ("05 Wiley").
    expect(parse("1-05 Wiley - Eskimo.mp3")).toMatchObject({ artists: ["Wiley"], title: "Eskimo", position: { disc: 1, number: 5 } })
    expect(parse("2-11 Wiley - Wot Do U Call It.mp3")).toMatchObject({ artists: ["Wiley"], position: { disc: 2, number: 11 } })
    // Names that look like numbers stay names.
    expect(parse("50 Cent - In Da Club.mp3").artists).toEqual(["50 Cent"])
    expect(parse("1999 - Prince.mp3").position).toBeUndefined()
  })

  it("treats a file that's a whole side or disc as that part of a longer recording", () => {
    // Just "Side A": the folder says what it's a side of.
    expect(parse("Side A.mp3", "Stone Love vs Killamanjaro - Clash 1995")).toMatchObject({
      artists: ["Stone Love", "Killamanjaro"],
      relation: "vs",
      version: "Side A",
      position: { side: "A", whole: true },
    })
    expect(parse("Stone Love vs Killamanjaro - Clash 1995 (Side B).mp3")).toMatchObject({ title: "Clash", year: 1995, version: "Side B", position: { side: "B", whole: true } })
    expect(parse("Fabric 99 CD2.mp3")).toMatchObject({ title: "Fabric 99", version: "CD2", position: { disc: 2, whole: true } })
    // Clash and juggling tapes: a tape number, a side, a part.
    expect(parse("Bodyguard vs Killamanjaro (Tape 2 Side A).mp3")).toMatchObject({ artists: ["Bodyguard", "Killamanjaro"], version: "Tape 2 Side A", position: { disc: 2, side: "A", whole: true } })
    expect(parse("stone love 1995 juggling side b pt2.mp3")).toMatchObject({ version: "Side B Part 2", position: { side: "B", part: 2, whole: true } })
    expect(parse("Side A.mp3", "Saxon Sound - Lewisham 1985/Tape 2").position).toMatchObject({ disc: 2, side: "A", whole: true })
    expect(describePosition({ side: "B", part: 2, whole: true, label: "Side B Part 2" })).toBe("Part 2 of Side B")
    expect(trailingPart("B-Side Of Life")).toBeNull()
    expect(trailingPart("Here Comes Trouble")).toBeNull()
  })

  it("counts vinyl positions on across the sides of a record", () => {
    const sideA = [1, 2, 3, 4].map((n) => ({ side: "A", number: n, disc: 1 }))
    expect(trackOnDisc({ side: "B", number: 2, disc: 1 }, sideA)).toBe(6)
    expect(trackOnDisc({ side: "A", number: 3, disc: 1 }, [])).toBe(3)
    // Side C starts record 2 again at 1; with nothing known of side A, B can't be counted.
    expect(trackOnDisc({ side: "C", number: 1, disc: 2 }, sideA)).toBe(1)
    expect(trackOnDisc({ side: "B", number: 1, disc: 1 }, [])).toBeUndefined()
    expect(describePosition({ side: "B", number: 2, disc: 1 }, 6)).toBe("Side B · B2 · track 6")
    expect(describePosition({ disc: 2, number: 5 }, null, null, 2)).toBe("Disc 2 of 2 · track 5")
    expect(multiDisc({}, { side: "B", disc: 1 })).toBeUndefined()
    expect(multiDisc({}, { disc: 1, label: "CD1" })).toBe(1)
    expect(multiDisc({ disc: 1, discTotal: 1 })).toBeUndefined()
  })

  it("doesn't take a whole side for a DJ mix just because it's long", () => {
    const releases = [
      { source: "musicbrainz" as const, title: "Fever", kind: "album" as const, own: true, id: "fever" },
      { source: "musicbrainz" as const, title: "Reggae Mix", kind: "dj-mix" as const, own: false, id: "mix" },
    ]
    const base = { artists: ["Tenor Saw"], folders: [], duration: 22 * 60, filename: "Side A.mp3", fingerprintRecordings: new Set<string>(), preferOwn: true }
    expect(pickRelease(releases, base)?.release.id).toBe("mix")
    expect(pickRelease(releases, { ...base, wholeSide: true })?.release.id).toBe("fever")
  })
})

describe("disc and track numbers in the tags", () => {
  it("are written from names and folders, kept where the file has them, and rewound", async () => {
    const files = [
      "Tenor Saw - Fever/A1 Tenor Saw - Ring The Alarm.mp3",
      "Tenor Saw - Fever/A2 Tenor Saw - Lots Of Sign.mp3",
      "Tenor Saw - Fever/A3 Tenor Saw - Fever.mp3",
      "Tenor Saw - Fever/B1 Tenor Saw - Pumpkin Belly.mp3",
      "Tenor Saw - Fever/B2 Tenor Saw - Roll Call.mp3",
      "Wiley - Treddin On Thin Ice/CD1/01 Wiley - Eskimo.mp3",
      "Wiley - Treddin On Thin Ice/CD2/01 Wiley - Wot Do U Call It.mp3",
      "Wiley - Treddin On Thin Ice/CD2/02 Wiley - Ice Rink.mp3",
    ]
    for (const f of files) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true })
      writeMp3(path.join(dir, f))
    }
    const lib = repo.addLibrary(dir, "Music")
    await scanLibrary(lib, settings, ctx())
    const tracks = repo.getTracks(repo.queryTrackIds({}))
    expect(tracks).toHaveLength(files.length)
    for (const t of tracks) {
      const h = t.heuristic!
      repo.updateTrack(t.id, { final: { artists: h.artists, featuring: [], title: h.title, album: t.relDir.split(path.sep)[0].split(" - ")[1] }, status: "approved" })
    }
    const byName = (n: string) => repo.getTracks(repo.queryTrackIds({})).find((t) => t.filename.includes(n))!

    const plan = buildPlan(repo.getTracks(repo.queryTrackIds({})), settings)
    const tagsOf = (n: string) => plan.find((p) => p.fromName.includes(n))!.tags
    // Vinyl: one record, so no disc number; B2 comes after side A's three.
    expect(tagsOf("Ring The Alarm")).toMatchObject({ track: 1 })
    expect(tagsOf("Ring The Alarm").disc).toBeUndefined()
    expect(tagsOf("Roll Call")).toMatchObject({ track: 5 })
    // Two CDs: disc numbers, and the count, from the CD1/CD2 folders.
    expect(tagsOf("Ice Rink")).toMatchObject({ track: 2, disc: 2, discTotal: 2 })
    expect(tagsOf("Eskimo")).toMatchObject({ track: 1, disc: 1, discTotal: 2 })

    // The folder template's {disc} only shows for the two-disc album.
    const tpl = "{artist}/{album}/[Disc {disc}]"
    const eskimo = byName("Eskimo")
    expect(renderFolderTemplate(tpl, folderValues(eskimo, metaFor(eskimo)!, settings))).toBe("Wiley/Treddin On Thin Ice/Disc 1")
    const fever = byName("Pumpkin Belly")
    expect(renderFolderTemplate(tpl, folderValues(fever, metaFor(fever)!, settings))).toBe("Tenor Saw/Fever")

    const exec = ctx()
    const batch = await executePlan(plan, settings, { dryRun: false }, exec)
    expect(exec.job.failed).toBe(0)
    const iceRink = repo.getTrack(byName("Ice Rink").id)!
    expect((await readAudio(iceRink.path)).tags).toMatchObject({ track: 2, disc: 2, discTotal: 2 })
    expect((await readAudio(repo.getTrack(byName("Roll Call").id)!.path)).tags).toMatchObject({ track: 5 })

    // A track number the file already has is left alone.
    const again = buildPlan(repo.getTracks([iceRink.id]), settings)
    expect(again[0].tags.track).toBeUndefined()

    const rw = ctx()
    await rewind(null, batch, rw)
    expect(rw.job.failed).toBe(0)
    const back = await readAudio(path.join(dir, "Wiley - Treddin On Thin Ice/CD2/02 Wiley - Ice Rink.mp3"))
    expect(back.tags.track).toBeUndefined()
    expect(back.tags.disc).toBeUndefined()
  })
})
