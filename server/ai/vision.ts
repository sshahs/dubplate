// A vision model looks at a found cover when the match is in doubt - the
// sources disagreed, a second model had to read the track, the release was a
// compilation over the artist's own, or the sources offered several different
// covers. A cover it's sure is wrong isn't embedded.

import type { ArtRef, CoverCheck, Settings, Track } from "../../shared/types"
import { cachedArt } from "../art"
import { metaFor } from "../placement"
import { providerWithModel } from "./interpreter"
import { completeJson } from "./providers"

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matches", "confidence", "reason"],
  properties: {
    matches: { type: "boolean" },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
} as const

/** Why the cover's worth a second look, or null when it isn't in doubt. */
export function coverInDoubt(t: Track): string | null {
  const d = t.decision
  if (!d) return null
  if (d.escalated) return "a second model had to read the track"
  if (d.status === "conflict") return "the sources disagree"
  if (d.release?.ownAlternative) return "the release is a compilation or mix, not the artist's own"
  const covers = new Set((d.clusters[0]?.candidates ?? []).map((c) => c.artwork).filter(Boolean))
  if (covers.size >= 3) return "the sources offered several different covers"
  return null
}

/** Ask the vision model whether `art` is this track's cover. Null when vision isn't set up. */
export async function checkCover(t: Track, art: ArtRef, settings: Settings, signal?: AbortSignal): Promise<CoverCheck | null> {
  const v = settings.llm.vision
  const provider = v.enabled ? providerWithModel(settings, v.providerId, v.model) : null
  const bytes = cachedArt(art.hash)
  const meta = metaFor(t)
  if (!provider || !bytes || !meta) return null
  const what = [
    `Artist: ${meta.artists.join(", ")}`,
    `Title: ${meta.title}${meta.version ? ` (${meta.version})` : ""}`,
    t.decision?.release ? `Release: ${t.decision.release.release.title}` : meta.album ? `Album: ${meta.album}` : "",
    meta.year ? `Year: ${meta.year}` : "",
  ]
    .filter(Boolean)
    .join("\n")
  const raw = (await completeJson(provider, {
    system:
      "You check album and single covers for a music tagger. Look at the picture and decide whether it is plausibly the cover of the release described. Text on the cover (artist or title) is the strongest clue; a generic or unrelated image, another artist's name, or a different title means it doesn't match. Answer with JSON only.",
    user: `${what}\n\nIs this picture the cover of that release? confidence is 0 to 1.`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    schemaName: "check_cover",
    temperature: 0,
    signal,
    images: [{ mime: art.mime, base64: bytes.toString("base64") }],
  })) as { matches?: unknown; confidence?: unknown; reason?: unknown }
  const confidence = Math.max(0, Math.min(1, Number(raw?.confidence) || 0))
  return { model: provider.model, matches: raw?.matches !== false, confidence, reason: String(raw?.reason ?? "").slice(0, 300), at: new Date().toISOString() }
}
