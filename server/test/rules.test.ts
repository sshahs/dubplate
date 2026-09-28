// Escalation, fingerprint-first and shared identifications, the lookup cache,
// AcoustID submission, MusicBrainz seeding and tag updates, canonical genres,
// scraper health and genre weights, the cover check and the decision steps.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Candidate, Decision, Settings, Track } from "../../shared/types"
import { checkSubmissions, eligibility, submitTracks } from "../acoustid-submit"
import { shouldEscalate } from "../ai/escalation"
import { systemPrompt } from "../ai/interpreter"
import { checkCover, coverInDoubt } from "../ai/vision"
import { storeArt } from "../art"
import { tagsFor } from "../core/naming"
import { discogsKind, mbKind } from "../core/releases"
import { getDb, openDb, setDb } from "../db"
import { buildPlan } from "../executor"
import { canonicalGenre, ruleFor } from "../genres"
import { resetJobStateForTests, type JobContext } from "../jobs"
import { completeMbSubmission, startMbSubmission } from "../musicbrainz-seed"
import { processTracks, scoreAndSave } from "../pipeline"
import { targetFolder } from "../placement"
import * as repo from "../repo"
import { scanLibrary } from "../scanner"
import { cleanGenreRules, DEFAULT_SETTINGS, loadSettings, saveSettings, STARTER_GENRE_RULES } from "../settings"
import { BAD_LIMIT, junkResults, recordScraperAnswer } from "../source-health"
import { genreBoost, scourTrack } from "../sources"
import { trackInsight } from "../steps"
import { writeMp3 } from "./fixtures"

let dir: string

function ctx(): JobContext & { logs: string[] } {
  const job = { id: "t", kind: "process", status: "running", label: "t", total: 0, done: 0, failed: 0, message: null, createdAt: "", startedAt: null, finishedAt: null } as JobContext["job"]
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

/** Only MusicBrainz, no extras: keeps the network stub small. */
function quiet(over: Partial<Settings> = {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS)
  s.sources = Object.fromEntries(Object.entries(s.sources).map(([k, v]) => [k, { ...v, enabled: k === "musicbrainz" }]))
  s.scrapers = []
  s.artwork.fetch = false
  s.lyrics.fetch = false
  s.analysis.onProcess = false
  s.safety.readOnly = false
  return { ...s, ...over }
}

type Reply = (url: string, init?: RequestInit) => unknown
function stub(reply: Reply) {
  const calls: { url: string; body?: string }[] = []
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined })
    const out = reply(url, init)
    if (out === undefined) return new Response("{}", { status: 404 })
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } })
  })
  return calls
}

const mbReply = (artist: string, title: string, score = 100) => ({
  recordings: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      score,
      title,
      length: 1500,
      "artist-credit": [{ name: artist, artist: { id: "a1", name: artist } }],
      releases: [{ id: "22222222-2222-2222-2222-222222222222", title: "Bam Bam", status: "Official", "release-group": { id: "g1", "primary-type": "Single" } }],
    },
  ],
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-rules-"))
  setDb(openDb(":memory:"))
  resetJobStateForTests()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

async function scanned(files: string[], bytes?: (f: string) => void): Promise<Track[]> {
  for (const f of files) (bytes ?? ((p) => writeMp3(p)))(path.join(dir, f))
  const lib = repo.addLibrary(dir, "Music")
  await scanLibrary(lib, quiet(), ctx())
  return repo.getTracks(repo.queryTracks({}).items.map((t) => t.id))
}

// ---------- the AI ----------

describe("AI rulebook and escalation", () => {
  it("the prompt carries the metadata rulebook, with the naming settings", () => {
    const p = systemPrompt("Any genre.", { artistJoiner: " x ", clashJoiner: " vs ", featuring: "title" })
    expect(p).toContain("Never invent an album, year, label or catalogue number")
    expect(p).toContain('joins them with "x"')
    expect(p).toContain('"(feat. Name)"')
    expect(p).toMatch(/version "VIP"/)
  })

  it("a middle score or a conflict goes to the second model; nothing-online-knows-it never does", () => {
    const s = quiet()
    s.llm.escalation = { enabled: true, providerId: "ollama", model: "qwen3.6:27b", from: 60, to: 89 }
    const t = (d: Partial<Decision>) => ({ status: "review", escalation: null, decision: { confidence: 70, status: "review", clusters: [{}], ...d } }) as unknown as Track
    expect(shouldEscalate(t({}), s)).toMatch(/scored 70/)
    expect(shouldEscalate(t({ confidence: 95, status: "conflict" }), s)).toBe("sources disagree")
    expect(shouldEscalate(t({ confidence: 95, status: "matched" }), s)).toBeNull()
    // The 75 cap: no source had it at all.
    expect(shouldEscalate(t({ confidence: 75, clusters: [] }), s)).toBeNull()
    expect(shouldEscalate({ ...t({}), status: "approved" } as Track, s)).toBeNull()
    s.llm.escalation.enabled = false
    expect(shouldEscalate(t({}), s)).toBeNull()
  })

  it("an escalated track is read by the second model and always waits for a person", async () => {
    const [track] = await scanned(["sister_nancy_bam_bam.mp3"])
    const s = quiet()
    s.confidence.autoApprove = true
    s.llm.escalation = { enabled: true, providerId: "ollama", model: "big-model", from: 0, to: 100 }
    const models: string[] = []
    stub((url, init) => {
      if (url.includes("/api/chat")) {
        const body = JSON.parse(String(init?.body))
        models.push(body.model)
        const reading = { artists: ["Sister Nancy"], featuring: [], relation: null, title: "Bam Bam", version: null, year: null, riddim: null, event: null, label: null, genre: "Dancehall", country: "JM", confidence: 0.9, reasoning: "", alternatives: [], searchQueries: [] }
        return { message: { content: JSON.stringify(reading) }, prompt_eval_count: 10, eval_count: 5 }
      }
      if (url.includes("musicbrainz.org/ws/2/recording")) return mbReply("Sister Nancy", "Bam Bam")
    })
    await processTracks([track.id], s, { interpret: true, scour: true, force: false }, ctx())
    const t = repo.getTrack(track.id)!
    expect(models).toEqual([DEFAULT_SETTINGS.llm.providers[0].model, "big-model"])
    expect(t.escalation).toMatchObject({ model: "big-model", changed: false })
    expect(t.decision?.escalated?.model).toBe("big-model")
    // Auto-approve is on, and it would have matched: an escalated track still goes to Review.
    expect(t.status).toBe("review")
    expect(t.approvedBy).toBeNull()
  })

  it("a vision model checks a cover only when the match is in doubt", async () => {
    const s = quiet()
    s.llm.vision = { enabled: true, providerId: "ollama", model: "gemma4:12b" }
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex")
    const art = storeArt(new Uint8Array(png), "musicbrainz")!
    const t = { final: { artists: ["Wiley"], featuring: [], title: "Eskimo" }, decision: { status: "matched", clusters: [{ candidates: [] }] } } as unknown as Track
    expect(coverInDoubt(t)).toBeNull()
    expect(coverInDoubt({ ...t, decision: { ...t.decision!, status: "conflict" } })).toMatch(/disagree/)
    const calls = stub((url) => (url.includes("/api/chat") ? { message: { content: '{"matches": false, "confidence": 0.8, "reason": "The cover says Dizzee Rascal"}' } } : undefined))
    const check = await checkCover(t, art, s)
    expect(check).toMatchObject({ matches: false, confidence: 0.8, model: "gemma4:12b" })
    const body = JSON.parse(calls[0].body!)
    expect(body.model).toBe("gemma4:12b")
    expect(body.messages[1].images).toHaveLength(1)
  })
})

// ---------- fingerprint-first, shared identifications and the lookup cache ----------

describe("identification shortcuts", () => {
  it("the same audio is identified once, and the other copy reuses it", async () => {
    const tracks = await scanned(["sister nancy - bam bam.mp3", "copy of sister nancy - bam bam.mp3"])
    expect(tracks[0].hash).toBe(tracks[1].hash)
    const calls = stub((url) => (url.includes("musicbrainz.org") ? mbReply("Sister Nancy", "Bam Bam") : undefined))
    const c1 = ctx()
    await processTracks([tracks[0].id], quiet(), { interpret: false, scour: true, force: false }, c1)
    const asked = calls.length
    expect(asked).toBeGreaterThan(0)
    const c2 = ctx()
    await processTracks([tracks[1].id], quiet(), { interpret: false, scour: true, force: false }, c2)
    expect(calls.length).toBe(asked)
    expect(repo.getTrack(tracks[1].id)!.candidates).toEqual(repo.getTrack(tracks[0].id)!.candidates)
    expect(c2.logs.join()).toMatch(/same audio/)
  })

  it("lookups are kept by normalised artist, title, version and length", async () => {
    const [t] = await scanned(["a.mp3"])
    const calls = stub((url) => (url.includes("musicbrainz.org") ? mbReply("Sister Nancy", "Bam Bam") : undefined))
    await scourTrack(t, { artists: ["Sister Nancy"], featuring: [], title: "Bam Bam" }, quiet(), [])
    const asked = calls.length
    // Different spelling, different request - but the same song: no new lookup.
    const r = await scourTrack(t, { artists: ["SISTER NANCY"], featuring: [], title: "Bam  Bam" }, quiet(), [])
    expect(calls.length).toBe(asked)
    expect(r.candidates[0]).toMatchObject({ title: "Bam Bam" })
  })

  it("each file's first-scan name and tags are kept for good", async () => {
    const [t] = await scanned(["Track 07.mp3"])
    expect(t.original).toMatchObject({ filename: "Track 07.mp3", path: path.join(dir, "Track 07.mp3") })
    repo.updateTrack(t.id, { path: path.join(dir, "Renamed.mp3"), filename: "Renamed.mp3", tags: { artist: "X" } })
    expect(repo.getTrack(t.id)!.original).toMatchObject({ filename: "Track 07.mp3" })
  })
})

// ---------- AcoustID ----------

const MB_REC = "33333333-3333-3333-3333-333333333333"

function verifiedDone(t: Track, over: Partial<Track> = {}): Track {
  const decision = {
    artists: ["Sister Nancy"],
    featuring: [],
    artist: "Sister Nancy",
    title: "Bam Bam",
    confidence: 96,
    status: "matched",
    basis: "sources",
    factors: [],
    warnings: [],
    clusters: [
      {
        artist: "Sister Nancy",
        title: "Bam Bam",
        sources: ["musicbrainz", "discogs"],
        support: 1.8,
        relevance: 1,
        candidates: [{ source: "musicbrainz", sourceLabel: "MusicBrainz", artist: "Sister Nancy", title: "Bam Bam", ids: { mbRecordingId: MB_REC } } as Candidate],
      },
    ],
    versionCheck: { kind: "original", label: "Original", official: true, durationMatch: true, fingerprintMatch: null },
  } as Decision
  const patch: Partial<Track> = {
    decision,
    final: { artists: ["Sister Nancy"], featuring: [], title: "Bam Bam" },
    status: "done",
    approvedBy: "person",
    fingerprint: { duration: 200, fingerprint: "AQADtFmUaEmSJEmSJEmSJA", at: "" },
    ...over,
  }
  repo.updateTrack(t.id, patch)
  return repo.getTrack(t.id)!
}

describe("AcoustID submission", () => {
  const keys = () => {
    const s = quiet()
    s.sources.acoustid = { ...s.sources.acoustid, apiKey: "app-key" }
    s.acoustid = { submit: true, userKey: "user-key" }
    return s
  }

  it("only verified and corrected tracks qualify - stricter than any score", async () => {
    const [t0] = await scanned(["a.mp3"])
    const s = keys()
    const t = verifiedDone(t0)
    expect(eligibility(t, s)).toMatchObject({ eligible: true })
    const failing = (over: Partial<Track>) =>
      eligibility({ ...t, ...over }, s)
        .checks.filter((c) => !c.ok)
        .map((c) => c.key)
    expect(failing({ fingerprint: null })).toEqual(["fingerprint"])
    expect(failing({ status: "approved" })).toEqual(["cut"])
    // Auto-approved, but two independent sources agree: still fine.
    expect(failing({ approvedBy: "auto" })).toEqual([])
    // …not when only one source does.
    expect(failing({ approvedBy: "auto", decision: { ...t.decision!, clusters: [{ ...t.decision!.clusters[0], sources: ["musicbrainz"] }] } })).toEqual(["confirmed"])
    expect(failing({ approvedBy: "auto", decision: { ...t.decision!, status: "conflict" } })).toEqual(["conflict"])
    // Escalated: a person has to approve it.
    expect(failing({ approvedBy: "auto", decision: { ...t.decision!, escalated: { provider: "x", model: "y", at: "", before: { confidence: 70, status: "review", artists: [], title: "" }, changed: false, reason: "" } } })).toEqual(["confirmed"])
    expect(failing({ decision: { ...t.decision!, clusters: [{ ...t.decision!.clusters[0], candidates: [{ ...t.decision!.clusters[0].candidates[0], ids: {} }] }] } })).toEqual([])
    expect(eligibility(t, { ...s, acoustid: { submit: true } }).checks.find((c) => c.key === "keys")?.ok).toBe(false)
  })

  it("sends the fingerprint with its recording, records it, never sends it twice, and follows it to imported", async () => {
    const [t0] = await scanned(["a.mp3"])
    const s = keys()
    const t = verifiedDone(t0)
    const calls = stub((url) => {
      if (url.includes("/v2/submit")) return { status: "ok", submissions: [{ index: "0", id: 42, status: "pending" }] }
      if (url.includes("/v2/submission_status")) return { status: "ok", submissions: [{ id: 42, status: "imported", result: { id: "acoustid-1" } }] }
    })
    expect(await submitTracks([t.id], s, ctx())).toBe(1)
    const form = new URLSearchParams(calls[0].body)
    expect(Object.fromEntries(form)).toMatchObject({ client: "app-key", user: "user-key", "mbid.0": MB_REC, "fingerprint.0": "AQADtFmUaEmSJEmSJEmSJA", "duration.0": "200", "artist.0": "Sister Nancy", "track.0": "Bam Bam" })
    expect(eligibility(repo.getTrack(t.id)!, s)).toMatchObject({ eligible: false, submission: { status: "pending", submissionId: 42 } })
    expect(await submitTracks([t.id], s, ctx())).toBe(0)
    expect(calls.filter((c) => c.url.includes("/v2/submit"))).toHaveLength(1)
    expect(await checkSubmissions(s)).toBe(1)
    expect(eligibility(repo.getTrack(t.id)!, s).submission).toMatchObject({ status: "imported", acoustId: "acoustid-1" })
  })
})

// ---------- MusicBrainz ----------

describe("MusicBrainz release editor", () => {
  it("pre-fills a release from the evidence, and stores the IDs it comes back with", async () => {
    const tracks = await scanned(["01 sister nancy - bam bam.mp3", "02 sister nancy - transport connection.mp3"])
    repo.updateTrack(tracks[0].id, { final: { artists: ["Sister Nancy"], featuring: [], title: "Bam Bam", album: "One Two", year: 1982, label: "Techniques" }, status: "done", tags: { ...tracks[0].tags, track: 1 } })
    repo.updateTrack(tracks[1].id, { final: { artists: ["Sister Nancy"], featuring: ["Yellowman"], title: "Transport Connection", album: "One Two" }, status: "done", tags: { ...tracks[1].tags, track: 2 } })
    const { submission, action, fields } = startMbSubmission([tracks[1].id, tracks[0].id], "http://nas:4455/")
    expect(action).toBe("https://musicbrainz.org/release/add")
    expect(fields).toMatchObject({
      name: "One Two",
      type: "ep",
      status: "official",
      "artist_credit.names.0.name": "Sister Nancy",
      "events.0.date.year": "1982",
      "labels.0.name": "Techniques",
      "mediums.0.format": "Digital Media",
      "mediums.0.track.0.name": "Bam Bam",
      "mediums.0.track.1.name": "Transport Connection",
      "mediums.0.track.1.artist_credit.names.0.join_phrase": " feat. ",
      "mediums.0.track.1.artist_credit.names.1.name": "Yellowman",
      redirect_uri: `http://nas:4455/musicbrainz/done?submission=${submission.id}`,
    })
    expect(fields["mediums.0.track.0.length"]).toMatch(/^\d+$/)
    expect(fields.edit_note).toMatch(/Pre-filled by Dubplate/)
    expect(submission).toMatchObject({ status: "pending", trackIds: [tracks[0].id, tracks[1].id] })

    const release = "44444444-4444-4444-4444-444444444444"
    stub((url) =>
      url.includes(`/release/${release}`)
        ? { id: release, title: "One Two", "release-group": { id: "55555555-5555-5555-5555-555555555555" }, media: [{ tracks: [{ position: 1, title: "Bam Bam", recording: { id: "r1" } }, { position: 2, title: "Transport Connection", recording: { id: "r2" } }] }] }
        : undefined
    )
    const done = await completeMbSubmission(submission.id, `https://musicbrainz.org/release/${release}`)
    expect(done).toMatchObject({ recordings: 2, submission: { status: "received", releaseMbid: release } })
    expect(repo.getTrack(tracks[1].id)!.idsOverride).toEqual({ mbReleaseId: release, mbReleaseGroupId: "55555555-5555-5555-5555-555555555555", mbRecordingId: "r2" })

    // A tag update for the cut file writes them, without renaming anything.
    const plan = buildPlan(repo.getTracks([tracks[0].id]), quiet(), { tagsOnly: true })
    expect(plan[0]).toMatchObject({ rename: false, blocked: false, toPath: tracks[0].path })
    expect(plan[0].tags).toMatchObject({ mbReleaseId: release, mbRecordingId: "r1", mbReleaseGroupId: "55555555-5555-5555-5555-555555555555" })
    await expect(completeMbSubmission(submission.id, "not an id")).rejects.toThrow(/isn't a MusicBrainz release ID/)
  })
})

// ---------- canonical genres ----------

describe("canonical genres", () => {
  const s = () => {
    const x = quiet()
    x.canonicalGenres = { enabled: true, overwrite: true, rules: STARTER_GENRE_RULES }
    return x
  }
  const d = (sourceGenres: string[], country?: string) => ({ sourceGenres, clusters: [{ candidates: country ? [{ country }] : [] }] }) as unknown as Decision
  const t = (over: Partial<Track> = {}) => ({ final: null, ai: null, tags: {}, escalation: null, ...over }) as unknown as Track

  it("map region plus style to one genre from the list", () => {
    expect(canonicalGenre(t(), d(["Grime"]), s())).toMatchObject({ genre: "UK Grime", region: "UK" })
    expect(canonicalGenre(t(), d(["UK Garage", "Electronic"]), s())).toMatchObject({ genre: "UK Garage" })
    expect(canonicalGenre(t(), d(["Hip Hop", "Trap"], "GB"), s())).toMatchObject({ genre: "UK Rap", region: "UK" })
    expect(canonicalGenre(t(), d(["Hip Hop", "Trap"], "US"), s())).toMatchObject({ genre: "Hip-Hop", region: "" })
    // Nobody says where it's from: only the rules that don't need to know.
    expect(canonicalGenre(t(), d(["Boom Bap"]), s())).toMatchObject({ genre: "Hip-Hop" })
    expect(canonicalGenre(t({ ai: { country: "GB", genre: "rap" } as Track["ai"] }), d([]), s())).toMatchObject({ genre: "UK Rap" })
    expect(canonicalGenre(t(), d(["Bashment"]), s())).toMatchObject({ genre: "Reggae" })
    // Your own pick wins; nothing fitting leaves it for you; switched off is nothing at all.
    expect(canonicalGenre(t({ final: { artists: [], featuring: [], title: "", genre: "Reggae" } }), d(["Grime"]), s())).toMatchObject({ genre: "Reggae", from: "your choice" })
    expect(canonicalGenre(t(), d(["Polka"]), s())).toBeNull()
    expect(canonicalGenre(t(), d(["Grime"]), quiet())).toBeNull()
    expect(ruleFor("uk drill", STARTER_GENRE_RULES, "UK")?.genre).toBe("UK Drill")
  })

  it("file into Dee's folders", () => {
    const where = (g: ReturnType<typeof canonicalGenre>) => (g ? [g.region, g.folder].filter(Boolean).join("/") : null)
    const at = (genres: string[], country?: string, over: Partial<Track> = {}, reading: Partial<Decision> = {}) => where(canonicalGenre(t(over), { ...d(genres, country), ...reading }, s()))
    // UK styles live under UK; a genre that names a place counts as from there.
    expect(at(["Grime"])).toBe("UK/UK Grime")
    expect(at(["UK Drill"])).toBe("UK/UK Drill")
    expect(at(["Drill"], "GB")).toBe("UK/UK Drill")
    expect(at(["Drill"], "US")).toBe("Hip-Hop")
    expect(at(["British Hip Hop"])).toBe("UK/UK Rap")
    expect(at(["Hip-Hop"], "US")).toBe("Hip-Hop")
    expect(at(["Hardcore Hip-Hop"], "US")).toBe("Hip-Hop")
    // Words that look alike but aren't: garage rock, hardcore punk, dub techno, dubstep.
    expect(at(["Garage Rock"])).toBeNull()
    expect(at(["Hardcore Punk"])).toBeNull()
    expect(at(["Dub Techno"])).toBeNull()
    expect(at(["Dubstep"])).toBeNull()
    expect(at(["Garage House"])).toBe("House Genres")
    expect(at(["UK Garage", "House"])).toBe("UK/UK Garage")
    // The tag says House; the folder's called House Genres.
    expect(canonicalGenre(t(), d(["Deep House"]), s())).toMatchObject({ genre: "House", folder: "House Genres" })
    expect(at(["Drum & Bass"])).toBe("Drum And Bass")
    expect(at(["Liquid Funk"])).toBe("Drum And Bass")
    expect(at(["Ragga Jungle"])).toBe("Jungle")
    expect(at(["Happy Hardcore"])).toBe("Hardcore")
    expect(at(["Breakbeat Hardcore"])).toBe("Old Skool")
    expect(at(["Rave"])).toBe("Old Skool")
    expect(at(["Dancehall"], "JM")).toBe("Reggae")
    expect(at(["Roots Reggae"])).toBe("Reggae")
    expect(at(["Northern Soul"])).toBe("Oldies")
    expect(at(["Christmas"])).toBe("Christmas Classic Pop")
    expect(at(["Techno"])).toBeNull()
    // A series or instrumental in the title wins over the style.
    expect(at(["UK Drill"], "GB", { filename: "Headie One - Daily Duppy.mp3" } as Partial<Track>)).toBe("UK/Daily Duppy")
    expect(at(["Grime"], "GB", { tags: { album: "SBTV: Warm Up Sessions" } })).toBe("UK/SBTV")
    expect(at(["Grime"], "GB", {}, { version: "Instrumental" })).toBe("UK/Instrumentals")
    expect(at(["Hip Hop"], "US", {}, { version: "Instrumental" })).toBe("Hip-Hop")
    expect(canonicalGenre(t({ filename: "Headie One - Daily Duppy.mp3" } as Partial<Track>), d(["UK Drill"], "GB"), s())?.from).toBe('the title ("daily duppy")')
    // Picking the folder's name counts as picking the genre.
    expect(canonicalGenre(t({ final: { artists: [], featuring: [], title: "", genre: "House Genres" } }), d(["Grime"]), s())).toMatchObject({ genre: "House", from: "your choice" })
  })

  it("replace the old example list nobody switched on with the built-in one", () => {
    const old = ["UK Grime", "UK Garage", "UK Rap", "UK R&B", "Hip Hop", "Reggae", "Dancehall"].map((genre) => ({ genre, region: "", match: [genre.toLowerCase()] }))
    saveSettings({ canonicalGenres: { enabled: false, overwrite: true, rules: old } })
    expect(loadSettings().canonicalGenres.rules.map((r) => r.genre)).toEqual(STARTER_GENRE_RULES.map((r) => r.genre))
    // Switched on, it was chosen: kept as it is.
    saveSettings({ canonicalGenres: { enabled: true, overwrite: true, rules: old } })
    expect(loadSettings().canonicalGenres.rules).toHaveLength(7)
    saveSettings({ canonicalGenres: DEFAULT_SETTINGS.canonicalGenres })
  })

  it("keep a rule's folder name, title words and exclusions when saved", () => {
    const [r] = cleanGenreRules([{ genre: " House ", folder: "House Genres", region: "", match: ["House", "Deep  House"], titles: ["Mix"], exclude: ["Rock"], regions: ["uk"] }])
    expect(r).toEqual({ genre: "House", folder: "House Genres", region: "", match: ["house", "deep house"], titles: ["mix"], exclude: ["rock"], regions: ["UK"] })
    expect(cleanGenreRules([{ genre: "Reggae", folder: "Reggae", region: "", match: [] }])[0]).toEqual({ genre: "Reggae", region: "", match: [] })
  })

  it("are the only genre written, over the file's own, and give folders their region", () => {
    const meta = { artists: ["Wiley"], featuring: [], title: "Eskimo", genre: "Electronic" }
    const naming = DEFAULT_SETTINGS.naming
    expect(tagsFor(meta, { genre: ["Electronic"] }, naming, { canonicalGenre: { genre: "UK Grime", overwrite: true } }).genre).toEqual(["UK Grime"])
    expect(tagsFor(meta, { genre: ["Electronic"] }, naming, { canonicalGenre: { genre: "UK Grime", overwrite: false } }).genre).toBeUndefined()
    // Nothing canonical yet: the source's genre isn't written either.
    expect(tagsFor(meta, {}, naming, { canonicalGenre: { genre: null, overwrite: true } }).genre).toBeUndefined()
    expect(tagsFor(meta, {}, naming, {}).genre).toEqual(["Electronic"])
    const track = { final: meta, decision: d(["Grime"]), tags: {}, ai: null, escalation: null, libraryId: 0, bpm: null, key: null, ext: "mp3" } as unknown as Track
    expect(targetFolder(track, { ...s(), organise: { ...s().organise, template: "[{region}]/{genre}/{artist}" } })).toBe("UK/UK Grime/Wiley")
  })
})

// ---------- sources ----------

describe("scrapers and releases", () => {
  it("a scraper answering with its login or home page is switched off after five in a row", () => {
    saveSettings({ scrapers: [{ ...DEFAULT_SETTINGS.scrapers[0], id: "grm", name: "GRM", enabled: true }] })
    const junk = [
      { source: "scraper:grm", sourceLabel: "GRM", artist: "", title: "Login" },
      { source: "scraper:grm", sourceLabel: "GRM", artist: "", title: "Home" },
    ] as Candidate[]
    expect(junkResults(junk)).toMatch(/"Login", "Home"/)
    expect(junkResults([{ ...junk[0], title: "Shutdown", artist: "Skepta" }])).toBeNull()
    for (let i = 1; i < BAD_LIMIT; i++) expect(recordScraperAnswer("scraper:grm", junkResults(junk), junk)).toBeNull()
    expect(recordScraperAnswer("scraper:grm", junkResults(junk), junk)).toMatch(/Switched off by the health check/)
    expect(loadSettings().scrapers.find((x) => x.id === "grm")).toMatchObject({ enabled: false, disabledReason: expect.stringContaining("Login") })
    // Switched back on by hand: it starts counting afresh.
    saveSettings({ scrapers: loadSettings().scrapers.map((x) => ({ ...x, enabled: true })) })
    expect(loadSettings().scrapers.find((x) => x.id === "grm")?.disabledReason).toBeUndefined()
    expect(recordScraperAnswer("scraper:grm", "error", [])).toBeNull()
    expect((getDb().prepare("SELECT bad_in_a_row FROM source_health").get() as { bad_in_a_row: number }).bad_in_a_row).toBe(1)
  })

  it("a source's own genre weights replace the flat ×1.2", () => {
    const s = quiet()
    s.llm.genres = ["Grime", "Reggae"]
    s.scrapers = [{ ...DEFAULT_SETTINGS.scrapers[0], id: "grm", genres: ["Grime"], genreWeights: { Grime: 1.4, "UK rap": 1.2 } }]
    expect(genreBoost(s, "scraper:grm")).toBeCloseTo(1.4)
    s.scrapers[0].genreWeights = undefined
    expect(genreBoost(s, "scraper:grm")).toBeCloseTo(1.2)
    s.sources.discogs = { ...s.sources.discogs, genreWeights: { Reggae: 1.3 } }
    expect(genreBoost(s, "discogs")).toBeCloseTo(1.3)
  })

  it("release types map the way MusicBrainz and Discogs mean them", () => {
    expect(mbKind("Album", ["Compilation"])).toBe("compilation")
    expect(mbKind("Album", ["Compilation", "DJ-mix"])).toBe("dj-mix")
    expect(mbKind("Album", ["Mixtape/Street"])).toBe("mixtape")
    expect(mbKind("EP", [])).toBe("ep")
    expect(mbKind(undefined, [])).toBe("standalone")
    expect(discogsKind(["Compilation", "Mixed"])).toBe("dj-mix")
    expect(discogsKind(["LP", "Album", "Reissue"])).toBe("remix")
    expect(discogsKind(['7"', "45 RPM", "Single"])).toBe("single")
  })
})

// ---------- steps ----------

describe("decision steps", () => {
  it("answer each question on its own, in order", async () => {
    const [t0] = await scanned(["a.mp3"])
    const s = quiet()
    const t = verifiedDone(t0)
    const insight = trackInsight(scoreAndSave(repo.getTrack(t.id)!, s) && repo.getTrack(t.id)!, s)
    expect(insight.steps.map((x) => x.key)).toEqual(["recording", "version", "safety", "verified", "acoustid", "musicbrainz"])
    expect(insight.steps.find((x) => x.key === "verified")).toMatchObject({ state: "ok", value: "Approved by you" })
    expect(insight.risk.level).toBeDefined()
  })
})
