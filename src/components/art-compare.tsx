import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight02Icon, MusicNote01Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import type { ArtRef, PlanItem } from "@shared/types"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { artSourceName } from "@/lib/art"
import { cn } from "@/lib/utils"

type Pic = Pick<ArtRef, "hash" | "width" | "height"> & Partial<Pick<ArtRef, "source" | "sourceLabel">>

const dims = (a: { width?: number; height?: number }) => (a.width ? `${a.width}×${a.height}` : "")

/** One picture with what it is under it; a click opens it full size. */
function Figure({ url, label, sub, size, faded }: { url: string | null; label: string; sub?: string; size: number; faded?: boolean }) {
  const [failed, setFailed] = useState(false)
  const img =
    url && !failed ? (
      <img src={url} alt={label} width={size} height={size} loading="lazy" decoding="async" className="size-full object-cover" onError={() => setFailed(true)} />
    ) : (
      <span className="flex flex-col items-center gap-1">
        <HugeiconsIcon icon={MusicNote01Icon} strokeWidth={2} className="text-muted-foreground/60 size-6" />
        <span className="text-muted-foreground text-[11px]">No picture</span>
      </span>
    )
  return (
    <figure className="flex min-w-0 flex-col items-center gap-1.5" style={{ width: size }}>
      {url && !failed ? (
        <a href={url.replace(/size=\d+/, "size=1200")} target="_blank" rel="noreferrer" title="Open full size" className={cn("bg-muted block overflow-hidden rounded-xl border", faded && "opacity-60")} style={{ width: size, height: size }}>
          {img}
        </a>
      ) : (
        <span className="bg-muted flex items-center justify-center rounded-xl border border-dashed" style={{ width: size, height: size }}>
          {img}
        </span>
      )}
      <figcaption className="w-full text-center leading-tight">
        <div className="truncate text-xs font-medium">{label}</div>
        {sub && <div className="text-muted-foreground text-[11px] break-words">{sub}</div>}
      </figcaption>
    </figure>
  )
}

/**
 * Before and after: the picture in the file now, the one that would replace it,
 * and - when a cut already replaced the file's own picture - the one it came with.
 */
export function ArtCompare({ trackId, before, after, original, size = 120 }: { trackId: number; before: Pic | null; after: Pic; original?: Pic | null; size?: number }) {
  const px = size * 2
  const showOriginal = original && original.hash !== before?.hash && original.hash !== after.hash
  return (
    <div className="flex flex-wrap items-center gap-3">
      {showOriginal && <Figure url={api.artUrlFor(trackId, "original", original.hash, px)} label="Came with" sub="before Dubplate" size={Math.round(size * 0.7)} faded />}
      <Figure url={before ? api.artUrlFor(trackId, "current", before.hash, px) : null} label="Before" sub={before ? `In the file${dims(before) ? ` · ${dims(before)}` : ""}` : "The file has none"} size={size} />
      <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} className="text-muted-foreground size-4 shrink-0" />
      <Figure url={api.artUrlFor(trackId, "found", after.hash, px)} label="After" sub={[after.source && artSourceName(after as Pick<ArtRef, "source" | "sourceLabel">), dims(after)].filter(Boolean).join(" · ")} size={size} />
    </div>
  )
}

/** The picture a file came with, when a cut since replaced it. */
export function ArtCompareOriginal({ trackId, hash, size = 64 }: { trackId: number; hash: string; size?: number }) {
  return <Figure url={api.artUrlFor(trackId, "original", hash, size * 2)} label="Came with" sub="before Dubplate" size={size} faded />
}

/**
 * Cut & Tag: every file with new artwork, before and after, to say yes or no to.
 * Nothing waiting is written until a person says "use it".
 */
export function ArtworkChoiceDialog({ items, open, onOpenChange }: { items: PlanItem[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient()
  const withArt = items.filter((p) => p.art)
  const waiting = withArt.filter((p) => p.art!.waiting)
  const choose = useMutation({
    mutationFn: ({ ids, use }: { ids: number[]; use: boolean }) => api.chooseArtwork(ids, use),
    onSuccess: (r, { ids, use }) => {
      void qc.invalidateQueries({ queryKey: ["tracks"] })
      if (ids.length > 1) toast(use ? `Using the new artwork for ${r.changed} files` : `Keeping the files' own pictures for ${r.changed} files`)
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Use the new artwork?</DialogTitle>
          <DialogDescription>
            {waiting.length
              ? `${waiting.length} file${waiting.length === 1 ? " has" : "s have"} new artwork waiting for your OK. It's only written when you say so - until then each file keeps its own picture.`
              : "Every file's artwork has been decided. Change your mind on any of them here."}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 divide-y overflow-y-auto border-y px-6">
          {withArt.map((p) => (
            <div key={p.trackId} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="truncate text-sm font-medium" title={p.toName}>
                  {p.toName}
                </div>
                <ArtCompare trackId={p.trackId} before={p.art!.before} after={p.art!.after} size={88} />
              </div>
              <div className="flex shrink-0 gap-1.5 sm:flex-col">
                {p.art!.waiting ? (
                  <>
                    <Button size="sm" onClick={() => choose.mutate({ ids: [p.trackId], use: true })} disabled={choose.isPending}>
                      Use new
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => choose.mutate({ ids: [p.trackId], use: false })} disabled={choose.isPending}>
                      {p.art!.replaces ? "Keep original" : "No artwork"}
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="text-rasta-green text-xs font-medium">Using the new one</span>
                    <Button size="xs" variant="ghost" onClick={() => choose.mutate({ ids: [p.trackId], use: false })} disabled={choose.isPending}>
                      {p.art!.replaces ? "Keep original instead" : "Don't use it"}
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          {waiting.length > 1 && (
            <>
              <Button variant="outline" onClick={() => choose.mutate({ ids: waiting.map((p) => p.trackId), use: false })} disabled={choose.isPending}>
                Keep all {waiting.length} as they are
              </Button>
              <Button onClick={() => choose.mutate({ ids: waiting.map((p) => p.trackId), use: true })} disabled={choose.isPending}>
                Use all {waiting.length} new
              </Button>
            </>
          )}
          {waiting.length <= 1 && <Button onClick={() => onOpenChange(false)}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
