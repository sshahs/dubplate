// A Discogs release named by its code: reading the code, matching files to the
// tracklist, pinning the release so it wins on every re-score, and filling in
// MusicBrainz's release editor with the whole release rather than one file.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Settings, Track } from "../../shared/types"
import { openDb, setDb } from "../db"
import { applyDiscogsRelease, lookupDiscogs, parseDiscogsCode } from "../discogs-code"
import { resetJobStateForTests, type JobContext } from "../jobs"
import { completeMbSubmission, startMbSubmission } from "../musicbrainz-seed"
import { scoreAndSave } from "../pipeline"
import * as repo from "../repo"
import { scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS } from "../settings"
import { writeMp3 } from "./fixtures"

let dir: string

function ctx(): JobContext {
  const job = { id: "t", kind: "process", status: "running", label: "t", total: 0, done: 0, failed: 0, message: null, createdAt: "", startedAt: null, finishedAt: null } as JobContext["job"]
  return {
    job,
    signal: new AbortController().signal,
    setTotal: () => {},
    tick: () => {},
    message: () => {},
    log: () => {},
    tracksChanged: () => {},
    filesChanged: () => {},
    report: () => {},
  }
}

function quiet(): Settings {
  const s = structuredClone(DEFAULT_SETTINGS)
  s.sources = Object.fromEntries(Object.entries(s.sources).map(([k, v]) => [k, { ...v, enabled: false }]))
  s.scrapers = []
  s.artwork.fetch = false
  s.lyrics.fetch = false
  s.analysis.onProcess = false
  return s
}

const RELEASE = {
  id: 123456,
  title: "Original Nuttah EP",
  year: 1994,
  released: "1994-11-00",
  country: "UK",
  artists: [{ name: "Shy FX", join: "&" }, { name: "UK Apachi" }],
  labels: [{ name: "Sound Of Underground Records", catno: "SOUR 008" }],
  formats: [{ name: "Vinyl", descriptions: ['12"', "33 ⅓ RPM", "EP"] }],
  genres: ["Electronic"],
  styles: ["Jungle"],
  images: [{ type: "primary", uri: "https://i.discogs.com/cover.jpg" }],
  identifiers: [{ type: "Barcode", value: "5 012345 678900" }],
  tracklist: [
    { position: "", title: "Side One", type_: "heading" },
    { position: "A", title: "Original Nuttah", duration: "6:12", type_: "track" },
    { position: "B1", title: "Original Nuttah (Remix)", duration: "5:40", type_: "track" },
    { position: "B2", title: "Gangsta Kid", duration: "5:01", type_: "track", artists: [{ name: "Shy FX" }] },
  ],
}

function stubDiscogs() {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input)
    const body = url.endsWith(`/releases/${RELEASE.id}`) ? RELEASE : url.endsWith("/masters/99") ? { main_release: RELEASE.id } : undefined
    if (!body) return new Response("{}", { status: 404 })
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-discogs-"))
  setDb(openDb(":memory:"))
  resetJobStateForTests()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

async function scanned(files: string[]): Promise<Track[]> {
  for (const f of files) writeMp3(path.join(dir, f))
  const lib = repo.addLibrary(dir, "Music")
  await scanLibrary(lib, quiet(), ctx())
  const tracks = repo.getTracks(repo.queryTracks({}).items.map((t) => t.id))
  return files.map((f) => tracks.find((t) => t.filename === f)!)
}

describe("Discogs codes", () => {
  it("reads links, [r…] and [m…] codes, bare numbers and catalogue numbers", () => {
    expect(parseDiscogsCode("https://www.discogs.com/release/123456-Shy-FX-Original-Nuttah")).toEqual({ kind: "release", id: 123456 })
    expect(parseDiscogsCode("https://www.discogs.com/Shy-FX-Original-Nuttah/release/123456")).toEqual({ kind: "release", id: 123456 })
    expect(parseDiscogsCode("https://www.discogs.com/master/99-Original-Nuttah")).toEqual({ kind: "master", id: 99 })
    expect(parseDiscogsCode("[r123456]")).toEqual({ kind: "release", id: 123456 })
    expect(parseDiscogsCode(" m99 ")).toEqual({ kind: "master", id: 99 })
    expect(parseDiscogsCode("123456")).toEqual({ kind: "release", id: 123456 })
    expect(parseDiscogsCode("SOUR 008")).toEqual({ kind: "catno", text: "SOUR 008" })
    expect(parseDiscogsCode("  ")).toBeNull()
  })

  it("looks a release up (a master by its main release) and matches each file to its track", async () => {
    stubDiscogs()
    const [a, b] = await scanned(["white label side a.mp3", "B2 gangsta kid.mp3"])
    const found = await lookupDiscogs("m99", [a, b], quiet())
    expect(found.release).toMatchObject({ id: RELEASE.id, title: "Original Nuttah EP", artist: "Shy FX & UK Apachi", label: "Sound Of Underground Records", catno: "SOUR 008", year: 1994, kind: "ep" })
    expect(found.release!.tracks.map((t) => t.position)).toEqual(["A", "B1", "B2"])
    // "Side A" in one name is the tune on side A; "B2" and the title both point at Gangsta Kid.
    expect(found.matches).toEqual([
      { trackId: a.id, filename: a.filename, index: 0 },
      { trackId: b.id, filename: b.filename, index: 2 },
    ])
  })

  it("pins the release: the file is approved with its details, and it wins on every re-score", async () => {
    stubDiscogs()
    const [t] = await scanned(["track 1.mp3"])
    const r = await applyDiscogsRelease(RELEASE.id, [{ trackId: t.id, index: 0 }], quiet())
    expect(r).toMatchObject({ applied: 1, skipped: 0 })
    const after = repo.getTrack(t.id)!
    expect(after.status).toBe("approved")
    expect(after.final).toMatchObject({ artists: ["Shy FX", "UK Apachi"], title: "Original Nuttah", album: "Original Nuttah EP", year: 1994, label: "Sound Of Underground Records" })
    expect(after.idsOverride?.discogsReleaseId).toBe(String(RELEASE.id))
    expect(after.decision?.release).toMatchObject({ reason: "you gave its Discogs code", release: { id: String(RELEASE.id) } })
    expect(after.decision?.position).toMatchObject({ track: "A" })
    // A search hit for another song doesn't take over.
    repo.updateTrack(t.id, {
      candidates: [...after.candidates!, { source: "musicbrainz", sourceLabel: "MusicBrainz", artist: "Someone Else", title: "Track 1", sourceScore: 1 }],
    })
    const again = scoreAndSave(repo.getTrack(t.id)!, quiet())
    expect(again.decision).toMatchObject({ title: "Original Nuttah", album: "Original Nuttah EP" })
  })

  it("fills in MusicBrainz with the whole release, each file in its place", async () => {
    stubDiscogs()
    const [t] = await scanned(["gangsta kid.mp3"])
    await applyDiscogsRelease(RELEASE.id, [{ trackId: t.id, index: 2 }], quiet())
    const seed = await startMbSubmission([t.id], "http://nas:4455", {}, quiet())
    expect(seed.release).toMatchObject({ id: RELEASE.id, tracks: 3, yours: [2] })
    expect(seed.fields).toMatchObject({
      name: "Original Nuttah EP",
      type: "ep",
      status: "official",
      "artist_credit.names.0.name": "Shy FX",
      "artist_credit.names.0.join_phrase": " & ",
      "artist_credit.names.1.name": "UK Apachi",
      "events.0.date.year": "1994",
      "events.0.date.month": "11",
      "events.0.country": "GB",
      "labels.0.name": "Sound Of Underground Records",
      "labels.0.catalog_number": "SOUR 008",
      barcode: "5012345678900",
      "mediums.0.format": '12" Vinyl',
      "mediums.0.track.0.name": "Original Nuttah",
      "mediums.0.track.0.number": "A",
      "mediums.0.track.0.length": "372000",
      "mediums.0.track.2.name": "Gangsta Kid",
      "mediums.0.track.2.number": "B2",
      "mediums.0.track.2.artist_credit.names.0.name": "Shy FX",
      "urls.0.url": `https://www.discogs.com/release/${RELEASE.id}`,
    })
    expect(seed.fields["mediums.1.track.0.name"]).toBeUndefined()
    expect(seed.fields.edit_note).toMatch(/B2: "gangsta kid.mp3"/)

    // Only the files can still be asked for.
    const files = await startMbSubmission([t.id], "http://nas:4455", { whole: false }, quiet())
    expect(files.release).toBeNull()
    expect(files.wholeAvailable).toMatchObject({ id: RELEASE.id })
    expect(files.fields["mediums.0.track.1.name"]).toBeUndefined()

    // The new release's recording for the file comes from its own place on it, not the first track.
    const mbid = "44444444-4444-4444-4444-444444444444"
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ id: mbid, title: "Original Nuttah EP", media: [{ tracks: [{ position: 1, title: "Original Nuttah", recording: { id: "r1" } }, { position: 2, title: "Remix", recording: { id: "r2" } }, { position: 3, title: "Gangsta Kid", recording: { id: "r3" } }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
    await completeMbSubmission(seed.submission.id, mbid)
    expect(repo.getTrack(t.id)!.idsOverride).toMatchObject({ mbReleaseId: mbid, mbRecordingId: "r3", discogsReleaseId: String(RELEASE.id) })
  })
})
