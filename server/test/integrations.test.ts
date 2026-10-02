import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Candidate, Decision, Job, MediaServerConfig, Settings } from "../../shared/types"
import { isBackup, makeBackup, restoreBackup } from "../backup"
import { idsFor } from "../core/ids"
import { tagsFor } from "../core/naming"
import { getDb, openDb, setDb } from "../db"
import { messageForJob, sendChat } from "../integrations/chat"
import { refreshMediaServer, subsonicUrl, testMediaServer } from "../integrations/media-servers"
import { weightsFrom } from "../pipeline"
import * as repo from "../repo"
import { readAudio } from "../scanner"
import { DEFAULT_SETTINGS, loadSettings, publicSettings, saveSettings } from "../settings"
import { readManagedTags, writeTags } from "../tagger"
import { writeMp3 } from "./fixtures"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-int-"))
  setDb(openDb(":memory:"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function mockFetch(reply: (url: string, init?: RequestInit) => Response) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => reply(String(url), init))
  vi.stubGlobal("fetch", fn)
  return fn
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("catalogue IDs", () => {
  const cand = (over: Partial<Candidate>): Candidate => ({ source: "musicbrainz", sourceLabel: "MusicBrainz", artist: "Skepta", title: "Shutdown", ...over })
  const decision = (candidates: Candidate[]) => ({ clusters: [{ artist: "Skepta", title: "Shutdown", sources: [], support: 1, relevance: 1, candidates }] }) as unknown as Decision
  const meta = { artists: ["Skepta"], featuring: [], title: "Shutdown" }

  it("come from the sources that agreed on the approved song", () => {
    const d = decision([
      cand({ ids: { mbRecordingId: "rec-text", mbReleaseId: "rel-1", mbArtistIds: ["art-1"] }, sourceScore: 0.9 }),
      cand({ source: "acoustid", fingerprint: true, ids: { mbRecordingId: "rec-fp" } }),
      cand({ source: "acoustid", fingerprint: false, ids: { mbRecordingId: "rec-fp", mbReleaseId: "rel-fp" } }),
      cand({ source: "discogs", ids: { discogsReleaseId: "123" } }),
    ])
    // The fingerprint's recording wins; its release comes from another hit on the same recording.
    expect(idsFor(d, meta)).toEqual({ mbRecordingId: "rec-fp", mbReleaseId: "rel-fp", discogsReleaseId: "123" })
    // An approved reading of a different song gets none.
    expect(idsFor(d, { ...meta, title: "Man" })).toEqual({})
    expect(tagsFor(meta, { mbRecordingId: "rec-fp" }, DEFAULT_SETTINGS.naming, { ids: idsFor(d, meta) })).toMatchObject({ mbReleaseId: "rel-fp", discogsReleaseId: "123" })
    expect(tagsFor(meta, { mbRecordingId: "rec-fp" }, DEFAULT_SETTINGS.naming, { ids: idsFor(d, meta) }).mbRecordingId).toBeUndefined()
  })

  it("are written in the standard fields and read back", async () => {
    const file = path.join(dir, "t.mp3")
    writeMp3(file)
    writeTags(file, { artist: "Skepta", title: "Shutdown", mbRecordingId: "c3e4a0b2-1111-2222-3333-444455556666", mbReleaseId: "d1e2f3a4-1111-2222-3333-444455556666", mbArtistId: "a1b2c3d4-1111-2222-3333-444455556666", discogsReleaseId: "8141390" })
    expect(readManagedTags(file)).toMatchObject({ mbRecordingId: "c3e4a0b2-1111-2222-3333-444455556666", mbReleaseId: "d1e2f3a4-1111-2222-3333-444455556666", discogsReleaseId: "8141390" })
    // Other taggers' reading of the same fields.
    const read = await readAudio(file)
    expect(read.tags).toMatchObject({ mbRecordingId: "c3e4a0b2-1111-2222-3333-444455556666", mbReleaseId: "d1e2f3a4-1111-2222-3333-444455556666", discogsReleaseId: "8141390" })
    writeTags(file, { discogsReleaseId: null, mbRecordingId: null })
    expect(readManagedTags(file).discogsReleaseId).toBeUndefined()
    expect(readManagedTags(file).mbRecordingId).toBeUndefined()
  })
})

describe("backup and restore", () => {
  it("round-trips settings, learnings and libraries, keys only when asked", () => {
    saveSettings({ ...loadSettings(), contact: "me@example.com", llm: { ...loadSettings().llm, genres: ["Dub"], providers: loadSettings().llm.providers.map((p) => (p.id === "openai" ? { ...p, apiKey: "sk-secret" } : p)) } })
    saveSettings({ integrations: { ...loadSettings().integrations, discord: { enabled: true, webhookUrl: "https://discord.com/api/webhooks/1/abc" } } })
    repo.upsertAlias("kartel", "Vybz Kartel")
    repo.addCorrection("skepta_shutdown.mp3", ["Skepta"], "Shutdown")
    repo.addLibrary(dir, "Crates", { watch: true, settings: { genres: ["Grime"] } })

    const plain = makeBackup({ secrets: false })
    expect(isBackup(plain)).toBe(true)
    expect(JSON.stringify(plain)).not.toContain("sk-secret")
    expect(JSON.stringify(plain)).not.toContain("webhooks/1/abc")
    expect(makeBackup({ secrets: true }).settings.llm.providers.find((p) => p.id === "openai")?.apiKey).toBe("sk-secret")

    // Into a fresh install.
    setDb(openDb(":memory:"))
    const r = restoreBackup(JSON.parse(JSON.stringify(plain)), { settings: true, learnings: true, libraries: true })
    expect(r).toMatchObject({ settings: true, aliases: expect.any(Number), corrections: 1, libraries: { added: 1, updated: 0 } })
    expect(loadSettings()).toMatchObject({ contact: "me@example.com", llm: { genres: ["Dub"] } })
    expect(repo.aliasMap().get("kartel")).toBe("Vybz Kartel")
    expect(repo.listCorrections()[0]).toMatchObject({ filename: "skepta_shutdown.mp3", title: "Shutdown" })
    expect(repo.listLibraries()[0]).toMatchObject({ name: "Crates", watch: true, settings: { genres: ["Grime"] } })

    // Restoring again adds nothing twice, and keeps keys the backup didn't carry.
    saveSettings({ llm: { ...loadSettings().llm, providers: loadSettings().llm.providers.map((p) => (p.id === "openai" ? { ...p, apiKey: "sk-here" } : p)) } })
    const again = restoreBackup(plain, { settings: true, learnings: true, libraries: true })
    expect(again).toMatchObject({ corrections: 0, libraries: { added: 0, updated: 1 } })
    expect(loadSettings().llm.providers.find((p) => p.id === "openai")?.apiKey).toBe("sk-here")
    expect(isBackup({ app: "other" })).toBe(false)
  })
})

describe("chat notifications", () => {
  const job = (over: Partial<Job>): Job => ({
    id: "j",
    kind: "process",
    status: "done",
    label: "Identify 20 tracks",
    total: 20,
    done: 20,
    failed: 0,
    message: null,
    createdAt: "",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:05Z",
    ...over,
  })
  const withChat = (): Settings => {
    const s = structuredClone(DEFAULT_SETTINGS)
    s.integrations.discord = { enabled: true, webhookUrl: "https://discord.test/hook" }
    s.integrations.telegram = { enabled: true, botToken: "123:abc", chatId: "42" }
    s.integrations.publicUrl = "http://nas:4455"
    return s
  }

  it("says something only when it's worth it", () => {
    const s = withChat()
    const none = { filesChanged: false, report: null }
    expect(messageForJob(job({}), none, DEFAULT_SETTINGS)).toBeNull() // no channels
    expect(messageForJob(job({}), none, s)).toBeNull() // short and nothing to review
    expect(messageForJob(job({}), { filesChanged: false, report: { matched: 12, review: 5, unmatched: 3 } }, s)).toMatchObject({
      title: "5 tracks to review",
      lines: ["12 matched · 5 to review · 3 unmatched", "5 tracks need a listen in Review."],
      link: { path: "/review" },
    })
    expect(messageForJob(job({ kind: "execute", label: "Rename & tag 8 files" }), { filesChanged: true, report: null }, s)).toMatchObject({ title: "Done: Rename & tag 8 files", tone: "ok" })
    expect(messageForJob(job({ status: "failed", message: "Ollama is down" }), none, s)).toMatchObject({ title: "Failed: Identify 20 tracks", lines: ["Ollama is down"], tone: "error" })
    expect(messageForJob(job({ status: "cancelled" }), { filesChanged: true, report: null }, s)).toBeNull()
    s.integrations.notify.review = false
    expect(messageForJob(job({}), { filesChanged: false, report: { review: 5 } }, s)).toBeNull()
  })

  it("posts to Discord and Telegram", async () => {
    const fn = mockFetch((url) => (url.includes("telegram") ? json({ ok: true }) : new Response(null, { status: 204 })))
    const r = await sendChat(withChat(), { title: "Done <now>", lines: ["8 done"], link: { label: "Open", path: "/execute" }, tone: "ok" })
    expect(r.every((x) => x.ok)).toBe(true)
    const [discord, telegram] = fn.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) }))
    expect(discord.url).toBe("https://discord.test/hook")
    expect(discord.body.embeds[0]).toMatchObject({ title: "Done <now>", description: "8 done", url: "http://nas:4455/execute" })
    expect(telegram.url).toBe("https://api.telegram.org/bot123:abc/sendMessage")
    expect(telegram.body).toMatchObject({ chat_id: "42", parse_mode: "HTML", text: '<b>Done &lt;now&gt;</b>\n8 done\n<a href="http://nas:4455/execute">Open</a>' })

    mockFetch(() => json({ ok: false, description: "Bad Request: chat not found" }, 400))
    expect((await sendChat(withChat(), { title: "x", lines: [], tone: "ok" }, "telegram"))[0]).toMatchObject({ ok: false, message: "Telegram: Bad Request: chat not found" })
  })
})

describe("media servers", () => {
  const server = (over: Partial<MediaServerConfig>): MediaServerConfig => ({ id: "m", kind: "plex", name: "Plex", url: "http://plex:32400", token: "tok", enabled: true, ...over })

  it("asks Plex to rescan its music libraries", async () => {
    const fn = mockFetch((url) =>
      url.endsWith("/library/sections")
        ? json({ MediaContainer: { Directory: [{ key: "3", type: "artist" }, { key: "1", type: "movie" }] } })
        : new Response(null, { status: 200 })
    )
    expect(await refreshMediaServer(server({}))).toEqual({ ok: true, message: "Rescanning 1 music library" })
    expect(fn.mock.calls.map(([u]) => String(u))).toEqual(["http://plex:32400/library/sections", "http://plex:32400/library/sections/3/refresh"])
    expect(fn.mock.calls[0][1]?.headers).toMatchObject({ "X-Plex-Token": "tok" })
    mockFetch(() => new Response(null, { status: 401 }))
    expect(await testMediaServer(server({}))).toEqual({ ok: false, message: "Plex didn't accept the token" })
  })

  it("asks Jellyfin to refresh, and pings Navidrome with a salted token", async () => {
    const fn = mockFetch((url) => (url.includes("System/Info") ? json({ ServerName: "Den", Version: "10.9.0" }) : new Response(null, { status: 204 })))
    expect(await testMediaServer(server({ kind: "jellyfin", url: "http://jf:8096" }))).toEqual({ ok: true, message: "Connected to Den (10.9.0)" })
    expect(await refreshMediaServer(server({ kind: "jellyfin", url: "http://jf:8096" }))).toEqual({ ok: true, message: "Library scan started" })
    expect(fn.mock.calls[1][0]).toBe("http://jf:8096/Library/Refresh")
    expect(fn.mock.calls[1][1]?.method).toBe("POST")

    const nd = server({ kind: "navidrome", url: "http://nd:4533", user: "dj", token: "pass" })
    const u = new URL(subsonicUrl(nd, "ping.view", "salt"))
    expect(u.searchParams.get("t")).toBe(createHash("md5").update("passsalt").digest("hex"))
    expect(u.searchParams.get("u")).toBe("dj")
    mockFetch(() => json({ "subsonic-response": { status: "ok", serverVersion: "0.53.3" } }))
    expect(await testMediaServer(nd)).toEqual({ ok: true, message: "Connected to Navidrome 0.53.3" })
    mockFetch(() => json({ "subsonic-response": { status: "failed", error: { message: "Wrong username or password" } } }))
    expect(await refreshMediaServer(nd)).toEqual({ ok: false, message: "Wrong username or password" })
  })
})

describe("sources and settings", () => {
  it("trusts sources that suit the picked genres a little more", () => {
    const s = structuredClone(DEFAULT_SETTINGS)
    expect(weightsFrom(s).bandcamp).toBe(0.75)
    s.llm.genres = ["Jungle"]
    expect(weightsFrom(s).bandcamp).toBeCloseTo(0.9)
    expect(weightsFrom(s).musicbrainz).toBe(1)
    expect(weightsFrom(s)["scraper:juno"]).toBeCloseTo(0.84)
    s.confidence.genreAware = false
    expect(weightsFrom(s).bandcamp).toBe(0.75)
  })

  it("offers presets added since an install last saved its scrapers, once", () => {
    const stored = { scrapers: [{ ...DEFAULT_SETTINGS.scrapers[0], genres: undefined }] }
    getDb().prepare("INSERT INTO settings (key, value_json) VALUES ('app', ?)").run(JSON.stringify(stored))
    const ids = loadSettings().scrapers.map((s) => s.id)
    // The old presets the owner deleted stay deleted; the new ones arrive switched off (not the ones since retired).
    expect(ids).toEqual(["juno", "traxsource", "genius", "audius", "hypem", "grime-archive", "britishhiphop"])
    expect(loadSettings().scrapers[0].genres).toContain("Grime")
    expect(loadSettings().scrapers.every((s) => !s.enabled)).toBe(true)
    // Once saved, deleting a new preset sticks.
    saveSettings({ scrapers: loadSettings().scrapers.filter((s) => s.id !== "genius") })
    expect(loadSettings().scrapers.map((s) => s.id)).not.toContain("genius")
  })

  it("never shows integration secrets, and keeps them when the masked value comes back", () => {
    saveSettings({ integrations: { ...DEFAULT_SETTINGS.integrations, mediaServers: [{ id: "p", kind: "plex", name: "", url: "http://plex:32400/", token: "plex-token", enabled: true }], telegram: { enabled: true, botToken: "123:secret", chatId: "42" } } })
    const pub = publicSettings()
    expect(JSON.stringify(pub)).not.toContain("plex-token")
    expect(JSON.stringify(pub)).not.toContain("123:secret")
    saveSettings({ integrations: pub.integrations })
    const saved = loadSettings().integrations
    expect(saved.mediaServers[0]).toMatchObject({ token: "plex-token", name: "Plex", url: "http://plex:32400" })
    expect(saved.telegram.botToken).toBe("123:secret")
  })
})
