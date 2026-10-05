// "Listen": identify a track by its sound alone, the way Shazam does - its Chromaprint
// fingerprint looked up on AcoustID - and offer what it heard as suggestions to pick
// from. For files with nothing to go on ("Track 1.mp3"), and for a second opinion.

import type { Candidate, Settings, Track } from "../shared/types"
import { checkCandidate, cleanCandidate } from "./core/plain-text"
import { log } from "./logs"
import { scoreAndSave } from "./pipeline"
import { getTrack, updateTrack } from "./repo"
import { acoustidMatches, findFpcalc, fingerprintFile } from "./sources/acoustid"

export interface ListenResult {
  /** what it heard, best match first (weaker guesses included, marked by their score) */
  suggestions: Candidate[]
  /** matches AcoustID has that nobody has named on MusicBrainz yet */
  unnamed: number
  track: Track
}

/** Below this, AcoustID's matches are usually wrong: shown as guesses, never used on their own. */
const LISTEN_MIN_SCORE = 0.3

/** Why listening can't happen here, or null. */
export function cantListen(settings: Settings): string | null {
  const cfg = settings.sources.acoustid
  if (!cfg?.apiKey) return "Listening needs an AcoustID application key - add one under Sources → AcoustID (it's free)."
  if (!findFpcalc()) return "Listening needs fpcalc (Chromaprint) to fingerprint the audio, and it isn't installed here."
  return null
}

export async function listenTo(track: Track, settings: Settings, signal?: AbortSignal): Promise<ListenResult> {
  // The first two minutes, as AcoustID expects; kept, so listening again (or submitting it) is instant.
  const fp = track.fingerprint ?? { ...(await fingerprintFile(track.path, signal)), at: new Date().toISOString() }
  if (!track.fingerprint) updateTrack(track.id, { fingerprint: fp })
  const { candidates, unnamed } = await acoustidMatches(fp, settings.sources.acoustid!.apiKey!, signal, { minScore: LISTEN_MIN_SCORE, limit: 10 })
  const heard = candidates.map(cleanCandidate).flatMap((c) => checkCandidate(c) ?? [])
  // What it heard joins what the other sources found (in place of an earlier listen), and the track is decided again.
  const others = (track.candidates ?? []).filter((c) => c.source !== "acoustid")
  updateTrack(track.id, { candidates: [...heard, ...others] })
  scoreAndSave(getTrack(track.id)!, settings)
  const top = heard[0]
  log(
    "info",
    top
      ? `Listened to ${track.filename}: AcoustID hears ${top.artist} - ${top.title} (${Math.round((top.sourceScore ?? 0) * 100)}%)${heard.length > 1 ? ` and ${heard.length - 1} other suggestion${heard.length === 2 ? "" : "s"}` : ""}`
      : `Listened to ${track.filename}: ${unnamed ? "AcoustID knows the audio, but nobody has named it yet" : "AcoustID doesn't know the audio"}`,
    { area: "identify", trackId: track.id, detail: heard.map((c) => `${Math.round((c.sourceScore ?? 0) * 100)}%  ${c.artist} - ${c.title}${c.album ? ` · ${c.album}` : ""}  ${c.url ?? ""}`).join("\n") || undefined }
  )
  return { suggestions: heard, unnamed, track: getTrack(track.id)! }
}
