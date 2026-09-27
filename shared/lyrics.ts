// Small helpers for lyrics text, shared by the server (tags, .lrc files) and the UI.

import { normArtist, normTitle } from "../server/core/normalize"
import type { FinalMeta } from "./types"

/** What lyrics were looked up for: a different artist, title or version is looked up again. */
export function lyricsKey(meta: Pick<FinalMeta, "artists" | "title" | "version">): string {
  return `${meta.artists.map(normArtist).join("|")}::${normTitle(meta.title)}::${normTitle(meta.version ?? "")}`
}

const TIMESTAMP = /^\s*\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/
/** What lyricsSummary makes, so summarising twice changes nothing. */
const SUMMARY = /^\d+ lines?(, timed)?$/
/** LRC header lines like [ar: …], [ti: …], [length: …]. */
const HEADER = /^\s*\[(ar|ti|al|au|by|re|ve|length|offset|#):[^\]]*\]\s*$/i

/** The text carries LRC timestamps. */
export function isTimed(text: string | undefined | null): boolean {
  return !!text && text.split("\n").some((l) => TIMESTAMP.test(l))
}

/** A timed line: seconds from the start and the words. */
export interface LyricLine {
  at: number | null
  text: string
}

/** Lines to show, with their times when the lyrics are timed (header lines dropped). */
export function lyricLines(text: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (HEADER.test(raw)) continue
    let line = raw
    let at: number | null = null
    // A line can carry several stamps ("[00:12.00][01:30.00] chorus"); the first one places it.
    let m = TIMESTAMP.exec(line)
    while (m) {
      if (at === null) at = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0)
      line = line.slice(m[0].length)
      m = TIMESTAMP.exec(line)
    }
    out.push({ at, text: line.trim() })
  }
  // No blank lines at either end.
  while (out.length && !out[0].text) out.shift()
  while (out.length && !out[out.length - 1].text) out.pop()
  return out
}

/** The words without timestamps. */
export function plainFromTimed(text: string): string {
  return lyricLines(text)
    .map((l) => l.text)
    .join("\n")
}

/**
 * What the database keeps of a file's lyrics tag: enough to know it has some
 * (the words themselves stay in the file, and in the journal when replaced).
 */
export function lyricsSummary(text: string | undefined | null): string | undefined {
  if (!text?.trim()) return undefined
  if (SUMMARY.test(text)) return text
  const lines = lyricLines(text).filter((l) => l.text).length
  return `${lines} line${lines === 1 ? "" : "s"}${isTimed(text) ? ", timed" : ""}`
}
