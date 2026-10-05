// A source that's rate-limiting us, or just slow, never holds a run up; and YouTube is
// searched the way youtube.com's own search box does it, with no key and no quota.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Settings, Track } from "../../shared/types"
import { openDb, setDb } from "../db"
import { DEFAULT_SETTINGS } from "../settings"
import { scourTrack, sourceLimits } from "../sources"
import { forgetSpotifyToken } from "../sources/catalog"
import { clearResting, hostResting } from "../sources/http"
import { youtube, youtubeCandidate, ytLength, ytVideos } from "../sources/underground"

const track = { id: 1, libraryId: 1, filename: "Tenor Saw - Ring The Alarm.mp3", relDir: "", tags: {}, duration: 200 } as unknown as Track
const reading = { artists: ["Tenor Saw"], featuring: [], title: "Ring The Alarm" }

/** Only these sources on (with Spotify's credentials, when it's one of them). */
function only(...ids: string[]): Settings {
  return structuredClone({
    ...DEFAULT_SETTINGS,
    sources: Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS.sources).map(([id, c]) => [id, { ...c, enabled: ids.includes(id), ...(id === "spotify" ? { apiKey: "client", apiSecret: "secret" } : {}) }])
    ),
    scrapers: [],
  })
}

const urlOf = (input: string | URL | Request) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url)

beforeEach(() => {
  setDb(openDb(":memory:"))
  clearResting()
  forgetSpotifyToken()
})
afterEach(() => {
  vi.unstubAllGlobals()
  sourceLimits.deadlineMs = 60_000
})

describe("a source that says to come back later", () => {
  it("is skipped at once when Spotify asks for an hour, not waited on, and not asked again until then", async () => {
    const asked: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input)
        asked.push(new URL(url).host)
        if (url.includes("accounts.spotify.com")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
        if (url.includes("api.spotify.com")) return new Response("", { status: 429, headers: { "retry-after": "3600" } })
        return new Response(JSON.stringify({ data: [{ title: "Ring The Alarm", duration: 200, artist: { name: "Tenor Saw" }, album: { title: "Fever" } }] }))
      })
    )
    const started = Date.now()
    const first = await scourTrack(track, reading, only("spotify", "deezer"), [])
    expect(Date.now() - started).toBeLessThan(5000)
    // Deezer's answer still came through; Spotify's said why it wasn't there.
    expect(first.candidates.map((c) => c.source)).toEqual(["deezer"])
    expect(first.errors).toEqual([{ source: "Spotify", message: expect.stringContaining("rate-limiting us for 60 min") }])
    expect(hostResting("api.spotify.com")).toBeGreaterThan(3_500_000)

    // The next track: Spotify isn't asked at all while it's resting.
    asked.length = 0
    const next = await scourTrack(track, { ...reading, title: "Pumpkin Belly" }, only("spotify", "deezer"), [])
    expect(asked).not.toContain("api.spotify.com")
    expect(next.errors[0].message).toContain("asked us to wait")
  })

  it("still waits out a short Retry-After, as before", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "1" } }) : new Response(JSON.stringify({ data: [{ title: "Ring The Alarm", duration: 200, artist: { name: "Tenor Saw" }, album: { title: "Fever" } }] }))))
    )
    const r = await scourTrack(track, reading, only("deezer"), [])
    expect([calls, r.candidates.length, r.errors]).toEqual([2, 1, []])
  })

  it("tells a sign-in that failed from a search that did", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 })))
    const r = await scourTrack(track, reading, only("spotify"), [])
    expect(r.errors[0]).toMatchObject({ source: "Spotify", message: expect.stringMatching(/^Spotify sign-in failed: accounts\.spotify\.com replied 400/) })
  })
})

describe("a source that never answers", () => {
  it("is given up on for that track, and the others' answers still count", async () => {
    sourceLimits.deadlineMs = 300
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        urlOf(input).includes("deezer")
          ? new Response(JSON.stringify({ data: [{ title: "Ring The Alarm", duration: 200, artist: { name: "Tenor Saw" }, album: { title: "Fever" } }] }))
          : new Promise<Response>(() => {}) // hangs, and ignores being told to stop
      )
    )
    const started = Date.now()
    const r = await scourTrack(track, reading, only("deezer", "itunes"), [])
    expect(Date.now() - started).toBeLessThan(3000)
    expect(r.candidates.map((c) => c.source)).toEqual(["deezer"])
    expect(r.errors).toEqual([{ source: "Apple Music", message: "no answer within 0.3 s - skipped for this track" }])
  })
})

// The shape youtube.com's search answers in (trimmed): videos nested in sections, alongside shelves and ads.
const INNERTUBE_ANSWER = {
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            {
              itemSectionRenderer: {
                contents: [
                  { adSlotRenderer: {} },
                  {
                    videoRenderer: {
                      videoId: "abc123",
                      title: { runs: [{ text: "Ring The Alarm" }] },
                      ownerText: { runs: [{ text: "Tenor Saw - Topic" }] },
                      lengthText: { simpleText: "3:21" },
                    },
                  },
                  {
                    videoRenderer: {
                      videoId: "def456",
                      title: { runs: [{ text: "Stalag Riddim - Tenor Saw - Ring The Alarm (Official Audio)" }] },
                      ownerText: { runs: [{ text: "Techniques Records" }] },
                      lengthText: { simpleText: "1:02:03" },
                    },
                  },
                  { shelfRenderer: { content: { verticalListRenderer: { items: [{ videoRenderer: { videoId: "ghi789", title: { simpleText: "Tenor Saw - Pumpkin Belly" }, longBylineText: { runs: [{ text: "Uploader" }] } } }] } } } },
                  { videoRenderer: { videoId: "nope", title: { runs: [] } } },
                ],
              },
            },
          ],
        },
      },
    },
  },
}

describe("YouTube, with no key and no quota", () => {
  it("needs nothing set up", () => {
    expect(youtube.unavailable({ cfg: { enabled: true, weight: 0.4 }, settings: DEFAULT_SETTINGS })).toBeNull()
  })

  it("asks youtube.com's own search, for videos, and reads what comes back", async () => {
    const sent: { url: string; body: { query: string; params: string; context: { client: { clientName: string } } }; headers: Record<string, string> }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: urlOf(input), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> })
        return new Response(JSON.stringify(INNERTUBE_ANSWER))
      })
    )
    const r = await scourTrack(track, reading, only("youtube"), [])
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe("https://www.youtube.com/youtubei/v1/search?prettyPrint=false")
    expect(sent[0].url).not.toMatch(/key=/)
    expect(sent[0].body).toMatchObject({ query: "Tenor Saw Ring The Alarm", params: "EgIQAQ==", context: { client: { clientName: "WEB" } } })
    expect(r.errors).toEqual([])
    expect(r.candidates.map((c) => [c.artist, c.title, c.riddim, c.duration, c.url, c.sourceScore])).toEqual([
      ["Tenor Saw", "Ring The Alarm", undefined, 201, "https://www.youtube.com/watch?v=abc123", 0.9],
      ["Tenor Saw", "Ring The Alarm", "Stalag", 3723, "https://www.youtube.com/watch?v=def456", undefined],
      ["Tenor Saw", "Pumpkin Belly", undefined, undefined, "https://www.youtube.com/watch?v=ghi789", undefined],
    ])
  })

  it("reads lengths and skips what isn't a video", () => {
    expect([ytLength("3:21"), ytLength("1:02:03"), ytLength("LIVE"), ytLength("")]).toEqual([201, 3723, undefined, undefined])
    expect(ytVideos(INNERTUBE_ANSWER).map((v) => v.videoId)).toEqual(["abc123", "def456", "ghi789", "nope"])
    expect(youtubeCandidate({ videoId: "nope", title: { runs: [] } })).toBeNull()
    expect(ytVideos({ error: { code: 400 } })).toEqual([])
  })
})
