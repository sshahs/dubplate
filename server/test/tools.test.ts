// Lyrics, the broken-file check, uploads, and API tokens with the download-tool hook.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fileProblems } from "../../shared/problems"
import type { Settings, TrackSummary } from "../../shared/types"
import { analyseFile } from "../analysis/analyse"
import { IntegrityCollector } from "../analysis/integrity"
import { createApp } from "../app"
import { mismatch, sniffFile } from "../sniff"
import { openDb, setDb } from "../db"
import { rankCopies } from "../duplicates"
import { buildPlan, executePlan, rewind } from "../executor"
import { clearHookCalls, mapHookPath, readHook, recentHookCalls, runHook } from "../hooks"
import { activeJobs, resetJobStateForTests, type JobContext } from "../jobs"
import { findLyrics, lyricsKey, pickLyrics, type LrclibHit } from "../lyrics"
import * as repo from "../repo"
import { scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS, saveSettings } from "../settings"
import { readManagedTags } from "../tagger"
import { createToken } from "../tokens"
import { stopAutomation } from "../watcher"
import { writeMp3, writeWav } from "./fixtures"
import { synthTrack, toWav } from "./synth"

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

async function jobsSettled() {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 20))
    if (!activeJobs().length) return
  }
  throw new Error("jobs still running")
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-tools-"))
  setDb(openDb(":memory:"))
  resetJobStateForTests()
  clearHookCalls()
})
afterEach(() => {
  stopAutomation()
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

/** An MP3 whose first frame carries a Xing header saying how many frames there are. */
function writeMp3WithXing(file: string, frames: number, framesOnDisk: number) {
  writeMp3(file, framesOnDisk)
  const b = fs.readFileSync(file)
  b.write("Xing", 36, "latin1")
  b.writeUInt32BE(1, 40)
  b.writeUInt32BE(frames, 44)
  fs.writeFileSync(file, b)
}

function withSilence(before: number, after: number, sr = 44100) {
  const music = synthTrack({ bpm: 120, chords: [[57, "m"]], seconds: 12, sampleRate: sr })
  const out = new Float32Array(music.length + Math.round((before + after) * sr))
  out.set(music, Math.round(before * sr))
  return toWav(out, sr)
}

// ---------- broken-file check ----------

describe("file check", () => {
  it("knows a file by its content, not its name", async () => {
    const mp3 = path.join(dir, "a.mp3")
    const wav = path.join(dir, "b.wav")
    const liar = path.join(dir, "c.mp3")
    writeMp3(mp3)
    writeWav(wav)
    writeWav(liar)
    expect(await sniffFile(mp3)).toMatchObject({ ext: "mp3", family: "mpeg" })
    expect(await sniffFile(wav)).toMatchObject({ ext: "wav" })
    expect(mismatch(mp3, await sniffFile(mp3))).toBeNull()
    expect(mismatch(liar, await sniffFile(liar))).toMatchObject({ ext: "wav", label: "WAV" })
    // An MP3's exact length comes from its VBR header.
    const vbr = path.join(dir, "vbr.mp3")
    writeMp3WithXing(vbr, 1000, 40)
    expect((await sniffFile(vbr))?.statedSeconds).toBeCloseTo((1000 * 1152) / 44100, 3)
    // A WAV's header states its length even when the file stops sooner.
    const whole = toWav(new Float32Array(44100 * 4), 44100)
    const cut = path.join(dir, "cut.wav")
    fs.writeFileSync(cut, whole.subarray(0, whole.length / 2))
    expect((await sniffFile(cut))?.statedSeconds).toBeCloseTo(4, 3)
    // …and an AIFF's (3 s at 44.1 kHz, as an 80-bit float).
    const comm = Buffer.alloc(26)
    comm.write("COMM", 0)
    comm.writeUInt32BE(18, 4)
    comm.writeUInt16BE(1, 8)
    comm.writeUInt32BE(44100 * 3, 10)
    comm.writeUInt16BE(16, 14)
    Buffer.from("400EAC44000000000000", "hex").copy(comm, 16)
    const aiff = path.join(dir, "cut.aiff")
    fs.writeFileSync(aiff, Buffer.concat([Buffer.from("FORM\0\0\0\0AIFF", "latin1"), comm, Buffer.from("SSND", "latin1"), Buffer.alloc(100)]))
    expect(await sniffFile(aiff)).toMatchObject({ ext: "aiff", statedSeconds: 3 })
  })

  it("gives a mislabelled file its right extension when cut, and rewinds it", async () => {
    const liar = path.join(dir, "sister nancy - bam bam.mp3")
    fs.writeFileSync(liar, toWav(synthTrack({ bpm: 100, chords: [[57, "m"]], seconds: 2 }), 44100))
    const lib = repo.addLibrary(dir, "Music")
    await scanLibrary(lib, settings, ctx())
    let t = repo.queryTracks({}).items[0]
    expect(t.fileCheck).toMatchObject({ realExt: "wav" })
    // Read as what it is, not what it's called.
    expect(t).toMatchObject({ codec: "PCM", duration: 2 })
    expect(fileProblems(t).map((p) => p.kind)).toEqual(["format"])
    expect(repo.queryTracks({ problems: true }).total).toBe(1)

    repo.updateTrack(t.id, { final: { artists: ["Sister Nancy"], featuring: [], title: "Bam Bam" }, status: "approved" })
    const plan = buildPlan(repo.getTracks([t.id]), settings)
    expect(plan[0]).toMatchObject({ toName: "Sister Nancy - Bam Bam.wav", blocked: false })
    await executePlan(plan, settings, { dryRun: false }, ctx())
    const cut = path.join(dir, "Sister Nancy - Bam Bam.wav")
    expect(readManagedTags(cut)).toMatchObject({ artist: "Sister Nancy", title: "Bam Bam" })
    t = repo.queryTracks({}).items[0]
    expect(t).toMatchObject({ ext: "wav", fileCheck: null })
    expect(repo.queryTracks({ problems: true }).total).toBe(0)

    await rewind(null, repo.listBatches()[0].batchId, ctx())
    expect(fs.existsSync(liar)).toBe(true)
    expect(repo.queryTracks({}).items[0]).toMatchObject({ ext: "mp3", fileCheck: { realExt: "wav" } })
  })

  it("measures silence at the ends", async () => {
    const file = path.join(dir, "gap.wav")
    fs.writeFileSync(file, withSilence(3, 6))
    const a = await analyseFile({ file, ext: "wav", duration: 21, bpmMin: 88, integrity: true })
    expect(a.integrity).toMatchObject({ truncated: false, damagedAt: null })
    expect(a.integrity!.silenceStart).toBeCloseTo(3, 0)
    expect(a.integrity!.silenceEnd).toBeCloseTo(6, 0)
    expect(fileProblems({ ext: "wav", fileCheck: null, analysis: a })).toMatchObject([{ kind: "silence", severity: "info", detail: "3 s of silence at the start and 6 s at the end." }])
  })

  it("spots a file that stops short of its stated length", async () => {
    const whole = toWav(synthTrack({ bpm: 120, chords: [[57, "m"]], seconds: 20, sampleRate: 22050 }), 22050)
    const file = path.join(dir, "half.wav")
    fs.writeFileSync(file, whole.subarray(0, Math.round(whole.length * 0.6)))
    // (The tag reader says 12 s: only the header knows it should be 20.)
    const a = await analyseFile({ file, ext: "wav", duration: 12, bpmMin: 88, integrity: true })
    expect(a.integrity).toMatchObject({ truncated: true, expectedSeconds: 20 })
    expect(a.integrity!.decodedSeconds).toBeCloseTo(12, 0)
    const problems = fileProblems({ ext: "wav", fileCheck: null, analysis: a })
    expect(problems[0]).toMatchObject({ kind: "truncated", severity: "error", label: "Cut short" })

    // An MP3 that says (in its VBR header) it's much longer than it is.
    const mp3 = path.join(dir, "short.mp3")
    writeMp3WithXing(mp3, 5000, 600)
    const b = await analyseFile({ file: mp3, ext: "mp3", duration: 130, bpmMin: 88, integrity: true }).catch((e: Error) => e)
    expect(b).not.toBeInstanceOf(Error)
    expect((b as Awaited<ReturnType<typeof analyseFile>>).integrity).toMatchObject({ truncated: true })

    // Never the copy to keep.
    const base = { ext: "wav", codec: "PCM", bitrate: 1_411_200, duration: 20, status: "matched", art: null, path: "/m/a.wav", filename: "a.wav", proposedName: null, fileCheck: null } as const
    const broken = { ...base, id: 1, analysis: a } as unknown as TrackSummary
    const fine = { ...base, id: 2, ext: "mp3", codec: "MPEG", bitrate: 192_000, analysis: null } as unknown as TrackSummary
    expect(rankCopies([broken, fine])).toMatchObject({ best: 2, reasons: { 1: expect.stringContaining("cut short") } })
  })

  it("records where decoding broke off", () => {
    const c = new IntegrityCollector()
    c.push([new Float32Array(44100 * 5).fill(0.2)], 44100)
    expect(c.result(60, "invalid frame")).toMatchObject({ damagedAt: 5, damage: "invalid frame", truncated: false })
    expect(fileProblems({ ext: "flac", fileCheck: null, analysis: { integrity: c.result(60, "x") } as never })[0]).toMatchObject({ kind: "damaged", label: "Damaged" })
  })
})

// ---------- lyrics ----------

const hit = (over: Partial<LrclibHit>): LrclibHit => ({
  id: 1,
  trackName: "Here Comes Trouble",
  artistName: "Chronixx",
  duration: 200,
  instrumental: false,
  plainLyrics: "Here comes trouble\nMan a lion",
  syncedLyrics: "[00:12.00] Here comes trouble\n[00:15.50] Man a lion",
  ...over,
})

function lrclib(hits: LrclibHit[]) {
  const fn = vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url))
    expect(u.host).toBe("lrclib.net")
    return new Response(JSON.stringify(hits), { status: 200, headers: { "content-type": "application/json" } })
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

describe("lyrics", () => {
  const meta = { artists: ["Chronixx"], title: "Here Comes Trouble" }

  it("pick the same song at the same length, timed only when the lengths agree", () => {
    expect(pickLyrics([hit({})], meta, 201)).toMatchObject({ timed: true })
    expect(pickLyrics([hit({})], meta, 210)).toMatchObject({ timed: false })
    expect(pickLyrics([hit({})], meta, 240)).toBeNull()
    expect(pickLyrics([hit({ artistName: "Protoje" })], meta, 200)).toBeNull()
    expect(pickLyrics([hit({ trackName: "Skankin' Sweet" })], meta, 200)).toBeNull()
    // The timed one wins among equals.
    expect(pickLyrics([hit({ id: 1, syncedLyrics: null }), hit({ id: 2 })], meta, 200)?.hit.id).toBe(2)
  })

  it("are looked up for what the track is, and not for dubplates or dubs", async () => {
    const fetch = lrclib([hit({})])
    const track = { id: 1, duration: 200, final: { ...meta, featuring: [] }, decision: null } as never
    const found = await findLyrics(track)
    expect(found).toMatchObject({ found: true, source: "lrclib", synced: expect.stringContaining("[00:12.00]"), plain: expect.stringContaining("Man a lion"), for: lyricsKey(meta) })
    expect(fetch).toHaveBeenCalledTimes(1)
    const special = await findLyrics({ ...(track as object), final: { ...meta, featuring: [], version: "Dubplate for King Addies" } } as never)
    expect(special).toMatchObject({ found: false, reason: expect.stringContaining("Dubplates") })
    const dub = await findLyrics({ ...(track as object), final: { ...meta, featuring: [], version: "Dub" } } as never)
    expect(dub).toMatchObject({ found: false, instrumental: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("are written when cutting, with a .lrc, and rewound", async () => {
    lrclib([hit({ duration: 2 })])
    const file = path.join(dir, "chronixx_here_comes_trouble.wav")
    fs.writeFileSync(file, toWav(synthTrack({ bpm: 100, chords: [[57, "m"]], seconds: 2 }), 44100))
    // Someone's .lrc for the old name comes along too.
    const lib = repo.addLibrary(dir, "Music")
    await scanLibrary(lib, settings, ctx())
    const t = repo.queryTracks({}).items[0]
    repo.updateTrack(t.id, { final: { ...meta, featuring: [] }, status: "approved" })
    const s = structuredClone({ ...settings, lyrics: { ...settings.lyrics, lrcFile: true } })
    const plan0 = buildPlan(repo.getTracks([t.id]), s)
    expect(plan0[0].tagChanges.map((c) => c.field)).not.toContain("lyrics")
    await findLyrics(repo.getTrack(t.id)!).then((l) => repo.updateTrack(t.id, { lyrics: l }))
    const plan = buildPlan(repo.getTracks([t.id]), s)
    expect(plan[0].tags.lyrics).toBe("Here comes trouble\nMan a lion")
    await executePlan(plan, s, { dryRun: false }, ctx())

    const cut = path.join(dir, "Chronixx - Here Comes Trouble.wav")
    const lrc = path.join(dir, "Chronixx - Here Comes Trouble.lrc")
    expect(readManagedTags(cut).lyrics).toBe("Here comes trouble\nMan a lion")
    expect(fs.readFileSync(lrc, "utf8")).toBe("[ar:Chronixx]\n[ti:Here Comes Trouble]\n[00:12.00] Here comes trouble\n[00:15.50] Man a lion\n")
    // The database keeps only a note of them.
    expect(repo.getTrack(t.id)!.tags.lyrics).toBe("2 lines")

    await rewind(null, repo.listBatches()[0].batchId, ctx())
    expect(fs.existsSync(lrc)).toBe(false)
    expect(readManagedTags(file).lyrics).toBeUndefined()
    expect(repo.getTrack(t.id)!.tags.lyrics).toBeUndefined()
  })

  it("an existing .lrc follows its track, and one you've edited isn't taken away", async () => {
    const file = path.join(dir, "old name.wav")
    fs.writeFileSync(file, toWav(synthTrack({ bpm: 100, chords: [[57, "m"]], seconds: 2 }), 44100))
    fs.writeFileSync(path.join(dir, "old name.lrc"), "[00:01.00] mine\n")
    const lib = repo.addLibrary(dir, "Music")
    await scanLibrary(lib, settings, ctx())
    const t = repo.queryTracks({}).items[0]
    repo.updateTrack(t.id, { final: { ...meta, featuring: [] }, status: "approved" })
    await executePlan(buildPlan(repo.getTracks([t.id]), settings), settings, { dryRun: false }, ctx())
    expect(fs.readFileSync(path.join(dir, "Chronixx - Here Comes Trouble.lrc"), "utf8")).toBe("[00:01.00] mine\n")
    await rewind(null, repo.listBatches()[0].batchId, ctx())
    expect(fs.readFileSync(path.join(dir, "old name.lrc"), "utf8")).toBe("[00:01.00] mine\n")
  })
})

// ---------- API tokens and the import hook ----------

describe("API tokens", () => {
  const post = (app: ReturnType<typeof createApp>, url: string, init: RequestInit = {}) => app.request(`http://localhost${url}`, { method: "POST", ...init })

  it("let a download tool in without a browser, and only as far as its scope", async () => {
    const app = createApp()
    const hooks = createToken("qBittorrent", "hooks")
    const full = createToken("Script", "full")
    expect(hooks.token).toMatch(/^dp_/)
    // No X-Dubplate header, a Host the browser guard would refuse: fine with a token.
    const ok = await post(app, "/api/hooks/import", { headers: { authorization: `Bearer ${hooks.token}`, host: "dubplate.docker", "content-type": "application/json" }, body: JSON.stringify({ eventType: "Test" }) })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ test: true })
    // Without one, the guard stands.
    expect((await post(app, "/api/hooks/import", { headers: { host: "dubplate.docker" } })).status).toBe(403)
    // A hooks token can't read the library; a full one can; neither can make tokens.
    expect((await app.request("http://localhost/api/tracks", { headers: { authorization: `Bearer ${hooks.token}` } })).status).toBe(403)
    expect((await app.request("http://localhost/api/tracks", { headers: { authorization: `Bearer ${full.token}` } })).status).toBe(200)
    expect((await app.request("http://localhost/api/tokens", { headers: { authorization: `Bearer ${full.token}` } })).status).toBe(403)
    // Lidarr's username/password box, and a query parameter.
    const basic = Buffer.from(`lidarr:${hooks.token}`).toString("base64")
    expect((await post(app, "/api/hooks/import?x=1", { headers: { authorization: `Basic ${basic}`, "content-type": "application/json" }, body: '{"eventType":"Test"}' })).status).toBe(200)
    expect((await post(app, `/api/hooks/import?token=${hooks.token}`, { headers: { "content-type": "application/json" }, body: '{"eventType":"Test"}' })).status).toBe(200)
    // With a password set, a token is still enough on its own; without one, sign in first.
    process.env.DUBPLATE_PASSWORD = "correct horse battery"
    try {
      expect((await post(app, "/api/hooks/import", { headers: { authorization: `Bearer ${hooks.token}`, "content-type": "application/json" }, body: '{"eventType":"Test"}' })).status).toBe(200)
      expect((await post(app, "/api/hooks/import", { headers: { "x-dubplate": "1", "content-type": "application/json" }, body: '{"eventType":"Test"}' })).status).toBe(401)
    } finally {
      delete process.env.DUBPLATE_PASSWORD
    }
    // A wrong one is refused outright; someone else's bearer token (a proxy's) is ignored.
    expect((await post(app, "/api/hooks/import", { headers: { authorization: "Bearer dp_nope" } })).status).toBe(401)
    expect((await app.request("http://localhost/api/tracks", { headers: { authorization: "Bearer eyJhbGciOi" } })).status).toBe(200)
  })

  it("the hook reads what each tool sends", () => {
    expect(readHook({ type: "DownloadDirectoryComplete", localDirectoryName: "/downloads/Album" }, {})).toMatchObject({ paths: ["/downloads/Album"], from: "slskd", test: false })
    expect(readHook({ eventType: "Download", instanceName: "Lidarr", trackFiles: [{ path: "/music/A/1.flac" }, { path: "/music/A/2.flac" }] }, {})).toMatchObject({ paths: ["/music/A/1.flac", "/music/A/2.flac"], from: "Lidarr" })
    expect(readHook({ eventType: "Test", instanceName: "Lidarr" }, {})).toMatchObject({ test: true, paths: [] })
    expect(readHook({ path: "/dl/x" }, {}, "curl/8.5.0")).toMatchObject({ from: "curl", paths: ["/dl/x"] })
    expect(readHook({}, { path: "/dl/y", from: "qBittorrent" })).toMatchObject({ from: "qBittorrent", paths: ["/dl/y"] })
    expect(readHook("/dl/z\n".trim(), {})).toMatchObject({ paths: ["/dl/z"] })
  })

  it("maps the tool's folders to Dubplate's", () => {
    const map = [
      { from: "/downloads", to: "/music/Downloads" },
      { from: "D:\\Torrents", to: "/music/Torrents" },
    ]
    expect(mapHookPath("/downloads/Album/01.mp3", map)).toBe(path.resolve("/music/Downloads/Album/01.mp3"))
    expect(mapHookPath("/downloadsX/a", map)).toBe(path.resolve("/downloadsX/a"))
    expect(mapHookPath("d:\\torrents\\Album", map)).toBe(path.resolve("/music/Torrents/Album"))
  })

  it("scans the library a download landed in and identifies it", async () => {
    const inbox = path.join(dir, "Downloads")
    fs.mkdirSync(inbox)
    const lib = repo.addLibrary(inbox, "Downloads")
    saveSettings({ ...DEFAULT_SETTINGS, automation: { ...DEFAULT_SETTINGS.automation, autoProcess: false }, lyrics: { ...DEFAULT_SETTINGS.lyrics, fetch: false } })
    writeMp3(path.join(inbox, "wiley_-_wot_do_u_call_it.mp3"))
    // Offline: identifying falls back to the rule-based parser.
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline")
    })
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const r = runHook({ paths: ["/dl/Album", "/elsewhere"], test: false, from: "slskd" }, [{ from: "/dl", to: inbox }], "slskd")
    expect(r.queued).toEqual([{ id: lib.id, name: "Downloads" }])
    expect(r.ignored).toMatchObject([{ path: "/elsewhere", reason: expect.stringContaining("Not inside any library") }])
    expect(recentHookCalls()[0]).toMatchObject({ from: "slskd", libraries: ["Downloads"] })
    vi.advanceTimersByTime(6000)
    vi.useRealTimers()
    await jobsSettled()
    // Identified even with "identify new files" off: someone just sent it in.
    const t = repo.queryTracks({}).items[0]
    expect(t.filename).toBe("wiley_-_wot_do_u_call_it.mp3")
    expect(t.status).not.toBe("new")
  })
})

// ---------- uploads ----------

describe("uploads", () => {
  const put = (app: ReturnType<typeof createApp>, q: string, body: Buffer | string | null, headers: Record<string, string> = {}) =>
    app.request(`http://localhost/api/upload?${q}`, { method: "PUT", body, headers: { "x-dubplate": "1", ...headers } })

  it("save into the library under a free name, and refuse what isn't music", async () => {
    const lib = repo.addLibrary(dir, "Inbox")
    const app = createApp()
    const mp3 = path.join(os.tmpdir(), `dubplate-up-${process.pid}.mp3`)
    writeMp3(mp3)
    const bytes = fs.readFileSync(mp3)
    fs.rmSync(mp3)
    const first = await put(app, `library=${lib.id}&name=${encodeURIComponent("Bam Bam.mp3")}`, bytes)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ name: "Bam Bam.mp3", size: bytes.length, libraryId: lib.id })
    const second = await put(app, `library=${lib.id}&name=${encodeURIComponent("../../Bam Bam.mp3")}`, bytes)
    expect(await second.json()).toMatchObject({ name: "Bam Bam (2).mp3", path: "Bam Bam (2).mp3" })
    expect(fs.readdirSync(dir).sort()).toEqual(["Bam Bam (2).mp3", "Bam Bam.mp3"])

    expect((await put(app, `library=${lib.id}&name=notes.txt`, "hello")).status).toBe(415)
    expect((await put(app, `library=${lib.id}&name=fake.mp3`, "<html>not music</html>")).status).toBe(415)
    expect((await put(app, `library=999&name=a.mp3`, bytes)).status).toBe(400)
    saveSettings({ uploads: { maxMb: 1 } })
    expect((await put(app, `library=${lib.id}&name=big.mp3`, Buffer.alloc(1024 * 1024 + 10, 0xff))).status).toBe(413)
    // Nothing half-written is left behind.
    expect(fs.readdirSync(dir).sort()).toEqual(["Bam Bam (2).mp3", "Bam Bam.mp3"])
    // A folder inside the library is fine; outside it isn't possible.
    const sub = await put(app, `library=${lib.id}&name=x.mp3&dir=${encodeURIComponent("From phone/../..")}`, bytes)
    expect(await sub.json()).toMatchObject({ path: path.join("From phone", "x.mp3") })
  })
})
