/**
 * Suggestions for "What's in your crates". Owners can add anything else;
 * whatever is picked is passed to the AI as the collection's context.
 */
export const GENRE_GROUPS: { label: string; genres: string[] }[] = [
  { label: "Sound system", genres: ["Reggae", "Roots", "Dub", "Dancehall", "Lovers rock", "Ska & rocksteady", "Soca", "Afrobeats", "Amapiano"] },
  { label: "Bass & club", genres: ["Grime", "UK garage", "Jungle", "Drum & bass", "Dubstep", "House", "Techno", "Disco", "Electronic"] },
  { label: "Hip-hop & soul", genres: ["Hip-hop", "R&B", "Soul", "Funk", "Jazz", "Blues", "Gospel"] },
  { label: "Everything else", genres: ["Pop", "Rock", "Indie", "Punk", "Metal", "Folk", "Country", "Latin", "Classical", "Soundtracks", "Ambient", "World"] },
  { label: "Kinds of recording", genres: ["Sound clashes", "Dubplates & specials", "Live sets", "Radio rips", "DJ mixes", "Edits & bootlegs"] },
]

export const KNOWN_GENRES = new Set(GENRE_GROUPS.flatMap((g) => g.genres.map((x) => x.toLowerCase())))
