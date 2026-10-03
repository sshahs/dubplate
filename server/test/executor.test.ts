import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Settings } from "../../shared/types"
import { openDb, setDb } from "../db"
import { buildPlan, executePlan, rewind } from "../executor"
import type { JobContext } from "../jobs"
import * as repo from "../repo"
import { readAudio, scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS } from "../settings"
import { readManagedTags, writeTags } from "../tagger"
import { writeMp3, writeWav } from "./fixtures"

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-test-"))
  setDb(openDb(":memory:"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("scan → approve → execute → rewind", () => {
  it("renames and tags files, then puts everything back", async () => {
    fs.mkdirSync(path.join(dir, "Clashes"))
    const mp3 = path.join(dir, "Clashes", "12_buju_banton_vs_beenie_man_live_93_dubplate.mp3")
    const wav = path.join(dir, "03 - chronixx - here comes trouble.wav")
    writeMp3(mp3)
    writeWav(wav)
    const before = fs.readFileSync(mp3)

    const lib = repo.addLibrary(dir, "Test")
    const c = ctx()
    await scanLibrary(lib, settings, c)
    expect(c.job.done).toBe(2)

    const tracks = repo.queryTracks({}).items
    expect(tracks).toHaveLength(2)
    // Scanning must be read-only.
    expect(fs.readFileSync(mp3).equals(before)).toBe(true)

    const clash = tracks.find((t) => t.ext === "mp3")!
    const chronixx = tracks.find((t) => t.ext === "wav")!
    repo.updateTrack(clash.id, { final: { artists: ["Buju Banton", "Beenie Man"], relation: "vs", featuring: [], title: "Live Clash", version: "Dubplate", year: 1993 }, status: "approved" })
    repo.updateTrack(chronixx.id, { final: { artists: ["Chronixx"], featuring: [], title: "Here Comes Trouble" }, status: "approved" })

    const plan = buildPlan(repo.getTracks([clash.id, chronixx.id]), settings)
    expect(plan.map((p) => p.toName).sort()).toEqual(["Buju Banton vs Beenie Man - Live Clash (Dubplate).mp3", "Chronixx - Here Comes Trouble.wav"])
    expect(plan.every((p) => !p.blocked)).toBe(true)

    // Read-only mode refuses to write.
    await expect(executePlan(plan, DEFAULT_SETTINGS, { dryRun: false }, ctx())).rejects.toThrow(/Read-only/)

    const exec = ctx()
    const batchId = await executePlan(plan, settings, { dryRun: false }, exec)
    expect(exec.job.failed).toBe(0)
    const renamedMp3 = path.join(dir, "Clashes", "Buju Banton vs Beenie Man - Live Clash (Dubplate).mp3")
    expect(fs.existsSync(renamedMp3)).toBe(true)
    expect(fs.existsSync(mp3)).toBe(false)
    const tagged = await readAudio(renamedMp3)
    expect(tagged.tags.artist).toBe("Buju Banton vs Beenie Man")
    expect(tagged.tags.title).toBe("Live Clash (Dubplate)")
    expect(tagged.tags.year).toBe(1993)
    expect(repo.getTrack(clash.id)!.status).toBe("done")

    const rw = ctx()
    await rewind(null, batchId, rw)
    expect(rw.job.failed).toBe(0)
    expect(fs.existsSync(mp3)).toBe(true)
    expect(fs.existsSync(wav)).toBe(true)
    const restored = await readAudio(mp3)
    expect(restored.tags.artist).toBeUndefined()
    expect(restored.tags.title).toBeUndefined()
    expect(repo.getTrack(clash.id)!.path).toBe(mp3)
  })

  it("writes the riddim, and never over a Grouping the file already has", async () => {
    const plain = path.join(dir, "tenor saw - ring the alarm.mp3")
    const crated = path.join(dir, "sister nancy - bam bam.mp3")
    writeMp3(plain)
    writeMp3(crated)
    writeTags(crated, { grouping: "Selecta crate" })
    const lib = repo.addLibrary(dir, "Test")
    await scanLibrary(lib, settings, ctx())
    const [a, b] = ["tenor saw", "sister nancy"].map((n) => repo.queryTracks({}).items.find((t) => t.filename.startsWith(n))!)
    expect(b.tags.grouping).toBe("Selecta crate")
    // As if scanned before Dubplate read Grouping: the plan can't know it's there, the cut has to look.
    repo.updateTrack(b.id, { tags: { ...b.tags, grouping: undefined } })
    repo.updateTrack(a.id, { final: { artists: ["Tenor Saw"], featuring: [], title: "Ring The Alarm", riddim: "Stalag" }, status: "approved" })
    repo.updateTrack(b.id, { final: { artists: ["Sister Nancy"], featuring: [], title: "Bam Bam", riddim: "Stalag" }, status: "approved" })
    const plan = buildPlan(repo.getTracks([a.id, b.id]), settings)
    expect(plan.find((p) => p.trackId === b.id)!.tagChanges.map((c) => c.field)).toContain("grouping")
    const batchId = await executePlan(plan, settings, { dryRun: false }, ctx())
    const after = (id: number) => readManagedTags(repo.getTrack(id)!.path)
    expect(after(a.id)).toMatchObject({ riddim: "Stalag", grouping: "Stalag" })
    expect(after(b.id)).toMatchObject({ riddim: "Stalag", grouping: "Selecta crate" })
    expect(repo.getTrack(b.id)!.tags.grouping).toBe("Selecta crate")
    await rewind(null, batchId, ctx())
    expect(readManagedTags(plain)).toMatchObject({ riddim: undefined, grouping: undefined })
    expect(readManagedTags(crated)).toMatchObject({ riddim: undefined, grouping: "Selecta crate" })
  })

  it("blocks collisions instead of overwriting", async () => {
    const a = path.join(dir, "skepta_shutdown.mp3")
    const b = path.join(dir, "Skepta - Shutdown (1).mp3")
    writeMp3(a)
    writeMp3(b, 30)
    const lib = repo.addLibrary(dir, "Test")
    await scanLibrary(lib, settings, ctx())
    for (const t of repo.queryTracks({}).items) {
      repo.updateTrack(t.id, { final: { artists: ["Skepta"], featuring: [], title: "Shutdown" }, status: "approved" })
    }
    const plan = buildPlan(repo.getTracks(repo.queryTrackIds({})), settings)
    expect(plan.every((p) => p.blocked)).toBe(true)
    expect(plan[0].issues.join(" ")).toMatch(/same name/)
  })

  it("follows files moved outside Dubplate by content hash", async () => {
    const a = path.join(dir, "tune.mp3")
    writeMp3(a)
    const lib = repo.addLibrary(dir, "Test")
    await scanLibrary(lib, settings, ctx())
    const id = repo.queryTracks({}).items[0].id
    fs.mkdirSync(path.join(dir, "moved"))
    fs.renameSync(a, path.join(dir, "moved", "tune.mp3"))
    await scanLibrary(lib, settings, ctx())
    // first rescan marks it missing and re-finds it in one pass
    const t = repo.getTrack(id)!
    expect(t.path).toBe(path.join(dir, "moved", "tune.mp3"))
  })
})
