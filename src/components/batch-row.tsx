import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight02Icon, Backward01Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import type { Operation, OperationBatch } from "@shared/types"
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { api } from "@/lib/api"
import { fmtAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

const parts = (p: string) => p.split(/[\\/]/)

/** The file's name, with its folder when the operation moved it to another one. */
function shown(op: Operation, which: "from" | "to") {
  const from = parts(op.fromPath)
  const to = parts(op.toPath)
  const p = which === "from" ? from : to
  const sameFolder = from.slice(0, -1).join("/") === to.slice(0, -1).join("/")
  return sameFolder ? p.at(-1)! : p.slice(-2).join("/")
}

const REWIND_WHAT: Record<string, string> = {
  Cut: "goes back to its old name and old tags",
  Organise: "goes back to the folder it came from",
  "Set aside duplicates": "comes back out of the holding folder",
}

export function BatchRow({ batch, busy }: { batch: OperationBatch; busy: boolean }) {
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
          <span className={cn("size-2 shrink-0 rounded-full", batch.dryRun ? "bg-muted-foreground" : batch.failed ? "bg-rasta-gold" : batch.reverted === batch.count ? "bg-muted-foreground" : "bg-rasta-green")} />
          <span className="text-sm font-medium">{batch.label}</span>
          <span className="text-muted-foreground text-sm">
            {batch.count} file{batch.count === 1 ? "" : "s"}
          </span>
          <span className="text-muted-foreground hidden font-mono text-xs sm:inline">{batch.batchId.slice(0, 8)}</span>
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
                  Pull up! Every file in this {batch.label.toLowerCase()} {REWIND_WHAT[batch.label] ?? "goes back as it was"} - as long as nothing else has touched it since.
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
              <span className={cn("w-16 shrink-0", op.status === "done" ? "text-rasta-green" : op.status === "failed" ? "text-rasta-red" : "text-muted-foreground")}>{op.status}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono" title={op.fromPath}>
                {shown(op, "from")}
              </span>
              <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={op.toPath}>
                {shown(op, "to")}
              </span>
              {op.error && <span className="text-rasta-red truncate">{op.error}</span>}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
