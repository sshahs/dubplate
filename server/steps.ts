// How a track was decided, as separate questions in order: which recording,
// which release, which version, which canonical genre, is it safe to change,
// is it verified, can it go to AcoustID, is it on MusicBrainz. Each answers
// on its own, so a sure recording with a doubtful release says exactly that.

import { independentSources, RISK_LABEL, riskOf } from "../shared/risk"
import type { AcoustIdEligibility, DecisionStep, MbSubmission, RiskAssessment, Settings, Track } from "../shared/types"
import { eligibility } from "./acoustid-submit"
import { idsFor } from "./core/ids"
import { KIND_LABEL } from "./core/releases"
import { getDb, parseJson } from "./db"
import { canonicalGenre } from "./genres"
import { metaFor } from "./placement"

export interface TrackInsight {
  steps: DecisionStep[]
  risk: RiskAssessment
  acoustid: AcoustIdEligibility
  musicbrainz: MbSubmission | null
}

function latestMbSubmission(trackId: number): MbSubmission | null {
  const rows = getDb().prepare("SELECT * FROM mb_submissions ORDER BY id DESC LIMIT 200").all() as {
    id: number
    track_ids_json: string
    title: string
    status: string
    release_mbid: string | null
    created_at: string
    updated_at: string
  }[]
  const r = rows.find((x) => parseJson<number[]>(x.track_ids_json, []).includes(trackId))
  return r
    ? {
        id: r.id,
        trackIds: parseJson<number[]>(r.track_ids_json, []),
        title: r.title,
        status: r.status === "received" ? "received" : r.status === "submitted" ? "submitted" : "pending",
        releaseMbid: r.release_mbid,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }
    : null
}

/** What's still missing before a fingerprint can go: the first thing, and how many more. */
function missingDetail(missing: AcoustIdEligibility["checks"]): string {
  const [first, ...rest] = missing
  if (!first) return ""
  return `${first.detail ?? first.label}${rest.length ? ` (and ${rest.length} more)` : ""}`
}

export function trackInsight(t: Track, settings: Settings): TrackInsight {
  const d = t.decision
  const meta = metaFor(t)
  const risk = riskOf(t)
  const acoustid = eligibility(t, settings)
  const mb = latestMbSubmission(t.id)
  const steps: DecisionStep[] = []

  // 1. Which recording
  if (!d) steps.push({ key: "recording", label: "Recording", state: "pending", value: "Not identified yet" })
  else if (d.basis === "sources") {
    const n = independentSources(d.clusters[0]?.sources ?? [])
    const names = [...new Set((d.clusters[0]?.candidates ?? []).map((c) => c.sourceLabel))]
    steps.push({
      key: "recording",
      label: "Recording",
      state: d.status === "conflict" ? "warn" : "ok",
      value: `${d.artist} - ${d.title}`,
      detail: `${n} independent source${n === 1 ? "" : "s"} (${names.join(", ")})${d.versionCheck?.fingerprintMatch ? ", and the audio fingerprint" : ""}${d.status === "conflict" ? " - but another source suggests something else" : ""}`,
    })
  } else {
    steps.push({
      key: "recording",
      label: "Recording",
      state: "warn",
      value: d.title ? `${d.artist} - ${d.title}` : "Unknown",
      detail: d.clusters.length ? "Only supporting sources had it - nothing confirms it" : `No source knows it, so it's capped at ${settings.confidence.parseOnlyMax} - common for dubplates and specials`,
    })
  }

  // 2. Which release
  if (d?.release) {
    const r = d.release
    steps.push({
      key: "release",
      label: "Release",
      state: r.ownAlternative ? "info" : "ok",
      value: `${r.release.title} (${KIND_LABEL[r.release.kind]})`,
      detail: `Chosen because ${r.reason}${r.considered > 1 ? `, of ${r.considered} releases` : ""}.${r.ownAlternative ? ` The artist's own is ${r.ownAlternative.title} (${KIND_LABEL[r.ownAlternative.kind]}).` : ""}`,
    })
  } else if (d?.basis === "sources") steps.push({ key: "release", label: "Release", state: "info", value: "None named", detail: "The sources that know it didn't say which release it's on" })

  // 3. Which version
  if (d?.versionCheck) {
    const v = d.versionCheck
    const checks = [
      v.durationMatch === true ? "length matches" : v.durationMatch === false ? "length doesn't match the recording" : null,
      v.fingerprintMatch === true ? "fingerprint matches" : v.fingerprintMatch === false ? "fingerprint points elsewhere" : null,
      v.official === true ? "official release" : v.official === false ? "not an official release of theirs" : null,
    ].filter(Boolean)
    steps.push({
      key: "version",
      label: "Version",
      state: v.durationMatch === false || v.fingerprintMatch === false ? "warn" : "ok",
      value: `${v.label}${meta?.version ? ` - ${meta.version}` : ""}`,
      detail: checks.length ? `${checks.join(", ")}.` : undefined,
    })
  }

  // 4. Which canonical genre
  if (settings.canonicalGenres.enabled) {
    const g = canonicalGenre(t, d, settings)
    steps.push(
      g
        ? { key: "genre", label: "Genre", state: "ok", value: g.region ? `${g.genre} (${g.region})` : g.genre, detail: `From ${g.from}.${d?.sourceGenres?.length ? ` The sources said: ${d.sourceGenres.join(", ")}.` : ""}` }
        : { key: "genre", label: "Genre", state: "warn", value: "Not in your list", detail: `Nothing fits a canonical genre${d?.sourceGenres?.length ? ` (the sources said: ${d.sourceGenres.join(", ")})` : ""} - pick one, or add a rule. No genre is written until then.` }
    )
  } else if (d?.sourceGenres?.length) steps.push({ key: "genre", label: "Genre", state: "info", value: d.sourceGenres.slice(0, 3).join(", "), detail: "As the sources worded it (canonical genres are off)" })

  // 5. Is it safe to change without a person?
  steps.push({
    key: "safety",
    label: "Safe to automate",
    state: risk.level === "low" ? "ok" : risk.level === "medium" ? "warn" : "bad",
    value: RISK_LABEL[risk.level],
    detail: risk.reasons.length ? `${risk.reasons.join(". ")}. Auto-approve and hands-off only act on low-risk tracks.` : "Nothing stands in the way of auto-approve or hands-off.",
  })

  // 6. Verified
  steps.push(
    t.approvedBy === "person" && (t.status === "approved" || t.status === "done")
      ? { key: "verified", label: "Verified", state: "ok", value: "Approved by you" }
      : t.status === "approved" || t.status === "done"
        ? t.approvedBy
          ? { key: "verified", label: "Verified", state: "info", value: t.approvedBy === "hands-off" ? "Approved by hands-off" : "Auto-approved", detail: "Approve it yourself for AcoustID to count it as verified by a person" }
          : { key: "verified", label: "Verified", state: "info", value: "Approved", detail: "Before Dubplate noted who approved what, so it doesn't count as verified by a person" }
        : { key: "verified", label: "Verified", state: "pending", value: "Waiting for approval" }
  )

  // 7. AcoustID
  const sub = acoustid.submission
  steps.push(
    sub && sub.status !== "failed"
      ? { key: "acoustid", label: "AcoustID", state: sub.status === "imported" ? "ok" : "pending", value: sub.status === "imported" ? "Fingerprint imported" : "Fingerprint sent, waiting", detail: sub.acoustId ?? undefined }
      : acoustid.eligible
        ? { key: "acoustid", label: "AcoustID", state: "pending", value: "Ready to send", detail: settings.acoustid.submit ? "Sent after the next cut" : "Sending is off in Sources → AcoustID" }
        : { key: "acoustid", label: "AcoustID", state: "info", value: "Not sent", detail: missingDetail(acoustid.checks.filter((c) => !c.ok)) }
  )

  // 8. MusicBrainz
  const ids = { ...idsFor(d, meta), ...(t.idsOverride ?? {}) }
  steps.push(
    ids.mbReleaseId
      ? { key: "musicbrainz", label: "MusicBrainz", state: "ok", value: "Release known", detail: ids.mbReleaseId }
      : mb && mb.status !== "received"
        ? { key: "musicbrainz", label: "MusicBrainz", state: "pending", value: mb.status === "submitted" ? "Sent to the release editor" : "Started, not sent yet", detail: `${mb.title} - waiting for the new release's ID` }
        : { key: "musicbrainz", label: "MusicBrainz", state: "info", value: ids.mbRecordingId ? "Recording known, no release" : "Not on MusicBrainz", detail: meta ? "You can add it: Dubplate fills in the release editor, you check and submit" : undefined }
  )
  return { steps, risk, acoustid, musicbrainz: mb }
}
