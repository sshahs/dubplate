import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, ArrowDown01Icon, Cancel01Icon, Image01Icon, InformationCircleIcon, RefreshIcon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { formatBpm, parseKey, toCamelot } from "@shared/keys"
import { lyricLines, lyricsKey } from "@shared/lyrics"
import { fileProblems } from "@shared/problems"
import type { ArtworkConfirm, FileProblem, Track } from "@shared/types"
import { ArtCompare, ArtCompareOriginal } from "@/components/art-compare"
import { Cover } from "@/components/cover"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { artSourceName } from "@/lib/art"
import { cn } from "@/lib/utils"

function useTrackUpdate(trackId: number) {
  const qc = useQueryClient()
  return (updated: Track) => {
    qc.setQueryData(["track", trackId], updated)
    void qc.invalidateQueries({ queryKey: ["tracks"] })
  }
}

/**
 * The file's picture, the one Dubplate found to replace it, side by side, and a
 * plain question: use it or keep the original? Found artwork waits for that
 * answer (Settings → Artwork) before it's written to the file.
 */
export function ArtworkPanel({ track, embed, replace, confirm }: { track: Track; embed: boolean; replace: boolean; confirm: ArtworkConfirm }) {
  const saved = useTrackUpdate(track.id)
  const qc = useQueryClient()
  const find = useMutation({
    mutationFn: () => api.findTrackArtwork(track.id),
    onSuccess: (t) => {
      saved(t)
      toast(t.artFound ? "Found artwork - compare it with the file's own" : "The file's own artwork is the best match")
    },
    onError: (e) => toast.error(e.message),
  })
  const choose = useMutation({
    mutationFn: (use: boolean) => api.chooseArtwork([track.id], use),
    onSuccess: (r, use) => {
      if (r.tracks) saved(r.tracks)
      toast(use ? (track.status === "done" ? "Using the new artwork - write it to the file when you're ready" : "Using the new artwork - it's written when you cut") : "Keeping the file's own picture")
    },
    onError: (e) => toast.error(e.message),
  })
  const write = useMutation({
    mutationFn: () => api.retag({ ids: [track.id] }),
    onSuccess: () => {
      toast("Writing the artwork into the file…")
      void qc.invalidateQueries({ queryKey: ["tracks"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const found = track.artFound
  const original = track.original?.tags?.cover
  const originalPic = original && original !== track.art?.hash ? { hash: original } : null
  const willWrite = !!found && embed && (!track.art || replace)
  const needsOk = confirm === "always" || (confirm === "replacing" && !!track.art)
  const waiting = willWrite && needsOk && !found.confirmed
  const size = (a: { width?: number; height?: number } | null) => (a?.width ? `${a.width}×${a.height}` : "")

  let line: string
  if (found) {
    line = !embed
      ? "Embedding artwork is off in Settings, so the file keeps its own."
      : !willWrite
        ? "The file already has a picture, and replacing it is off in Settings."
        : waiting
          ? `Use the new artwork from ${artSourceName(found)}? Nothing is written until you say so.`
          : track.status === "done"
            ? "You chose the new artwork. Write it into the file to finish."
            : "You chose the new artwork: it's written when you cut."
  } else line = track.art ? `The file has its own picture${size(track.art) ? ` (${size(track.art)})` : ""}.` : "No picture yet."

  return (
    <div className={cn("bg-card/60 rounded-2xl border p-3", waiting && "border-rasta-gold/50")}>
      <div className="mb-2 flex items-center gap-2">
        <div className="text-sm font-medium">Artwork</div>
        {waiting && <span className="bg-rasta-gold/15 text-rasta-gold rounded-full px-2 py-0.5 text-[11px] font-medium">Waiting for your OK</span>}
      </div>
      {found ? (
        <ArtCompare trackId={track.id} before={track.art} after={found} original={originalPic} size={112} />
      ) : (
        <div className="flex items-center gap-3">
          {originalPic && <ArtCompareOriginal trackId={track.id} hash={originalPic.hash} />}
          <Cover track={track} which="current" size={64} />
        </div>
      )}
      <p className="text-muted-foreground mt-2 text-xs">{line}</p>
      {found?.check && (
        <p className={cn("mt-0.5 text-xs", found.check.matches ? "text-muted-foreground" : "text-rasta-gold")}>
          {found.check.matches ? `${found.check.model} looked: it fits this release.` : `${found.check.model} isn't sure it's this release: ${found.check.reason}`}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {waiting && (
          <>
            <Button size="xs" onClick={() => choose.mutate(true)} disabled={choose.isPending}>
              Use new artwork
            </Button>
            <Button size="xs" variant="outline" onClick={() => choose.mutate(false)} disabled={choose.isPending}>
              {track.art ? "Keep the original" : "No artwork"}
            </Button>
          </>
        )}
        {found && !waiting && willWrite && track.status === "done" && (
          <Button size="xs" onClick={() => write.mutate()} disabled={write.isPending}>
            Write it into the file
          </Button>
        )}
        {found && !waiting && (
          <Button size="xs" variant="ghost" onClick={() => choose.mutate(false)} disabled={choose.isPending}>
            {track.art ? "Keep the original instead" : "Don't use it"}
          </Button>
        )}
        <Button size="xs" variant="outline" onClick={() => find.mutate()} disabled={find.isPending}>
          {find.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={Image01Icon} strokeWidth={2} data-icon="inline-start" />}
          {found ? "Look again" : "Find artwork"}
        </Button>
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

const dbfs = (linear: number) => (linear > 0 ? 20 * Math.log10(linear) : -Infinity)

/** Is the file really the quality it claims, and how loud is it. */
export function AudioQualityPanel({ track }: { track: Track }) {
  const analyse = useMutation({
    mutationFn: () => api.analyze({ ids: [track.id] }, true),
    onSuccess: () => toast("Listening to the whole file…", { description: "Quality and loudness show here when it's done." }),
    onError: (e) => toast.error(e.message),
  })
  const q = track.analysis?.quality
  const l = track.analysis?.loudness
  const measured = q !== undefined || l !== undefined
  const tone = q?.verdict === "suspect" ? "text-rasta-gold" : q?.verdict === "ok" ? "text-rasta-green" : "text-muted-foreground"
  const verdict = q ? { ok: "Sounds as good as it claims", suspect: "Sounds made from a lower-quality file", unknown: "Can't tell" }[q.verdict] : null
  return (
    <div className={cn("bg-card/60 rounded-2xl border p-3", q?.verdict === "suspect" && "border-rasta-gold/40")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Quality & loudness</div>
          {!measured ? (
            <p className="text-muted-foreground text-xs">Not measured yet.</p>
          ) : (
            <div className="mt-1 space-y-1.5 text-xs">
              {q && (
                <p>
                  <span className={cn("font-medium", tone)}>{verdict}.</span> <span className="text-muted-foreground">{q.detail}</span>
                </p>
              )}
              {l ? (
                <p className="text-muted-foreground tabular-nums">
                  <span className="text-foreground font-medium">{l.lufs.toFixed(1)} LUFS</span> · peak {dbfs(l.peak).toFixed(1)} dBFS · ReplayGain {l.gain > 0 ? "+" : ""}
                  {l.gain.toFixed(2)} dB
                </p>
              ) : (
                l === null && <p className="text-muted-foreground">Too quiet to measure loudness.</p>
              )}
              {track.analysis?.integrity && !fileProblems(track).some((p) => p.kind === "damaged" || p.kind === "truncated") && (
                <p className="text-muted-foreground">Decodes cleanly all the way through.</p>
              )}
            </div>
          )}
        </div>
        <Button size="xs" variant="outline" onClick={() => analyse.mutate()} disabled={analyse.isPending}>
          <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />
          {measured ? "Measure again" : "Measure"}
        </Button>
      </div>
    </div>
  )
}

const SEVERITY: Record<FileProblem["severity"], { tone: string; icon: typeof Alert02Icon }> = {
  error: { tone: "text-destructive", icon: Alert02Icon },
  warn: { tone: "text-rasta-gold", icon: Alert02Icon },
  info: { tone: "text-muted-foreground", icon: InformationCircleIcon },
}

/** What's wrong with the file itself: broken, cut short, the wrong extension, long silences. Hidden when nothing is. */
export function FileProblemsPanel({ track, fixExtensions }: { track: Track; fixExtensions: boolean }) {
  const problems = fileProblems(track)
  if (!problems.length) return null
  const worst = problems[0].severity
  return (
    <div className={cn("bg-card/60 rounded-2xl border p-3", worst === "error" ? "border-destructive/40" : worst === "warn" && "border-rasta-gold/40")}>
      <div className="text-sm font-medium">File check</div>
      <ul className="mt-1 space-y-1.5 text-xs">
        {problems.map((p) => (
          <li key={p.kind} className="flex gap-2">
            <HugeiconsIcon icon={SEVERITY[p.severity].icon} strokeWidth={2} className={cn("mt-px size-3.5 shrink-0", SEVERITY[p.severity].tone)} />
            <span>
              <span className={cn("font-medium", SEVERITY[p.severity].tone)}>{p.label}.</span>{" "}
              <span className="text-muted-foreground">{p.kind === "format" && !fixExtensions ? p.detail.replace(/ Cutting it gives it the right extension\.$/, " Fixing extensions is off in Settings.") : p.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The reading lyrics would be looked up for now (the approved one, else the best guess). */
function readingOf(t: Track) {
  if (t.final?.title && t.final.artists.length) return t.final
  if (t.decision?.title && t.decision.artists.length) return t.decision
  return null
}

function clock(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
}

/** Lyrics found for the track, what happens to them on cut, and a look at them. */
export function LyricsPanel({ track, settings }: { track: Track; settings: { fetch: boolean; embed: boolean; embedSynced: boolean; lrcFile: boolean; replaceExisting: boolean } }) {
  const [open, setOpen] = useState(false)
  const saved = useTrackUpdate(track.id)
  const act = useMutation({
    mutationFn: (action: "find" | "reject") => api.trackLyrics(track.id, action),
    onSuccess: (t, action) => {
      saved(t)
      if (action === "find") toast(t.lyrics?.found ? "Found lyrics" : (t.lyrics?.reason ?? "No lyrics found"))
    },
    onError: (e) => toast.error(e.message),
  })
  const reading = readingOf(track)
  const l = track.lyrics
  const current = !!l && !!reading && l.for === lyricsKey(reading)
  const usable = current && l.found && !l.rejected
  const own = track.tags.lyrics
  let line: string
  if (!reading) line = "Looked up once the track's identified."
  else if (!l || !current) line = l ? "Looked up for an earlier reading - look again for this one." : "Not looked up yet."
  else if (l.rejected) line = "You turned these down, so nothing is written."
  else if (!l.found) line = l.instrumental ? "An instrumental - no words to write." : `${l.reason ?? "None found"}.`
  else {
    const what = l.synced ? "Timed lyrics" : "Lyrics"
    const writes = [
      settings.embed && (!own || settings.replaceExisting) && (settings.embedSynced && l.synced ? "into the file (timed)" : "into the file"),
      settings.lrcFile && l.synced && "as a .lrc next to it",
    ].filter(Boolean)
    line = writes.length
      ? `${what} from LRCLIB - written ${writes.join(" and ")} when you cut.`
      : own && settings.embed
        ? `${what} from LRCLIB. The file has its own (${own}); replacing them is off in Settings.`
        : `${what} from LRCLIB. Writing them is off in Settings.`
  }
  const lines = usable ? lyricLines(l.synced ?? l.plain ?? "") : []
  return (
    <div className="bg-card/60 rounded-2xl border">
      {/* Title and buttons share a row; what happens to the words gets the full width under them. */}
      <div className="flex items-center gap-2 px-3 pt-3">
        <button
          type="button"
          aria-expanded={usable ? open : undefined}
          aria-label={usable ? (open ? "Hide the lyrics" : "Show the lyrics") : undefined}
          disabled={!usable}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
        >
          <span className="text-sm font-medium">Lyrics</span>
          {usable && <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-180")} />}
        </button>
        {reading && (
          <div className="flex shrink-0 gap-1.5">
            {usable && (
              <Button size="xs" variant="ghost" onClick={() => act.mutate("reject")} disabled={act.isPending} title="These are the wrong words: don't write them">
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} data-icon="inline-start" />
                Not these
              </Button>
            )}
            <Button size="xs" variant="outline" onClick={() => act.mutate("find")} disabled={act.isPending}>
              {act.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />}
              {l && current ? "Look again" : "Find"}
            </Button>
          </div>
        )}
      </div>
      <p className="text-muted-foreground px-3 pt-0.5 pb-3 text-xs text-pretty">{line}</p>
      {usable && open && (
        <div className="max-h-72 overflow-y-auto border-t px-3 py-2">
          {lines.map((x, i) =>
            x.text ? (
              <p key={i} className="flex gap-3 py-px text-xs">
                {x.at !== null && <span className="text-muted-foreground w-9 shrink-0 font-mono tabular-nums">{clock(x.at)}</span>}
                <span>{x.text}</span>
              </p>
            ) : (
              <div key={i} className="h-2" />
            )
          )}
        </div>
      )}
    </div>
  )
}

const RELATION: Record<string, string> = { same: "same key", up: "one step up", down: "one step down", relative: "relative major/minor", boost: "energy boost (+2)" }

/** Tracks that mix well after this one: compatible key on the Camelot wheel, tempo within reach. */
export function MixesPanel({ track, notation, onOpenTrack }: { track: Track; notation: "musical" | "camelot"; onOpenTrack?: (id: number) => void }) {
  const [open, setOpen] = useState(false)
  const has = !!(track.bpm || track.key)
  const { data, isLoading } = useQuery({ queryKey: ["mixes", track.id, track.bpm, track.key], queryFn: () => api.mixes(track.id), enabled: has && open })
  if (!has) return null
  const keyText = (k: string | null) => (k ? (notation === "camelot" ? toCamelot(k) : k) : null)
  return (
    <div className="bg-card/60 rounded-2xl border">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 p-3 text-left">
        <span>
          <span className="text-sm font-medium">Mixes well with</span>
          <span className="text-muted-foreground block text-xs">
            {track.key ? `Keys next to ${keyText(track.key)} on the Camelot wheel` : "Similar tempo"}
            {track.bpm ? `, within 6% of ${formatBpm(track.bpm)} BPM (or half/double)` : ""}
          </span>
        </span>
        <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t px-3 pt-2 pb-3">
          {isLoading ? (
            <Spinner className="size-4" />
          ) : !data?.length ? (
            <p className="text-muted-foreground text-xs">Nothing in your libraries mixes with it yet.</p>
          ) : (
            <ul className="-mx-1 space-y-0.5">
              {data.map((m) => {
                const row = (
                  <>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{m.track.proposedTitle ?? m.track.filename}</span>
                      {m.track.proposedArtist && <span className="text-muted-foreground"> · {m.track.proposedArtist}</span>}
                    </span>
                    <span className="text-muted-foreground shrink-0 font-mono tabular-nums" title={m.keyRelation ? RELATION[m.keyRelation] : undefined}>
                      {keyText(m.track.key)}
                      {m.track.bpm ? ` · ${formatBpm(m.track.bpm)}${m.halfDouble ? "×½/2" : ""}` : ""}
                      {m.bpmDiff ? ` (${m.bpmDiff > 0 ? "+" : ""}${m.bpmDiff}%)` : ""}
                    </span>
                  </>
                )
                return (
                  <li key={m.track.id}>
                    {onOpenTrack ? (
                      <button type="button" onClick={() => onOpenTrack(m.track.id)} className="hover:bg-muted/60 flex w-full items-center gap-3 rounded-lg px-1 py-1 text-left text-xs">
                        {row}
                      </button>
                    ) : (
                      <div className="flex items-center gap-3 px-1 py-1 text-xs">{row}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
