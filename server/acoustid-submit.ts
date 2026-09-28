// Giving back to AcoustID: fingerprints of tracks that are verified and
// corrected, linked to their MusicBrainz recording. "Verified" is a checklist,
// not a score - the engine's scores aren't probabilities - and it's stricter
// than any confidence number: a person approved it or independent sources
// agree, nothing's in conflict, and the file's been cut. Every submission is
// recorded (pending, then imported), and the same fingerprint is never sent
// twice.

import { createHash } from "node:crypto"
import { independentSources } from "../shared/risk"
import type { AcoustIdEligibility, AcoustIdSubmission, Settings, Track } from "../shared/types"
import { idsFor } from "./core/ids"
import { artistSimilarity, titleSimilarity } from "./core/normalize"
import { getDb } from "./db"
import type { JobContext } from "./jobs"
import { metaFor } from "./placement"
import { getTracks } from "./repo"
import { httpJson } from "./sources/http"

const API = "https://api.acoustid.org/v2"
/** AcoustID takes several fingerprints per request; its limit is 3 requests a second (http.ts spaces them). */
const BATCH = 10

type Row = {
  id: number
  track_id: number | null
  fingerprint_hash: string
  submission_id: number | null
  status: string
  acoustid: string | null
  mb_recording_id: string | null
  error: string | null
  submitted_at: string
  checked_at: string | null
}

function toSubmission(r: Row): AcoustIdSubmission {
  return {
    id: r.id,
    trackId: r.track_id,
    status: r.status === "imported" ? "imported" : r.status === "failed" ? "failed" : "pending",
    submissionId: r.submission_id,
    acoustId: r.acoustid,
    mbRecordingId: r.mb_recording_id,
    error: r.error,
    submittedAt: r.submitted_at,
    checkedAt: r.checked_at,
  }
}

export const fingerprintHash = (fp: string) => createHash("sha256").update(fp).digest("hex")

export function submissionFor(t: Pick<Track, "id" | "fingerprint">): AcoustIdSubmission | null {
  const db = getDb()
  const r = (t.fingerprint ? db.prepare("SELECT * FROM acoustid_submissions WHERE fingerprint_hash = ?").get(fingerprintHash(t.fingerprint.fingerprint)) : undefined) as Row | undefined
  const byTrack = r ?? (db.prepare("SELECT * FROM acoustid_submissions WHERE track_id = ? ORDER BY id DESC LIMIT 1").get(t.id) as Row | undefined)
  return byTrack ? toSubmission(byTrack) : null
}

export function listSubmissions(limit = 50): { items: AcoustIdSubmission[]; counts: Record<AcoustIdSubmission["status"], number> } {
  const db = getDb()
  const items = (db.prepare("SELECT * FROM acoustid_submissions ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(toSubmission)
  const counts = { pending: 0, imported: 0, failed: 0 }
  for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM acoustid_submissions GROUP BY status").all() as { status: string; n: number }[]) {
    if (r.status in counts) counts[r.status as keyof typeof counts] = r.n
  }
  return { items, counts }
}

/** Whether MusicBrainz knows this song at all (some source hit on it carries a recording ID). */
function musicBrainzKnows(t: Track): boolean {
  const meta = metaFor(t)
  if (!meta) return false
  return (t.decision?.clusters ?? []).some(
    (cl) => titleSimilarity(cl.title, meta.title) >= 0.85 && artistSimilarity(cl.artist, meta.artists) >= 0.7 && cl.candidates.some((c) => c.ids?.mbRecordingId)
  )
}

/** The checklist: every box has to be ticked before a fingerprint is sent. */
export function eligibility(t: Track, settings: Settings): AcoustIdEligibility {
  const d = t.decision
  const meta = metaFor(t)
  const person = t.approvedBy === "person" && (t.status === "approved" || t.status === "done")
  const independent = independentSources(d?.clusters[0]?.sources ?? [])
  const ids = { ...idsFor(d, meta), ...(t.idsOverride ?? {}) }
  const submission = submissionFor(t)
  const checks: AcoustIdEligibility["checks"] = [
    {
      key: "keys",
      label: "AcoustID application and user keys",
      ok: !!settings.sources.acoustid?.apiKey && !!settings.acoustid.userKey,
      detail: settings.acoustid.userKey ? undefined : "Add your user key under Sources → AcoustID",
    },
    { key: "fingerprint", label: "Fingerprint made", ok: !!t.fingerprint, detail: t.fingerprint ? undefined : "Identify it with AcoustID switched on" },
    {
      key: "verified",
      label: "Artist, title and version verified",
      ok: !!meta?.title && !!meta.artists.length && (person || (d?.versionCheck?.durationMatch !== false && d?.versionCheck?.fingerprintMatch !== false)),
      detail: !meta?.title ? "Not identified yet" : d?.versionCheck?.durationMatch === false ? "Its length doesn't match the recording - a person needs to approve it" : undefined,
    },
    {
      key: "confirmed",
      label: "Approved by a person, or confirmed by independent sources",
      ok: person || (d?.basis === "sources" && independent >= 2 && !d.escalated),
      detail: person ? "Approved by you" : d?.escalated ? "A second model read it, so a person has to approve it" : `${independent} independent source${independent === 1 ? "" : "s"} agree`,
    },
    {
      key: "conflict",
      label: "No unresolved source conflict",
      ok: person || (d?.status !== "conflict" && d?.versionCheck?.fingerprintMatch !== false),
      detail: !person && (d?.status === "conflict" || d?.versionCheck?.fingerprintMatch === false) ? "The sources disagree - approve it to settle that" : undefined,
    },
    {
      key: "mbid",
      label: "MusicBrainz recording ID (where MusicBrainz has it)",
      ok: !!ids.mbRecordingId || !musicBrainzKnows(t),
      detail: ids.mbRecordingId ? ids.mbRecordingId : musicBrainzKnows(t) ? "MusicBrainz knows the song, but no recording was matched" : "MusicBrainz doesn't list it; sent with artist and title",
    },
    { key: "cut", label: "Cut: its tags are corrected", ok: t.status === "done", detail: t.status === "done" ? undefined : "Cut it first" },
    {
      key: "new",
      label: "Not sent before",
      ok: !submission || submission.status === "failed",
      detail: submission && submission.status !== "failed" ? `Sent ${submission.submittedAt.slice(0, 10)} (${submission.status})` : undefined,
    },
  ]
  return { eligible: checks.every((c) => c.ok), checks, submission }
}

interface SubmitReply {
  status: string
  error?: { message?: string }
  submissions?: { index?: string; id: number; status: string; result?: { id?: string } }[]
}

/** Send the eligible ones among these tracks (a job). Returns how many were accepted. */
export async function submitTracks(ids: number[], settings: Settings, ctx: Pick<JobContext, "log" | "signal"> & Partial<Pick<JobContext, "setTotal" | "tick">>): Promise<number> {
  const client = settings.sources.acoustid?.apiKey
  const user = settings.acoustid.userKey
  if (!client || !user) throw new Error("AcoustID needs its application key and your user key (Sources → AcoustID)")
  const ready = getTracks(ids).filter((t) => eligibility(t, settings).eligible)
  ctx.setTotal?.(ready.length)
  let accepted = 0
  for (let i = 0; i < ready.length; i += BATCH) {
    if (ctx.signal.aborted) break
    const batch = ready.slice(i, i + BATCH)
    const form = new URLSearchParams({ client, clientversion: "dubplate", user, format: "json" })
    batch.forEach((t, n) => {
      const meta = metaFor(t)!
      const trackIds = { ...idsFor(t.decision, meta), ...(t.idsOverride ?? {}) }
      form.set(`duration.${n}`, String(Math.round(t.fingerprint!.duration)))
      form.set(`fingerprint.${n}`, t.fingerprint!.fingerprint)
      if (trackIds.mbRecordingId) form.set(`mbid.${n}`, trackIds.mbRecordingId)
      form.set(`track.${n}`, meta.version ? `${meta.title} (${meta.version})` : meta.title)
      form.set(`artist.${n}`, meta.artists.join(", "))
      if (meta.album ?? t.decision?.album) form.set(`album.${n}`, (meta.album ?? t.decision?.album)!)
      if (meta.year) form.set(`year.${n}`, String(meta.year))
      form.set(`fileformat.${n}`, t.ext.toUpperCase())
      if (t.bitrate) form.set(`bitrate.${n}`, String(Math.round(t.bitrate / 1000)))
    })
    let reply: SubmitReply | null
    try {
      reply = await httpJson<SubmitReply>(`${API}/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        ttlMs: 0,
        signal: ctx.signal,
      })
    } catch (err) {
      ctx.log("error", `AcoustID didn't take the fingerprints: ${err instanceof Error ? err.message : err}`)
      batch.forEach(() => ctx.tick?.(false))
      continue
    }
    if (reply?.status !== "ok") {
      ctx.log("error", `AcoustID refused the fingerprints: ${reply?.error?.message ?? "no reason given"}`)
      batch.forEach(() => ctx.tick?.(false))
      continue
    }
    const insert = getDb().prepare(
      `INSERT INTO acoustid_submissions (track_id, fingerprint_hash, submission_id, status, mb_recording_id, acoustid) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint_hash) DO UPDATE SET track_id = excluded.track_id, submission_id = excluded.submission_id, status = excluded.status, error = NULL, submitted_at = datetime('now')`
    )
    batch.forEach((t, n) => {
      const sub = reply!.submissions?.find((s) => Number(s.index ?? -1) === n) ?? reply!.submissions?.[n]
      const trackIds = { ...idsFor(t.decision, metaFor(t)), ...(t.idsOverride ?? {}) }
      insert.run(t.id, fingerprintHash(t.fingerprint!.fingerprint), sub?.id ?? null, sub?.status === "imported" ? "imported" : "pending", trackIds.mbRecordingId ?? null, sub?.result?.id ?? null)
      accepted++
      ctx.tick?.(true, t.filename)
    })
  }
  if (accepted) ctx.log("success", `Sent ${accepted} fingerprint${accepted === 1 ? "" : "s"} to AcoustID - they show as imported once AcoustID has processed them`)
  return accepted
}

interface StatusReply {
  status: string
  submissions?: { id: number; status: string; result?: { id?: string } }[]
}

/** Ask AcoustID how the pending submissions got on. */
export async function checkSubmissions(settings: Settings, log: (level: "info" | "warn", m: string) => void = () => {}): Promise<number> {
  const client = settings.sources.acoustid?.apiKey
  if (!client) return 0
  const db = getDb()
  const pending = db.prepare("SELECT id, submission_id FROM acoustid_submissions WHERE status = 'pending' AND submission_id IS NOT NULL ORDER BY id LIMIT 100").all() as { id: number; submission_id: number }[]
  let imported = 0
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH)
    const q = new URLSearchParams({ client, format: "json" })
    for (const p of batch) q.append("id", String(p.submission_id))
    let reply: StatusReply | null
    try {
      reply = await httpJson<StatusReply>(`${API}/submission_status?${q}`, { ttlMs: 0 })
    } catch (err) {
      log("warn", `Couldn't check AcoustID submissions: ${err instanceof Error ? err.message : err}`)
      return imported
    }
    const done = db.prepare("UPDATE acoustid_submissions SET status = 'imported', acoustid = ?, checked_at = datetime('now') WHERE submission_id = ?")
    const seen = db.prepare("UPDATE acoustid_submissions SET checked_at = datetime('now') WHERE submission_id = ?")
    for (const s of reply?.submissions ?? []) {
      if (s.status === "imported") {
        done.run(s.result?.id ?? null, s.id)
        imported++
      } else seen.run(s.id)
    }
  }
  if (imported) log("info", `AcoustID imported ${imported} of your fingerprints`)
  return imported
}

export function pendingSubmissions(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM acoustid_submissions WHERE status = 'pending'").get() as { n: number }).n
}
