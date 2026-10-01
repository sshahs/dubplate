// Discs and sides: CD1/CD2, Disc 2, LP2, Side A/B and vinyl positions like A1
// or B2. Read from a file's name and its folders, so a track knows where it
// sits on its record - and a folder called "CD1" or "Side A" is never taken
// for an album or an artist. Pure, so the web app can use it too.

import type { DiscPosition } from "../../shared/types"

const SIDES = "ABCDEFGH"
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }

/** The record a side is on: A and B are the first, C and D the second… */
export function sideToDisc(side: string): number {
  return Math.floor(SIDES.indexOf(side.toUpperCase()) / 2) + 1
}

/** Where a side comes on its record: A, C, E… first; B, D, F… second. */
export function sideOnDisc(side: string): number {
  return (SIDES.indexOf(side.toUpperCase()) % 2) + 1
}

/** "A".."H", from a letter or a cassette's "Side 1", "Side 2". */
function sideLetter(s: string): string {
  return /^\d$/.test(s) ? SIDES[Number(s) - 1] : s.toUpperCase()
}

const num = (s: string) => WORDS[s.toLowerCase()] ?? Number(s)

/** "CD1", "CD 2", "Disc 2", "Disk2", "Disc 2 - Bonus", "CD 1 of 2", "LP2", "Record 2", "Vinyl 1", "Tape 2", "Disc One" */
const DISC = /^(cd|dis[ck]|lp|record|vinyl|tape|cassette)[\s._-]*(\d{1,2}|one|two|three|four|five|six)(?:\s*(?:of|\/)\s*\d{1,2})?(?:\s*[-–:]\s*.+)?$/i
/** "Side A", "A Side", "A-Side", "Side 1" (a tape), "Seite B", "Face A" */
const SIDE = /^(?:(?:side|seite|face|kant)[\s._-]*([a-h]|[1-8])|([a-h])[\s._-]*side)$/i

function discLabel(word: string, n: number): string {
  const w = word.toLowerCase()
  return w === "cd" ? `CD${n}` : w === "lp" ? `LP${n}` : w === "record" ? `Record ${n}` : w === "vinyl" ? `Vinyl ${n}` : w === "tape" || w === "cassette" ? `Tape ${n}` : `Disc ${n}`
}

/** A folder (or a whole file's name) that's just a disc or a side: its position, else null. */
export function discMarker(name: string): DiscPosition | null {
  const t = name.trim()
  const d = t.match(DISC)
  if (d) {
    const n = num(d[2])
    return n > 0 ? { disc: n, label: discLabel(d[1], n) } : null
  }
  const s = t.match(SIDE)
  if (s) {
    const side = sideLetter(s[1] ?? s[2])
    return { disc: sideToDisc(side), side, label: `Side ${side}` }
  }
  return null
}

export const isDiscFolder = (name: string) => !!discMarker(name)

/** Folders that aren't just a disc or a side: the ones that can name an album or an artist. */
export function withoutDiscFolders(folders: string[]): string[] {
  return folders.filter((f) => !isDiscFolder(f))
}

/**
 * A disc or side the folders say, nearest first: "Album/CD2" is disc 2,
 * "Album/LP2/Side C" side C of record 2.
 */
export function folderPosition(folders: string[]): DiscPosition | null {
  const markers: DiscPosition[] = []
  for (const f of folders) {
    const m = discMarker(f)
    if (!m) break
    markers.push(m)
  }
  const [near, far] = markers
  if (!near) return null
  // The nearest says most (a side); one further out can still give the record: "LP2/Side A".
  return far && near.side && far.disc && !far.side ? { ...near, disc: far.disc } : near
}

/**
 * A position at the start of a filename: "A1 ", "B2-", "CD1-05 ", "Disc 2 - 03 ",
 * "1-05 " (disc 1, track 5), or a plain "05 ". `track` is what it said ("A1", "05").
 */
export function leadingPosition(s: string): { rest: string; track: string; position: DiscPosition } | null {
  const sep = String.raw`(?:\s*[-.)_]\s*|\s+)(?=\S)`
  let m = s.match(new RegExp(String.raw`^(cd|dis[ck])\s?(\d{1,2})\s?[-._ ]\s?(\d{1,3})${sep}`, "i"))
  if (m) return { rest: s.slice(m[0].length), track: m[3], position: { disc: Number(m[2]), number: Number(m[3]), label: `${discLabel(m[1], Number(m[2]))} · ${m[3]}` } }
  m = s.match(new RegExp(String.raw`^([1-9])[-.](\d{2})${sep}`))
  if (m) return { rest: s.slice(m[0].length), track: m[2], position: { disc: Number(m[1]), number: Number(m[2]), label: `${m[1]}-${m[2]}` } }
  m = s.match(new RegExp(String.raw`^([a-h])(\d{1,2})${sep}`, "i"))
  if (m) {
    const side = m[1].toUpperCase()
    return { rest: s.slice(m[0].length), track: `${side}${m[2]}`, position: { disc: sideToDisc(side), side, number: Number(m[2]), label: `${side}${Number(m[2])}` } }
  }
  m = s.match(new RegExp(String.raw`^(\d{1,3})${sep}`))
  if (m) return { rest: s.slice(m[0].length), track: m[1], position: { number: Number(m[1]), label: m[1] } }
  return null
}

/**
 * A side or disc named at the end of a name - "Clash 1995 (Side B)", "Fabric
 * 99 CD2", "juggling side b pt2", "(Tape 2 Side A)": the file is that part of a
 * longer recording. Returns the name without it.
 */
export function trailingPart(title: string): { rest: string; position: DiscPosition } | null {
  const tape = String.raw`(?:(tape|cassette|cd|dis[ck]|lp|record)\s*(\d{1,2})\s*[,-]?\s*)?`
  const side = String.raw`(?:(?:side|seite|face)\s*([a-h]|[1-8])|([a-h])[\s-]?side)`
  const disc = String.raw`(cd|dis[ck])\s*(\d{1,2})`
  const part = String.raw`(?:\s*[,-]?\s*(?:pt|part)\.?\s*(\d{1,2}))?`
  const m = title.match(new RegExp(String.raw`^(.*?)[\s([{_-]+(?:${tape}${side}|${disc})${part}\s*[)\]}]?\s*$`, "i"))
  if (!m || !m[1].trim()) return null
  const [, before, tapeWord, tapeNum, sideA, sideB, discWord, discNum, partNum] = m
  const n = partNum ? Number(partNum) : undefined
  const partLabel = n ? ` Part ${n}` : ""
  let position: DiscPosition
  if (sideA || sideB) {
    const letter = sideLetter(sideA ?? sideB)
    const of = tapeWord ? `${discLabel(tapeWord, Number(tapeNum))} ` : ""
    position = { disc: tapeNum ? Number(tapeNum) : sideToDisc(letter), side: letter, label: `${of}Side ${letter}${partLabel}`, whole: true }
  } else {
    position = { disc: Number(discNum), label: `${discLabel(discWord, Number(discNum))}${partLabel}`, whole: true }
  }
  if (n) position.part = n
  return { rest: before.replace(/[\s([{-]+$/, "").trim(), position }
}

/** "Side B · B2", "Disc 2 · track 5", for showing where a track sits. */
export function describePosition(p: DiscPosition | null | undefined, track?: number | null, disc?: number | null, discTotal?: number | null): string | null {
  if (!p && !track && !disc) return null
  if (p?.whole) return p.part ? `Part ${p.part} of ${p.label?.replace(/ Part \d+$/, "") ?? (p.side ? `side ${p.side}` : `disc ${p.disc}`)}` : p.side ? `The whole of side ${p.side}` : `The whole of ${p.label ?? `disc ${p.disc}`}`
  const bits: string[] = []
  const d = disc ?? p?.disc
  if (p?.side) bits.push(`Side ${p.side}${p.disc && p.disc > 1 ? ` of record ${p.disc}` : ""}`, `${p.side}${p.number ?? ""}`)
  else if (d) bits.push(`Disc ${d}${discTotal && discTotal > 1 ? ` of ${discTotal}` : ""}`)
  const n = track ?? (p?.side ? undefined : p?.number)
  if (n) bits.push(`track ${n}`)
  return bits.join(" · ") || null
}

/**
 * The track number on its disc for a vinyl position, counting on across the
 * sides: on a record whose side A has four tracks, B2 is track 6. `siblings`
 * are the positions of the other files from the same record.
 */
export function trackOnDisc(p: DiscPosition, siblings: DiscPosition[]): number | undefined {
  if (!p.number) return undefined
  if (!p.side) return p.number
  const disc = p.disc ?? sideToDisc(p.side)
  let before = 0
  for (const side of SIDES.slice(0, SIDES.indexOf(p.side))) {
    if (sideToDisc(side) !== disc) continue
    const onSide = [p, ...siblings].filter((s) => s.side === side && (s.disc ?? sideToDisc(side)) === disc).map((s) => s.number ?? 0)
    // A side we know nothing about: can't count past it.
    if (!onSide.length) return undefined
    before += Math.max(...onSide)
  }
  return before + p.number
}

/**
 * The disc to show in a name or folder - only for a release on more than one:
 * a disc tag that says so, or a disc the name or folder numbers ("CD1", "1-05",
 * side C). Side A or B alone is just a record, not disc 1 of a set.
 */
export function multiDisc(tags: { disc?: number; discTotal?: number }, p?: DiscPosition | null): number | undefined {
  if (tags.disc && ((tags.discTotal ?? 0) > 1 || tags.disc > 1)) return tags.disc
  if (p?.disc && (p.disc > 1 || !p.side)) return p.disc
  return undefined
}

/** The position for a filename: "A1" on vinyl, else the track number as "05". */
export function positionLabel(tags: { track?: number }, p?: DiscPosition | null): string | undefined {
  if (p?.whole) return p.side ? `Side ${p.side}` : undefined
  if (p?.side && p.number) return `${p.side}${p.number}`
  const n = tags.track ?? p?.number
  return n ? String(n).padStart(2, "0") : undefined
}

/** The values naming templates get for where a track sits: {position}, {track}, {disc}. */
export function placeValues(tags: { track?: number; disc?: number; discTotal?: number }, p?: DiscPosition | null): { position?: string; track?: string; disc?: string } {
  const n = tags.track ?? (p?.side || p?.whole ? undefined : p?.number)
  const d = multiDisc(tags, p)
  return { position: positionLabel(tags, p), track: n ? String(n).padStart(2, "0") : undefined, disc: d ? String(d) : undefined }
}

