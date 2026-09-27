import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { FinalMeta, Settings } from "../../shared/types"
import { collectionContext } from "../ai/interpreter"
import { bpmRange, decadeOf, initialOf, renderFolderTemplate, unknownFolderTokens } from "../core/folders"
import { openDb, setDb } from "../db"
import { duplicateGroups, rankCopies, setAside, validResolutions } from "../duplicates"
import { buildPlan, executePlan, rewind } from "../executor"
import type { JobContext } from "../jobs"
import { settingsForLibrary } from "../library-settings"
import { executeOrganise, planOrganise } from "../organise"
import { proposedFilename } from "../placement"
import * as repo from "../repo"
import { scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS } from "../settings"
import { writeMp3, writeWav } from "./fixtures"

let dir: string
const settings: Settings = structuredClone({ ...DEFAULT_SETTINGS, safety: { readOnly: false } })

function ctx(): JobContext & { files: boolean } {
  const job = { id: "t", kind: "organise", status: "running", label: "t", total: 0, done: 0, failed: 0, message: null, createdAt: "", startedAt: null, finishedAt: null } as JobContext["job"]
  const c = {
    job,
    files: false,
    signal: new AbortController().signal,
    setTotal: (n: number) => void (job.total = n),
    tick: (ok = true) => void (ok ? job.done++ : job.failed++),
    message: () => {},
    log: () => {},
    tracksChanged: () => {},
    filesChanged: () => void (c.files = true),
    report: () => {},
  }
  return c
}

function put(rel: string, kind: "mp3" | "wav" = "mp3", frames = 60) {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (kind === "wav") writeWav(file)
  else writeMp3(file, frames)
  return file
}

function approve(file: string, meta: Partial<FinalMeta>, status: "approved" | "done" = "done") {
  const t = repo.queryTracks({}).items.find((x) => x.path === file)!
  repo.updateTrack(t.id, { final: { artists: [], featuring: [], title: "", ...meta } as FinalMeta, status })
  return t.id
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-organise-"))
  setDb(openDb(":memory:"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("folder templates", () => {
  const values = { artist: "Chronixx", album: "Dread & Terrible", year: "2014", genre: "Reggae" }

  it("builds nested folders and drops optional parts without values", () => {
    expect(renderFolderTemplate("{artist}/[{year} - ]{album}", values)).toBe("Chronixx/2014 - Dread & Terrible")
    expect(renderFolderTemplate("{artist}/[{year} - ]{album}", { ...values, year: "" })).toBe("Chronixx/Dread & Terrible")
    // A level with nothing in it is skipped, or named "Unknown …" when asked.
    expect(renderFolderTemplate("{artist}/{album}", { artist: "Chronixx" })).toBe("Chronixx")
    expect(renderFolderTemplate("{artist}/{album}", { artist: "Chronixx" }, { missing: "unknown" })).toBe("Chronixx/Unknown Album")
    // A level's own tag missing: no folder for it, however the rest of the level reads.
    expect(renderFolderTemplate("{artist}/[{year} - ]{album}", { artist: "Buju Banton", year: "1993" })).toBe("Buju Banton")
    expect(renderFolderTemplate("{artist}/{year} - {album}", { artist: "Skepta", album: "Konnichiwa" }, { missing: "unknown" })).toBe("Skepta/Unknown Year")
    // Separators left behind by an empty optional part are tidied away.
    expect(renderFolderTemplate("{album}[ ({year})]", { album: "Konnichiwa" })).toBe("Konnichiwa")
  })

  it("keeps literal brackets and makes every level safe", () => {
    expect(renderFolderTemplate("[Singles]/{artist}", { artist: "AC/DC" })).toBe("[Singles]/AC-DC")
    expect(renderFolderTemplate("{artist}", { artist: "../../etc" })).toBe("etc")
    expect(renderFolderTemplate("{artist}: {album}", { artist: "Skepta", album: "Konnichiwa" })).toBe("Skepta - Konnichiwa")
    expect(renderFolderTemplate("", values)).toBe("")
  })

  it("points out tags that aren't folder tags, which are always empty", () => {
    expect(unknownFolderTokens("{Artist}/[{year} - ]{album}")).toEqual([])
    expect(unknownFolderTokens("{artst}/{title}/{title}")).toEqual(["artst", "title"])
    expect(renderFolderTemplate("{artist}/{title}", values)).toBe("Chronixx")
    expect(renderFolderTemplate("{artist}/{title}", values, { missing: "unknown" })).toBe("Chronixx/Unknown")
    // Names of built-in object properties are just unknown tags too.
    expect(unknownFolderTokens("{constructor}/{toString}/{TOSTRING}")).toEqual(["constructor", "toString"])
    expect(renderFolderTemplate("{constructor}/{artist}[ {valueOf}]", values, { missing: "unknown" })).toBe("Unknown/Chronixx")
  })

  it("has the helpers the layouts need", () => {
    expect(initialOf("The Specials")).toBe("S")
    expect(initialOf("2Pac")).toBe("0-9")
    expect(initialOf("Ásgeir")).toBe("A")
    expect(decadeOf(1993)).toBe("1990s")
    expect(bpmRange(139.6)).toBe("140-149")
    expect(bpmRange(null)).toBe("")
  })
})

describe("organise", () => {
  it("moves tracks into the layout, brings the cover along, tidies up and rewinds", async () => {
    const a = put("rips/ALBUM RIP/01 track.mp3")
    const b = put("rips/ALBUM RIP/02 track.mp3")
    fs.writeFileSync(path.join(dir, "rips/ALBUM RIP/cover.jpg"), "jpg")
    fs.writeFileSync(path.join(dir, "rips/ALBUM RIP/.DS_Store"), "junk")
    const single = put("loose/skepta shutdown.mp3")
    const lib = repo.addLibrary(dir, "Test")
    await scanLibrary(lib, settings, ctx())
    const ids = [
      approve(a, { artists: ["Chronixx"], title: "Here Comes Trouble", album: "Dread & Terrible", year: 2014 }),
      approve(b, { artists: ["Chronixx"], title: "Smile Jamaica", album: "Dread & Terrible", year: 2014 }),
      approve(single, { artists: ["Skepta"], title: "Shutdown" }),
    ]
    const req = { libraryId: lib.id, template: "{artist}/[{year} - ]{album}" }

    const { preview } = planOrganise(settings, req)
    expect(preview.counts).toMatchObject({ tracks: 3, moving: 3, blocked: 0, sidecars: 1, notReady: 0 })
    expect(preview.folders.map((f) => f.path)).toEqual(["Chronixx/2014 - Dread & Terrible", "Skepta"])
    expect(preview.folders[0].count).toBe(3) // two tracks and the cover

    // Read-only mode refuses to move anything.
    await expect(executeOrganise(DEFAULT_SETTINGS, req, ctx())).rejects.toThrow(/Read-only/)

    const run = ctx()
    await executeOrganise(settings, req, run)
    expect(run.job.failed).toBe(0)
    expect(run.files).toBe(true)
    const album = path.join(dir, "Chronixx", "2014 - Dread & Terrible")
    expect(fs.readdirSync(album).sort()).toEqual(["01 track.mp3", "02 track.mp3", "cover.jpg"])
    expect(fs.existsSync(path.join(dir, "Skepta", "skepta shutdown.mp3"))).toBe(true)
    // Emptied folders go (OS junk doesn't keep them alive).
    expect(fs.existsSync(path.join(dir, "rips"))).toBe(false)
    expect(fs.existsSync(path.join(dir, "loose"))).toBe(false)
    const moved = repo.getTrack(ids[0])!
    expect(moved.path).toBe(path.join(album, "01 track.mp3"))
    expect(moved.relDir).toBe("Chronixx/2014 - Dread & Terrible")
    expect(moved.status).toBe("done")

    // A second look finds nothing left to do.
    expect(planOrganise(settings, req).preview.counts).toMatchObject({ moving: 0, unchanged: 3 })

    const batch = repo.listBatches()[0]
    expect(batch.label).toBe("Organise")
    const rw = ctx()
    await rewind(null, batch.batchId, rw)
    expect(rw.job.failed).toBe(0)
    expect(fs.existsSync(a) && fs.existsSync(b) && fs.existsSync(single)).toBe(true)
    expect(fs.existsSync(path.join(dir, "rips/ALBUM RIP/cover.jpg"))).toBe(true)
    // The folders the organise created are gone again, and statuses are as they were.
    expect(fs.existsSync(path.join(dir, "Chronixx"))).toBe(false)
    expect(fs.existsSync(path.join(dir, "Skepta"))).toBe(false)
    expect(repo.getTrack(ids[0])!).toMatchObject({ path: a, relDir: "rips/ALBUM RIP", status: "done" })
  })

  it("leaves a folder's cover where it is when not all of its audio moves together", async () => {
    const a = put("mixed/one.mp3")
    put("mixed/two.mp3")
    fs.writeFileSync(path.join(dir, "mixed/folder.jpg"), "jpg")
    const lib = repo.addLibrary(dir, "Test")
    await scanLibrary(lib, settings, ctx())
    approve(a, { artists: ["Skepta"], title: "Shutdown" }) // two.mp3 isn't identified yet
    const { preview } = planOrganise(settings, { libraryId: lib.id })
    expect(preview.counts).toMatchObject({ moving: 1, sidecars: 0, notReady: 1 })
    await executeOrganise(settings, { libraryId: lib.id }, ctx())
    expect(fs.readdirSync(path.join(dir, "mixed")).sort()).toEqual(["folder.jpg", "two.mp3"])
  })

  it("blocks collisions instead of overwriting", async () => {
    const a = put("a/tune.mp3")
    const b = put("b/tune.mp3", "mp3", 30)
    put("Skepta/tune.mp3", "mp3", 20)
    const lib = repo.addLibrary(dir, "Test")
    await scanLibrary(lib, settings, ctx())
    approve(a, { artists: ["Skepta"], title: "Shutdown" })
    approve(b, { artists: ["Skepta"], title: "Shutdown" })
    const { preview } = planOrganise(settings, { libraryId: lib.id })
    expect(preview.counts.moving).toBe(0)
    expect(preview.blocked.map((m) => m.issues[0])).toEqual([expect.stringMatching(/already a "tune.mp3"/), expect.stringMatching(/already a "tune.mp3"/)])
  })

  it("moves into folders on cut when switched on, and rewinds the cut", async () => {
    const file = put("incoming/03 - chronixx - here comes trouble.wav", "wav")
    const lib = repo.addLibrary(dir, "Test")
    await scanLibrary(lib, settings, ctx())
    const id = approve(file, { artists: ["Chronixx"], title: "Here Comes Trouble", year: 2014 }, "approved")
    const s: Settings = { ...settings, organise: { ...settings.organise, onCut: true, template: "{artist}" } }
    const plan = buildPlan(repo.getTracks([id]), s)
    expect(plan[0]).toMatchObject({ toName: "Chronixx - Here Comes Trouble.wav", fromDir: "incoming", toDir: "Chronixx", blocked: false })
    const run = ctx()
    const batchId = await executePlan(plan, s, { dryRun: false }, run)
    const target = path.join(dir, "Chronixx", "Chronixx - Here Comes Trouble.wav")
    expect(fs.existsSync(target)).toBe(true)
    expect(fs.existsSync(path.join(dir, "incoming"))).toBe(false)
    expect(repo.getTrack(id)).toMatchObject({ path: target, relDir: "Chronixx", status: "done" })
    await rewind(null, batchId, ctx())
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.existsSync(path.join(dir, "Chronixx"))).toBe(false)
    expect(repo.getTrack(id)).toMatchObject({ path: file, relDir: "incoming", status: "approved" })
  })
})

describe("per-library settings", () => {
  it("lets a library use its own naming, folders and genres", async () => {
    const file = put("x.mp3")
    const lib = repo.addLibrary(dir, "Test")
    await scanLibrary(lib, settings, ctx())
    const id = approve(file, { artists: ["Skepta"], title: "Shutdown", year: 2016 }, "approved")
    expect(proposedFilename(repo.getTrack(id)!, settings)).toBe("Skepta - Shutdown.mp3")

    repo.updateLibrary(lib.id, { settings: { template: "{year} {artist} - {title}", genres: ["Grime"], organiseOnCut: true, folderTemplate: "{genre}/{artist}", bogus: 1 } as never })
    expect(repo.getLibrary(lib.id)!.settings).toEqual({ template: "{year} {artist} - {title}", genres: ["Grime"], organiseOnCut: true, folderTemplate: "{genre}/{artist}" })
    expect(proposedFilename(repo.getTrack(id)!, settings)).toBe("2016 Skepta - Shutdown.mp3")
    const s = settingsForLibrary(settings, lib.id)
    expect(collectionContext(s.llm)).toBe("Mostly Grime.")
    expect(s.organise).toMatchObject({ onCut: true, template: "{genre}/{artist}" })
    // The app's settings are untouched.
    expect(settings.naming.template).toBe("{artist} - {title}")

    // Clearing the overrides puts the library back on the app's settings.
    repo.updateLibrary(lib.id, { settings: {} })
    expect(proposedFilename(repo.getTrack(id)!, settings)).toBe("Skepta - Shutdown.mp3")
  })
})

describe("duplicates", () => {
  const summary = (over: Record<string, unknown>) =>
    ({ id: 1, ext: "mp3", codec: "MPEG 1 Layer 3", bitrate: 128000, duration: 240, status: "matched", art: null, path: "/m/a.mp3", filename: "a.mp3", proposedName: null, ...over }) as never

  it("keeps lossless over lossy, never a clipped copy, then the one already cut", () => {
    expect(rankCopies([summary({ id: 1 }), summary({ id: 2, ext: "flac", codec: "FLAC", bitrate: 900000 })]).best).toBe(2)
    expect(rankCopies([summary({ id: 1, bitrate: 320000, duration: 30 }), summary({ id: 2, bitrate: 128000 })]).best).toBe(2)
    const r = rankCopies([summary({ id: 1 }), summary({ id: 2, status: "done" })])
    expect(r.best).toBe(2)
    expect(r.reasons[2]).toMatch(/already cut/)
  })

  it("sets extra copies aside in the holding folder, out of scans, and rewinds", async () => {
    const keep = put("Skepta - Shutdown.mp3")
    fs.mkdirSync(path.join(dir, "old"))
    fs.copyFileSync(keep, path.join(dir, "old", "shutdown copy.mp3"))
    const lib = repo.addLibrary(dir, "Test")
    await scanLibrary(lib, settings, ctx())
    const groups = duplicateGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe("hash")
    const [best, other] = [groups[0].best, groups[0].tracks.find((t) => t.id !== groups[0].best)!.id]
    expect(repo.getTrack(best)!.path).toBe(keep) // shallower path wins between identical copies

    // Only copies of the kept track can be set aside.
    expect(validResolutions([{ keep: best, aside: [other, 999] }])).toEqual([{ keep: best, aside: [other] }])
    const run = ctx()
    await setAside([{ keep: best, aside: [other] }], settings, run)
    expect(run.job.failed).toBe(0)
    const held = path.join(dir, "Duplicates set aside", "old", "shutdown copy.mp3")
    expect(fs.existsSync(held)).toBe(true)
    expect(fs.existsSync(path.join(dir, "old"))).toBe(false)
    expect(repo.getTrack(other)).toMatchObject({ missing: true, path: held, aside: { from: path.join(dir, "old", "shutdown copy.mp3"), keptId: best } })
    expect(duplicateGroups()).toHaveLength(0)

    // A second run queued for the same copy leaves it where it is.
    const again = ctx()
    await setAside([{ keep: best, aside: [other] }], settings, again)
    expect(again.job.done).toBe(0)
    expect(repo.getTrack(other)!.path).toBe(held)

    // A rescan neither brings it back nor treats the held copy as new - even after renaming the holding folder.
    await scanLibrary(lib, settings, ctx())
    expect(repo.queryTracks({}).total).toBe(1)
    await scanLibrary(lib, { ...settings, duplicates: { holdingFolder: "Elsewhere" } }, ctx())
    expect(repo.queryTracks({}).total).toBe(1)

    await rewind(null, repo.listBatches()[0].batchId, ctx())
    expect(fs.existsSync(path.join(dir, "old", "shutdown copy.mp3"))).toBe(true)
    expect(fs.existsSync(path.join(dir, "Duplicates set aside"))).toBe(false)
    expect(repo.getTrack(other)).toMatchObject({ missing: false, aside: null, relDir: "old" })
  })
})
