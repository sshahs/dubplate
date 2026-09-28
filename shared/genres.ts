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
 * The canonical genre list, from Dee's folders on the Jellyfin server
 * (Music/Albums): UK styles under a UK folder, everything else at the top.
 * Series and kinds named in the title (Daily Duppy, SBTV, instrumentals) go
 * to their own folders whatever their style. Order matters on a tie: the rule
 * higher up wins, so the UK ones come before Hip-Hop.
 */
export const STARTER_GENRE_RULES: GenreRule[] = [
  { genre: "Daily Duppy", region: "UK", match: [], titles: ["daily duppy"] },
  { genre: "SBTV", region: "UK", match: [], titles: ["sbtv", "warm up session", "warm up sessions", "f64"] },
  { genre: "Instrumentals", region: "UK", match: ["instrumental"], titles: ["instrumental", "instrumentals"], regions: ["UK"] },
  { genre: "UK Drill", region: "UK", match: ["uk drill", "drill", "london drill"], regions: ["UK"] },
  { genre: "UK Grime", region: "UK", match: ["grime", "uk grime", "grime revival", "eskibeat", "sublow"] },
  {
    genre: "UK Garage",
    region: "UK",
    match: ["uk garage", "garage", "ukg", "2 step", "two step", "speed garage", "bassline", "future garage", "old skool garage", "old school garage"],
    exclude: ["rock", "punk", "psych"],
  },
  {
    genre: "UK Rap",
    region: "UK",
    match: ["uk rap", "uk hip hop", "british hip hop", "british rap", "road rap", "rap", "hip hop", "trap", "uk trap", "afroswing", "afro swing"],
    regions: ["UK"],
  },
  {
    genre: "Drum And Bass",
    region: "",
    match: ["drum and bass", "drum & bass", "drum n bass", "drum 'n' bass", "drum'n'bass", "dnb", "d&b", "liquid funk", "liquid drum and bass", "neurofunk", "jump up", "techstep", "rollers"],
  },
  { genre: "Jungle", region: "", match: ["jungle", "ragga jungle", "junglist", "old skool jungle", "old school jungle", "darkside jungle"] },
  {
    genre: "Hardcore",
    region: "",
    match: ["hardcore", "happy hardcore", "uk hardcore", "hardcore techno", "gabber", "gabba", "freeform", "bouncy techno", "makina"],
    exclude: ["punk", "hip hop", "rap", "metal", "rock", "breakbeat", "breaks", "old skool", "oldskool", "old school"],
  },
  {
    genre: "Old Skool",
    region: "",
    match: ["old skool", "oldskool", "old school", "rave", "old skool rave", "breakbeat hardcore", "hardcore breaks", "old skool hardcore", "bleep techno"],
    exclude: ["hip hop", "rap", "garage", "jungle", "reggae", "dancehall", "soul", "funk"],
  },
  { genre: "House", folder: "House Genres", region: "", match: ["house", "deep house", "tech house", "soulful house", "afro house", "acid house", "garage house", "funky house", "disco house"] },
  {
    genre: "Hip-Hop",
    region: "",
    match: [
      "hip hop",
      "rap",
      "us rap",
      "trap",
      "drill",
      "boom bap",
      "east coast hip hop",
      "west coast hip hop",
      "gangsta rap",
      "g funk",
      "conscious hip hop",
      "old school hip hop",
      "hardcore hip hop",
      "hardcore rap",
      "underground hip hop",
      "southern hip hop",
      "dirty south",
      "crunk",
      "jazz rap",
      "abstract hip hop",
      "pop rap",
    ],
  },
  {
    genre: "Reggae",
    region: "",
    match: ["reggae", "roots reggae", "dub", "lovers rock", "rocksteady", "ska", "dancehall", "bashment", "ragga", "raggamuffin", "reggae fusion", "one drop", "steppers", "sound clash"],
    exclude: ["techno", "punk"],
  },
  {
    genre: "Oldies",
    region: "",
    match: ["oldies", "doo wop", "rock and roll", "rock & roll", "rock n roll", "rock 'n' roll", "rockabilly", "motown", "northern soul", "classic soul", "girl group", "merseybeat"],
  },
  { genre: "Christmas Classic Pop", region: "", match: ["christmas", "xmas", "christmas music", "christmas pop", "holiday"] },
]
