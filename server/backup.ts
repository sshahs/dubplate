// Backup and restore: settings, what Dubplate has learned (aliases and
// corrections) and the libraries it knows, as one JSON file.

import fs from "node:fs"
import path from "node:path"
import type { BackupFile, Settings } from "../shared/types"
import { VERSION } from "./config"
import { getDb, tx } from "./db"
import { addLibrary, listCorrections, listLibraries, updateLibrary, upsertAlias } from "./repo"
import { loadSettings, saveSettings } from "./settings"

/** Settings without any API keys, tokens or webhook addresses. */
function withoutSecrets(s: Settings): Settings {
  const out = structuredClone(s)
  out.llm.providers = out.llm.providers.map(({ apiKey: _k, ...p }) => p)
  for (const [id, cfg] of Object.entries(out.sources)) {
    const { apiKey: _k, apiSecret: _s, ...rest } = cfg
    out.sources[id] = rest
  }
  out.integrations.mediaServers = out.integrations.mediaServers.map(({ token: _t, ...m }) => m)
  delete out.integrations.discord.webhookUrl
  delete out.integrations.telegram.botToken
  return out
}

export function makeBackup(opts: { secrets: boolean }): BackupFile {
  const settings = loadSettings()
  const aliases = getDb().prepare("SELECT alias, canonical FROM aliases ORDER BY canonical, alias").all() as { alias: string; canonical: string }[]
  return {
    app: "dubplate",
    format: 1,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    secrets: opts.secrets,
    settings: opts.secrets ? settings : withoutSecrets(settings),
    aliases,
    corrections: listCorrections(1_000_000).map(({ filename, artists, title, version, createdAt }) => ({ filename, artists, title, version, createdAt })),
    libraries: listLibraries().map((l) => ({ path: l.path, name: l.name, watch: l.watch, settings: l.settings })),
  }
}

export function isBackup(b: unknown): b is BackupFile {
  const x = b as BackupFile | null
  return !!x && x.app === "dubplate" && x.format === 1 && typeof x.settings === "object" && Array.isArray(x.aliases) && Array.isArray(x.corrections) && Array.isArray(x.libraries)
}

export interface RestoreParts {
  settings: boolean
  learnings: boolean
  libraries: boolean
}

export interface RestoreResult {
  settings: boolean
  aliases: number
  corrections: number
  libraries: { added: number; updated: number; skipped: { path: string; reason: string }[] }
}

/**
 * Put a backup back. Settings replace the current ones (keys missing from the
 * backup are kept); aliases and corrections are merged in; libraries whose
 * folders exist here are added, and ones already known get their settings back.
 */
export function restoreBackup(b: BackupFile, parts: RestoreParts): RestoreResult {
  const result: RestoreResult = { settings: false, aliases: 0, corrections: 0, libraries: { added: 0, updated: 0, skipped: [] } }
  if (parts.settings) {
    saveSettings(b.settings)
    result.settings = true
  }
  if (parts.learnings) {
    const db = getDb()
    tx(db, () => {
      for (const a of b.aliases) {
        if (typeof a?.alias !== "string" || typeof a?.canonical !== "string" || !a.canonical.trim()) continue
        upsertAlias(a.alias, a.canonical)
        result.aliases++
      }
      const has = db.prepare("SELECT 1 FROM corrections WHERE filename = ?")
      const insert = db.prepare("INSERT INTO corrections (filename, artists_json, title, version, created_at) VALUES (?, ?, ?, ?, ?)")
      for (const c of b.corrections) {
        if (typeof c?.filename !== "string" || typeof c?.title !== "string" || !Array.isArray(c.artists)) continue
        if (has.get(c.filename)) continue
        insert.run(c.filename, JSON.stringify(c.artists.map(String)), c.title, c.version ?? null, c.createdAt ?? new Date().toISOString().slice(0, 19).replace("T", " "))
        result.corrections++
      }
    })
  }
  if (parts.libraries) {
    for (const l of b.libraries) {
      if (typeof l?.path !== "string") continue
      const p = path.resolve(l.path)
      const known = listLibraries()
      const same = known.find((k) => k.path === p)
      if (same) {
        updateLibrary(same.id, { watch: !!l.watch, settings: l.settings ?? {} })
        result.libraries.updated++
        continue
      }
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
        result.libraries.skipped.push({ path: l.path, reason: "folder not found here" })
        continue
      }
      const overlapping = known.find((k) => p.startsWith(k.path + path.sep) || k.path.startsWith(p + path.sep))
      if (overlapping) {
        result.libraries.skipped.push({ path: l.path, reason: `overlaps with "${overlapping.name}"` })
        continue
      }
      addLibrary(p, String(l.name || path.basename(p)), { watch: !!l.watch, settings: l.settings })
      result.libraries.added++
    }
  }
  return result
}
