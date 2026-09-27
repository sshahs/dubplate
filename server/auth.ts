// An optional single password in front of the whole app. The hash lives in the
// settings table under its own key (never in the settings JSON, so backups don't
// carry it); sessions are signed cookies, and changing the password - or signing
// out everywhere - invalidates every one of them.

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import type { AuthStatus } from "../shared/types"
import { getDb, parseJson } from "./db"

export const SESSION_COOKIE = "dubplate_session"
export const SESSION_DAYS = 30

interface AuthRecord {
  /** signs session cookies */
  secret: string
  /** bumped to sign everyone out */
  generation: number
  salt?: string
  hash?: string
  updatedAt?: string
}

/** DUBPLATE_PASSWORD wins over a password set in the app. */
export function passwordFromEnv(): string | undefined {
  const p = process.env.DUBPLATE_PASSWORD
  return p ? p : undefined
}

function load(): AuthRecord {
  const row = getDb().prepare("SELECT value_json FROM settings WHERE key = 'auth'").get() as { value_json: string } | undefined
  const rec = parseJson<AuthRecord | null>(row?.value_json, null)
  if (rec?.secret) return rec
  const fresh: AuthRecord = { secret: randomBytes(32).toString("hex"), generation: 1 }
  save(fresh)
  return fresh
}

function save(rec: AuthRecord) {
  getDb()
    .prepare("INSERT INTO settings (key, value_json) VALUES ('auth', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(JSON.stringify(rec))
}

function scrypt(password: string, salt: string) {
  return scryptSync(password.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex")
}

export function authEnabled(): boolean {
  return !!passwordFromEnv() || !!load().hash
}

/** Changes whenever the password does, so old cookies stop working. */
function passwordStamp(rec: AuthRecord): string {
  const env = passwordFromEnv()
  return createHash("sha256")
    .update(env ? `env:${env}` : `db:${rec.hash ?? ""}`)
    .digest("hex")
    .slice(0, 16)
}

export function checkPassword(password: string): boolean {
  const env = passwordFromEnv()
  if (env) {
    const a = createHash("sha256").update(password).digest()
    const b = createHash("sha256").update(env).digest()
    return timingSafeEqual(a, b)
  }
  const rec = load()
  if (!rec.hash || !rec.salt) return false
  const got = Buffer.from(scrypt(password, rec.salt), "hex")
  const want = Buffer.from(rec.hash, "hex")
  return got.length === want.length && timingSafeEqual(got, want)
}

export const MIN_PASSWORD = 8

/** Set (or replace) the password; everyone signed in is signed out. */
export function setPassword(password: string) {
  if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters`)
  const rec = load()
  const salt = randomBytes(16).toString("hex")
  save({ ...rec, salt, hash: scrypt(password, salt), generation: rec.generation + 1, updatedAt: new Date().toISOString() })
}

export function removePassword() {
  const rec = load()
  save({ secret: rec.secret, generation: rec.generation + 1 })
}

export function signOutEverywhere() {
  const rec = load()
  save({ ...rec, generation: rec.generation + 1 })
}

function sign(rec: AuthRecord, body: string) {
  return createHmac("sha256", rec.secret).update(`${body}.${passwordStamp(rec)}`).digest("base64url")
}

/** A cookie value good for SESSION_DAYS. */
export function issueSession(now = Date.now()): string {
  const rec = load()
  const body = `${Math.floor(now / 1000) + SESSION_DAYS * 86400}.${rec.generation}`
  return `${body}.${sign(rec, body)}`
}

export function validSession(value: string | undefined, now = Date.now()): boolean {
  if (!value) return false
  const [exp, gen, sig] = value.split(".")
  if (!exp || !gen || !sig) return false
  const rec = load()
  if (Number(gen) !== rec.generation || Number(exp) * 1000 < now) return false
  const want = Buffer.from(sign(rec, `${exp}.${gen}`))
  const got = Buffer.from(sig)
  return got.length === want.length && timingSafeEqual(got, want)
}

export function authStatus(cookie: string | undefined): AuthStatus {
  const enabled = authEnabled()
  return { enabled, authenticated: !enabled || validSession(cookie), fromEnv: !!passwordFromEnv() }
}

// ---- guessing ----

const MAX_FAILS = 5
const LOCK_MS = 60_000
const attempts = new Map<string, { fails: number; lockedUntil: number }>()

/** Milliseconds this address must wait before trying again (0 = go ahead). */
export function lockedFor(who: string, now = Date.now()): number {
  const a = attempts.get(who)
  return a && a.lockedUntil > now ? a.lockedUntil - now : 0
}

export function recordAttempt(who: string, ok: boolean, now = Date.now()) {
  if (ok) {
    attempts.delete(who)
    return
  }
  const a = attempts.get(who) ?? { fails: 0, lockedUntil: 0 }
  a.fails++
  // Every fifth wrong guess in a row locks the address out for a minute, doubling each time.
  if (a.fails % MAX_FAILS === 0) a.lockedUntil = now + LOCK_MS * 2 ** (a.fails / MAX_FAILS - 1)
  attempts.set(who, a)
  if (attempts.size > 1000) attempts.delete(attempts.keys().next().value!)
}

export function resetAttemptsForTests() {
  attempts.clear()
}
