// Creates a folder of silent audio files with realistically messy names so
// you can try Dubplate without pointing it at your real collection.
//   npm run demo -- ./demo-crates
import fs from "node:fs"
import path from "node:path"
import { writeTags } from "../server/tagger"
import { writeMp3, writeWav } from "../server/test/fixtures"

const root = path.resolve(process.argv[2] ?? "demo-crates")

const files: { rel: string; tags?: Record<string, string> }[] = [
  { rel: "Clashes/1993/12_buju_banton_vs_beenie_man_live_93_dubplate.mp3" },
  { rel: "Clashes/stone love vs killamanjaro 1995 side b pt2.mp3" },
  { rel: "Grime/03. Wiley - Wot Do U Call It (Official Video) [320kbps] www.grimeripz.com.mp3" },
  { rel: "Grime/skepta_-_shutdown.mp3" },
  { rel: "Grime/dizzee rascal - i luv u (radio rip).mp3" },
  { rel: "Grime/Kano - P's and Q's (1).mp3" },
  { rel: "Reggae 7s/A1-Tenor_Saw-Ring_The_Alarm.mp3" },
  { rel: "Reggae 7s/Murder She Wrote - Chaka Demus & Pliers.mp3" },
  { rel: "Reggae 7s/super cat - ghetto red hot.mp3", tags: { artist: "Super Cat", title: "Ghetto Red Hot" } },
  { rel: "Reggae 7s/Track 07.mp3", tags: { artist: "Sister Nancy" } },
  { rel: "Dubplates/chronixx ft protoje - here comes trouble (dubplate for king addies).mp3" },
  { rel: "Dubplates/sizzla kalonji - praise ye jah special.mp3" },
  { rel: "Jungle/shy fx & t power - shake ur body.wav" },
  { rel: "Downloads/audio_track_01 copy.mp3" },
]

for (const [i, f] of files.entries()) {
  const full = path.join(root, f.rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  if (full.endsWith(".wav")) writeWav(full, 2)
  // A different length each, so only the copy below counts as a duplicate.
  else writeMp3(full, 200 + i * 10)
  if (f.tags) writeTags(full, f.tags)
}
// an exact duplicate, to show off duplicate detection
fs.copyFileSync(path.join(root, files[3].rel), path.join(root, "Downloads/skepta shutdown.mp3"))
console.log(`Created ${files.length + 1} demo files in ${root}`)
