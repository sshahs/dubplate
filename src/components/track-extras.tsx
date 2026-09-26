import { HugeiconsIcon } from "@hugeicons/react"
import { Image01Icon, RefreshIcon } from "@hugeicons/core-free-icons"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { formatBpm, parseKey, toCamelot } from "@shared/keys"
import type { Track } from "@shared/types"
import { Cover } from "@/components/cover"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

const SOURCE_NAMES: Record<string, string> = {
  musicbrainz: "Cover Art Archive",
  discogs: "Discogs",
  bandcamp: "Bandcamp",
  itunes: "Apple Music",
  deezer: "Deezer",
  spotify: "Spotify",
}

function useTrackUpdate(trackId: number) {
  const qc = useQueryClient()
  return (updated: Track) => {
    qc.setQueryData(["track", trackId], updated)
    void qc.invalidateQueries({ queryKey: ["tracks"] })
  }
}

/** The file's picture, the one Dubplate found to replace it, and what happens on cut. */
export function ArtworkPanel({ track, embed, replace }: { track: Track; embed: boolean; replace: boolean }) {
  const saved = useTrackUpdate(track.id)
  const find = useMutation({
    mutationFn: () => api.findTrackArtwork(track.id),
    onSuccess: (t) => {
      saved(t)
      toast(t.artFound ? "Found artwork" : "The file's own artwork is the best match")
    },
    onError: (e) => toast.error(e.message),
  })
  const drop = useMutation({ mutationFn: () => api.dropFoundArtwork(track.id), onSuccess: saved, onError: (e) => toast.error(e.message) })
  const found = track.artFound
  const willEmbed = !!found && embed && (!track.art || replace)
  const size = (a: { width?: number; height?: number } | null) => (a?.width ? `${a.width}×${a.height}` : "")

  let line: string
  if (found) {
    const from = SOURCE_NAMES[found.source] ?? found.sourceLabel ?? found.source
    line = willEmbed
      ? `From ${from}${size(found) ? ` · ${size(found)}` : ""} — embedded when you cut.`
      : !embed
        ? `From ${from}. Embedding is off in Settings.`
        : `From ${from}. The file already has a picture; replacing it is off in Settings.`
  } else line = track.art ? `The file has its own picture${size(track.art) ? ` (${size(track.art)})` : ""}.` : "No picture yet."

  return (
    <div className="bg-card/60 flex items-center gap-3 rounded-2xl border p-3">
      <div className="flex shrink-0 items-center gap-1.5">
        {found && track.art && <Cover track={track} which="current" size={44} className="opacity-60" />}
        <Cover track={track} which={found ? "found" : "current"} size={64} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Artwork</div>
        <p className="text-muted-foreground text-xs">{line}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Button size="xs" variant="outline" onClick={() => find.mutate()} disabled={find.isPending}>
            {find.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={Image01Icon} strokeWidth={2} data-icon="inline-start" />}
            {found ? "Look again" : "Find artwork"}
          </Button>
          {found && (
            <Button size="xs" variant="ghost" onClick={() => drop.mutate()} disabled={drop.isPending}>
              Don't use it
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** BPM and key: what's set, what the analyser heard, and a way to fix either. */
export function TempoKeyPanel({ track, notation }: { track: Track; notation: "musical" | "camelot" }) {
  const saved = useTrackUpdate(track.id)
  const [draft, setDraft] = useState<{ bpm: string; key: string } | null>(null)
  const save = useMutation({
    mutationFn: (v: { bpm: string; key: string }) => api.updateTrack(track.id, { bpm: v.bpm ? Number(v.bpm) : null, key: v.key || null }),
    onSuccess: (t) => {
      saved(t)
      setDraft(null)
    },
    onError: (e) => toast.error(e.message),
  })
  const analyse = useMutation({
    mutationFn: () => api.analyze({ ids: [track.id] }, true),
    onSuccess: () => toast("Listening for tempo and key…", { description: "It updates here when it's done." }),
    onError: (e) => toast.error(e.message),
  })
  const a = track.analysis
  const keyShown = (k: string | null) => (k ? (notation === "camelot" ? `${toCamelot(k)} · ${k}` : `${k} · ${toCamelot(k)}`) : null)
  const heard = a?.error
    ? `Couldn't analyse: ${a.error}`
    : a
      ? `Heard ${[formatBpm(a.bpm) && `${formatBpm(a.bpm)} BPM`, a.key].filter(Boolean).join(" in ") || "no clear pulse or key"}${a.bpmConfidence < 0.35 && a.bpm ? " (unsure)" : ""}.`
      : "Not analysed yet."
  const differs = a && !a.error && ((a.bpm && Math.round(a.bpm) !== Math.round(track.bpm ?? 0)) || (a.key && a.key !== track.key))
  const badKey = draft?.key ? !parseKey(draft.key) : false

  return (
    <div className="bg-card/60 rounded-2xl border p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Tempo & key</div>
          {draft ? (
            <form
              className="mt-1.5 flex flex-wrap items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                if (!badKey) save.mutate(draft)
              }}
            >
              <Input aria-label="BPM" inputMode="decimal" className="h-8 w-20" value={draft.bpm} placeholder="BPM" onChange={(e) => setDraft({ ...draft, bpm: e.target.value.replace(/[^\d.]/g, "") })} />
              <Input aria-label="Key" className={cn("h-8 w-24", badKey && "border-rasta-red")} value={draft.key} placeholder="Am / 8A" onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
              <Button size="xs" type="submit" disabled={save.isPending || badKey}>
                Save
              </Button>
              <Button size="xs" variant="ghost" type="button" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </form>
          ) : (
            <button
              type="button"
              className="hover:bg-muted/60 -mx-1 mt-0.5 rounded-lg px-1 text-left"
              title="Click to edit"
              onClick={() => setDraft({ bpm: track.bpm ? String(track.bpm) : "", key: track.key ?? "" })}
            >
              <span className="font-heading text-2xl font-extrabold tabular-nums">{formatBpm(track.bpm) ?? "–"}</span>
              <span className="text-muted-foreground ml-1 text-xs">BPM</span>
              <span className="font-heading ml-3 text-lg font-bold">{keyShown(track.key) ?? "–"}</span>
            </button>
          )}
          <p className="text-muted-foreground mt-1 text-xs">
            {heard}
            {differs && !draft && (
              <button type="button" className="text-foreground ml-1 underline underline-offset-2" onClick={() => save.mutate({ bpm: a!.bpm ? String(a!.bpm) : "", key: a!.key ?? "" })}>
                Use that
              </button>
            )}
          </p>
        </div>
        <Button size="xs" variant="outline" onClick={() => analyse.mutate()} disabled={analyse.isPending}>
          <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />
          {a ? "Re-analyse" : "Analyse"}
        </Button>
      </div>
    </div>
  )
}
