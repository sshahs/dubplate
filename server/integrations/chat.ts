// Discord and Telegram messages: a long job finishing, or new tracks waiting
// for a listen, reach you wherever you are.

import type { Job, Settings } from "../../shared/types"
import type { JobOutcome } from "../jobs"
import { networkMessage } from "../net"

export interface ChatMessage {
  title: string
  lines: string[]
  /** a page in Dubplate to open, e.g. "/review" (only sent when Dubplate's address is set) */
  link?: { label: string; path: string }
  tone: "ok" | "warn" | "error"
}

export type ChatChannel = "discord" | "telegram"

const COLORS = { ok: 0x1f9d55, warn: 0xf4c20d, error: 0xd62f2f }
const TIMEOUT_MS = 10_000
/** Jobs quicker than this aren't worth a message unless they changed files or failed. */
const LONG_JOB_MS = 30_000
const FILE_JOBS = new Set<Job["kind"]>(["execute", "rewind", "organise", "duplicates"])

export function chatChannels(settings: Settings): ChatChannel[] {
  const { discord, telegram } = settings.integrations
  const out: ChatChannel[] = []
  if (discord.enabled && discord.webhookUrl) out.push("discord")
  if (telegram.enabled && telegram.botToken && telegram.chatId) out.push("telegram")
  return out
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function linkUrl(settings: Settings, path: string) {
  const base = settings.integrations.publicUrl
  return base ? `${base}${path}` : undefined
}

async function post(url: string, body: unknown) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) })
}

async function sendOne(settings: Settings, channel: ChatChannel, msg: ChatMessage): Promise<{ channel: ChatChannel; ok: boolean; message: string }> {
  const url = msg.link ? linkUrl(settings, msg.link.path) : undefined
  try {
    if (channel === "discord") {
      const res = await post(settings.integrations.discord.webhookUrl!, {
        username: "Dubplate",
        embeds: [{ title: msg.title, description: msg.lines.join("\n") || undefined, color: COLORS[msg.tone], url }],
      })
      if (!res.ok) return { channel, ok: false, message: res.status === 404 ? "Discord doesn't know that webhook - was it deleted?" : `Discord replied ${res.status}` }
      return { channel, ok: true, message: "Sent" }
    }
    const { botToken, chatId } = settings.integrations.telegram
    const text = [`<b>${escapeHtml(msg.title)}</b>`, ...msg.lines.map(escapeHtml), ...(url && msg.link ? [`<a href="${escapeHtml(url)}">${escapeHtml(msg.link.label)}</a>`] : [])].join("\n")
    const res = await post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
    const j = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null
    if (!res.ok || !j?.ok) return { channel, ok: false, message: j?.description ? `Telegram: ${j.description}` : `Telegram replied ${res.status}` }
    return { channel, ok: true, message: "Sent" }
  } catch (err) {
    return { channel, ok: false, message: networkMessage(err) }
  }
}

export async function sendChat(settings: Settings, msg: ChatMessage, only?: ChatChannel) {
  const channels = chatChannels(settings).filter((c) => !only || c === only)
  return Promise.all(channels.map((c) => sendOne(settings, c, msg)))
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What to say (if anything) about a job that just finished. */
export function messageForJob(job: Job, outcome: JobOutcome, settings: Settings): ChatMessage | null {
  if (!chatChannels(settings).length || job.status === "cancelled") return null
  const { notify } = settings.integrations
  const ran = job.startedAt && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : 0
  const review = outcome.report?.review ?? 0
  const failed = job.status === "failed"
  const changedFiles = FILE_JOBS.has(job.kind) && outcome.filesChanged
  const wantReview = notify.review && job.kind === "process" && job.status === "done" && review > 0
  const wantJob = notify.jobs && (failed || ran >= LONG_JOB_MS || changedFiles)
  if (!wantReview && !wantJob) return null

  const lines: string[] = []
  const r = outcome.report
  if (failed) lines.push(job.message ?? "It stopped with an error.")
  else if (r && job.kind === "process") {
    const parts = [r.matched && `${r.matched} matched`, r.approved && `${r.approved} approved`, review && `${review} to review`, r.unmatched && `${r.unmatched} unmatched`].filter(Boolean)
    if (parts.length) lines.push(parts.join(" · "))
  } else lines.push(`${job.done} done${job.failed ? ` · ${job.failed} failed` : ""}`)
  if (wantReview && !failed) lines.push(`${plural(review, "track")} need${review === 1 ? "s" : ""} a listen in Review.`)

  const title = failed ? `Failed: ${job.label}` : wantJob ? `Done: ${job.label}` : `${plural(review, "track")} to review`
  const link = review && !failed ? { label: "Open Review", path: "/review" } : FILE_JOBS.has(job.kind) ? { label: "Open Cut & Tag", path: "/execute" } : { label: "Open Dubplate", path: "/" }
  return { title, lines, link, tone: failed ? "error" : job.failed ? "warn" : "ok" }
}
