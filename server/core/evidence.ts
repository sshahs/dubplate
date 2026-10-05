// What may say what kind of recording a file is: "Dubplate", "Special", "Remix", "Live".

import type { Track } from "../../shared/types"
import { withoutDiscFolders } from "./discs"

type Evidence = Pick<Track, "filename" | "relDir" | "tags"> & {
  originalPath?: string
  original?: Track["original"]
  heuristic?: Track["heuristic"]
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p

/**
 * Only the file's own name and title, as they were before Dubplate changed anything.
 *
 * A folder ("Dubplates", "Specials 2019"), an album, a genre or a comment describes
 * a collection the file sits in, not the recording (the genre list itself has
 * "Dubplates & specials"). A name Dubplate gave the file is its own earlier guess
 * coming back: a file wrongly cut as "Straight Drop (Dubplate)" mustn't back that
 * guess forever after. A file that's a whole side or disc ("Side A.mp3") is named by
 * its folder, so that folder counts.
 */
export function versionSays(t: Evidence): string[] {
  // Tracks first scanned since the original was kept; else the first name it had (a cut
  // file's tags are Dubplate's own, so its title isn't used).
  const filename = t.original?.filename ?? (t.originalPath ? basename(t.originalPath) : t.filename)
  const title = t.original ? t.original.tags?.title : t.originalPath ? undefined : t.tags?.title
  const out = [filename, title]
  if (t.heuristic?.position?.whole) {
    const [recording] = withoutDiscFolders(t.relDir.split(/[\\/]/).filter(Boolean).reverse())
    out.push(recording)
  }
  return out.filter((s): s is string => !!s)
}
