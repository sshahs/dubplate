import { HugeiconsIcon } from "@hugeicons/react"
import { CheckListIcon } from "@hugeicons/core-free-icons"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router"
import type { TrackStatus } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { ConfidenceMeter, StatusBadge } from "@/components/confidence"
import { TrackDetail } from "@/components/track-detail"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

const QUEUES: Record<string, { label: string; status: TrackStatus[] }> = {
  review: { label: "Needs review", status: ["review", "conflict"] },
  conflict: { label: "Conflicts", status: ["conflict"] },
  matched: { label: "Matched", status: ["matched"] },
  unmatched: { label: "Unmatched", status: ["unmatched"] },
}

export default function ReviewPage() {
  const [queue, setQueue] = useState("review")
  const [currentId, setCurrentId] = useState<number | null>(null)
  const filter = useMemo(() => ({ status: QUEUES[queue].status, sort: "confidence" as const, dir: "desc" as const, limit: 200 }), [queue])
  const { data } = useQuery({ queryKey: ["tracks", "review", filter], queryFn: () => api.tracks(filter) })
  const items = useMemo(() => data?.items ?? [], [data])
  const index = Math.max(0, items.findIndex((t) => t.id === currentId))
  const current = items[index]

  useEffect(() => {
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
        const next = items[index + 1]
        if (next) setCurrentId(next.id)
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        const prev = items[index - 1]
        if (prev) setCurrentId(prev.id)
      } else if (e.key === "a") {
        document.querySelector<HTMLButtonElement>("[data-review-action=approve]")?.click()
      } else if (e.key === "x") {
        document.querySelector<HTMLButtonElement>("[data-review-action=reject]")?.click()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [items, index])

  return (
    <>
      <PageHeader
        eyebrow="Selector's chair"
        title="Review"
        description="The tracks the engine wasn't sure about. Have a listen, check the evidence, and make the call — every approval teaches the AI your style."
        actions={
          <div className="text-muted-foreground hidden items-center gap-1.5 text-xs md:flex">
            <Kbd>J</Kbd>/<Kbd>K</Kbd> move · <Kbd>A</Kbd> approve · <Kbd>X</Kbd> leave as-is
          </div>
        }
      />
      <Tabs value={queue} onValueChange={(v) => setQueue(String(v))} className="mb-4 max-w-full overflow-x-auto">
        <TabsList>
          {Object.entries(QUEUES).map(([k, v]) => (
            <TabsTrigger key={k} value={k}>
              {v.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={CheckListIcon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>Queue clear — nuff respect</EmptyTitle>
            <EmptyDescription>Nothing waiting in "{QUEUES[queue].label}". Process more tracks or head to Cut & Tag.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link to="/execute" />}>Go to Cut & Tag</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <Card className="py-0 lg:sticky lg:top-20 lg:self-start">
            <ScrollArea className="h-[40vh] lg:h-[calc(100vh-14rem)]">
              <div className="p-2">
                {items.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setCurrentId(t.id)}
                    className={cn("w-full rounded-2xl p-2.5 text-left transition-colors", i === index ? "bg-muted" : "hover:bg-muted/50")}
                  >
                    <div className="truncate font-mono text-xs">{t.filename}</div>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <StatusBadge status={t.status} />
                      <ConfidenceMeter value={t.confidence} />
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
            <div className="text-muted-foreground border-t px-4 py-2 text-xs">
              {index + 1} of {data?.total ?? items.length}
            </div>
          </Card>
          <Card>
            <CardContent>
              {current && (
                <TrackDetail
                  key={current.id}
                  trackId={current.id}
                  compact
                  onAdvance={() => {
                    const next = items[index + 1] ?? items[index - 1]
                    setCurrentId(next ? next.id : null)
                  }}
                />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  )
}
