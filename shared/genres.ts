import type { GenreRule } from "./types"

/**
 * Suggestions for "What's in your crates". Owners can add anything else;
 * whatever is picked is passed to the AI as the collection's context.
 */
export const GENRE_GROUPS: { label: string; genres: string[] }[] = [
  { label: "Sound system", genres: ["Reggae", "Roots", "Dub", "Dancehall", "Lovers rock", "Ska & rocksteady", "Soca", "Afrobeats", "Amapiano"] },
  { label: "Bass & club", genres: ["Grime", "UK garage", "Jungle", "Drum & bass", "Dubstep", "House", "Techno", "Disco", "Electronic"] },
  { label: "Hip-hop & soul", genres: ["Hip-hop", "UK rap", "UK drill", "R&B", "Soul", "Funk", "Jazz", "Blues", "Gospel"] },
  { label: "Everything else", genres: ["Pop", "Rock", "Indie", "Punk", "Metal", "Folk", "Country", "Latin", "Classical", "Soundtracks", "Ambient", "World"] },
  { label: "Kinds of recording", genres: ["Sound clashes", "Dubplates & specials", "Live sets", "Radio rips", "DJ mixes", "Edits & bootlegs"] },
]

export const KNOWN_GENRES = new Set(GENRE_GROUPS.flatMap((g) => g.genres.map((x) => x.toLowerCase())))

/**
 * A starting point for the canonical genre list, from the examples it was
 * asked for. Replace it with your own folders; region folders for reggae and
 * dancehall are left empty until they're decided.
 */
export const STARTER_GENRE_RULES: GenreRule[] = [
  { genre: "UK Grime", region: "UK", match: ["grime", "grime revival", "uk grime", "eskibeat"] },
  { genre: "UK Garage", region: "UK", match: ["uk garage", "garage", "2-step", "2 step", "speed garage", "ukg", "bassline"] },
  { genre: "UK Rap", region: "UK", match: ["uk rap", "uk hip hop", "british hip hop", "british hip-hop", "british rap", "uk drill", "rap", "hip hop", "hip-hop", "drill"], regions: ["UK"] },
  { genre: "UK R&B", region: "UK", match: ["uk r&b", "r&b", "rnb", "contemporary r&b"], regions: ["UK"] },
  {
    genre: "Hip Hop",
    region: "US",
    match: ["us rap", "hip hop", "hip-hop", "rap", "trap", "drill", "boom bap", "hardcore rap", "hardcore hip-hop", "east coast", "east coast hip hop", "west coast", "underground hip hop", "gangsta rap", "conscious"],
    regions: ["US", "?"],
  },
  { genre: "Reggae", region: "", match: ["reggae", "roots reggae", "roots", "lovers rock", "rocksteady", "dub", "ska", "one drop"] },
  { genre: "Dancehall", region: "", match: ["dancehall", "bashment", "ragga", "raggamuffin"] },
]
