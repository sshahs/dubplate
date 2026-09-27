// API tokens: keys for scripts and download tools (qBittorrent, slskd, Lidarr…)
// to call Dubplate without a browser session. Only a SHA-256 of each token is
// stored; the token itself is shown once, when it's made. A "hooks" token can
// only report downloads and upload files; a "full" token can use the whole API
// except signing in and managing tokens.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { ApiToken } from "../shared/types"
import { getDb } from "./db"

const PREFIX = "dp_"

type Row = { id: number; name: string; token_hash: string; prefix: string; scope: string; created_at: string; last_used_at: string | null }

function toToken(r: Row): ApiToken {
  return { id: r.id, name: r.name, prefix: r.prefix, scope: r.scope === "full" ? "full" : "hooks", createdAt: r.created_at, lastUsedAt: r.last_used_at }
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex")

export function listTokens(): ApiToken[] {
  return (getDb().prepare("SELECT * FROM api_tokens ORDER BY created_at DESC, id DESC").all() as Row[]).map(toToken)
}

/** Make a token. The returned `token` is the only time it's ever seen in full. */
export function createToken(name: string, scope: ApiToken["scope"]): ApiToken & { token: string } {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 60)
  if (!clean) throw new Error("Give the token a name, e.g. the tool that will use it")
  const token = `${PREFIX}${randomBytes(24).toString("base64url")}`
  const r = getDb()
    .prepare("INSERT INTO api_tokens (name, token_hash, prefix, scope) VALUES (?, ?, ?, ?) RETURNING *")
    .get(clean, hash(token), token.slice(0, PREFIX.length + 4), scope === "full" ? "full" : "hooks") as Row
  return { ...toToken(r), token }
}

export function deleteToken(id: number): boolean {
  return Number(getDb().prepare("DELETE FROM api_tokens WHERE id = ?").run(id).changes) > 0
}

/** Last-used times are only written once a minute per token, not on every call. */
const touched = new Map<number, number>()

/** The token this is, if it's one of ours. */
export function checkToken(token: string): ApiToken | null {
  if (!token.startsWith(PREFIX) || token.length > 200) return null
  const h = hash(token)
  const r = getDb().prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(h) as Row | undefined
  // The lookup is by hash already; compare again in constant time for good measure.
  if (!r || !timingSafeEqual(Buffer.from(r.token_hash, "hex"), Buffer.from(h, "hex"))) return null
  if (Date.now() - (touched.get(r.id) ?? 0) > 60_000) {
    touched.set(r.id, Date.now())
    getDb().prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(r.id)
  }
  return toToken(r)
}

/**
 * The token a request carries, if any: "Authorization: Bearer …", a Basic
 * password (for tools that only have a username/password box, like Lidarr),
 * an X-Dubplate-Token header, or ?token= as a last resort.
 */
export function tokenFromRequest(headers: { authorization?: string; xToken?: string }, query: string | undefined): string | null {
  const auth = headers.authorization?.trim()
  if (auth) {
    const [kind, value] = auth.split(/\s+/, 2)
    // Only ours: a proxy in front may send its own bearer tokens along.
    if (/^bearer$/i.test(kind) && value?.startsWith(PREFIX)) return value
    if (/^basic$/i.test(kind) && value) {
      const decoded = Buffer.from(value, "base64").toString("utf8")
      const pass = decoded.slice(decoded.indexOf(":") + 1)
      if (pass.startsWith(PREFIX)) return pass
    }
  }
  if (headers.xToken) return headers.xToken.trim()
  return query?.trim() || null
}

/** Paths a "hooks" token may call. */
export function hooksMayCall(pathname: string): boolean {
  return pathname.startsWith("/api/hooks/") || pathname === "/api/upload" || pathname === "/api/health"
}

/** Paths no token may call: signing in, the password, and tokens themselves. */
export function tokensMayNotCall(pathname: string): boolean {
  return pathname.startsWith("/api/auth/") || pathname === "/api/tokens" || pathname.startsWith("/api/tokens/")
}
