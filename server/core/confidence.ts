// Confidence engine: compares every reading of a file (AI, rule-based
// parser, embedded tags) against what the metadata sources returned, clusters
// the source hits, looks for consensus and conflict, and produces an
// explainable 0–100 score plus the metadata to apply.

import type {
  AiParse,
  Candidate,
  CandidateCluster,
  ConfidenceFactor,
  Decision,
  ExistingTags,
  HeuristicParse,
  ProvenanceField,
  ReleaseChoice,
  TrackReading,
  VersionCheck,
} from "../../shared/types"
import { checkFields, isPlaceholder, needsALook, versionBacked, withoutUnbackedVersions } from "../../shared/fields"
import { artistSimilarity, collapseSpaces, normArtist, normTitle, similarity, splitArtists, titleSimilarity } from "./normalize"
import { KIND_LABEL, pickRelease, releasesOf } from "./releases"
import { withoutDiscFolders } from "./discs"

export interface ScoreInput {
  heuristic: HeuristicParse | null
  ai: AiParse | null
  tags: ExistingTags
  candidates: Candidate[]
  duration: number | null
  /** source id → weight (default 0.6) */
  weights: Record<string, number>
  thresholds: { autoThreshold: number; reviewThreshold: number; parseOnlyMax: number }
  /** what the file itself says about its release, for choosing among the sources' releases */
  context?: {
    filename: string
    folders: string[]
    preferOwnRelease: boolean
    /** what may say what kind of recording this is: its own first name and title (else the filename and title tag) */
    versionSays?: string[]
  }
  /** sources whose hits back others up but never confirm a track on their own */
  supporting?: Set<string>
}

interface Hypothesis {
  artists: string[]
  title: string
  from: "ai" | "ai-alt" | "heuristic" | "tags"
  descriptive: boolean
}

const DESCRIPTIVE =
  /^(?:live(?: clash| at .+| in .+| session)?|clash|sound ?clash|dubplates?|dubplate (?:session|mix|special)|specials?|session|set|mix|radio (?:set|show)|untitled|unknown)(?: \d{4})?$/i

export function isDescriptiveTitle(r: Pick<TrackReading, "title" | "relation">): boolean {
  const t = r.title?.trim() ?? ""
  return !t || DESCRIPTIVE.test(t) || (r.relation === "vs" && /\b(?:live|clash)\b/i.test(t))
}

const GENERIC_TAG_TITLE = /^(?:track\s*\d+|audio\s*track|unknown|untitled|\d+)$/i

const RELEVANCE_MIN = 0.55
const CLUSTER_MIN = 0.85
const VERSION_OK_FOR_DURATION = /live|dub|special|remix|mix|vip|refix|edit|extended|instrumental|clash|bootleg/i

function candidateArtists(c: Candidate): string[] {
  return c.artists?.length ? c.artists : splitArtists(c.artist).artists
}

/** How well a candidate matches a hypothesis (0..1). */
export function relevance(h: Hypothesis, c: Candidate): number {
  const cArtists = candidateArtists(c)
  const t = titleSimilarity(h.title, c.title)
  if (!h.artists.length) return t * 0.7
  const a = artistSimilarity(h.artists, cArtists)
  const straight = h.descriptive ? a * (0.6 + 0.4 * t) : t * (0.35 + 0.65 * a)
  // Filenames are sometimes "Title - Artist".
  const swapped = h.descriptive
    ? 0
    : titleSimilarity(h.artists.join(" "), c.title) * (0.35 + 0.65 * artistSimilarity([h.title], cArtists)) * 0.92
  return Math.max(straight, swapped)
}

/** Similarity between two candidates, for clustering. */
function sameRecording(a: Candidate, b: Candidate): number {
  const t = titleSimilarity(a.title, b.title)
  const ar = artistSimilarity(candidateArtists(a), candidateArtists(b))
  return t * (0.35 + 0.65 * ar)
}

function readingSimilarity(a: Hypothesis, b: Hypothesis): number {
  if (!a.artists.length || !b.artists.length) return titleSimilarity(a.title, b.title) * 0.7
  return titleSimilarity(a.title, b.title) * 0.55 + artistSimilarity(a.artists, b.artists) * 0.45
}

function hypotheses(input: ScoreInput): Hypothesis[] {
  const out: Hypothesis[] = []
  const { ai, heuristic, tags } = input
  if (ai && (ai.title || ai.artists.length)) {
    out.push({ artists: ai.artists, title: ai.title, from: "ai", descriptive: isDescriptiveTitle(ai) })
    for (const alt of ai.alternatives) out.push({ artists: alt.artists, title: alt.title, from: "ai-alt", descriptive: isDescriptiveTitle(alt) })
  }
  if (heuristic && (heuristic.title || heuristic.artists.length)) {
    out.push({ artists: heuristic.artists, title: heuristic.title, from: "heuristic", descriptive: isDescriptiveTitle(heuristic) })
  }
  if (tags.title && tags.artist && !GENERIC_TAG_TITLE.test(tags.title)) {
    const split = tags.artists?.length ? tags.artists : splitArtists(tags.artist).artists
    // Tags written as "Artist - Title" in the artist, a riddim as the artist…: read as they should have been.
    const { fields } = checkFields({ artists: split, title: tags.title }, { names: false })
    out.push({ artists: fields.artists, title: fields.title, from: "tags", descriptive: false })
  }
  return out
}

function round(n: number) {
  return Math.round(n * 1000) / 1000
}

export function scoreTrack(input: ScoreInput): Decision {
  const hyps = hypotheses(input)
  const primary = hyps.find((h) => h.from === "ai") ?? hyps.find((h) => h.from === "heuristic") ?? hyps.find((h) => h.from === "tags")
  const warnings: string[] = []
  const factors: ConfidenceFactor[] = []
  const weightOf = (source: string) => input.weights[source] ?? 0.6

  const baseReading: TrackReading =
    primary?.from === "ai" && input.ai
      ? input.ai
      : primary?.from === "heuristic" && input.heuristic
        ? input.heuristic
        : { artists: primary?.artists ?? [], featuring: [], title: primary?.title ?? "" }

  if (!primary) {
    return {
      ...emptyDecision(),
      warnings: ["Nothing could be read from this file - no filename structure, tags or AI reading."],
    }
  }

  // ---- parse agreement ----
  const others = hyps.filter((h) => h !== primary && h.from !== "ai-alt")
  const agreement = others.length ? others.reduce((s, h) => s + readingSimilarity(primary, h), 0) / others.length : primaryOwnConfidence(input, primary) * 0.8
  factors.push({
    key: "agreement",
    label: "Readings agree",
    score: round(agreement),
    weight: 0.5,
    detail: others.length
      ? `${primary.from === "ai" ? "AI" : "Parser"} reading vs ${others.map((h) => (h.from === "tags" ? "embedded tags" : h.from === "heuristic" ? "rule-based parse" : h.from)).join(" & ")}`
      : "Only one reading available",
  })

  const selfConf = input.ai ? input.ai.confidence : (input.heuristic?.confidence ?? 0.3) * 0.8
  factors.push({
    key: "ai",
    label: input.ai ? "AI certainty" : "Parser certainty",
    score: round(selfConf),
    weight: 0.5,
    detail: input.ai ? `${input.ai.model}: ${input.ai.reasoning || "no reasoning given"}` : "No AI reading yet - rule-based parser only",
  })
  const parseScore = 0.5 * agreement + 0.5 * selfConf

  // ---- relevance + clustering ----
  const scored = input.candidates
    .map((c) => {
      let rel = Math.max(0, ...hyps.map((h) => relevance(h, c) * (h.from === "ai-alt" ? 0.9 : 1)))
      if (c.fingerprint && c.sourceScore) rel = Math.max(rel, c.sourceScore * 0.95)
      return { c, rel, relPrimary: relevance(primary, c) }
    })
    .filter((x) => x.rel >= RELEVANCE_MIN)
    .sort((a, b) => b.rel - a.rel)

  const clusters: (CandidateCluster & { rep: Candidate; best: Map<string, number>; relPrimary: number })[] = []
  for (const x of scored) {
    const home = clusters.find((cl) => sameRecording(cl.rep, x.c) >= CLUSTER_MIN)
    if (home) {
      home.candidates.push(x.c)
      home.best.set(x.c.source, Math.max(home.best.get(x.c.source) ?? 0, x.rel))
      home.relPrimary = Math.max(home.relPrimary, x.relPrimary)
    } else {
      clusters.push({
        artist: x.c.artist,
        title: x.c.title,
        sources: [],
        support: 0,
        relevance: x.rel,
        candidates: [x.c],
        rep: x.c,
        best: new Map([[x.c.source, x.rel]]),
        relPrimary: x.relPrimary,
      })
    }
  }
  for (const cl of clusters) {
    cl.sources = [...cl.best.keys()] as CandidateCluster["sources"]
    cl.support = round([...cl.best.entries()].reduce((s, [src, rel]) => s + weightOf(src) * rel, 0))
    // Prefer the most authoritative spelling as the cluster representative.
    cl.rep = [...cl.candidates].sort((a, b) => weightOf(b.source) - weightOf(a.source))[0]
    cl.artist = cl.rep.artist
    cl.title = cl.rep.title
  }
  clusters.sort((a, b) => b.support - a.support)

  // A cluster only supporting-evidence sources agree on backs a reading up, but doesn't confirm it.
  const confirms = (cl: (typeof clusters)[number]) => !input.supporting?.size || cl.sources.some((s) => !input.supporting!.has(s))
  if (clusters.length && !confirms(clusters[0])) {
    const firm = clusters.findIndex(confirms)
    if (firm > 0) clusters.unshift(...clusters.splice(firm, 1))
  }
  const best = clusters.length && confirms(clusters[0]) ? clusters[0] : undefined
  const runner = clusters[1]
  let conflict = false
  let final: number
  let basis: Decision["basis"] = primary.from === "ai" ? "ai" : primary.from === "heuristic" ? "heuristic" : "tags"
  let reading: TrackReading = { ...baseReading, artists: [...baseReading.artists], featuring: [...(baseReading.featuring ?? [])] }

  if (best) {
    const sourceMatch = Math.max(best.relPrimary, best.relevance * 0.9)
    const consensus = 1 - Math.exp(-best.support / 1.0)
    factors.push({
      key: "match",
      label: "Sources match the reading",
      score: round(sourceMatch),
      weight: 0.5,
      detail: `Closest hit: ${best.rep.sourceLabel} - ${best.rep.artist} - ${best.rep.title}`,
    })
    factors.push({
      key: "consensus",
      label: "Source consensus",
      score: round(consensus),
      weight: 0.5,
      detail: `${best.sources.length} source${best.sources.length === 1 ? "" : "s"} agree (${best.candidates.map((c) => c.sourceLabel).filter((v, i, a) => a.indexOf(v) === i).join(", ")})`,
    })
    const sourceScore = 0.5 * sourceMatch + 0.5 * consensus
    final = 0.3 * parseScore + 0.7 * sourceScore

    // ---- conflict ----
    if (runner && runner.support >= best.support * 0.6 && runner.relevance >= 0.7 && sameRecording(best.rep, runner.rep) < CLUSTER_MIN) {
      conflict = true
      const penalty = 0.25 * (runner.support / best.support)
      final -= penalty
      factors.push({
        key: "conflict",
        label: "Conflicting matches",
        score: round(1 - runner.support / best.support),
        weight: -penalty,
        detail: `${runner.rep.sourceLabel} suggests ${runner.rep.artist} - ${runner.rep.title}`,
      })
      warnings.push(`Sources disagree: "${best.rep.artist} - ${best.rep.title}" vs "${runner.rep.artist} - ${runner.rep.title}"`)
    }

    // ---- fingerprint ----
    if (best.candidates.some((c) => c.fingerprint)) {
      final += 0.06
      factors.push({ key: "fingerprint", label: "Audio fingerprint", score: 1, weight: 0.06, detail: "AcoustID recognised the audio itself" })
    } else if (clusters.some((cl) => cl !== best && cl.candidates.some((c) => c.fingerprint))) {
      conflict = true
      warnings.push("The audio fingerprint points to a different recording than the filename")
    }

    // ---- duration ----
    const isVersion = VERSION_OK_FOR_DURATION.test(`${reading.version ?? ""} ${input.heuristic?.hints.join(" ") ?? ""}`)
    const durations = best.candidates.map((c) => c.duration).filter((d): d is number => !!d)
    // A whole side or disc in one file is meant to be longer than any one track.
    if (input.duration && durations.length && !input.heuristic?.position?.whole) {
      const delta = Math.min(...durations.map((d) => Math.abs(d - input.duration!)))
      let adj = 0
      if (delta <= 3) adj = 0.04
      else if (delta > 30 && !isVersion) adj = -0.06
      if (adj) {
        final += adj
        factors.push({
          key: "duration",
          label: "Duration check",
          score: adj > 0 ? 1 : 0,
          weight: adj,
          detail: adj > 0 ? `Within ${Math.round(delta)}s of the source` : `${Math.round(delta)}s longer/shorter than any source - maybe a different version`,
        })
      }
    }

    // ---- choose spelling ----
    if (sourceMatch >= 0.8 || best.candidates.some((c) => c.fingerprint)) {
      basis = "sources"
      reading = mergeFromSources(reading, best.rep, best.candidates)
    } else {
      warnings.push(`Closest source hit only matches ${Math.round(sourceMatch * 100)}% - keeping the ${basis === "ai" ? "AI" : "parsed"} reading`)
    }
  } else {
    final = Math.min(input.thresholds.parseOnlyMax / 100, parseScore * 0.85)
    factors.push({
      key: "consensus",
      label: "Source consensus",
      score: 0,
      weight: 0,
      detail: clusters.length
        ? `Only supporting sources had it (${clusters[0].sources.join(", ")}) - they back a reading up but don't confirm it`
        : input.candidates.length
          ? "Sources returned results, but none matched this reading"
          : "No source had this track - common for dubplates and specials",
    })
    warnings.push(`No source confirmation - capped at ${input.thresholds.parseOnlyMax}`)
  }

  if (!reading.artists.length) warnings.push("No artist identified")
  if (!reading.title) warnings.push("No title identified")

  // ---- release: release group, then release, then recording ----
  const fingerprintRecordings = new Set((best?.candidates ?? []).filter((c) => c.fingerprint && c.ids?.mbRecordingId).map((c) => c.ids!.mbRecordingId!))
  const release =
    best && basis === "sources"
      ? pickRelease(releasesOf(best.candidates), {
          artists: reading.artists,
          albumTag: input.tags.album,
          // "CD1", "Side A" folders say where the track sits; the album folder is the one above.
          folders: withoutDiscFolders(input.context?.folders ?? []),
          duration: input.duration,
          version: reading.version,
          filename: input.context?.filename ?? "",
          wholeSide: !!input.heuristic?.position?.whole,
          fingerprintRecordings,
          preferOwn: input.context?.preferOwnRelease ?? true,
        })
      : null
  const provenance = provenanceOf(reading, basis, primary.from, best?.rep, best?.candidates ?? [], release, input)
  if (release) {
    reading = { ...reading, album: release.release.title, label: reading.label ?? release.release.label }
    provenance.album = `${sourceName(release.release.source)} (${KIND_LABEL[release.release.kind]})`
  }
  const versionCheck = checkVersion(reading, release, best, clusters, input.heuristic?.position?.whole ? null : input.duration)

  // Every field in its place before it's proposed; what can't be put right waits for a person.
  const checked = checkFields(reading, { names: false })
  reading = checked.fields
  // What the AI said that the file never states was left out when it answered: say so here.
  for (const u of input.ai?.unsupported ?? []) {
    const field = (["version", "year", "label", "riddim", "event"] as const).find((f) => u.startsWith(f)) ?? "version"
    checked.notes.push({ field, fixed: true, message: `The AI's ${u} left out: nothing in the file's name, folder or tags says so` })
  }

  // A version, or a "(Remix)" in a source's title, says what kind of recording this is: it only
  // stands when the file's own name or title says the same, or a hit that matched the audio does.
  // (Similar files the owner approved can lead the AI to give every Asco tune "Dubplate"; a
  // "Dubplates" folder holds a collection, not this recording; the only remix a text search
  // knows isn't this file.)
  if (input.context) {
    const fileSays = input.context.versionSays ?? [input.context.filename, input.tags.title]
    const heard = (best?.candidates ?? []).filter((c) => c.fingerprint).map((c) => c.title)
    if (reading.version && !versionBacked(reading.version, [...fileSays, ...heard])) {
      checked.notes.push({ field: "version", fixed: true, message: `Version "${reading.version}" left out: the file's own name and title don't say so` })
      reading = { ...reading, version: undefined }
    }
    // An audio fingerprint knows the recording itself; a text search only knows the names.
    if (basis === "sources" && !(best?.candidates ?? []).some((c) => c.fingerprint)) {
      const t = withoutUnbackedVersions(reading.title, fileSays)
      if (t.removed.length) {
        checked.notes.push({ field: "title", fixed: true, message: `Took ${t.removed.join(" ")} off the title: a source's title says so, but nothing about the file does` })
        reading = { ...reading, title: t.title }
      }
    }
  }
  const unsure = needsALook(checked.notes)
  for (const n of unsure) warnings.push(n.message)

  const confidence = Math.round(Math.max(0, Math.min(1, final)) * 100)
  let status: Decision["status"]
  if (conflict) status = "conflict"
  else if (confidence >= input.thresholds.autoThreshold && reading.artists.length && reading.title && !unsure.length) status = "matched"
  else if (confidence >= input.thresholds.reviewThreshold) status = "review"
  else status = "unmatched"

  return {
    artists: reading.artists,
    featuring: reading.featuring ?? [],
    relation: reading.relation,
    artist: reading.artists.join(reading.relation === "vs" ? " vs " : " & "),
    title: reading.title,
    version: reading.version,
    year: reading.year,
    album: reading.album,
    label: reading.label,
    riddim: reading.riddim,
    genre: reading.genre,
    confidence,
    status,
    basis,
    factors,
    clusters: clusters.slice(0, 5).map(({ rep: _rep, best: _best, relPrimary: _rp, ...c }) => ({ ...c, relevance: round(c.relevance) })),
    warnings,
    release,
    versionCheck,
    provenance,
    sourceGenres: sourceGenresOf(best?.candidates ?? []),
    ...positionOnAlbum(reading.album, release, basis === "sources" ? (best?.candidates ?? []) : []),
    ...(checked.notes.length ? { checks: checked.notes } : {}),
  }
}

/** Sources by how far their track numbers are trusted: catalogues first, then the stores. */
const POSITION_ORDER = ["musicbrainz", "discogs", "itunes", "spotify"]

/**
 * Where the track sits on the album it's given, as a source lists it: the chosen
 * release's own track number, else a hit on that same album that numbers it. For
 * {position} and the track number when the file says nothing itself.
 */
export function positionOnAlbum(album: string | undefined, release: ReleaseChoice | null, cands: Candidate[]): { position?: Decision["position"] } {
  if (!album) return {}
  const same = (t: string | undefined) => !!t && normTitle(t) === normTitle(album)
  if (release?.release.position && same(release.release.title)) return { position: { ...release.release.position, from: sourceName(release.release.source) } }
  const rank = (s: string) => (POSITION_ORDER.indexOf(s) + 1 || POSITION_ORDER.length + 1)
  const hit = cands.filter((c) => c.position && same(c.album)).sort((a, b) => rank(a.source) - rank(b.source))[0]
  return hit?.position ? { position: { ...hit.position, from: hit.sourceLabel } } : {}
}

const SOURCE_NAMES: Record<string, string> = { musicbrainz: "MusicBrainz", discogs: "Discogs", acoustid: "AcoustID", spotify: "Spotify", itunes: "Apple Music", deezer: "Deezer" }
const sourceName = (id: string) => SOURCE_NAMES[id] ?? (id.startsWith("scraper:") ? id.slice(8) : id)

/** Short genre words written in capitals. */
const GENRE_CAPS: Record<string, string> = { uk: "UK", us: "US", "r&b": "R&B", rnb: "RnB", edm: "EDM", idm: "IDM", dnb: "DnB", ukg: "UKG", vip: "VIP", "2-step": "2-Step", "2 step": "2 Step" }

/** A genre as a tag shows it: MusicBrainz's "deep house" as "Deep House"; a source's own capitals kept. */
export function genreCase(g: string): string {
  if (g !== g.toLowerCase()) return g
  if (GENRE_CAPS[g]) return GENRE_CAPS[g]
  return g.replace(/[a-z0-9&'-]+/g, (w) => GENRE_CAPS[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
}

/**
 * The genre the agreeing sources give most (each source's genres and styles, a
 * MusicBrainz recording's tags most-used first). Not a placeholder like "Other".
 */
export function sourceGenre(cands: Candidate[]): string | undefined {
  const top = sourceGenresOf(cands).find((g) => !isPlaceholder("genre", g))
  return top ? genreCase(top) : undefined
}

/** Genres the agreeing sources gave, most-mentioned first, as they worded them. */
function sourceGenresOf(cands: Candidate[]): string[] {
  const count = new Map<string, { name: string; n: number }>()
  for (const c of cands) {
    const names = c.genres?.length ? c.genres : c.genre ? c.genre.split(/,\s*/) : []
    for (const raw of names) {
      const name = raw.trim()
      if (!name) continue
      const k = name.toLowerCase()
      const e = count.get(k) ?? { name, n: 0 }
      e.n++
      count.set(k, e)
    }
  }
  return [...count.values()].sort((a, b) => b.n - a.n).map((e) => e.name).slice(0, 12)
}

/** Where each field came from: a source, the AI, the filename or the file's own tags. */
function provenanceOf(
  reading: TrackReading,
  basis: Decision["basis"],
  from: Hypothesis["from"],
  rep: Candidate | undefined,
  cluster: Candidate[],
  release: ReleaseChoice | null,
  input: ScoreInput
): Partial<Record<ProvenanceField, string>> {
  const readingFrom = from === "ai" ? `AI (${input.ai?.model ?? "model"})` : from === "tags" ? "the file's tags" : "the filename"
  const out: Partial<Record<ProvenanceField, string>> = {}
  out.artists = basis === "sources" && rep ? rep.sourceLabel : readingFrom
  out.title = out.artists
  if (reading.version) out.version = readingFrom
  const find = (field: "year" | "album" | "label" | "genre") => {
    const v = reading[field]
    if (v === undefined || v === null || v === "") return
    const hit = cluster.find((c) => c[field] === v || (field === "genre" && c.genres?.some((g) => genreCase(g) === v)))
    out[field] = hit ? hit.sourceLabel : readingFrom
  }
  find("year")
  find("album")
  find("label")
  find("genre")
  if (release) out.release = sourceName(release.release.source)
  return out
}

const VERSION_KINDS: [RegExp, VersionCheck["kind"], string][] = [
  [/\b(?:dubplate|special)s?\b/i, "dubplate", "Dubplate or special"],
  [/\bvip\b/i, "vip", "VIP"],
  [/\b(?:live|clash)\b/i, "live", "Live"],
  [/\b(?:remix|refix|rmx|bootleg|flip|re-?edit)\b/i, "remix", "Remix"],
  [/\b(?:edit|radio edit|extended|club mix|instrumental|dub|acapella)\b/i, "edit", "Edit"],
]

/** What kind of recording this is - original, remix, VIP, dubplate… - and whether length and fingerprint back it up. */
function checkVersion(
  reading: TrackReading,
  release: ReleaseChoice | null,
  best: { candidates: Candidate[] } | undefined,
  clusters: { candidates: Candidate[] }[],
  duration: number | null
): VersionCheck {
  let kind: VersionCheck["kind"] = "original"
  let label = "Original"
  const hit = VERSION_KINDS.find(([re]) => re.test(reading.version ?? ""))
  if (hit) [, kind, label] = hit
  else if (release?.release.kind === "dj-mix") [kind, label] = ["dj-mix", "From a DJ mix"]
  else if (release?.release.kind === "compilation" && !release.ownAlternative) [kind, label] = ["compilation", "Only on compilations"]
  else if (release && /with this version on it/.test(release.reason)) [kind, label] = ["exclusive", `This version is on ${release.release.title}`]
  const durations = (best?.candidates ?? []).map((c) => c.duration).filter((d): d is number => !!d)
  const delta = duration && durations.length ? Math.min(...durations.map((d) => Math.abs(d - duration))) : null
  const fpHere = best?.candidates.some((c) => c.fingerprint) ?? false
  const fpElsewhere = clusters.some((cl) => cl !== best && cl.candidates.some((c) => c.fingerprint))
  const r = release?.release
  return {
    kind,
    label,
    official: r ? (r.status ? r.status.toLowerCase() === "official" && r.own !== false : null) : null,
    durationMatch: delta === null ? null : delta <= 3 ? true : delta > 10 ? false : null,
    fingerprintMatch: fpHere ? true : fpElsewhere ? false : null,
  }
}

function primaryOwnConfidence(input: ScoreInput, h: Hypothesis) {
  if (h.from === "ai") return input.ai?.confidence ?? 0.5
  if (h.from === "heuristic") return input.heuristic?.confidence ?? 0.3
  return 0.5
}

function emptyDecision(): Decision {
  return {
    artists: [],
    featuring: [],
    artist: "",
    title: "",
    confidence: 0,
    status: "unmatched",
    basis: "heuristic",
    factors: [],
    clusters: [],
    warnings: [],
  }
}

/** Use the source's spelling for names, but keep what the file tells us about the version. */
function mergeFromSources(reading: TrackReading, rep: Candidate, cluster: Candidate[]): TrackReading {
  const repSplit = rep.artists?.length ? { artists: rep.artists, featuring: [] as string[] } : splitArtists(rep.artist)
  let artists = reading.artists
  if (repSplit.artists.length) {
    // Respell each of our artists using the closest source artist.
    // The source's whole credit is an option too, so a duo credited as one act
    // ("Chaka Demus & Pliers") isn't cut down to its first name.
    const options = [...new Set([rep.artist, ...repSplit.artists])]
    artists = reading.artists.length
      ? reading.artists.map((a) => {
          const hit = options.map((s) => ({ s, sim: similarity(normArtist(a), normArtist(s)) })).sort((x, y) => y.sim - x.sim)[0]
          return hit && hit.sim >= 0.85 ? hit.s : a
        })
      : repSplit.artists
  }
  // Pull "feat." out of the source title into featuring.
  let title = rep.title
  const featuring = [...(reading.featuring ?? [])]
  const feat = title.match(/\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[)\]]/i)
  if (feat) {
    title = collapseSpaces(title.replace(feat[0], " "))
    for (const f of splitArtists(feat[1]).artists) if (!featuring.some((x) => normArtist(x) === normArtist(f))) featuring.push(f)
  }
  for (const f of repSplit.featuring) if (!featuring.some((x) => normArtist(x) === normArtist(f))) featuring.push(f)
  // Keep the file's version if the source title doesn't mention one.
  const version = reading.version && !title.toLowerCase().includes(reading.version.toLowerCase()) ? reading.version : undefined
  const years = cluster.map((c) => c.year).filter((y): y is number => !!y)
  const isRecordingSpecific = /live|dubplate|special|clash/i.test(reading.version ?? "")
  const year = isRecordingSpecific ? (reading.year ?? (years.length ? Math.min(...years) : undefined)) : years.length ? Math.min(...years) : reading.year
  const withMeta = (field: "album" | "label" | "riddim" | "genre") =>
    [...cluster].sort((a, b) => Number(b.source === "discogs" || b.source === "musicbrainz") - Number(a.source === "discogs" || a.source === "musicbrainz")).find((c) => c[field])?.[field]
  return {
    ...reading,
    artists,
    featuring,
    title,
    version,
    year,
    album: reading.album ?? withMeta("album"),
    label: reading.label ?? withMeta("label"),
    riddim: reading.riddim ?? withMeta("riddim"),
    // What the sources call it beats the AI's guess (an AI that knows the artist for jazz isn't a source
    // tagging this tune deep house); the AI's only counts when no source gives one.
    genre: sourceGenre(cluster) ?? reading.genre ?? withMeta("genre"),
  }
}
