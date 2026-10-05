import { HugeiconsIcon } from "@hugeicons/react"
import { AudioWave01Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import type { Candidate, Track } from "@shared/types"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { fmtDuration } from "@/lib/format"
import { cn } from "@/lib/utils"

/** How sure AcoustID is, in words a person reads at a glance. */
function sureness(score: number): { word: string; tone: string } {
  if (score >= 0.9) return { word: "sure", tone: "text-rasta-green" }
  if (score >= 0.6) return { word: "likely", tone: "text-foreground" }
  return { word: "a guess", tone: "text-rasta-gold" }
}

/**
 * Listen: identify a track by its sound alone, the way Shazam does, and pick from
 * what it heard. "Use" fills in the details; Approve & learn does the rest.
 */
export function ListenButton({ track, onUse }: { track: Track; onUse: (c: Candidate) => void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const listen = useMutation({
    mutationFn: () => api.listen(track.id),
    onSuccess: (r) => {
      qc.setQueryData(["track", track.id], r.track)
      void qc.invalidateQueries({ queryKey: ["tracks"] })
    },
  })
  const start = () => {
    setOpen(true)
    listen.mutate()
  }
  const r = listen.data
  const needsSetup = listen.error && /AcoustID application key|fpcalc/.test(listen.error.message)

  return (
    <>
      <Button variant="outline" onClick={start} disabled={listen.isPending} title="Identify it by the sound alone, like Shazam">
        {listen.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={AudioWave01Icon} strokeWidth={2} data-icon="inline-start" />}
        Listen
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>What it sounds like</DialogTitle>
            <DialogDescription>
              Identified by the sound alone: the first two minutes are fingerprinted and checked with AcoustID, the way Shazam does. It isn't always right - pick the one you know, check the details, then
              Approve & learn.
            </DialogDescription>
          </DialogHeader>

          <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
            {listen.isPending && (
              <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
                <Spinner /> Listening to {track.filename}…
              </div>
            )}
            {listen.error && (
              <div className="space-y-2 py-2 text-sm">
                <p className="text-rasta-red">{listen.error.message}</p>
                {needsSetup && (
                  <Link to="/sources" className="underline underline-offset-2">
                    Set up AcoustID in Sources
                  </Link>
                )}
              </div>
            )}
            {r && !r.suggestions.length && (
              <div className="text-muted-foreground space-y-2 py-2 text-sm">
                <p className="text-foreground font-medium">{r.unnamed ? "AcoustID knows this audio, but nobody has named it yet." : "AcoustID doesn't recognise this audio."}</p>
                <p>
                  {r.unnamed
                    ? "Someone has fingerprinted it before without linking it to a MusicBrainz recording."
                    : "It's never been fingerprinted - common for dubplates, specials and private or home recordings."}{" "}
                  Once you've named it and approved it, you can send its fingerprint to AcoustID from the Decision tab, so it's recognised next time.
                </p>
              </div>
            )}
            {!!r?.suggestions.length && (
              <div className="divide-y rounded-xl border">
                {r.suggestions.map((c, i) => {
                  const score = c.sourceScore ?? 0
                  const s = sureness(score)
                  const sameLength = c.duration && track.duration ? Math.abs(c.duration - track.duration) <= 3 : false
                  const details = [c.album, c.duration && `${fmtDuration(c.duration)}${sameLength ? " (same length as your file)" : ""}`].filter(Boolean).join(" · ")
                  return (
                    <div key={`${c.externalId ?? c.url ?? ""}-${i}`} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="w-14 shrink-0 text-center">
                        <div className={cn("font-heading text-lg font-bold tabular-nums", s.tone)}>{Math.round(score * 100)}%</div>
                        <div className={cn("text-[11px]", s.tone)}>{s.word}</div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-2 text-sm font-medium break-words" title={`${c.artist} - ${c.title}`}>
                          {c.artist} - {c.title}
                        </div>
                        {details && (
                          <div className="text-muted-foreground truncate text-xs" title={details}>
                            {details}
                          </div>
                        )}
                      </div>
                      {c.url && (
                        <a href={c.url} target="_blank" rel="noreferrer noopener" className="text-muted-foreground hover:text-foreground" aria-label="Open on MusicBrainz">
                          <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} className="size-4" />
                        </a>
                      )}
                      <Button
                        size="sm"
                        variant={i === 0 && score >= 0.6 ? "default" : "outline"}
                        aria-label={`Use ${c.artist} - ${c.title}`}
                        onClick={() => {
                          onUse(c)
                          setOpen(false)
                          toast(`Filled in: ${c.artist} - ${c.title}`, { description: "Check the details, then Approve & learn." })
                        }}
                      >
                        Use
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <DialogFooter>
            {(r || listen.error) && !needsSetup && (
              <Button variant="ghost" onClick={() => listen.mutate()} disabled={listen.isPending}>
                Listen again
              </Button>
            )}
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
