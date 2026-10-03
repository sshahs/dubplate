// What the AI costs: every call's token counts, booked against the job that made
// it, priced with what you enter per provider. A monthly budget switches the AI
// off (the rule-based parser carries on) once estimated spend reaches it.

import { AsyncLocalStorage } from "node:async_hooks"
import type { AiUsageReport, LlmProviderConfig, Settings, UsageTotals } from "../../shared/types"
import { getDb } from "../db"
import { currentJobId } from "../jobs"

export interface TokenCounts {
  input: number
  output: number
}

/** The call being made, so its token counts can go in the log line about it. */
export const callTokens = new AsyncLocalStorage<{ tokens?: TokenCounts }>()

export function recordUsage(p: LlmProviderConfig, t: TokenCounts) {
  const call = callTokens.getStore()
  if (call) call.tokens = t
  if (!t.input && !t.output) return
  getDb()
    .prepare("INSERT INTO ai_usage (provider_id, model, input_tokens, output_tokens, job_id) VALUES (?, ?, ?, ?, ?)")
    .run(p.id, p.model, Math.max(0, Math.round(t.input)), Math.max(0, Math.round(t.output)), currentJobId())
  spendCache = null
}

/** Prices per million tokens; a local Ollama costs nothing unless you say otherwise. */
function pricesFor(p: LlmProviderConfig | undefined): { in: number; out: number } | null {
  if (!p) return null
  if (p.priceIn !== undefined || p.priceOut !== undefined) return { in: p.priceIn ?? 0, out: p.priceOut ?? 0 }
  return p.kind === "ollama" ? { in: 0, out: 0 } : null
}

function costOf(p: LlmProviderConfig | undefined, input: number, output: number): number | null {
  const price = pricesFor(p)
  return price ? (input * price.in + output * price.out) / 1e6 : null
}

type Row = { provider_id: string; model?: string; input: number; output: number; calls: number }

function totals(rows: Row[], settings: Settings): UsageTotals {
  const byId = new Map(settings.llm.providers.map((p) => [p.id, p]))
  let cost: number | null = null
  const out: UsageTotals = { input: 0, output: 0, calls: 0, cost: null }
  for (const r of rows) {
    out.input += r.input
    out.output += r.output
    out.calls += r.calls
    const c = costOf(byId.get(r.provider_id), r.input, r.output)
    if (c !== null) cost = (cost ?? 0) + c
  }
  out.cost = cost
  return out
}

const MONTH = "at >= datetime('now', 'start of month')"

function monthRows(): Row[] {
  return getDb()
    .prepare(`SELECT provider_id, SUM(input_tokens) AS input, SUM(output_tokens) AS output, COUNT(*) AS calls FROM ai_usage WHERE ${MONTH} GROUP BY provider_id`)
    .all() as Row[]
}

let spendCache: { at: number; value: number } | null = null

/** Estimated spend this calendar month (UTC), at today's prices. */
export function monthSpend(settings: Settings): number {
  if (spendCache && Date.now() - spendCache.at < 10_000) return spendCache.value
  const value = totals(monthRows(), settings).cost ?? 0
  spendCache = { at: Date.now(), value }
  return value
}

/** The monthly budget is set and used up. */
export function overBudget(settings: Settings): boolean {
  return settings.llm.monthlyBudget > 0 && monthSpend(settings) >= settings.llm.monthlyBudget
}

export function usageReport(settings: Settings): AiUsageReport {
  const db = getDb()
  const byId = new Map(settings.llm.providers.map((p) => [p.id, p]))
  const month = monthRows()
  const providerRows = db
    .prepare(
      `SELECT provider_id, model, SUM(input_tokens) AS input, SUM(output_tokens) AS output, COUNT(*) AS calls FROM ai_usage WHERE ${MONTH} GROUP BY provider_id, model ORDER BY input + output DESC`
    )
    .all() as Row[]
  const days = db
    .prepare(
      `SELECT date(at) AS day, provider_id, SUM(input_tokens) AS input, SUM(output_tokens) AS output, COUNT(*) AS calls FROM ai_usage WHERE at >= datetime('now', '-29 days', 'start of day') GROUP BY day, provider_id ORDER BY day`
    )
    .all() as (Row & { day: string })[]
  const byDay = new Map<string, Row[]>()
  for (const d of days) byDay.set(d.day, [...(byDay.get(d.day) ?? []), d])
  const runs = db
    .prepare(
      `SELECT u.job_id AS job_id, coalesce(j.label, 'A run') AS label, MIN(u.at) AS at, u.provider_id AS provider_id, SUM(u.input_tokens) AS input, SUM(u.output_tokens) AS output, COUNT(*) AS calls
       FROM ai_usage u LEFT JOIN jobs j ON j.id = u.job_id WHERE u.job_id IS NOT NULL GROUP BY u.job_id, u.provider_id ORDER BY at DESC LIMIT 40`
    )
    .all() as (Row & { job_id: string; label: string; at: string })[]
  const runMap = new Map<string, { label: string; at: string; rows: Row[] }>()
  for (const r of runs) {
    const e = runMap.get(r.job_id) ?? { label: r.label, at: r.at, rows: [] }
    e.rows.push(r)
    if (r.at < e.at) e.at = r.at
    runMap.set(r.job_id, e)
  }
  return {
    currency: settings.llm.currency,
    budget: settings.llm.monthlyBudget,
    monthCost: totals(month, settings).cost ?? 0,
    month: totals(month, settings),
    byProvider: providerRows.map((r) => {
      const p = byId.get(r.provider_id)
      return { providerId: r.provider_id, label: p?.label ?? r.provider_id, model: r.model ?? "", priced: !!pricesFor(p), ...totals([r], settings) }
    }),
    // Every one of the last 30 days, quiet ones included, oldest first.
    byDay: Array.from({ length: 30 }, (_, i) => {
      const day = new Date(Date.now() - (29 - i) * 86400_000).toISOString().slice(0, 10)
      return { day, ...totals(byDay.get(day) ?? [], settings) }
    }),
    runs: [...runMap.entries()].slice(0, 12).map(([jobId, e]) => ({ jobId, label: e.label, at: e.at, ...totals(e.rows, settings) })),
  }
}
