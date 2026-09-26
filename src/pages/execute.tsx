import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, ArrowRight02Icon, Backward01Icon, Scissor01Icon, SquareLock02Icon, TestTube01Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import type { OperationBatch } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { ConfidenceMeter } from "@/components/confidence"
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api } from "@/lib/api"
import { useActiveJobs } from "@/lib/events"
import { fmtAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

function BatchRow({ batch, busy }: { batch: OperationBatch; busy: boolean }) {
  const [open, setOpen] = useState(false)
  const { data: ops } = useQuery({ queryKey: ["ops", batch.batchId], queryFn: () => api.operations(batch.batchId), enabled: open })
  const rewind = useMutation({
    mutationFn: () => api.rewind({ batchId: batch.batchId }),
    onSuccess: (j) => toast(j.label, { description: "Wheel up and come again…" }),
    onError: (e) => toast.error(e.message),
  })
  const canRewind = !batch.dryRun && batch.done > 0
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="animate-in fade-in slide-in-from-top-1 rounded-2xl border duration-300">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className={cn("size-2 rounded-full", batch.dryRun ? "bg-muted-foreground" : batch.failed ? "bg-rasta-gold" : batch.reverted === batch.count ? "bg-muted-foreground" : "bg-rasta-green")} />
          <span className="font-mono text-xs">{batch.batchId.slice(0, 8)}</span>
          <span className="text-sm">
            {batch.count} file{batch.count === 1 ? "" : "s"}
          </span>
          {batch.dryRun && <Badge variant="outline">dry run</Badge>}
          {batch.failed > 0 && <Badge variant="destructive">{batch.failed} failed</Badge>}
          {batch.reverted > 0 && <Badge variant="secondary">{batch.reverted} rewound</Badge>}
          <span className="text-muted-foreground ml-auto text-xs">{fmtAgo(batch.createdAt)}</span>
        </CollapsibleTrigger>
        {canRewind && (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button size="sm" variant="outline" disabled={rewind.isPending || busy}>
                  <HugeiconsIcon icon={Backward01Icon} strokeWidth={2} data-icon="inline-start" />
                  Rewind
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Rewind this batch?</AlertDialogTitle>
                <AlertDialogDescription>
                  Pull up! Every file in batch {batch.batchId.slice(0, 8)} goes back to its old name and old tags — as long as nothing else has touched it since.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => rewind.mutate()}>Rewind</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      <CollapsibleContent>
        <div className="space-y-1 border-t p-3">
          {ops?.map((op) => (
            <div key={op.id} className="flex items-center gap-2 text-xs">
              <span
                className={cn(
                  "w-16 shrink-0",
                  op.status === "done" ? "text-rasta-green" : op.status === "failed" ? "text-rasta-red" : "text-muted-foreground"
                )}
              >
                {op.status}
              </span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono" title={op.fromPath}>
                {op.fromPath.split(/[\\/]/).pop()}
              </span>
              <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={op.toPath}>
                {op.toPath.split(/[\\/]/).pop()}
              </span>
              {op.error && <span className="text-rasta-red truncate">{op.error}</span>}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export default function ExecutePage() {
  const qc = useQueryClient()
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const { data: plan, isLoading: planLoading } = useQuery({ queryKey: ["tracks", "plan"], queryFn: () => api.plan() })
  const { data: batches } = useQuery({ queryKey: ["batches"], queryFn: api.batches })
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  // A cut or rewind in flight: lock the controls and show its progress.
  const writing = useActiveJobs().find((j) => j.kind === "execute" || j.kind === "rewind")

  const readOnly = settings?.safety.readOnly ?? true
  const setReadOnly = useMutation({
    mutationFn: (v: boolean) => api.saveSettings({ safety: { readOnly: v } }),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s)
      void qc.invalidateQueries({ queryKey: ["health"] })
      toast(s.safety.readOnly ? "Read-only mode on — files are safe" : "Writes enabled — handle with care")
    },
  })

  const runnable = useMemo(() => (plan ?? []).filter((p) => !p.blocked && !excluded.has(p.trackId)), [plan, excluded])
  const blocked = (plan ?? []).filter((p) => p.blocked)

  const execute = useMutation({
    mutationFn: (dryRun: boolean) => api.execute({ ids: runnable.map((p) => p.trackId) }, dryRun),
    onSuccess: (j) => {
      toast(j.label)
      void qc.invalidateQueries({ queryKey: ["batches"] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <>
      <PageHeader
        eyebrow="Cut the plates"
        title="Cut & Tag"
        description="Verify the plan, then rename and tag approved files. Every change is journalled so any batch can be rewound."
      />

      <Card id="safety" className={cn("mb-4", readOnly ? "border-rasta-green/30" : "border-rasta-red/40")}>
        <CardContent className="flex flex-wrap items-center gap-4">
          <div className={cn("flex size-10 items-center justify-center rounded-2xl", readOnly ? "bg-rasta-green/15 text-rasta-green" : "bg-rasta-red/15 text-rasta-red")}>
            <HugeiconsIcon icon={SquareLock02Icon} strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-heading font-bold">{readOnly ? "Read-only mode is on" : "Writes are enabled"}</div>
            <div className="text-muted-foreground text-sm">
              {readOnly ? "Dry runs work, but nothing on disk can change. Switch off when you're ready to cut." : "Dubplate can rename and retag approved files. Rewind is available for every batch."}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={readOnly} onCheckedChange={(v) => setReadOnly.mutate(v)} />
            Read-only
          </label>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>The plan</CardTitle>
          <CardDescription>
            Template <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{settings?.naming.template}</code> · rename{" "}
            {settings?.naming.renameFiles ? "on" : "off"} · tags {settings?.naming.writeTags ? "on" : "off"} ·{" "}
            <Link to="/settings#naming" className="underline underline-offset-2">
              change
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {planLoading && (
            <div className="space-y-3">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}
          {!plan?.length && !planLoading && (
            <div className="text-muted-foreground text-sm">
              {batches?.some((b) => !b.dryRun && b.done > 0) ? "Every approved track has been cut. " : "No approved tracks yet. "}
              Approve matches in{" "}
              <Link to="/review" className="underline">
                Review
              </Link>{" "}
              or bulk-approve from{" "}
              <Link to="/tracks?status=matched" className="underline">
                Tracks
              </Link>
              .
            </div>
          )}
          {!!plan?.length && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{runnable.length} ready</Badge>
                {blocked.length > 0 && <Badge variant="outline">{blocked.length} blocked or already clean</Badge>}
                <div className="ml-auto flex gap-2">
                  <Button variant="outline" onClick={() => execute.mutate(true)} disabled={!runnable.length || execute.isPending || !!writing}>
                    <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} data-icon="inline-start" />
                    Dry run
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button disabled={!runnable.length || readOnly || execute.isPending || !!writing}>
                          {writing ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={Scissor01Icon} strokeWidth={2} data-icon="inline-start" />}
                          {writing ? `Cutting ${writing.done + writing.failed}/${writing.total || "?"}` : `Rename & tag ${runnable.length}`}
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Cut {runnable.length} files?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Files are renamed in place and their tags updated. Each change is journalled — you can rewind the whole batch from the history below.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Not yet</AlertDialogCancel>
                        <AlertDialogAction onClick={() => execute.mutate(false)}>Run it</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
              <div className="overflow-hidden rounded-2xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10 pl-4" />
                      <TableHead>From</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead className="hidden md:table-cell">Tags</TableHead>
                      <TableHead className="hidden md:table-cell">Conf.</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.map((p) => (
                      <TableRow key={p.trackId} className={cn(p.blocked && "opacity-60")}>
                        <TableCell className="pl-4">
                          <Checkbox
                            disabled={p.blocked}
                            checked={!p.blocked && !excluded.has(p.trackId)}
                            onCheckedChange={() => {
                              const next = new Set(excluded)
                              if (next.has(p.trackId)) next.delete(p.trackId)
                              else next.add(p.trackId)
                              setExcluded(next)
                            }}
                            aria-label={`Include ${p.fromName}`}
                          />
                        </TableCell>
                        <TableCell className="max-w-[16rem]">
                          <div className="text-muted-foreground truncate font-mono text-xs" title={p.fromPath}>
                            {p.fromName}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[20rem]">
                          <div className="truncate text-sm font-medium" title={p.toPath}>
                            {p.rename ? p.toName : <span className="text-muted-foreground">name unchanged</span>}
                          </div>
                          {p.issues.map((i) => (
                            <div key={i} className="text-rasta-gold mt-0.5 flex items-center gap-1 text-xs">
                              <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3" />
                              {i}
                            </div>
                          ))}
                        </TableCell>
                        <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                          {p.tagChanges.length ? p.tagChanges.map((c) => c.field).join(", ") : "–"}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <ConfidenceMeter value={p.confidence} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>Every batch Dubplate has run. Rewind puts names and tags back exactly as they were.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {!batches?.length && <div className="text-muted-foreground text-sm">Nothing cut yet.</div>}
          {batches?.map((b) => (
            <BatchRow key={b.batchId} batch={b} busy={!!writing} />
          ))}
        </CardContent>
      </Card>
    </>
  )
}
