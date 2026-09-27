// Tell media servers to rescan after Dubplate renames, moves or retags files,
// so Plex, Jellyfin/Emby and Navidrome pick the changes up straight away.

import { createHash, randomBytes } from "node:crypto"
import type { MediaServerConfig, Settings } from "../../shared/types"
import { networkMessage } from "../net"

const TIMEOUT_MS = 10_000

export interface ServerResult {
  ok: boolean
  message: string
}

function failure(err: unknown): ServerResult {
  return { ok: false, message: networkMessage(err) }
}

async function call(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
}

function plexHeaders(m: MediaServerConfig) {
  return { accept: "application/json", "X-Plex-Token": m.token ?? "", "X-Plex-Client-Identifier": "dubplate", "X-Plex-Product": "Dubplate" }
}

function jellyfinHeaders(m: MediaServerConfig) {
  return { accept: "application/json", "X-Emby-Token": m.token ?? "" }
}

/** Subsonic API URL with salted-token auth (Navidrome and friends). */
export function subsonicUrl(m: MediaServerConfig, method: string, salt = randomBytes(6).toString("hex")) {
  const token = createHash("md5")
    .update((m.token ?? "") + salt)
    .digest("hex")
  const q = new URLSearchParams({ u: m.user ?? "", t: token, s: salt, v: "1.16.1", c: "dubplate", f: "json" })
  return `${m.url}/rest/${method}?${q}`
}

async function subsonic(m: MediaServerConfig, method: string): Promise<ServerResult & { version?: string }> {
  const res = await call(subsonicUrl(m, method))
  if (!res.ok) return { ok: false, message: `Navidrome replied ${res.status}` }
  const j = (await res.json()) as { "subsonic-response"?: { status?: string; version?: string; serverVersion?: string; error?: { message?: string } } }
  const r = j["subsonic-response"]
  if (r?.status !== "ok") return { ok: false, message: r?.error?.message ?? "Navidrome said no" }
  return { ok: true, message: "", version: r.serverVersion ?? r.version }
}

async function plexMusicSections(m: MediaServerConfig): Promise<{ ok: false; message: string } | { ok: true; keys: string[] }> {
  const res = await call(`${m.url}/library/sections`, { headers: plexHeaders(m) })
  if (res.status === 401) return { ok: false, message: "Plex didn't accept the token" }
  if (!res.ok) return { ok: false, message: `Plex replied ${res.status}` }
  const j = (await res.json()) as { MediaContainer?: { Directory?: { key: string; type: string }[] } }
  return { ok: true, keys: (j.MediaContainer?.Directory ?? []).filter((d) => d.type === "artist").map((d) => d.key) }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export async function testMediaServer(m: MediaServerConfig): Promise<ServerResult> {
  if (!m.url) return { ok: false, message: "Needs the server's address" }
  try {
    if (m.kind === "plex") {
      const r = await plexMusicSections(m)
      if (!r.ok) return r
      return r.keys.length ? { ok: true, message: `Connected - ${plural(r.keys.length, "music library", "music libraries")}` } : { ok: false, message: "Connected, but Plex has no music libraries" }
    }
    if (m.kind === "jellyfin") {
      const res = await call(`${m.url}/System/Info`, { headers: jellyfinHeaders(m) })
      if (res.status === 401 || res.status === 403) return { ok: false, message: "The server didn't accept the API key" }
      if (!res.ok) return { ok: false, message: `The server replied ${res.status}` }
      const j = (await res.json()) as { ServerName?: string; Version?: string }
      return { ok: true, message: `Connected to ${j.ServerName || "the server"}${j.Version ? ` (${j.Version})` : ""}` }
    }
    const r = await subsonic(m, "ping.view")
    return r.ok ? { ok: true, message: `Connected to Navidrome${r.version ? ` ${r.version}` : ""}` } : r
  } catch (err) {
    return failure(err)
  }
}

export async function refreshMediaServer(m: MediaServerConfig): Promise<ServerResult> {
  if (!m.url) return { ok: false, message: "Needs the server's address" }
  try {
    if (m.kind === "plex") {
      const r = await plexMusicSections(m)
      if (!r.ok) return r
      for (const key of r.keys) {
        const res = await call(`${m.url}/library/sections/${encodeURIComponent(key)}/refresh`, { headers: plexHeaders(m) })
        if (!res.ok) return { ok: false, message: `Plex replied ${res.status} to the rescan` }
      }
      return { ok: true, message: `Rescanning ${plural(r.keys.length, "music library", "music libraries")}` }
    }
    if (m.kind === "jellyfin") {
      const res = await call(`${m.url}/Library/Refresh`, { method: "POST", headers: jellyfinHeaders(m) })
      if (!res.ok) return { ok: false, message: `The server replied ${res.status} to the rescan` }
      return { ok: true, message: "Library scan started" }
    }
    const r = await subsonic(m, "startScan.view")
    return r.ok ? { ok: true, message: "Scan started" } : r
  } catch (err) {
    return failure(err)
  }
}

export async function refreshMediaServers(settings: Settings): Promise<(ServerResult & { name: string })[]> {
  const servers = settings.integrations.mediaServers.filter((m) => m.enabled && m.url)
  return Promise.all(servers.map(async (m) => ({ name: m.name, ...(await refreshMediaServer(m)) })))
}
