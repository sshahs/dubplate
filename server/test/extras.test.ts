import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mixingKeys } from "../../shared/keys"
import type { Decision, FinalMeta, Settings, TrackSummary } from "../../shared/types"
import { usageReport, overBudget, recordUsage } from "../ai/usage"
import { analyseFile } from "../analysis/analyse"
import { fft } from "../analysis/dsp"
import { LoudnessMeter } from "../analysis/loudness"
import { judgeQuality, SpectrumCollector } from "../analysis/quality"
import { createApp } from "../app"
import * as auth from "../auth"
import { cutApproved, handsOff, handsOffReady } from "../autopilot"
import { makeBackup, restoreBackup } from "../backup"
import { tagsFor } from "../core/naming"
import { crateFacets, createCrate, listCrates, mixSuggestionIds } from "../crates"
import { openDb, setDb } from "../db"
import { exportPlaylists, mapPath, rekordboxLocation, seratoPath, traktorLocation } from "../dj-export"
import { rankCopies } from "../duplicates"
import { buildPlan, executePlan, rewind } from "../executor"
import { healthReport } from "../health"
import { enqueueJob, resetJobStateForTests, type JobContext } from "../jobs"
import * as repo from "../repo"
import { scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS, saveSettings } from "../settings"
import { discogsCollection, ownedReleases, syncCollection } from "../sources/discogs-collection"
import { readManagedTags, writeTags } from "../tagger"
import { writeMp3 } from "./fixtures"
import { toWav } from "./synth"

let dir: string
const settings: Settings = structuredClone({ ...DEFAULT_SETTINGS, safety: { readOnly: false } })

function ctx(): JobContext & { logs: string[] } {
  const job = { id: "t", kind: "execute", status: "running", label: "t", total: 0, done: 0, failed: 0, message: null, createdAt: "", startedAt: null, finishedAt: null } as JobContext["job"]
  const logs: string[] = []
  return {
    job,
    logs,
    signal: new AbortController().signal,
    setTotal: (n) => void (job.total = n),
    tick: (ok = true) => void (ok ? job.done++ : job.failed++),
    message: () => {},
    log: (_l, m) => void logs.push(m),
    tracksChanged: () => {},
    filesChanged: () => {},
    report: () => {},
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-extras-"))
  setDb(openDb(":memory:"))
  auth.resetAttemptsForTests()
  resetJobStateForTests()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  delete process.env.DUBPLATE_PASSWORD
})

// ---------- audio ----------

function sine(rate: number, secs: number, hz: number, dbfs: number) {
  const a = 10 ** (dbfs / 20)
  const x = new Float32Array(rate * secs)
  for (let i = 0; i < x.length; i++) x[i] = a * Math.sin((2 * Math.PI * hz * i) / rate)
  return x
}

/** Noise with a chosen spectrum: `gain(hz)` per frequency, shaped in one big FFT. */
function shapedNoise(rate: number, secs: number, gain: (hz: number) => number) {
  let n = 1
  while (n < rate * secs) n <<= 1
  let s = 12345
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    re[i] = ((s >>> 0) / 4294967296) * 2 - 1
  }
  fft(re, im)
  for (let b = 0; b < n; b++) {
    const g = gain(((b <= n / 2 ? b : n - b) * rate) / n)
    re[b] *= g
    im[b] = -im[b] * g
  }
  fft(re, im)
  const out = new Float32Array(rate * secs)
  let peak = 0
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs((out[i] = re[i] / n)))
  for (let i = 0; i < out.length; i++) out[i] *= 0.5 / peak
  return out
}

const pink = (hz: number) => (hz < 20 ? 0 : 1 / Math.sqrt(hz / 100))

function spectrumOf(x: Float32Array, rate: number) {
  const s = new SpectrumCollector(x.length / rate)
  for (let i = 0; i < x.length; i += 8192) {
    const c = x.subarray(i, i + 8192)
    s.push([c, c], rate)
  }
  return s.result()
}

describe("loudness", () => {
  it("reads a -23 dBFS stereo tone as -23 LUFS and ignores silence", () => {
    for (const rate of [44100, 48000]) {
      const m = new LoudnessMeter()
      const x = sine(rate, 12, 1000, -23)
      m.push([x, x], rate)
      const r = m.result()!
      expect(r.lufs).toBeCloseTo(-23, 0)
      expect(Math.abs(r.lufs + 23)).toBeLessThan(0.15)
      expect(r.gain).toBeCloseTo(5, 0)
      expect(r.peak).toBeCloseTo(0.0708, 3)
    }
    const m = new LoudnessMeter()
    const x = sine(48000, 8, 1000, -23)
    const silence = new Float32Array(48000 * 8)
    m.push([x, x], 48000)
    m.push([silence, silence], 48000)
    expect(Math.abs(m.result()!.lufs + 23)).toBeLessThan(0.2)
    const quiet = new LoudnessMeter()
    quiet.push([silence, silence], 48000)
    expect(quiet.result()).toBeNull()
  })

  it("counts stereo the decoder collapsed to one channel as both, even when it opens collapsed", () => {
    const x = sine(48000, 8, 1000, -23)
    const collapsed = new LoudnessMeter(2)
    collapsed.push([x], 48000)
    expect(Math.abs(collapsed.result()!.lufs + 23)).toBeLessThan(0.15)
    // A silent (identical) intro arrives as one channel, then real stereo: both channels count throughout.
    const mixed = new LoudnessMeter(2)
    mixed.push([x.subarray(0, 48000 * 2)], 48000)
    mixed.push([x.subarray(48000 * 2), x.subarray(48000 * 2)], 48000)
    expect(Math.abs(mixed.result()!.lufs + 23)).toBeLessThan(0.15)
    // A real mono file is one channel.
    const mono = new LoudnessMeter(1)
    mono.push([x], 48000)
    expect(Math.abs(mono.result()!.lufs + 26)).toBeLessThan(0.15)
  })
})

describe("fake-quality check", () => {
  const flac = { ext: "flac", codec: "FLAC", bitrate: 900_000, sampleRate: 44100 }
  const mp3 = (kbps: number) => ({ ext: "mp3", codec: "MPEG 1 Layer 3", bitrate: kbps * 1000, sampleRate: 44100 })

  it("flags a brick wall far below what the format claims, and only then", () => {
    const from128 = spectrumOf(
      shapedNoise(44100, 8, (hz) => (hz < 16000 ? pink(hz) : 0)),
      44100
    )
    const asFlac = judgeQuality(from128, flac)
    expect(asFlac.verdict).toBe("suspect")
    expect(asFlac.cutoffHz).toBeGreaterThan(15500)
    expect(asFlac.cutoffHz).toBeLessThan(16500)
    expect(asFlac.likely).toMatch(/128/)
    expect(judgeQuality(from128, mp3(320)).verdict).toBe("suspect")
    expect(judgeQuality(from128, mp3(128)).verdict).toBe("ok")
  })

  it("leaves full-range audio and dull recordings alone", () => {
    expect(judgeQuality(spectrumOf(shapedNoise(44100, 8, pink), 44100), flac)).toMatchObject({ verdict: "ok", cutoffHz: null })
    // Rolls off steadily (a dull tape), no brick wall: not the encoder's doing.
    const dull = judgeQuality(
      spectrumOf(
        shapedNoise(44100, 8, (hz) => pink(hz) * 10 ** (-Math.max(0, hz - 8000) / 1000 / 5)),
        44100
      ),
      flac
    )
    expect(dull.verdict).toBe("ok")
    expect(dull.sharp).toBe(false)
    expect(judgeQuality(null, flac).verdict).toBe("unknown")
  })

  it("spots a hi-res file upsampled from CD quality", () => {
    const up = judgeQuality(
      spectrumOf(
        shapedNoise(96000, 4, (hz) => (hz < 21000 ? pink(hz) : 0)),
        96000
      ),
      { ext: "flac", codec: "FLAC", bitrate: 2_000_000, sampleRate: 96000 }
    )
    expect(up.verdict).toBe("suspect")
    expect(up.detail).toMatch(/upsampled/)
  })

  it("measures a real file end to end: quality and loudness in one pass", async () => {
    const file = path.join(dir, "rip.wav")
    fs.writeFileSync(file, toWav(shapedNoise(44100, 14, (hz) => (hz < 16000 ? pink(hz) : 0))))
    const a = await analyseFile({ file, ext: "wav", duration: 14, bpmMin: 88, quality: true, loudness: true, codec: "PCM", bitrate: 1_411_200, sampleRate: 44100 })
    expect(a.quality?.verdict).toBe("suspect")
    expect(a.loudness?.lufs).toBeLessThan(0)
    expect(a.loudness?.peak).toBeGreaterThan(0.3)
    expect(a.loudness?.gain).toBeCloseTo(-18 - a.loudness!.lufs, 1)
  })

  it("ranks a copy made from something worse below an honest one", () => {
    const base = { ext: "mp3", codec: "MPEG 1 Layer 3", duration: 240, status: "matched", art: null, path: "/m/a.mp3", filename: "a.mp3", proposedName: null } as const
    const fake = { ...base, id: 1, ext: "flac", codec: "FLAC", bitrate: 900_000, analysis: { quality: { verdict: "suspect", cutoffHz: 16000, sharp: true, detail: "" } } } as unknown as TrackSummary
    const honest = { ...base, id: 2, bitrate: 320_000, analysis: null } as unknown as TrackSummary
    const r = rankCopies([fake, honest])
    expect(r.best).toBe(2)
    expect(r.reasons[1]).toMatch(/sounds like a ~128 kbps file/)
  })
})

describe("ReplayGain tags", () => {
  it("writes the gain and peak once, and reads them back", () => {
    const meta: FinalMeta = { artists: ["Kano"], featuring: [], title: "Ps and Qs" }
    const rg = { lufs: -9.5, peak: 0.98765432, gain: -8.5 }
    const tags = tagsFor(meta, {}, settings.naming, { replayGain: rg })
    expect(tags).toMatchObject({ replayGainTrackGain: -8.5, replayGainTrackPeak: 0.987654 })
    expect(tagsFor(meta, { replayGainTrackGain: -8.5, replayGainTrackPeak: 0.987654 }, settings.naming, { replayGain: rg }).replayGainTrackGain).toBeUndefined()
    const file = path.join(dir, "a.mp3")
    writeMp3(file)
    writeTags(file, { replayGainTrackGain: -8.5, replayGainTrackPeak: 0.987654 })
    expect(readManagedTags(file)).toMatchObject({ replayGainTrackGain: -8.5, replayGainTrackPeak: 0.987654 })
    writeTags(file, { replayGainTrackGain: null, replayGainTrackPeak: null })
    expect(readManagedTags(file).replayGainTrackGain).toBeUndefined()
  })
})

// ---------- sign-in ----------

describe("password", () => {
  it("hashes, checks and signs sessions that die with a new password", () => {
    expect(auth.authEnabled()).toBe(false)
    expect(() => auth.setPassword("short")).toThrow(/8 characters/)
    auth.setPassword("selector 1993")
    expect(auth.authEnabled()).toBe(true)
    expect(auth.checkPassword("selector 1993")).toBe(true)
    expect(auth.checkPassword("selector 1994")).toBe(false)
    const cookie = auth.issueSession()
    expect(auth.validSession(cookie)).toBe(true)
    expect(auth.validSession(cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBe(false)
    expect(auth.validSession(auth.issueSession(Date.now() - 31 * 86400_000))).toBe(false)
    auth.signOutEverywhere()
    expect(auth.validSession(cookie)).toBe(false)
    const fresh = auth.issueSession()
    auth.setPassword("another one")
    expect(auth.validSession(fresh)).toBe(false)
    auth.removePassword()
    expect(auth.authEnabled()).toBe(false)
    process.env.DUBPLATE_PASSWORD = "from the environment"
    expect(auth.authEnabled()).toBe(true)
    expect(auth.checkPassword("from the environment")).toBe(true)
  })

  it("guards the API and throttles guessing", async () => {
    const app = createApp()
    const H = { "x-dubplate": "1", "content-type": "application/json" }
    expect((await app.request("http://localhost/api/libraries")).status).toBe(200)
    const set = await app.request("http://localhost/api/auth/password", { method: "POST", headers: H, body: JSON.stringify({ next: "selector 1993" }) })
    expect(set.status).toBe(200)
    expect(set.headers.get("set-cookie")).toMatch(/dubplate_session=.*HttpOnly.*SameSite=Strict/i)
    expect((await app.request("http://localhost/api/libraries")).status).toBe(401)
    expect(await (await app.request("http://localhost/api/health")).json()).toEqual({ auth: true, version: expect.any(String) })
    expect(await (await app.request("http://localhost/api/auth/status")).json()).toMatchObject({ enabled: true, authenticated: false })

    const wrong = () => app.request("http://localhost/api/auth/login", { method: "POST", headers: H, body: JSON.stringify({ password: "nope" }) })
    for (let i = 0; i < 5; i++) expect((await wrong()).status).toBe(401)
    expect((await wrong()).status).toBe(429)
    auth.resetAttemptsForTests()

    const ok = await app.request("http://localhost/api/auth/login", { method: "POST", headers: H, body: JSON.stringify({ password: "selector 1993" }) })
    expect(ok.status).toBe(200)
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]
    expect((await app.request("http://localhost/api/libraries", { headers: { cookie } })).status).toBe(200)
    // Changing it needs the current one.
    const bad = await app.request("http://localhost/api/auth/password", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ current: "nope", next: "something else" }) })
    expect(bad.status).toBe(403)
    const removed = await app.request("http://localhost/api/auth/password/remove", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ current: "selector 1993" }) })
    expect(removed.status).toBe(200)
    expect((await app.request("http://localhost/api/libraries")).status).toBe(200)
  })
})

// ---------- crates, mixing, exports ----------

async function library(files: { rel: string; meta: Partial<FinalMeta>; bpm?: number; key?: string; genre?: string[] }[]) {
  for (const f of files) {
    const file = path.join(dir, f.rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeMp3(file)
  }
  const lib = repo.addLibrary(dir, "Crates")
  await scanLibrary(lib, settings, ctx())
  const tracks = repo.queryTracks({ limit: 100 }).items
  const ids: Record<string, number> = {}
  for (const f of files) {
    const t = tracks.find((x) => x.path === path.join(dir, f.rel))!
    ids[f.rel] = t.id
    repo.updateTrack(t.id, {
      final: { artists: [], featuring: [], title: "", ...f.meta } as FinalMeta,
      status: "done",
      bpm: f.bpm ?? null,
      key: f.key ?? null,
      tags: { ...t.tags, genre: f.genre },
    })
  }
  return { lib, ids }
}

describe("smart crates", () => {
  it("filters by genre, tempo (half/double too), key and era, and counts itself", async () => {
    const { ids } = await library([
      { rel: "a.mp3", meta: { artists: ["Skepta"], title: "Shutdown", year: 2015, genre: "Grime" }, bpm: 140, key: "Am" },
      { rel: "b.mp3", meta: { artists: ["Sister Nancy"], title: "Bam Bam", year: 1982 }, bpm: 70, key: "Em", genre: ["Reggae", "Dancehall"] },
      { rel: "c.mp3", meta: { artists: ["Wiley"], title: "Eskimo", year: 2002, genre: "Grime" }, bpm: 139, key: "F#m" },
      { rel: "d.mp3", meta: { artists: ["Shy FX"], title: "Original Nuttah", year: 1994, genre: "Jungle" }, bpm: 170, key: "C" },
    ])
    const grime = createCrate("Grime 140", { genres: ["grime"], bpmMin: 138, bpmMax: 142 })
    expect(grime.count).toBe(2)
    expect(repo.queryTracks({ crateId: grime.id }).items.map((t) => t.id).sort()).toEqual([ids["a.mp3"], ids["c.mp3"]].sort())
    // A 70 BPM one-drop sits in a 140 crate at double time.
    expect(createCrate("Halftime", { bpmMin: 138, bpmMax: 142, halfDouble: true }).count).toBe(3)
    // Keys that mix with Am: Am, Em, Dm, C, Bm.
    const mixes = createCrate("Mixes with Am", { mixesWith: "8A" })
    expect(repo.queryTracks({ crateId: mixes.id }).total).toBe(3)
    expect(createCrate("Nineties", { yearFrom: 1990, yearTo: 1999 }).count).toBe(1)
    expect(createCrate("Reggae", { genres: ["Reggae"] }).count).toBe(1)
    expect(() => createCrate("  ", {})).toThrow(/name/)
    expect(listCrates().map((c) => c.name)).toContain("Grime 140")
    const f = crateFacets()
    expect(f.genres.find((g) => g.value === "Grime")?.count).toBe(2)
    expect(f.bpm).toEqual({ min: 70, max: 170 })
    expect(f.years).toEqual({ min: 1982, max: 2015 })
  })

  it("suggests what mixes after a track", async () => {
    const { ids } = await library([
      { rel: "a.mp3", meta: { artists: ["A"], title: "A" }, bpm: 140, key: "Am" },
      { rel: "b.mp3", meta: { artists: ["B"], title: "B" }, bpm: 141, key: "C" },
      { rel: "c.mp3", meta: { artists: ["C"], title: "C" }, bpm: 70, key: "Am" },
      { rel: "d.mp3", meta: { artists: ["D"], title: "D" }, bpm: 140, key: "F#" },
      { rel: "e.mp3", meta: { artists: ["E"], title: "E" }, bpm: 160, key: "Am" },
    ])
    expect(mixingKeys("Am").map((k) => k.key)).toEqual(["Am", "Em", "Dm", "C", "Bm"])
    const s = mixSuggestionIds({ id: ids["a.mp3"], bpm: 140, key: "Am" })
    expect(s.map((x) => x.id)).toEqual([ids["c.mp3"], ids["b.mp3"]])
    expect(s[0]).toMatchObject({ keyRelation: "same", halfDouble: true, bpmDiff: 0 })
    expect(s[1]).toMatchObject({ keyRelation: "relative", halfDouble: false })
  })
})

describe("DJ exports", () => {
  it("maps paths for another computer and writes each format", async () => {
    expect(mapPath("/music/Grime/a.mp3", [{ from: "/music", to: "D:\\Music" }])).toBe("D:\\Music\\Grime\\a.mp3")
    expect(mapPath("/music/Grime/a.mp3", [{ from: "/music/", to: "/Volumes/USB/Music" }])).toBe("/Volumes/USB/Music/Grime/a.mp3")
    expect(mapPath("/elsewhere/a.mp3", [{ from: "/music", to: "D:\\Music" }])).toBe("/elsewhere/a.mp3")
    expect(rekordboxLocation("D:\\Music\\Sister Nancy - Bam Bam & Co.mp3")).toBe("file://localhost/D:/Music/Sister%20Nancy%20-%20Bam%20Bam%20%26%20Co.mp3")
    expect(rekordboxLocation("/Users/me/Música/a.mp3")).toBe("file://localhost/Users/me/M%C3%BAsica/a.mp3")
    expect(traktorLocation("/Volumes/USB/Music/a.mp3", "Macintosh HD")).toEqual({ volume: "USB", dir: "/:Music/:", file: "a.mp3" })
    expect(traktorLocation("C:\\DJ\\a.mp3", "Macintosh HD")).toEqual({ volume: "C:", dir: "/:DJ/:", file: "a.mp3" })
    expect(traktorLocation("/Users/me/a.mp3", "Macintosh HD")).toEqual({ volume: "Macintosh HD", dir: "/:Users/:me/:", file: "a.mp3" })
    expect(seratoPath("/Volumes/USB/Music/a.mp3")).toBe("Music/a.mp3")
    expect(seratoPath("C:\\Music\\a.mp3")).toBe("Music/a.mp3")

    const { ids } = await library([
      { rel: "Grime/a.mp3", meta: { artists: ["Skepta"], title: "Shutdown <Dub>" }, bpm: 140, key: "Am" },
      { rel: "b.mp3", meta: { artists: ["Sister Nancy"], title: "Bam Bam" }, bpm: 70 },
    ])
    const tracks = repo.getTracks(Object.values(ids))
    const opts = { pathMap: [{ from: dir, to: "D:\\Music" }], traktorVolume: "Macintosh HD", naming: settings.naming }
    const rb = exportPlaylists("rekordbox", [{ name: "Grime & more", tracks }], opts)
    expect(rb.body).toContain('<NODE Name="Grime &amp; more" Type="1" KeyType="0" Entries="2">')
    expect(rb.body).toContain('Name="Shutdown &lt;Dub&gt;"')
    expect(rb.body).toContain('Tonality="Am"')
    expect(rb.body).toContain('AverageBpm="140.00"')
    expect(rb.body).toContain('Location="file://localhost/D:/Music/Grime/a.mp3"')
    const nml = exportPlaylists("traktor", [{ name: "Crate", tracks }], opts).body as string
    expect(nml).toContain('<LOCATION DIR="/:Music/:Grime/:" FILE="a.mp3" VOLUME="D:"')
    expect(nml).toContain('<MUSICAL_KEY VALUE="21">')
    expect(nml).toContain('KEY="D:/:Music/:Grime/:a.mp3"')
    const m3u = exportPlaylists("m3u", [{ name: "Crate", tracks }], opts)
    expect(m3u.filename).toBe("Crate.m3u8")
    // Sorted by artist: Sister Nancy before Skepta.
    expect(m3u.body).toMatch(/Sister Nancy - Bam Bam\r\nD:\\Music\\b\.mp3\r\n#EXTINF:\d+,Skepta/)
    const crate = Buffer.from(exportPlaylists("serato", [{ name: "Crate", tracks }], opts).body as Uint8Array)
    expect(crate.subarray(0, 4).toString("latin1")).toBe("vrsn")
    expect(crate.includes(Buffer.from("otrk", "latin1"))).toBe(true)
    expect(crate.includes(Buffer.from("ptrk", "latin1"))).toBe(true)
    // The path inside is UTF-16BE, relative to the drive root.
    const be = (s: string) => Buffer.from(s, "utf16le").swap16()
    expect(crate.includes(be("Music/Grime/a.mp3"))).toBe(true)

    const app = createApp()
    const res = await app.request("http://localhost/api/export/dj", {
      method: "POST",
      headers: { "x-dubplate": "1", "content-type": "application/json" },
      body: JSON.stringify({ format: "rekordbox", name: "Mixes", ids: Object.values(ids), pathMap: [] }),
    })
    expect(res.headers.get("content-disposition")).toMatch(/Mixes \(rekordbox\)\.xml/)
    expect(await res.text()).toContain(`Location="file://localhost${dir.split(path.sep).map(encodeURIComponent).join("/")}/b.mp3"`)
  })
})

// ---------- hands-off and inboxes ----------

const decision = (artist: string, title: string, confidence: number, basis: Decision["basis"] = "sources", sources: Decision["clusters"][number]["sources"] = ["musicbrainz", "discogs"]): Decision => ({
  artists: [artist],
  featuring: [],
  artist,
  title,
  confidence,
  status: confidence >= 90 ? "matched" : "review",
  basis,
  factors: [],
  clusters: basis === "sources" ? [{ artist, title, sources, support: 1, relevance: 1, candidates: [] }] : [],
  warnings: [],
})

describe("hands-off", () => {
  it("approves and cuts only sure, source-backed matches in hands-off libraries", async () => {
    for (const f of ["skepta shutdown.mp3", "sister nancy.mp3", "wiley.mp3"]) writeMp3(path.join(dir, f))
    const lib = repo.addLibrary(dir, "Downloads", { settings: { handsOff: true } })
    await scanLibrary(lib, settings, ctx())
    const byName = Object.fromEntries(repo.queryTracks({}).items.map((t) => [t.filename, t.id]))
    repo.updateTrack(byName["skepta shutdown.mp3"], { decision: decision("Skepta", "Shutdown", 97), confidence: 97, status: "matched" })
    repo.updateTrack(byName["sister nancy.mp3"], { decision: decision("Sister Nancy", "Bam Bam", 80), confidence: 80, status: "review" })
    repo.updateTrack(byName["wiley.mp3"], { decision: decision("Wiley", "Eskimo", 97, "ai"), confidence: 97, status: "matched" })

    // Sure but risky - only one source backs it up - isn't hands-off either.
    const lone = repo.getTrack(byName["sister nancy.mp3"])!
    expect(handsOffReady({ ...lone, decision: decision("Sister Nancy", "Bam Bam", 97, "sources", ["musicbrainz"]), confidence: 97, status: "matched" }, settings)).toBe(false)
    expect(handsOffReady({ ...lone, decision: decision("Sister Nancy", "Bam Bam", 97), confidence: 97, status: "matched" }, settings)).toBe(true)

    const readOnly = { ...settings, safety: { readOnly: true } }
    const c = ctx()
    const approved = handsOff(Object.values(byName), readOnly, c)
    expect(approved).toEqual([byName["skepta shutdown.mp3"]])
    expect(c.logs.join()).toMatch(/read-only mode is on/)
    expect(repo.getTrack(approved[0])!.status).toBe("approved")
    expect(repo.getTrack(byName["sister nancy.mp3"])!.status).toBe("review")
    // Not hands-off: nothing happens.
    repo.updateLibrary(lib.id, { settings: {} })
    repo.updateTrack(byName["skepta shutdown.mp3"], { status: "matched", final: null })
    expect(handsOff(Object.values(byName), readOnly, ctx())).toEqual([])

    saveSettings({ safety: { readOnly: false } })
    repo.updateTrack(byName["skepta shutdown.mp3"], { status: "approved", final: { artists: ["Skepta"], featuring: [], title: "Shutdown" } })
    const cut = ctx()
    await cutApproved(approved, cut)
    expect(cut.job.done).toBe(1)
    expect(fs.existsSync(path.join(dir, "Skepta - Shutdown.mp3"))).toBe(true)
    expect(repo.listBatches()[0].label).toBe("Hands-off")
  })
})

describe("inbox", () => {
  it("cuts into the library it feeds, in that library's layout, and rewinds back", async () => {
    const inboxDir = path.join(dir, "Downloads")
    const mainDir = path.join(dir, "Music")
    fs.mkdirSync(inboxDir)
    fs.mkdirSync(mainDir)
    writeMp3(path.join(inboxDir, "sister_nancy_-_bam_bam.mp3"))
    const main = repo.addLibrary(mainDir, "Music", { settings: { folderTemplate: "{initial}/{artist}" } })
    const inbox = repo.addLibrary(inboxDir, "Downloads", { settings: { inboxFor: main.id } })
    await scanLibrary(inbox, settings, ctx())
    const t = repo.queryTracks({}).items[0]
    repo.updateTrack(t.id, { final: { artists: ["Sister Nancy"], featuring: [], title: "Bam Bam" }, status: "approved" })

    const plan = buildPlan(repo.getTracks([t.id]), settings)
    expect(plan[0]).toMatchObject({ toLibraryId: main.id, toDir: path.join("S", "Sister Nancy"), toName: "Sister Nancy - Bam Bam.mp3", blocked: false })
    await executePlan(plan, settings, { dryRun: false }, ctx())
    const moved = path.join(mainDir, "S", "Sister Nancy", "Sister Nancy - Bam Bam.mp3")
    expect(fs.existsSync(moved)).toBe(true)
    expect(repo.getTrack(t.id)).toMatchObject({ libraryId: main.id, path: moved, relDir: path.join("S", "Sister Nancy"), status: "done" })
    // A rescan of either library doesn't lose or duplicate it.
    await scanLibrary(repo.getLibrary(inbox.id)!, settings, ctx())
    await scanLibrary(repo.getLibrary(main.id)!, settings, ctx())
    expect(repo.queryTracks({}).total).toBe(1)

    await rewind(null, repo.listBatches()[0].batchId, ctx())
    expect(fs.existsSync(path.join(inboxDir, "sister_nancy_-_bam_bam.mp3"))).toBe(true)
    expect(fs.existsSync(path.join(mainDir, "S"))).toBe(false)
    expect(repo.getTrack(t.id)).toMatchObject({ libraryId: inbox.id, relDir: "", status: "approved" })

    // An inbox can't feed itself or another inbox.
    const app = createApp()
    const patch = (id: number, inboxFor: number) =>
      app.request(`http://localhost/api/libraries/${id}`, { method: "PATCH", headers: { "x-dubplate": "1", "content-type": "application/json" }, body: JSON.stringify({ settings: { inboxFor } }) })
    expect((await patch(inbox.id, inbox.id)).status).toBe(400)
    expect((await patch(main.id, inbox.id)).status).toBe(400)
  })

  it("and crates survive a backup by folder, not by ID", () => {
    const [a, b, c] = ["Other", "Music", "Downloads"].map((n) => {
      fs.mkdirSync(path.join(dir, n))
      return path.join(dir, n)
    })
    const main = repo.addLibrary(b, "Music")
    repo.addLibrary(c, "Downloads", { settings: { inboxFor: main.id } })
    createCrate("Grime", { genres: ["grime"], libraryId: main.id })
    createCrate("Everything", { bpmMin: 100 })
    const backup = JSON.parse(JSON.stringify(makeBackup({ secrets: false })))
    expect(backup.libraries.find((l: { name: string }) => l.name === "Downloads")).toMatchObject({ inboxForPath: b })
    expect(backup.crates).toEqual([
      { name: "Everything", rules: { bpmMin: 100 } },
      { name: "Grime", rules: { genres: ["grime"] }, libraryPath: b },
    ])

    // A fresh install where the IDs come out differently.
    setDb(openDb(":memory:"))
    repo.addLibrary(a, "Other")
    createCrate("everything", { bpmMin: 90 })
    const r = restoreBackup(backup, { settings: false, learnings: false, libraries: true, crates: true })
    expect(r).toMatchObject({ libraries: { added: 2 }, crates: 1 })
    const libs = repo.listLibraries()
    const music = libs.find((l) => l.path === b)!
    expect(libs.find((l) => l.path === c)?.settings.inboxFor).toBe(music.id)
    expect(music.id).not.toBe(main.id)
    // "Everything" was already here (names match without case), so it's left as it was.
    expect(listCrates().map((x) => [x.name, x.rules])).toEqual([
      ["everything", { bpmMin: 90 }],
      ["Grime", { genres: ["grime"], libraryId: music.id }],
    ])

    // Without its library, a limited crate isn't widened to everything.
    setDb(openDb(":memory:"))
    expect(restoreBackup(backup, { settings: false, learnings: false, libraries: false, crates: true }).crates).toBe(1)
    expect(listCrates().map((x) => x.name)).toEqual(["Everything"])
  })
})

// ---------- Discogs collection ----------

describe("Discogs collection", () => {
  it("syncs the collection and finds tracks on records you own", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url)
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } })
      if (url.endsWith("/oauth/identity")) return json({ username: "selector" })
      if (url.includes("/collection/folders/0/releases")) {
        return json({
          pagination: { page: 1, pages: 1, items: 2 },
          releases: [
            { id: 111, date_added: "2024-01-01", basic_information: { id: 111, title: "Bam Bam", year: 1982, artists: [{ name: "Sister Nancy" }], labels: [{ name: "Techniques", catno: "TQ1" }], formats: [{ name: "Vinyl", descriptions: ['7"'] }] } },
            { id: 222, basic_information: { id: 222, title: "Ring The Alarm", artists: [{ name: "Tenor Saw (2)" }] } },
          ],
        })
      }
      if (url.endsWith("/releases/111")) {
        return json({ id: 111, title: "Bam Bam", year: 1982, artists: [{ name: "Sister Nancy" }], labels: [{ name: "Techniques" }], tracklist: [{ title: "Bam Bam", duration: "3:40" }, { title: "Bam Bam (Version)" }] })
      }
      return new Response("not found", { status: 404 })
    })
    const s: Settings = structuredClone(settings)
    s.sources.discogs = { ...s.sources.discogs, apiKey: "token" }
    expect(discogsCollection.unavailable({ cfg: s.sources["discogs-collection"], settings: s })).toMatch(/sync/)
    await syncCollection(s, ctx())
    expect(discogsCollection.unavailable({ cfg: s.sources["discogs-collection"], settings: s })).toBeNull()
    expect(ownedReleases(["Tenor Saw"], "Something")).toEqual([222])
    expect(ownedReleases(["Nobody"], "Bam Bam")).toEqual([111])
    const hits = await discogsCollection.search(
      { artists: ["Sister Nancy"], artist: "Sister Nancy", title: "Bam Bam", query: "", extraQueries: [], duration: null, descriptiveTitle: false, filePath: "" },
      { cfg: s.sources["discogs-collection"], settings: s }
    )
    expect(hits[0]).toMatchObject({ source: "discogs-collection", artist: "Sister Nancy", title: "Bam Bam", year: 1982, ids: { discogsReleaseId: "111" } })
    expect(calls.filter((u) => u.includes("/releases/111"))).toHaveLength(1)
  }, 15_000)
})

// ---------- AI usage ----------

describe("AI usage", () => {
  it("books tokens against the job, prices them and enforces the budget", async () => {
    const s: Settings = structuredClone(settings)
    const openai = s.llm.providers.find((p) => p.id === "openai")!
    openai.priceIn = 0.5
    openai.priceOut = 2
    await new Promise<void>((resolve) => enqueueJob("process", "Identify 3 tracks", async () => {
      recordUsage(openai, { input: 1_000_000, output: 250_000 })
      resolve()
    }))
    recordUsage(s.llm.providers.find((p) => p.id === "ollama")!, { input: 5000, output: 900 })
    recordUsage(s.llm.providers.find((p) => p.id === "anthropic")!, { input: 1000, output: 100 })
    const r = usageReport(s)
    expect(r.month.input).toBe(1_006_000)
    expect(r.month.cost).toBeCloseTo(1, 5)
    expect(r.byProvider.find((p) => p.providerId === "anthropic")).toMatchObject({ priced: false, cost: null })
    expect(r.byProvider.find((p) => p.providerId === "ollama")).toMatchObject({ priced: true, cost: 0 })
    expect(r.runs[0]).toMatchObject({ label: "Identify 3 tracks", input: 1_000_000 })
    expect(r.byDay).toHaveLength(30)
    expect(r.byDay.at(-1)!.input).toBe(1_006_000)
    expect(r.byDay[0].calls).toBe(0)
    expect(overBudget({ ...s, llm: { ...s.llm, monthlyBudget: 0 } })).toBe(false)
    expect(overBudget({ ...s, llm: { ...s.llm, monthlyBudget: 5 } })).toBe(false)
    expect(overBudget({ ...s, llm: { ...s.llm, monthlyBudget: 0.9 } })).toBe(true)
  })
})

// ---------- health ----------

describe("health checks", () => {
  it("reports the data folder, libraries and security without going online", async () => {
    const s: Settings = structuredClone(settings)
    for (const cfg of Object.values(s.sources)) cfg.enabled = false
    for (const sc of s.scrapers) sc.enabled = false
    for (const p of s.llm.providers) p.enabled = false
    repo.addLibrary(path.join(dir, "gone"), "Unplugged")
    const r = await healthReport(s, true)
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]))
    expect(byId.data.status).toBe("ok")
    expect(r.checks.find((c) => c.label === "Unplugged")).toMatchObject({ status: "error", fix: { to: "/libraries" } })
    expect(byId.password.status).toBe("info")
    expect(byId.sources.status).toBe("warn")
    expect(r.system.version).toBeTruthy()
  })
})
