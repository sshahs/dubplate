import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, CheckmarkCircle02Icon, Tag01Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Link, useSearchParams } from "react-router"
import { toast } from "sonner"
import { PageHeader } from "@/components/app-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"

/**
 * Where MusicBrainz's release editor sends a person back after they submit a
 * release Dubplate filled in: /musicbrainz/done?submission=ID&release_mbid=…
 */
export default function MusicBrainzDonePage() {
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const submission = Number(params.get("submission"))
  const [pasted, setPasted] = useState<string | null>(null)
  const mbid = pasted ?? params.get("release_mbid") ?? ""
  const [draft, setDraft] = useState("")

  const done = useQuery({
    queryKey: ["mb-complete", submission, mbid],
    queryFn: async () => {
      const r = await api.mbComplete(submission, mbid)
      void qc.invalidateQueries({ queryKey: ["track"] })
      return r
    },
    enabled: !!submission && !!mbid,
    retry: false,
    staleTime: Infinity,
  })
  const retag = useMutation({
    mutationFn: () => api.retag({ ids: done.data!.submission.trackIds }),
    onSuccess: (j) => toast(j.label, { description: "Runs in the background - watch the job dock." }),
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        eyebrow="MusicBrainz"
        title={done.data ? "Release added" : "Back from MusicBrainz"}
        description="Dubplate keeps the new release's IDs so the next tag update writes them into the files."
      />
      <Card>
        <CardContent className="space-y-4">
          {!submission && <p className="text-sm">This page is where MusicBrainz sends you back after adding a release. Start one from a track's Decision tab, or from a selection in Tracks.</p>}

          {!!submission && !mbid && (
            <div className="space-y-2">
              <p className="text-sm">MusicBrainz didn't send the release's ID back (it does once the release is submitted). If you did submit it, paste its link:</p>
              <div className="flex gap-2">
                <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="https://musicbrainz.org/release/…" aria-label="MusicBrainz release link" />
                <Button onClick={() => setPasted(draft.trim())} disabled={!draft.trim()}>
                  Save
                </Button>
              </div>
            </div>
          )}

          {done.isLoading && (
            <div className="space-y-2" aria-busy>
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}

          {done.error && (
            <div className="flex gap-2 text-sm">
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="text-rasta-red mt-0.5 size-4 shrink-0" />
              <span>{done.error.message}</span>
            </div>
          )}

          {done.data && (
            <>
              <div className="flex gap-2.5">
                <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="text-rasta-green mt-0.5 size-5 shrink-0" />
                <div className="text-sm">
                  <div className="font-medium">{done.data.submission.title}</div>
                  <p className="text-muted-foreground text-xs text-pretty">
                    Saved on {done.data.submission.trackIds.length} track{done.data.submission.trackIds.length === 1 ? "" : "s"}
                    {done.data.recordings ? `, ${done.data.recordings} with their MusicBrainz recording` : ""}.{" "}
                    <a className="underline underline-offset-2" href={`https://musicbrainz.org/release/${done.data.submission.releaseMbid}`} target="_blank" rel="noreferrer noopener">
                      Open it on MusicBrainz
                    </a>
                  </p>
                </div>
              </div>
              <p className="text-muted-foreground text-xs text-pretty">Tracks that are already cut need their tags updated to carry the IDs; the rest get them when they're cut.</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => retag.mutate()} disabled={retag.isPending}>
                  {retag.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={Tag01Icon} strokeWidth={2} data-icon="inline-start" />}
                  Update the tags now
                </Button>
                <Button variant="ghost" render={<Link to="/tracks" />} nativeButton={false}>
                  Back to tracks
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
