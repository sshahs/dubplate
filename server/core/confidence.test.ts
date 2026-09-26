import { describe, expect, it } from "vitest"
import type { AiParse, Candidate } from "../../shared/types"
import { scoreTrack, type ScoreInput } from "./confidence"
import { parseFilename } from "./filename-parser"

const thresholds = { autoThreshold: 90, reviewThreshold: 60, parseOnlyMax: 75 }
const weights = { musicbrainz: 1, discogs: 0.95, itunes: 0.85, deezer: 0.8, lastfm: 0.6, bandcamp: 0.75, acoustid: 1.3 }

function ai(partial: Partial<AiParse>): AiParse {
  return {
    artists: [],
    featuring: [],
    title: "",
    confidence: 0.9,
    reasoning: "test",
    alternatives: [],
    searchQueries: [],
    provider: "test",
    model: "test-model",
    ...partial,
  }
}

function cand(source: Candidate["source"], artist: string, title: string, extra: Partial<Candidate> = {}): Candidate {
  return { source, sourceLabel: source, artist, title, ...extra }
}

function input(over: Partial<ScoreInput>): ScoreInput {
  return { heuristic: null, ai: null, tags: {}, candidates: [], duration: null, weights, thresholds, ...over }
}

describe("scoreTrack", () => {
  it("auto-matches when several sources agree with the reading", () => {
    const d = scoreTrack(
      input({
        heuristic: parseFilename("03 - skepta - shutdown.mp3"),
        ai: ai({ artists: ["Skepta"], title: "Shutdown", confidence: 0.95 }),
        duration: 180,
        candidates: [
          cand("musicbrainz", "Skepta", "Shutdown", { duration: 181 }),
          cand("itunes", "Skepta", "Shutdown"),
          cand("deezer", "Skepta", "Shutdown"),
          cand("deezer", "Skepta", "That's Not Me"),
        ],
      })
    )
    expect(d.status).toBe("matched")
    expect(d.confidence).toBeGreaterThanOrEqual(90)
    expect(d.basis).toBe("sources")
    expect(d.artist).toBe("Skepta")
    expect(d.title).toBe("Shutdown")
    expect(d.clusters[0].sources).toEqual(expect.arrayContaining(["musicbrainz", "itunes", "deezer"]))
  })

  it("uses the source spelling but keeps the file's version", () => {
    const d = scoreTrack(
      input({
        ai: ai({ artists: ["chronixx"], title: "here comes trouble", version: "Dubplate" }),
        candidates: [cand("musicbrainz", "Chronixx", "Here Comes Trouble"), cand("itunes", "Chronixx", "Here Comes Trouble")],
      })
    )
    expect(d.artists).toEqual(["Chronixx"])
    expect(d.title).toBe("Here Comes Trouble")
    expect(d.version).toBe("Dubplate")
  })

  it("caps parse-only readings below the auto threshold", () => {
    const d = scoreTrack(
      input({
        heuristic: parseFilename("12_buju_banton_vs_beenie_man_live_93_dubplate.mp3"),
        ai: ai({ artists: ["Buju Banton", "Beenie Man"], relation: "vs", title: "Live Clash", year: 1993, version: "Dubplate", confidence: 0.85 }),
      })
    )
    expect(d.confidence).toBeLessThanOrEqual(75)
    expect(d.status).not.toBe("matched")
    expect(d.warnings.join(" ")).toMatch(/No source confirmation/)
  })

  it("flags conflicts when strong clusters disagree", () => {
    const d = scoreTrack(
      input({
        ai: ai({ artists: ["Tenor Saw"], title: "Ring the Alarm", confidence: 0.6, alternatives: [{ artists: ["Tenor Saw"], title: "Fever" }] }),
        candidates: [
          cand("musicbrainz", "Tenor Saw", "Ring the Alarm"),
          cand("itunes", "Tenor Saw", "Ring the Alarm"),
          cand("discogs", "Tenor Saw", "Fever"),
          cand("deezer", "Tenor Saw", "Fever"),
        ],
      })
    )
    expect(d.status).toBe("conflict")
    expect(d.warnings.join(" ")).toMatch(/disagree/)
  })

  it("matches Title - Artist filenames via the swapped orientation", () => {
    const d = scoreTrack(
      input({
        heuristic: parseFilename("Murder She Wrote - Chaka Demus & Pliers.mp3"),
        candidates: [cand("musicbrainz", "Chaka Demus & Pliers", "Murder She Wrote"), cand("itunes", "Chaka Demus & Pliers", "Murder She Wrote")],
      })
    )
    expect(d.clusters.length).toBeGreaterThan(0)
    expect(d.clusters[0].relevance).toBeGreaterThan(0.8)
  })

  it("trusts an audio fingerprint over a useless filename", () => {
    const d = scoreTrack(
      input({
        heuristic: parseFilename("track 07.mp3"),
        candidates: [cand("acoustid", "Super Cat", "Ghetto Red Hot", { fingerprint: true, sourceScore: 0.97 })],
      })
    )
    expect(d.basis).toBe("sources")
    expect(d.artists).toEqual(["Super Cat"])
    expect(d.factors.some((f) => f.key === "fingerprint")).toBe(true)
  })

  it("keeps duos credited as one act intact when respelling", () => {
    const d = scoreTrack(
      input({
        ai: ai({ artists: ["chaka demus & pliers"], title: "murder she wrote" }),
        candidates: [cand("musicbrainz", "Chaka Demus & Pliers", "Murder She Wrote"), cand("itunes", "Chaka Demus & Pliers", "Murder She Wrote")],
      })
    )
    expect(d.artists).toEqual(["Chaka Demus & Pliers"])
  })

  it("respells each clash artist from the source credit", () => {
    const d = scoreTrack(
      input({
        ai: ai({ artists: ["buju banton", "beenie man"], relation: "vs", title: "Murderer" }),
        candidates: [cand("musicbrainz", "Buju Banton", "Murderer"), cand("itunes", "Buju Banton", "Murderer")],
      })
    )
    expect(d.artists).toEqual(["Buju Banton", "beenie man"])
  })

  it("ignores irrelevant hits", () => {
    const d = scoreTrack(
      input({
        ai: ai({ artists: ["Kano"], title: "P's and Q's" }),
        candidates: [cand("itunes", "Taylor Swift", "Shake It Off")],
      })
    )
    expect(d.clusters).toHaveLength(0)
  })
})
