import type { ArtRef } from "@shared/types"

const SOURCE_NAMES: Record<string, string> = {
  musicbrainz: "Cover Art Archive",
  discogs: "Discogs",
  bandcamp: "Bandcamp",
  itunes: "Apple Music",
  deezer: "Deezer",
  spotify: "Spotify",
}

/** Where a found cover came from, by the name people know it by. */
export const artSourceName = (a: Pick<ArtRef, "source" | "sourceLabel">) => SOURCE_NAMES[a.source] ?? a.sourceLabel ?? a.source
