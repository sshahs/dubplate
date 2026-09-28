// The golden dataset: hand-checked cases with the answer a careful selector
// would give, run through the real scoring. It's what says whether a rule is
// safe to loosen - change a threshold, and these show what it costs.
import { describe, expect, it } from "vitest"
import { riskOf } from "../../shared/risk"
import type { Candidate, Decision, ReleaseInfo } from "../../shared/types"
import { scoreTrack, type ScoreInput } from "../core/confidence"
import { idsFor } from "../core/ids"

const THRESHOLDS = { autoThreshold: 90, reviewThreshold: 60, parseOnlyMax: 75 }
const WEIGHTS = { musicbrainz: 1, discogs: 0.95, acoustid: 1, spotify: 0.85, itunes: 0.85, deezer: 0.8, "discogs-collection": 1.2, "scraper:soundclash-hub": 0.3 }

const rel = (over: Partial<ReleaseInfo>): ReleaseInfo => ({ source: "musicbrainz", title: "?", kind: "album", own: null, status: "Official", ...over })

function mb(artist: string, title: string, releases: ReleaseInfo[], over: Partial<Candidate> = {}): Candidate {
  return {
    source: "musicbrainz",
    sourceLabel: "MusicBrainz",
    artist,
    artists: [artist],
    title,
    duration: 200,
    sourceScore: 1,
    ids: { mbRecordingId: "rec-1", mbReleaseId: releases[0]?.id },
    releases: releases.map((r) => ({ recordingId: "rec-1", length: 200, ...r })),
    ...over,
  }
}

function other(source: "discogs" | "spotify" | "itunes", artist: string, title: string, over: Partial<Candidate> = {}): Candidate {
  const label = { discogs: "Discogs", spotify: "Spotify", itunes: "Apple Music" }[source]
  return { source, sourceLabel: label, artist, artists: [artist], title, duration: 201, ...over }
}

function score(filename: string, candidates: Candidate[], over: Partial<ScoreInput> = {}): Decision {
  const [artist, title] = filename.replace(/\.\w+$/, "").split(" - ")
  return scoreTrack({
    heuristic: { artists: [artist], featuring: [], title: title ?? "", cleaned: filename, hints: [], confidence: 0.8, notes: [] },
    ai: null,
    tags: {},
    candidates,
    duration: 200,
    weights: WEIGHTS,
    thresholds: THRESHOLDS,
    context: { filename, folders: [], preferOwnRelease: true },
    ...over,
  })
}

interface Case {
  name: string
  decide: () => Decision
  expect: { status?: Decision["status"]; maxConfidence?: number; album?: string; kind?: ReleaseInfo["kind"]; risk?: "low" | "medium" | "high"; basis?: Decision["basis"]; releaseId?: string; versionKind?: string }
}

const COMPILATION = rel({ id: "now-85", title: "NOW That's What I Call Music! 85", kind: "compilation", own: false, date: "2013-07-22" })
const ALBUM = rel({ id: "album-1", title: "Dread & Terrible", kind: "album", own: true, date: "2014-06-10" })
const SINGLE = rel({ id: "single-1", title: "Here Comes Trouble", kind: "single", own: true, date: "2013-04-01" })
const DJMIX = rel({ id: "fabric-1", title: "FabricLive 99", kind: "dj-mix", own: false, date: "2018-05-01" })

const CASES: Case[] = [
  {
    name: "a NOW! compilation doesn't win over the artist's own releases, however tidy its data",
    decide: () => score("Chronixx - Here Comes Trouble.mp3", [mb("Chronixx", "Here Comes Trouble", [COMPILATION, SINGLE, ALBUM]), other("discogs", "Chronixx", "Here Comes Trouble")]),
    expect: { album: "Dread & Terrible", kind: "album", risk: "low", releaseId: "album-1" },
  },
  {
    name: "the file's own album tag names the compilation: it keeps that relationship",
    decide: () => score("Chronixx - Here Comes Trouble.mp3", [mb("Chronixx", "Here Comes Trouble", [ALBUM, COMPILATION]), other("discogs", "Chronixx", "Here Comes Trouble")], { tags: { album: "NOW That's What I Call Music! 85" } }),
    expect: { album: "NOW That's What I Call Music! 85", kind: "compilation", releaseId: "now-85" },
  },
  {
    name: "a continuous mix keeps the DJ mix it's from, which isn't just another compilation",
    decide: () =>
      score("Various - FabricLive 99 (continuous mix).mp3", [mb("Various", "FabricLive 99 (continuous mix)", [COMPILATION, DJMIX], { duration: 3600 })], {
        duration: 3600,
        heuristic: { artists: ["Various"], featuring: [], title: "FabricLive 99 (continuous mix)", cleaned: "", hints: [], confidence: 0.8, notes: [] },
      }),
    expect: { kind: "dj-mix", versionKind: "dj-mix" },
  },
  {
    name: "a version only on a mix (its length matches nothing else) keeps the mix",
    decide: () =>
      score("Skepta - Shutdown.mp3", [
        mb("Skepta", "Shutdown", [
          { ...rel({ id: "konnichiwa", title: "Konnichiwa", kind: "album", own: true }), length: 172 },
          { ...rel({ id: "mix-1", title: "Rinse Presents", kind: "dj-mix", own: false }), length: 200 },
        ]),
        other("discogs", "Skepta", "Shutdown"),
      ]),
    expect: { kind: "dj-mix" },
  },
  {
    name: "a radio edit belongs to the single its length matches, not the album",
    decide: () =>
      score("Wiley - Wot Do U Call It.mp3", [
        mb("Wiley", "Wot Do U Call It", [
          { ...rel({ id: "tad", title: "Treddin' on Thin Ice", kind: "album", own: true }), length: 240 },
          { ...rel({ id: "wdyci", title: "Wot Do U Call It?", kind: "single", own: true }), length: 199 },
        ]),
        other("discogs", "Wiley", "Wot Do U Call It"),
      ]),
    expect: { kind: "single", releaseId: "wdyci", versionKind: "exclusive" },
  },
  {
    name: "a dubplate no source knows stays capped at 75 and high risk",
    decide: () => score("Chronixx - Here Comes Trouble (Dubplate for King Addies).mp3", []),
    expect: { basis: "heuristic", risk: "high", maxConfidence: 75 },
  },
  {
    name: "one source alone matches, but that's medium risk: a person looks",
    decide: () => score("Kano - P's and Q's.mp3", [mb("Kano", "P's and Q's", [rel({ id: "hwe", title: "Home Sweet Home", kind: "album", own: true })])]),
    expect: { risk: "medium" },
  },
  {
    name: "a supporting-only source never confirms a clash on its own",
    decide: () =>
      score("Stone Love vs Killamanjaro - Clash 1995.mp3", [{ source: "scraper:soundclash-hub", sourceLabel: "SoundClash Hub", artist: "Stone Love vs Killamanjaro", title: "Clash 1995" }], {
        supporting: new Set(["scraper:soundclash-hub"]),
      }),
    expect: { basis: "heuristic", risk: "high" },
  },
  {
    name: "sources in conflict are high risk whatever the score",
    decide: () =>
      score("Tenor Saw - Ring the Alarm.mp3", [
        mb("Tenor Saw", "Ring the Alarm", [rel({ id: "a", title: "Fever", kind: "album", own: true })]),
        other("discogs", "Tenor Saw", "Ring the Alarm"),
        { ...other("spotify", "Tenor Saw", "Ring Di Alarm Quick"), sourceScore: 1 },
        { ...other("itunes", "Tenor Saw", "Ring Di Alarm Quick") },
      ]),
    expect: { risk: "high" },
  },
]

describe("golden dataset", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const d = c.decide()
      if (c.expect.status) expect(d.status).toBe(c.expect.status)
      if (c.expect.basis) expect(d.basis).toBe(c.expect.basis)
      if (c.expect.maxConfidence !== undefined) expect(d.confidence).toBeLessThanOrEqual(c.expect.maxConfidence)
      if (c.expect.album) expect(d.album).toBe(c.expect.album)
      if (c.expect.kind) expect(d.release?.release.kind).toBe(c.expect.kind)
      if (c.expect.versionKind) expect(d.versionCheck?.kind).toBe(c.expect.versionKind)
      if (c.expect.risk) expect(riskOf({ decision: d, analysis: null, fileCheck: null, ext: "mp3" }).level).toBe(c.expect.risk)
      if (c.expect.releaseId) expect(idsFor(d, { artists: d.artists, featuring: [], title: d.title }).mbReleaseId).toBe(c.expect.releaseId)
    })
  }

  it("keeps a note of where each field came from", () => {
    const d = score("Chronixx - Here Comes Trouble.mp3", [mb("Chronixx", "Here Comes Trouble", [SINGLE, ALBUM], { year: 2013 }), other("discogs", "Chronixx", "Here Comes Trouble", { label: "Soul Circle" })])
    expect(d.provenance).toMatchObject({ artists: "MusicBrainz", title: "MusicBrainz", year: "MusicBrainz", label: "Discogs", release: "MusicBrainz", album: "MusicBrainz (album)" })
  })
})
