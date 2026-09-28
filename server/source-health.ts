// Scraper health: a site that redesigns, puts search behind a login or starts
// answering with its home page keeps "working" - it just returns junk like
// "Login" or "Home" as tracks. Five bad answers in a row (junk or errors)
// switch the scraper off, with the reason shown in Sources and on Health.

import type { Candidate, SourceHealth } from "../shared/types"
import { getDb } from "./db"
import { log } from "./jobs"
import { loadSettings, saveSettings } from "./settings"

/** Bad answers in a row before a scraper is switched off. */
export const BAD_LIMIT = 5

const JUNK = /^(?:log ?in|log ?on|sign ?in|sign ?up|register|home|home ?page|my account|account|menu|search|search results?|cookies?|cookie (?:policy|settings)|privacy(?: policy)?|terms(?: of use)?|contact(?: us)?|404|page not found|not found|access denied|forbidden|subscribe|skip to (?:main )?content)$/i

/** Why these results look like a page that isn't a search result, or null when they look fine. */
export function junkResults(hits: Candidate[]): string | null {
  if (!hits.length) return null
  const junk = hits.filter((c) => JUNK.test(c.title.trim()) || JUNK.test(c.artist.trim()))
  if (junk.length * 2 < hits.length) return null
  const words = [...new Set(junk.map((c) => (JUNK.test(c.title.trim()) ? c.title.trim() : c.artist.trim())))].slice(0, 3)
  return `it returned "${words.join('", "')}" instead of tracks`
}

type Row = { source_id: string; bad_in_a_row: number; last_bad: string | null; last_ok_at: string | null; disabled_at: string | null }

function toHealth(r: Row): SourceHealth {
  return { sourceId: r.source_id, badInARow: r.bad_in_a_row, lastBad: r.last_bad, lastOkAt: r.last_ok_at, disabledAt: r.disabled_at }
}

export function sourceHealth(): SourceHealth[] {
  return (getDb().prepare("SELECT * FROM source_health ORDER BY source_id").all() as Row[]).map(toHealth)
}

/**
 * Note how a scraper answered. `bad` is a reason (junk results or an error), or
 * null for a good answer; empty answers don't count either way. Returns the
 * reason when this answer tipped it over and it's been switched off.
 */
export function recordScraperAnswer(sourceId: string, bad: string | null, hits: Candidate[]): string | null {
  const db = getDb()
  if (!bad) {
    if (!hits.length) return null
    db.prepare(
      "INSERT INTO source_health (source_id, bad_in_a_row, last_ok_at) VALUES (?, 0, datetime('now')) ON CONFLICT(source_id) DO UPDATE SET bad_in_a_row = 0, last_ok_at = datetime('now')"
    ).run(sourceId)
    return null
  }
  // Switched back on by hand since it was switched off: count afresh.
  const prev = db.prepare("SELECT disabled_at FROM source_health WHERE source_id = ?").get(sourceId) as { disabled_at: string | null } | undefined
  if (prev?.disabled_at) db.prepare("DELETE FROM source_health WHERE source_id = ?").run(sourceId)
  const r = db
    .prepare(
      "INSERT INTO source_health (source_id, bad_in_a_row, last_bad) VALUES (?, 1, ?) ON CONFLICT(source_id) DO UPDATE SET bad_in_a_row = bad_in_a_row + 1, last_bad = excluded.last_bad RETURNING bad_in_a_row"
    )
    .get(sourceId, bad) as { bad_in_a_row: number }
  if (r.bad_in_a_row < BAD_LIMIT) return null
  const id = sourceId.replace(/^scraper:/, "")
  const s = loadSettings()
  const def = s.scrapers.find((x) => x.id === id)
  if (!def?.enabled) return null
  const reason = `Switched off by the health check: ${bad} (${r.bad_in_a_row} times in a row)`
  saveSettings({ scrapers: s.scrapers.map((x) => (x.id === id ? { ...x, enabled: false, disabledReason: reason } : x)) })
  db.prepare("UPDATE source_health SET disabled_at = datetime('now') WHERE source_id = ?").run(sourceId)
  log("error", `${def.name}: ${reason}. Test it in Sources and switch it back on once it works.`)
  return reason
}

/** Switched back on by hand: start counting afresh. */
export function resetSourceHealth(sourceId: string) {
  getDb().prepare("DELETE FROM source_health WHERE source_id = ?").run(sourceId)
}
