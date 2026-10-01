// Folder templates: where a track lives inside its library.
// "{artist}/[{year} - ]{album}" → "Chronixx/2014 - Dread & Terrible"
// "/" starts a new folder level; anything in [ ] only appears when every tag
// inside it has a value. Pure, so the web app can preview templates too.

import { collapseSpaces, stripDiacritics } from "./normalize"
import { sanitizeFilename } from "./naming"

export const FOLDER_TOKENS = {
  artist: "Main artists",
  firstartist: "First artist only",
  albumartist: "Album artist",
  album: "Album",
  disc: "Disc number, only for releases on more than one (CD1/CD2, double LPs)",
  year: "Year",
  decade: "Decade, e.g. 1990s",
  label: "Label",
  genre: "Genre",
  region: "Region folder of the genre, e.g. UK (canonical genres)",
  version: "Version, e.g. Dubplate",
  initial: "First letter of the artist",
  bpm: "BPM",
  bpmrange: "BPM range, e.g. 140-149",
  key: "Key",
  camelot: "Camelot key, e.g. 8A",
  format: "File type, e.g. FLAC",
} as const

export type FolderToken = keyof typeof FOLDER_TOKENS
export type FolderValues = Partial<Record<FolderToken, string>>

/** Ready-made layouts. */
export const FOLDER_PRESETS: { id: string; label: string; template: string; about: string }[] = [
  { id: "artist", label: "Artist", template: "{artist}", about: "One folder per artist." },
  { id: "artist-album", label: "Artist / Album", template: "{artist}/{album}", about: "Singles stay in the artist's folder." },
  { id: "artist-year-album", label: "Artist / Year - Album", template: "{artist}/[{year} - ]{album}", about: "Albums in release order." },
  { id: "artist-album-disc", label: "Artist / Album / Disc", template: "{artist}/{album}/[Disc {disc}]", about: "Multi-disc albums and double LPs get a folder per disc." },
  { id: "a-z", label: "A-Z / Artist", template: "{initial}/{artist}", about: "Big crates, split by letter." },
  { id: "genre", label: "Genre / Artist", template: "{genre}/{artist}", about: "A crate per genre." },
  { id: "region-genre-flat", label: "Region / Genre", template: "[{region}]/{genre}", about: "UK/UK Grime, Reggae… one folder per canonical genre." },
  { id: "region-genre", label: "Region / Genre / Artist", template: "[{region}]/{genre}/{artist}", about: "UK/UK Grime/Wiley, Reggae/Chronixx… from your canonical genres." },
  { id: "label", label: "Label / Year", template: "{label}/{year}", about: "For 7-inch and 12-inch collectors." },
  { id: "decade", label: "Decade / Genre", template: "{decade}/{genre}", about: "Selecting by era." },
  { id: "dj", label: "BPM / Key", template: "[{bpmrange} BPM]/[{camelot}]", about: "Mixing crates by tempo and key." },
]

/** What a folder level is called when "name it Unknown" is chosen and its tag is missing. */
const UNKNOWN: Record<FolderToken, string> = {
  artist: "Unknown Artist",
  firstartist: "Unknown Artist",
  albumartist: "Unknown Artist",
  album: "Unknown Album",
  disc: "Disc 1",
  year: "Unknown Year",
  decade: "Unknown Decade",
  label: "Unknown Label",
  genre: "Unknown Genre",
  region: "Other",
  version: "Originals",
  initial: "#",
  bpm: "Unknown BPM",
  bpmrange: "Unknown BPM",
  key: "Unknown Key",
  camelot: "Unknown Key",
  format: "Other",
}

const TOKEN = /\{(\w+)\}/g
const GROUP = /\[([^[\]]*)\]/

export function tokensIn(s: string): string[] {
  return [...s.matchAll(TOKEN)].map((m) => m[1].toLowerCase())
}

const isFolderToken = (name: string): name is FolderToken => Object.hasOwn(FOLDER_TOKENS, name)

/** Tags in a template that aren't folder tags ({title}, typos), as written: they never have a value. */
export function unknownFolderTokens(template: string): string[] {
  const seen = new Set<string>()
  return [...template.matchAll(TOKEN)]
    .map((m) => m[1])
    .filter((n) => {
      const key = n.toLowerCase()
      if (isFolderToken(key) || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function valueOf(values: FolderValues, name: string): string {
  const key = name.toLowerCase()
  return isFolderToken(key) ? (values[key] ?? "").trim() : ""
}

function renderLevel(raw: string, values: FolderValues, missing: "skip" | "unknown"): string {
  // A tag outside [ ] is what the level is about: without it there's no folder to make.
  const gap = tokensIn(raw.replace(/\[[^[\]]*\]/g, "")).find((n) => !valueOf(values, n))
  if (gap) return missing === "unknown" ? sanitizeFilename(isFolderToken(gap) ? UNKNOWN[gap] : "Unknown", 120) : ""
  let level = raw
  // [..] with tags inside shows only when all of them have values; brackets without tags are kept as written.
  const literals: string[] = []
  for (let guard = 0; guard < 50; guard++) {
    const m = level.match(GROUP)
    if (!m || m.index === undefined) break
    const names = tokensIn(m[1])
    let replacement: string
    if (!names.length) {
      literals.push(m[0])
      replacement = `\uE000${literals.length - 1}\uE000`
    } else replacement = names.every((n) => valueOf(values, n)) ? m[1] : ""
    level = level.slice(0, m.index) + replacement + level.slice(m.index + m[0].length)
  }
  let out = level.replace(TOKEN, (_, n: string) => valueOf(values, n))
  out = out.replace(/\uE000(\d+)\uE000/g, (_, i: string) => literals[Number(i)])
  // Tidy separators an empty [ ] part can leave behind.
  out = collapseSpaces(out.replace(/\(\s*\)/g, "").replace(/\s[-–](\s+[-–])+\s/g, " - ")).replace(/^[\s\-–]+|[\s\-–]+$/g, "")
  return out ? sanitizeFilename(out, 120) : ""
}

/**
 * The folder a template gives for these values, inside the library, with "/"
 * between levels. "" means the library's top level. A level whose tag (outside
 * [ ]) has no value is skipped, or named "Unknown …".
 */
export function renderFolderTemplate(template: string, values: FolderValues, opts: { missing?: "skip" | "unknown" } = {}): string {
  return template
    .replace(/\\/g, "/")
    .split("/")
    .map((level) => renderLevel(level, values, opts.missing ?? "skip"))
    .filter(Boolean)
    .join("/")
}

/** A-Z folder for an artist: "The Specials" files under S, "2Pac" under 0-9. */
export function initialOf(artist: string | undefined): string {
  const a = stripDiacritics(artist ?? "")
    .trim()
    .replace(/^the\s+/i, "")
  const c = a.charAt(0).toUpperCase()
  if (!c) return ""
  if (/[A-Z]/.test(c)) return c
  if (/[0-9]/.test(c)) return "0-9"
  return "#"
}

export function decadeOf(year: number | undefined | null): string {
  return year ? `${Math.floor(year / 10) * 10}s` : ""
}

export function bpmRange(bpm: number | undefined | null): string {
  if (!bpm) return ""
  const lo = Math.floor(Math.round(bpm) / 10) * 10
  return `${lo}-${lo + 9}`
}
