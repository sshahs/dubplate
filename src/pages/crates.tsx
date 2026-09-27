import { HugeiconsIcon } from "@hugeicons/react"
import { Add01Icon, ArrowRight02Icon, Delete02Icon, Download04Icon, PencilEdit02Icon, Vynil02Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState, type ReactNode } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { formatBpm, fromCamelot } from "@shared/keys"
import type { Crate, CrateFacets, CrateRules, TrackStatus } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { DjExportDialog } from "@/components/dj-export-dialog"
import { QueryError } from "@/components/query-error"
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
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { useDebounced } from "@/hooks/use-debounced"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

/** The wheel in Camelot order: 1A…12A (minor), then 1B…12B (major). */
const WHEEL = (["A", "B"] as const).flatMap((letter) => Array.from({ length: 12 }, (_, i) => ({ code: `${i + 1}${letter}`, key: fromCamelot(i + 1, letter) })))

const STATUS_CHOICES: { value: string; label: string; statuses?: TrackStatus[] }[] = [
  { value: "any", label: "Any track" },
  { value: "done", label: "Cut (renamed and tagged)", statuses: ["done"] },
  { value: "ready", label: "Approved or cut", statuses: ["approved", "done"] },
]

const QUALITY_CHOICES = [
  { value: "any", label: "Any" },
  { value: "ok", label: "Leave out re-encoded files" },
  { value: "suspect", label: "Only re-encoded files" },
]

/** A short line per rule, for crate cards. */
function describeRules(r: CrateRules, libraryName?: (id: number) => string | undefined): string[] {
  const out: string[] = []
  if (r.genres?.length) out.push(r.genres.join(" / "))
  if (r.bpmMin !== undefined || r.bpmMax !== undefined) {
    const range = r.bpmMin !== undefined && r.bpmMax !== undefined ? `${formatBpm(r.bpmMin)}-${formatBpm(r.bpmMax)}` : r.bpmMin !== undefined ? `${formatBpm(r.bpmMin)}+` : `up to ${formatBpm(r.bpmMax)}`
    out.push(`${range} BPM${r.halfDouble ? " (and half/double)" : ""}`)
  }
  if (r.mixesWith) out.push(`mixes with ${r.mixesWith}`)
  if (r.keys?.length) out.push(r.keys.length > 4 ? `${r.keys.length} keys` : r.keys.join(", "))
  if (r.yearFrom !== undefined || r.yearTo !== undefined) out.push(r.yearFrom === r.yearTo ? String(r.yearFrom) : `${r.yearFrom ?? "…"}-${r.yearTo ?? "now"}`)
  if (r.labels?.length) out.push(r.labels.join(", "))
  if (r.artists?.length) out.push(r.artists.join(", "))
  if (r.libraryId) out.push(libraryName?.(r.libraryId) ?? "one library")
  if (r.statuses?.length) out.push(r.statuses.length === 1 && r.statuses[0] === "done" ? "cut" : "approved or cut")
  if (r.text) out.push(`“${r.text}”`)
  if (r.quality === "suspect") out.push("re-encoded only")
  if (r.quality === "ok") out.push("no re-encodes")
  return out
}

function Chips({ options, value, onChange, max = 24 }: { options: { value: string; count?: number }[]; value: string[]; onChange: (v: string[]) => void; max?: number }) {
  const has = (v: string) => value.some((x) => x.toLowerCase() === v.toLowerCase())
  const extra = value.filter((v) => !options.some((o) => o.value.toLowerCase() === v.toLowerCase()))
  return (
    <div className="flex flex-wrap gap-1.5">
      {[...extra.map((value): { value: string; count?: number } => ({ value })), ...options.slice(0, max)].map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={has(o.value)}
          onClick={() => onChange(has(o.value) ? value.filter((x) => x.toLowerCase() !== o.value.toLowerCase()) : [...value, o.value])}
          className={cn("h-7 rounded-full px-3 text-xs font-medium transition-colors", has(o.value) ? "bg-foreground text-background" : "bg-muted hover:bg-muted/70")}
        >
          {o.value}
          {o.count !== undefined && <span className="ml-1 tabular-nums opacity-60">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

function AddValue({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => void }) {
  const [v, setV] = useState("")
  return (
    <Input
      className="mt-2 h-8 w-full text-xs sm:w-56"
      placeholder={placeholder}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && v.trim()) {
          e.preventDefault()
          onAdd(v.trim())
          setV("")
        }
      }}
    />
  )
}

function Rule({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t pt-4 first:border-t-0 first:pt-0">
      <div>
        <div className="text-sm font-medium">{title}</div>
        {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
      </div>
      {children}
    </section>
  )
}

const num = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? undefined : Number(v))

/** Make or change a crate: its rules, with the tracks it'd hold updating as you go. */
function CrateEditor({ crate, facets, open, onOpenChange }: { crate: Crate | null; facets: CrateFacets | undefined; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const { data: libraries } = useQuery({ queryKey: ["libraries"], queryFn: api.libraries })
  // Mounted afresh for each opening (see its key), so these start from the crate.
  const [name, setName] = useState(crate?.name ?? "")
  const [rules, setRules] = useState<CrateRules>(crate?.rules ?? {})
  const set = (patch: Partial<CrateRules>) => setRules((r) => ({ ...r, ...patch }))
  const debounced = useDebounced(rules, 250)
  const preview = useQuery({ queryKey: ["crate-preview", debounced], queryFn: () => api.cratePreview(debounced), enabled: open, placeholderData: (p) => p })
  const save = useMutation({
    mutationFn: () => (crate ? api.updateCrate(crate.id, { name, rules }) : api.createCrate(name, rules)),
    onSuccess: (c) => {
      toast.success(crate ? `Saved ${c.name}` : `Made ${c.name}`, { description: `${c.count} track${c.count === 1 ? "" : "s"} in it now.` })
      void qc.invalidateQueries({ queryKey: ["crates"] })
      void qc.invalidateQueries({ queryKey: ["crate", c.id] })
      onOpenChange(false)
    },
    onError: (e) => toast.error(e.message),
  })
  const statusValue = STATUS_CHOICES.find((c) => JSON.stringify(c.statuses) === JSON.stringify(rules.statuses))?.value ?? "any"
  const libItems = [{ value: "all", label: "Every library" }, ...(libraries ?? []).map((l) => ({ value: String(l.id), label: l.name }))]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{crate ? `Edit ${crate.name}` : "New crate"}</DialogTitle>
          <DialogDescription>Every rule you set must match; within a rule, any of its values will do. It fills itself as tracks come in.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Grime at 140" autoFocus />
            </label>
            <Rule title="Genre" hint="From the file's tags or the approved genre.">
              <Chips options={facets?.genres ?? []} value={rules.genres ?? []} onChange={(genres) => set({ genres })} />
              <AddValue placeholder="Another genre, then Enter" onAdd={(g) => set({ genres: [...(rules.genres ?? []), g] })} />
            </Rule>
            <Rule title="Tempo" hint={facets?.bpm.min ? `Your tracks run ${formatBpm(facets.bpm.min)}-${formatBpm(facets.bpm.max)} BPM.` : undefined}>
              <div className="flex flex-wrap items-center gap-2">
                <Input aria-label="Lowest BPM" type="number" className="w-24" placeholder="from" value={rules.bpmMin ?? ""} onChange={(e) => set({ bpmMin: num(e.target.value) })} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input aria-label="Highest BPM" type="number" className="w-24" placeholder="to" value={rules.bpmMax ?? ""} onChange={(e) => set({ bpmMax: num(e.target.value) })} />
                <span className="text-muted-foreground text-sm">BPM</span>
                <label className="ml-2 flex items-center gap-2 text-sm">
                  <Switch size="sm" checked={!!rules.halfDouble} onCheckedChange={(v) => set({ halfDouble: v || undefined })} />
                  half and double time too
                </label>
              </div>
            </Rule>
            <Rule title="Key" hint="Pick keys, or one key to include everything that mixes with it on the Camelot wheel.">
              <div className="grid grid-cols-6 gap-1 sm:grid-cols-12">
                {WHEEL.map((k) => {
                  const on = rules.keys?.includes(k.key) ?? false
                  return (
                    <button
                      key={k.code}
                      type="button"
                      aria-pressed={on}
                      title={k.key}
                      onClick={() => set({ keys: on ? rules.keys!.filter((x) => x !== k.key) : [...(rules.keys ?? []), k.key] })}
                      className={cn("flex h-9 flex-col items-center justify-center rounded-lg text-[11px] leading-tight transition-colors", on ? "bg-foreground text-background" : "bg-muted hover:bg-muted/70")}
                    >
                      <span className="font-medium">{k.code}</span>
                      <span className="opacity-60">{k.key}</span>
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span>Mixes with</span>
                <Select
                  items={[{ value: "none", label: "no key" }, ...WHEEL.map((k) => ({ value: k.key, label: `${k.code} · ${k.key}` }))]}
                  value={rules.mixesWith ?? "none"}
                  onValueChange={(v) => set({ mixesWith: v === "none" ? undefined : String(v) })}
                >
                  <SelectTrigger className="w-36" aria-label="Mixes with key">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">no key</SelectItem>
                    {WHEEL.map((k) => (
                      <SelectItem key={k.code} value={k.key}>
                        {k.code} · {k.key}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </Rule>
            <Rule title="Year" hint={facets?.years.min ? `From ${facets.years.min} to ${facets.years.max} in your library.` : undefined}>
              <div className="flex items-center gap-2">
                <Input aria-label="From year" type="number" className="w-24" placeholder="from" value={rules.yearFrom ?? ""} onChange={(e) => set({ yearFrom: num(e.target.value) })} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input aria-label="To year" type="number" className="w-24" placeholder="to" value={rules.yearTo ?? ""} onChange={(e) => set({ yearTo: num(e.target.value) })} />
              </div>
            </Rule>
            <Rule title="Label">
              <Chips options={facets?.labels ?? []} value={rules.labels ?? []} onChange={(labels) => set({ labels })} max={16} />
              <AddValue placeholder="A label, then Enter" onAdd={(l) => set({ labels: [...(rules.labels ?? []), l] })} />
            </Rule>
            <Rule title="More">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-sm">
                  <span>Artists (comma between)</span>
                  <Input
                    value={(rules.artists ?? []).join(", ")}
                    onChange={(e) =>
                      set({
                        artists: e.target.value
                          .split(",")
                          .map((a) => a.trimStart())
                          .filter((a, i, all) => a || i === all.length - 1),
                      })
                    }
                  />
                </label>
                <label className="space-y-1.5 text-sm">
                  <span>Name or folder contains</span>
                  <Input value={rules.text ?? ""} onChange={(e) => set({ text: e.target.value || undefined })} />
                </label>
                <div className="space-y-1.5 text-sm">
                  <span>Library</span>
                  <Select items={libItems} value={rules.libraryId ? String(rules.libraryId) : "all"} onValueChange={(v) => set({ libraryId: v === "all" ? undefined : Number(v) })}>
                    <SelectTrigger className="w-full" aria-label="Library">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {libItems.map((l) => (
                        <SelectItem key={l.value} value={l.value}>
                          {l.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 text-sm">
                  <span>Which tracks</span>
                  <Select items={STATUS_CHOICES} value={statusValue} onValueChange={(v) => set({ statuses: STATUS_CHOICES.find((c) => c.value === v)?.statuses })}>
                    <SelectTrigger className="w-full" aria-label="Which tracks">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_CHOICES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 text-sm sm:col-span-2">
                  <span>Re-encoded files</span>
                  <Select items={QUALITY_CHOICES} value={rules.quality ?? "any"} onValueChange={(v) => set({ quality: v === "any" ? undefined : (v as "ok" | "suspect") })}>
                    <SelectTrigger className="w-full sm:w-64" aria-label="Re-encoded files">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {QUALITY_CHOICES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </Rule>
          </div>
          <aside className="bg-muted/40 h-fit space-y-2 rounded-2xl p-3 md:sticky md:top-0">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground text-xs">In this crate</span>
              <span className="font-heading text-xl font-extrabold tabular-nums">
                {preview.data?.total ?? "…"}
                {preview.isFetching && <Spinner className="ml-1.5 inline size-3" />}
              </span>
            </div>
            <ul className="space-y-1.5">
              {preview.data?.items.map((t) => (
                <li key={t.id} className="text-xs">
                  <div className="truncate font-medium">{t.proposedTitle ?? t.filename}</div>
                  <div className="text-muted-foreground truncate">
                    {[t.proposedArtist, formatBpm(t.bpm) && `${formatBpm(t.bpm)} BPM`, t.key].filter(Boolean).join(" · ")}
                  </div>
                </li>
              ))}
            </ul>
            {preview.data && preview.data.total > preview.data.items.length && <div className="text-muted-foreground text-xs">and {preview.data.total - preview.data.items.length} more</div>}
          </aside>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
            {save.isPending && <Spinner data-icon="inline-start" />}
            {crate ? "Save crate" : "Make crate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Starting points from what's in the library. */
function suggestions(f: CrateFacets | undefined): { name: string; rules: CrateRules }[] {
  if (!f) return []
  const out: { name: string; rules: CrateRules }[] = []
  for (const g of f.genres.slice(0, 3)) out.push({ name: g.value, rules: { genres: [g.value], statuses: ["done"] } })
  const topKey = f.keys[0]?.value
  if (topKey) out.push({ name: `Mixes with ${topKey}`, rules: { mixesWith: topKey } })
  out.push({ name: "Sounds re-encoded", rules: { quality: "suspect" } })
  return out
}

export default function CratesPage() {
  const qc = useQueryClient()
  const { data: crates, error, refetch } = useQuery({ queryKey: ["crates"], queryFn: api.crates })
  const { data: facets } = useQuery({ queryKey: ["crate-facets"], queryFn: () => api.crateFacets() })
  const { data: libraries } = useQuery({ queryKey: ["libraries"], queryFn: api.libraries })
  const [editing, setEditing] = useState<{ crate: Crate | null; session: number } | null>(null)
  const [session, setSession] = useState(0)
  const edit = (crate: Crate | null) => {
    setSession((n) => n + 1)
    setEditing({ crate, session: session + 1 })
  }
  const [exporting, setExporting] = useState<{ ids: number[]; name: string; count?: number } | null>(null)
  const libName = useMemo(() => (id: number) => libraries?.find((l) => l.id === id)?.name, [libraries])
  const create = useMutation({
    mutationFn: (s: { name: string; rules: CrateRules }) => api.createCrate(s.name, s.rules),
    onSuccess: (c) => {
      toast.success(`Made ${c.name}`, { description: `${c.count} track${c.count === 1 ? "" : "s"} in it.` })
      void qc.invalidateQueries({ queryKey: ["crates"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (c: Crate) => api.deleteCrate(c.id),
    onSuccess: (_r, c) => {
      toast(`Deleted ${c.name}`, { description: "The tracks themselves are untouched." })
      void qc.invalidateQueries({ queryKey: ["crates"] })
    },
  })

  const header = (
    <PageHeader
      eyebrow="Selections"
      title="Crates"
      description="Saved filters - genre, tempo, key, era, label - that fill themselves as tracks come in. Open one in Tracks, or send it to your DJ software."
      actions={
        <>
          {!!crates?.length && (
            <Button variant="outline" onClick={() => setExporting({ ids: crates.map((c) => c.id), name: "Dubplate crates" })}>
              <HugeiconsIcon icon={Download04Icon} strokeWidth={2} data-icon="inline-start" />
              Export all
            </Button>
          )}
          <Button onClick={() => edit(null)}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
            New crate
          </Button>
        </>
      }
    />
  )

  return (
    <>
      {header}
      {error ? (
        <QueryError error={error} onRetry={() => void refetch()} />
      ) : !crates ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 rounded-4xl" />
          ))}
        </div>
      ) : !crates.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Vynil02Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No crates yet</EmptyTitle>
            <EmptyDescription>Start from one of these, or make your own.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap justify-center gap-2">
              {suggestions(facets).map((s) => (
                <Button key={s.name} variant="outline" size="sm" onClick={() => create.mutate(s)} disabled={create.isPending}>
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
                  {s.name}
                </Button>
              ))}
            </div>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {crates.map((c) => (
            <Card key={c.id} className="animate-in fade-in duration-200">
              <CardContent className="flex h-full flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-bold">{c.name}</h2>
                    <div className="text-muted-foreground text-sm tabular-nums">
                      {c.count} track{c.count === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.name}`} onClick={() => edit(c)}>
                      <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Delete ${c.name}`} />}>
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete {c.name}?</AlertDialogTitle>
                          <AlertDialogDescription>Only the crate goes; its tracks stay where they are.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep it</AlertDialogCancel>
                          <AlertDialogAction variant="destructive" onClick={() => remove.mutate(c)}>
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {describeRules(c.rules, libName).map((d) => (
                    <span key={d} className="bg-muted rounded-full px-2.5 py-0.5 text-xs">
                      {d}
                    </span>
                  ))}
                  {!describeRules(c.rules).length && <span className="text-muted-foreground text-xs">Every track</span>}
                </div>
                <div className="mt-auto flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="outline" nativeButton={false} render={<Link to={`/tracks?crate=${c.id}`} />}>
                    Open in Tracks
                    <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} data-icon="inline-end" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setExporting({ ids: [c.id], name: c.name, count: c.count })} disabled={!c.count}>
                    <HugeiconsIcon icon={Download04Icon} strokeWidth={2} data-icon="inline-start" />
                    Export
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <CrateEditor key={session} crate={editing?.crate ?? null} facets={facets} open={!!editing} onOpenChange={(o) => !o && setEditing(null)} />
      <DjExportDialog open={!!exporting} onOpenChange={(o) => !o && setExporting(null)} crateIds={exporting?.ids} defaultName={exporting?.name ?? ""} count={exporting?.count} />
    </>
  )
}
