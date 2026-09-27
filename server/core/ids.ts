// Catalogue IDs for an approved track. They're taken from the sources that
// agreed on the approved song, so an edit to a different song never inherits
// the wrong IDs.

import type { Decision, ExternalIds, FinalMeta } from "../../shared/types"
import { artistSimilarity, titleSimilarity } from "./normalize"

export function idsFor(decision: Decision | null | undefined, meta: FinalMeta | null | undefined): ExternalIds {
  if (!decision || !meta?.title || !meta.artists.length) return {}
  const cluster = decision.clusters.find((c) => titleSimilarity(c.title, meta.title) >= 0.85 && artistSimilarity(c.artist, meta.artists) >= 0.7)
  if (!cluster) return {}
  const out: ExternalIds = {}
  // A fingerprint match is the surest recording; otherwise the catalogue's own best-scored hit.
  const mb = cluster.candidates
    .filter((c) => c.ids?.mbRecordingId)
    .sort((a, b) => Number(!!b.fingerprint) - Number(!!a.fingerprint) || (b.sourceScore ?? 0) - (a.sourceScore ?? 0))
  if (mb[0]?.ids) {
    const recording = mb[0].ids.mbRecordingId
    // Fill the release and artists from any hit on the same recording.
    const same = mb.filter((c) => c.ids?.mbRecordingId === recording)
    out.mbRecordingId = recording
    out.mbReleaseId = same.find((c) => c.ids?.mbReleaseId)?.ids?.mbReleaseId
    out.mbArtistIds = same.find((c) => c.ids?.mbArtistIds?.length)?.ids?.mbArtistIds
  }
  const discogs = cluster.candidates.find((c) => c.ids?.discogsReleaseId)
  if (discogs?.ids?.discogsReleaseId) out.discogsReleaseId = discogs.ids.discogsReleaseId
  for (const k of Object.keys(out) as (keyof ExternalIds)[]) if (!out[k] || (Array.isArray(out[k]) && !out[k].length)) delete out[k]
  return out
}
