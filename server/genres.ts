// Canonical genres: every track gets exactly one genre from your own list,
// decided by rules (region plus style) rather than by whatever a source or
// the AI called it on the day. The rules live in Settings and can be saved and
// loaded as a file, so a borderline case like UK drill is decided once. Source
// genres are kept in the database; only the canonical one is written to files.

import type { CanonicalGenre, Decision, GenreRule, Settings, Track } from "../shared/types"
import { stripDiacritics } from "./core/normalize"

/** Country codes and names → the region a rule talks about. */
const REGION_OF: Record<string, string> = {
  GB: "UK",
  UK: "UK",
  "UNITED KINGDOM": "UK",
  ENGLAND: "UK",
  SCOTLAND: "UK",
  WALES: "UK",
  US: "US",
  USA: "US",
  "UNITED STATES": "US",
  JM: "JM",
  JAMAICA: "JM",
}

export function regionOfCountry(country: string | undefined | null): string | null {
  if (!country) return null
  const k = country.trim().toUpperCase()
  return REGION_OF[k] ?? (/^[A-Z]{2}$/.test(k) ? k : null)
}

/**
 * Where the music's from: what the AI knows of the artist, else what most of
 * the agreeing sources say about the release. Null when nobody says.
 */
export function regionOf(t: Pick<Track, "ai">, d: Decision | null): string | null {
  const ai = regionOfCountry(t.ai?.country)
  if (ai) return ai
  const votes = new Map<string, number>()
  for (const c of d?.clusters[0]?.candidates ?? []) {
    const r = regionOfCountry(c.country)
    if (r) votes.set(r, (votes.get(r) ?? 0) + 1)
  }
  for (const r of d?.release ? [regionOfCountry(d.release.release.country)] : []) if (r) votes.set(r, (votes.get(r) ?? 0) + 2)
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

const norm = (s: string) =>
  stripDiacritics(s)
    .toLowerCase()
    .replace(/[_/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

/** How specifically `term` (a genre as some source put it) matches a rule's word: 0 = not at all. */
function matchStrength(term: string, word: string): number {
  const t = norm(term)
  const w = norm(word)
  if (!t || !w) return 0
  if (t === w) return 1000 + w.length
  // "uk grime" matches the rule word "grime", "grime revival" matches "grime" - as whole words.
  const re = new RegExp(`(?:^|[^a-z0-9&])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9&])`)
  return re.test(t) ? w.length : 0
}

/** Genre words that say where the music's from: "UK drill", "British hip hop", "US rap". */
const REGION_WORDS: [string, RegExp][] = [
  ["UK", /\b(?:uk|british|english|london|brit)\b/],
  ["US", /\b(?:us|usa|american|east coast|west coast|dirty south|chicago|atlanta|brooklyn|new york|nyc|detroit|memphis|houston)\b/],
  ["JM", /\b(?:jamaican|jamaica)\b/],
]

/** The region a genre word names itself, or null. */
export function regionInTerm(term: string): string | null {
  const t = norm(term)
  return REGION_WORDS.find(([, re]) => re.test(t))?.[0] ?? null
}

function ruleApplies(rule: GenreRule, region: string | null): boolean {
  if (!rule.regions?.length) return true
  if (region) return rule.regions.includes(region)
  return rule.regions.includes("?")
}

/** How well one genre term fits one rule (0 = not at all, or it's excluded). */
function scoreFor(term: string, rule: GenreRule): number {
  if (rule.exclude?.some((x) => matchStrength(term, x) > 0)) return 0
  // The canonical name (or its folder's) only counts when it's the whole term, like any exact word, so on
  // a tie the rule higher up wins: "Hip Hop" from a UK artist still lands on UK Rap before the Hip-Hop folder.
  const named = [rule.genre, rule.folder ?? ""].map((w) => matchStrength(term, w)).filter((x) => x >= 1000)
  return Math.max(0, ...named, ...rule.match.map((w) => matchStrength(term, w)))
}

/** The best rule for one genre term, and how well it fits. A term naming a region ("UK drill") counts as that region. */
function bestRule(term: string, rules: GenreRule[], region: string | null): { rule: GenreRule; score: number } | null {
  const where = regionInTerm(term) ?? region
  let best: { rule: GenreRule; score: number } | null = null
  for (const rule of rules) {
    if (!ruleApplies(rule, where)) continue
    const score = scoreFor(term, rule)
    // On a tie, the rule higher up the list wins.
    if (score > 0 && (!best || score > best.score)) best = { rule, score }
  }
  return best
}

/** The best rule for one genre term, or null. */
export function ruleFor(term: string, rules: GenreRule[], region: string | null): GenreRule | null {
  return bestRule(term, rules, region)?.rule ?? null
}

/** A rule whose title words appear in the track's title, version or album (a series like Daily Duppy, or instrumentals). */
function titleRule(texts: string[], rules: GenreRule[], region: string | null): { rule: GenreRule; word: string } | null {
  let best: { rule: GenreRule; word: string; score: number } | null = null
  for (const rule of rules) {
    if (!rule.titles?.length || !ruleApplies(rule, region)) continue
    for (const word of rule.titles) {
      const score = Math.max(0, ...texts.map((x) => matchStrength(x, word)))
      if (score > 0 && (!best || score > best.score)) best = { rule, word, score }
    }
  }
  return best
}

const canonicalOf = (rule: GenreRule, from: string): CanonicalGenre => ({ genre: rule.genre, folder: rule.folder || rule.genre, region: rule.region, from })

/**
 * The one canonical genre for a track, or null (switched off, or nothing in
 * the list fits - it then needs a person to pick one). Your own choice wins,
 * then a series or kind named in the title (Daily Duppy, instrumentals), then
 * what the agreeing sources say, then the AI, then the file's own tag.
 */
export function canonicalGenre(t: Pick<Track, "final" | "ai" | "tags" | "escalation"> & { filename?: string }, d: Decision | null, settings: Settings): CanonicalGenre | null {
  const cg = settings.canonicalGenres
  if (!cg.enabled || !cg.rules.length) return null
  const region = regionOf(t, d)
  const exact = (g: string | undefined) => (g ? cg.rules.find((r) => norm(r.genre) === norm(g) || (!!r.folder && norm(r.folder) === norm(g))) : undefined)
  const mine = exact(t.final?.genre)
  if (mine) return canonicalOf(mine, "your choice")
  const ai = t.escalation?.ai ?? t.ai
  const texts = [t.final?.title, t.final?.version, t.final?.album, d?.title, d?.version, d?.album, ai?.title, ai?.version, ai?.album, ai?.event, t.tags.title, t.tags.album, t.filename?.replace(/\.\w+$/, "")].filter(
    (x): x is string => !!x
  )
  const titled = titleRule(texts, cg.rules, region)
  if (titled) return canonicalOf(titled.rule, `the title ("${titled.word}")`)
  const inputs: [string[], string][] = [
    [d?.sourceGenres ?? [], "the sources"],
    [[t.escalation?.ai.genre, t.ai?.genre].filter((g): g is string => !!g), "the AI"],
    [t.tags.genre ?? [], "the file's tag"],
  ]
  for (const [terms, from] of inputs) {
    // Across one input, the rule most of its genres point to wins ("deep house" and "garage house" make it
    // House, whatever one "drum and bass" tag says); on a tie, the most specific match (a source saying
    // "UK garage" over another saying "house"), then the rule higher up the list.
    const votes = new Map<GenreRule, { rule: GenreRule; term: string; score: number; votes: number }>()
    for (const term of terms) {
      const hit = bestRule(term, cg.rules, region)
      if (!hit) continue
      const v = votes.get(hit.rule)
      if (!v) votes.set(hit.rule, { ...hit, term, votes: 1 })
      else {
        v.votes++
        if (hit.score > v.score) Object.assign(v, { score: hit.score, term })
      }
    }
    const order = (r: GenreRule) => cg.rules.indexOf(r)
    const best = [...votes.values()].sort((a, b) => b.votes - a.votes || b.score - a.score || order(a.rule) - order(b.rule))[0]
    if (best) {
      const where = regionInTerm(best.term) ?? region
      return canonicalOf(best.rule, `${from} ("${best.term}"${where ? `, ${where}` : ""})`)
    }
  }
  return null
}
