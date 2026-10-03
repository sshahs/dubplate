// The console's log: kept in SQLite, linked to jobs and tracks, filtered, paged and trimmed.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createApp } from "../app"
import { inScope } from "../bus"
import { getDb, openDb, setDb } from "../db"
import { activeJobs, enqueueJob, forTrack, resetJobStateForTests } from "../jobs"
import { clearLogs, configureLogs, formatLine, log, logSummary, logText, pruneLogs, queryLogs } from "../logs"
import { redactUrl } from "../sources/http"

async function jobsSettled() {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 10))
    if (!activeJobs().length) return
  }
  throw new Error("jobs still running")
}

beforeEach(() => {
  setDb(openDb(":memory:"))
  resetJobStateForTests()
  configureLogs({ detail: true, keepDays: 14 })
})

afterEach(() => configureLogs({ detail: true, keepDays: 14 }))

describe("the log", () => {
  it("keeps every line, oldest first, with its level, area and detail", () => {
    log("info", "Dubplate started", { area: "server" })
    log("warn", "Bandcamp: too busy", { area: "sources", detail: "replied 429" })
    log("debug", "GET bandcamp.com/search - 200 in 80 ms", { area: "http" })
    const { entries, more } = queryLogs({})
    expect(more).toBe(false)
    expect(entries.map((e) => [e.level, e.area, e.message])).toEqual([
      ["info", "server", "Dubplate started"],
      ["warn", "sources", "Bandcamp: too busy"],
      ["debug", "http", "GET bandcamp.com/search - 200 in 80 ms"],
    ])
    expect(entries[1].detail).toBe("replied 429")
    expect(entries[0].id).toBeLessThan(entries[1].id)
  })

  it("leaves out the step-by-step detail when that's switched off", () => {
    configureLogs({ detail: false, keepDays: 14 })
    expect(log("debug", "GET musicbrainz.org/ws/2/recording", { area: "http" })).toBeNull()
    log("error", "MusicBrainz keeps failing", { area: "sources" })
    expect(queryLogs({}).entries.map((e) => e.message)).toEqual(["MusicBrainz keeps failing"])
  })

  it("knows the job and the track a line was written in, however deep", async () => {
    enqueueJob("process", "Identify 2 tracks", async (ctx) => {
      ctx.log("info", "Reading")
      await forTrack(7, async () => {
        await Promise.resolve()
        // e.g. a web request deep inside a source
        log("debug", "GET riddim-id.com/search", { area: "http" })
        ctx.log("warn", "Riddim-ID: too busy")
      })
      // a line about the run, not one track
      await forTrack(8, async () => ctx.log("info", "Summary", { trackId: null }))
    })
    await jobsSettled()
    const lines = queryLogs({}).entries
    const job = lines[0].jobId
    expect(lines.map((e) => [e.area, e.message, e.trackId])).toEqual([
      ["jobs", "Started: Identify 2 tracks", undefined],
      ["identify", "Reading", undefined],
      ["http", "GET riddim-id.com/search", 7],
      ["identify", "Riddim-ID: too busy", 7],
      ["identify", "Summary", undefined],
      ["jobs", expect.stringMatching(/^Finished: Identify 2 tracks in 0 s$/), undefined],
    ])
    expect(lines.every((e) => e.jobId === job && e.jobLabel === "Identify 2 tracks")).toBe(true)
    expect(lines.at(-1)!.level).toBe("success")
  })

  it("says when a job fails, with the stack trace", async () => {
    enqueueJob("scan", "Scan Crates", async () => {
      throw new Error("The folder went away")
    })
    await jobsSettled()
    const failed = queryLogs({ levels: ["error"] }).entries
    expect(failed).toHaveLength(1)
    expect(failed[0].message).toBe("Scan Crates failed: The folder went away")
    expect(failed[0].detail).toContain("Error: The folder went away")
    expect(failed[0].area).toBe("jobs")
  })

  it("filters by level, area, job, track and words (taking % and _ literally)", () => {
    inScope({ job: { id: "j1", kind: "scan", label: "Scan" } }, () => log("info", "found 100% of files"))
    inScope({ job: { id: "j2", kind: "process", label: "Identify" }, trackId: 3 }, () => {
      log("warn", "Bandcamp: 503", { area: "sources", detail: "the riddim_id field was empty" })
      log("debug", "GET bandcamp.com")
    })
    const msgs = (f: Parameters<typeof queryLogs>[0]) => queryLogs(f).entries.map((e) => e.message)
    expect(msgs({ levels: ["warn", "debug"] })).toEqual(["Bandcamp: 503", "GET bandcamp.com"])
    expect(msgs({ areas: ["scan"] })).toEqual(["found 100% of files"])
    expect(msgs({ jobId: "j2" })).toEqual(["Bandcamp: 503", "GET bandcamp.com"])
    expect(msgs({ trackId: 3, levels: ["debug"] })).toEqual(["GET bandcamp.com"])
    expect(msgs({ q: "100%" })).toEqual(["found 100% of files"])
    expect(msgs({ q: "0% o" })).toEqual(["found 100% of files"])
    // in the detail, and "_" isn't a wildcard
    expect(msgs({ q: "riddim_id" })).toEqual(["Bandcamp: 503"])
    expect(msgs({ q: "riddimXid" })).toEqual([])
    expect(msgs({ q: "BANDCAMP" })).toEqual(["Bandcamp: 503", "GET bandcamp.com"])
  })

  it("pages back through older lines and forward through newer ones", () => {
    for (let i = 1; i <= 12; i++) log("info", `line ${i}`)
    const newest = queryLogs({ limit: 5 })
    expect(newest.entries.map((e) => e.message)).toEqual(["line 8", "line 9", "line 10", "line 11", "line 12"])
    expect(newest.more).toBe(true)
    const older = queryLogs({ limit: 5, before: newest.entries[0].id })
    expect(older.entries.map((e) => e.message)).toEqual(["line 3", "line 4", "line 5", "line 6", "line 7"])
    const oldest = queryLogs({ limit: 5, before: older.entries[0].id })
    expect(oldest.entries.map((e) => e.message)).toEqual(["line 1", "line 2"])
    expect(oldest.more).toBe(false)
    const after = queryLogs({ limit: 3, after: older.entries.at(-1)!.id })
    expect(after.entries.map((e) => e.message)).toEqual(["line 8", "line 9", "line 10"])
    expect(after.more).toBe(true)
  })

  it("counts lines per level within the areas picked, and per area within the levels picked", () => {
    log("info", "a", { area: "scan" })
    log("warn", "b", { area: "sources" })
    log("warn", "c", { area: "scan" })
    log("debug", "d", { area: "http" })
    enqueueJob("scan", "Scan", async () => {})
    const s = logSummary({ areas: ["scan"], levels: ["warn"] })
    expect(s.byLevel).toEqual({ debug: 0, info: 1, success: 0, warn: 1, error: 0 })
    expect(s.byArea).toEqual({ scan: 1, sources: 1 })
    // everything kept, the job's own "Started" line included
    expect(s.total).toBe(5)
    expect(s.jobs.map((j) => j.label)).toEqual(["Scan"])
  })

  it("trims lines older than the keep period", () => {
    log("info", "today")
    getDb().prepare("INSERT INTO logs (at, level, area, message) VALUES (?, 'info', 'server', 'last month')").run(new Date(Date.now() - 31 * 864e5).toISOString())
    getDb().prepare("INSERT INTO logs (at, level, area, message) VALUES (?, 'info', 'server', 'last week')").run(new Date(Date.now() - 6 * 864e5).toISOString())
    expect(pruneLogs()).toBe(1)
    configureLogs({ detail: true, keepDays: 3 })
    expect(pruneLogs()).toBe(1)
    expect(queryLogs({}).entries.map((e) => e.message)).toEqual(["today"])
    expect(clearLogs()).toBe(1)
    expect(queryLogs({}).entries).toEqual([])
  })

  it("writes a readable text log, detail indented under its line", () => {
    getDb().prepare("INSERT INTO jobs (id, kind, status, label, created_at) VALUES ('j', 'execute', 'done', 'Cut 3 files', datetime('now'))").run()
    inScope({ job: { id: "j", kind: "execute", label: "Cut 3 files" }, trackId: 12 }, () => log("error", "Couldn't rename it", { detail: "Error: EACCES\n    at rename" }))
    const text = [...logText({})].join("")
    expect(text).toMatch(/^\S+Z ERROR {2}files {8}Couldn't rename it {2}\[Cut 3 files\] {2}\(track 12\)\n {4}Error: EACCES\n {8}at rename\n$/)
    expect(formatLine({ id: 1, at: "2026-01-01T00:00:00.000Z", level: "success", area: "jobs", message: "Finished: Scan", jobLabel: "Scan" })).toBe("2026-01-01T00:00:00.000Z DONE   jobs         Finished: Scan")
  })

  it("never writes keys or tokens from a URL into the log", () => {
    expect(redactUrl("https://www.googleapis.com/youtube/v3/search?q=ring%20the%20alarm&key=AIzaSECRET")).toBe("https://www.googleapis.com/youtube/v3/search?q=ring+the+alarm&key=%E2%80%A2%E2%80%A2%E2%80%A2")
    expect(redactUrl("https://api.discogs.com/database/search?q=x&token=abc&api_key=def")).not.toMatch(/abc|def/)
    expect(redactUrl("https://user:pass@example.com/a")).not.toMatch(/user|pass/)
    expect(redactUrl("https://api.telegram.org/bot123456:AAH-secret_x/sendMessage")).toBe("https://api.telegram.org/bot•••/sendMessage")
    expect(redactUrl("https://discord.com/api/webhooks/1234/abc-DEF_1")).toBe("https://discord.com/api/webhooks/1234/•••")
  })

  it("answers the console's requests", async () => {
    log("info", "first", { area: "scan" })
    log("error", "second", { area: "server", detail: "stack" })
    const app = createApp()
    const H = { "x-dubplate": "1" }
    const page = (await (await app.request("http://localhost/api/logs?levels=error,bogus&limit=10")).json()) as { entries: { message: string }[]; more: boolean }
    expect(page.entries.map((e) => e.message)).toEqual(["second"])
    const summary = (await (await app.request("http://localhost/api/logs/summary?areas=scan")).json()) as { byLevel: Record<string, number>; detail: boolean; keepDays: number }
    expect(summary.byLevel.info).toBe(1)
    expect(summary.byLevel.error).toBe(0)
    expect([summary.detail, summary.keepDays]).toEqual([true, 14])
    const download = await app.request("http://localhost/api/logs/download?q=second")
    expect(download.headers.get("content-disposition")).toMatch(/attachment; filename="dubplate-log-\d{4}-\d{2}-\d{2}\.txt"/)
    expect(await download.text()).toMatch(/ERROR {2}server {7}second\n {4}stack\n$/)
    expect(await (await app.request("http://localhost/api/logs/download?q=nothing-like-this")).text()).toBe("No lines match these filters.\n")
    const cleared = (await (await app.request("http://localhost/api/logs", { method: "DELETE", headers: H })).json()) as { cleared: number }
    expect(cleared.cleared).toBe(2)
    expect(queryLogs({}).entries).toEqual([])
  })

  it("logs a request that breaks with its method, path and stack", async () => {
    const app = createApp()
    app.get("/api/test-breaks", () => {
      throw new Error("kaboom")
    })
    const res = await app.request("http://localhost/api/test-breaks")
    expect(res.status).toBe(500)
    const [line] = queryLogs({ levels: ["error"] }).entries
    expect(line.message).toBe("GET /api/test-breaks: kaboom")
    expect(line.area).toBe("server")
    expect(line.detail).toContain("Error: kaboom")
  })
})
