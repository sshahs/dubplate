import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, ArrowRight02Icon, Folder01Icon, Image01Icon, Scissor01Icon, SquareLock02Icon, TestTube01Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import type { ExistingTags } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { ArtworkChoiceDialog } from "@/components/art-compare"
import { BatchRow } from "@/components/batch-row"
import { QueryError } from "@/components/query-error"
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
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api } from "@/lib/api"
import { useActiveJobs } from "@/lib/events"
import { cn } from "@/lib/utils"

const TAG_NAMES: Partial<Record<keyof ExistingTags, string>> = {
  cover: "artwork",
  bpm: "BPM",
  mbRecordingId: "MusicBrainz IDs",
  mbReleaseId: "MusicBrainz IDs",
  mbArtistId: "MusicBrainz IDs",
  discogsReleaseId: "Discogs ID",
  replayGainTrackGain: "ReplayGain",
  replayGainTrackPeak: "ReplayGain",
  lyrics: "lyrics",
  track: "track number",
  disc: "disc number",
  discTotal: "disc number",
}

export default function ExecutePage() {
  const qc = useQueryClient()
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const { data: plan, isLoading: planLoading, error: planError, refetch: refetchPlan } = useQuery({ queryKey: ["tracks", "plan"], queryFn: () => api.plan() })
  const { data: batches } = useQuery({ queryKey: ["batches"], queryFn: api.batches })
  const { data: libraries } = useQuery({ queryKey: ["libraries"], queryFn: api.libraries })
  const libName = (id: number) => libraries?.find((l) => l.id === id)?.name ?? "another library"
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [choosingArt, setChoosingArt] = useState(false)
  // A cut or rewind in flight: lock the controls and show its progress.
  const writing = useActiveJobs().find((j) => j.kind === "execute" || j.kind === "rewind")

  const readOnly = settings?.safety.readOnly ?? true
  const setReadOnly = useMutation({
    mutationFn: (v: boolean) => api.saveSettings({ safety: { readOnly: v } }),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s)
      void qc.invalidateQueries({ queryKey: ["health"] })
      toast(s.safety.readOnly ? "Read-only mode on - files are safe" : "Writes enabled - handle with care")
    },
  })

  const runnable = useMemo(() => (plan ?? []).filter((p) => !p.blocked && !excluded.has(p.trackId)), [plan, excluded])
  const blocked = (plan ?? []).filter((p) => p.blocked)
  // Found artwork waits for a person's OK before it's written (Settings → Artwork).
  const artWaiting = (plan ?? []).filter((p) => p.art?.waiting)
  const artChosen = (plan ?? []).filter((p) => p.art && !p.art.waiting)

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
            {settings?.organise.onCut && (
              <>
                {" "}
                · into folders <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{settings.organise.template}</code> ·{" "}
                <Link to="/organise" className="underline underline-offset-2">
                  layout
                </Link>
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {planLoading && (
            <div className="space-y-3">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}
          {planError && !plan && <QueryError compact error={planError} onRetry={() => void refetchPlan()} />}
          {!plan?.length && !planLoading && !planError && (
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
              {(artWaiting.length > 0 || artChosen.length > 0) && (
                <div className={cn("flex flex-wrap items-center gap-3 rounded-2xl border p-3", artWaiting.length ? "border-rasta-gold/50 bg-rasta-gold/5" : "bg-card/60")}>
                  <HugeiconsIcon icon={Image01Icon} strokeWidth={2} className={cn("size-5 shrink-0", artWaiting.length ? "text-rasta-gold" : "text-muted-foreground")} />
                  <div className="min-w-0 flex-1 text-sm">
                    {artWaiting.length ? (
                      <>
                        <span className="font-medium">
                          {artWaiting.length} file{artWaiting.length === 1 ? " has" : "s have"} new artwork waiting for your OK.
                        </span>{" "}
                        <span className="text-muted-foreground">Until you choose, cutting leaves each file's own picture as it is.</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        New artwork you chose goes into {artChosen.length} file{artChosen.length === 1 ? "" : "s"} with this cut.
                      </span>
                    )}
                  </div>
                  <Button size="sm" variant={artWaiting.length ? "default" : "outline"} onClick={() => setChoosingArt(true)}>
                    Compare & choose
                  </Button>
                </div>
              )}
              <ArtworkChoiceDialog items={plan} open={choosingArt} onOpenChange={setChoosingArt} />
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
                          Files are renamed in place and their tags updated. Each change is journalled - you can rewind the whole batch from the history below.
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
                          {(p.toDir !== p.fromDir || p.toLibraryId) && (
                            <div className="text-rasta-gold flex min-w-0 items-center gap-1 text-xs" title={p.toLibraryId ? `Into ${libName(p.toLibraryId)}: ${p.toDir || "its top folder"}` : p.toDir || "the library's top folder"}>
                              <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-3 shrink-0" />
                              <span className="truncate">
                                {p.toLibraryId && <span className="font-medium">{libName(p.toLibraryId)} › </span>}
                                {p.toDir || "top folder"}/
                              </span>
                            </div>
                          )}
                          <div className="truncate text-sm font-medium" title={p.toPath}>
                            {p.toName !== p.fromName ? p.toName : <span className="text-muted-foreground">name unchanged</span>}
                          </div>
                          {p.issues.map((i) => (
                            <div key={i} className="text-rasta-gold mt-0.5 flex items-center gap-1 text-xs">
                              <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3" />
                              {i}
                            </div>
                          ))}
                        </TableCell>
                        <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                          {p.tagChanges.length ? [...new Set(p.tagChanges.map((c) => TAG_NAMES[c.field] ?? c.field))].join(", ") : "–"}
                          {p.art && (
                            <button
                              type="button"
                              onClick={() => setChoosingArt(true)}
                              title={p.art.waiting ? "New artwork, waiting for your OK - compare and choose" : "New artwork you chose - change your mind"}
                              className="hover:bg-muted mt-1 flex items-center gap-1 rounded-lg p-0.5"
                            >
                              <Thumb url={p.art.before ? api.artUrlFor(p.trackId, "current", p.art.before.hash, 64) : null} />
                              <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} className="size-3" />
                              <Thumb url={api.artUrlFor(p.trackId, "found", p.art.after.hash, 64)} />
                              {p.art.waiting && <span className="text-rasta-gold ml-1 font-medium">needs your OK</span>}
                            </button>
                          )}
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

/** A small cover in the plan; an empty box when the file has no picture. */
function Thumb({ url }: { url: string | null }) {
  return url ? <img src={url} alt="" width={28} height={28} loading="lazy" className="size-7 rounded-md border object-cover" /> : <span className="bg-muted size-7 rounded-md border border-dashed" />
}
