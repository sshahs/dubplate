import { HugeiconsIcon } from "@hugeicons/react"
import { CheckListIcon, TickDouble02Icon } from "@hugeicons/core-free-icons"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { addTransitionType, startTransition, useEffect, useMemo, useRef, useState, ViewTransition } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import type { TrackStatus } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { QueryError } from "@/components/query-error"
import { ConfidenceMeter, StatusBadge } from "@/components/confidence"
import { Cover } from "@/components/cover"
import { SwipeToDecide } from "@/components/swipe-to-decide"
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
import { Card, CardContent } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/lib/api"
import { usePrefetchTracks } from "@/lib/prefetch"
import { toastUndoable, undoLast } from "@/lib/undo"
import { cn } from "@/lib/utils"

const QUEUES: Record<string, { label: string; status: TrackStatus[] }> = {
  review: { label: "Needs review", status: ["review", "conflict"] },
  conflict: { label: "Conflicts", status: ["conflict"] },
  matched: { label: "Matched", status: ["matched"] },
  unmatched: { label: "Unmatched", status: ["unmatched"] },
}

export default function ReviewPage() {
  const qc = useQueryClient()
  const [queue, setQueue] = useState("review")
  const [currentId, setCurrentId] = useState<number | null>(null)
  const filter = useMemo(() => ({ status: QUEUES[queue].status, sort: "confidence" as const, dir: "desc" as const, limit: 200 }), [queue])
  const { data, isPlaceholderData, error, refetch } = useQuery({ queryKey: ["tracks", "review", filter], queryFn: () => api.tracks(filter), placeholderData: keepPreviousData })
  const items = useMemo(() => data?.items ?? [], [data])
  const index = Math.max(0, items.findIndex((t) => t.id === currentId))
  const current = items[index]
  usePrefetchTracks([items[index + 1]?.id, items[index - 1]?.id, items[index + 2]?.id])
  const listRef = useRef<HTMLDivElement>(null)
  // Keep the highlighted track in view as J/K walk the queue.
  useEffect(() => {
    listRef.current?.querySelector("[data-current]")?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [current?.id])

  /** Move to another track, sliding the detail panel in the direction of travel. */
  const go = (id: number | null | undefined, dir: "forward" | "back") => {
    if (id === undefined) return
    startTransition(() => {
      addTransitionType(dir)
      setCurrentId(id)
    })
  }

  // After an undo, the track comes back into the queue once the list refreshes: go back to it then.
  const returnTo = useRef<number | null>(null)
  useEffect(() => {
    const want = returnTo.current
    if (want !== null && items.some((t) => t.id === want)) {
      returnTo.current = null
      go(want, "back")
      return
    }
    if (items.length && (currentId === null || !items.some((t) => t.id === currentId))) setCurrentId(items[Math.min(index, items.length - 1)]?.id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.closest("input, textarea, [contenteditable], [role=combobox]")) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        go(items[index + 1]?.id, "forward")
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        go(items[index - 1]?.id, "back")
      } else if (e.key === "a") {
        document.querySelector<HTMLButtonElement>("[data-review-action=approve]")?.click()
      } else if (e.key === "x") {
        document.querySelector<HTMLButtonElement>("[data-review-action=reject]")?.click()
      } else if (e.key === "z") {
        undoLast()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [items, index])

  const total = data?.total ?? 0
  const approveAll = useMutation({
    mutationFn: () => api.bulk({ filter: { status: QUEUES[queue].status } }, "approve"),
    onSuccess: (r) => {
      toastUndoable(qc, `Approved ${r.changed} track${r.changed === 1 ? "" : "s"}`, r.undoId, {
        description: r.skipped ? `${r.skipped} had no suggestion to approve - they're still here.` : "Off to Cut & Tag.",
      })
      void qc.invalidateQueries({ queryKey: ["tracks"] })
      void qc.invalidateQueries({ queryKey: ["stats"] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <>
      <PageHeader
        eyebrow="Selector's chair"
        title="Review"
        description="The tracks the engine wasn't sure about. Have a listen, check the evidence, and make the call - every approval teaches the AI your style."
        actions={
          <>
            <div className="text-muted-foreground hidden items-center gap-1.5 text-xs lg:flex">
              <Kbd>J</Kbd>/<Kbd>K</Kbd> move · <Kbd>A</Kbd> approve · <Kbd>X</Kbd> leave as-is · <Kbd>Z</Kbd> undo
            </div>
            {queue !== "unmatched" && total > 0 && (
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <Button variant="outline" disabled={approveAll.isPending}>
                      <HugeiconsIcon icon={TickDouble02Icon} strokeWidth={2} data-icon="inline-start" />
                      Approve all {total}
                    </Button>
                  }
                />
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Approve all {total} in "{QUEUES[queue].label}"?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      Each one gets the artist and title Dubplate suggested, ready for Cut & Tag. You can undo straight afterwards. Approving in bulk doesn't teach the AI - only
                      the ones you check yourself do.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Not yet</AlertDialogCancel>
                    <AlertDialogAction onClick={() => approveAll.mutate()}>Approve all</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </>
        }
      />
      <p className="text-muted-foreground -mt-3 mb-4 text-xs md:hidden">Swipe a track right to approve it, or left to leave it as-is.</p>
      <Tabs value={queue} onValueChange={(v) => setQueue(String(v))} className="mb-4 max-w-full overflow-x-auto">
        <TabsList>
          {Object.entries(QUEUES).map(([k, v]) => (
            <TabsTrigger key={k} value={k}>
              {v.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {error && !data ? (
        <QueryError error={error} onRetry={() => void refetch()} />
      ) : !data ? (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <Skeleton className="h-[40vh] rounded-4xl lg:h-[calc(100vh-14rem)]" />
          <Skeleton className="h-[60vh] rounded-4xl" />
        </div>
      ) : items.length === 0 ? (
        <Empty className="animate-in fade-in border duration-300">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={CheckListIcon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>Queue clear - nuff respect</EmptyTitle>
            <EmptyDescription>Nothing waiting in "{QUEUES[queue].label}". Process more tracks or head to Cut & Tag.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button nativeButton={false} render={<Link to="/execute" />}>Go to Cut & Tag</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <Card className={cn("py-0 transition-opacity lg:sticky lg:top-20 lg:self-start", isPlaceholderData && "opacity-60")}>
            <ScrollArea className="h-[40vh] lg:h-[calc(100vh-14rem)]">
              <div ref={listRef} className="p-2">
                {items.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    data-current={i === index || undefined}
                    onClick={() => go(t.id, i < index ? "back" : "forward")}
                    className={cn("w-full rounded-2xl p-2.5 text-left transition-colors duration-200", i === index ? "bg-muted" : "hover:bg-muted/50")}
                  >
                    <div className="flex items-center gap-2.5">
                      <Cover track={t} size={36} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-xs">{t.filename}</div>
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <StatusBadge status={t.status} />
                          <ConfidenceMeter value={t.confidence} />
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
            <div className="text-muted-foreground border-t px-4 py-2 text-xs">
              {index + 1} of {data?.total ?? items.length}
            </div>
          </Card>
          <SwipeToDecide>
            <Card>
              <CardContent>
                {current && (
                  <ViewTransition
                    key={current.id}
                    enter={{ forward: "detail-enter-forward", back: "detail-enter-back", default: "none" }}
                    exit={{ forward: "detail-exit-forward", back: "detail-exit-back", default: "none" }}
                    default="none"
                  >
                    <div>
                      <TrackDetail
                        trackId={current.id}
                        compact
                        onUndone={() => (returnTo.current = current.id)}
                        onAdvance={() => {
                          const next = items[index + 1] ?? items[index - 1]
                          go(next ? next.id : null, "forward")
                        }}
                      />
                    </div>
                  </ViewTransition>
                )}
              </CardContent>
            </Card>
          </SwipeToDecide>
        </div>
      )}
    </>
  )
}
