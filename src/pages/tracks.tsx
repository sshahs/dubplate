import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiMagicIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Download04Icon,
  MoreHorizontalIcon,
  RefreshIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { addTransitionType, startTransition, useEffect, useMemo, useState, ViewTransition } from "react"
import { useSearchParams } from "react-router"
import { toast } from "sonner"
import type { TrackStatus } from "@shared/types"
import { TRACK_STATUSES } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { ConfidenceMeter, StatusBadge } from "@/components/confidence"
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
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, type Selection, type TrackFilter } from "@/lib/api"
import { useActiveJobs } from "@/lib/events"
import { fmtDuration, STATUS_META } from "@/lib/format"
import { usePrefetchTracks } from "@/lib/prefetch"
import { cn } from "@/lib/utils"

const PAGE = 50
/** Statuses a track only passes through mid-job; their chips would blink in and out while processing. */
const TRANSIENT: TrackStatus[] = ["interpreted", "scoured"]

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export default function TracksPage() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get("q") ?? "")
  const debouncedQ = useDebounced(q)
  const status = (params.get("status")?.split(",").filter((s) => TRACK_STATUSES.includes(s as TrackStatus)) ?? []) as TrackStatus[]
  const libraryId = params.get("libraryId") ? Number(params.get("libraryId")) : undefined
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<TrackFilter["sort"]>("filename")
  const [dir, setDir] = useState<"asc" | "desc">("asc")
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [allMatching, setAllMatching] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)

  const filter: TrackFilter = useMemo(
    () => ({ q: debouncedQ || undefined, status: status.length ? status : undefined, libraryId, sort, dir, limit: PAGE, offset: page * PAGE }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debouncedQ, params.get("status"), libraryId, sort, dir, page]
  )
  useEffect(() => {
    setPage(0)
    setSelected(new Set())
    setAllMatching(false)
  }, [debouncedQ, params, sort, dir])

  const { data, isFetching, isPlaceholderData } = useQuery({ queryKey: ["tracks", filter], queryFn: () => api.tracks(filter), placeholderData: keepPreviousData })
  const { data: libraries } = useQuery({ queryKey: ["libraries"], queryFn: api.libraries })
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: api.stats })
  const busy = useActiveJobs().length > 0

  const selection: Selection | null = allMatching
    ? { filter: { ...filter, limit: undefined, offset: undefined } }
    : selected.size
      ? { ids: [...selected] }
      : null
  const selectionCount = allMatching ? (data?.total ?? 0) : selected.size

  const done = (msg: string) => {
    toast(msg)
    setSelected(new Set())
    setAllMatching(false)
    void qc.invalidateQueries({ queryKey: ["tracks"] })
    void qc.invalidateQueries({ queryKey: ["stats"] })
  }
  const process = useMutation({
    mutationFn: (opts: { interpret?: boolean; scour?: boolean; force?: boolean }) => api.process(selection, opts),
    onSuccess: (j) => done(j.label),
    onError: (e) => toast.error(e.message),
  })
  const bulk = useMutation({
    mutationFn: (action: "approve" | "reject" | "reset" | "unapprove") => api.bulk(selection!, action),
    onSuccess: (r, action) => done(`${action === "approve" ? "Approved" : action === "reject" ? "Rejected" : action === "reset" ? "Reset" : "Unapproved"} ${r.changed} tracks`),
    onError: (e) => toast.error(e.message),
  })

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

  const items = data?.items ?? []
  const allOnPageSelected = items.length > 0 && items.every((t) => selected.has(t.id))
  const toggleAll = () => {
    const next = new Set(selected)
    if (allOnPageSelected) items.forEach((t) => next.delete(t.id))
    else items.forEach((t) => next.add(t.id))
    setSelected(next)
    setAllMatching(false)
  }
  const sortBy = (col: TrackFilter["sort"]) => {
    if (sort === col) setDir(dir === "asc" ? "desc" : "asc")
    else {
      setSort(col)
      setDir(col === "confidence" ? "desc" : "asc")
    }
  }
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE))
  const openIndex = items.findIndex((t) => t.id === openId)
  usePrefetchTracks(openId === null ? [] : [items[openIndex + 1]?.id])

  const libItems = [{ value: "all", label: "All libraries" }, ...(libraries ?? []).map((l) => ({ value: String(l.id), label: l.name }))]

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
              <DropdownMenuItem render={<a href={api.exportUrl({ ...filter, limit: undefined, offset: undefined }, "csv")} />}>CSV report</DropdownMenuItem>
              <DropdownMenuItem render={<a href={api.exportUrl({ ...filter, limit: undefined, offset: undefined }, "json")} />}>JSON report</DropdownMenuItem>
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
          {data ? `${data.total} tracks` : ""}
        </span>
      </div>

      {/* Always holds its slot, so ticking a box never pushes the table down. */}
      <div
        className={cn(
          "mb-3 flex min-h-[3.125rem] flex-wrap items-center gap-2 rounded-3xl border p-2 pl-4 transition-[background-color,box-shadow,border-color] duration-300",
          selectionCount > 0 ? "bg-card sticky top-16 z-10 shadow-lg" : "text-muted-foreground border-dashed"
        )}
      >
        {selectionCount === 0 && <span className="animate-in fade-in text-xs duration-300">Tick tracks to identify, approve or leave them as they are.</span>}
        {selectionCount > 0 && (
          <div className="animate-in fade-in slide-in-from-bottom-1 flex flex-1 flex-wrap items-center gap-2 duration-300">
            <span className="text-sm font-medium tabular-nums">{selectionCount} selected</span>
            {!allMatching && allOnPageSelected && (data?.total ?? 0) > items.length && (
              <Button variant="link" size="sm" onClick={() => setAllMatching(true)}>
                Select all {data?.total} matching
              </Button>
            )}
            <div className="ml-auto flex flex-wrap gap-1.5">
              <Button size="sm" onClick={() => process.mutate({})} disabled={process.isPending}>
                <HugeiconsIcon icon={AiMagicIcon} strokeWidth={2} data-icon="inline-start" />
                Identify
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
                    <DropdownMenuItem onClick={() => api.rescore(selection!).then((j) => done(j.label))}>Re-score (offline)</DropdownMenuItem>
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
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Clear selection"
                onClick={() => {
                  setSelected(new Set())
                  setAllMatching(false)
                }}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </div>
          </div>
        )}
      </div>

      <Card className={cn("overflow-hidden py-0 transition-opacity duration-200", isPlaceholderData && "opacity-60")}>
        {/* Fixed layout: column widths don't jump around as rows refresh during a job. */}
        <Table className="min-w-[42rem] table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 pl-4">
                <Checkbox checked={allOnPageSelected} onCheckedChange={toggleAll} aria-label="Select page" />
              </TableHead>
              <TableHead className="cursor-pointer" onClick={() => sortBy("filename")}>
                Original file {sort === "filename" && (dir === "asc" ? "↑" : "↓")}
              </TableHead>
              <TableHead>Becomes</TableHead>
              <TableHead className="w-36 cursor-pointer" onClick={() => sortBy("confidence")}>
                Confidence {sort === "confidence" && (dir === "asc" ? "↑" : "↓")}
              </TableHead>
              <TableHead className="w-32 cursor-pointer" onClick={() => sortBy("status")}>
                Status {sort === "status" && (dir === "asc" ? "↑" : "↓")}
              </TableHead>
              <TableHead className="hidden w-20 text-right lg:table-cell">Length</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-12 text-center">
                  {data ? "No tracks match." : "Loading…"}
                </TableCell>
              </TableRow>
            )}
            {items.map((t) => (
              <TableRow
                key={t.id}
                data-state={selected.has(t.id) || allMatching ? "selected" : undefined}
                className="animate-in fade-in cursor-pointer duration-300"
                onClick={() => setOpenId(t.id)}
              >
                <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={allMatching || selected.has(t.id)}
                    onCheckedChange={() => {
                      const next = new Set(selected)
                      if (next.has(t.id)) next.delete(t.id)
                      else next.add(t.id)
                      setSelected(next)
                      setAllMatching(false)
                    }}
                    aria-label={`Select ${t.filename}`}
                  />
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
                      {t.proposedArtist || "?"} — {t.proposedTitle || "?"}
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-xs">–</span>
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
            ))}
          </TableBody>
        </Table>
      </Card>

      <div className="mt-3 flex items-center justify-end gap-2 text-sm">
        <span className="text-muted-foreground">
          Page {page + 1} of {pages}
        </span>
        <Button variant="outline" size="icon-sm" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
        </Button>
        <Button variant="outline" size="icon-sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
        </Button>
      </div>

      <Sheet open={openId !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Track</SheetTitle>
            <SheetDescription>Check the evidence, fix anything that's off, then approve.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            {openId !== null && (
              <ViewTransition key={openId} enter={{ forward: "detail-enter-forward", default: "none" }} exit={{ forward: "detail-exit-forward", default: "none" }} default="none">
                <div>
                  <TrackDetail
                    trackId={openId}
                    onAdvance={() => {
                      const next = items[openIndex + 1]
                      if (!next) return setOpenId(null)
                      startTransition(() => {
                        addTransitionType("forward")
                        setOpenId(next.id)
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
