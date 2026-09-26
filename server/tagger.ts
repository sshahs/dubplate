// Writes tags in place with node-taglib-sharp (pure TypeScript TagLib port,
// so it covers MP3, FLAC, M4A, OGG/Opus, WAV, AIFF, WMA and APE alike).

import path from "node:path"
import { ByteVector, Picture, PictureType, File as TagFile, TagTypes, type IPicture } from "node-taglib-sharp"
import type { ExistingTags } from "../shared/types"
import { cachedArt, storeArt } from "./art"
import { sniffImage } from "./art-image"

const TAG_TYPE_BY_EXT: Record<string, TagTypes> = {
  mp3: TagTypes.Id3v2,
  mp2: TagTypes.Id3v2,
  aac: TagTypes.Id3v2,
  wav: TagTypes.Id3v2,
  aif: TagTypes.Id3v2,
  aiff: TagTypes.Id3v2,
  flac: TagTypes.Xiph,
  ogg: TagTypes.Xiph,
  oga: TagTypes.Xiph,
  opus: TagTypes.Xiph,
  m4a: TagTypes.Apple,
  mp4: TagTypes.Apple,
  alac: TagTypes.Apple,
  wma: TagTypes.Asf,
  ape: TagTypes.Ape,
  wv: TagTypes.Ape,
  mpc: TagTypes.Ape,
}

function frontCover(pictures: IPicture[]): IPicture | undefined {
  return pictures.find((p) => p.type === PictureType.FrontCover) ?? pictures.find((p) => p.type === PictureType.Other) ?? pictures[0]
}

/**
 * Read back exactly the fields Dubplate manages, straight from the tag. The
 * front cover is copied into the artwork cache so a rewind can put it back.
 */
export function readManagedTags(file: string): ExistingTags {
  const f = TagFile.createFromPath(file)
  try {
    const t = f.tag
    const cover = frontCover(t.pictures ?? [])
    return {
      artist: t.performers?.length ? t.performers.join("; ") : undefined,
      title: t.title || undefined,
      album: t.album || undefined,
      year: t.year || undefined,
      genre: t.genres?.length ? [...t.genres] : undefined,
      label: t.publisher || undefined,
      comment: t.comment || undefined,
      bpm: t.beatsPerMinute || undefined,
      key: t.initialKey || undefined,
      cover: cover ? storeArt(cover.data.toByteArray(), "embedded")?.hash : undefined,
    }
  } finally {
    f.dispose()
  }
}

/**
 * Apply `changes` to the file's tags. A value of `null`/"" clears a field
 * (used when rewinding a field that was previously empty).
 */
export function writeTags(file: string, changes: Partial<Record<keyof ExistingTags, unknown>>) {
  const f = TagFile.createFromPath(file)
  try {
    const ext = path.extname(file).slice(1).toLowerCase()
    const type = TAG_TYPE_BY_EXT[ext]
    // Make sure there's a tag of the right kind to write into.
    if (type !== undefined) f.getTag(type, true)
    const t = f.tag
    // TagLib clears a field when given undefined, even though the setters are typed as string.
    const str = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : String(v)) as string
    if ("artist" in changes) t.performers = str(changes.artist) ? [String(changes.artist)] : []
    if ("title" in changes) t.title = str(changes.title)
    if ("album" in changes) t.album = str(changes.album)
    if ("year" in changes) t.year = Number(changes.year) || 0
    if ("genre" in changes) t.genres = Array.isArray(changes.genre) ? (changes.genre as string[]) : str(changes.genre) ? [String(changes.genre)] : []
    if ("label" in changes) t.publisher = str(changes.label)
    if ("comment" in changes) t.comment = str(changes.comment)
    if ("bpm" in changes) t.beatsPerMinute = Math.round(Number(changes.bpm)) || 0
    if ("key" in changes) t.initialKey = str(changes.key)
    if ("cover" in changes) {
      // Only the front cover is Dubplate's; back covers, artist photos etc. stay put.
      const others = (t.pictures ?? []).filter((p) => p !== frontCover(t.pictures ?? []))
      const hash = str(changes.cover)
      const bytes = hash ? cachedArt(hash) : null
      if (hash && !bytes) throw new Error("Artwork is missing from the cache — find it again")
      t.pictures = bytes ? [Picture.fromFullData(ByteVector.fromByteArray(bytes), PictureType.FrontCover, sniffImage(bytes)?.mime ?? "image/jpeg", ""), ...others] : others
    }
    f.save()
  } finally {
    f.dispose()
  }
}
