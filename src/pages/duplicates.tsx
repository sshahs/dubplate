import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import type { DuplicateGroup } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { BatchRow } from "@/components/batch-row"
import { QueryError } from "@/components/query-error"
import { ConfidenceMeter, StatusBadge } from "@/components/confidence"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { useActiveJobs } from "@/lib/events"
import { fmtBytes, fmtDuration } from "@/lib/format"
import { cn } from "@/lib/utils"

const groupKey = (g: DuplicateGroup) => `${g.kind}:${g.key}`

function GroupCard({ group, keep, onKeep, onResolve, disabled }: { group: DuplicateGroup; keep: number; onKeep: (id: number) => void; onResolve: () => void; disabled: boolean }) {
  const others = group.tracks.length - 1
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <Badge variant={group.kind === "hash" ? "secondary" : "outline"}>{group.kind === "hash" ? "identical audio" : "same proposed name"}</Badge>
          <span className="truncate text-sm font-medium">{group.kind === "name" ? group.key : `${group.tracks.length} copies`}</span>
        </CardTitle>
        {group.kind === "name" && (
          <CardDescription className="flex items-center gap-1.5 text-xs">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="text-rasta-gold size-3.5 shrink-0" />
            Different files - have a listen before setting any aside, they may be different cuts.
          </CardDescription>
        )}
        <CardAction>
          <Button size="sm" variant="outline" onClick={onResolve} disabled={disabled}>
            Set aside {others === 1 ? "the other" : `the other ${others}`}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div role="radiogroup" aria-label="Copy to keep" className="space-y-1">
          {group.tracks.map((t) => {
            const kept = t.id === keep
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={kept}
                onClick={() => onKeep(t.id)}
                className={cn("flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2.5 py-2 text-left text-xs transition-colors", kept ? "bg-rasta-green/10" : "hover:bg-muted/50")}
              >
                <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border-2", kept ? "border-rasta-green bg-rasta-green" : "border-muted-foreground/40")}>
                  {kept && <HugeiconsIcon icon={Tick02Icon} strokeWidth={3} className="size-2.5 text-white" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono" title={t.path}>
                    {t.relDir ? `${t.relDir}/` : ""}
                    {t.filename}
                  </span>
                  <span className={cn("block", kept ? "text-rasta-green" : "text-muted-foreground")}>
                    {kept ? "Keep" : "Set aside"} · {group.reasons[t.id]}
                    {t.id === group.best && !kept && " · suggested"}
                  </span>
                </span>
                <span className="text-muted-foreground font-mono">{fmtDuration(t.duration)}</span>
                <span className="text-muted-foreground w-10 text-right font-mono">{t.bitrate ? `${Math.round(t.bitrate / 1000)}k` : ""}</span>
                <span className="text-muted-foreground w-16 text-right font-mono">{fmtBytes(t.size)}</span>
                <ConfidenceMeter value={t.confidence} />
                <StatusBadge status={t.status} />
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

export default function DuplicatesPage() {
  const { data, error, refetch } = useQuery({ queryKey: ["tracks", "duplicates"], queryFn: api.duplicates })
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const { data: batches } = useQuery({ queryKey: ["batches"], queryFn: api.batches })
  const [choice, setChoice] = useState<Record<string, number>>({})
  const working = useActiveJobs().find((j) => j.kind === "duplicates")
  const readOnly = settings?.safety.readOnly ?? true

  const resolve = useMutation({
    mutationFn: (groups: { keep: number; aside: number[] }[]) => api.resolveDuplicates(groups),
    onSuccess: (j) => toast(j.label, { description: `Moved into "${data?.holdingFolder}". Rewind from the history below if that was wrong.` }),
    onError: (e) => toast.error(e.message),
  })

  const groups = data?.groups ?? []
  const keepOf = (g: DuplicateGroup) => choice[groupKey(g)] ?? g.best
  const resolution = (g: DuplicateGroup) => ({ keep: keepOf(g), aside: g.tracks.filter((t) => t.id !== keepOf(g)).map((t) => t.id) })
  const identical = groups.filter((g) => g.kind === "hash")
  const identicalCopies = identical.reduce((n, g) => n + g.tracks.length - 1, 0)
  const history = (batches ?? []).filter((b) => b.label === "Set aside duplicates").slice(0, 5)
  const busy = readOnly || !!working || resolve.isPending

  return (
    <>
      <PageHeader
        eyebrow="Doubles"
        title="Duplicates"
        description="Identical audio, and different files that would end up with the same name. Pick the copy to keep: the others are set aside in a holding folder inside their library - never deleted - and Rewind brings them back."
        actions={
          identical.length > 0 && (
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button disabled={busy}>
                    {working ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} data-icon="inline-start" />}
                    {working ? `Moving ${working.done + working.failed}/${working.total || "?"}` : "Keep the best of every identical copy"}
                  </Button>
                }
              />
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Set aside {identicalCopies} identical copies?</AlertDialogTitle>
                  <AlertDialogDescription>
                    In each of the {identical.length} groups of identical audio, the copy marked Keep stays and the rest move to "{data?.holdingFolder}" in their library. Groups with the
                    same name but different audio aren't touched.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Not yet</AlertDialogCancel>
                  <AlertDialogAction onClick={() => resolve.mutate(identical.map(resolution))}>Set them aside</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )
        }
      />
      {error && !data && <QueryError error={error} onRetry={() => void refetch()} />}
      {!data && !error && (
        <div className="space-y-3">
          <Skeleton className="h-32 rounded-4xl" />
          <Skeleton className="h-32 rounded-4xl" />
        </div>
      )}
      {data && (readOnly || data.setAside > 0) && (
        <div className="text-muted-foreground mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {data.setAside > 0 && (
            <span>
              {data.setAside} cop{data.setAside === 1 ? "y is" : "ies are"} set aside in "{data.holdingFolder}".
            </span>
          )}
          {readOnly && groups.length > 0 && (
            <span>
              Read-only mode is on -{" "}
              <Link to="/execute#safety" className="underline underline-offset-2">
                switch it off in Cut & Tag
              </Link>{" "}
              to move files.
            </span>
          )}
        </div>
      )}
      {data && groups.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No doubles found</EmptyTitle>
            <EmptyDescription>Every file is unique, and no two proposed names collide.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <div className="space-y-3">
        {groups.map((g) => (
          <GroupCard
            key={groupKey(g)}
            group={g}
            keep={keepOf(g)}
            onKeep={(id) => setChoice((c) => ({ ...c, [groupKey(g)]: id }))}
            onResolve={() => resolve.mutate([resolution(g)])}
            disabled={busy}
          />
        ))}
      </div>
      {history.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Set aside so far</CardTitle>
            <CardDescription>Rewind moves the copies back where they were.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {history.map((b) => (
              <BatchRow key={b.batchId} batch={b} busy={!!working} />
            ))}
          </CardContent>
        </Card>
      )}
    </>
  )
}
