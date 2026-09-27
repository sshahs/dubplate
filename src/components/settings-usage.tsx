import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import type { AiUsageReport } from "@shared/types"
import { SettingRow, SettingRows } from "@/components/settings-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { api, type PublicSettings } from "@/lib/api"
import { fmtAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

function fmtTokens(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
  return String(n)
}

function fmtMoney(v: number | null, currency: string) {
  if (v === null) return "no price set"
  if (v === 0) return `${currency}0`
  return v < 0.01 ? `<${currency}0.01` : `${currency}${v.toFixed(2)}`
}

/** The last 30 days, one bar per day (days without calls are empty, not missing). */
function DailyBars({ report }: { report: AiUsageReport }) {
  const [hover, setHover] = useState<number | null>(null)
  const days = report.byDay.map((d) => ({ day: d.day, tokens: d.input + d.output, cost: d.cost, calls: d.calls }))
  const max = Math.max(1, ...days.map((d) => d.tokens))
  const h = hover === null ? null : days[hover]
  return (
    <figure className="space-y-2">
      <figcaption className="text-muted-foreground flex items-baseline justify-between text-xs">
        <span>Tokens a day, last 30 days</span>
        <span className="text-foreground tabular-nums">{h ? `${new Date(h.day).toLocaleDateString(undefined, { day: "numeric", month: "short" })}: ${fmtTokens(h.tokens)} tokens · ${h.calls} calls · ${fmtMoney(h.cost, report.currency)}` : `busiest: ${fmtTokens(max)}`}</span>
      </figcaption>
      <div className="relative flex h-24 items-end gap-0.5 border-b" onMouseLeave={() => setHover(null)} role="img" aria-label={`Tokens used each day for the last 30 days, up to ${fmtTokens(max)} a day`}>
        {days.map((d, i) => (
          // The whole column is the hover target; the bar is only as tall as the day was busy.
          <div key={d.day} className="flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)}>
            <div
              className={cn("bg-primary w-full rounded-t-[4px] transition-opacity", hover !== null && hover !== i && "opacity-40", !d.tokens && "bg-transparent")}
              style={{ height: d.tokens ? `${Math.max(3, (d.tokens / max) * 100)}%` : 0 }}
            />
          </div>
        ))}
      </div>
    </figure>
  )
}

/** This month's AI tokens and spend, the budget, and where the tokens went. */
export function AiUsageCard({ draft, set }: { draft: PublicSettings; set: (fn: (d: PublicSettings) => void) => void }) {
  const { data: r } = useQuery({ queryKey: ["ai-usage"], queryFn: api.aiUsage, refetchInterval: 60_000 })
  const cur = draft.llm.currency || "$"
  const budget = draft.llm.monthlyBudget
  const pct = r && budget > 0 ? Math.min(100, (r.monthCost / budget) * 100) : 0
  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage & cost</CardTitle>
        <CardDescription>Tokens are counted on every AI call. Costs are estimates from the prices you set on each provider above.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!r ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <div className="text-muted-foreground text-xs">This month</div>
                <div className="font-heading text-2xl font-extrabold tabular-nums">{fmtTokens(r.month.input + r.month.output)}</div>
                <div className="text-muted-foreground text-xs tabular-nums">
                  tokens in {r.month.calls} call{r.month.calls === 1 ? "" : "s"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Estimated cost</div>
                <div className="font-heading text-2xl font-extrabold tabular-nums">{fmtMoney(r.month.calls ? r.month.cost : 0, cur)}</div>
                <div className="text-muted-foreground text-xs">{r.byProvider.some((p) => !p.priced) ? "some calls have no price set" : "at today's prices"}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Budget</div>
                {budget > 0 ? (
                  <>
                    <div className="font-heading text-2xl font-extrabold tabular-nums">{Math.round(pct)}%</div>
                    <div className="bg-muted mt-1 h-1.5 overflow-hidden rounded-full" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Budget used">
                      <div className={cn("h-full rounded-full", pct >= 100 ? "bg-rasta-red" : pct >= 80 ? "bg-rasta-gold" : "bg-rasta-green")} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-muted-foreground mt-1 text-xs tabular-nums">
                      {fmtMoney(r.monthCost, cur)} of {cur}
                      {budget.toFixed(2)}
                      {pct >= 100 && " - AI off until next month"}
                    </div>
                  </>
                ) : (
                  <div className="text-muted-foreground mt-1 text-sm">No limit</div>
                )}
              </div>
            </div>

            <DailyBars report={r} />

            {r.byProvider.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="text-muted-foreground mb-2 text-left text-xs">This month by provider</caption>
                  <thead className="text-muted-foreground text-xs">
                    <tr className="text-left">
                      <th className="py-1 pr-3 font-medium">Provider</th>
                      <th className="py-1 pr-3 text-right font-medium">Calls</th>
                      <th className="py-1 pr-3 text-right font-medium">In</th>
                      <th className="py-1 pr-3 text-right font-medium">Out</th>
                      <th className="py-1 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {r.byProvider.map((p) => (
                      <tr key={`${p.providerId}-${p.model}`} className="border-t">
                        <td className="py-1.5 pr-3">
                          {p.label} <span className="text-muted-foreground font-mono text-xs">{p.model}</span>
                        </td>
                        <td className="py-1.5 pr-3 text-right">{p.calls}</td>
                        <td className="py-1.5 pr-3 text-right">{fmtTokens(p.input)}</td>
                        <td className="py-1.5 pr-3 text-right">{fmtTokens(p.output)}</td>
                        <td className={cn("py-1.5 text-right", !p.priced && "text-muted-foreground")}>{fmtMoney(p.cost, cur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {r.runs.length > 0 && (
              <div>
                <div className="text-muted-foreground mb-2 text-xs">Recent runs</div>
                <ul className="divide-y text-sm">
                  {r.runs.slice(0, 6).map((run) => (
                    <li key={run.jobId} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate">
                        {run.label} <span className="text-muted-foreground text-xs">{fmtAgo(run.at)}</span>
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {fmtTokens(run.input + run.output)} · {fmtMoney(run.cost, cur)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        <SettingRows>
          <SettingRow htmlFor="budget" title="Monthly budget" description="When this month's estimated spend reaches it, identifying carries on with the rule-based parser until the 1st. 0 = no limit.">
            <div className="flex items-center gap-2">
              <Input
                aria-label="Currency symbol"
                className="w-14 text-center"
                value={draft.llm.currency}
                maxLength={4}
                onChange={(e) => set((d) => void (d.llm.currency = e.target.value))}
              />
              <Input
                id="budget"
                type="number"
                min={0}
                step={1}
                className="w-28"
                value={draft.llm.monthlyBudget || ""}
                placeholder="0"
                onChange={(e) => set((d) => void (d.llm.monthlyBudget = Math.max(0, Number(e.target.value) || 0)))}
              />
            </div>
          </SettingRow>
        </SettingRows>
      </CardContent>
    </Card>
  )
}
