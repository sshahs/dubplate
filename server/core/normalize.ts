// String normalisation and fuzzy similarity used across the parser,
// confidence engine and source adapters.

const FEAT_RE = /\s*[([]?\b(?:feat\.?|ft\.?|featuring|w\/)\s+[^)\]]*[)\]]?/gi

/** Words we keep in a fixed case when title-casing. */
const FIXED_CASE = new Map(
  [
    "DJ", "MC", "UK", "USA", "VIP", "EP", "LP", "II", "III", "IV", "NYC", "BBC", "UKG", "DnB",
    "OG", "TV", "FM", "HQ", "JA", "KRS-One", "UB40", "A$AP", "JME", "SLK", "NSG", "RSD", "N.E.R.D",
    "D.O.D", "OT", "BBK", "SK", "AJ", "TQD", "BTA", "PJ",
  ].map((w) => [w.toLowerCase(), w])
)
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "de", "di", "for", "in", "inna", "nor", "of", "on", "or", "the", "to", "vs", "vs.", "x", "feat.", "ft."])

export function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "")
}

export function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** Loose key used for matching: lowercase, no accents, no punctuation. */
export function normKey(s: string | undefined | null): string {
  if (!s) return ""
  return collapseSpaces(
    stripDiacritics(s)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/\+/g, " and ")
      .replace(/['’`´]/g, "")
      .replace(/[^a-z0-9$]+/g, " ")
  )
}

/** Normalise an artist string for comparison. */
export function normArtist(s: string | undefined | null): string {
  if (!s) return ""
  let k = normKey(s.replace(FEAT_RE, " "))
  k = k.replace(/^the /, "")
  return k
}

const VERSION_WORDS =
  "original mix|radio edit|radio mix|extended mix|extended|remaster(?:ed)?(?: \\d{4})?|\\d{4} remaster(?:ed)?|album version|single version|explicit|clean|clean version|dirty|mono|stereo|bonus track|official (?:music )?video|official audio|lyric video|lyrics|audio|hq|hd"

/** Normalise a title: drops featuring credits and generic version tags. */
export function normTitle(s: string | undefined | null): string {
  if (!s) return ""
  let t = s.replace(FEAT_RE, " ")
  t = t.replace(new RegExp(`[([](?:${VERSION_WORDS})[)\\]]`, "gi"), " ")
  t = t.replace(new RegExp(`\\s-\\s(?:${VERSION_WORDS})$`, "gi"), " ")
  return normKey(t)
}

/** Title with *all* bracketed parts removed - the bare song name. */
export function bareTitle(s: string | undefined | null): string {
  if (!s) return ""
  return normTitle(s.replace(/[([][^)\]]*[)\]]/g, " "))
}

// ---------- similarity ----------

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0
  if (!a.length || !b.length) return 0
  const matchDist = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatches = new Array<boolean>(a.length).fill(false)
  const bMatches = new Array<boolean>(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchDist)
    const hi = Math.min(i + matchDist + 1, b.length)
    for (let j = lo; j < hi; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue
      aMatches[i] = bMatches[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0
  let t = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue
    while (!bMatches[k]) k++
    if (a[i] !== b[k]) t++
    k++
  }
  const m = matches
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3
  let prefix = 0
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>()
  const str = s.replace(/ /g, "")
  for (let i = 0; i < str.length - 1; i++) {
    const g = str.slice(i, i + 2)
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

export function dice(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0
  if (a.length < 2 || b.length < 2) return 0
  const A = bigrams(a)
  const B = bigrams(b)
  let inter = 0
  let total = 0
  for (const [g, n] of A) {
    inter += Math.min(n, B.get(g) ?? 0)
    total += n
  }
  for (const n of B.values()) total += n
  return (2 * inter) / total
}

/** Token-set ratio: robust to word re-ordering and extra words on one side. */
export function tokenSet(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean))
  const B = new Set(b.split(" ").filter(Boolean))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  const smaller = Math.min(A.size, B.size)
  const larger = Math.max(A.size, B.size)
  // Containment weighted with a mild penalty for extra tokens.
  return (inter / smaller) * 0.8 + (inter / larger) * 0.2
}

/** 0..1 similarity between two already-normalised strings. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const jw = jaroWinkler(a, b)
  const ts = tokenSet(a, b)
  const dc = dice(a, b)
  // Jaro-Winkler over-rewards shared prefixes on short strings.
  const blended = Math.max(ts, dc * 0.95, jw * (Math.min(a.length, b.length) < 6 ? 0.85 : 0.97))
  return Math.min(1, blended)
}

export function titleSimilarity(a: string | undefined, b: string | undefined): number {
  const full = similarity(normTitle(a), normTitle(b))
  const bare = similarity(bareTitle(a), bareTitle(b))
  // Versions like "(Dubplate)" shouldn't sink an otherwise exact match.
  return Math.max(full, bare * 0.96)
}

/** Compare artist lists - the primary artist matters most. */
export function artistSimilarity(a: string[] | string | undefined, b: string[] | string | undefined): number {
  const la = (Array.isArray(a) ? a : a ? splitArtists(a).artists : []).map(normArtist).filter(Boolean)
  const lb = (Array.isArray(b) ? b : b ? splitArtists(b).artists : []).map(normArtist).filter(Boolean)
  if (!la.length || !lb.length) return 0
  const joinedA = la.join(" ")
  const joinedB = lb.join(" ")
  const whole = similarity(joinedA, joinedB)
  // best match per artist in A, averaged - order independent
  let sum = 0
  for (const x of la) sum += Math.max(...lb.map((y) => similarity(x, y)))
  const perArtist = sum / la.length
  let sumB = 0
  for (const y of lb) sumB += Math.max(...la.map((x) => similarity(x, y)))
  const perArtistB = sumB / lb.length
  return Math.max(whole, (perArtist + perArtistB) / 2, Math.max(perArtist, perArtistB) * 0.9)
}

// ---------- artist splitting ----------

const FEAT_SPLIT = /\s+(?:feat\.?|ft\.?|featuring|w\/)\s+/i
const VS_SPLIT = /\s+(?:vs\.?|versus|v\.?|clash)\s+/i
const AND_SPLIT = /\s*(?:,|&|\+|\band\b|\bx\b|\/)\s*/i

export interface SplitArtists {
  artists: string[]
  featuring: string[]
  relation?: "&" | "vs" | "x"
}

/** "A & B feat. C" → { artists: [A, B], featuring: [C] } */
export function splitArtists(input: string, knownArtists?: Set<string>): SplitArtists {
  let s = collapseSpaces(input.replace(/[()[\]]/g, " "))
  const featuring: string[] = []
  const featIdx = s.search(FEAT_SPLIT)
  if (featIdx >= 0) {
    const rest = s.slice(featIdx).replace(FEAT_SPLIT, "")
    s = s.slice(0, featIdx)
    featuring.push(...rest.split(AND_SPLIT).map(collapseSpaces).filter(Boolean))
  }
  if (VS_SPLIT.test(s)) {
    return {
      artists: s.split(VS_SPLIT).map(collapseSpaces).filter(Boolean),
      featuring,
      relation: "vs",
    }
  }
  // Don't break up known names containing "&" (e.g. "Sly & Robbie").
  if (knownArtists?.has(normArtist(s))) return { artists: [collapseSpaces(s)], featuring }
  const hasX = /\s+x\s+/i.test(s)
  const parts = s.split(AND_SPLIT).map(collapseSpaces).filter(Boolean)
  if (parts.length > 1) return { artists: parts, featuring, relation: hasX ? "x" : "&" }
  return { artists: parts.length ? parts : [], featuring }
}

// ---------- casing ----------

function capitalizeWord(w: string, isFirst: boolean): string {
  const m = w.match(/^([^A-Za-z0-9$\u00c0-\u024f]*)(.*?)([^A-Za-z0-9$.\u00c0-\u024f]*)$/)
  if (!m) return w
  const [, pre, core, post] = m
  const lower = core.toLowerCase()
  const fixed = FIXED_CASE.get(lower)
  if (fixed) return pre + fixed + post
  if (!isFirst && !pre && SMALL_WORDS.has(lower)) return pre + lower + post
  const cased = lower
    .replace(/(^|-)([a-z\u00e0-\u00ff])/g, (_, p: string, c: string) => p + c.toUpperCase())
    .replace(/^O'([a-z])/, (_, c: string) => "O'" + c.toUpperCase())
  return pre + cased + post
}

/** Title-case strings that arrive ALL LOWER or ALL UPPER; leave mixed case alone. */
export function smartCase(s: string): string {
  const letters = s.replace(/[^A-Za-z]/g, "")
  if (!letters) return s
  const isLower = letters === letters.toLowerCase()
  const isUpper = letters === letters.toUpperCase() && letters.length > 3
  if (!isLower && !isUpper) return s
  return s
    .split(" ")
    .map((w, i) => capitalizeWord(w, i === 0))
    .join(" ")
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}
