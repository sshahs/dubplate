// Writes tags in place with node-taglib-sharp (pure TypeScript TagLib port,
// so it covers MP3, FLAC, M4A, OGG/Opus, WAV, AIFF, WMA and APE alike).

import fs from "node:fs"
import path from "node:path"
import {
  ApeTag,
  AsfTag,
  ByteVector,
  Id3v2FrameClassType,
  Id3v2Tag,
  Id3v2UserTextInformationFrame,
  Mpeg4AppleTag,
  Picture,
  PictureType,
  File as TagFile,
  TagTypes,
  XiphComment,
  type IPicture,
} from "node-taglib-sharp"
import type { ExistingTags } from "../shared/types"
import { cachedArt, storeArt } from "./art"
import { sniffImage } from "./art-image"
import { mismatch, sniffFileSync } from "./sniff"

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

/** The field name most taggers (Mp3tag, foobar2000, Picard plugins) use for a Discogs release. */
const DISCOGS_RELEASE = "DISCOGS_RELEASE_ID"
/** No tag standard has a riddim; this is the plain name Mp3tag, foobar2000 and MusicBee show for a custom field. */
export const RIDDIM = "RIDDIM"
/** WMA's own names for the label and the musical key. */
export const ASF_LABEL = "WM/Publisher"
export const ASF_KEY = "WM/InitialKey"

/**
 * Open a file with TagLib as what it really is: a .mp3 that's really an M4A is
 * opened as an M4A, so its tags go where players look for them (and it isn't
 * damaged by an MP3 tag). Returns the extension its content goes by.
 */
function openTagFile(file: string): { f: TagFile; ext: string } {
  const real = mismatch(file, sniffFileSync(file))
  return { f: TagFile.createFromPath(file, real ? `taglib/${real.ext}` : undefined), ext: real?.ext ?? path.extname(file).slice(1).toLowerCase() }
}

/** The file's own tag of the kind Dubplate writes into, for fields TagLib has no property for. */
function nativeTag(f: TagFile, ext: string, create: boolean) {
  const type = TAG_TYPE_BY_EXT[ext]
  return type === undefined ? undefined : f.getTag(type, create)
}

function readCustom(f: TagFile, ext: string, key: string): string | undefined {
  const t = nativeTag(f, ext, false)
  let v: string | undefined
  if (t instanceof Id3v2Tag) {
    const frames = t.getFramesByClassType<Id3v2UserTextInformationFrame>(Id3v2FrameClassType.UserTextInformationFrame)
    v = Id3v2UserTextInformationFrame.findUserTextInformationFrame(frames, key, false)?.text?.[0]
  } else if (t instanceof XiphComment) v = t.getFieldFirstValue(key)
  else if (t instanceof Mpeg4AppleTag) v = t.getFirstItunesString("com.apple.iTunes", key)
  else if (t instanceof ApeTag) v = t.getItem(key)?.text?.[0]
  else if (t instanceof AsfTag) v = t.getDescriptorString(key)
  return v?.trim() || undefined
}

function writeCustom(f: TagFile, ext: string, key: string, value: string | undefined) {
  const t = nativeTag(f, ext, true)
  if (t instanceof Id3v2Tag) {
    const frames = t.getFramesByClassType<Id3v2UserTextInformationFrame>(Id3v2FrameClassType.UserTextInformationFrame)
    const frame = Id3v2UserTextInformationFrame.findUserTextInformationFrame(frames, key, false)
    if (!value) {
      if (frame) t.removeFrame(frame)
    } else if (frame) frame.text = [value]
    else {
      const created = Id3v2UserTextInformationFrame.fromDescription(key)
      created.text = [value]
      t.addFrame(created)
    }
  } else if (t instanceof XiphComment) {
    if (value) t.setFieldAsStrings(key, value)
    else t.removeField(key)
  } else if (t instanceof Mpeg4AppleTag) {
    if (value) t.setItunesStrings("com.apple.iTunes", key, value)
    else t.setItunesStrings("com.apple.iTunes", key)
  } else if (t instanceof ApeTag) t.setStringValue(key, value ?? "")
  else if (t instanceof AsfTag) t.setDescriptorString(value ?? "", key)
}

/**
 * Save the tags. node-taglib-sharp 6.0.3 (the latest) saves a WMA's header by
 * overwriting as many bytes as the new header is long instead of replacing the
 * old one, so a header that grows (it always gains padding) destroys the start
 * of the audio and the file no longer plays. For WMA/ASF the old header is
 * replaced by its own length - the size its header object states.
 */
function saveTagFile(f: TagFile, file: string, ext: string) {
  if (TAG_TYPE_BY_EXT[ext] !== TagTypes.Asf) return f.save()
  const head = Buffer.alloc(24)
  const fd = fs.openSync(file, "r")
  try {
    fs.readSync(fd, head, 0, 24, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (!head.subarray(0, 16).equals(ASF_HEADER)) throw new Error("Not a WMA file inside - its tags weren't written")
  const oldHeader = Number(head.readBigUInt64LE(16))
  const insert = TagFile.prototype.insert
  TagFile.prototype.insert = function (this: TagFile, data: ByteVector, start: number, replace?: number) {
    return insert.call(this, data, start, this === f && start === 0 ? oldHeader : replace)
  }
  try {
    f.save()
  } finally {
    TagFile.prototype.insert = insert
  }
}

/** The ASF header object's GUID: every WMA/WMV starts with it. */
const ASF_HEADER = Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex")

/**
 * Whether a WMA's header runs straight into its audio, as it must. One saved
 * by the bug above has its header followed by part of the overwritten audio.
 */
export function asfDamage(file: string): string | null {
  const fd = fs.openSync(file, "r")
  try {
    const head = Buffer.alloc(24)
    if (fs.readSync(fd, head, 0, 24, 0) < 24 || !head.subarray(0, 16).equals(ASF_HEADER)) return null
    const size = Number(head.readBigUInt64LE(16))
    const next = Buffer.alloc(16)
    if (fs.readSync(fd, next, 0, 16, size) < 16) return "the file ends inside its header"
    return next.equals(ASF_DATA) ? null : "its header runs over the start of the audio (saved by an earlier Dubplate's WMA tag bug)"
  } finally {
    fs.closeSync(fd)
  }
}

/** The ASF data object's GUID: the audio packets follow the header. */
const ASF_DATA = Buffer.from("3626b2758e66cf11a6d900aa0062ce6c", "hex")

function frontCover(pictures: IPicture[]): IPicture | undefined {
  return pictures.find((p) => p.type === PictureType.FrontCover) ?? pictures.find((p) => p.type === PictureType.Other) ?? pictures[0]
}

/**
 * Read back exactly the fields Dubplate manages, straight from the tag. The
 * front cover is copied into the artwork cache so a rewind can put it back.
 */
export function readManagedTags(file: string): ExistingTags {
  const { f, ext } = openTagFile(file)
  try {
    const t = f.tag
    const asf = TAG_TYPE_BY_EXT[ext] === TagTypes.Asf
    const cover = frontCover(t.pictures ?? [])
    return {
      artist: t.performers?.length ? t.performers.join("; ") : undefined,
      title: t.title || undefined,
      album: t.album || undefined,
      year: t.year || undefined,
      genre: t.genres?.length ? [...t.genres] : undefined,
      label: t.publisher || (asf ? readCustom(f, ext, ASF_LABEL) : undefined),
      riddim: readCustom(f, ext, RIDDIM),
      grouping: t.grouping || undefined,
      comment: t.comment || undefined,
      bpm: t.beatsPerMinute || undefined,
      track: t.track || undefined,
      trackTotal: t.trackCount || undefined,
      disc: t.disc || undefined,
      discTotal: t.discCount || undefined,
      key: t.initialKey || (asf ? readCustom(f, ext, ASF_KEY) : undefined),
      cover: cover ? storeArt(cover.data.toByteArray(), "embedded")?.hash : undefined,
      mbRecordingId: t.musicBrainzTrackId || undefined,
      mbReleaseId: t.musicBrainzReleaseId || undefined,
      mbReleaseGroupId: t.musicBrainzReleaseGroupId || undefined,
      mbArtistId: t.musicBrainzArtistId || undefined,
      discogsReleaseId: readCustom(f, ext, DISCOGS_RELEASE),
      replayGainTrackGain: Number.isFinite(t.replayGainTrackGain) ? t.replayGainTrackGain : undefined,
      replayGainTrackPeak: Number.isFinite(t.replayGainTrackPeak) ? t.replayGainTrackPeak : undefined,
      lyrics: t.lyrics?.trim() ? t.lyrics : undefined,
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
  const { f, ext } = openTagFile(file)
  try {
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
    if ("riddim" in changes) writeCustom(f, ext, RIDDIM, str(changes.riddim))
    if ("grouping" in changes) t.grouping = str(changes.grouping)
    if ("comment" in changes) t.comment = str(changes.comment)
    if ("bpm" in changes) t.beatsPerMinute = Math.round(Number(changes.bpm)) || 0
    // 0 clears a number.
    if ("track" in changes) t.track = Math.round(Number(changes.track)) || 0
    if ("trackTotal" in changes) t.trackCount = Math.round(Number(changes.trackTotal)) || 0
    if ("disc" in changes) t.disc = Math.round(Number(changes.disc)) || 0
    if ("discTotal" in changes) t.discCount = Math.round(Number(changes.discTotal)) || 0
    if ("key" in changes) t.initialKey = str(changes.key)
    if ("mbRecordingId" in changes) t.musicBrainzTrackId = str(changes.mbRecordingId)
    if ("mbReleaseId" in changes) t.musicBrainzReleaseId = str(changes.mbReleaseId)
    if ("mbReleaseGroupId" in changes) t.musicBrainzReleaseGroupId = str(changes.mbReleaseGroupId)
    if ("mbArtistId" in changes) t.musicBrainzArtistId = str(changes.mbArtistId)
    if ("discogsReleaseId" in changes) writeCustom(f, ext, DISCOGS_RELEASE, str(changes.discogsReleaseId))
    if ("lyrics" in changes) t.lyrics = str(changes.lyrics)
    // TagLib's WMA tag has no label or key; these are the names WMA players and taggers use.
    if (type === TagTypes.Asf) {
      if ("label" in changes) writeCustom(f, ext, ASF_LABEL, str(changes.label))
      if ("key" in changes) writeCustom(f, ext, ASF_KEY, str(changes.key))
    }
    // NaN clears a ReplayGain field.
    const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? NaN : Number(v))
    if ("replayGainTrackGain" in changes) t.replayGainTrackGain = num(changes.replayGainTrackGain)
    if ("replayGainTrackPeak" in changes) t.replayGainTrackPeak = num(changes.replayGainTrackPeak)
    if ("cover" in changes) {
      // Only the front cover is Dubplate's; back covers, artist photos etc. stay put.
      const others = (t.pictures ?? []).filter((p) => p !== frontCover(t.pictures ?? []))
      const hash = str(changes.cover)
      const bytes = hash ? cachedArt(hash) : null
      if (hash && !bytes) throw new Error("Artwork is missing from the cache - find it again")
      t.pictures = bytes ? [Picture.fromFullData(ByteVector.fromByteArray(bytes), PictureType.FrontCover, sniffImage(bytes)?.mime ?? "image/jpeg", ""), ...others] : others
    }
    saveTagFile(f, file, ext)
  } finally {
    f.dispose()
  }
}
