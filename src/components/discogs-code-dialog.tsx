import { HugeiconsIcon } from "@hugeicons/react"
import { CdIcon, LinkSquare02Icon, Search01Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import type { DiscogsLookup } from "@shared/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api, type Selection } from "@/lib/api"
import { fmtDuration } from "@/lib/format"
import { toastUndoable } from "@/lib/undo"

/**
 * "Enter a Discogs code": for a record no search finds, the person pastes the
 * release they found on Discogs - its link, its [r1234567] code or a catalogue
 * number - and the whole release is read: artists, title, label, year and the
 * tracklist. Each file is matched to its track on it (changeable), then approved.
 */
export function DiscogsCodeDialog({
  open,
  onOpenChange,
  selection,
  count,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selection: Selection
  count?: number
  onDone?: () => void
}) {
  const qc = useQueryClient()
  const [code, setCode] = useState("")
  const [found, setFound] = useState<DiscogsLookup | null>(null)
  const [picks, setPicks] = useState<Record<number, number | null>>({})
  const close = () => {
    onOpenChange(false)
    setCode("")
    setFound(null)
    setPicks({})
  }
  const lookup = useMutation({
    mutationFn: (c: string) => api.discogsLookup(selection, c),
    onSuccess: (r) => {
      setFound(r)
      setPicks(Object.fromEntries((r.matches ?? []).map((m) => [m.trackId, m.index])))
    },
    onError: (e) => toast.error(e.message),
  })
  const apply = useMutation({
    mutationFn: () => api.discogsApply(found!.release!.id, (found!.matches ?? []).map((m) => ({ trackId: m.trackId, index: picks[m.trackId] ?? null }))),
    onSuccess: (r) => {
      toastUndoable(qc, `Put "${r.release.title}" on ${r.applied} track${r.applied === 1 ? "" : "s"}`, r.undoId, {
        description: r.skipped ? `${r.skipped} left as they were` : "Approved with the release's details - cut them when you're ready",
      })
      void qc.invalidateQueries({ queryKey: ["track"] })
      void qc.invalidateQueries({ queryKey: ["tracks"] })
      onDone?.()
      close()
    },
    onError: (e) => toast.error(e.message),
  })
  const release = found?.release
  const placed = Object.values(picks).filter((v) => v !== null).length

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Use a Discogs release</DialogTitle>
          <DialogDescription className="text-pretty">
            Found the record on Discogs? Paste its link, its code (the <span className="font-mono">[r1234567]</span> at the bottom of the page) or its catalogue number, and Dubplate takes
            everything from that release{count && count > 1 ? ` for these ${count} tracks` : ""}: artists, titles, label, year, track numbers and the cover.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (code.trim()) lookup.mutate(code.trim())
          }}
        >
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="https://www.discogs.com/release/… or [r1234567]" aria-label="Discogs code or link" autoFocus />
          <Button type="submit" variant="secondary" disabled={!code.trim() || lookup.isPending}>
            {lookup.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={Search01Icon} strokeWidth={2} data-icon="inline-start" />}
            Look up
          </Button>
        </form>

        {found?.choices && (
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-xs">Several releases have that number - which is yours?</p>
            <ul className="max-h-72 space-y-1 overflow-auto">
              {found.choices.map((ch) => (
                <li key={ch.id}>
                  <button
                    type="button"
                    className="hover:bg-muted/60 flex w-full items-center gap-2 rounded-xl border p-2 text-left text-sm"
                    onClick={() => {
                      setCode(`r${ch.id}`)
                      lookup.mutate(`r${ch.id}`)
                    }}
                  >
                    {ch.thumb ? <img src={ch.thumb} alt="" className="size-10 shrink-0 rounded object-cover" /> : <HugeiconsIcon icon={CdIcon} strokeWidth={2} className="text-muted-foreground size-10 shrink-0 p-2" />}
                    <span className="min-w-0 flex-1">
                      <span className="block break-words">{ch.title}</span>
                      <span className="text-muted-foreground block text-xs">{[ch.label, ch.catno, ch.format, ch.country, ch.year].filter(Boolean).join(" · ")}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {release && (
          <div className="space-y-3 rounded-2xl border p-3 text-sm">
            <div className="flex gap-3">
              {release.artwork && <img src={release.artwork} alt="" className="size-16 shrink-0 rounded-lg object-cover" />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{release.title}</span>
                  {release.year && <Badge variant="outline">{release.year}</Badge>}
                </div>
                <div className="text-muted-foreground text-xs break-words">
                  by {release.artist}
                  {release.label ? ` · ${release.label}` : ""}
                  {release.catno ? ` · ${release.catno}` : ""}
                </div>
                {release.format && <div className="text-muted-foreground text-xs break-words">{release.format}</div>}
                <a className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline underline-offset-2" href={release.url} target="_blank" rel="noreferrer noopener">
                  <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} className="size-3" />
                  On Discogs
                </a>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium">Which track is each file?</div>
              <ul className="space-y-1.5">
                {(found?.matches ?? []).map((m) => (
                  <li key={m.trackId} className="grid gap-1 sm:grid-cols-[1fr_14rem] sm:items-center sm:gap-2">
                    <span className="text-muted-foreground min-w-0 truncate text-xs" title={m.filename}>
                      {m.filename}
                    </span>
                    <select
                      className="border-input bg-background h-8 w-full min-w-0 rounded-lg border px-2 text-xs"
                      aria-label={`Track on the release for ${m.filename}`}
                      value={picks[m.trackId] ?? ""}
                      onChange={(e) => setPicks((p) => ({ ...p, [m.trackId]: e.target.value === "" ? null : Number(e.target.value) }))}
                    >
                      <option value="">Leave this file alone</option>
                      {release.tracks.map((t) => (
                        <option key={t.index} value={t.index}>
                          {[t.position, t.artist ? `${t.artist} - ${t.title}` : t.title, t.duration ? fmtDuration(t.duration) : ""].filter(Boolean).join("  ")}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </div>

            <details>
              <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs underline underline-offset-2">The whole tracklist ({release.tracks.length})</summary>
              <ol className="mt-1.5 space-y-0.5 text-xs">
                {release.tracks.map((t) => (
                  <li key={t.index} className="flex gap-2">
                    <span className="text-muted-foreground w-8 shrink-0 text-right font-mono">{t.position}</span>
                    <span className="flex-1 break-words">{t.artist ? `${t.artist} - ${t.title}` : t.title}</span>
                    <span className="text-muted-foreground font-mono">{t.duration ? fmtDuration(t.duration) : ""}</span>
                  </li>
                ))}
              </ol>
            </details>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          {release && (
            <Button onClick={() => apply.mutate()} disabled={!placed || apply.isPending}>
              {apply.isPending && <Spinner data-icon="inline-start" />}
              Use it for {placed} track{placed === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
