import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiMagicIcon,
  Alert02Icon,
  ArrowRight02Icon,
  Cancel01Icon,
  FlashIcon,
  LinkSquare02Icon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { renderTemplate } from "@core/naming"
import type { Candidate, FinalMeta, Track } from "@shared/types"
import { AudioPlayer } from "@/components/audio-player"
import { ConfidenceDial, StatusBadge } from "@/components/confidence"
import { fromDraft, MetaEditor, toDraft, type MetaDraft } from "@/components/meta-editor"
import { QueryError } from "@/components/query-error"
import { ArtworkPanel, TempoKeyPanel } from "@/components/track-extras"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/lib/api"
import { fmtBytes, fmtDuration } from "@/lib/format"
import { toastUndoable } from "@/lib/undo"
import { cn } from "@/lib/utils"

function initialMeta(t: Track): Partial<FinalMeta> | null {
  return t.final ?? (t.decision?.title ? t.decision : null) ?? t.ai ?? t.heuristic
}

function candidateToMeta(c: Candidate, base: MetaDraft): MetaDraft {
  return {
    ...base,
    artists: (c.artists?.length ? c.artists : [c.artist]).join(", "),
    title: c.title,
    album: c.album ?? base.album,
    year: c.year ? String(c.year) : base.year,
    label: c.label ?? base.label,
  }
}

export function TrackDetail({
  trackId,
  onAdvance,
  onUndone,
  compact = false,
}: {
  trackId: number
  onAdvance?: () => void
  /** after an approve / leave-as-is is undone, e.g. to bring this track back into view */
  onUndone?: () => void
  compact?: boolean
}) {
  const qc = useQueryClient()
  const { data: track, isLoading, error, refetch } = useQuery({ queryKey: ["track", trackId], queryFn: () => api.track(trackId) })
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  // The form follows the saved track until you edit it; edits are tied to the track they were made on.
  // Derived during render (not in an effect) so a cached track appears without a skeleton frame.
  const [edit, setEdit] = useState<{ trackId: number; draft: MetaDraft } | null>(null)
  const saved = useMemo(() => (track ? toDraft(initialMeta(track)) : null), [track])
  const dirty = edit?.trackId === trackId
  const draft = dirty ? edit.draft : saved

  const preview = useMemo(() => {
    if (!draft || !settings || !track) return null
    const meta = fromDraft(draft)
    if (!meta.title || !meta.artists.length) return null
    return `${renderTemplate(settings.naming.template, meta, settings.naming)}.${track.ext.toLowerCase()}`
  }, [draft, settings, track])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["track", trackId] })
    void qc.invalidateQueries({ queryKey: ["tracks"] })
    void qc.invalidateQueries({ queryKey: ["stats"] })
  }

  const approve = useMutation({
    mutationFn: () => api.approve(trackId, draft ? fromDraft(draft) : undefined, true),
    onSuccess: ({ undoId, ...updated }) => {
      toastUndoable(qc, "Approved — big up!", undoId, { description: preview ?? undefined, onUndone })
      qc.setQueryData(["track", trackId], updated)
      setEdit(null)
      refresh()
      onAdvance?.()
    },
    onError: (e) => toast.error(e.message),
  })
  const save = useMutation({
    mutationFn: () => api.updateTrack(trackId, { final: draft ? fromDraft(draft) : undefined }),
    onSuccess: (updated) => {
      toast("Saved")
      // Show the saved values straight away rather than flashing back until the refetch lands.
      qc.setQueryData(["track", trackId], updated)
      setEdit(null)
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const reject = useMutation({
    mutationFn: () => api.bulk({ ids: [trackId] }, "reject"),
    onSuccess: (r) => {
      toastUndoable(qc, "Left as-is", r.undoId, { description: track?.filename, onUndone })
      refresh()
      onAdvance?.()
    },
    onError: (e) => toast.error(e.message),
  })
  const rerun = useMutation({
    mutationFn: () => api.process({ ids: [trackId] }, { force: true }),
    onSuccess: (j) => toast(j.label, { description: "Re-reading and re-scouring this track" }),
    onError: (e) => toast.error(e.message),
  })

  if (error && !track) return <QueryError compact error={error} onRetry={() => void refetch()} />
  if (isLoading || !track || !draft) {
    // Mirrors the real layout so the panel doesn't collapse and re-expand while loading.
    return (
      <div className="space-y-5" aria-busy>
        <div className="flex items-start gap-4">
          <Skeleton className={cn("shrink-0 rounded-full", compact ? "size-20" : "size-24")} />
          <div className="flex-1 space-y-2 pt-1">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-7 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  const d = track.decision
  const editDraft = (next: MetaDraft) => setEdit({ trackId, draft: next })

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-4">
        <ConfidenceDial value={track.confidence} size={compact ? 80 : 96} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={track.status} />
            {d?.basis && <Badge variant="outline">from {d.basis === "sources" ? "sources" : d.basis === "ai" ? "AI reading" : d.basis}</Badge>}
            {track.ai && <Badge variant="outline">{track.ai.model}</Badge>}
          </div>
          <div className="text-muted-foreground font-mono text-xs break-all">{track.relDir ? `${track.relDir}/` : ""}</div>
          <div className="font-mono text-sm font-medium break-all">{track.filename}</div>
          <div className="flex items-center gap-2 text-sm">
            <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} className="text-rasta-gold size-4 shrink-0" />
            <span className={cn("font-medium break-words", preview ? "text-foreground" : "text-muted-foreground italic")}>{preview ?? "needs an artist and title"}</span>
          </div>
        </div>
      </div>

      <AudioPlayer src={api.audioUrl(track.id)} />

      <div className={cn("grid gap-3", !compact && "sm:grid-cols-2")}>
        <ArtworkPanel track={track} embed={settings?.artwork.embed ?? true} replace={settings?.artwork.replaceExisting ?? false} />
        <TempoKeyPanel track={track} notation={settings?.analysis.keyNotation ?? "musical"} />
      </div>

      {!!d?.warnings.length && (
        <div className="border-rasta-gold/30 bg-rasta-gold/8 space-y-1 rounded-2xl border p-3 text-sm">
          {d.warnings.map((w, i) => (
            <div key={i} className="flex gap-2">
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="text-rasta-gold mt-0.5 size-4 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}
      {track.note && <div className="text-rasta-red text-sm">{track.note}</div>}

      <MetaEditor value={draft} onChange={editDraft} />

      <div className="flex flex-wrap gap-2">
        <Button data-review-action="approve" onClick={() => approve.mutate()} disabled={approve.isPending || !preview}>
          <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} data-icon="inline-start" />
          Approve{compact ? "" : " & learn"}
        </Button>
        {dirty && (
          <Button variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>
            Save draft
          </Button>
        )}
        <Button data-review-action="reject" variant="outline" onClick={() => reject.mutate()} disabled={reject.isPending}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} data-icon="inline-start" />
          Leave as-is
        </Button>
        <Button variant="ghost" onClick={() => rerun.mutate()} disabled={rerun.isPending}>
          <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />
          Re-run
        </Button>
      </div>

      <Tabs defaultValue="evidence">
        <TabsList>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="sources">Sources {d?.clusters.length ? `(${d.clusters.length})` : ""}</TabsTrigger>
          <TabsTrigger value="readings">Readings</TabsTrigger>
          <TabsTrigger value="file">File</TabsTrigger>
        </TabsList>

        <TabsContent value="evidence" className="space-y-2 pt-3">
          {!d && <p className="text-muted-foreground text-sm">Not scored yet — run the pipeline on this track.</p>}
          {d?.factors.map((f) => (
            <div key={f.key} className="bg-card/60 rounded-2xl border p-3">
              <div className="flex items-center gap-3">
                <span className="flex-1 text-sm font-medium">{f.label}</span>
                <span className={cn("font-mono text-xs", f.weight < 0 ? "text-rasta-red" : "text-muted-foreground")}>
                  {f.weight < 0 ? `−${Math.round(-f.weight * 100)}` : f.weight > 0 && f.weight < 0.2 ? `+${Math.round(f.weight * 100)}` : `${Math.round(f.score * 100)}%`}
                </span>
              </div>
              {f.weight >= 0.2 && (
                <div className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full">
                  <div
                    className={cn("h-full rounded-full", f.score >= 0.8 ? "bg-rasta-green" : f.score >= 0.5 ? "bg-rasta-gold" : "bg-rasta-red")}
                    style={{ width: `${f.score * 100}%` }}
                  />
                </div>
              )}
              <div className="text-muted-foreground mt-1.5 text-xs">{f.detail}</div>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="sources" className="space-y-3 pt-3">
          {!d?.clusters.length && (
            <p className="text-muted-foreground text-sm">
              {track.candidates?.length ? `${track.candidates.length} raw hits, none close enough to this reading.` : "No source hits."}
            </p>
          )}
          {d?.clusters.map((cl, i) => (
            <div key={i} className={cn("rounded-2xl border p-3", i === 0 && "border-rasta-green/40 bg-rasta-green/5")}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {cl.artist} — {cl.title}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {[...new Set(cl.candidates.map((c) => c.sourceLabel))].map((s) => (
                      <Badge key={s} variant="secondary">
                        {s}
                      </Badge>
                    ))}
                    <span className="text-muted-foreground ml-1 text-xs">
                      support {cl.support.toFixed(2)} · match {Math.round(cl.relevance * 100)}%
                    </span>
                  </div>
                </div>
                <Button size="xs" variant="outline" onClick={() => editDraft(candidateToMeta(cl.candidates[0], draft))}>
                  Use this
                </Button>
              </div>
              <div className="mt-2 space-y-1">
                {cl.candidates.slice(0, 6).map((c, j) => (
                  <div key={j} className="text-muted-foreground flex items-center gap-2 text-xs">
                    <span className="w-24 shrink-0 truncate">{c.sourceLabel}</span>
                    <span className="flex-1 truncate">
                      {c.artist} — {c.title}
                      {c.album ? ` · ${c.album}` : ""}
                      {c.year ? ` · ${c.year}` : ""}
                      {c.duration ? ` · ${fmtDuration(c.duration)}` : ""}
                    </span>
                    {c.url && (
                      <a href={c.url} target="_blank" rel="noreferrer noopener" className="hover:text-foreground" aria-label="Open source">
                        <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} className="size-3.5" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="readings" className="space-y-3 pt-3">
          {track.ai && (
            <div className="rounded-2xl border p-3">
              <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                <HugeiconsIcon icon={AiMagicIcon} strokeWidth={2} className="text-rasta-gold size-4" />
                AI · {track.ai.provider} · {Math.round(track.ai.confidence * 100)}%
              </div>
              <div className="text-sm">
                {track.ai.artists.join(track.ai.relation === "vs" ? " vs " : " & ")} — {track.ai.title}
                {track.ai.version ? ` (${track.ai.version})` : ""}
                {track.ai.year ? ` · ${track.ai.year}` : ""}
                {track.ai.riddim ? ` · ${track.ai.riddim} riddim` : ""}
                {track.ai.event ? ` · ${track.ai.event}` : ""}
              </div>
              <p className="text-muted-foreground mt-1 text-xs">{track.ai.reasoning}</p>
              {track.ai.alternatives.map((alt, i) => (
                <button
                  key={i}
                  type="button"
                  className="text-muted-foreground hover:text-foreground mt-1 block text-left text-xs underline-offset-2 hover:underline"
                  onClick={() => editDraft({ ...draft, artists: alt.artists.join(", "), title: alt.title })}
                >
                  or: {alt.artists.join(" & ")} — {alt.title}
                </button>
              ))}
            </div>
          )}
          {track.heuristic && (
            <div className="rounded-2xl border p-3">
              <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                <HugeiconsIcon icon={FlashIcon} strokeWidth={2} className="text-rasta-green size-4" />
                Rule-based parser · {Math.round(track.heuristic.confidence * 100)}%
              </div>
              <div className="text-sm">
                {track.heuristic.artists.join(track.heuristic.relation === "vs" ? " vs " : " & ") || "?"} — {track.heuristic.title || "?"}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {track.heuristic.hints.map((h) => (
                  <Badge key={h} variant="outline">
                    {h}
                  </Badge>
                ))}
              </div>
              {track.heuristic.notes.length > 0 && <p className="text-muted-foreground mt-1 text-xs">{track.heuristic.notes.join(" · ")}</p>}
            </div>
          )}
          <div className="rounded-2xl border p-3">
            <div className="mb-1 text-sm font-medium">Embedded tags</div>
            {Object.keys(track.tags).length === 0 ? (
              <p className="text-muted-foreground text-xs">No tags in the file.</p>
            ) : (
              <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-xs">
                {Object.entries(track.tags).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k === "cover" ? "picture" : k}</dt>
                    <dd className="break-all">{k === "cover" ? "front cover" : Array.isArray(v) ? v.join(", ") : String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </TabsContent>

        <TabsContent value="file" className="pt-3">
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Path</dt>
            <dd className="font-mono break-all">{track.path}</dd>
            {track.originalPath !== track.path && (
              <>
                <dt className="text-muted-foreground">Originally</dt>
                <dd className="font-mono break-all">{track.originalPath}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Format</dt>
            <dd>
              {track.codec ?? track.ext} · {track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : "?"} · {track.sampleRate ? `${track.sampleRate / 1000} kHz` : "?"}
            </dd>
            <dt className="text-muted-foreground">Duration</dt>
            <dd>{fmtDuration(track.duration)}</dd>
            <dt className="text-muted-foreground">Size</dt>
            <dd>{fmtBytes(track.size)}</dd>
            <dt className="text-muted-foreground">Fingerprint</dt>
            <dd className="font-mono">{track.hash?.slice(0, 16) ?? "–"}</dd>
          </dl>
        </TabsContent>
      </Tabs>
    </div>
  )
}
