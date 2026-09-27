// Musical key notation shared by the server (tags) and the UI.
// Keys are stored in musical notation ("Am", "F#", "Bbm"); Camelot is derived.

const MAJOR = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
const MINOR = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"]
/** Camelot wheel number for each pitch class (index = pitch class of the tonic). */
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]

const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/** Key name for a tonic pitch class (0 = C) and mode. */
export function keyName(pitchClass: number, minor: boolean): string {
  const pc = ((pitchClass % 12) + 12) % 12
  return minor ? MINOR[pc] : MAJOR[pc]
}

/**
 * Read a key written by any tool - "Am", "A minor", "A#m", "Bbmin", Camelot "8A"
 * or Open Key "1m" - and return it in Dubplate's musical notation.
 */
export function parseKey(input: string | null | undefined): string | null {
  const s = (input ?? "").trim()
  if (!s) return null
  const camelot = s.match(/^(1[0-2]|[1-9])\s*([AB])$/i)
  if (camelot) {
    const n = Number(camelot[1])
    const minor = camelot[2].toUpperCase() === "A"
    const pc = (minor ? CAMELOT_MINOR : CAMELOT_MAJOR).indexOf(n)
    return keyName(pc, minor)
  }
  const openKey = s.match(/^(1[0-2]|[1-9])\s*([dm])$/i)
  if (openKey) {
    // Open Key is Camelot shifted by seven: 1d = C (8B), 1m = Am (8A).
    const n = ((Number(openKey[1]) + 6) % 12) + 1
    const minor = openKey[2].toLowerCase() === "m"
    const pc = (minor ? CAMELOT_MINOR : CAMELOT_MAJOR).indexOf(n)
    return keyName(pc, minor)
  }
  const m = s.match(/^([A-G])\s*(#|♯|b|♭)?\s*(m(?:in(?:or)?)?|maj(?:or)?|-)?$/i)
  if (!m) return null
  let pc = PITCH[m[1].toUpperCase()]
  if (m[2] === "#" || m[2] === "♯") pc += 1
  if (m[2] === "b" || m[2] === "♭") pc -= 1
  const mode = (m[3] ?? "").toLowerCase()
  // A lone lowercase "m" after the note means minor; "maj" means major.
  return keyName(pc, mode === "-" || (mode.startsWith("m") && !mode.startsWith("maj")))
}

/** Camelot code ("8A") for a key in musical notation. */
export function toCamelot(key: string | null | undefined): string | null {
  const k = parseKey(key)
  if (!k) return null
  const minor = k.endsWith("m")
  const pc = (minor ? MINOR : MAJOR).indexOf(k)
  return `${(minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[pc]}${minor ? "A" : "B"}`
}

export function formatKey(key: string | null | undefined, notation: "musical" | "camelot"): string | null {
  const k = parseKey(key)
  if (!k) return null
  return notation === "camelot" ? toCamelot(k) : k
}

/** Tempo for display and tags: whole numbers stay whole, off-speed rips keep one decimal. */
export function formatBpm(bpm: number | null | undefined): string | null {
  if (!bpm || !Number.isFinite(bpm)) return null
  const r = Math.round(bpm)
  return Math.abs(bpm - r) < 0.15 ? String(r) : bpm.toFixed(1)
}

/** Every key, majors then minors, in Dubplate's notation. */
export const ALL_KEYS = [...MAJOR, ...MINOR]

/** A key's place on the Camelot wheel: 1-12 and A (minor) or B (major). */
export function camelotOf(key: string | null | undefined): { n: number; letter: "A" | "B" } | null {
  const c = toCamelot(key)
  return c ? { n: Number(c.slice(0, -1)), letter: c.slice(-1) as "A" | "B" } : null
}

export function fromCamelot(n: number, letter: "A" | "B"): string {
  const wrapped = ((((n - 1) % 12) + 12) % 12) + 1
  const minor = letter === "A"
  return keyName((minor ? CAMELOT_MINOR : CAMELOT_MAJOR).indexOf(wrapped), minor)
}

export type MixRelation = "same" | "up" | "down" | "relative" | "boost"

/**
 * Keys that mix with `key` on the Camelot wheel: the same key, one step either
 * way, its relative major/minor, and two steps up for an energy lift.
 */
export function mixingKeys(key: string | null | undefined): { key: string; relation: MixRelation }[] {
  const c = camelotOf(key)
  if (!c) return []
  const other = c.letter === "A" ? "B" : "A"
  return [
    { key: fromCamelot(c.n, c.letter), relation: "same" },
    { key: fromCamelot(c.n + 1, c.letter), relation: "up" },
    { key: fromCamelot(c.n - 1, c.letter), relation: "down" },
    { key: fromCamelot(c.n, other), relation: "relative" },
    { key: fromCamelot(c.n + 2, c.letter), relation: "boost" },
  ]
}

/** Pitch class of the tonic (0 = C) and mode, for software that numbers keys (Traktor). */
export function keyIndex(key: string | null | undefined): { pc: number; minor: boolean } | null {
  const k = parseKey(key)
  if (!k) return null
  const minor = k.endsWith("m")
  return { pc: (minor ? MINOR : MAJOR).indexOf(k), minor }
}
