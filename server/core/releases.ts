// Which release a track belongs to. The artist's own release context comes
// first - their album, EP, single, a standalone release, a remix or re-release
// of their own, their mixtape - then compilations, DJ mixes and anything else.
// It's a preference, not an override: a file whose own tags or folder name a
// compilation, a continuous mix, or a version that only exists on a mix keeps
// that release. Release groups are weighed first (what kind of release), then
// releases within them (official, earliest), then whether the recording on
// them is this file (length, fingerprint) - so a NOW! compilation doesn't win
// just because its metadata is tidier.

import type { Candidate, ReleaseChoice, ReleaseInfo, ReleaseKind } from "../../shared/types"
import { artistSimilarity, titleSimilarity } from "./normalize"

export const RELEASE_ORDER: ReleaseKind[] = ["album", "ep", "single", "standalone", "remix", "mixtape", "compilation", "dj-mix", "other"]

export const KIND_LABEL: Record<ReleaseKind, string> = {
  album: "album",
  ep: "EP",
  single: "single",
  standalone: "release",
  remix: "remix or re-release",
  mixtape: "mixtape",
  live: "live album",
  compilation: "compilation",
  "dj-mix": "DJ mix",
  other: "release",
}

const VARIOUS = /^(?:various(?: artists)?|va|v\.a\.|various artist)$/i

/** A release credited to the recording's own artist (false for Various Artists or someone else). */
export function isOwnRelease(releaseArtists: string[] | undefined, recordingArtists: string[]): boolean | null {
  if (!releaseArtists?.length) return null
  if (releaseArtists.some((a) => VARIOUS.test(a.trim()))) return false
  if (!recordingArtists.length) return null
  return artistSimilarity(releaseArtists, recordingArtists) >= 0.7
}

/** MusicBrainz release-group types → kind. DJ-mix and Compilation stay apart, as MusicBrainz keeps them. */
export function mbKind(primary: string | undefined | null, secondary: string[] = []): ReleaseKind {
  const sec = secondary.map((s) => s.toLowerCase())
  if (sec.includes("dj-mix")) return "dj-mix"
  if (sec.includes("compilation")) return "compilation"
  if (sec.includes("mixtape/street")) return "mixtape"
  if (sec.includes("remix")) return "remix"
  if (sec.includes("live")) return "live"
  if (sec.some((s) => ["soundtrack", "spokenword", "interview", "audiobook", "audio drama", "field recording"].includes(s))) return "other"
  switch ((primary ?? "").toLowerCase()) {
    case "album":
      return "album"
    case "ep":
      return "ep"
    case "single":
      return "single"
    case "broadcast":
      return "other"
    default:
      return "standalone"
  }
}

/** Discogs format descriptions ("Album", "EP", "Compilation", "Mixed", "Reissue"…) → kind. */
export function discogsKind(descriptions: string[], formatNames: string[] = []): ReleaseKind {
  const d = new Set(descriptions.map((x) => x.toLowerCase()))
  if (d.has("mixed")) return "dj-mix"
  if (d.has("compilation")) return "compilation"
  if (d.has("mixtape")) return "mixtape"
  if (d.has("reissue") || d.has("repress") || d.has("remastered")) return "remix"
  if (d.has("album") || d.has("lp")) return "album"
  if (d.has("ep") || d.has("mini-album")) return "ep"
  if (d.has("single") || d.has("maxi-single") || d.has('7"')) return "single"
  if (formatNames.some((f) => /^(?:file|cd|vinyl|cassette)$/i.test(f)) && (d.has('12"') || d.has("33 ⅓ rpm") || d.has("45 rpm"))) return "single"
  return "standalone"
}

/** Spotify's album_type → kind. */
export function spotifyKind(albumType: string | undefined): ReleaseKind {
  if (albumType === "album") return "album"
  if (albumType === "single") return "single"
  if (albumType === "compilation") return "compilation"
  return "standalone"
}

export interface ReleaseContext {
  /** the recording's artists, to tell the artist's own releases from others */
  artists: string[]
  /** the file's own album tag */
  albumTag?: string
  /** folder names the file sits in, nearest first */
  folders: string[]
  /** the file's length in seconds */
  duration: number | null
  /** version, filename: to spot a continuous mix */
  version?: string
  filename: string
  /** recordings an audio fingerprint pointed at */
  fingerprintRecordings: Set<string>
  preferOwn: boolean
}

/** How far down the preferred order a release sits (lower is preferred). */
export function releaseRank(r: ReleaseInfo): number {
  // Someone else's album or single (a producer's LP, a label sampler credited to the label) counts like a compilation.
  if (r.own === false && ["album", "ep", "single", "standalone", "remix", "mixtape", "live"].includes(r.kind)) return RELEASE_ORDER.indexOf("compilation") - 0.5
  if (r.kind === "live") return RELEASE_ORDER.indexOf("remix") + 0.5
  return RELEASE_ORDER.indexOf(r.kind)
}

function statusPenalty(r: ReleaseInfo): number {
  const s = (r.status ?? "").toLowerCase()
  if (!s || s === "official") return 0
  if (s === "promotion") return 0.1
  return 0.3 // bootleg, pseudo-release
}

const CONTINUOUS = /\b(?:continuous(?: mix)?|dj[ -]?mix|mixed by|mix ?tape|megamix|non-?stop|full (?:set|mix))\b/i

/** Every release the cluster's sources mention, once each (same source and id, or same title and kind). */
export function releasesOf(candidates: Candidate[]): ReleaseInfo[] {
  const seen = new Set<string>()
  const out: ReleaseInfo[] = []
  for (const c of candidates) {
    for (const r of c.releases ?? []) {
      const key = r.id ? `${r.source}:${r.id}` : `${r.title.toLowerCase()}|${r.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(r)
    }
  }
  return out
}

/**
 * The release to credit a track to, and why. Null when no source named any.
 */
export function pickRelease(releases: ReleaseInfo[], ctx: ReleaseContext): ReleaseChoice | null {
  if (!releases.length) return null
  if (!ctx.preferOwn) return { release: releases[0], reason: "the first release the sources listed", considered: releases.length }

  const own = (r: ReleaseInfo) => r.own !== false && !["compilation", "dj-mix", "other"].includes(r.kind)
  const bestOwn = () => [...releases].filter(own).sort(compare)[0]
  // A version whose length only matches some releases (a radio edit, a mix edit) belongs to those.
  const lengthOk = (r: ReleaseInfo) => !ctx.duration || !r.length || Math.abs(r.length - ctx.duration) <= 10
  const matching = releases.filter(lengthOk)
  const pool = matching.length ? matching : releases

  function compare(a: ReleaseInfo, b: ReleaseInfo) {
    const fp = (r: ReleaseInfo) => (r.recordingId && ctx.fingerprintRecordings.has(r.recordingId) ? 0 : 1)
    return (
      releaseRank(a) - releaseRank(b) ||
      Number(!lengthOk(a)) - Number(!lengthOk(b)) ||
      fp(a) - fp(b) ||
      statusPenalty(a) - statusPenalty(b) ||
      (a.date || "9999").localeCompare(b.date || "9999")
    )
  }
  const withOwn = (choice: ReleaseChoice): ReleaseChoice => {
    const alt = bestOwn()
    return alt && alt !== choice.release && !own(choice.release) ? { ...choice, ownAlternative: alt } : choice
  }

  // 1. The file names its release: its album tag, or a folder called after it.
  const named = (text: string | undefined) => (text ? pool.find((r) => titleSimilarity(r.title, text) >= 0.9) : undefined)
  const byTag = named(ctx.albumTag)
  if (byTag) return withOwn({ release: byTag, reason: `the file's album tag names this ${KIND_LABEL[byTag.kind]}`, considered: releases.length })
  for (const folder of ctx.folders.slice(0, 2)) {
    const byFolder = named(folder)
    if (byFolder) return withOwn({ release: byFolder, reason: `the folder is named after this ${KIND_LABEL[byFolder.kind]}`, considered: releases.length })
  }

  // 2. A continuous mix belongs to the DJ mix it's from.
  const mixes = pool.filter((r) => r.kind === "dj-mix")
  const continuous = (ctx.duration ?? 0) >= 20 * 60 || CONTINUOUS.test(`${ctx.version ?? ""} ${ctx.filename}`)
  if (mixes.length && continuous) {
    const mix = [...mixes].sort(compare)[0]
    return withOwn({ release: mix, reason: "a continuous mix, so it keeps the DJ mix it's from", considered: releases.length })
  }

  // 3. Otherwise the preferred order, among releases this version is on.
  const best = [...pool].sort(compare)[0]
  const reason = own(best)
    ? `the artist's own ${KIND_LABEL[best.kind]}${matching.length && matching.length < releases.length ? " with this version on it" : ""}`
    : best.kind === "dj-mix"
      ? "this version is only on a DJ mix"
      : best.kind === "compilation"
        ? "this version is only on compilations"
        : `the best of ${releases.length} release${releases.length === 1 ? "" : "s"}`
  return withOwn({ release: best, reason, considered: releases.length })
}
