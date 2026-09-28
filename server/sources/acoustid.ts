// AcoustID audio fingerprinting via Chromaprint's fpcalc. When it hits,
// it's the strongest signal we have: the audio itself, not the filename.

import { execFile, spawnSync } from "node:child_process"
import type { Candidate } from "../../shared/types"
import { isOwnRelease, mbKind } from "../core/releases"
import { httpJson } from "./http"
import type { SourceAdapter } from "./types"

let fpcalcPath: string | null | undefined

export function findFpcalc(): string | null {
  if (fpcalcPath !== undefined) return fpcalcPath
  const candidates = [process.env.FPCALC_PATH, "fpcalc"].filter(Boolean) as string[]
  for (const c of candidates) {
    const r = spawnSync(c, ["-version"], { encoding: "utf8" })
    if (r.status === 0) return (fpcalcPath = c)
  }
  return (fpcalcPath = null)
}

export interface Fingerprint {
  duration: number
  fingerprint: string
}

/** The file's Chromaprint fingerprint (the first two minutes, as AcoustID expects). */
export function fingerprintFile(file: string, signal?: AbortSignal): Promise<Fingerprint> {
  return new Promise((resolve, reject) => {
    execFile(findFpcalc()!, ["-json", "-length", "120", file], { signal, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      try {
        resolve(JSON.parse(stdout))
      } catch (e) {
        reject(e)
      }
    })
  })
}

interface AcoustIdResult {
  score: number
  recordings?: {
    id: string
    title?: string
    duration?: number
    artists?: { name: string; joinphrase?: string }[]
    releasegroups?: { id?: string; title: string; type?: string; secondarytypes?: string[]; artists?: { name: string }[] }[]
  }[]
}

export const acoustid: SourceAdapter = {
  id: "acoustid",
  label: "AcoustID",
  unavailable: ({ cfg }) => {
    if (!cfg.apiKey) return "needs an application API key"
    if (!findFpcalc()) return "fpcalc (Chromaprint) is not installed"
    return null
  },
  async search(q, { cfg, signal }) {
    return acoustidLookup(await fingerprintFile(q.filePath, signal), cfg.apiKey!, signal)
  },
}

/** Recordings AcoustID knows this fingerprint as (the response is cached for a month). */
export async function acoustidLookup(fp: Fingerprint, apiKey: string, signal?: AbortSignal): Promise<Candidate[]> {
  const body = new URLSearchParams({
    client: apiKey,
    meta: "recordings releasegroups compress",
    duration: String(Math.round(fp.duration)),
    fingerprint: fp.fingerprint,
  }).toString()
  const j = await httpJson<{ status: string; results?: AcoustIdResult[] }>("https://api.acoustid.org/v2/lookup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal,
    ttlMs: 30 * 86400_000,
  })
  const out: Candidate[] = []
  for (const r of j?.results ?? []) {
    if (r.score < 0.5) continue
    for (const rec of r.recordings ?? []) {
      if (!rec.title || !rec.artists?.length) continue
      out.push({
        source: "acoustid",
        sourceLabel: "AcoustID",
        artist: rec.artists.map((a) => a.name + (a.joinphrase ?? "")).join("").trim(),
        artists: rec.artists.map((a) => a.name),
        title: rec.title,
        album: rec.releasegroups?.[0]?.title,
        duration: rec.duration,
        url: `https://musicbrainz.org/recording/${rec.id}`,
        externalId: rec.id,
        ids: { mbRecordingId: rec.id },
        sourceScore: r.score,
        fingerprint: true,
        releases: (rec.releasegroups ?? []).map((g) => ({
          source: "acoustid" as const,
          title: g.title,
          kind: mbKind(g.type, g.secondarytypes ?? []),
          own: g.artists?.length ? isOwnRelease(g.artists.map((a) => a.name), rec.artists!.map((a) => a.name)) : null,
          groupId: g.id,
          typeText: [g.type, ...(g.secondarytypes ?? [])].filter(Boolean).join(" + ") || undefined,
          recordingId: rec.id,
          length: rec.duration,
        })),
      })
    }
  }
  return out.slice(0, 6)
}
