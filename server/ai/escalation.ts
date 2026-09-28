// Escalation: a second, larger model reads the uncertain tracks - a score in
// the middle band, or sources that disagree - and never the ones no source
// knows at all (the capped "nothing online knows it" case, where a bigger
// model has nothing more to check against). Whatever it reads, a person
// approves: an escalated track never auto-approves or goes hands-off.

import type { Correction, Settings, Track } from "../../shared/types"
import { normArtist, normTitle } from "../core/normalize"
import { interpretTrack, providerWithModel } from "./interpreter"

/** Whether a scored track should go to the second model. */
export function shouldEscalate(t: Track, settings: Settings): string | null {
  const e = settings.llm.escalation
  const d = t.decision
  if (!e.enabled || !d || t.escalation) return null
  if (t.status === "approved" || t.status === "done" || t.status === "rejected") return null
  if (!providerWithModel(settings, e.providerId, e.model)) return null
  // Nothing online knows it: a bigger model can't check against anything either.
  if (!d.clusters.length) return null
  if (d.status === "conflict") return "sources disagree"
  const c = d.confidence
  return c >= e.from && c <= e.to ? `scored ${c}, between ${e.from} and ${e.to}` : null
}

function sameReading(a: { artists: string[]; title: string }, b: { artists: string[]; title: string } | null | undefined) {
  if (!b) return false
  return normTitle(a.title) === normTitle(b.title) && a.artists.map(normArtist).join("|") === b.artists.map(normArtist).join("|")
}

/** Ask the second model; returns the track with its reading stored (not yet re-scored). */
export async function escalate(t: Track, reason: string, settings: Settings, opts: { corrections: Correction[]; aliases: Map<string, string>; signal?: AbortSignal }): Promise<Track> {
  const e = settings.llm.escalation
  const provider = providerWithModel(settings, e.providerId, e.model)!
  const ai = await interpretTrack(t, settings, { ...opts, provider })
  const d = t.decision!
  const escalation = {
    ai,
    provider: provider.label,
    model: provider.model,
    at: new Date().toISOString(),
    before: { confidence: d.confidence, status: d.status, artists: d.artists, title: d.title },
    changed: !sameReading(ai, t.ai ?? d),
    reason,
  }
  return { ...t, escalation }
}
