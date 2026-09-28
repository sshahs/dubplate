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
    .replace(/[_/]+/g, " ")
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

function ruleApplies(rule: GenreRule, region: string | null): boolean {
  if (!rule.regions?.length) return true
  if (region) return rule.regions.includes(region)
  return rule.regions.includes("?")
}

/** The best rule for one genre term, or null. */
export function ruleFor(term: string, rules: GenreRule[], region: string | null): GenreRule | null {
  let best: { rule: GenreRule; score: number; order: number } | null = null
  rules.forEach((rule, order) => {
    if (!ruleApplies(rule, region)) return
    // A term that is the canonical name itself counts as its best match.
    const score = Math.max(norm(term) === norm(rule.genre) ? 2000 : 0, ...rule.match.map((w) => matchStrength(term, w)))
    if (score > 0 && (!best || score > best.score || (score === best.score && order < best.order))) best = { rule, score, order }
  })
  return (best as { rule: GenreRule } | null)?.rule ?? null
}

/**
 * The one canonical genre for a track, or null (switched off, or nothing in
 * the list fits - it then needs a person to pick one). Your own choice wins,
 * then what the agreeing sources say, then the AI, then the file's own tag.
 */
export function canonicalGenre(t: Pick<Track, "final" | "ai" | "tags" | "escalation">, d: Decision | null, settings: Settings): CanonicalGenre | null {
  const cg = settings.canonicalGenres
  if (!cg.enabled || !cg.rules.length) return null
  const region = regionOf(t, d)
  const exact = (g: string | undefined) => (g ? cg.rules.find((r) => norm(r.genre) === norm(g)) : undefined)
  const mine = exact(t.final?.genre)
  if (mine) return { genre: mine.genre, region: mine.region, from: "your choice" }
  const inputs: [string[], string][] = [
    [d?.sourceGenres ?? [], "the sources"],
    [[t.escalation?.ai.genre, t.ai?.genre].filter((g): g is string => !!g), "the AI"],
    [t.tags.genre ?? [], "the file's tag"],
  ]
  for (const [terms, from] of inputs) {
    // Across one input, the most specific match wins (a source saying "UK garage" over another saying "electronic").
    let best: { rule: GenreRule; term: string } | null = null
    let bestScore = 0
    for (const term of terms) {
      const rule = ruleFor(term, cg.rules, region)
      if (!rule) continue
      const score = Math.max(norm(term) === norm(rule.genre) ? 2000 : 0, ...rule.match.map((w) => matchStrength(term, w)))
      if (score > bestScore) {
        best = { rule, term }
        bestScore = score
      }
    }
    if (best) return { genre: best.rule.genre, region: best.rule.region, from: `${from} ("${best.term}"${region ? `, ${region}` : ""})` }
  }
  return null
}
