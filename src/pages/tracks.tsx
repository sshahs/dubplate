import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiMagicIcon,
  Cancel01Icon,
  Download04Icon,
  Image01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  RefreshIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { useWindowVirtualizer } from "@tanstack/react-virtual"
import { addTransitionType, memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, ViewTransition } from "react"
import { useSearchParams } from "react-router"
import { toast } from "sonner"
import { formatBpm, toCamelot } from "@shared/keys"
import type { TrackStatus, TrackSummary } from "@shared/types"
import { TRACK_STATUSES } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { BulkEditDialog } from "@/components/bulk-edit"
import { ConfidenceMeter, StatusBadge } from "@/components/confidence"
import { Cover } from "@/components/cover"
import { QueryError } from "@/components/query-error"
import { TrackDetail } from "@/components/track-detail"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, type BulkChanges, type Selection, type TrackFilter } from "@/lib/api"
import { useActiveJobs } from "@/lib/events"
import { fmtDuration, STATUS_META } from "@/lib/format"
import { usePrefetchTracks } from "@/lib/prefetch"
import { toastUndoable } from "@/lib/undo"
import { cn } from "@/lib/utils"

/** Rows are fetched in blocks as they scroll into view, so a 20,000-track library loads like a small one. */
const BLOCK = 100
const ROW_HEIGHT = 56
/** Statuses a track only passes through mid-job; their chips would blink in and out while processing. */
const TRANSIENT: TrackStatus[] = ["interpreted", "scoured"]
const COLUMNS = 8
/** Exactly ROW_HEIGHT tall: the separator is a shadow, since a table border adds a fraction of a pixel. */
const ROW_CLASS = "h-14 border-0 [&>td]:shadow-[inset_0_-1px_0_var(--color-border)]"

type Sort = NonNullable<TrackFilter["sort"]>

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function SkeletonRow({ index }: { index: number }) {
  return (
    <TableRow data-index={index} className={cn(ROW_CLASS, "hover:bg-transparent")}>
      <TableCell className="pl-4">
        <Skeleton className="size-4 rounded" />
      </TableCell>
      <TableCell>
        <Skeleton className="size-10 rounded-lg" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-3.5 w-3/4" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-3.5 w-2/3" />
      </TableCell>
      <TableCell colSpan={COLUMNS - 4} />
    </TableRow>
  )
}

/** One row. Memoised: scrolling re-renders the page, but rows already on screen stay put. */
const TrackRow = memo(function TrackRow({
  t,
  index,
  selected,
  keyNotation,
  onOpen,
  onToggle,
  onShift,
}: {
  t: TrackSummary
  index: number
  selected: boolean
  keyNotation: "musical" | "camelot"
  onOpen: (id: number, index: number) => void
  onToggle: (t: TrackSummary, index: number) => void
  /** whether Shift is down as the checkbox is pressed (for range ticking) */
  onShift: (held: boolean) => void
}) {
  return (
    <TableRow data-index={index} data-state={selected ? "selected" : undefined} className={cn(ROW_CLASS, "cursor-pointer")} onClick={() => onOpen(t.id, index)}>
      <TableCell
        className="pl-4"
        onClick={(e) => e.stopPropagation()}
        onPointerDownCapture={(e) => onShift(e.shiftKey)}
        onKeyDownCapture={(e) => onShift(e.shiftKey)}
      >
        <Checkbox checked={selected} onCheckedChange={() => onToggle(t, index)} aria-label={`Select ${t.filename}`} />
      </TableCell>
      <TableCell className="py-1">
        <Cover track={t} size={40} />
      </TableCell>
      <TableCell>
        <div className="truncate font-mono text-xs" title={t.filename}>
          {t.filename}
        </div>
        {t.relDir && <div className="text-muted-foreground truncate text-[11px]">{t.relDir}</div>}
      </TableCell>
      <TableCell>
        {t.proposedName && t.proposedName !== t.filename ? (
          <div className="truncate text-sm" title={t.proposedName}>
            {t.proposedName}
          </div>
        ) : t.proposedArtist || t.proposedTitle ? (
          <div className="text-muted-foreground truncate text-sm">
            {t.proposedArtist || "?"} - {t.proposedTitle || "?"}
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">–</span>
        )}
      </TableCell>
      <TableCell className="font-mono text-xs tabular-nums">
        {t.bpm || t.key ? (
          <span title={t.key ? `${t.key} · Camelot ${toCamelot(t.key)}` : undefined}>
            {formatBpm(t.bpm) ?? "–"}
            {t.key && <span className="text-muted-foreground ml-1.5">{keyNotation === "camelot" ? toCamelot(t.key) : t.key}</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell>
        <ConfidenceMeter value={t.confidence} />
      </TableCell>
      <TableCell>
        <StatusBadge status={t.status} />
      </TableCell>
      <TableCell className="text-muted-foreground hidden text-right font-mono text-xs lg:table-cell">{fmtDuration(t.duration)}</TableCell>
    </TableRow>
  )
})

export default function TracksPage() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get("q") ?? "")
  const debouncedQ = useDebounced(q)
  const status = (params.get("status")?.split(",").filter((s) => TRACK_STATUSES.includes(s as TrackStatus)) ?? []) as TrackStatus[]
  const libraryId = params.get("libraryId") ? Number(params.get("libraryId")) : undefined
  const [sort, setSort] = useState<Sort>("filename")
  const [dir, setDir] = useState<"asc" | "desc">("asc")
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [allMatching, setAllMatching] = useState(false)
  const [open, setOpen] = useState<{ id: number; index: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const lastClicked = useRef<number | null>(null)
  const shiftHeld = useRef(false)

  const filter: TrackFilter = useMemo(
    () => ({ q: debouncedQ || undefined, status: status.length ? status : undefined, libraryId, sort, dir }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debouncedQ, params.get("status"), libraryId, sort, dir]
  )
  const filterKey = JSON.stringify(filter)
  useEffect(() => {
    setSelected(new Set())
    setAllMatching(false)
    lastClicked.current = null
  }, [filterKey])

  const { data: libraries } = useQuery({ queryKey: ["libraries"], queryFn: api.libraries })
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: api.stats })
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const keyNotation = settings?.analysis.keyNotation ?? "musical"
  const busy = useActiveJobs().length > 0

  // ---- windowed list ----
  const listRef = useRef<HTMLTableSectionElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    const measure = () => {
      const top = listRef.current ? listRef.current.getBoundingClientRect().top + window.scrollY : 0
      setScrollMargin((prev) => (Math.abs(prev - top) > 1 ? top : prev))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(document.body)
    return () => ro.disconnect()
  }, [])

  // What's on screen: the current filter once its first block has arrived, else the previous one (dimmed).
  const [view, setView] = useState<{ key: string; filter: TrackFilter; total: number } | null>(null)
  // Every row is exactly ROW_HEIGHT, so nothing is measured: measuring makes the virtualizer
  // recompute all 20,000 offsets each time a row mounts.
  const virtualizer = useWindowVirtualizer({
    count: view?.total ?? 0,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    scrollMargin,
  })
  const vItems = virtualizer.getVirtualItems()
  const first = Math.floor((vItems[0]?.index ?? 0) / BLOCK)
  const last = Math.floor((vItems.at(-1)?.index ?? 0) / BLOCK)
  const blockIndexes = Array.from({ length: last - first + 1 }, (_, i) => first + i)
  const blockKey = (f: TrackFilter, b: number) => ["tracks", "block", f, b] as const
  const results = useQueries({
    queries: blockIndexes.map((b) => ({
      queryKey: blockKey(filter, b),
      queryFn: () => api.tracks({ ...filter, limit: BLOCK, offset: b * BLOCK }),
      staleTime: 5_000,
    })),
  })
  const current = results.find((r) => r.data)?.data
  const listError = results.find((r) => r.error)?.error
  const isFetching = results.some((r) => r.isFetching)
  useEffect(() => {
    if (current && (view?.key !== filterKey || view.total !== current.total)) setView({ key: filterKey, filter, total: current.total })
  }, [current, filterKey, filter, view])
  // A new search starts from the top of the list.
  const prevKey = useRef(filterKey)
  useEffect(() => {
    if (prevKey.current === filterKey) return
    prevKey.current = filterKey
    if (window.scrollY > scrollMargin) window.scrollTo({ top: Math.max(0, scrollMargin - 140) })
  }, [filterKey, scrollMargin])

  const stale = !!view && view.key !== filterKey
  const rowAt = (i: number): TrackSummary | undefined => {
    if (!view) return undefined
    const block = qc.getQueryData<{ items: TrackSummary[] }>(blockKey(view.filter, Math.floor(i / BLOCK)))
    return block?.items[i % BLOCK]
  }
  const total = view?.total

  const selection: Selection | null = allMatching ? { filter } : selected.size ? { ids: [...selected] } : null
  const selectionCount = allMatching ? (total ?? 0) : selected.size
  const clearSelection = () => {
    setSelected(new Set())
    setAllMatching(false)
  }
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tracks"] })
    void qc.invalidateQueries({ queryKey: ["stats"] })
  }

  const process = useMutation({
    mutationFn: (opts: { interpret?: boolean; scour?: boolean; force?: boolean }) => api.process(selection, opts),
    onSuccess: (j) => {
      toast(j.label)
      clearSelection()
    },
    onError: (e) => toast.error(e.message),
  })
  const job = useMutation({
    mutationFn: (kind: "analyze" | "reanalyze" | "artwork") => (kind === "artwork" ? api.findArtwork(selection!) : api.analyze(selection!, kind === "reanalyze")),
    onSuccess: (j) => toast(j.label, { description: "Runs in the background - watch the job dock." }),
    onError: (e) => toast.error(e.message),
  })
  const bulk = useMutation({
    mutationFn: (action: "approve" | "reject" | "reset" | "unapprove") => api.bulk(selection!, action),
    onSuccess: (r, action) => {
      const verb = { approve: "Approved", reject: "Left as-is:", reset: "Reset", unapprove: "Unapproved" }[action]
      toastUndoable(qc, `${verb} ${r.changed} track${r.changed === 1 ? "" : "s"}`, r.undoId)
      clearSelection()
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const applyEdit = async (changes: BulkChanges) => {
    try {
      const r = await api.bulkEdit(selection!, changes)
      toastUndoable(qc, `Updated ${r.changed} track${r.changed === 1 ? "" : "s"}`, r.undoId, {
        description: r.skipped ? `${r.skipped} not identified yet - their artist/title fields were left alone` : undefined,
      })
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  const setStatusFilter = (s: TrackStatus | "all") => {
    const next = new URLSearchParams(params)
    if (s === "all") next.delete("status")
    else next.set("status", s)
    setParams(next)
  }
  const setLibrary = (id: string) => {
    const next = new URLSearchParams(params)
    if (id === "all") next.delete("libraryId")
    else next.set("libraryId", id)
    setParams(next)
  }
  const sortBy = (col: Sort) => {
    if (sort === col) setDir(dir === "asc" ? "desc" : "asc")
    else {
      setSort(col)
      setDir(col === "confidence" ? "desc" : "asc")
    }
  }
  const arrow = (col: Sort) => (sort === col ? (dir === "asc" ? " ↑" : " ↓") : "")

  // The current rowAt without making the callbacks below change on every render.
  const rowAtRef = useRef(rowAt)
  rowAtRef.current = rowAt
  const openRow = useCallback((id: number, index: number) => setOpen({ id, index }), [])
  const noteShift = useCallback((held: boolean) => {
    shiftHeld.current = held
  }, [])
  const toggleRow = useCallback((t: TrackSummary, index: number) => {
    const next = new Set(allMatching ? [] : selected)
    // Shift-click ticks everything between the last row you ticked and this one.
    if (shiftHeld.current && lastClicked.current !== null) {
      const [a, b] = [Math.min(lastClicked.current, index), Math.max(lastClicked.current, index)]
      for (let i = a; i <= b; i++) {
        const row = rowAtRef.current(i)
        if (row) next.add(row.id)
      }
    } else if (next.has(t.id)) next.delete(t.id)
    else next.add(t.id)
    lastClicked.current = index
    setSelected(next)
    setAllMatching(false)
  }, [allMatching, selected])

  usePrefetchTracks(open ? [rowAt(open.index + 1)?.id] : [])
  const libItems = [{ value: "all", label: "All libraries" }, ...(libraries ?? []).map((l) => ({ value: String(l.id), label: l.name }))]
  const exportFilter = view?.filter ?? filter
  const paddingTop = vItems.length ? vItems[0].start - scrollMargin : 0
  const paddingBottom = vItems.length ? virtualizer.getTotalSize() - (vItems.at(-1)!.end - scrollMargin) : 0

  return (
    <>
      <PageHeader
        eyebrow="Staging"
        title="Tracks"
        description="Everything the scanner found, with the AI's reading, source consensus and what it'll be renamed to."
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline">
                  <HugeiconsIcon icon={Download04Icon} strokeWidth={2} data-icon="inline-start" />
                  Export
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem render={<a href={api.exportUrl(exportFilter, "csv")} />}>CSV report</DropdownMenuItem>
              <DropdownMenuItem render={<a href={api.exportUrl(exportFilter, "json")} />}>JSON report</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <div className="mb-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setStatusFilter("all")}
          className={cn("h-7 rounded-full px-3 text-xs font-medium transition-colors", !status.length ? "bg-foreground text-background" : "bg-muted hover:bg-muted/70")}
        >
          All <span className="tabular-nums">{stats ? stats.total : ""}</span>
        </button>
        {TRACK_STATUSES.filter((s) => status.includes(s) || ((stats?.byStatus[s] ?? 0) > 0 && !(busy && TRANSIENT.includes(s)))).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={cn(
              "animate-in fade-in zoom-in-95 h-7 rounded-full px-3 text-xs font-medium transition-colors duration-200",
              status.includes(s) ? "bg-foreground text-background" : "bg-muted hover:bg-muted/70"
            )}
            title={STATUS_META[s].hint}
          >
            {STATUS_META[s].label} <span className="tabular-nums opacity-60">{stats?.byStatus[s] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <InputGroup className="max-w-sm">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
          </InputGroupAddon>
          <InputGroupInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search filenames, folders, names…" />
        </InputGroup>
        {(libraries?.length ?? 0) > 1 && (
          <Select items={libItems} value={libraryId ? String(libraryId) : "all"} onValueChange={(v) => setLibrary(String(v))}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {libItems.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="text-muted-foreground ml-auto flex items-center gap-1.5 text-xs tabular-nums">
          <Spinner className={cn("size-3 transition-opacity", isFetching ? "opacity-100" : "opacity-0")} />
          {total !== undefined ? `${total.toLocaleString()} track${total === 1 ? "" : "s"}` : ""}
        </span>
      </div>

      {/* Always holds its slot, so ticking a box never pushes the table down. */}
      <div
        className={cn(
          "mb-3 flex min-h-[3.125rem] flex-wrap items-center gap-2 rounded-3xl border p-2 pl-4 transition-[background-color,box-shadow,border-color] duration-300",
          selectionCount > 0 ? "bg-card sticky top-16 z-10 shadow-lg" : "text-muted-foreground border-dashed"
        )}
      >
        {selectionCount === 0 && <span className="animate-in fade-in text-xs duration-300">Tick tracks to identify, edit, approve or leave them as they are. Shift-click ticks a run.</span>}
        {selectionCount > 0 && (
          <div className="animate-in fade-in slide-in-from-bottom-1 flex flex-1 flex-wrap items-center gap-2 duration-300">
            <span className="text-sm font-medium tabular-nums">{selectionCount.toLocaleString()} selected</span>
            {!allMatching && (total ?? 0) > selected.size && (
              <Button variant="link" size="sm" onClick={() => setAllMatching(true)}>
                Select all {total?.toLocaleString()} matching
              </Button>
            )}
            <div className="ml-auto flex flex-wrap gap-1.5">
              <Button size="sm" onClick={() => process.mutate({})} disabled={process.isPending}>
                <HugeiconsIcon icon={AiMagicIcon} strokeWidth={2} data-icon="inline-start" />
                Identify
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} data-icon="inline-start" />
                Edit fields
              </Button>
              <Button size="sm" variant="secondary" onClick={() => bulk.mutate("approve")}>
                <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} data-icon="inline-start" />
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => bulk.mutate("reject")}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} data-icon="inline-start" />
                Leave as-is
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More actions" />}>
                  <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Pipeline</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => process.mutate({ force: true })}>
                      <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                      Re-identify (ignore cache of results)
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => process.mutate({ interpret: false })}>Scour sources only (no AI)</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => process.mutate({ scour: false })}>AI interpret only</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => api.rescore(selection!).then((j) => toast(j.label))}>Re-score (offline)</DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Extras</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => job.mutate("analyze")}>Analyse BPM & key</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => job.mutate("reanalyze")}>Re-analyse BPM & key</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => job.mutate("artwork")}>
                      <HugeiconsIcon icon={Image01Icon} strokeWidth={2} />
                      Find artwork
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => bulk.mutate("unapprove")}>Unapprove</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => bulk.mutate("reset")}>
                      Reset to new
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={clearSelection}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </div>
          </div>
        )}
      </div>

      {listError && !view ? (
        <QueryError error={listError} onRetry={() => void qc.invalidateQueries({ queryKey: ["tracks", "block"] })} />
      ) : (
        <Card className={cn("overflow-hidden py-0 transition-opacity duration-200", stale && "opacity-60")}>
          {/* Fixed layout: column widths don't jump around as rows refresh during a job. */}
          <Table className="min-w-[52rem] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 pl-4">
                  <Checkbox
                    checked={allMatching}
                    indeterminate={!allMatching && selected.size > 0}
                    onCheckedChange={(c) => (c ? setAllMatching(true) : clearSelection())}
                    aria-label="Select all matching tracks"
                  />
                </TableHead>
                <TableHead className="w-14">
                  <span className="sr-only">Artwork</span>
                </TableHead>
                <TableHead className="cursor-pointer select-none" onClick={() => sortBy("filename")}>
                  Original file{arrow("filename")}
                </TableHead>
                <TableHead>Becomes</TableHead>
                <TableHead className="w-24 cursor-pointer select-none" onClick={() => sortBy("bpm")} title="Tempo and key">
                  BPM · Key{arrow("bpm")}
                </TableHead>
                <TableHead className="w-36 cursor-pointer select-none" onClick={() => sortBy("confidence")}>
                  Confidence{arrow("confidence")}
                </TableHead>
                <TableHead className="w-32 cursor-pointer select-none" onClick={() => sortBy("status")}>
                  Status{arrow("status")}
                </TableHead>
                <TableHead className="hidden w-20 text-right lg:table-cell">Length</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody ref={listRef}>
              {total === 0 && (
                <TableRow>
                  <TableCell colSpan={COLUMNS} className="text-muted-foreground py-12 text-center">
                    No tracks match.
                  </TableCell>
                </TableRow>
              )}
              {total === undefined &&
                Array.from({ length: 8 }, (_, i) => <SkeletonRow key={i} index={i} />)}
              {paddingTop > 0 && <tr aria-hidden style={{ height: paddingTop }} />}
              {vItems.map((v) => {
                const t = rowAt(v.index)
                if (!t) return <SkeletonRow key={`s${v.index}`} index={v.index} />
                return (
                  <TrackRow
                    key={t.id}
                    t={t}
                    index={v.index}
                    selected={allMatching || selected.has(t.id)}
                    keyNotation={keyNotation}
                    onOpen={openRow}
                    onToggle={toggleRow}
                    onShift={noteShift}
                  />
                )
              })}
              {paddingBottom > 0 && <tr aria-hidden style={{ height: paddingBottom }} />}
            </TableBody>
          </Table>
        </Card>
      )}

      <BulkEditDialog open={editing} onOpenChange={setEditing} count={selectionCount} onApply={applyEdit} />

      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Track</SheetTitle>
            <SheetDescription>Check the evidence, fix anything that's off, then approve.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            {open !== null && (
              <ViewTransition key={open.id} enter={{ forward: "detail-enter-forward", default: "none" }} exit={{ forward: "detail-exit-forward", default: "none" }} default="none">
                <div>
                  <TrackDetail
                    trackId={open.id}
                    onUndone={() => setOpen(open)}
                    onAdvance={() => {
                      const next = rowAt(open.index + 1)
                      if (!next) return setOpen(null)
                      startTransition(() => {
                        addTransitionType("forward")
                        setOpen({ id: next.id, index: open.index + 1 })
                      })
                    }}
                  />
                </div>
              </ViewTransition>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
