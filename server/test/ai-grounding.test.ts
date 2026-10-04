// The AI reads one file. Earlier approvals are shown as context only, and whatever it says that
// only the file can state (version, year, label, riddim, event) is kept only where the file states it.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fileSays, groundReading } from "../../shared/fields"
import type { Correction, Track } from "../../shared/types"
import { buildUserPrompt, interpretTrack, similarCorrections, systemPrompt } from "../ai/interpreter"
import { scoreTrack } from "../core/confidence"
import { parseFilename } from "../core/filename-parser"
import { openDb, setDb } from "../db"
import * as repo from "../repo"
import { DEFAULT_SETTINGS } from "../settings"

const provider = { id: "t", kind: "ollama" as const, label: "Test model", baseUrl: "http://ollama.test", model: "m", enabled: true }

/** Five Asco tunes the owner approved as dubplates - the trap the AI fell into. */
const ascoDubplates: Correction[] = ["Bad Boy", "Ting Dun", "No Hook", "Wagwan", "Mad Ting"].map((title, i) => ({
  id: i + 1,
  filename: `Asco - ${title}.flac`,
  artists: ["Asco"],
  title,
  version: "Dubplate",
  createdAt: "",
}))

function trackFor(filename: string, over: Partial<Track> = {}): Track {
  return { id: 1, libraryId: 1, filename, relDir: "UK Rap/Asco", tags: {}, duration: 180, heuristic: parseFilename(filename), ...over } as unknown as Track
}

describe("what the AI may only say when the file does", () => {
  it("keeps a version, year, label, riddim or event only where the file states it", () => {
    const said = { version: "Dubplate", year: 2019, label: "Asco Music", riddim: "Stalag", event: "Sting" }
    expect(groundReading(said, ["Asco - STRAIGHT DROP .flac", "UK Rap/Asco"])).toEqual({
      reading: { version: undefined, year: undefined, label: undefined, riddim: undefined, event: undefined },
      unsupported: ['version "Dubplate"', "year 2019", 'label "Asco Music"', 'riddim "Stalag"', 'event "Sting"'],
    })
    const stated = ["Asco - Straight Drop (Dub Plate) 2019.flac", "Asco Music/Stalag Riddim", "live at sting"]
    expect(groundReading(said, stated)).toEqual({ reading: said, unsupported: [] })
  })

  it("knows a year however a filename writes it, and not a number that isn't one", () => {
    for (const name of ["Clash 1993.mp3", "Jaro vs Stone Love '93.mp3", "Bodyguard live 93.mp3", "Sting 26.12.93.mp3"]) expect(groundReading({ year: 1993 }, [name]).unsupported).toEqual([])
    for (const name of ["Track 93.mp3", "Bodyguard.mp3"]) expect(groundReading({ year: 1993 }, [name]).unsupported).toEqual(["year 1993"])
  })

  it("reads the file's own tags as part of what it says", () => {
    expect(fileSays({ filename: "a.flac", relDir: "UK Rap", tags: { label: "Jah Shaka Music", year: 1995, genre: ["Dub"] } })).toEqual(["a.flac", "UK Rap", "Jah Shaka Music", "1995", "Dub"])
    expect(groundReading({ label: "Jah Shaka Music", year: 1995 }, fileSays({ filename: "a.flac", tags: { label: "Jah Shaka Music", year: 1995 } })).unsupported).toEqual([])
  })
})

describe("the AI's examples", () => {
  it("are fenced off as context only, before the file it's reading, with no version this file doesn't share", () => {
    const prompt = buildUserPrompt(trackFor("Asco - STRAIGHT DROP .flac"), ascoDubplates)
    expect(prompt.startsWith("EXAMPLES - other files the owner approved, for context only.")).toBe(true)
    expect(prompt).toContain("They are different recordings: never copy anything from them into your answer.")
    expect(prompt).toContain('- "Asco - Bad Boy.flac" → Asco - Bad Boy\n')
    expect(prompt).not.toContain("Dubplate")
    expect(prompt.indexOf("THIS FILE - your answer is about this file only:")).toBeGreaterThan(prompt.indexOf("Mad Ting"))
    expect(prompt.trimEnd().endsWith("Answer for THIS FILE. The examples above are context only - nothing in your answer may come from them.")).toBe(true)
    // with no examples, just the file
    expect(buildUserPrompt(trackFor("Asco - STRAIGHT DROP .flac"), []).startsWith("THIS FILE")).toBe(true)
    // the rules say the same
    expect(systemPrompt("Any genre.")).toContain("They are examples for context only")
    expect(systemPrompt("Any genre.")).toContain("check each of version, year, label, riddim and event: if this file's name, folder or tags don't state it, it's null")
  })

  it("aren't picked for sharing a common word like remix or dubplate", () => {
    const corrections: Correction[] = [
      { id: 1, filename: "Wiley - Eskimo (Remix).mp3", artists: ["Wiley"], title: "Eskimo", version: "Remix", createdAt: "" },
      { id: 2, filename: "Asco - Bad Boy.flac", artists: ["Asco"], title: "Bad Boy", version: null, createdAt: "" },
    ]
    expect(similarCorrections("Asco - Straight Drop (Remix).flac", corrections).map((c) => c.id)).toEqual([2])
    expect(similarCorrections("Skepta - Shutdown (Dubplate).mp3", corrections)).toEqual([])
  })
})

describe("a model that copies the examples anyway", () => {
  beforeEach(() => {
    setDb(openDb(":memory:"))
    repo.addLibrary(fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-ai-")), "Crate")
  })
  afterEach(() => vi.unstubAllGlobals())

  it("has what the file doesn't state left out, and the track says so", async () => {
    const sent: { messages: { role: string; content: string }[] }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)))
        const answer = {
          artists: ["Asco"],
          featuring: [],
          relation: null,
          title: "Straight Drop",
          version: "Dubplate",
          year: 2019,
          riddim: "Stalag",
          event: null,
          label: "Asco Music",
          genre: "UK Rap",
          country: "GB",
          confidence: 0.8,
          reasoning: "Like the owner's other Asco files, a dubplate.",
          alternatives: [],
          searchQueries: ["Asco Straight Drop"],
        }
        return new Response(JSON.stringify({ message: { content: JSON.stringify(answer) }, prompt_eval_count: 900, eval_count: 80 }))
      })
    )
    const track = trackFor("Asco - STRAIGHT DROP .flac")
    const ai = await interpretTrack(track, DEFAULT_SETTINGS, { corrections: ascoDubplates, aliases: new Map(), provider })

    // It was told: the examples were context only, and showed no Dubplate.
    expect(sent[0].messages[1].content).toContain("EXAMPLES - other files the owner approved, for context only.")
    expect(sent[0].messages[1].content).not.toContain("Dubplate")
    // It said Dubplate anyway (and a year, label and riddim): all of that is left out.
    expect(ai).toMatchObject({ artists: ["Asco"], title: "Straight Drop", genre: "UK Rap", country: "GB" })
    expect([ai.version, ai.year, ai.label, ai.riddim]).toEqual([undefined, undefined, undefined, undefined])
    expect(ai.unsupported).toEqual(['version "Dubplate"', "year 2019", 'label "Asco Music"', 'riddim "Stalag"'])

    // The decision is "Asco - Straight Drop", and says what was left out and why.
    const d = scoreTrack({
      heuristic: track.heuristic,
      ai,
      tags: {},
      candidates: [],
      duration: 180,
      weights: {},
      thresholds: { autoThreshold: 90, reviewThreshold: 60, parseOnlyMax: 75 },
      context: { filename: track.filename, folders: ["Asco", "UK Rap"], preferOwnRelease: true },
    })
    expect([d.artist, d.title, d.version]).toEqual(["Asco", "Straight Drop", undefined])
    expect(d.checks?.map((n) => n.message)).toEqual(expect.arrayContaining([`The AI's version "Dubplate" left out: nothing in the file's name, folder or tags says so`]))
  })

  it("keeps a Dubplate the file does state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ artists: ["Asco"], featuring: [], title: "Straight Drop", version: "Dubplate", confidence: 0.9, reasoning: "", alternatives: [], searchQueries: [] }) } })))
    )
    const ai = await interpretTrack(trackFor("Asco - Straight Drop (Dub Plate).flac"), DEFAULT_SETTINGS, { corrections: ascoDubplates, aliases: new Map(), provider })
    expect(ai.version).toBe("Dubplate")
    expect(ai.unsupported).toBeUndefined()
  })
})
