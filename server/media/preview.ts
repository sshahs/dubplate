// Previews of formats browsers can't play (WMA, APE, WavPack, Musepack, AIFF):
// ffmpeg makes an MP3 copy once, kept in the data folder so seeking works and
// the next listen is instant. The music file itself is only read.

import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { ensureDataDir } from "../config"
import { findFfmpeg, runFfmpeg } from "./ffmpeg"

/** What Chrome, Firefox and Safari all play. Anything else gets an MP3 copy. */
const BROWSER_PLAYS = new Set(["mp3", "m4a", "mp4", "aac", "flac", "ogg", "oga", "opus", "wav"])
/** Copies kept; the oldest go first. */
const KEEP = 60

export function browserPlays(ext: string): boolean {
  return BROWSER_PLAYS.has(ext.toLowerCase())
}

const inFlight = new Map<string, Promise<string>>()

function cacheDir(): string {
  const dir = path.join(ensureDataDir(), "previews")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Keep the newest copies only. */
function prune(dir: string) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mp3"))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  for (const { f } of files.slice(KEEP)) fs.rmSync(path.join(dir, f), { force: true })
}

/**
 * An MP3 of `file` for the browser to play, made on first request. Rejects when
 * ffmpeg isn't installed or can't read it.
 */
export function previewCopy(file: string, size: number, mtimeMs: number): Promise<string> {
  if (!findFfmpeg()) return Promise.reject(new Error("Browsers can't play this format, and ffmpeg (which would convert it for listening) isn't installed"))
  const key = createHash("sha1").update(`${file}\0${size}\0${Math.round(mtimeMs)}`).digest("hex").slice(0, 20)
  const dir = cacheDir()
  const out = path.join(dir, `${key}.mp3`)
  if (fs.existsSync(out)) {
    const now = new Date()
    fs.utimesSync(out, now, now)
    return Promise.resolve(out)
  }
  const running = inFlight.get(key)
  if (running) return running
  const tmp = path.join(dir, `.${key}.${randomUUID().slice(0, 8)}.mp3`)
  const job = runFfmpeg(["-i", file, "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "4", "-f", "mp3", tmp])
    .then(() => {
      fs.renameSync(tmp, out)
      prune(dir)
      return out
    })
    .catch((err) => {
      fs.rmSync(tmp, { force: true })
      throw err
    })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, job)
  return job
}
