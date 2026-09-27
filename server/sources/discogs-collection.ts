// Your own Discogs collection as a source. The collection is synced into the
// database (a page of 100 releases a second); when a track's artist or title
// matches a record you own, that release's tracklist is checked, and a hit is
// trusted highly - you have the record, so it's very likely what you ripped.

import type { Candidate, Settings } from "../../shared/types"
import { normArtist, normTitle } from "../core/normalize"
import { getDb, parseJson, tx } from "../db"
import type { JobContext } from "../jobs"
import { discogsRelease, releaseCandidate } from "./catalog"
import { httpJson } from "./http"
import { cleanArtistName, type SourceAdapter } from "./types"

export const COLLECTION_SOURCE = "discogs-collection" as const

interface CollectionPage {
  pagination?: { page: number; pages: number; items: number }
  releases?: {
    id: number
    date_added?: string
    basic_information?: {
      id: number
      title: string
      year?: number
      artists?: { name: string }[]
      labels?: { name: string; catno?: string }[]
      formats?: { name: string; descriptions?: string[] }[]
    }
  }[]
}

export interface CollectionStatus {
  username: string | null
  count: number
  syncedAt: string | null
}

export function collectionStatus(): CollectionStatus {
  const db = getDb()
  const meta = parseJson<{ username?: string; syncedAt?: string } | null>(
    (db.prepare("SELECT value_json FROM settings WHERE key = 'discogs_collection'").get() as { value_json: string } | undefined)?.value_json,
    null
  )
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM discogs_collection").get() as { n: number }
  return { username: meta?.username ?? null, count: n, syncedAt: meta?.syncedAt ?? null }
}

const auth = (token: string) => ({ authorization: `Discogs token=${token}` })

/** Fetch the whole collection and replace the stored copy (only once every page has arrived). */
export async function syncCollection(settings: Settings, ctx: JobContext) {
  const token = settings.sources.discogs?.apiKey
  if (!token) throw new Error("Add your Discogs personal access token (Sources → Discogs) first")
  const me = await httpJson<{ username?: string }>("https://api.discogs.com/oauth/identity", { headers: auth(token), ttlMs: 0, signal: ctx.signal })
  if (!me?.username) throw new Error("Discogs didn't recognise that token")
  const rows: { id: number; artist: string; artistsKey: string; title: string; titleKey: string; year: number | null; label: string | null; catno: string | null; format: string | null; added: string | null }[] = []
  let page = 1
  let pages = 1
  do {
    if (ctx.signal.aborted) return
    const url = `https://api.discogs.com/users/${encodeURIComponent(me.username)}/collection/folders/0/releases?per_page=100&page=${page}&sort=added&sort_order=desc`
    const j = await httpJson<CollectionPage>(url, { headers: auth(token), ttlMs: 0, signal: ctx.signal })
    pages = j?.pagination?.pages ?? 1
    if (page === 1) ctx.setTotal(j?.pagination?.items ?? 0)
    for (const r of j?.releases ?? []) {
      const b = r.basic_information
      if (!b) continue
      const names = (b.artists ?? []).map((a) => cleanArtistName(a.name))
      rows.push({
        id: b.id ?? r.id,
        artist: names.join(" / "),
        artistsKey: `|${names.map((a) => normArtist(a)).join("|")}|`,
        title: b.title,
        titleKey: normTitle(b.title),
        year: b.year || null,
        label: b.labels?.[0]?.name ?? null,
        catno: b.labels?.[0]?.catno ?? null,
        format: b.formats?.map((f) => [f.name, ...(f.descriptions ?? [])].join(" ")).join(", ") || null,
        added: r.date_added ?? null,
      })
      ctx.tick(true)
    }
    ctx.message(`Page ${page} of ${pages}`)
    page++
  } while (page <= pages)
  const db = getDb()
  tx(db, () => {
    db.prepare("DELETE FROM discogs_collection").run()
    const ins = db.prepare(
      "INSERT OR REPLACE INTO discogs_collection (release_id, artist, artists_key, title, title_key, year, label, catno, format, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    for (const r of rows) ins.run(r.id, r.artist, r.artistsKey, r.title, r.titleKey, r.year, r.label, r.catno, r.format, r.added)
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('discogs_collection', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(
      JSON.stringify({ username: me.username, syncedAt: new Date().toISOString() })
    )
  })
  ctx.log("success", `Synced ${rows.length} release${rows.length === 1 ? "" : "s"} from ${me.username}'s Discogs collection`)
}

/** Owned releases by one of these artists, or titled like the track (a 7" is named after its A-side). */
export function ownedReleases(artists: string[], title: string, limit = 6): number[] {
  const where: string[] = []
  const params: string[] = []
  for (const a of artists.slice(0, 3)) {
    const k = normArtist(a)
    if (!k) continue
    where.push("artists_key LIKE ?")
    params.push(`%|${k.replace(/[%_]/g, "")}|%`)
  }
  const t = normTitle(title)
  if (t.length > 2) {
    where.push("title_key = ?")
    params.push(t)
  }
  if (!where.length) return []
  const rows = getDb()
    .prepare(`SELECT release_id FROM discogs_collection WHERE ${where.join(" OR ")} ORDER BY (title_key = ?) DESC, added_at DESC LIMIT ?`)
    .all(...params, t, limit) as { release_id: number }[]
  return rows.map((r) => r.release_id)
}

export const discogsCollection: SourceAdapter = {
  id: COLLECTION_SOURCE,
  label: "Your Discogs collection",
  unavailable: ({ settings }) => {
    if (!settings.sources.discogs?.apiKey) return "needs the Discogs token"
    return collectionStatus().count ? null : "needs syncing first"
  },
  async search(q, { settings, signal }) {
    if (!q.title || q.descriptiveTitle) return []
    const token = settings.sources.discogs?.apiKey
    if (!token) return []
    const out: Candidate[] = []
    for (const id of ownedReleases(q.artists, q.title).slice(0, 4)) {
      const rel = await discogsRelease(id, token, signal)
      const hit = rel && releaseCandidate(rel, q.title, { source: COLLECTION_SOURCE, label: "Your Discogs collection", minSimilarity: 0.6 })
      if (hit) out.push({ ...hit, sourceScore: 1 })
    }
    return out
  },
}
