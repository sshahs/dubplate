import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, CancelCircleIcon, Clock01Icon, InformationCircleIcon, LinkSquare02Icon, SentIcon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import type { DecisionStep, ProvenanceField, Track } from "@shared/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { api, type MbSeed, type Selection } from "@/lib/api"
import { fmtDuration } from "@/lib/format"
import { cn } from "@/lib/utils"

const STATE: Record<DecisionStep["state"], { icon: typeof Tick02Icon; className: string }> = {
  ok: { icon: Tick02Icon, className: "text-rasta-green" },
  warn: { icon: Alert02Icon, className: "text-rasta-gold" },
  bad: { icon: CancelCircleIcon, className: "text-rasta-red" },
  info: { icon: InformationCircleIcon, className: "text-muted-foreground" },
  pending: { icon: Clock01Icon, className: "text-muted-foreground" },
}

const FIELD_LABEL: Record<ProvenanceField, string> = {
  artists: "Artist",
  title: "Title",
  version: "Version",
  year: "Year",
  album: "Album",
  label: "Label",
  genre: "Genre",
  release: "Release",
}

/** "How it was decided": each question answered on its own, then the risk, AcoustID and MusicBrainz. */
export function DecisionSteps({ track }: { track: Track }) {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ["insight", track.id, track.updatedAt], queryFn: () => api.insight(track.id) })
  const [mbOpen, setMbOpen] = useState(false)
  const send = useMutation({
    mutationFn: () => api.acoustidSubmit({ ids: [track.id] }),
    onSuccess: (j) => {
      toast(j.label)
      void qc.invalidateQueries({ queryKey: ["insight", track.id] })
    },
    onError: (e) => toast.error(e.message),
  })

  if (error) return <p className="text-rasta-red text-sm">{error.message}</p>
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />
  const provenance = Object.entries(track.decision?.provenance ?? {}) as [ProvenanceField, string][]
  const mbKnown = data.steps.find((s) => s.key === "musicbrainz")?.state === "ok"

  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {data.steps.map((s) => {
          const st = STATE[s.state]
          return (
            <li key={s.key} className="bg-card/60 rounded-2xl border p-3" data-step={s.key}>
              <div className="flex items-start gap-2.5">
                <HugeiconsIcon icon={st.icon} strokeWidth={2} className={cn("mt-0.5 size-4 shrink-0", st.className)} aria-label={s.state} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-muted-foreground text-xs">{s.label}</span>
                    <span className="text-sm font-medium break-words">{s.value}</span>
                  </div>
                  {s.detail && <p className="text-muted-foreground mt-0.5 text-xs text-pretty break-words">{s.detail}</p>}

                  {s.key === "acoustid" && !data.acoustid.submission && (
                    <Collapsible className="mt-1.5">
                      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2">What AcoustID needs</CollapsibleTrigger>
                      <CollapsibleContent>
                        <ul className="mt-1.5 space-y-1">
                          {data.acoustid.checks.map((c) => (
                            <li key={c.key} className="flex gap-1.5 text-xs">
                              <HugeiconsIcon icon={c.ok ? Tick02Icon : CancelCircleIcon} strokeWidth={2} className={cn("mt-px size-3.5 shrink-0", c.ok ? "text-rasta-green" : "text-muted-foreground")} />
                              <span className={c.ok ? "" : "text-muted-foreground"}>
                                {c.label}
                                {c.detail ? ` - ${c.detail}` : ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                  {s.key === "acoustid" && data.acoustid.eligible && !data.acoustid.submission && (
                    <Button size="xs" variant="outline" className="mt-2" onClick={() => send.mutate()} disabled={send.isPending}>
                      {send.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={SentIcon} strokeWidth={2} data-icon="inline-start" />}
                      Send the fingerprint now
                    </Button>
                  )}
                  {s.key === "musicbrainz" && !mbKnown && track.final && (
                    <Button size="xs" variant="outline" className="mt-2" onClick={() => setMbOpen(true)}>
                      <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} data-icon="inline-start" />
                      {data.musicbrainz && data.musicbrainz.status !== "received" ? "Carry on with MusicBrainz" : "Add to MusicBrainz"}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ol>

      {!!data.risk.reasons.length && (
        <p className="text-muted-foreground text-xs">
          Risk is separate from confidence: a track can be a sure match and still need a person to look, because changing it could go wrong.
        </p>
      )}

      {provenance.length > 0 && (
        <div className="rounded-2xl border p-3">
          <div className="mb-1.5 text-sm font-medium">Where each field came from</div>
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
            {provenance.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{FIELD_LABEL[k] ?? k}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <MusicBrainzDialog
        open={mbOpen}
        onOpenChange={setMbOpen}
        selection={{ ids: [track.id] }}
        count={1}
        resume={data.musicbrainz && data.musicbrainz.status !== "received" ? data.musicbrainz.id : undefined}
        onDone={() => void qc.invalidateQueries({ queryKey: ["insight", track.id] })}
      />
    </div>
  )
}

/**
 * Posts the fields to MusicBrainz's release editor in a new tab. It has to run
 * straight from a click, or the browser treats the new tab as a pop-up.
 */
function openReleaseEditor(seed: MbSeed) {
  const form = document.createElement("form")
  form.method = "POST"
  form.action = seed.action
  form.target = "_blank"
  form.acceptCharset = "UTF-8"
  for (const [name, value] of Object.entries(seed.fields)) {
    const input = document.createElement("input")
    input.type = "hidden"
    input.name = name
    input.value = value
    form.appendChild(input)
  }
  document.body.appendChild(form)
  form.submit()
  form.remove()
}

/** The tracks the release editor will be filled with, read back from its fields, disc by disc. */
function seedTracks(fields: Record<string, string>) {
  const out: { name: string; number: string; disc: number; length: number | null; recording: boolean }[] = []
  for (let m = 0; fields[`mediums.${m}.track.0.name`] !== undefined; m++)
    for (let i = 0; fields[`mediums.${m}.track.${i}.name`] !== undefined; i++) {
      const p = `mediums.${m}.track.${i}`
      const len = fields[`${p}.length`]
      out.push({ name: fields[`${p}.name`], number: fields[`${p}.number`] ?? String(i + 1), disc: m + 1, length: len ? Number(len) / 1000 : null, recording: !!fields[`${p}.recording`] })
    }
  return out
}

function seedArtist(fields: Record<string, string>) {
  let s = ""
  for (let i = 0; fields[`artist_credit.names.${i}.name`] !== undefined; i++) s += fields[`artist_credit.names.${i}.name`] + (fields[`artist_credit.names.${i}.join_phrase`] ?? "")
  return s
}

/**
 * Add a release to MusicBrainz: Dubplate fills in the release editor, the
 * person checks it there and submits it. MusicBrainz then sends them back to
 * /musicbrainz/done with the new release's ID (or they paste its link here).
 */
export function MusicBrainzDialog({
  open,
  onOpenChange,
  selection,
  count,
  resume,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selection: Selection
  count?: number
  /** a submission already started, to finish */
  resume?: number
  onDone?: () => void
}) {
  const qc = useQueryClient()
  const [seed, setSeed] = useState<MbSeed | null>(null)
  const [opened, setOpened] = useState(false)
  const [link, setLink] = useState("")
  const [discogs, setDiscogs] = useState("")
  const submissionId = seed?.submission.id ?? resume
  const close = () => {
    onOpenChange(false)
    setSeed(null)
    setOpened(false)
    setLink("")
    setDiscogs("")
  }
  const prepare = useMutation({
    mutationFn: (opts: { whole?: boolean; discogs?: string } = {}) => api.mbSeed(selection, opts),
    onSuccess: (s) => {
      setSeed(s)
      setOpened(false)
    },
    onError: (e) => toast.error(e.message),
  })
  const complete = useMutation({
    mutationFn: () => api.mbComplete(submissionId!, link),
    onSuccess: (r) => {
      toast.success("Saved the MusicBrainz release", {
        description: `${r.submission.trackIds.length} track${r.submission.trackIds.length === 1 ? "" : "s"}${r.recordings ? `, ${r.recordings} with their recording` : ""}. Cut tracks get the IDs with "Update tags"; the rest when they're cut.`,
      })
      void qc.invalidateQueries({ queryKey: ["track"] })
      onDone?.()
      close()
    },
    onError: (e) => toast.error(e.message),
  })
  const tracks = seed ? seedTracks(seed.fields) : []
  const yours = new Set(seed?.release?.yours ?? [])
  const discs = new Set(tracks.map((t) => t.disc)).size

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add to MusicBrainz</DialogTitle>
          <DialogDescription className="text-pretty">
            Dubplate fills in MusicBrainz's release editor from what it found. When it knows the record on Discogs, that's the whole release - every track, label, catalogue number and
            format - not just {count && count > 1 ? "these files" : "this file"}. You check everything there and submit it yourself (you need a MusicBrainz account). Afterwards the
            release's IDs go into the tags, so Jellyfin, Navidrome, Symphonium and your car know it.
          </DialogDescription>
        </DialogHeader>

        {!seed && (
          <Button variant={resume ? "outline" : "default"} onClick={() => prepare.mutate({})} disabled={prepare.isPending} className="self-start">
            {prepare.isPending && <Spinner data-icon="inline-start" />}
            {resume ? "Fill in the release editor again" : "Prepare the release"}
          </Button>
        )}

        <form
          className="space-y-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (discogs.trim()) prepare.mutate({ discogs: discogs.trim() })
          }}
        >
          <p className="text-muted-foreground text-xs text-pretty">
            {seed?.release ? "A different record? " : "Got the record on Discogs? "}Paste its link or <span className="font-mono">[r…]</span> code to fill in the whole release from it:
          </p>
          <div className="flex gap-2">
            <Input value={discogs} onChange={(e) => setDiscogs(e.target.value)} placeholder="https://www.discogs.com/release/… or [r1234567]" aria-label="Discogs release for MusicBrainz" />
            <Button type="submit" variant="secondary" disabled={!discogs.trim() || prepare.isPending}>
              Use it
            </Button>
          </div>
        </form>

        {seed && (
          <div className="space-y-2 rounded-2xl border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{seed.fields.name}</span>
              <Badge variant="outline">{seed.fields.type}</Badge>
              {seed.fields["mediums.0.format"] && <Badge variant="outline">{seed.fields["mediums.0.format"]}</Badge>}
              {seed.fields["events.0.date.year"] && <Badge variant="outline">{seed.fields["events.0.date.year"]}</Badge>}
            </div>
            <div className="text-muted-foreground text-xs">
              by {seedArtist(seed.fields)}
              {seed.fields["labels.0.name"] ? ` · ${seed.fields["labels.0.name"]}` : ""}
              {seed.fields["labels.0.catalog_number"] ? ` · ${seed.fields["labels.0.catalog_number"]}` : ""}
            </div>
            {seed.release && (
              <p className="text-xs text-pretty">
                The whole release from{" "}
                <a className="underline underline-offset-2" href={seed.release.url} target="_blank" rel="noreferrer noopener">
                  Discogs
                </a>
                : {seed.release.tracks} track{seed.release.tracks === 1 ? "" : "s"}
                {discs > 1 ? ` on ${discs} discs` : ""}, {seed.release.yours.length} of them yours.
              </p>
            )}
            {seed.wholeAvailable && !seed.release && (
              <Button size="xs" variant="outline" onClick={() => prepare.mutate({ whole: true })} disabled={prepare.isPending}>
                Use the whole of "{seed.wholeAvailable.title}" instead
              </Button>
            )}
            <ol className="max-h-64 space-y-0.5 overflow-auto text-xs">
              {tracks.map((t, i) => (
                <li key={i} className={cn("flex gap-2", seed.release && !yours.has(i) && "text-muted-foreground")}>
                  <span className="text-muted-foreground w-8 shrink-0 text-right font-mono">{discs > 1 ? `${t.disc}·${t.number}` : t.number}</span>
                  <span className="flex-1 break-words">{t.name}</span>
                  {seed.release && yours.has(i) && <span className="text-rasta-green">yours</span>}
                  {t.recording && <span className="text-muted-foreground">known recording</span>}
                  <span className="text-muted-foreground font-mono">{fmtDuration(t.length)}</span>
                </li>
              ))}
            </ol>
            <Collapsible>
              <CollapsibleTrigger className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2">The edit note</CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="bg-muted/50 mt-1.5 max-h-40 overflow-auto rounded-xl p-2 text-[11px] whitespace-pre-wrap">{seed.fields.edit_note}</pre>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}

        {(opened || resume) && (
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-xs text-pretty">
              When you submit it, MusicBrainz brings you back to Dubplate and the release is saved. If it doesn't, paste the new release's link here:
            </p>
            <div className="flex gap-2">
              <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://musicbrainz.org/release/…" aria-label="MusicBrainz release link" />
              <Button variant="secondary" onClick={() => complete.mutate()} disabled={!link.trim() || complete.isPending || !submissionId}>
                {complete.isPending && <Spinner data-icon="inline-start" />}
                Save
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {opened ? "Done" : "Cancel"}
          </Button>
          {seed && (
            <Button
              onClick={() => {
                openReleaseEditor(seed)
                setOpened(true)
                void api.mbSubmitted(seed.submission.id).catch(() => {})
              }}
            >
              <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} data-icon="inline-start" />
              {opened ? "Open it again" : "Open the release editor"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
