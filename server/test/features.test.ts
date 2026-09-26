import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import jpeg from "jpeg-js"
import { PNG } from "pngjs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { formatBpm, formatKey, parseKey, toCamelot } from "../../shared/keys"
import type { Decision, Settings } from "../../shared/types"
import { analyseFile, listenWindow } from "../analysis/analyse"
import { applyAnalysis } from "../analysis"
import { estimateKey } from "../analysis/key"
import { estimateTempo } from "../analysis/tempo"
import { createApp } from "../app"
import { artToEmbed, artworkCandidates, cachedArt, findArtwork, storeArt } from "../art"
import { makeThumbnail, sniffImage } from "../art-image"
import { getDb as getDbForTest, MIGRATIONS, openDb, setDb } from "../db"
import { buildPlan, executePlan, rewind } from "../executor"
import type { JobContext } from "../jobs"
import * as repo from "../repo"
import { libraryHasChanges, readAudio, scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS } from "../settings"
import { readManagedTags, writeTags } from "../tagger"
import { restore, snapshot } from "../undo"
import { writeMp3 } from "./fixtures"
import { synthTrack, toWav } from "./synth"

let dir: string
const settings: Settings = structuredClone({ ...DEFAULT_SETTINGS, safety: { readOnly: false } })

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
  }
}

function jpegBytes(w: number, h: number, rgb: [number, number, number]) {
  const data = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4)
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, 90).data)
}

async function scanned(files: string[]) {
  for (const f of files) writeMp3(path.join(dir, f))
  const lib = repo.addLibrary(dir, "Test")
  await scanLibrary(lib, settings, ctx())
  return { lib, tracks: repo.queryTracks({}).items }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-test-"))
  setDb(openDb(":memory:"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe("key notation", () => {
  it("reads musical, Camelot and Open Key spellings", () => {
    expect(parseKey("Am")).toBe("Am")
    expect(parseKey("A minor")).toBe("Am")
    expect(parseKey("Bbm")).toBe("Bbm")
    expect(parseKey("A#m")).toBe("Bbm")
    expect(parseKey("F#")).toBe("F#")
    expect(parseKey("Gb")).toBe("F#")
    expect(parseKey("8A")).toBe("Am")
    expect(parseKey("8B")).toBe("C")
    expect(parseKey("1m")).toBe("Am")
    expect(parseKey("2d")).toBe("G")
    expect(parseKey("Cmaj")).toBe("C")
    expect(parseKey("")).toBeNull()
    expect(parseKey("banana")).toBeNull()
  })

  it("writes Camelot and tidy BPMs", () => {
    expect(toCamelot("Am")).toBe("8A")
    expect(toCamelot("F#m")).toBe("11A")
    expect(toCamelot("Eb")).toBe("5B")
    expect(formatKey("Am", "camelot")).toBe("8A")
    expect(formatBpm(140.04)).toBe("140")
    expect(formatBpm(139.6)).toBe("139.6")
    expect(formatBpm(null)).toBeNull()
  })
})

describe("BPM & key analysis", () => {
  const Am: [number, "m" | "M"][] = [
    [57, "m"],
    [62, "m"],
    [64, "M"],
    [57, "m"],
  ]
  const G: [number, "m" | "M"][] = [
    [55, "M"],
    [60, "M"],
    [62, "M"],
    [55, "M"],
  ]

  it.each([
    { bpm: 140, chords: Am, pattern: "four" as const, want: 140, key: "Am" },
    { bpm: 172, chords: G, pattern: "breaks" as const, want: 172, key: "G" },
    // A one-drop at 75 reads as 150 in the default 88–176 range, as DJ software counts it.
    { bpm: 75, chords: Am, pattern: "onedrop" as const, want: 150, key: "Am" },
  ])("hears $bpm BPM in $key", ({ bpm, chords, pattern, want, key }) => {
    const x = synthTrack({ bpm, chords, pattern, seconds: 40, sampleRate: 11025 })
    const tempo = estimateTempo(x, 11025, 88)
    expect(tempo.bpm).toBeGreaterThan(want - 0.6)
    expect(tempo.bpm).toBeLessThan(want + 0.6)
    expect(estimateKey(x, 11025).key).toBe(key)
  })

  it("copes with a rip that runs sharp", () => {
    const x = synthTrack({ bpm: 96, chords: Am, pattern: "four", seconds: 40, sampleRate: 11025, detuneCents: 35 })
    const k = estimateKey(x, 11025)
    expect(k.key).toBe("Am")
    expect(k.tuningCents).toBeGreaterThan(20)
  })

  it("decodes a file and skips the intro", async () => {
    const file = path.join(dir, "tune.wav")
    fs.writeFileSync(file, toWav(synthTrack({ bpm: 128, chords: G, seconds: 50 })))
    expect(listenWindow(300)).toEqual({ from: 45, seconds: 90 })
    const a = await analyseFile({ file, ext: "wav", duration: 50, bpmMin: 88 })
    expect(Math.round(a.bpm!)).toBe(128)
    expect(a.key).toBe("G")
    expect(a.seconds).toBeGreaterThan(30)
  })

  it("fills tempo/key but never overrides tags or your edits", () => {
    const base = { bpm: null, key: null, analysis: null } as unknown as Parameters<typeof applyAnalysis>[0]
    const result = { bpm: 140, key: "Am", bpmConfidence: 1, keyConfidence: 1, seconds: 60, analyzedAt: "" }
    expect(applyAnalysis(base, result)).toMatchObject({ bpm: 140, key: "Am" })
    const tagged = { ...base, bpm: 70, key: "C" }
    expect(applyAnalysis(tagged, result)).not.toHaveProperty("bpm")
    const reanalysed = { ...base, bpm: 139, key: "Em", analysis: { ...result, bpm: 139, key: "Em" } }
    expect(applyAnalysis(reanalysed, result)).toMatchObject({ bpm: 140, key: "Am" })
  })
})

describe("artwork", () => {
  it("identifies images and makes square thumbnails", () => {
    const j = jpegBytes(300, 200, [200, 30, 30])
    expect(sniffImage(j)).toEqual({ mime: "image/jpeg", width: 300, height: 200 })
    const png = new PNG({ width: 40, height: 50 })
    png.data.fill(128)
    const pngBytes = new Uint8Array(PNG.sync.write(png))
    expect(sniffImage(pngBytes)).toEqual({ mime: "image/png", width: 40, height: 50 })
    const thumb = makeThumbnail(j, 160)!
    expect(sniffImage(thumb)).toMatchObject({ mime: "image/jpeg", width: 160, height: 160 })
    const decoded = jpeg.decode(thumb)
    expect(decoded.data[0]).toBeGreaterThan(150) // still red
    expect(makeThumbnail(pngBytes, 64)).not.toBeNull()
    expect(makeThumbnail(new Uint8Array([1, 2, 3]), 64)).toBeNull()
  })

  it("stores covers once by content", () => {
    const j = jpegBytes(64, 64, [0, 128, 0])
    const a = storeArt(j, "itunes", "https://example.com/a.jpg")!
    const b = storeArt(j, "deezer")!
    expect(a.hash).toBe(b.hash)
    expect(cachedArt(a.hash)?.length).toBe(j.length)
    expect(cachedArt("../../etc/passwd")).toBeNull()
  })

  it("picks covers only from hits that match the track, best source first", async () => {
    const { tracks } = await scanned(["tenor saw - ring the alarm.mp3"])
    const hit = (source: "itunes" | "musicbrainz", title: string, artwork: string) => ({ source, sourceLabel: source, artist: "Tenor Saw", title, artwork })
    const decision = {
      artists: ["Tenor Saw"],
      featuring: [],
      artist: "Tenor Saw",
      title: "Ring The Alarm",
      confidence: 92,
      status: "matched",
      basis: "sources",
      factors: [],
      warnings: [],
      clusters: [
        { artist: "Tenor Saw", title: "Ring The Alarm", sources: ["itunes", "musicbrainz"], support: 2, relevance: 1, candidates: [hit("itunes", "Ring the Alarm", "https://img/itunes.jpg"), hit("musicbrainz", "Ring The Alarm", "https://img/caa.jpg")] },
        { artist: "Tenor Saw", title: "Pumpkin Belly", sources: ["itunes"], support: 1, relevance: 0.3, candidates: [hit("itunes", "Pumpkin Belly", "https://img/wrong.jpg")] },
      ],
    } as unknown as Decision
    repo.updateTrack(tracks[0].id, { decision })
    const t = repo.getTrack(tracks[0].id)!
    expect(artworkCandidates(t).map((c) => c.url)).toEqual(["https://img/caa.jpg", "https://img/itunes.jpg"])
    expect(artworkCandidates(t)[0].label).toBe("musicbrainz")

    // The first URL fails, the second serves an image.
    const cover = jpegBytes(500, 500, [10, 20, 200])
    const fetch = vi.fn(async (url: string | URL | Request) => (String(url).includes("caa") ? new Response("nope", { status: 404 }) : new Response(cover, { status: 200 })))
    vi.stubGlobal("fetch", fetch)
    const found = await findArtwork(t, settings)
    expect(found).toMatchObject({ source: "itunes", width: 500, height: 500, url: "https://img/itunes.jpg" })
    expect(fetch).toHaveBeenCalledTimes(2)

    repo.updateTrack(t.id, { artFound: found })
    const withArt = repo.getTrack(t.id)!
    expect(artToEmbed(withArt, settings)?.hash).toBe(found!.hash)
    expect(artToEmbed(withArt, { ...settings, artwork: { ...settings.artwork, embed: false } })).toBeNull()
    expect(artToEmbed({ ...withArt, art: { ...found!, hash: "other" } }, settings)).toBeNull()
  })
})

describe("tags: BPM, key and cover", () => {
  it("round-trips through the file and is reversible", async () => {
    const file = path.join(dir, "a.mp3")
    writeMp3(file)
    const cover = storeArt(jpegBytes(120, 120, [250, 200, 0]), "itunes")!
    writeTags(file, { bpm: 140.4, key: "Am", cover: cover.hash })
    const back = readManagedTags(file)
    expect(back).toMatchObject({ bpm: 140, key: "Am", cover: cover.hash })
    const scanned = await readAudio(file)
    expect(scanned.tags).toMatchObject({ bpm: 140, key: "Am", cover: cover.hash })
    expect(scanned.art).toMatchObject({ hash: cover.hash, width: 120, source: "embedded" })
    writeTags(file, { bpm: null, key: null, cover: null })
    expect(readManagedTags(file)).toMatchObject({ bpm: undefined, key: undefined, cover: undefined })
  })

  it("cuts tempo, key and artwork into files and rewinds them", async () => {
    const { tracks } = await scanned(["skepta - shutdown.mp3"])
    const id = tracks[0].id
    const cover = storeArt(jpegBytes(200, 200, [30, 30, 30]), "deezer")!
    repo.updateTrack(id, { final: { artists: ["Skepta"], featuring: [], title: "Shutdown" }, status: "approved", bpm: 140, key: "F#m", artFound: cover })
    const camelot = { ...settings, analysis: { ...settings.analysis, keyNotation: "camelot" as const } }
    const plan = buildPlan(repo.getTracks([id]), camelot)
    expect(plan[0].tagChanges.map((c) => c.field).sort()).toEqual(["artist", "bpm", "cover", "key", "title"])
    const batch = await executePlan(plan, camelot, { dryRun: false }, ctx())
    const done = repo.getTrack(id)!
    expect(done.art?.hash).toBe(cover.hash)
    expect(done.artFound).toBeNull()
    expect(readManagedTags(done.path)).toMatchObject({ bpm: 140, key: "11A", cover: cover.hash })

    await rewind(null, batch, ctx())
    const back = repo.getTrack(id)!
    expect(readManagedTags(back.path).cover).toBeUndefined()
    expect(back.art).toBeNull()
    expect(back.artFound?.hash).toBe(cover.hash)
  })
})

describe("undo and bulk edit", () => {
  it("puts an approval (and what it taught) back", async () => {
    const { tracks } = await scanned(["kano - ps and qs.mp3"])
    const t = repo.getTrack(tracks[0].id)!
    const undoId = snapshot("Approve", [t.id], [t.filename])!
    repo.updateTrack(t.id, { status: "approved", final: { artists: ["Kano"], featuring: [], title: "P's & Q's" } })
    repo.addCorrection(t.filename, ["Kano"], "P's & Q's")
    expect(repo.listCorrections()).toHaveLength(1)
    expect(restore(undoId)?.ids).toEqual([t.id])
    const back = repo.getTrack(t.id)!
    expect(back.status).toBe("new")
    expect(back.final).toBeNull()
    expect(repo.listCorrections()).toHaveLength(0)
    expect(restore(undoId)).toBeNull()
  })

  it("sets fields across tracks through the API, and undoes it", async () => {
    const { tracks } = await scanned(["wiley - wot do u call it.mp3", "dizzee rascal - i luv u.mp3"])
    const app = createApp()
    const call = (url: string, body?: unknown) =>
      app.request(url, { method: "POST", headers: { "x-dubplate": "1", "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })
    const res = await call("/api/tracks/bulk-edit", { ids: tracks.map((t) => t.id), changes: { album: "Grime Classics", label: "XL", year: 2003, bpm: 140, key: "8A" } })
    const out = (await res.json()) as { changed: number; skipped: number; undoId: string }
    expect(out).toMatchObject({ changed: 2, skipped: 0 })
    for (const t of repo.getTracks(tracks.map((x) => x.id))) {
      expect(t.final).toMatchObject({ album: "Grime Classics", label: "XL", year: 2003 })
      expect(t.final?.title).toBeTruthy()
      expect(t).toMatchObject({ bpm: 140, key: "Am" })
    }
    // Clearing a field with null.
    await call("/api/tracks/bulk-edit", { ids: [tracks[0].id], changes: { label: null } })
    expect(repo.getTrack(tracks[0].id)!.final?.label).toBeUndefined()

    expect((await call(`/api/undo/${out.undoId}`)).status).toBe(200)
    expect(repo.getTrack(tracks[1].id)).toMatchObject({ final: null, bpm: null, key: null })
    expect((await call(`/api/undo/${out.undoId}`)).status).toBe(410)
  })
})

describe("big libraries", () => {
  it("migrates a v1 database, moving bulky JSON aside", () => {
    const file = path.join(dir, "old.db")
    const old = new DatabaseSync(file)
    old.exec(MIGRATIONS[0])
    old.exec("PRAGMA user_version = 1")
    old.exec("INSERT INTO libraries (id, path, name) VALUES (1, '/music', 'Music')")
    const decision = JSON.stringify({ status: "matched", title: "T", artists: ["A"], clusters: [{ sources: ["discogs", "itunes"] }] })
    old.prepare("INSERT INTO tracks (library_id, path, original_path, rel_dir, filename, ext, size, mtime_ms, tags_json, decision_json, candidates_json, status) VALUES (1, '/music/a.mp3', '/music/a.mp3', '', 'a.mp3', 'mp3', 1, 1, ?, ?, '[]', 'matched')").run(
      JSON.stringify({ bpm: 128, key: "8A" }),
      decision
    )
    old.close()

    const db = openDb(file)
    setDb(db)
    const cols = (db.prepare("PRAGMA table_info(tracks)").all() as { name: string }[]).map((c) => c.name)
    expect(cols).not.toContain("decision_json")
    expect(cols).toEqual(expect.arrayContaining(["bpm", "musical_key", "art_json", "art_found_json", "top_sources", "tags_version"]))
    const t = repo.getTrack(1)!
    expect(t.decision?.clusters[0].sources).toEqual(["discogs", "itunes"])
    expect(t).toMatchObject({ bpm: 128, key: "Am" })
    expect(repo.stats().sources).toEqual([
      { source: "discogs", hits: 1 },
      { source: "itunes", hits: 1 },
    ])
    expect(repo.listLibraries()[0]).toMatchObject({ watch: false, watchState: "off" })
    db.close()
  })

  it("lists pages with the right reading and order", async () => {
    const { tracks } = await scanned(["b.mp3", "a.mp3", "c.mp3"])
    const [b, a] = [tracks.find((t) => t.filename === "b.mp3")!, tracks.find((t) => t.filename === "a.mp3")!]
    repo.updateTrack(a.id, { decision: { artists: ["Dec"], title: "Decided", status: "conflict", clusters: [{ sources: ["itunes"] }] } as unknown as Decision })
    repo.updateTrack(b.id, { final: { artists: ["Me"], featuring: [], title: "Mine" }, bpm: 90 })
    const page = repo.queryTracks({ sort: "filename", limit: 2 })
    expect(page.total).toBe(3)
    expect(page.items.map((t) => t.filename)).toEqual(["a.mp3", "b.mp3"])
    expect(page.items[0]).toMatchObject({ proposedArtist: "Dec", proposedTitle: "Decided", sourceCount: 1, conflict: true })
    expect(page.items[1]).toMatchObject({ proposedArtist: "Me", proposedTitle: "Mine", bpm: 90 })
    expect(repo.queryTracks({ sort: "bpm", dir: "desc", limit: 1 }).items[0].id).toBe(b.id)
  })

  it("re-reads tags once for files scanned before covers, BPM and key were collected", async () => {
    const file = path.join(dir, "tagged.mp3")
    writeMp3(file)
    const cover = storeArt(jpegBytes(80, 80, [9, 99, 199]), "itunes")!
    writeTags(file, { bpm: 128, key: "8A", cover: cover.hash })
    const { lib, tracks } = await scanned([])
    const id = tracks[0].id
    // Pretend an older scanner read it: no cover, no tempo/key, old tags version.
    getDbForTest().prepare("UPDATE tracks SET tags_version = 0, art_json = NULL, bpm = NULL, musical_key = NULL WHERE id = ?").run(id)
    expect(await libraryHasChanges(lib, settings)).toBe(true)
    await scanLibrary(lib, settings, ctx())
    expect(repo.getTrack(id)).toMatchObject({ bpm: 128, key: "Am", art: { hash: cover.hash } })
    expect(await libraryHasChanges(lib, settings)).toBe(false)
  })

  it("notices new or changed files without a full scan", async () => {
    const { lib } = await scanned(["one.mp3"])
    expect(await libraryHasChanges(lib, settings)).toBe(false)
    writeMp3(path.join(dir, "two.mp3"))
    expect(await libraryHasChanges(lib, settings)).toBe(true)
    await scanLibrary(lib, settings, ctx())
    fs.rmSync(path.join(dir, "one.mp3"))
    expect(await libraryHasChanges(lib, settings)).toBe(true)
  })
})
