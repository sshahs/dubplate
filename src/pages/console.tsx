import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowDownDoubleIcon,
  ArrowRight01Icon,
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  Download04Icon,
  MusicNote03Icon,
  PauseIcon,
  PlayIcon,
  Search01Icon,
  Settings02Icon,
  SquareArrowUpRightIcon,
} from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useSearchParams } from "react-router"
import { toast } from "sonner"
import { LOG_AREAS, LOG_LEVELS, type LogArea, type LogEntry, type LogLevel } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { DubplateMark } from "@/components/brand"
import { QueryError } from "@/components/query-error"
import { TrackDetail } from "@/components/track-detail"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { useDebounced } from "@/hooks/use-debounced"
import { api, type LogFilter } from "@/lib/api"
import { useLive } from "@/lib/events"
import { fmtAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

const LEVEL: Record<LogLevel, { label: string; tag: string; dot: string; tagClass: string; row?: string; text?: string }> = {
  debug: { label: "Detail", tag: "detail", dot: "bg-muted-foreground/45", tagClass: "text-muted-foreground/70", text: "text-muted-foreground" },
  info: { label: "Info", tag: "info", dot: "bg-foreground/70", tagClass: "text-muted-foreground" },
  success: { label: "Done", tag: "done", dot: "bg-rasta-green", tagClass: "text-rasta-green" },
  warn: { label: "Warnings", tag: "warn", dot: "bg-rasta-gold", tagClass: "text-rasta-gold", row: "bg-rasta-gold/6 border-l-rasta-gold" },
  error: { label: "Errors", tag: "error", dot: "bg-rasta-red", tagClass: "text-rasta-red", row: "bg-rasta-red/8 border-l-rasta-red" },
}

const AREA: Record<LogArea, { label: string; tag: string; hint: string }> = {
  jobs: { label: "Jobs", tag: "jobs", hint: "Each job starting, finishing, failing or being cancelled" },
  scan: { label: "Scanning", tag: "scan", hint: "Files found, read again, moved or gone" },
  identify: { label: "Identifying", tag: "identify", hint: "How each track was read and decided" },
  sources: { label: "Sources", tag: "sources", hint: "What every source answered for each track" },
  http: { label: "Web requests", tag: "web", hint: "Every request to a website or API, with its answer and timing" },
  ai: { label: "AI", tag: "ai", hint: "Every AI call: model, time, tokens and the answer" },
  files: { label: "Files", tag: "files", hint: "Renames, moves, tags written and rewinds" },
  analysis: { label: "Audio analysis", tag: "analysis", hint: "BPM, key, loudness and quality checks" },
  automation: { label: "Automation", tag: "auto", hint: "Watched folders, the nightly scan and download tools" },
  integrations: { label: "Integrations", tag: "integrations", hint: "Media servers, Discord and Telegram" },
  server: { label: "Server", tag: "server", hint: "Start-ups, API errors and anything else the server reports" },
}

const KEEP_DAYS = [1, 3, 7, 14, 30, 90, 365]
const PAGE = 500
/** Lines held on screen while following; scrolled up, more are kept so nothing shifts under you. */
const MAX_LINES = 5_000
const MAX_LINES_READING = 20_000
const LEVELS_KEY = "dubplate-console-levels"

const isLevel = (v: string): v is LogLevel => (LOG_LEVELS as string[]).includes(v)
const isArea = (v: string): v is LogArea => (LOG_AREAS as string[]).includes(v)

function readFilter(p: URLSearchParams): LogFilter {
  const track = Number(p.get("track"))
  return {
    levels: p.get("levels")?.split(",").filter(isLevel),
    areas: p.get("areas")?.split(",").filter(isArea),
    job: p.get("job") || undefined,
    track: Number.isInteger(track) && track > 0 ? track : undefined,
    q: p.get("q") || undefined,
  }
}

/** The same test the server applies, for lines arriving live. */
function matches(e: LogEntry, f: LogFilter): boolean {
  if (f.levels?.length && !f.levels.includes(e.level)) return false
  if (f.areas?.length && !f.areas.includes(e.area)) return false
  if (f.job && e.jobId !== f.job) return false
  if (f.track && e.trackId !== f.track) return false
  const q = f.q?.trim().toLowerCase()
  if (q && !e.message.toLowerCase().includes(q) && !e.detail?.toLowerCase().includes(q)) return false
  return true
}

const WORD: Record<LogLevel, string> = { debug: "DETAIL", info: "INFO", success: "DONE", warn: "WARN", error: "ERROR" }

/** As the downloaded log writes it. */
function asText(e: LogEntry): string {
  const head = `${e.at} ${WORD[e.level].padEnd(6)} ${e.area.padEnd(12)} ${e.message}${e.jobLabel && e.area !== "jobs" ? `  [${e.jobLabel}]` : ""}${e.trackId ? `  (track ${e.trackId})` : ""}`
  return e.detail ? `${head}\n${e.detail.replace(/^/gm, "    ")}` : head
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" })
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" })

function clock(iso: string) {
  const d = new Date(iso)
  return `${timeFmt.format(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`
}

const dayOf = (iso: string) => new Date(iso).toDateString()

function Highlight({ text, q }: { text: string; q?: string }): ReactNode {
  const needle = q?.trim()
  if (!needle) return text
  const parts = text.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"))
  return parts.map((part, i) =>
    i % 2 ? (
      <mark key={i} className="bg-rasta-gold/35 text-foreground rounded-[3px] px-px">
        {part}
      </mark>
    ) : (
      part
    )
  )
}

function copy(text: string, what = "Copied") {
  navigator.clipboard.writeText(text).then(
    () => toast.success(what),
    () => toast.error("Couldn't copy - the browser said no")
  )
}

const Line = memo(function Line({
  e,
  day,
  open,
  q,
  onToggle,
  onJob,
  onTrack,
}: {
  e: LogEntry
  /** the date, when this is the first line of a new day */
  day: string | null
  open: boolean
  q?: string
  onToggle: (id: number) => void
  onJob: (id: string) => void
  onTrack: (id: number) => void
}) {
  const lv = LEVEL[e.level]
  return (
    <div>
      {day && (
        <div className="text-muted-foreground flex items-center gap-3 px-3 pt-3 pb-1.5 font-sans text-[11px] font-semibold tracking-wide uppercase">
          <span>{day}</span>
          <span className="bg-border h-px flex-1" />
        </div>
      )}
      <div className={cn("group/line border-l-2 border-l-transparent", lv.row, open && "bg-muted/50")}>
        <div className="flex flex-wrap items-start gap-x-3 gap-y-0.5 px-3 py-1 sm:flex-nowrap">
          <time dateTime={e.at} title={fullFmt.format(new Date(e.at))} className="text-muted-foreground/70 w-[5.75rem] shrink-0 tabular-nums">
            {clock(e.at)}
          </time>
          <span className={cn("w-11 shrink-0 font-semibold", lv.tagClass)}>{lv.tag}</span>
          <span className="text-muted-foreground w-[5.5rem] shrink-0 truncate" title={AREA[e.area]?.label}>
            {AREA[e.area]?.tag ?? e.area}
          </span>
          <div className="flex min-w-0 basis-full items-start gap-1.5 sm:basis-auto sm:flex-1">
            {e.detail ? (
              <button
                type="button"
                onClick={() => onToggle(e.id)}
                aria-expanded={open}
                className={cn("hover:text-foreground min-w-0 flex-1 text-left break-words whitespace-pre-wrap", lv.text)}
              >
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2.5}
                  className={cn("text-muted-foreground mr-1 -ml-0.5 inline size-3 align-[-1px] transition-transform duration-150", open && "rotate-90")}
                  aria-hidden
                />
                <Highlight text={e.message} q={q} />
              </button>
            ) : (
              <span className={cn("min-w-0 flex-1 break-words whitespace-pre-wrap", lv.text)}>
                <Highlight text={e.message} q={q} />
              </span>
            )}
            <span className="flex shrink-0 items-center gap-1">
              {e.trackId && (
                <button
                  type="button"
                  onClick={() => onTrack(e.trackId!)}
                  className="bg-muted text-muted-foreground hover:text-foreground inline-flex h-5 items-center gap-1 rounded-full px-1.5 font-sans text-[10px]"
                  title="Open the track"
                >
                  <HugeiconsIcon icon={MusicNote03Icon} strokeWidth={2} className="size-3" />
                  {e.trackId}
                </button>
              )}
              {e.jobId && e.area !== "jobs" && (
                <button
                  type="button"
                  onClick={() => onJob(e.jobId!)}
                  className="bg-muted text-muted-foreground hover:text-foreground hidden h-5 max-w-40 items-center rounded-full px-2 font-sans text-[10px] md:inline-flex"
                  title={`Only lines from “${e.jobLabel ?? "this job"}”`}
                >
                  <span className="truncate">{e.jobLabel ?? "job"}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => copy(asText(e), "Line copied")}
                className="text-muted-foreground hover:text-foreground inline-flex size-5 items-center justify-center rounded-md opacity-0 transition-opacity group-hover/line:opacity-100 focus-visible:opacity-100 max-sm:opacity-60"
                aria-label="Copy this line"
              >
                <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} className="size-3" />
              </button>
            </span>
          </div>
        </div>
        {open && e.detail && (
          <pre className="text-foreground/85 mx-3 mb-2 overflow-x-auto rounded-xl border bg-black/[0.03] px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap sm:ml-[13.25rem] dark:bg-white/[0.03]">
            <Highlight text={e.detail} q={q} />
          </pre>
        )}
      </div>
    </div>
  )
})

function LogSettings({ detail, keepDays, total, oldest }: { detail: boolean; keepDays: number; total: number; oldest: string | null }) {
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (logs: { detail?: boolean; keepDays?: number }) => api.saveSettings({ logs }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["log-summary"] })
      void qc.invalidateQueries({ queryKey: ["settings"] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't save"),
  })
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" aria-label="Log settings" />}>
        <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} data-icon="inline-start" />
        <span className="hidden sm:inline">Settings</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,22rem)] space-y-4 p-4">
        <label className="flex items-start justify-between gap-4">
          <span className="space-y-1">
            <span className="block text-sm font-medium">Step-by-step detail</span>
            <span className="text-muted-foreground block text-xs">Every web request, what each source answered, how each track was read and decided, and every file change.</span>
          </span>
          <Switch checked={detail} disabled={save.isPending} onCheckedChange={(v) => save.mutate({ detail: v })} />
        </label>
        <div className="flex items-center justify-between gap-4">
          <span className="space-y-1">
            <span className="block text-sm font-medium">Keep lines for</span>
            <span className="text-muted-foreground block text-xs">Older lines are trimmed every hour.</span>
          </span>
          <Select items={KEEP_DAYS.map((d) => ({ value: String(d), label: d === 1 ? "1 day" : `${d} days` }))} value={String(keepDays)} onValueChange={(v) => save.mutate({ keepDays: Number(v) })}>
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KEEP_DAYS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d === 1 ? "1 day" : `${d} days`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-muted-foreground border-t pt-3 text-xs">
          {total.toLocaleString()} line{total === 1 ? "" : "s"} kept{oldest ? `, the oldest from ${fmtAgo(oldest)}` : ""}. The server also prints them; set <code className="font-mono">DUBPLATE_LOG_LEVEL</code> to choose how much.
        </p>
      </PopoverContent>
    </Popover>
  )
}

export default function ConsolePage({ standalone = false }: { standalone?: boolean }) {
  const qc = useQueryClient()
  const { onLog, connected, jobs: liveJobs } = useLive()
  const [params, setParams] = useSearchParams()
  const [qInput, setQInput] = useState(params.get("q") ?? "")
  const q = useDebounced(qInput, 250)
  const searchRef = useRef<HTMLInputElement>(null)

  // Which levels were shown last time, when the address doesn't say.
  useEffect(() => {
    if (params.has("levels")) return
    let saved: string | null = null
    try {
      saved = localStorage.getItem(LEVELS_KEY)
    } catch {
      // private window: start with every level
    }
    const levels = saved?.split(",").filter(isLevel)
    if (levels?.length && levels.length < LOG_LEVELS.length) setParams((p) => (p.set("levels", levels.join(",")), p), { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setParams(
      (p) => {
        if (q.trim()) p.set("q", q.trim())
        else p.delete("q")
        return p
      },
      { replace: true }
    )
  }, [q, setParams])

  const filter = useMemo(() => readFilter(params), [params])
  const filterKey = JSON.stringify(filter)
  const filterRef = useRef(filter)
  filterRef.current = filter
  const filtered = !!(filter.levels?.length || filter.areas?.length || filter.job || filter.track || filter.q)

  const setParam = (key: string, value: string | null) =>
    setParams((p) => {
      if (value) p.set(key, value)
      else p.delete(key)
      return p
    })

  const toggleLevel = (level: LogLevel) => {
    const on = new Set(filter.levels?.length ? filter.levels : LOG_LEVELS)
    if (on.has(level)) on.delete(level)
    else on.add(level)
    const next = LOG_LEVELS.filter((l) => on.has(l))
    const all = next.length === LOG_LEVELS.length || next.length === 0
    try {
      localStorage.setItem(LEVELS_KEY, all ? "" : next.join(","))
    } catch {
      // not remembered, that's all
    }
    setParam("levels", all ? null : next.join(","))
  }

  const summary = useQuery({ queryKey: ["log-summary", filterKey], queryFn: () => api.logSummary(filter), refetchInterval: 8_000 })

  // ---- the lines ----
  const [log, setLog] = useState<{ entries: LogEntry[]; older: boolean }>({ entries: [], older: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [reload, setReload] = useState(0)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [paused, setPaused] = useState(false)
  const [waiting, setWaiting] = useState(0)
  const [follow, setFollow] = useState(true)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [trackOpen, setTrackOpen] = useState<number | null>(null)
  const pending = useRef<LogEntry[]>([])
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const loadingRef = useRef(true)
  const followRef = useRef(follow)
  followRef.current = follow

  /** New lines onto the end: no repeats, never older than what's shown, trimmed from the top. */
  const append = useCallback((add: LogEntry[]) => {
    if (!add.length) return
    setLog((prev) => {
      const last = prev.entries.at(-1)?.id ?? 0
      const seen = new Set(prev.entries.map((e) => e.id))
      const fresh = add.filter((e) => (e.id > 0 ? e.id > last : !seen.has(e.id)) && !seen.has(e.id))
      if (!fresh.length) return prev
      let entries = [...prev.entries, ...fresh]
      const max = followRef.current ? MAX_LINES : MAX_LINES_READING
      const over = entries.length - max
      if (over > 0) entries = entries.slice(over)
      return { entries, older: prev.older || over > 0 }
    })
  }, [])

  // The newest page whenever the filters change.
  useEffect(() => {
    let stale = false
    loadingRef.current = true
    setLoading(true)
    setError(null)
    setExpanded(new Set())
    pending.current = []
    setWaiting(0)
    api
      .logs(filterRef.current, { limit: PAGE })
      .then((r) => {
        if (stale) return
        setLog({ entries: r.entries, older: r.more })
        setFollow(true)
      })
      .catch((err) => !stale && setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => {
        if (stale) return
        loadingRef.current = false
        setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [filterKey, reload])

  // Lines as they happen, gathered and added a few times a second.
  useEffect(
    () =>
      onLog((ev) => {
        const { type: _type, ...e } = ev
        if (matches(e, filterRef.current)) pending.current.push(e)
      }),
    [onLog]
  )
  useEffect(() => {
    const t = setInterval(() => {
      if (!pending.current.length || loadingRef.current) return
      if (pausedRef.current) return setWaiting(pending.current.length)
      const add = pending.current
      pending.current = []
      setWaiting(0)
      append(add)
    }, 250)
    return () => clearInterval(t)
  }, [append])

  // Back after the connection dropped: fetch whatever was missed meanwhile.
  const wasConnected = useRef(connected)
  useEffect(() => {
    const back = connected && !wasConnected.current
    wasConnected.current = connected
    const last = log.entries.findLast((e) => e.id > 0)?.id
    if (!back || !last) return
    void api
      .logs(filterRef.current, { after: last, limit: 2000 })
      .then((r) => append(r.entries))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  const resume = () => {
    setPaused(false)
    const add = pending.current
    pending.current = []
    setWaiting(0)
    append(add)
  }

  // ---- scrolling ----
  const scrollRef = useRef<HTMLDivElement>(null)
  const anchor = useRef<number | null>(null)
  const { entries } = log
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 16,
    getItemKey: (i) => entries[i].id,
  })

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (anchor.current !== null) {
      // Older lines went in above: keep the ones being read where they were.
      el.scrollTop = el.scrollHeight - anchor.current
      anchor.current = null
    } else if (follow) el.scrollTop = el.scrollHeight
  })

  const loadOlder = useCallback(async () => {
    const first = log.entries.find((e) => e.id > 0)
    if (!first || loadingOlder) return
    setLoadingOlder(true)
    try {
      const r = await api.logs(filterRef.current, { before: first.id, limit: PAGE })
      const el = scrollRef.current
      if (el) anchor.current = el.scrollHeight - el.scrollTop
      setLog((prev) => {
        const seen = new Set(prev.entries.map((e) => e.id))
        return { entries: [...r.entries.filter((e) => !seen.has(e.id)), ...prev.entries], older: r.more }
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load older lines")
    } finally {
      setLoadingOlder(false)
    }
  }, [log.entries, loadingOlder])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (atBottom !== follow) setFollow(atBottom)
    if (el.scrollTop < 300 && log.older && !loadingOlder && !loading) void loadOlder()
  }

  const toLatest = () => {
    setFollow(true)
    if (paused) resume()
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // "/" jumps to the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t?.closest("input, textarea, [contenteditable=true]")) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const toggle = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const onJob = useCallback((id: string) => setParams((p) => (p.set("job", id), p)), [setParams])
  const onTrack = useCallback((id: number) => setTrackOpen(id), [])

  const clear = useMutation({
    mutationFn: api.clearLogs,
    onSuccess: (r) => {
      setLog({ entries: [], older: false })
      pending.current = []
      setWaiting(0)
      void qc.invalidateQueries({ queryKey: ["log-summary"] })
      toast.success(`Cleared ${r.cleared.toLocaleString()} line${r.cleared === 1 ? "" : "s"}`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't clear the log"),
  })

  const popOut = () => {
    const w = window.open(`/console/window${window.location.search}`, "dubplate-console", "popup,width=1200,height=820")
    if (!w) toast.error("The browser blocked the new window - allow pop-ups for Dubplate")
  }

  // ---- filters ----
  const s = summary.data
  const levelsOn = new Set(filter.levels?.length ? filter.levels : LOG_LEVELS)
  const matching = s ? LOG_LEVELS.filter((l) => levelsOn.has(l)).reduce((n, l) => n + (s.byLevel[l] ?? 0), 0) : null
  const areaItems = [{ value: "all", label: "Every part" }, ...LOG_AREAS.map((a) => ({ value: a, label: `${AREA[a].label}${s?.byArea[a] ? ` (${s.byArea[a]!.toLocaleString()})` : ""}` }))]
  const jobList = useMemo(() => {
    const list = [...(s?.jobs ?? [])]
    // A job that hasn't written anything yet (or isn't in the recent list) still has a name.
    if (filter.job && !list.some((j) => j.id === filter.job)) {
      const live = liveJobs.find((j) => j.id === filter.job)
      list.unshift({ id: filter.job, label: live?.label ?? "This job", kind: live?.kind ?? "process", status: live?.status ?? "running", createdAt: live?.createdAt ?? "" })
    }
    return list
  }, [s?.jobs, filter.job, liveJobs])
  const jobItems = [{ value: "all", label: "Every job" }, ...jobList.map((j) => ({ value: j.id, label: j.label }))]

  const actions = (
    <>
      {!standalone && (
        <Button variant="outline" size="sm" onClick={popOut} title="Open the console in a window of its own">
          <HugeiconsIcon icon={SquareArrowUpRightIcon} strokeWidth={2} data-icon="inline-start" />
          <span className="hidden sm:inline">Pop out</span>
        </Button>
      )}
      <Button variant="outline" size="sm" nativeButton={false} render={<a href={api.logDownloadUrl(filter)} download />} title={filtered ? "Download the lines that match these filters" : "Download the whole log"}>
        <HugeiconsIcon icon={Download04Icon} strokeWidth={2} data-icon="inline-start" />
        <span className="hidden sm:inline">Download</span>
      </Button>
      {s && <LogSettings detail={s.detail} keepDays={s.keepDays} total={s.total} oldest={s.oldest} />}
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="outline" size="sm" aria-label="Clear the log" disabled={!s?.total || clear.isPending} />}>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} data-icon="inline-start" />
          <span className="hidden sm:inline">Clear</span>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the whole log?</AlertDialogTitle>
            <AlertDialogDescription>All {s?.total.toLocaleString() ?? ""} lines go, including any the filters hide. Your music, settings and the Cut & Tag history aren't touched.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => clear.mutate()}>
              Clear the log
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )

  const live = paused ? (
    <span className="text-rasta-gold">Paused{waiting ? ` - ${waiting.toLocaleString()} new` : ""}</span>
  ) : connected ? (
    <span className="text-rasta-green inline-flex items-center gap-1.5">
      <span className="bg-rasta-green size-1.5 animate-pulse rounded-full" />
      Live
    </span>
  ) : (
    <span className="text-rasta-red">Reconnecting…</span>
  )

  return (
    <div className={cn(standalone && "bg-background text-foreground flex h-dvh flex-col gap-3 p-3 md:p-4")}>
      {standalone ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <DubplateMark className="size-6" />
            <h1 className="text-lg font-extrabold">Console</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </div>
      ) : (
        <PageHeader
          eyebrow="Under the hood"
          title="Console"
          description={`Everything Dubplate does, as it happens - kept for ${s?.keepDays ?? 14} day${s?.keepDays === 1 ? "" : "s"}. Open a line to see the whole story.`}
          actions={actions}
        />
      )}

      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Levels">
        {LOG_LEVELS.map((l) => {
          const on = levelsOn.has(l)
          return (
            <button
              key={l}
              type="button"
              aria-pressed={on}
              onClick={() => toggleLevel(l)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors",
                on ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/70"
              )}
            >
              <span className={cn("size-1.5 rounded-full", LEVEL[l].dot)} />
              {LEVEL[l].label}
              <span className="tabular-nums opacity-60">{s ? (s.byLevel[l] ?? 0).toLocaleString() : ""}</span>
            </button>
          )
        })}
        {s && !s.detail && (
          <span className="text-muted-foreground self-center px-1 text-xs">Step-by-step detail is off - switch it on in Settings above.</span>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <InputGroup className="w-full sm:max-w-xs">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
          </InputGroupAddon>
          <InputGroupInput ref={searchRef} value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search messages and details…" aria-label="Search the log" />
          {qInput && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" onClick={() => setQInput("")} aria-label="Clear the search">
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <Select items={areaItems} value={filter.areas?.length === 1 ? filter.areas[0] : "all"} onValueChange={(v) => setParam("areas", v === "all" ? null : String(v))}>
          <SelectTrigger size="sm" className="min-w-36" aria-label="Part of Dubplate">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {areaItems.map((a) => (
              <SelectItem key={a.value} value={a.value} title={a.value === "all" ? undefined : AREA[a.value as LogArea].hint}>
                {a.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select items={jobItems} value={filter.job ?? "all"} onValueChange={(v) => setParam("job", v === "all" ? null : String(v))}>
          <SelectTrigger size="sm" className="max-w-64 min-w-36" aria-label="Job">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every job</SelectItem>
            {jobList.map((j) => (
              <SelectItem key={j.id} value={j.id}>
                <span className="truncate">{j.label}</span>
                {j.createdAt && <span className="text-muted-foreground ml-auto pl-3 text-xs whitespace-nowrap">{fmtAgo(j.createdAt)}</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filter.track && (
          <Button variant="secondary" size="sm" onClick={() => setParam("track", null)} title="Show every track's lines">
            <HugeiconsIcon icon={MusicNote03Icon} strokeWidth={2} data-icon="inline-start" />
            Track {filter.track}
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} data-icon="inline-end" />
          </Button>
        )}
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => (setQInput(""), setParams(new URLSearchParams()))}>
            Show everything
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => (paused ? resume() : setPaused(true))} aria-pressed={paused} title={paused ? "Carry on adding new lines" : "Hold new lines back while you read"}>
            <HugeiconsIcon icon={paused ? PlayIcon : PauseIcon} strokeWidth={2} data-icon="inline-start" />
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </div>

      <div className={cn("bg-card relative flex flex-col overflow-hidden rounded-3xl border", standalone ? "min-h-0 flex-1" : "h-[max(24rem,calc(100dvh-19rem))]")}>
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain font-mono text-xs leading-5" role="log" aria-live="off" aria-label="Log lines">
          {loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 10 }, (_, i) => (
                <Skeleton key={i} className="h-4" style={{ width: `${55 + ((i * 37) % 40)}%` }} />
              ))}
            </div>
          ) : error ? (
            <div className="p-4">
              <QueryError error={error} onRetry={() => setReload((n) => n + 1)} />
            </div>
          ) : !entries.length ? (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-6 text-center font-sans text-sm">
              {filtered ? (
                <>
                  <span>No lines match these filters.</span>
                  <Button variant="outline" size="sm" onClick={() => (setQInput(""), setParams(new URLSearchParams()))}>
                    Show everything
                  </Button>
                </>
              ) : (
                <span>Nothing logged yet - lines appear here as Dubplate works.</span>
              )}
            </div>
          ) : (
            <>
              {log.older && (
                <div className="flex justify-center pt-2">
                  <Button variant="ghost" size="xs" onClick={() => void loadOlder()} disabled={loadingOlder}>
                    {loadingOlder && <Spinner data-icon="inline-start" />}
                    Older lines
                  </Button>
                </div>
              )}
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((v) => {
                  const e = entries[v.index]
                  const prev = entries[v.index - 1]
                  const day = !prev || dayOf(prev.at) !== dayOf(e.at) ? dayFmt.format(new Date(e.at)) : null
                  return (
                    <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${v.start}px)` }}>
                      <Line e={e} day={day} open={expanded.has(e.id)} q={filter.q} onToggle={toggle} onJob={onJob} onTrack={onTrack} />
                    </div>
                  )
                })}
              </div>
              <div className="h-2" />
            </>
          )}
        </div>
        {!follow && entries.length > 0 && (
          <Button size="sm" className="absolute right-4 bottom-12 shadow-lg" onClick={toLatest}>
            <HugeiconsIcon icon={ArrowDownDoubleIcon} strokeWidth={2} data-icon="inline-start" />
            Latest{waiting ? ` (${waiting.toLocaleString()} new)` : ""}
          </Button>
        )}
        <div className="text-muted-foreground flex items-center justify-between gap-3 border-t px-4 py-2 text-xs">
          <span className="truncate tabular-nums">
            {entries.length.toLocaleString()} shown
            {matching !== null && matching > entries.length ? ` of ${matching.toLocaleString()} matching` : ""}
            {s && filtered ? ` · ${s.total.toLocaleString()} kept` : ""}
          </span>
          <span className="flex shrink-0 items-center gap-3">
            {live}
            {expanded.size > 0 && (
              <button type="button" className="hover:text-foreground inline-flex items-center gap-1" onClick={() => setExpanded(new Set())}>
                <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-3 rotate-180" />
                Fold all
              </button>
            )}
          </span>
        </div>
      </div>

      <Sheet open={trackOpen !== null} onOpenChange={(o) => !o && setTrackOpen(null)}>
        <SheetContent className="w-full overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Track</SheetTitle>
            <SheetDescription>
              {trackOpen !== null && filter.track !== trackOpen ? (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => {
                    setParam("track", String(trackOpen))
                    setTrackOpen(null)
                  }}
                >
                  Show only this track's lines in the console
                </button>
              ) : (
                "The console shows only this track's lines."
              )}
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">{trackOpen !== null && <TrackDetail key={trackOpen} trackId={trackOpen} onOpenTrack={setTrackOpen} onAdvance={() => setTrackOpen(null)} />}</div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
