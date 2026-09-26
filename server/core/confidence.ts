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
  TrackReading,
} from "../../shared/types"
import { artistSimilarity, collapseSpaces, normArtist, similarity, splitArtists, titleSimilarity } from "./normalize"

export interface ScoreInput {
  heuristic: HeuristicParse | null
  ai: AiParse | null
  tags: ExistingTags
  candidates: Candidate[]
  duration: number | null
  /** source id → weight (default 0.6) */
  weights: Record<string, number>
  thresholds: { autoThreshold: number; reviewThreshold: number; parseOnlyMax: number }
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
    out.push({ artists: split, title: tags.title, from: "tags", descriptive: false })
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

  const best = clusters[0]
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
    if (input.duration && durations.length) {
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
      detail: input.candidates.length ? "Sources returned results, but none matched this reading" : "No source had this track - common for dubplates and specials",
    })
    warnings.push(`No source confirmation - capped at ${input.thresholds.parseOnlyMax}`)
  }

  if (!reading.artists.length) warnings.push("No artist identified")
  if (!reading.title) warnings.push("No title identified")

  const confidence = Math.round(Math.max(0, Math.min(1, final)) * 100)
  let status: Decision["status"]
  if (conflict) status = "conflict"
  else if (confidence >= input.thresholds.autoThreshold && reading.artists.length && reading.title) status = "matched"
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
    genre: reading.genre,
    confidence,
    status,
    basis,
    factors,
    clusters: clusters.slice(0, 5).map(({ rep: _rep, best: _best, relPrimary: _rp, ...c }) => ({ ...c, relevance: round(c.relevance) })),
    warnings,
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
  const withMeta = (field: "album" | "label" | "genre") =>
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
    genre: reading.genre ?? withMeta("genre"),
  }
}
