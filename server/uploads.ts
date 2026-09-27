// Uploads from the browser (a phone, usually) straight into a library - an
// inbox, ideally, so hands-off can file them. Streamed to a hidden temporary
// file (scans skip dot-files) and only given its real name once it's all
// there; an upload never replaces a file, it takes the next free name.

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { Library, Settings, UploadResult } from "../shared/types"
import { sanitizeFilename } from "./core/naming"
import { familyOfExt, sniffFile } from "./sniff"
import { ensureDir, isInside } from "./fsops"

export class UploadError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    message: string
  ) {
    super(message)
  }
}

/** A name that's safe on any filesystem, keeping its extension. */
export function uploadName(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, "/"))
  const ext = path.extname(base).toLowerCase()
  const stem = sanitizeFilename(base.slice(0, base.length - ext.length), 150) || "Upload"
  return `${stem}${ext.replace(/[^.a-z0-9]/g, "")}`
}

/** `dir` inside the library, one sanitised folder name at a time. */
function targetDir(lib: Library, dir: string | undefined): string {
  const parts = (dir ?? "")
    .split(/[\\/]/)
    .map((p) => sanitizeFilename(p))
    .filter((p) => p && p !== "." && p !== "..")
  const out = path.join(lib.path, ...parts)
  if (!isInside(lib.path, out)) throw new UploadError(400, "That folder is outside the library")
  return out
}

/** `name`, or "name (2)", "name (3)"… - whichever doesn't exist yet, claimed without a race. */
async function claimName(tmp: string, dir: string, name: string): Promise<string> {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; i < 1000; i++) {
    const to = path.join(dir, i === 1 ? name : `${stem} (${i})${ext}`)
    try {
      // A hard link fails if the name's taken, so two uploads can't both get it.
      await fs.promises.link(tmp, to)
      await fs.promises.unlink(tmp)
      return to
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "EEXIST") continue
      // No hard links here (some network shares): check, then rename.
      if (fs.existsSync(to)) continue
      await fs.promises.rename(tmp, to)
      return to
    }
  }
  throw new UploadError(400, "Too many files with that name already")
}

/** Save an uploaded file's bytes into a library. */
export async function saveUpload(opts: { lib: Library; name: string; dir?: string; body: ReadableStream<Uint8Array> | null; size?: number; settings: Settings }): Promise<UploadResult> {
  const { lib, settings } = opts
  const name = uploadName(opts.name)
  const ext = path.extname(name).slice(1)
  if (!ext || !settings.scanner.extensions.includes(ext)) throw new UploadError(415, `.${ext || "?"} files aren't music Dubplate reads (${settings.scanner.extensions.map((e) => `.${e}`).join(", ")})`)
  const max = settings.uploads.maxMb * 1024 * 1024
  if (opts.size && opts.size > max) throw new UploadError(413, `Bigger than the ${settings.uploads.maxMb} MB limit (Settings → Download tools)`)
  if (!opts.body) throw new UploadError(400, "Nothing was sent")
  if (!lib.exists) throw new UploadError(400, `${lib.name}'s folder isn't there`)

  const dir = targetDir(lib, opts.dir)
  await ensureDir(dir)
  const tmp = path.join(dir, `.${name}.${randomUUID().slice(0, 8)}.uploading`)
  let bytes = 0
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length
      done(bytes > max ? new UploadError(413, `Bigger than the ${settings.uploads.maxMb} MB limit (Settings → Download tools)`) : null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(opts.body as import("node:stream/web").ReadableStream<Uint8Array>), limit, fs.createWriteStream(tmp, { flags: "wx" }))
    if (!bytes) throw new UploadError(400, "The file was empty")
    // Named like music but isn't any format Dubplate knows (a web page saved as .mp3, say).
    if (familyOfExt(ext) && !(await sniffFile(tmp).catch(() => null))) throw new UploadError(415, "That doesn't look like an audio file")
    const saved = await claimName(tmp, dir, name)
    return { path: path.relative(lib.path, saved), name: path.basename(saved), size: bytes, libraryId: lib.id }
  } catch (err) {
    await fs.promises.rm(tmp, { force: true })
    throw err
  }
}
