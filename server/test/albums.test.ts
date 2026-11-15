// Albums: the tracks of one record tagged together and approved with one OK.
// The album most of the folder is on is found from the tracks' hits, read in full
// from MusicBrainz, each file placed on its tracklist (by recording, title, or
// its place and length), and the album's details and one cover put on all of them.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PNG } from "pngjs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Candidate, ReleaseInfo, Settings, Track } from "../../shared/types"
import { albumTrackIds, applyAlbum, keepAlbumsTogether, listAlbums, proposeAlbum, releaseAlbum } from "../albums"
import { tagsFor } from "../core/naming"
import { openDb, setDb } from "../db"
import { buildPlan } from "../executor"
import { resetJobStateForTests, type JobContext } from "../jobs"
import { scoreAndSave } from "../pipeline"
import * as repo from "../repo"
import { scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS } from "../settings"
import { mbFindAlbum, splitCredit } from "../sources/album-release"
import { writeMp3 } from "./fixtures"

const ALBUM = "ba41a7ba-1033-4e5f-bdf8-1a55551d0802"
const SINGLE = "11111111-2222-3333-4444-555555555555"
const COMP = "99999999-8888-7777-6666-555555555555"

/** MusicBrainz's release, as its web service gives it (three of its tracks). */
const MB_RELEASE = {
  id: ALBUM,
  title: "Boy in da Corner",
  date: "2003-07-21",
  country: "GB",
  status: "Official",
  "artist-credit": [{ name: "Dizzee Rascal", joinphrase: "", artist: { id: "dizzee", name: "Dizzee Rascal" } }],
  "release-group": { id: "rg-1", "primary-type": "Album", "secondary-types": [], genres: [{ name: "grime", count: 3 }, { name: "hip hop", count: 1 }] },
  "label-info": [{ "catalog-number": "XLCD170", label: { name: "XL Recordings" } }],
  "cover-art-archive": { front: true },
  media: [
    {
      position: 1,
      format: "CD",
      tracks: [
        { number: "1", position: 1, title: "Sittin’ Here", length: 245000, "artist-credit": [{ name: "Dizzee Rascal" }], recording: { id: "rec-1" } },
        { number: "2", position: 2, title: "Stop Dat", length: 220000, "artist-credit": [{ name: "Dizzee Rascal" }], recording: { id: "rec-2" } },
        { number: "3", position: 3, title: "I Luv U", "artist-credit": [{ name: "Dizzee Rascal", joinphrase: " feat. " }, { name: "Jeanine Jacques" }], recording: { id: "rec-3" } },
      ],
    },
  ],
}

function cover(): Buffer {
  const png = new PNG({ width: 48, height: 48 })
  for (let i = 0; i < png.data.length; i++) png.data[i] = (i * 7919) % 251
  return PNG.sync.write(png)
}

function stub() {
  const calls: string[] = []
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes(`coverartarchive.org/release/${ALBUM}`)) return new Response(new Uint8Array(cover()), { status: 200, headers: { "content-type": "image/png" } })
    if (url.includes(`/ws/2/release/${ALBUM}`)) return Response.json(MB_RELEASE)
    if (url.includes("/ws/2/release?query=")) return Response.json({ releases: [{ id: ALBUM, score: 100, title: "Boy in da Corner", status: "Official", date: "2003-07-21", "track-count": 15, "artist-credit": [{ name: "Dizzee Rascal" }] }] })
    return new Response("{}", { status: 404 })
  })
  return calls
}

function settings(): Settings {
  const s = structuredClone(DEFAULT_SETTINGS)
  s.sources = Object.fromEntries(Object.entries(s.sources).map(([k, v]) => [k, { ...v, enabled: k === "musicbrainz" }]))
  s.scrapers = []
  s.safety.readOnly = false
  s.artwork.fetch = false
  return s
}

const rel = (id: string, title: string, kind: ReleaseInfo["kind"], extra: Partial<ReleaseInfo> = {}): ReleaseInfo => ({ source: "musicbrainz", title, kind, own: true, id, artist: "Dizzee Rascal", status: "Official", date: "2003-07-21", ...extra })
const mbHit = (title: string, recording: string, releases: ReleaseInfo[]): Candidate => ({
  source: "musicbrainz",
  sourceLabel: "MusicBrainz",
  artist: "Dizzee Rascal",
  artists: ["Dizzee Rascal"],
  title,
  album: releases[0]?.title,
  url: `https://musicbrainz.org/recording/${recording}`,
  externalId: recording,
  ids: { mbRecordingId: recording, mbReleaseId: releases[0]?.id, mbArtistIds: ["dizzee"] },
  sourceScore: 1,
  releases: releases.map((r) => ({ ...r, recordingId: recording })),
})

let dir: string
const ctx = () => ({ job: { id: "j" }, log: () => {}, signal: new AbortController().signal, setTotal: () => {}, tick: () => {}, message: () => {}, tracksChanged: () => {}, filesChanged: () => {}, report: () => {} }) as unknown as JobContext

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-albums-"))
  setDb(openDb(":memory:"))
  resetJobStateForTests()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

/**
 * A folder of the album, each track decided on its own: the first track's best hit
 * is the album, the second's the single (the album's among its releases, spelt
 * differently), and the third ("Track 03") nobody found.
 */
async function albumFolder(): Promise<Track[]> {
  const folder = path.join(dir, "Dizzee Rascal", "Boy In Da Corner (2003)")
  fs.mkdirSync(folder, { recursive: true })
  for (const f of ["01 - Dizzee Rascal - Sittin Here.mp3", "02 - Dizzee Rascal - Stop Dat.mp3", "03 - Track 03.mp3"]) writeMp3(path.join(folder, f))
  const lib = repo.addLibrary(dir, "Music")
  await scanLibrary(lib, settings(), ctx())
  const [a, b, c] = repo.queryTracks({ sort: "filename", dir: "asc" }).items.map((t) => repo.getTrack(t.id)!)
  repo.updateTrack(a.id, { candidates: [mbHit("Sittin' Here", "rec-1", [rel(ALBUM, "Boy in da Corner", "album"), rel(COMP, "Grime Classics", "compilation", { own: false, artist: "Various Artists" })])] })
  repo.updateTrack(b.id, { candidates: [mbHit("Stop Dat", "rec-2", [rel(SINGLE, "Stop Dat", "single", { date: "2003-05-01", label: "XL" }), rel(ALBUM, "Boy In Da Corner", "album")])] })
  for (const t of [a, b, c]) scoreAndSave(repo.getTrack(t.id)!, settings())
  return [a, b, c].map((t) => repo.getTrack(t.id)!)
}

describe("albums", () => {
  it("credits the release's guests as featuring", () => {
    expect(splitCredit([{ name: "Dizzee Rascal", joinphrase: " feat. " }, { name: "Jeanine Jacques" }])).toEqual({ artists: ["Dizzee Rascal"], featuring: ["Jeanine Jacques"] })
    expect(splitCredit([{ name: "A", joinphrase: " & " }, { name: "B" }])).toEqual({ artists: ["A", "B"], featuring: [] })
  })

  it("finds an album on MusicBrainz by its name and artist, an official one of about the folder's size", async () => {
    stub()
    expect(await mbFindAlbum("Boy in da Corner", "Dizzee Rascal", 15)).toBe(ALBUM)
  })

  it("lists a folder whose tracks go by one album", async () => {
    stub()
    await albumFolder()
    // Each track decided on its own: the tracks don't agree yet.
    const [a, b] = repo.queryTracks({ sort: "filename", dir: "asc" }).items.map((t) => repo.getTrack(t.id)!)
    expect(a.decision?.album).toBe("Boy in da Corner")
    expect(b.decision?.album).not.toBe(a.decision?.album)
    // The folder's tags name the album on all three: it's listed, by the name most of them go by.
    const tagged = repo.queryTracks({}).items.map((t) => t.id)
    for (const id of tagged) repo.updateTrack(id, { tags: { ...repo.getTrack(id)!.tags, album: "Boy In Da Corner" } })
    expect(listAlbums()).toMatchObject([{ folder: path.join("Dizzee Rascal", "Boy In Da Corner (2003)"), title: expect.stringMatching(/^boy in da corner$/i), tracks: 3, toApprove: 3, locked: false }])
  })

  it("proposes the album most of the tracks are on, read in full, with each file placed on it", async () => {
    stub()
    const [a, b, c] = await albumFolder()
    expect(albumTrackIds(c.id).sort()).toEqual([a.id, b.id, c.id].sort())
    const p = await proposeAlbum([a.id, b.id, c.id], settings())
    expect(p.options[0]).toMatchObject({ key: "boy in da corner", covers: 2, release: `musicbrainz:${ALBUM}` })
    expect(p.release).toMatchObject({ title: "Boy in da Corner", artist: "Dizzee Rascal", label: "XL Recordings", catno: "XLCD170", year: 2003, discs: 1 })
    expect(p.fields).toEqual({ title: "Boy in da Corner", albumArtist: "Dizzee Rascal", year: 2003, label: "XL Recordings", genre: "Grime" })
    // By the recording its hit found, by title, and "Track 03" by its place.
    expect(p.matches).toEqual([
      { trackId: a.id, index: 0, by: "recording" },
      { trackId: b.id, index: 1, by: "recording" },
      { trackId: c.id, index: 2, by: "place" },
    ])
    expect(p.artwork[0]).toBe(`https://coverartarchive.org/release/${ALBUM}/front-1200`)
  })

  it("approves the whole album with one OK: the same album details, numbers and cover on every track", async () => {
    stub()
    const [a, b, c] = await albumFolder()
    const p = await proposeAlbum([a.id, b.id, c.id], settings())
    const r = await applyAlbum(
      { trackIds: [a.id, b.id, c.id], release: `musicbrainz:${ALBUM}`, fields: p.fields, matches: p.matches, artworkUrl: p.artwork[0], approve: true, by: "person" },
      settings()
    )
    expect(r).toMatchObject({ tracks: 3, approved: 3, skipped: 0 })
    const after = [a, b, c].map((t) => repo.getTrack(t.id)!)
    for (const t of after) {
      expect(t.status).toBe("approved")
      expect(t.approvedBy).toBe("person")
      expect(t.final).toMatchObject({ album: "Boy in da Corner", albumArtist: "Dizzee Rascal", year: 2003, label: "XL Recordings", genre: "Grime" })
      expect(t.artFound?.hash).toBe(r.art!.hash)
      expect(t.artFound?.confirmed).toBe(true)
    }
    // "Track 03" is named from the release, guest and all.
    expect(after[2].final).toMatchObject({ artists: ["Dizzee Rascal"], featuring: ["Jeanine Jacques"], title: "I Luv U" })
    expect(after[0].final?.title).toBe("Sittin’ Here")

    // What gets written: the album's, the release's IDs and each track's number on it.
    const plan = buildPlan(after, settings())
    expect(plan.map((p) => [p.tags.album, p.tags.albumArtist, p.tags.track, p.tags.mbReleaseId, p.tags.mbRecordingId])).toEqual([
      ["Boy in da Corner", "Dizzee Rascal", 1, ALBUM, "rec-1"],
      ["Boy in da Corner", "Dizzee Rascal", 2, ALBUM, "rec-2"],
      ["Boy in da Corner", "Dizzee Rascal", 3, ALBUM, "rec-3"],
    ])
    expect(new Set(plan.map((p) => p.tags.mbReleaseGroupId))).toEqual(new Set(["rg-1"]))

    // Decided again (a re-run, new settings): still the album's.
    const again = scoreAndSave(repo.getTrack(b.id)!, settings())
    expect(again.decision).toMatchObject({ album: "Boy in da Corner", position: { track: "2" }, release: { reason: "the album its 3 tracks share" } })
  })

  it("numbers each track as its release does, over a wrong number in its name or tag", async () => {
    stub()
    const [a, b, c] = await albumFolder()
    // Track 2's file says it's track 9.
    repo.updateTrack(b.id, { tags: { ...repo.getTrack(b.id)!.tags, track: 9 } })
    const p = await proposeAlbum([a.id, b.id, c.id], settings())
    await applyAlbum({ trackIds: [a.id, b.id, c.id], release: `musicbrainz:${ALBUM}`, fields: p.fields, matches: p.matches, approve: true, by: "person" }, settings())
    const s = settings()
    s.naming.template = "{track} {artist} - {title}"
    const plan = buildPlan([a, b, c].map((t) => repo.getTrack(t.id)!), s)
    expect(plan.map((x) => x.tags.track)).toEqual([1, 2, 3])
    expect(plan[1].toName).toBe("02 Dizzee Rascal - Stop Dat.mp3")
  })

  it("writes the album's details over each file's own, and the album artist always", () => {
    const meta = { artists: ["Dizzee Rascal"], featuring: [], title: "Stop Dat", album: "Boy in da Corner", albumArtist: "Dizzee Rascal", year: 2003, label: "XL Recordings" }
    const own = { album: "Stop Dat (Single)", year: 2002, label: "XL", albumArtist: "Dizzee" }
    expect(tagsFor(meta, own, DEFAULT_SETTINGS.naming, { albumLocked: true })).toMatchObject({ album: "Boy in da Corner", year: 2003, label: "XL Recordings", albumArtist: "Dizzee Rascal" })
    // On its own, a track only fills gaps (the album artist aside).
    const loose = tagsFor(meta, own, DEFAULT_SETTINGS.naming)
    expect(loose.album).toBeUndefined()
    expect(loose.albumArtist).toBe("Dizzee Rascal")
  })

  it("keeps a folder's album together by itself after identifying, without approving it, and never over a person's", async () => {
    stub()
    const [a, b, c] = await albumFolder()
    expect(await keepAlbumsTogether([a.id], settings(), ctx())).toBe(1)
    const after = [a, b, c].map((t) => repo.getTrack(t.id)!)
    expect(after.map((t) => t.albumLock?.by)).toEqual(["auto", "auto", "auto"])
    expect(after.map((t) => t.decision?.album)).toEqual(["Boy in da Corner", "Boy in da Corner", "Boy in da Corner"])
    expect(after.map((t) => t.status)).not.toContain("approved")
    expect(new Set(after.map((t) => t.artFound?.hash)).size).toBe(1)
    expect(after[0].artFound?.confirmed).toBeFalsy()

    // A person's own album name stays.
    await applyAlbum({ trackIds: [a.id, b.id, c.id], fields: { title: "Boy In Da Corner (Deluxe)" }, approve: false, by: "person" }, settings())
    await keepAlbumsTogether([a.id], settings(), ctx())
    expect(repo.getTrack(b.id)!.decision?.album).toBe("Boy In Da Corner (Deluxe)")

    // Let go: each track back to its own hits.
    expect(releaseAlbum([a.id, b.id, c.id], settings())).toBe(3)
    expect(repo.getTrack(b.id)!.albumLock).toBeNull()
    expect(repo.getTrack(b.id)!.decision?.album).not.toBe("Boy In Da Corner (Deluxe)")
  })

  it("leaves a folder of singles alone", async () => {
    stub()
    fs.mkdirSync(path.join(dir, "Singles"))
    const songs: [string, string, string][] = [["Wiley", "Wot Do U Call It", "Treddin' on Thin Ice"], ["Skepta", "Shutdown", "Konnichiwa"], ["Dave", "Thiago Silva", "Thiago Silva"]]
    for (const [artist, title] of songs) writeMp3(path.join(dir, "Singles", `${artist} - ${title}.mp3`))
    const lib = repo.addLibrary(dir, "Music")
    await scanLibrary(lib, settings(), ctx())
    const ids = repo.queryTracks({}).items.map((t) => t.id)
    for (const id of ids) {
      const t = repo.getTrack(id)!
      const [artist, title, album] = songs.find(([x]) => t.filename.startsWith(x))!
      repo.updateTrack(id, { candidates: [{ ...mbHit(title, `rec-${artist}`, [rel(`r-${artist}`, album, "album", { artist })]), artist, artists: [artist] }] })
      scoreAndSave(repo.getTrack(id)!, settings())
    }
    expect(listAlbums()).toEqual([])
    expect(await keepAlbumsTogether(ids, settings(), ctx())).toBe(0)
    expect(ids.map((id) => repo.getTrack(id)!.albumLock)).toEqual([null, null, null])
  })

  it("puts a cut track back in Cut & Tag when the album changes its details", async () => {
    stub()
    const [a, b] = await albumFolder()
    repo.updateTrack(b.id, { status: "done", final: { artists: ["Dizzee Rascal"], featuring: [], title: "Stop Dat", album: "Stop Dat" } })
    const p = await proposeAlbum([a.id, b.id], settings())
    const r = await applyAlbum({ trackIds: [a.id, b.id], release: `musicbrainz:${ALBUM}`, fields: p.fields, matches: p.matches, approve: true, by: "person" }, settings())
    expect(r.recut).toBe(1)
    expect(repo.getTrack(b.id)).toMatchObject({ status: "approved", final: { album: "Boy in da Corner" } })
  })
})

