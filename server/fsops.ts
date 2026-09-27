// File moves for cutting, organising and setting duplicates aside. Every move
// refuses to overwrite, works across mounts, and reports the folders it had to
// create so a rewind can take them away again.

import fs from "node:fs"
import path from "node:path"

/** Files an OS leaves behind that shouldn't keep a folder alive. */
const JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini", "._.ds_store", ".directory"])

/** Files that belong with a release folder and follow it when all its audio moves. */
const SIDECAR_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "cue", "log", "nfo", "txt", "m3u", "m3u8", "pdf", "sfv", "md5", "accurip"])

export function isJunk(name: string) {
  return JUNK.has(name.toLowerCase())
}

export function isSidecar(name: string) {
  return !name.startsWith(".") && SIDECAR_EXT.has(path.extname(name).slice(1).toLowerCase())
}

export function sameFile(a: string, b: string) {
  try {
    const sa = fs.statSync(a)
    const sb = fs.statSync(b)
    return sa.ino === sb.ino && sa.dev === sb.dev
  } catch {
    return false
  }
}

/** `a` is `root` or somewhere inside it. */
export function isInside(root: string, a: string) {
  const rel = path.relative(path.resolve(root), path.resolve(a))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** mkdir -p, returning the folders that had to be created (outermost first). */
export async function ensureDir(dir: string): Promise<string[]> {
  const missing: string[] = []
  let cur = path.resolve(dir)
  while (!fs.existsSync(cur)) {
    missing.unshift(cur)
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  if (missing.length) await fs.promises.mkdir(dir, { recursive: true })
  return missing
}

/**
 * Move or rename a file without ever overwriting another one. Case-only renames
 * go via a temporary name; moves across mounts copy, check and then delete.
 */
export async function moveFile(from: string, to: string) {
  if (from === to) return
  if (fs.existsSync(to)) {
    if (!sameFile(from, to)) throw new Error(`Refusing to overwrite ${path.basename(to)}`)
    // Case-only rename on a case-insensitive filesystem: go via a temp name.
    const tmp = `${from}.dubplate-${process.pid}.tmp`
    await fs.promises.rename(from, tmp)
    await fs.promises.rename(tmp, to)
    return
  }
  try {
    await fs.promises.rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err
    // Different mount (a Docker volume per folder, say): copy, verify, then remove the original.
    const st = await fs.promises.stat(from)
    await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL)
    const copied = await fs.promises.stat(to)
    if (copied.size !== st.size) {
      await fs.promises.rm(to, { force: true })
      throw new Error(`Copy of ${path.basename(from)} came out the wrong size`)
    }
    // Keep the timestamps: the scanner uses them to know a file hasn't changed.
    await fs.promises.utimes(to, st.atime, st.mtime)
    await fs.promises.unlink(from)
  }
}

/** A folder with nothing in it but OS junk. */
async function emptyish(dir: string): Promise<string[] | null> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  if (entries.some((e) => !(e.isFile() && isJunk(e.name)))) return null
  return entries.map((e) => path.join(dir, e.name))
}

/**
 * Remove `dir` and then its parents while they're empty (apart from OS junk),
 * never going above `root`. Returns the folders removed.
 */
export async function removeEmptyDirs(dir: string, root: string): Promise<string[]> {
  const removed: string[] = []
  let cur = path.resolve(dir)
  const top = path.resolve(root)
  while (cur !== top && isInside(top, cur)) {
    const junk = await emptyish(cur)
    if (!junk) break
    try {
      for (const f of junk) await fs.promises.rm(f, { force: true })
      await fs.promises.rmdir(cur)
      removed.push(cur)
    } catch {
      break
    }
    cur = path.dirname(cur)
  }
  return removed
}

/** Take away folders a move created, deepest first, as long as they're empty. */
export async function removeCreatedDirs(dirs: string[]) {
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    const junk = await emptyish(d)
    if (!junk) continue
    try {
      for (const f of junk) await fs.promises.rm(f, { force: true })
      await fs.promises.rmdir(d)
    } catch {
      // still in use: leave it
    }
  }
}

/**
 * Sidecar files in `dir` (cover images, cue sheets…) that can follow its audio
 * to one new folder: only when nothing else is left there - no other files and
 * no sub-folders - so a folder is never split up.
 */
export function followableSidecars(dir: string, movingAudio: Set<string>): string[] | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const sidecars: string[] = []
  const noExt = (f: string) => f.slice(0, f.length - path.extname(f).length).toLowerCase()
  // A track's own .lrc goes with the track itself, so it doesn't hold the folder back.
  const movingBases = new Set([...movingAudio].map(noExt))
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return null
    if (!e.isFile() || isJunk(e.name)) continue
    if (movingAudio.has(full)) continue
    if (path.extname(e.name).toLowerCase() === ".lrc" && movingBases.has(noExt(full))) continue
    if (isSidecar(e.name)) sidecars.push(full)
    else return null
  }
  return sidecars
}
