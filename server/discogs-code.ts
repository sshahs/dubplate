// "Enter a Discogs code": for records no search finds (white labels, old
// jungle and drum & bass 12"s, promos), a person who's found the record on
// Discogs gives its code - [r1234567], a release or master link, or a
// catalogue number - and Dubplate reads that release in full: its title,
// artists, label, year, format and whole tracklist. Each chosen file is
// matched to its track on the release and the release is pinned to it, so it
// wins over whatever the searches found, now and on every re-run.

import type { Candidate, DiscogsLookup, DiscogsReleaseView, DiscogsTrackRow, Settings, Track } from "../shared/types"
import { releasePosition } from "./core/discs"
import { titleSimilarity } from "./core/normalize"
import { decisionToFinal } from "./core/naming"
import { discogsKind } from "./core/releases"
import { checkCandidate, cleanCandidate } from "./core/plain-text"
import { scoreAndSave } from "./pipeline"
import { getTrack, getTracks, updateTrack } from "./repo"
import { discogsDuration, discogsRelease, discogsTracks, joinDiscogsArtists, tracklistCandidate, type DiscogsRelease } from "./sources/catalog"
import { httpJson } from "./sources/http"
import { cleanArtistName } from "./sources/types"

export type DiscogsCode = { kind: "release" | "master"; id: number } | { kind: "catno"; text: string }

/**
 * What a person typed or pasted: "[r1234567]", "r1234567", "1234567", "m98765",
 * a discogs.com release or master link, or failing those a catalogue number ("SUB 001").
 */
export function parseDiscogsCode(input: string): DiscogsCode | null {
  const s = input.trim()
  if (!s) return null
  const link = s.match(/discogs\.com\/(?:[^\s?#]*\/)?(release|master)s?\/(\d+)/i)
  if (link) return { kind: link[1].toLowerCase() as "release" | "master", id: Number(link[2]) }
  const code = s.match(/^\[?\s*([rm])\s*(\d+)\s*\]?$/i)
  if (code) return { kind: code[1].toLowerCase() === "m" ? "master" : "release", id: Number(code[2]) }
  if (/^\d{1,9}$/.test(s)) return { kind: "release", id: Number(s) }
  return s.length >= 2 && s.length <= 60 ? { kind: "catno", text: s } : null
}

const auth = (token?: string): Record<string, string> => (token ? { authorization: `Discogs token=${token}` } : {})

/** Discogs' country names, as MusicBrainz's release countries. */
const COUNTRY: Record<string, string> = {
  uk: "GB", "united kingdom": "GB", england: "GB", scotland: "GB", wales: "GB", us: "US", usa: "US", jamaica: "JM", canada: "CA",
  germany: "DE", france: "FR", netherlands: "NL", belgium: "BE", italy: "IT", spain: "ES", japan: "JP", australia: "AU",
  sweden: "SE", norway: "NO", denmark: "DK", finland: "FI", ireland: "IE", switzerland: "CH", austria: "AT", poland: "PL",
  "new zealand": "NZ", "south africa": "ZA", brazil: "BR", russia: "RU", europe: "XE", worldwide: "XW",
}

export function countryCode(country?: string): string | undefined {
  return country ? COUNTRY[country.trim().toLowerCase()] : undefined
}

/** A Discogs release as the code box shows it. */
export function releaseView(rel: DiscogsRelease): DiscogsReleaseView {
  const releaseArtist = joinDiscogsArtists(rel.artists ?? [])
  const descriptions = (rel.formats ?? []).flatMap((f) => f.descriptions ?? [])
  const names = (rel.formats ?? []).map((f) => f.name)
  const tracks: DiscogsTrackRow[] = discogsTracks(rel).map((t, index) => {
    const artist = t.artists?.length ? joinDiscogsArtists(t.artists) : undefined
    return { index, position: t.position?.trim() ?? "", title: t.title, ...(artist && artist !== releaseArtist ? { artist } : {}), duration: discogsDuration(t.duration) }
  })
  return {
    id: rel.id,
    url: `https://www.discogs.com/release/${rel.id}`,
    title: rel.title,
    artist: releaseArtist,
    year: rel.year || undefined,
    released: rel.released,
    country: rel.country,
    label: rel.labels?.[0]?.name ? cleanArtistName(rel.labels[0].name) : undefined,
    catno: rel.labels?.[0]?.catno && !/^none$/i.test(rel.labels[0].catno) ? rel.labels[0].catno : undefined,
    barcode: rel.identifiers?.find((i) => /barcode/i.test(i.type))?.value.replace(/\s+/g, ""),
    format: (rel.formats ?? []).map((f) => [f.name, ...(f.descriptions ?? [])].join(", ")).join(" + ") || undefined,
    kind: discogsKind(descriptions, names),
    genres: [...(rel.genres ?? []), ...(rel.styles ?? [])],
    artwork: (rel.images?.find((i) => i.type === "primary") ?? rel.images?.[0])?.uri || undefined,
    tracks,
  }
}

/** The release behind a code (a master's main release), or null when Discogs doesn't have it. */
export async function fetchDiscogsRelease(code: DiscogsCode, settings: Settings, signal?: AbortSignal): Promise<DiscogsRelease | null> {
  const token = settings.sources.discogs?.apiKey
  if (code.kind === "catno") return null
  let id = code.id
  if (code.kind === "master") {
    const master = await httpJson<{ main_release?: number }>(`https://api.discogs.com/masters/${code.id}`, { headers: auth(token), signal, ttlMs: 30 * 86400_000 })
    if (!master?.main_release) return null
    id = master.main_release
  }
  return discogsRelease(id, token, signal)
}

interface SearchReply {
  results?: { id: number; title: string; year?: string; label?: string[]; catno?: string; format?: string[]; country?: string; thumb?: string; type?: string }[]
}

/** Look a code up, with each of `tracks` matched to the release's track it looks like. */
export async function lookupDiscogs(input: string, tracks: Track[], settings: Settings, signal?: AbortSignal): Promise<DiscogsLookup> {
  const code = parseDiscogsCode(input)
  if (!code) throw new Error("That doesn't look like a Discogs code - paste the release's link, or its code like [r1234567]")
  if (code.kind === "catno") {
    const token = settings.sources.discogs?.apiKey
    if (!token) throw new Error("Looking up a catalogue number needs your Discogs token (Sources → Discogs). A release link or [r…] code works without one.")
    const ask = (params: Record<string, string>) =>
      httpJson<SearchReply>(`https://api.discogs.com/database/search?${new URLSearchParams({ type: "release", per_page: "12", ...params })}`, { headers: auth(token), signal })
    const byCatno = await ask({ catno: code.text })
    const found = byCatno?.results?.length ? byCatno : await ask({ q: code.text })
    const choices = (found?.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      year: r.year,
      label: r.label?.[0],
      catno: r.catno,
      format: r.format?.join(", "),
      country: r.country,
      thumb: r.thumb || undefined,
    }))
    if (!choices.length) throw new Error(`Discogs has nothing with the catalogue number "${code.text}"`)
    if (choices.length > 1) return { choices }
    return lookupDiscogs(`r${choices[0].id}`, tracks, settings, signal)
  }
  const rel = await fetchDiscogsRelease(code, settings, signal)
  if (!rel) throw new Error(`Discogs doesn't have ${code.kind === "master" ? "master" : "release"} ${code.id}`)
  const release = releaseView(rel)
  const names = new Map(tracks.map((t) => [t.id, t.filename]))
  return { release, matches: matchTracks(release, tracks).map((m) => ({ ...m, filename: names.get(m.trackId) ?? "" })) }
}

/** The title to match a file by: what it was approved or identified as, else what its name or tags say. */
function titleOf(t: Track): string {
  return t.final?.title || t.decision?.title || t.ai?.title || t.heuristic?.title || t.tags.title || t.filename.replace(/\.[^.]+$/, "")
}

/** Where the file says it sits: "A1", "3"… from its name, folders or track tag. */
function ownPosition(t: Track): string | undefined {
  const p = t.heuristic?.position
  if (p?.side && p.number) return `${p.side}${p.number}`
  if (p?.side && !p.number) return p.side
  const n = t.tags.track ?? p?.number
  return n ? String(n) : undefined
}

const samePosition = (a: string | undefined, b: string) => {
  if (!a || !b) return false
  const x = releasePosition(a)
  const y = releasePosition(b)
  return x && y ? x.track === y.track && (x.disc ?? 1) === (y.disc ?? 1) : a.trim().toUpperCase() === b.trim().toUpperCase()
}

/**
 * Each file and the release's track it most looks like: by title first, then by
 * its own position ("A2", track 3), with its length as a tie-breaker. One file per
 * track; a file nothing fits is left for the person to place.
 */
export function matchTracks(release: DiscogsReleaseView, tracks: Track[]): { trackId: number; index: number | null }[] {
  const pairs: { trackId: number; index: number; score: number }[] = []
  for (const t of tracks) {
    const title = titleOf(t)
    const cleaned = t.heuristic?.cleaned ?? ""
    const pos = ownPosition(t)
    for (const row of release.tracks) {
      let score = Math.max(titleSimilarity(row.title, title), cleaned ? titleSimilarity(row.title, cleaned) * 0.9 : 0)
      if (samePosition(pos, row.position)) score += 0.45
      if (t.duration && row.duration) score += Math.abs(t.duration - row.duration) <= 4 ? 0.15 : Math.abs(t.duration - row.duration) > 40 ? -0.15 : 0
      pairs.push({ trackId: t.id, index: row.index, score })
    }
  }
  const out = new Map<number, number | null>(tracks.map((t) => [t.id, null]))
  // A one-track release and one file: that's the one.
  if (tracks.length === 1 && release.tracks.length === 1) out.set(tracks[0].id, 0)
  else {
    const taken = new Set<number>()
    for (const p of pairs.sort((a, b) => b.score - a.score)) {
      if (p.score < 0.55 || out.get(p.trackId) !== null || taken.has(p.index)) continue
      out.set(p.trackId, p.index)
      taken.add(p.index)
    }
  }
  return [...out].map(([trackId, index]) => ({ trackId, index }))
}

/** The candidate a file gets from its track on the release a person named. */
export function pinnedCandidate(rel: DiscogsRelease, index: number): Candidate | null {
  const track = discogsTracks(rel)[index]
  if (!track) return null
  const c = cleanCandidate(tracklistCandidate(rel, track, { source: "discogs", label: "Discogs" }))
  return checkCandidate({ ...c, pinned: true })
}

export interface DiscogsApplied {
  applied: number
  skipped: number
  release: { id: number; title: string }
}

/**
 * Put the release on each file: it becomes the file's pinned hit (replacing any
 * release pinned before), the file is decided again from it and approved with the
 * release's artists, title, album, year and label, and the Discogs release ID is kept
 * for the tags.
 */
export async function applyDiscogsRelease(
  releaseId: number,
  assignments: { trackId: number; index: number | null }[],
  settings: Settings,
  signal?: AbortSignal
): Promise<DiscogsApplied> {
  const rel = await discogsRelease(releaseId, settings.sources.discogs?.apiKey, signal)
  if (!rel) throw new Error(`Discogs doesn't have release ${releaseId}`)
  let applied = 0
  let skipped = 0
  const byId = new Map(getTracks(assignments.map((a) => a.trackId)).map((t) => [t.id, t]))
  for (const a of assignments) {
    const t = byId.get(a.trackId)
    const cand = t && a.index !== null ? pinnedCandidate(rel, a.index) : null
    if (!t || !cand) {
      skipped++
      continue
    }
    const candidates = [cand, ...(t.candidates ?? []).filter((c) => !c.pinned)]
    updateTrack(t.id, { candidates, idsOverride: { ...(t.idsOverride ?? {}), discogsReleaseId: String(rel.id) } })
    const scored = scoreAndSave(getTrack(t.id)!, settings)
    if (scored.decision?.title && scored.decision.artists.length) {
      const final = decisionToFinal(scored.decision)
      // The file's own version (a dubplate, a VIP) stays when the release's title doesn't say otherwise.
      if (!final.version && t.final?.version && !new RegExp(t.final.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(final.title)) final.version = t.final.version
      if (!final.riddim && t.final?.riddim) final.riddim = t.final.riddim
      updateTrack(t.id, { final, status: "approved", approvedBy: "person" })
      scoreAndSave(getTrack(t.id)!, settings)
    }
    applied++
  }
  return { applied, skipped, release: { id: rel.id, title: rel.title } }
}
