import { HugeiconsIcon } from "@hugeicons/react"
import { Album02Icon, ArrowLeft01Icon, ArrowRight01Icon, LinkSquare02Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import type { AlbumProposal } from "@shared/types"
import { StatusBadge } from "@/components/confidence"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { api, type AlbumTarget } from "@/lib/api"
import { fmtDuration } from "@/lib/format"
import { toastUndoable } from "@/lib/undo"
import { cn } from "@/lib/utils"

type Fields = AlbumProposal["fields"]

const MATCH_LABEL = { recording: "same recording", title: "by title", place: "by its number" } as const

/** A MusicBrainz or Discogs release link (or [r123] code), as "musicbrainz:<id>" / "discogs:<id>". */
function releaseRef(input: string): string | null {
  const s = input.trim()
  const mb = s.match(/musicbrainz\.org\/release\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ?? s.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
  if (mb) return `musicbrainz:${mb[1].toLowerCase()}`
  const dg = s.match(/discogs\.com\/(?:[^\s?#]*\/)?release\/(\d+)/i) ?? s.match(/^\[?r(\d+)\]?$/i)
  return dg ? `discogs:${dg[1]}` : null
}

/**
 * An album's tracks as one: the album most of them are on, read in full from
 * MusicBrainz or Discogs, each file placed on its tracklist, the album's details
 * and one cover for all - and every track approved with one OK.
 */
export function AlbumDialog({ open, onOpenChange, target }: { open: boolean; onOpenChange: (open: boolean) => void; target: AlbumTarget }) {
  const qc = useQueryClient()
  // What the person asked for: another of the albums, or a release of their own.
  const [ask, setAsk] = useState<{ option?: string; release?: string | null }>({})
  const [edits, setEdits] = useState<Partial<Fields>>({})
  const [picks, setPicks] = useState<Record<number, number | null>>({})
  const [artIndex, setArtIndex] = useState(0)
  const [noArt, setNoArt] = useState(false)
  const [replaceArt, setReplaceArt] = useState(false)
  const [link, setLink] = useState("")
  const key = JSON.stringify(target)
  const { data: p, isFetching, error } = useQuery({
    queryKey: ["album-proposal", key, ask],
    queryFn: () => api.albumPropose(target, ask),
    enabled: open,
    staleTime: 60_000,
  })
  const reset = () => {
    setEdits({})
    setPicks({})
    setArtIndex(0)
    setNoArt(false)
  }
  const close = () => {
    onOpenChange(false)
    setAsk({})
    setLink("")
    setReplaceArt(false)
    reset()
  }
  const choose = (next: { option?: string; release?: string | null }) => {
    reset()
    setAsk(next)
  }
  const fields: Fields = { ...(p?.fields ?? { title: "" }), ...edits }
  const matchOf = (id: number) => (id in picks ? picks[id] : (p?.matches.find((m) => m.trackId === id)?.index ?? null))
  const artwork = noArt ? null : (p?.artwork[artIndex] ?? null)
  const apply = useMutation({
    mutationFn: (approve: boolean) =>
      api.albumApply({
        trackIds: p!.tracks.map((t) => t.id),
        release: p!.release ? `${p!.release.source}:${p!.release.id}` : null,
        fields: { ...fields, year: fields.year ? Number(fields.year) : undefined },
        matches: p!.tracks.map((t) => ({ trackId: t.id, index: matchOf(t.id) })),
        artworkUrl: artwork,
        replaceArt: !!artwork && replaceArt,
        approve,
      }),
    onSuccess: (r, approve) => {
      toastUndoable(qc, approve ? `Approved "${fields.title}": ${r.approved} track${r.approved === 1 ? "" : "s"}` : `Kept "${fields.title}" together`, r.undoId, {
        description: [
          r.skipped && `${r.skipped} without an artist or title left for you`,
          r.recut && `${r.recut} cut track${r.recut === 1 ? "" : "s"} back in Cut & Tag to be tagged again`,
          approve && !r.skipped && "Ready to cut",
        ]
          .filter(Boolean)
          .join(" · "),
      })
      void qc.invalidateQueries()
      close()
    },
    onError: (e) => toast.error(e.message),
  })
  const placed = p ? p.tracks.filter((t) => matchOf(t.id) !== null).length : 0
  const toApprove = p ? p.tracks.filter((t) => t.status !== "approved" && t.status !== "done").length : 0
  const setField = (k: keyof Fields, v: string) => setEdits((e) => ({ ...e, [k]: k === "year" ? (v ? Number(v) || undefined : undefined) : v }))

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[92dvh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Tag as one album</DialogTitle>
          <DialogDescription className="text-pretty">
            Every track gets the same album, album artist, year, label, genre and cover, with its number on the record - then one OK approves them all.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-rasta-red text-sm">{error.message}</p>}
        {!p && !error && <Skeleton className="h-72 w-full" />}

        {p && (
          <div className={cn("min-w-0 space-y-4", isFetching && "opacity-60")}>
            {p.options.length > 1 && (
              <div className="space-y-1.5">
                <div className="text-muted-foreground text-xs">Albums these tracks are on</div>
                <div className="flex flex-wrap gap-1.5">
                  {p.options.map((o) => (
                    <Button
                      key={o.key}
                      size="xs"
                      className="max-w-full"
                      variant={o.key === p.chosen ? "default" : "outline"}
                      onClick={() => choose({ option: o.key })}
                      aria-pressed={o.key === p.chosen}
                    >
                      <span className="truncate">{o.title}</span>
                      <span className="opacity-70">
                        {o.covers}/{p.tracks.length}
                      </span>
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid min-w-0 gap-4 sm:grid-cols-[11rem_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <div className="bg-muted relative aspect-square w-full max-w-44 overflow-hidden rounded-xl border">
                  {artwork ? (
                    <img src={api.albumCoverUrl(artwork)} alt={`Cover of ${fields.title}`} className="size-full object-cover" onError={() => p.artwork.length > artIndex + 1 && setArtIndex(artIndex + 1)} />
                  ) : (
                    <div className="text-muted-foreground flex size-full flex-col items-center justify-center gap-1 p-3 text-center text-xs">
                      <HugeiconsIcon icon={Album02Icon} strokeWidth={1.5} className="size-8" />
                      {noArt ? "Each file keeps its own picture" : "No cover found"}
                    </div>
                  )}
                </div>
                {p.artwork.length > 0 && (
                  <div className="flex items-center gap-1">
                    {p.artwork.length > 1 && !noArt && (
                      <>
                        <Button size="icon-xs" variant="ghost" aria-label="Previous cover" disabled={artIndex === 0} onClick={() => setArtIndex(artIndex - 1)}>
                          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
                        </Button>
                        <span className="text-muted-foreground text-xs">
                          {artIndex + 1}/{p.artwork.length}
                        </span>
                        <Button size="icon-xs" variant="ghost" aria-label="Next cover" disabled={artIndex >= p.artwork.length - 1} onClick={() => setArtIndex(artIndex + 1)}>
                          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
                        </Button>
                      </>
                    )}
                    <Button size="xs" variant="ghost" onClick={() => setNoArt(!noArt)}>
                      {noArt ? "Use a cover" : "No cover"}
                    </Button>
                  </div>
                )}
                {artwork && (
                  <label className="flex items-start gap-2 text-xs">
                    <Checkbox checked={replaceArt} onCheckedChange={(v) => setReplaceArt(!!v)} className="mt-px" />
                    <span>Replace the pictures the files already have</span>
                  </label>
                )}
              </div>

              <div className="min-w-0 space-y-2">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="space-y-1 sm:col-span-2">
                    <span className="text-muted-foreground text-xs">Album</span>
                    <Input value={fields.title} onChange={(e) => setField("title", e.target.value)} aria-label="Album" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-muted-foreground text-xs">Album artist</span>
                    <Input value={fields.albumArtist ?? ""} onChange={(e) => setField("albumArtist", e.target.value)} aria-label="Album artist" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-muted-foreground text-xs">Year</span>
                    <Input value={fields.year ?? ""} inputMode="numeric" onChange={(e) => setField("year", e.target.value)} aria-label="Year" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-muted-foreground text-xs">Label</span>
                    <Input value={fields.label ?? ""} onChange={(e) => setField("label", e.target.value)} aria-label="Label" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-muted-foreground text-xs">Genre</span>
                    <Input value={fields.genre ?? ""} onChange={(e) => setField("genre", e.target.value)} aria-label="Genre" />
                  </label>
                </div>
                <div className="bg-muted/40 rounded-xl border p-2 text-xs">
                  {p.release ? (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span>
                        From{" "}
                        <a className="underline underline-offset-2" href={p.release.url} target="_blank" rel="noreferrer noopener">
                          {p.release.source === "musicbrainz" ? "MusicBrainz" : "Discogs"}
                        </a>
                        : {p.release.tracks.length} tracks{p.release.discs > 1 ? ` on ${p.release.discs} discs` : ""}
                        {p.release.catno ? ` · ${p.release.catno}` : ""}
                        {p.release.country ? ` · ${p.release.country}` : ""}
                      </span>
                      <Badge variant="outline">
                        {placed} of {p.tracks.length} placed
                      </Badge>
                      <Button size="xs" variant="ghost" onClick={() => choose({ option: p.chosen ?? undefined, release: null })}>
                        Not this release
                      </Button>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">No release found for it on MusicBrainz or Discogs: the album's details come from the tracks and their tags.</span>
                  )}
                  <form
                    className="mt-1.5 flex gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault()
                      const ref = releaseRef(link)
                      if (!ref) return void toast.error("Paste a MusicBrainz or Discogs release link")
                      choose({ option: p.chosen ?? undefined, release: ref })
                    }}
                  >
                    <Input className="h-7 text-xs" value={link} onChange={(e) => setLink(e.target.value)} placeholder="A different release: its MusicBrainz or Discogs link" aria-label="Release link" />
                    <Button type="submit" size="xs" variant="secondary" disabled={!link.trim()}>
                      <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} data-icon="inline-start" />
                      Use
                    </Button>
                  </form>
                </div>
              </div>
            </div>

            <div className="max-w-full overflow-x-auto rounded-xl border">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground bg-muted/40 text-left">
                  <tr>
                    <th className="px-2 py-1.5 font-normal">File</th>
                    <th className="px-2 py-1.5 font-normal">{p.release ? "On the release" : "Track"}</th>
                    <th className="px-2 py-1.5 font-normal">Now</th>
                  </tr>
                </thead>
                <tbody>
                  {p.tracks.map((t) => {
                    const index = matchOf(t.id)
                    const by = t.id in picks ? null : p.matches.find((m) => m.trackId === t.id)?.by
                    return (
                      <tr key={t.id} className="border-t align-top">
                        <td className="max-w-56 px-2 py-1.5">
                          <div className="truncate" title={t.filename}>
                            {t.place ? <span className="text-muted-foreground mr-1 font-mono">{t.place}</span> : null}
                            {t.filename}
                          </div>
                          <div className="text-muted-foreground font-mono">{fmtDuration(t.duration)}</div>
                        </td>
                        <td className="px-2 py-1.5">
                          {p.release ? (
                            <>
                              <select
                                className="border-input bg-background h-7 w-full min-w-40 rounded-lg border px-1.5"
                                aria-label={`Track on the release for ${t.filename}`}
                                value={index ?? ""}
                                onChange={(e) => setPicks((x) => ({ ...x, [t.id]: e.target.value === "" ? null : Number(e.target.value) }))}
                              >
                                <option value="">Not on this release</option>
                                {p.release.tracks.map((rt, i) => (
                                  <option key={i} value={i}>
                                    {[p.release!.discs > 1 ? `${rt.disc}-${rt.number}` : rt.number, rt.title, rt.length ? fmtDuration(rt.length) : ""].filter(Boolean).join("  ")}
                                  </option>
                                ))}
                              </select>
                              {by && <div className="text-muted-foreground mt-0.5">{MATCH_LABEL[by]}</div>}
                            </>
                          ) : (
                            <span>{t.title || "–"}</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="break-words">{t.artists.length ? `${t.artists.join(", ")} - ${t.title}` : t.title || "–"}</div>
                          <StatusBadge status={t.status} className="mt-0.5" />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {p?.lock && (
            <Button
              variant="ghost"
              className="sm:mr-auto"
              onClick={() =>
                void api.albumRelease(p.tracks.map((t) => t.id)).then((r) => {
                  toastUndoable(qc, `Stopped keeping ${r.released} tracks together`, r.undoId)
                  void qc.invalidateQueries()
                  close()
                })
              }
            >
              Stop keeping together
            </Button>
          )}
          <Button variant="outline" onClick={() => apply.mutate(false)} disabled={!p || !fields.title.trim() || apply.isPending}>
            Keep together
          </Button>
          <Button onClick={() => apply.mutate(true)} disabled={!p || !fields.title.trim() || apply.isPending}>
            {apply.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} data-icon="inline-start" />}
            Approve album{p ? ` (${p.tracks.length} track${p.tracks.length === 1 ? "" : "s"}${toApprove && toApprove < p.tracks.length ? `, ${toApprove} new` : ""})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
