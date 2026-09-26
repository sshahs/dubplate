import { HugeiconsIcon } from "@hugeicons/react"
import { AiMagicIcon, CheckListIcon, FolderLibraryIcon, RefreshIcon, Scissor01Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useState, type CSSProperties } from "react"
import { Link } from "react-router"
import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from "recharts"
import { toast } from "sonner"
import { AnimatedNumber } from "@/components/animated-number"
import { DubplateMark, VuMeter } from "@/components/brand"
import { PageHeader } from "@/components/app-shell"
import { QueryError } from "@/components/query-error"
import { StatusBadge } from "@/components/confidence"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { useActiveJobs } from "@/lib/events"
import { fmtAgo } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { TrackStatus } from "@shared/types"

const BUCKET_COLOR: Record<string, string> = {
  "0–39": "var(--chart-1)",
  "40–59": "var(--chart-1)",
  "60–74": "var(--chart-2)",
  "75–89": "var(--chart-2)",
  "90–100": "var(--chart-3)",
}

const chartConfig = { count: { label: "Tracks" } } satisfies ChartConfig

function Stat({ label, value, tone, hint, to, index }: { label: string; value: number | undefined; tone: string; hint: string; to: string; index: number }) {
  return (
    <Link to={to} className="group animate-rise-in" style={{ "--stagger": index } as CSSProperties}>
      <Card className="group-hover:border-foreground/20 h-full transition-[border-color,translate,box-shadow] duration-300 group-hover:-translate-y-0.5 group-hover:shadow-lg">
        <CardContent className="space-y-1">
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
            <span className={cn("size-2 rounded-full", tone)} />
            {label}
          </div>
          <div className="font-heading text-3xl font-extrabold tabular-nums">{value === undefined ? <Skeleton className="h-9 w-16" /> : <AnimatedNumber value={value} from={0} />}</div>
          <div className="text-muted-foreground text-xs">{hint}</div>
        </CardContent>
      </Card>
    </Link>
  )
}

const FLOW: { status: TrackStatus[]; label: string }[] = [
  { status: ["new"], label: "Waiting" },
  { status: ["interpreted", "scoured"], label: "In progress" },
  { status: ["matched"], label: "Matched" },
  { status: ["review", "conflict"], label: "Review" },
  { status: ["unmatched"], label: "Unmatched" },
  { status: ["approved"], label: "Approved" },
  { status: ["done"], label: "Done" },
]

export default function DashboardPage() {
  const { data: stats, error: statsError, refetch: refetchStats } = useQuery({ queryKey: ["stats"], queryFn: api.stats })
  const { data: libraries } = useQuery({ queryKey: ["libraries"], queryFn: api.libraries })
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: api.health })
  const { data: jobs } = useQuery({ queryKey: ["jobs"], queryFn: api.jobs })
  const active = useActiveJobs()
  // Bars grow in once. Recharts re-tweens them on every resize, so during a sidebar slide they lagged
  // behind, overshot the card and hid their labels; after the first grow they redraw directly.
  const [barsGrown, setBarsGrown] = useState(false)

  const processNew = useMutation({
    mutationFn: () => api.process(null, {}),
    onSuccess: (j) => toast(j.label),
    onError: (e) => toast.error(e.message),
  })
  const scanAll = useMutation({
    mutationFn: api.scanAll,
    onSuccess: () => toast("Rescanning all libraries"),
    onError: (e) => toast.error(e.message),
  })

  const s = stats?.byStatus
  const noLibraries = libraries && libraries.length === 0

  if (noLibraries) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center py-16 text-center">
        <DubplateMark className="size-28 drop-shadow-2xl" spinning />
        <h1 className="mt-8 text-4xl font-extrabold">
          Welcome to <span className="rasta-text">Dubplate</span>
        </h1>
        <p className="text-muted-foreground mt-3 text-balance">
          Point it at a folder of badly named tunes. It reads every filename like a selector would, checks MusicBrainz, Discogs, Bandcamp and friends
          for consensus, and only renames what it's sure of - everything else waits for your ear.
        </p>
        <div className="mt-6 flex gap-2">
          <Button nativeButton={false} render={<Link to="/libraries" />} size="lg">
            <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} data-icon="inline-start" />
            Add your first library
          </Button>
          <Button variant="outline" size="lg" nativeButton={false} render={<Link to="/untangler" />}>
            Try the Untangler
          </Button>
        </div>
        <p className="text-muted-foreground mt-6 text-xs">Scanning is read-only. Nothing on disk changes until you approve it and switch off read-only mode.</p>
      </div>
    )
  }

  if (statsError && !stats) {
    return (
      <>
        <PageHeader eyebrow="The yard" title="Dashboard" description="Where your crates stand - from raw rips to properly credited tunes." />
        <QueryError error={statsError} onRetry={() => void refetchStats()} />
      </>
    )
  }

  const pipelineTotal = stats?.total || 1
  return (
    <>
      <PageHeader
        eyebrow="The yard"
        title="Dashboard"
        description="Where your crates stand - from raw rips to properly credited tunes."
        actions={
          <>
            <Button variant="outline" onClick={() => scanAll.mutate()} disabled={scanAll.isPending}>
              <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />
              Rescan
            </Button>
            <Button onClick={() => processNew.mutate()} disabled={processNew.isPending || !s?.new}>
              <HugeiconsIcon icon={AiMagicIcon} strokeWidth={2} data-icon="inline-start" />
              Process {s?.new ? `${s.new} new` : "new"}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat index={0} label="In staging" value={stats?.total} tone="bg-muted-foreground" hint={`${stats?.libraries ?? 0} libraries`} to="/tracks" />
        <Stat index={1} label="Matched" value={s?.matched} tone="bg-rasta-green" hint="High-confidence consensus" to="/tracks?status=matched" />
        <Stat index={2} label="Needs your ear" value={s ? s.review + s.conflict : undefined} tone="bg-rasta-gold" hint={`${s?.conflict ?? 0} conflicts`} to="/review" />
        <Stat index={3} label="Cut" value={s?.done} tone="bg-rasta-red" hint={`${s?.approved ?? 0} approved & waiting`} to="/execute" />
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Pipeline</CardTitle>
          <CardDescription>Scan → interpret → scour → score → review → cut</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
            {FLOW.map((f, i) => {
              const n = f.status.reduce((a, st) => a + (s?.[st] ?? 0), 0)
              if (!n) return null
              const colors = ["bg-muted-foreground/35", "bg-muted-foreground/65", "bg-chart-3/55", "bg-chart-2", "bg-chart-1", "bg-foreground/85", "bg-chart-3"]
              // Segments grow from nothing and glide as tracks move through the pipeline.
              return (
                <div
                  key={f.label}
                  className={cn(colors[i], "w-(--w) transition-[width] duration-700 ease-(--ease-out) starting:w-0")}
                  style={{ "--w": `${(n / pipelineTotal) * 100}%` } as CSSProperties}
                  title={`${f.label}: ${n}`}
                />
              )
            })}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 lg:grid-cols-7">
            {FLOW.map((f) => (
              <div key={f.label}>
                <div className="flex flex-wrap gap-1">
                  {f.status.map((st) => (
                    <StatusBadge key={st} status={st} />
                  ))}
                </div>
                <div className="mt-1 font-mono text-lg tabular-nums">
                  <AnimatedNumber value={f.status.reduce((a, st) => a + (s?.[st] ?? 0), 0)} />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Confidence spread</CardTitle>
            <CardDescription>Scored tracks by confidence band - green auto-matches, gold waits for review, red is guesswork.</CardDescription>
          </CardHeader>
          <CardContent>
            {stats ? (
              <ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
                <BarChart data={stats.confidenceBuckets} margin={{ top: 20, left: -18, right: 8 }} barCategoryGap={2}>
                  <CartesianGrid vertical={false} strokeOpacity={0.4} />
                  <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
                  <ChartTooltip cursor={{ fillOpacity: 0.06 }} content={<ChartTooltipContent hideIndicator />} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={56} stroke="var(--card)" strokeWidth={2} isAnimationActive={!barsGrown} onAnimationEnd={() => setBarsGrown(true)} animationDuration={600} animationEasing="ease-out">
                    {stats.confidenceBuckets.map((b) => (
                      <Cell key={b.bucket} fill={BUCKET_COLOR[b.bucket]} />
                    ))}
                    <LabelList dataKey="count" position="top" className="fill-muted-foreground" fontSize={11} />
                  </Bar>
                </BarChart>
              </ChartContainer>
            ) : (
              <Skeleton className="h-56 w-full" />
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Rig status</CardTitle>
            <CardDescription>What's powering the identification.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">AI interpreter</span>
              {health?.llm ? (
                <span className="min-w-0 truncate text-right text-xs font-medium" title={`${health.llm.label} · ${health.llm.model}`}>
                  {health.llm.label} · <span className="text-muted-foreground font-mono">{health.llm.model || "no model"}</span>
                </span>
              ) : (
                <Badge variant="destructive">none enabled</Badge>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Audio fingerprinting</span>
              <Badge variant={health?.fpcalc ? "secondary" : "outline"}>{health?.fpcalc ? "fpcalc ready" : "fpcalc not installed"}</Badge>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Duplicates by content</span>
              <Link to="/duplicates" className="font-mono hover:underline">
                {stats?.duplicates ?? 0} groups
              </Link>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Files written</span>
              <span className="font-mono">{stats?.operations ?? 0}</span>
            </div>
            <div className="border-t pt-3">
              <div className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">Top sources in consensus</div>
              {stats?.sources.length ? (
                <div className="space-y-1.5">
                  {stats.sources.slice(0, 6).map((src) => (
                    <div key={src.source} className="flex items-center gap-2 text-xs">
                      <span className="w-28 truncate">{src.source.replace(/^scraper:/, "")}</span>
                      <div className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
                        <div
                          className="bg-foreground/50 h-full w-(--w) rounded-full transition-[width] duration-700 ease-(--ease-out) starting:w-0"
                          style={{ "--w": `${(src.hits / stats.sources[0].hits) * 100}%` } as CSSProperties}
                        />
                      </div>
                      <span className="text-muted-foreground w-8 text-right font-mono">{src.hits}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground text-xs">No consensus data yet.</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Next moves</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Button variant="outline" className="justify-start" nativeButton={false} render={<Link to="/review" />}>
              <HugeiconsIcon icon={CheckListIcon} strokeWidth={2} data-icon="inline-start" />
              Review {s ? s.review + s.conflict : 0} tracks that need a human ear
            </Button>
            <Button variant="outline" className="justify-start" nativeButton={false} render={<Link to="/tracks?status=matched" />}>
              <HugeiconsIcon icon={AiMagicIcon} strokeWidth={2} data-icon="inline-start" />
              Approve {s?.matched ?? 0} high-confidence matches
            </Button>
            <Button variant="outline" className="justify-start" nativeButton={false} render={<Link to="/execute" />}>
              <HugeiconsIcon icon={Scissor01Icon} strokeWidth={2} data-icon="inline-start" />
              Cut & tag {s?.approved ?? 0} approved files
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent jobs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {active.map((j) => (
              <div key={j.id} className="animate-in fade-in slide-in-from-top-1 space-y-1 duration-300">
                <div className="flex items-center gap-2 text-sm">
                  <VuMeter className="h-3" />
                  <span className="flex-1 truncate">{j.label}</span>
                  <span className="text-muted-foreground font-mono text-xs">
                    {j.done + j.failed}/{j.total}
                  </span>
                </div>
                <Progress value={j.total ? ((j.done + j.failed) / j.total) * 100 : 0} />
              </div>
            ))}
            {jobs?.recent
              .filter((j) => !active.some((a) => a.id === j.id))
              .slice(0, 6)
              .map((j) => (
                <div key={j.id} className="animate-in fade-in flex items-center gap-2 text-sm duration-300">
                  <span className={cn("size-2 rounded-full", j.status === "done" ? "bg-rasta-green" : j.status === "failed" ? "bg-rasta-red" : "bg-muted-foreground")} />
                  <span className="flex-1 truncate">{j.label}</span>
                  <span className="text-muted-foreground text-xs">{fmtAgo(j.finishedAt ?? j.createdAt)}</span>
                </div>
              ))}
            {!active.length && !jobs?.recent.length && <div className="text-muted-foreground text-sm">No jobs yet.</div>}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
