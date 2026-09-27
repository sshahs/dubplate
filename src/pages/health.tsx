import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, AlertCircleIcon, ArrowRight02Icon, CheckmarkCircle02Icon, InformationCircleIcon, RefreshIcon } from "@hugeicons/core-free-icons"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router"
import type { CheckStatus, HealthCheck, HealthReport } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { QueryError } from "@/components/query-error"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { fmtAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

const STATUS: Record<CheckStatus, { icon: typeof Alert02Icon; tone: string; word: string }> = {
  ok: { icon: CheckmarkCircle02Icon, tone: "text-rasta-green", word: "OK" },
  warn: { icon: Alert02Icon, tone: "text-rasta-gold", word: "Needs a look" },
  error: { icon: AlertCircleIcon, tone: "text-rasta-red", word: "Problem" },
  info: { icon: InformationCircleIcon, tone: "text-muted-foreground", word: "Note" },
}

const GROUPS: HealthCheck["group"][] = ["Server", "Security", "Libraries", "AI", "Sources", "Integrations"]

function uptime(sec: number) {
  if (sec < 3600) return `${Math.round(sec / 60)} min`
  if (sec < 86400) return `${Math.round(sec / 3600)} h`
  return `${Math.round(sec / 86400)} days`
}

function Row({ c }: { c: HealthCheck }) {
  const s = STATUS[c.status]
  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <HugeiconsIcon icon={s.icon} strokeWidth={2} className={cn("mt-0.5 size-4.5 shrink-0", s.tone)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{c.label}</span>
          <span className={cn("text-xs", s.tone)}>{s.word}</span>
        </div>
        <p className="text-muted-foreground text-sm text-pretty break-words">{c.detail}</p>
      </div>
      {c.fix && (
        <Button variant="ghost" size="sm" className="shrink-0" nativeButton={false} render={<Link to={c.fix.to} />}>
          {c.fix.label}
          <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} data-icon="inline-end" />
        </Button>
      )}
    </li>
  )
}

function Summary({ report }: { report: HealthReport }) {
  const errors = report.checks.filter((c) => c.status === "error").length
  const warns = report.checks.filter((c) => c.status === "warn").length
  const tone = errors ? "border-rasta-red/40 bg-rasta-red/8" : warns ? "border-rasta-gold/40 bg-rasta-gold/8" : "border-rasta-green/40 bg-rasta-green/8"
  const icon = errors ? AlertCircleIcon : warns ? Alert02Icon : CheckmarkCircle02Icon
  const text = errors
    ? `${errors} problem${errors === 1 ? "" : "s"}${warns ? ` and ${warns} thing${warns === 1 ? "" : "s"} to look at` : ""}`
    : warns
      ? `${warns} thing${warns === 1 ? "" : "s"} to look at`
      : "Everything's running as it should"
  return (
    <div role="status" className={cn("mb-4 flex items-center gap-3 rounded-3xl border p-4", tone)}>
      <HugeiconsIcon icon={icon} strokeWidth={2} className={cn("size-6 shrink-0", errors ? "text-rasta-red" : warns ? "text-rasta-gold" : "text-rasta-green")} />
      <div>
        <div className="font-medium">{text}</div>
        <div className="text-muted-foreground text-xs">Checked {fmtAgo(report.checkedAt)}</div>
      </div>
    </div>
  )
}

export default function HealthPage() {
  const qc = useQueryClient()
  const { data, error, refetch, isFetching } = useQuery({ queryKey: ["health-checks"], queryFn: () => api.healthChecks() })
  const again = () => void qc.fetchQuery({ queryKey: ["health-checks"], queryFn: () => api.healthChecks(true) })
  return (
    <>
      <PageHeader
        eyebrow="Soundcheck"
        title="Health"
        description="Everything Dubplate depends on, checked in one go: its data folder, your libraries, the AI, the sources and anything it talks to."
        actions={
          <Button variant="outline" onClick={again} disabled={isFetching}>
            {isFetching ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />}
            Check again
          </Button>
        }
      />
      {error ? (
        <QueryError error={error} onRetry={() => void refetch()} />
      ) : !data ? (
        <div className="space-y-4">
          <Skeleton className="h-20 rounded-3xl" />
          <div className="grid gap-4 lg:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-44 rounded-4xl" />
            ))}
          </div>
        </div>
      ) : (
        <>
          <Summary report={data} />
          <div className="grid gap-4 lg:grid-cols-2">
            {GROUPS.map((g) => {
              const checks = data.checks.filter((c) => c.group === g)
              if (!checks.length) return null
              return (
                <Card key={g}>
                  <CardHeader>
                    <CardTitle>{g}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="divide-border/70 divide-y">
                      {checks.map((c) => (
                        <Row key={c.id} c={c} />
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )
            })}
          </div>
          <dl className="text-muted-foreground mt-6 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["Dubplate", data.system.version],
              ["Node", data.system.node],
              ["Running for", uptime(data.system.uptimeSec)],
              ["Memory", `${data.system.memoryMb} MB`],
              ["Database", `${data.system.dbMb} MB`],
              ["System", data.system.platform],
            ].map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt>{k}</dt>
                <dd className="text-foreground truncate font-mono" title={v}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </>
  )
}
