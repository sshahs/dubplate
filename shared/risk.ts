// How safe it is to let automation change a file - kept apart from how sure
// the identification is. A 92 that one source backs up, on a file that's cut
// short, is a confident guess but a risky write. Auto-approve and hands-off
// only act on low-risk tracks; everything else waits for a person.

import { fileProblems } from "./problems"
import type { Decision, RiskAssessment, SourceId, Track } from "./types"

/** How each level reads. */
export const RISK_LABEL: Record<RiskAssessment["level"], string> = { low: "Low risk", medium: "Some risk", high: "High risk" }

/**
 * Sources that don't share data count once each: Discogs and your Discogs
 * collection are one, and so are MusicBrainz's text search and anything built
 * on it. AcoustID counts on its own - it listens to the audio.
 */
const SAME_DATA: Partial<Record<SourceId, string>> = { "discogs-collection": "discogs" }

/** How many independent sources back a cluster up. */
export function independentSources(sources: string[]): number {
  return new Set(sources.map((s) => SAME_DATA[s as SourceId] ?? s)).size
}

export type RiskInput = Pick<Track, "decision" | "analysis" | "fileCheck" | "ext">

export function riskOf(t: RiskInput): RiskAssessment {
  const high: string[] = []
  const medium: string[] = []
  const d: Decision | null = t.decision
  if (!d) return { level: "high", reasons: ["Not identified yet"] }
  if (d.escalated) high.push("A second model had to look at it, so a person decides")
  if (d.status === "conflict") high.push("Sources disagree about what it is")
  if (d.basis !== "sources") high.push("No source confirms the reading")
  if (d.versionCheck?.fingerprintMatch === false) high.push("The audio fingerprint points at a different recording")
  for (const p of fileProblems(t)) if (p.severity === "error") high.push(`The file is ${p.label.toLowerCase()}`)
  if (d.basis === "sources" && independentSources(d.clusters[0]?.sources ?? []) < 2 && d.versionCheck?.fingerprintMatch !== true) medium.push("Only one source confirms it")
  if (d.versionCheck?.durationMatch === false) medium.push("Its length doesn't match the recording's")
  if (t.analysis?.quality?.verdict === "suspect") medium.push("It sounds re-encoded from a lower-quality file")
  if (t.fileCheck?.realExt) medium.push("Its extension changes when it's cut")
  const level = high.length ? "high" : medium.length ? "medium" : "low"
  return { level, reasons: [...high, ...medium] }
}
