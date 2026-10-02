// WMA tags written without damaging the file, damage from the old bug spotted,
// and the converter: videos found by scans, their audio pulled out (kept as it
// is where possible), never over an existing file, and rewound. The converter
// tests make their own videos with ffmpeg and are skipped without it.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { planConversion } from "../../shared/convert"
import { fileProblems } from "../../shared/problems"
import type { MediaAudioStream, Settings } from "../../shared/types"
import { convertVideos } from "../convert"
import { openDb, setDb } from "../db"
import { rewind } from "../executor"
import { resetJobStateForTests, type JobContext } from "../jobs"
import { findFfmpeg, probeMedia, runFfmpeg } from "../media/ffmpeg"
import { browserPlays, previewCopy } from "../media/preview"
import * as repo from "../repo"
import { readAudio, scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS, saveSettings } from "../settings"
import { asfDamage, readManagedTags, writeTags } from "../tagger"
import { listVideos } from "../videos"

const TONE_WMA = path.join(import.meta.dirname, "assets", "tone.wma")
const ASF_DATA = Buffer.from("3626b2758e66cf11a6d900aa0062ce6c", "hex")

let dir: string

function ctx(): JobContext & { logs: string[] } {
  const job = { id: "t", kind: "convert", status: "running", label: "t", total: 0, done: 0, failed: 0, message: null, createdAt: "", startedAt: null, finishedAt: null } as JobContext["job"]
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

function settings(over: Partial<Settings["convert"]> = {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS)
  s.safety.readOnly = false
  s.scanner.hashFiles = true
  s.convert = { ...s.convert, ...over }
  return s
}

/** The ASF data object: where it starts (right after the header) and its bytes. */
function dataObject(file: string) {
  const b = fs.readFileSync(file)
  const header = Number(b.readBigUInt64LE(16))
  const size = Number(b.readBigUInt64LE(header + 16))
  return { at: header, guid: b.subarray(header, header + 16), bytes: b.subarray(header, header + size) }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-media-"))
  setDb(openDb(":memory:"))
  resetJobStateForTests()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("WMA", () => {
  it("gets its tags without its audio being touched", () => {
    const file = path.join(dir, "tone.wma")
    fs.copyFileSync(TONE_WMA, file)
    const before = dataObject(file)
    // A header that grows (new fields, padding) must move the audio along, not overwrite it.
    writeTags(file, { title: "Tone (Special)", album: "Test", genre: ["Reggae"], bpm: 120, key: "Am", label: "Greensleeves", comment: "Identified by Dubplate" })
    const after = dataObject(file)
    expect(after.at).toBeGreaterThan(before.at)
    expect(after.guid.equals(ASF_DATA)).toBe(true)
    expect(after.bytes.equals(before.bytes)).toBe(true)
    expect(fs.statSync(file).size).toBe(fs.statSync(TONE_WMA).size + (after.at - before.at))
    expect(asfDamage(file)).toBeNull()
    expect(readManagedTags(file)).toMatchObject({ title: "Tone (Special)", album: "Test", bpm: 120, key: "Am", label: "Greensleeves" })
    // Shrinking it again is just as safe.
    writeTags(file, { album: null, label: null, key: null, comment: null })
    expect(dataObject(file).bytes.equals(before.bytes)).toBe(true)
  })

  it("is read with its key and label, and an overwritten header is called out", async () => {
    const file = path.join(dir, "tone.wma")
    fs.copyFileSync(TONE_WMA, file)
    writeTags(file, { key: "F#m", label: "Jammy's" })
    expect((await readAudio(file)).tags).toMatchObject({ key: "F#m", label: "Jammy's" })

    // What the old writer left: the header's end runs on into what was the audio.
    const broken = path.join(dir, "broken.wma")
    const b = fs.readFileSync(TONE_WMA)
    const header = Number(b.readBigUInt64LE(16))
    b.fill(0x4e, header, header + 64)
    fs.writeFileSync(broken, b)
    expect(asfDamage(broken)).toMatch(/runs over the start of the audio/)
    const read = await readAudio(broken)
    expect(read.fileCheck?.containerDamage).toMatch(/runs over/)
    const problems = fileProblems({ fileCheck: read.fileCheck, analysis: { integrity: { decodedSeconds: 0, expectedSeconds: 3, truncated: true, damagedAt: null, silenceStart: 0, silenceEnd: 0 } } as never, ext: "wma" })
    expect(problems.map((p) => p.kind)).toEqual(["damaged"])
  })

  it("isn't something browsers play, so previews are converted", () => {
    expect(browserPlays("wma")).toBe(false)
    expect(browserPlays("aiff")).toBe(false)
    expect(browserPlays("mp3")).toBe(true)
    expect(browserPlays("flac")).toBe(true)
  })
})

describe("conversion plan", () => {
  const stream = (codec: string, codecName = codec.toUpperCase()): MediaAudioStream => ({ index: 0, codec, codecName, sampleRate: 44100, channels: 2, bitRate: 128000, duration: 60 })
  const opts = DEFAULT_SETTINGS.convert

  it("keeps the audio as it is wherever an audio file can hold it", () => {
    expect(planConversion(stream("aac"), opts)).toMatchObject({ mode: "copy", ext: "m4a" })
    expect(planConversion(stream("mp3"), opts)).toMatchObject({ mode: "copy", ext: "mp3" })
    expect(planConversion(stream("wmav2", "WMA"), opts)).toMatchObject({ mode: "copy", ext: "wma" })
    expect(planConversion(stream("opus"), opts)).toMatchObject({ mode: "copy", ext: "opus" })
    // Uncompressed: FLAC holds it exactly.
    expect(planConversion(stream("pcm_s16le", "PCM"), opts)).toMatchObject({ mode: "encode", ext: "flac" })
  })

  it("re-encodes what an audio file can't hold, to the format chosen", () => {
    expect(planConversion(stream("amr_nb", "AMR (phone)"), opts)).toMatchObject({ mode: "encode", ext: "mp3", label: "AMR (phone) re-encoded to MP3 (VBR V0)" })
    expect(planConversion(stream("ac3"), { ...opts, encodeTo: "m4a" })).toMatchObject({ mode: "encode", ext: "m4a" })
    // Asked to always re-encode: everything goes to the chosen format, except what's already in it.
    expect(planConversion(stream("aac"), { ...opts, keepAudio: false })).toMatchObject({ mode: "encode", ext: "mp3" })
    expect(planConversion(stream("mp3"), { ...opts, keepAudio: false })).toMatchObject({ mode: "copy", ext: "mp3" })
    expect(planConversion(stream("flac"), { ...opts, keepAudio: false, encodeTo: "flac" })).toMatchObject({ mode: "copy", ext: "flac" })
  })
})

describe.skipIf(!findFfmpeg())("the converter", () => {
  const SRC = "aevalsrc=0.3*sin(2*PI*220*t)+0.6*exp(-25*mod(t\\,0.5))*sin(2*PI*55*t):s=44100:d=6"
  async function video(name: string, audio: string[], video = ["-c:v", "mpeg4"], size = "160x120") {
    const out = path.join(dir, name)
    await runFfmpeg(["-f", "lavfi", "-i", `testsrc=size=${size}:rate=10:duration=6`, "-f", "lavfi", "-i", SRC, "-shortest", ...video, ...audio, out])
    return out
  }

  it("finds videos in a scan, pulls their audio out, and rewinds", async () => {
    await video("Kano - Ps and Qs (Official Video).avi", ["-c:a", "libmp3lame", "-b:a", "128k"])
    await video("Dizzee Rascal - Fix Up Look Sharp.3gp", ["-c:a", "aac", "-b:a", "96k"], ["-c:v", "mpeg4"], "176x144")
    await video("Wiley - Eskimo (live).avi", ["-c:a", "pcm_s16le"])
    await video("Super Cat - Ghetto Red Hot.wmv", ["-c:a", "wmav2", "-b:a", "96k", "-metadata", "title=Ghetto Red Hot", "-metadata", "artist=Super Cat"], ["-c:v", "wmv2"])
    await video("Skepta - Shutdown.avi", ["-c:a", "ac3", "-b:a", "128k"])
    // Already a file by the name the Kano audio would get: it must not be touched.
    fs.writeFileSync(path.join(dir, "Kano - Ps and Qs (Official Video).mp3"), "not mine")
    const lib = repo.addLibrary(dir, "Music")
    const s = settings({ originals: "aside" })
    saveSettings(s)

    // A scan lists the videos (and only reads them).
    const scan = await scanLibrary(lib, s, ctx())
    expect(scan.videos).toHaveLength(5)
    expect(scan.added).toHaveLength(1) // just the existing .mp3
    const videos = listVideos()
    expect(videos.find((v) => v.ext === "3gp")?.probe).toMatchObject({ video: true, audio: [{ codec: "aac" }] })

    const c = ctx()
    const libs = await convertVideos(
      videos.map((v) => v.id),
      s,
      c
    )
    expect(c.job.failed).toBe(0)
    expect(libs).toEqual([lib.id])
    const made = fs.readdirSync(dir).filter((f) => !/\.(avi|3gp|wmv)$/.test(f) && !f.startsWith("."))
    expect(made.sort()).toEqual(
      [
        "Dizzee Rascal - Fix Up Look Sharp.m4a",
        "Kano - Ps and Qs (Official Video) (2).mp3",
        "Kano - Ps and Qs (Official Video).mp3",
        "Skepta - Shutdown.mp3",
        "Super Cat - Ghetto Red Hot.wma",
        "Wiley - Eskimo (live).flac",
        DEFAULT_SETTINGS.duplicates.holdingFolder,
      ].sort()
    )
    expect(fs.readFileSync(path.join(dir, "Kano - Ps and Qs (Official Video).mp3"), "utf8")).toBe("not mine")
    // Kept as they were, or re-encoded where they had to be.
    const codecOf = async (f: string) => (await probeMedia(path.join(dir, f))).audio[0].codec
    expect(await codecOf("Dizzee Rascal - Fix Up Look Sharp.m4a")).toBe("aac")
    expect(await codecOf("Super Cat - Ghetto Red Hot.wma")).toBe("wmav2")
    expect(await codecOf("Wiley - Eskimo (live).flac")).toBe("flac")
    expect(await codecOf("Skepta - Shutdown.mp3")).toBe("mp3")
    expect(Math.round((await probeMedia(path.join(dir, "Skepta - Shutdown.mp3"))).duration!)).toBe(6)
    // The video's tags come along.
    expect((await readAudio(path.join(dir, "Super Cat - Ghetto Red Hot.wma"))).tags).toMatchObject({ title: "Ghetto Red Hot", artist: "Super Cat" })
    // The videos went to the holding folder; scans leave them be, and pick up the new audio.
    expect(fs.readdirSync(path.join(dir, DEFAULT_SETTINGS.duplicates.holdingFolder)).sort()).toHaveLength(5)
    expect(listVideos().every((v) => v.status === "converted" && v.asideFrom && !v.missing)).toBe(true)
    const again = await scanLibrary(lib, s, ctx())
    expect(again.added).toHaveLength(5)
    expect(again.videos).toHaveLength(0)
    expect(listVideos()).toHaveLength(5)

    // Rewind: the audio files go, the videos come back, ready to convert again.
    const batch = repo.listOperations().find((o) => o.kind === "convert")!.batchId
    const r = ctx()
    await rewind(null, batch, r)
    expect(r.job.failed).toBe(0)
    expect(fs.readdirSync(dir).filter((f) => !f.startsWith(".")).sort()).toEqual(
      [
        "Dizzee Rascal - Fix Up Look Sharp.3gp",
        "Kano - Ps and Qs (Official Video).avi",
        "Kano - Ps and Qs (Official Video).mp3",
        "Skepta - Shutdown.avi",
        "Super Cat - Ghetto Red Hot.wmv",
        "Wiley - Eskimo (live).avi",
      ].sort()
    )
    expect(listVideos().every((v) => v.status === "found" && !v.asideFrom && path.dirname(v.path) === dir)).toBe(true)
  }, 30_000) // three videos made and converted with ffmpeg: well past the 5 s default on a busy machine

  it("leaves a converted file alone on rewind once it's been changed", async () => {
    await video("Clip.avi", ["-c:a", "libmp3lame", "-b:a", "128k"])
    const lib = repo.addLibrary(dir, "Music")
    const s = settings()
    await scanLibrary(lib, s, ctx())
    await convertVideos(
      listVideos().map((v) => v.id),
      s,
      ctx()
    )
    // Kept where it was (the default).
    expect(fs.existsSync(path.join(dir, "Clip.avi"))).toBe(true)
    writeTags(path.join(dir, "Clip.mp3"), { title: "Tagged since" })
    const r = ctx()
    await rewind(null, repo.listOperations()[0].batchId, r)
    expect(r.job.failed).toBe(1)
    expect(fs.existsSync(path.join(dir, "Clip.mp3"))).toBe(true)
  })

  it("makes an MP3 copy for previewing what browsers can't play", async () => {
    const st = fs.statSync(TONE_WMA)
    const out = await previewCopy(TONE_WMA, st.size, st.mtimeMs)
    expect((await probeMedia(out)).audio[0].codec).toBe("mp3")
    expect(await previewCopy(TONE_WMA, st.size, st.mtimeMs)).toBe(out)
  })
})
