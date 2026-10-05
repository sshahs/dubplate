// Listen: a track identified by its sound alone (AcoustID), with what it heard to pick from -
// for files with nothing else to go on, like "Track 01.mp3".
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Correction, Settings } from "../../shared/types"
import { similarCorrections } from "../ai/interpreter"
import { createApp } from "../app"
import { openDb, setDb } from "../db"
import type { JobContext } from "../jobs"
import * as repo from "../repo"
import { scanLibrary } from "../scanner"
import { DEFAULT_SETTINGS, saveSettings } from "../settings"
import { writeMp3 } from "./fixtures"

// A stand-in for Chromaprint's fpcalc: says its version, and gives every file the same fingerprint.
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-fpcalc-"))
const fpcalc = path.join(fakeBin, "fpcalc")
fs.writeFileSync(fpcalc, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "fpcalc version 1.5.1"; else echo '{"duration": 201.5, "fingerprint": "AQADtFakePrint"}'; fi\n`, { mode: 0o755 })
process.env.FPCALC_PATH = fpcalc

// What AcoustID says: one it's sure of, one guess, and a match nobody has named on MusicBrainz.
const ACOUSTID_ANSWER = {
  status: "ok",
  results: [
    { id: "r3", score: 0.41, recordings: [{ id: "mb-dub", title: "Night Nurse (Dub)", duration: 230, artists: [{ name: "Sly & Robbie" }] }] },
    { id: "r1", score: 0.94, recordings: [{ id: "mb-nn", title: "Night Nurse", duration: 202, artists: [{ name: "Gregory Isaacs" }], releasegroups: [{ id: "rg1", title: "Night Nurse", type: "Album" }] }] },
    { id: "r2", score: 0.8, recordings: [{ id: "mb-unknown" }] },
    { id: "r4", score: 0.12, recordings: [{ id: "mb-noise", title: "Something Else", artists: [{ name: "Nobody" }] }] },
  ],
}

let dir: string
const ctx = { job: { id: "j" }, log: () => {}, signal: new AbortController().signal, setTotal: () => {}, tick: () => {}, message: () => {}, tracksChanged: () => {}, filesChanged: () => {}, report: () => {} } as unknown as JobContext
const call = (url: string) => createApp().request(`http://localhost${url}`, { method: "POST", headers: { "x-dubplate": "1" } })

async function trackOne(): Promise<number> {
  writeMp3(path.join(dir, "Track 01.mp3"))
  await scanLibrary(repo.addLibrary(dir, "Dad's tapes"), DEFAULT_SETTINGS, ctx)
  return repo.queryTrackIds({})[0]
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-listen-"))
  setDb(openDb(":memory:"))
})
afterEach(() => vi.unstubAllGlobals())

describe("Listen", () => {
  it("hears what a nameless file is, best match first, and decides it from that", async () => {
    saveSettings({ sources: { ...DEFAULT_SETTINGS.sources, acoustid: { enabled: true, weight: 1.3, apiKey: "app-key" } } } as Partial<Settings>)
    const id = await trackOne()
    const sent: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        sent.push(`${String(input)} ${String(init?.body)}`)
        return new Response(JSON.stringify(ACOUSTID_ANSWER))
      })
    )
    const res = await call(`/api/tracks/${id}/listen`)
    expect(res.status).toBe(200)
    const r = (await res.json()) as { suggestions: { artist: string; title: string; sourceScore: number; album?: string; fingerprint?: boolean }[]; unnamed: number; track: { fingerprint: unknown; decision: { artist: string; title: string; basis: string } } }

    // It asked AcoustID with the file's fingerprint, and nothing else.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^https:\/\/api\.acoustid\.org\/v2\/lookup /)
    expect(sent[0]).toContain("fingerprint=AQADtFakePrint")
    expect(sent[0]).toContain("duration=202")
    // Best first, a weak guess still offered, noise left out; the unnamed match counted.
    expect(r.suggestions.map((c) => [c.artist, c.title, c.sourceScore])).toEqual([
      ["Gregory Isaacs", "Night Nurse", 0.94],
      ["Sly & Robbie", "Night Nurse (Dub)", 0.41],
    ])
    expect(r.suggestions[0]).toMatchObject({ album: "Night Nurse", fingerprint: true })
    expect(r.unnamed).toBe(1)
    // The fingerprint is kept, and the track is decided from what it heard.
    expect(r.track.fingerprint).toMatchObject({ duration: 201.5, fingerprint: "AQADtFakePrint" })
    expect(r.track.decision).toMatchObject({ artist: "Gregory Isaacs", title: "Night Nurse", basis: "sources" })
    expect(repo.getTrack(id)!.candidates?.filter((c) => c.source === "acoustid")).toHaveLength(2)

    // Listening again doesn't pile up a second set of what it heard.
    await call(`/api/tracks/${id}/listen`)
    expect(repo.getTrack(id)!.candidates?.filter((c) => c.source === "acoustid")).toHaveLength(2)
  })

  it("says what it needs when AcoustID isn't set up", async () => {
    saveSettings({ sources: { ...DEFAULT_SETTINGS.sources, acoustid: { enabled: true, weight: 1.3, apiKey: "" } } } as Partial<Settings>)
    const id = await trackOne()
    const res = await call(`/api/tracks/${id}/listen`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/needs an AcoustID application key/)
  })
})

describe("what Approve & learn teaches about nameless files", () => {
  it("never makes one 'Track 101' an example for another", () => {
    const corrections: Correction[] = [{ id: 1, filename: "Track 101.mp3", artists: ["Gregory Isaacs"], title: "Night Nurse", version: null, createdAt: "" }]
    expect(similarCorrections("Track 101.mp3", corrections)).toEqual([])
    expect(similarCorrections("Track 01.mp3", corrections)).toEqual([])
  })
})
