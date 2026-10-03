// Text from websites can carry HTML: a link round an artist's name, "&amp;"
// for "&". Every field a source, the AI or a person fills in goes through
// here, so none of it reaches the editor, a tag or a filename.

import type { Candidate, FinalMeta } from "../../shared/types"
import { collapseSpaces } from "./normalize"

/** Tags that sit inside a line of text: taken out without a gap ("Linval <b>Thompson</b>"). */
const INLINE = "a|abbr|b|big|cite|code|del|em|font|i|ins|mark|nobr|q|s|small|span|strike|strong|sub|sup|time|tt|u|wbr"
/** Tags that break text up: taken out leaving a space ("<td>A</td><td>B</td>" → "A B"). */
const BLOCK = "article|aside|blockquote|body|br|center|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|head|header|hr|html|img|label|li|nav|ol|p|picture|pre|section|source|table|tbody|td|tfoot|th|thead|tr|ul"
const attrs = `(?:[^<>"']|"[^"]*"|'[^']*')*`
const INLINE_TAG = new RegExp(`<\\/?(?:${INLINE})(?=[\\s/>])${attrs}\\/?>`, "gi")
const BLOCK_TAG = new RegExp(`<\\/?(?:${BLOCK})(?=[\\s/>])${attrs}\\/?>`, "gi")
const HIDDEN = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const COMMENT = /<!--[\s\S]*?-->/g

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  times: "×",
  deg: "°",
  copy: "©",
  reg: "®",
  trade: "™",
  aacute: "á",
  agrave: "à",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  iacute: "í",
  igrave: "ì",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  oacute: "ó",
  ograve: "ò",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  uacute: "ú",
  ugrave: "ù",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  szlig: "ß",
  Aacute: "Á",
  Eacute: "É",
  Oacute: "Ó",
  Uacute: "Ú",
  Ntilde: "Ñ",
  Ouml: "Ö",
  Uuml: "Ü",
}
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,8}));/g

function decode(s: string): string {
  return s.replace(ENTITY, (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return NAMED[name] ?? NAMED[name.toLowerCase()] ?? m
    const code = dec ? Number(dec) : parseInt(hex!, 16)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m
  })
}

const strip = (s: string) => s.replace(COMMENT, "").replace(HIDDEN, " ").replace(BLOCK_TAG, " ").replace(INLINE_TAG, "")

/** The text a person would read: HTML tags taken out and entities ("&amp;", "&#8211;") turned back into characters. */
export function plainText(s: string): string {
  if (!/[<&]/.test(s)) return s
  // Stripped again after decoding, for markup that was escaped once ("&lt;a href=…&gt;").
  const out = strip(decode(strip(s)))
  return out === s ? s : collapseSpaces(out)
}

/** Any markup in a text, for checking without changing anything. */
export function hasMarkup(s: string | undefined | null): boolean {
  return !!s && /[<&]/.test(s) && plainText(s) !== collapseSpaces(s)
}

const TEXT_FIELDS = ["artist", "title", "album", "label", "riddim", "genre", "country"] as const

/** A source's hit with plain text in every field a person sees or a tag gets. */
export function cleanCandidate(c: Candidate): Candidate {
  let out: Candidate | null = null
  const set = <K extends keyof Candidate>(k: K, v: Candidate[K]) => {
    out ??= { ...c }
    out[k] = v
  }
  for (const k of TEXT_FIELDS) {
    const v = c[k]
    if (typeof v === "string" && /[<&]/.test(v)) {
      const clean = plainText(v)
      if (clean !== v) set(k, clean)
    }
  }
  const list = (xs: string[] | undefined) => (xs?.some((x) => /[<&]/.test(x)) ? xs.map(plainText).filter(Boolean) : xs)
  if (list(c.artists) !== c.artists) set("artists", list(c.artists))
  if (list(c.genres) !== c.genres) set("genres", list(c.genres))
  if (c.releases?.some((r) => /[<&]/.test(r.title))) set("releases", c.releases.map((r) => ({ ...r, title: plainText(r.title) })))
  return out ?? c
}

/** The same for what a track will be tagged with. */
export function cleanFinal(f: FinalMeta): FinalMeta {
  const t = (v: string | undefined) => (v === undefined ? v : plainText(v) || undefined)
  return {
    ...f,
    artists: f.artists.map(plainText).filter(Boolean),
    featuring: f.featuring.map(plainText).filter(Boolean),
    title: plainText(f.title),
    version: t(f.version),
    album: t(f.album),
    label: t(f.label),
    riddim: t(f.riddim),
    genre: t(f.genre),
  }
}
