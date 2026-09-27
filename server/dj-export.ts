// Playlists for DJ software: Rekordbox XML, a Traktor NML collection, a Serato
// crate and plain M3U. Paths can be rewritten for software on another computer
// (Dubplate in Docker sees /music; the laptop sees D:\Music or /Volumes/Music).

import { randomUUID } from "node:crypto"
import path from "node:path"
import { keyIndex, parseKey } from "../shared/keys"
import type { DjFormat, PathMapping, Settings, Track } from "../shared/types"
import { VERSION } from "./config"
import { formatArtist, formatTitle } from "./core/naming"
import { metaFor } from "./placement"

export interface Playlist {
  name: string
  tracks: Track[]
}

export interface ExportOptions {
  pathMap: PathMapping[]
  traktorVolume: string
  naming: Settings["naming"]
}

export interface ExportedFile {
  filename: string
  contentType: string
  body: string | Uint8Array
}

/** What the software shows for a track: the file's tags once it's cut, else what it'll be tagged as. */
export function exportMeta(t: Track, naming: Settings["naming"]) {
  const meta = metaFor(t)
  const fromMeta = t.status !== "done" && meta
  const base = path.parse(t.filename).name
  return {
    artist: (fromMeta ? formatArtist(meta, naming) : t.tags.artist) || (meta ? formatArtist(meta, naming) : "") || "",
    title: (fromMeta ? formatTitle(meta, naming) : t.tags.title) || (meta ? formatTitle(meta, naming) : "") || base,
    album: t.tags.album || meta?.album || "",
    genre: t.tags.genre?.[0] || meta?.genre || "",
    label: t.tags.label || meta?.label || "",
    year: t.tags.year || meta?.year || null,
    bpm: t.bpm,
    key: parseKey(t.key),
  }
}

const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")

/** The file's path as the DJ computer sees it: the first mapping whose folder it's in. */
export function mapPath(p: string, pathMap: PathMapping[]): string {
  const norm = p.replace(/\\/g, "/")
  for (const m of pathMap) {
    const from = m.from.replace(/\\/g, "/").replace(/\/+$/, "")
    if (!from) continue
    if (norm === from || norm.startsWith(`${from}/`)) {
      const to = m.to.replace(/[\\/]+$/, "")
      const rest = norm.slice(from.length)
      return isWindowsPath(to) ? `${to}${rest}`.replace(/\//g, "\\") : `${to.replace(/\\/g, "/")}${rest}`
    }
  }
  return p
}

/** Control characters (tab, CR and LF aside), which XML 1.0 can't hold and filenames shouldn't. */
const stripControl = (s: string) =>
  [...s]
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      return c >= 32 || c === 9 || c === 10 || c === 13
    })
    .join("")

const xml = (s: string | number | null | undefined) =>
  stripControl(String(s ?? ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")

const safeName = (s: string) =>
  stripControl(s)
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Dubplate"

/** Every track once, in the order they first appear. */
function collection(playlists: Playlist[]): Track[] {
  const seen = new Map<number, Track>()
  for (const p of playlists) for (const t of p.tracks) if (!seen.has(t.id)) seen.set(t.id, t)
  return [...seen.values()]
}

// ---------- M3U ----------

export function toM3u(p: Playlist, opts: ExportOptions): ExportedFile {
  const lines = ["#EXTM3U", `#PLAYLIST:${p.name}`]
  for (const t of p.tracks) {
    const m = exportMeta(t, opts.naming)
    lines.push(`#EXTINF:${Math.round(t.duration ?? -1)},${m.artist ? `${m.artist} - ` : ""}${m.title}`)
    lines.push(mapPath(t.path, opts.pathMap))
  }
  return { filename: `${safeName(p.name)}.m3u8`, contentType: "audio/x-mpegurl; charset=utf-8", body: `${lines.join("\r\n")}\r\n` }
}

// ---------- Rekordbox ----------

const REKORDBOX_KIND: Record<string, string> = {
  mp3: "MP3 File",
  m4a: "M4A File",
  mp4: "M4A File",
  aac: "AAC File",
  flac: "FLAC File",
  wav: "WAV File",
  aif: "AIFF File",
  aiff: "AIFF File",
  alac: "ALAC File",
  ogg: "OGG File",
}

/** file://localhost/ URI Rekordbox expects, each path segment percent-encoded. */
export function rekordboxLocation(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/")
  const encoded = parts.map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
  const joined = encoded.join("/")
  return `file://localhost${joined.startsWith("/") ? "" : "/"}${joined}`
}

export function toRekordbox(playlists: Playlist[], opts: ExportOptions): ExportedFile {
  const all = collection(playlists)
  const ids = new Map(all.map((t, i) => [t.id, i + 1]))
  const tracks = all.map((t) => {
    const m = exportMeta(t, opts.naming)
    const attrs: [string, string | number | null][] = [
      ["TrackID", ids.get(t.id)!],
      ["Name", m.title],
      ["Artist", m.artist],
      ["Album", m.album],
      ["Genre", m.genre],
      ["Kind", REKORDBOX_KIND[t.ext.toLowerCase()] ?? `${t.ext.toUpperCase()} File`],
      ["Size", t.size],
      ["TotalTime", Math.round(t.duration ?? 0)],
      ["Year", m.year],
      ["AverageBpm", m.bpm ? m.bpm.toFixed(2) : null],
      ["BitRate", t.bitrate ? Math.round(t.bitrate / 1000) : null],
      ["SampleRate", t.sampleRate],
      ["Tonality", m.key],
      ["Label", m.label],
      ["Location", rekordboxLocation(mapPath(t.path, opts.pathMap))],
    ]
    return `    <TRACK ${attrs
      .filter(([, v]) => v !== null && v !== "")
      .map(([k, v]) => `${k}="${xml(v)}"`)
      .join(" ")}/>`
  })
  const nodes = playlists.map(
    (p) =>
      `      <NODE Name="${xml(p.name)}" Type="1" KeyType="0" Entries="${p.tracks.length}">\n${p.tracks.map((t) => `        <TRACK Key="${ids.get(t.id)}"/>`).join("\n")}\n      </NODE>`
  )
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="Dubplate" Version="${VERSION}" Company="Dubplate"/>
  <COLLECTION Entries="${all.length}">
${tracks.join("\n")}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Type="0" Name="Dubplate" Count="${playlists.length}">
${nodes.join("\n")}
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`
  return { filename: playlists.length === 1 ? `${safeName(playlists[0].name)} (rekordbox).xml` : "Dubplate crates (rekordbox).xml", contentType: "application/xml; charset=utf-8", body }
}

// ---------- Traktor ----------

/** Traktor's split of a path into volume, "/:"-separated folder and file name. */
export function traktorLocation(p: string, defaultVolume: string): { volume: string; dir: string; file: string } {
  const norm = p.replace(/\\/g, "/")
  let volume = defaultVolume
  let rest = norm
  const drive = norm.match(/^([A-Za-z]:)\/(.*)$/)
  const mounted = norm.match(/^\/Volumes\/([^/]+)\/(.*)$/)
  if (drive) {
    volume = drive[1]
    rest = drive[2]
  } else if (mounted) {
    volume = mounted[1]
    rest = mounted[2]
  } else rest = norm.replace(/^\/+/, "")
  const parts = rest.split("/")
  const file = parts.pop() ?? ""
  return { volume, dir: `/:${parts.map((d) => `${d}/:`).join("")}`, file }
}

export function toTraktor(playlists: Playlist[], opts: ExportOptions): ExportedFile {
  const all = collection(playlists)
  const keys = new Map<number, string>()
  const entries = all.map((t) => {
    const m = exportMeta(t, opts.naming)
    const loc = traktorLocation(mapPath(t.path, opts.pathMap), opts.traktorVolume)
    keys.set(t.id, `${loc.volume}${loc.dir}${loc.file}`)
    const k = keyIndex(m.key)
    const info: [string, string | number | null][] = [
      ["BITRATE", t.bitrate],
      ["GENRE", m.genre],
      ["LABEL", m.label],
      ["KEY", m.key],
      ["PLAYTIME", t.duration ? Math.round(t.duration) : null],
      ["PLAYTIME_FLOAT", t.duration ? t.duration.toFixed(6) : null],
      ["RELEASE_DATE", m.year ? `${m.year}/1/1` : null],
      ["FILESIZE", Math.round(t.size / 1024)],
    ]
    return [
      `<ENTRY TITLE="${xml(m.title)}" ARTIST="${xml(m.artist)}">`,
      `<LOCATION DIR="${xml(loc.dir)}" FILE="${xml(loc.file)}" VOLUME="${xml(loc.volume)}" VOLUMEID=""></LOCATION>`,
      m.album ? `<ALBUM TITLE="${xml(m.album)}"></ALBUM>` : "",
      `<INFO ${info
        .filter(([, v]) => v !== null && v !== "")
        .map(([a, v]) => `${a}="${xml(v)}"`)
        .join(" ")}></INFO>`,
      m.bpm ? `<TEMPO BPM="${m.bpm.toFixed(6)}" BPM_QUALITY="100.000000"></TEMPO>` : "",
      k ? `<MUSICAL_KEY VALUE="${k.pc + (k.minor ? 12 : 0)}"></MUSICAL_KEY>` : "",
      "</ENTRY>",
    ]
      .filter(Boolean)
      .join("\n")
  })
  const nodes = playlists.map(
    (p) =>
      `<NODE TYPE="PLAYLIST" NAME="${xml(p.name)}"><PLAYLIST ENTRIES="${p.tracks.length}" TYPE="LIST" UUID="${randomUUID().replace(/-/g, "")}">\n${p.tracks
        .map((t) => `<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="${xml(keys.get(t.id))}"></PRIMARYKEY></ENTRY>`)
        .join("\n")}\n</PLAYLIST></NODE>`
  )
  const body = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<NML VERSION="19"><HEAD COMPANY="www.native-instruments.com" PROGRAM="Traktor"></HEAD>
<MUSICFOLDERS></MUSICFOLDERS>
<COLLECTION ENTRIES="${all.length}">
${entries.join("\n")}
</COLLECTION>
<SETS ENTRIES="0"></SETS>
<PLAYLISTS><NODE TYPE="FOLDER" NAME="$ROOT"><SUBNODES COUNT="1">
<NODE TYPE="FOLDER" NAME="Dubplate"><SUBNODES COUNT="${playlists.length}">
${nodes.join("\n")}
</SUBNODES></NODE>
</SUBNODES></NODE></PLAYLISTS>
</NML>
`
  return { filename: playlists.length === 1 ? `${safeName(playlists[0].name)}.nml` : "Dubplate crates.nml", contentType: "application/xml; charset=utf-8", body }
}

// ---------- Serato ----------

function utf16be(s: string): Buffer {
  const le = Buffer.from(s, "utf16le")
  const out = Buffer.alloc(le.length)
  for (let i = 0; i + 1 < le.length; i += 2) {
    out[i] = le[i + 1]
    out[i + 1] = le[i]
  }
  return out
}

/** A Serato tag: 4-byte name, 4-byte big-endian length, then the payload. */
function field(tag: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.write(tag, 0, "latin1")
  head.writeUInt32BE(payload.length, 4)
  return Buffer.concat([head, payload])
}

/** Where Serato finds a file: its path from the root of the drive it's on. */
export function seratoPath(p: string): string {
  const norm = p.replace(/\\/g, "/")
  return norm
    .replace(/^[A-Za-z]:\//, "")
    .replace(/^\/Volumes\/[^/]+\//, "")
    .replace(/^\/+/, "")
}

const SERATO_COLUMNS = ["song", "artist", "bpm", "key", "album", "length"]

export function toSerato(p: Playlist, opts: ExportOptions): ExportedFile {
  const parts = [field("vrsn", utf16be("1.0/Serato ScratchLive Crate"))]
  for (const col of SERATO_COLUMNS) parts.push(field("ovct", Buffer.concat([field("tvcn", utf16be(col)), field("tvcw", utf16be("0"))])))
  for (const t of p.tracks) parts.push(field("otrk", field("ptrk", utf16be(seratoPath(mapPath(t.path, opts.pathMap))))))
  return { filename: `${safeName(p.name)}.crate`, contentType: "application/octet-stream", body: new Uint8Array(Buffer.concat(parts)) }
}

/** One file for the chosen software. M3U and Serato take a single playlist (the first). */
export function exportPlaylists(format: DjFormat, playlists: Playlist[], opts: ExportOptions): ExportedFile {
  const sorted = playlists.map((p) => ({
    ...p,
    tracks: [...p.tracks].sort((a, b) => {
      const ma = exportMeta(a, opts.naming)
      const mb = exportMeta(b, opts.naming)
      return ma.artist.localeCompare(mb.artist) || ma.title.localeCompare(mb.title)
    }),
  }))
  switch (format) {
    case "rekordbox":
      return toRekordbox(sorted, opts)
    case "traktor":
      return toTraktor(sorted, opts)
    case "serato":
      return toSerato(sorted[0], opts)
    default:
      return toM3u(sorted[0], opts)
  }
}
