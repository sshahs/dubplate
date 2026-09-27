import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiBrain01Icon,
  ArrowDown01Icon,
  BookOpen01Icon,
  Delete02Icon,
  FileEditIcon,
  Image01Icon,
  RefreshIcon,
  Shield01Icon,
  Target02Icon,
  TestTube01Icon,
  Timer02Icon,
  Vynil01Icon,
} from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router"
import { toast } from "sonner"
import { renderTemplate } from "@core/naming"
import type { LlmProviderConfig, Settings } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { GenrePicker } from "@/components/genre-picker"
import { QueryError } from "@/components/query-error"
import { SectionNav, SettingRow, SettingRows, type SectionItem } from "@/components/settings-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { api, type PublicSettings } from "@/lib/api"
import { disableNotify, enableNotify, notifyEnabled, notifySupport } from "@/lib/notify"
import { cn } from "@/lib/utils"

type SectionId = "ai" | "crates" | "confidence" | "naming" | "extras" | "automation" | "safety" | "learning"

/** Sections, and the part of the settings each one edits (for the unsaved-changes dots). */
const SECTIONS: { id: SectionId; label: string; icon: SectionItem["icon"]; edits: (s: Settings) => unknown }[] = [
  { id: "ai", label: "AI interpreter", icon: AiBrain01Icon, edits: (s) => ({ ...s.llm, genres: undefined, sceneHint: undefined }) },
  { id: "crates", label: "Your crates", icon: Vynil01Icon, edits: (s) => [s.llm.genres, s.llm.sceneHint] },
  { id: "confidence", label: "Matching", icon: Target02Icon, edits: (s) => s.confidence },
  { id: "naming", label: "Naming & tags", icon: FileEditIcon, edits: (s) => s.naming },
  { id: "extras", label: "Artwork & tempo", icon: Image01Icon, edits: (s) => [s.artwork, s.analysis] },
  { id: "automation", label: "Automation", icon: Timer02Icon, edits: (s) => s.automation },
  { id: "safety", label: "Safety & scanner", icon: Shield01Icon, edits: (s) => [s.safety, s.scanner, s.contact] },
  { id: "learning", label: "Learning", icon: BookOpen01Icon, edits: () => null },
]
/** Older deep links that now live inside another section. */
const HASH_ALIASES: Record<string, SectionId> = { notifications: "automation", scanner: "safety" }

const one = (v: number | readonly number[]) => (Array.isArray(v) ? v[0] : (v as number))

/** A labelled slider with its value, sized for a SettingRow. */
function SliderControl({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = String,
  tone,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
  tone?: string
}) {
  return (
    <div className="flex w-full items-center gap-3 sm:w-64">
      <Slider min={min} max={max} step={step} value={[value]} onValueChange={(v) => onChange(one(v))} className="flex-1" aria-label={label} />
      <span className={cn("w-10 text-right font-mono text-sm tabular-nums", tone)}>{format(value)}</span>
    </div>
  )
}

function Choice<T extends string>({ value, items, onChange, className }: { value: T; items: { value: T; label: string }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <Select items={items} value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger className={cn("w-full sm:w-64", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------- AI ----------

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** One provider: a single line until opened, then its connection details. */
function ProviderItem({
  p,
  active,
  open,
  onOpenChange,
  onActivate,
  onChange,
  fromEnv,
  zdrFromEnv,
}: {
  p: LlmProviderConfig
  active: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onActivate: () => void
  onChange: (p: LlmProviderConfig) => void
  fromEnv: boolean
  zdrFromEnv: boolean
}) {
  const [models, setModels] = useState<string[] | null>(null)
  const fetchModels = useMutation({
    mutationFn: () => api.models(p.id),
    onSuccess: (r) => {
      setModels(r.models)
      if (r.error) toast.error(`${p.label}: ${r.error}`)
      else if (!r.models.length) toast(`${p.label} returned no models`)
    },
  })
  const test = useMutation({
    mutationFn: () => api.testLlm(p.id),
    onSuccess: (r) => (r.ok ? toast.success(`${p.label}: ${r.message}`, { description: `${r.latencyMs} ms` }) : toast.error(`${p.label}: ${r.message}`)),
  })
  const needsKey = p.kind !== "ollama" && p.kind !== "openai-compatible"
  const missingKey = needsKey && !p.apiKey && !fromEnv
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={cn("transition-colors", active && "bg-primary/5")}>
      <div className={cn("flex items-center gap-3 px-4 py-3", !p.enabled && "opacity-60")}>
        <button
          type="button"
          onClick={onActivate}
          aria-pressed={active}
          aria-label={`Use ${p.label}`}
          className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors", active ? "border-primary" : "border-muted-foreground/40 hover:border-muted-foreground")}
        >
          {active && <span className="bg-primary size-2.5 rounded-full" />}
        </button>
        <CollapsibleTrigger className="group/trigger flex min-w-0 flex-1 items-center gap-3 text-left outline-none">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.label}</span>
              {active && <Badge>in use</Badge>}
              {fromEnv && <Badge variant="outline">key from env</Badge>}
              {p.kind === "commandcode" && (p.zdr || zdrFromEnv) && <Badge variant="secondary">ZDR</Badge>}
            </div>
            <div className="text-muted-foreground truncate font-mono text-xs">
              {p.model || "no model chosen"} · {hostOf(p.baseUrl)}
            </div>
          </div>
          {missingKey && <span className="text-rasta-gold hidden text-xs sm:inline">needs a key</span>}
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="text-muted-foreground size-4 shrink-0 transition-transform duration-200 group-data-[panel-open]/trigger:rotate-180" />
        </CollapsibleTrigger>
        <Switch checked={p.enabled} onCheckedChange={(v) => onChange({ ...p, enabled: v })} size="sm" aria-label={`Offer ${p.label}`} />
      </div>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-(--ease-out) data-ending-style:h-0 data-starting-style:h-0">
        <div className="space-y-3 px-4 pt-1 pb-4 sm:pl-12">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`url-${p.id}`}>Base URL</FieldLabel>
              <Input id={`url-${p.id}`} value={p.baseUrl} onChange={(e) => onChange({ ...p, baseUrl: e.target.value })} className="font-mono text-xs" />
            </Field>
            <Field>
              <FieldLabel htmlFor={`model-${p.id}`}>Model</FieldLabel>
              <div className="flex gap-2">
                <Input id={`model-${p.id}`} value={p.model} onChange={(e) => onChange({ ...p, model: e.target.value })} list={`models-${p.id}`} className="font-mono text-xs" placeholder="pick or type" />
                <Button variant="outline" size="icon" onClick={() => fetchModels.mutate()} disabled={fetchModels.isPending} aria-label="Fetch model list">
                  {fetchModels.isPending ? <Spinner /> : <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />}
                </Button>
              </div>
              <datalist id={`models-${p.id}`}>{models?.map((m) => <option key={m} value={m} />)}</datalist>
              {models && <FieldDescription>{models.length} models available - start typing to pick.</FieldDescription>}
            </Field>
            {(needsKey || p.kind === "openai-compatible") && (
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor={`key-${p.id}`}>
                  API key {p.kind === "openai-compatible" && <span className="text-muted-foreground font-normal">(if required)</span>}
                </FieldLabel>
                <Input id={`key-${p.id}`} type="password" value={p.apiKey ?? ""} onChange={(e) => onChange({ ...p, apiKey: e.target.value })} placeholder="not set" autoComplete="off" />
              </Field>
            )}
          </div>
          {p.kind === "commandcode" && (
            <label className="flex items-start gap-3 rounded-xl border border-dashed p-3 text-sm">
              <Switch checked={zdrFromEnv || !!p.zdr} disabled={zdrFromEnv} onCheckedChange={(v) => onChange({ ...p, zdr: v })} className="mt-0.5" />
              <span>
                <span className="font-medium">Zero Data Retention</span>
                <span className="text-muted-foreground block text-xs">
                  Asks Command Code not to store your prompts or responses by sending <code>x-cmd-zdr: 1</code> with every request.
                  {zdrFromEnv && " Forced on by the CMD_ZDR environment variable."}
                </span>
              </span>
            </label>
          )}
          <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} data-icon="inline-start" />}
            Test (saved settings)
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ProviderList({ draft, set }: { draft: PublicSettings; set: (fn: (d: PublicSettings) => void) => void }) {
  const [openId, setOpenId] = useState<string | null>(draft.llm.activeProvider)
  return (
    <div className="divide-border/70 divide-y overflow-hidden rounded-2xl border">
      {draft.llm.providers.map((p, i) => (
        <ProviderItem
          key={p.id}
          p={p}
          active={draft.llm.activeProvider === p.id}
          open={openId === p.id}
          onOpenChange={(o) => setOpenId(o ? p.id : null)}
          fromEnv={draft.secretsFromEnv.includes(`llm:${p.id}`)}
          zdrFromEnv={draft.zdrFromEnv}
          onActivate={() => {
            set((d) => void (d.llm.activeProvider = p.id))
            setOpenId(p.id)
          }}
          onChange={(np) => set((d) => void (d.llm.providers[i] = np))}
        />
      ))}
    </div>
  )
}

// ---------- matching ----------

/** The three confidence bands as a bar, so the thresholds read at a glance. */
function Bands({ review, auto }: { review: number; auto: number }) {
  const segs = [
    { w: review, cls: "bg-rasta-red", label: "Unmatched", range: `0–${review - 1}` },
    { w: auto - review, cls: "bg-rasta-gold", label: "Review", range: `${review}–${auto - 1}` },
    { w: 100 - auto, cls: "bg-rasta-green", label: "Matched", range: `${auto}–100` },
  ]
  return (
    <div className="space-y-2">
      <div className="flex h-2.5 overflow-hidden rounded-full">
        {segs.map((s) => (
          <div key={s.label} className={cn("h-full transition-[width] duration-300", s.cls)} style={{ width: `${s.w}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {segs.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5 whitespace-nowrap">
            <span className={cn("size-2 rounded-full", s.cls)} />
            <span className="font-medium">{s.label}</span>
            <span className="text-muted-foreground font-mono">{s.w > 0 || s.label === "Matched" ? s.range : "none"}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------- learning ----------

function Learning() {
  const qc = useQueryClient()
  const { data: aliases } = useQuery({ queryKey: ["aliases"], queryFn: api.aliases })
  const { data: corrections } = useQuery({ queryKey: ["corrections"], queryFn: api.corrections })
  const [alias, setAlias] = useState("")
  const [canonical, setCanonical] = useState("")
  const add = useMutation({
    mutationFn: () => api.addAlias(alias, canonical),
    onSuccess: (list) => {
      qc.setQueryData(["aliases"], list)
      setAlias("")
      setCanonical("")
    },
    onError: (e) => toast.error(e.message),
  })
  const delAlias = useMutation({ mutationFn: api.deleteAlias, onSuccess: () => qc.invalidateQueries({ queryKey: ["aliases"] }) })
  const delCorrection = useMutation({ mutationFn: api.deleteCorrection, onSuccess: () => qc.invalidateQueries({ queryKey: ["corrections"] }) })
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Artist aliases</CardTitle>
          <CardDescription>Shorthand in filenames mapped to the credited name, e.g. “buju” → Buju Banton.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (alias && canonical) add.mutate()
            }}
          >
            <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="kartel" aria-label="Alias" />
            <Input value={canonical} onChange={(e) => setCanonical(e.target.value)} placeholder="Vybz Kartel" aria-label="Credited name" />
            <Button type="submit" variant="secondary" disabled={!alias || !canonical}>
              Add
            </Button>
          </form>
          <div className="max-h-80 space-y-0.5 overflow-y-auto">
            {aliases?.map((a) => (
              <div key={a.id} className="hover:bg-muted/50 flex items-center gap-2 rounded-xl px-2 py-1 text-sm">
                <span className="text-muted-foreground w-36 truncate font-mono text-xs">{a.alias}</span>
                <span className="flex-1 truncate">{a.canonical}</span>
                <Button size="icon-xs" variant="ghost" onClick={() => delAlias.mutate(a.id)} aria-label={`Delete alias ${a.alias}`}>
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Remembered corrections</CardTitle>
          <CardDescription>Every approval is kept and shown to the AI as an example for similar filenames.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 space-y-0.5 overflow-y-auto">
            {!corrections?.length && <div className="text-muted-foreground text-sm">Approve a few tracks and they'll show up here.</div>}
            {corrections?.map((c) => (
              <div key={c.id} className="hover:bg-muted/50 flex items-center gap-2 rounded-xl px-2 py-1">
                <div className="min-w-0 flex-1">
                  <div className="text-muted-foreground truncate font-mono text-[11px]">{c.filename}</div>
                  <div className="truncate text-sm">
                    {c.artists.join(" & ")} - {c.title}
                    {c.version ? ` (${c.version})` : ""}
                  </div>
                </div>
                <Button size="icon-xs" variant="ghost" onClick={() => delCorrection.mutate(c.id)} aria-label="Forget correction">
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------- notifications (per browser, not part of the saved settings) ----------

function NotificationsCard() {
  const support = notifySupport()
  const [on, setOn] = useState(notifyEnabled)
  const [denied, setDenied] = useState(support === "ok" && Notification.permission === "denied")
  const toggle = async (want: boolean) => {
    if (!want) {
      disableNotify()
      setOn(false)
      return
    }
    const result = await enableNotify()
    setOn(result === "granted")
    setDenied(result === "denied")
    if (result === "granted") new Notification("Dubplate notifications are on", { body: "You'll hear when long jobs finish.", icon: "/favicon.svg" })
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>When a long job finishes while you're in another tab, the tab title shows it. This part is saved in this browser only.</CardDescription>
      </CardHeader>
      <CardContent>
        <SettingRows>
          <SettingRow
            title="Pop up a notification"
            description={
              support === "insecure"
                ? "Browsers only allow notifications on HTTPS or localhost - open Dubplate through an HTTPS reverse proxy to use them."
                : support === "unsupported"
                  ? "This browser doesn't support notifications."
                  : denied
                    ? "Blocked for this site - allow notifications in the browser's site settings, then switch this on."
                    : "Scans, identifies and cuts that take a while."
            }
          >
            <Switch checked={on} disabled={support !== "ok"} onCheckedChange={(v) => void toggle(v)} aria-label="Pop up a notification" />
          </SettingRow>
        </SettingRows>
      </CardContent>
    </Card>
  )
}

// ---------- options ----------

const KEY_NOTATIONS = [
  { value: "musical" as const, label: "Musical - Am, F#" },
  { value: "camelot" as const, label: "Camelot - 8A, 2B" },
]
const BPM_RANGES = [
  { value: "60", label: "60–119 (half-time)" },
  { value: "70", label: "70–139" },
  { value: "78", label: "78–155" },
  { value: "88", label: "88–175 (Traktor-style)" },
  { value: "100", label: "100–199" },
]
const POLL_OPTIONS = [
  { value: "0", label: "Only when files change" },
  { value: "5", label: "Every 5 minutes" },
  { value: "15", label: "Every 15 minutes" },
  { value: "30", label: "Every 30 minutes" },
  { value: "60", label: "Every hour" },
]
const FEATURING = [
  { value: "artist" as const, label: "Artist feat. Guest - Title" },
  { value: "title" as const, label: "Artist - Title (feat. Guest)" },
  { value: "drop" as const, label: "Leave featuring out" },
]
const TOKENS = ["artist", "title", "song", "version", "year", "album", "label", "featuring", "genre"]

// ---------- page ----------

export default function SettingsPage() {
  const qc = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const { data, error, refetch } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: api.health })
  // Unsaved edits sit on top of the loaded settings; derived in render so the form never flashes empty.
  const [edit, setEdit] = useState<PublicSettings | null>(null)
  const draft = edit ?? data ?? null

  const hash = location.hash.slice(1)
  const section: SectionId = (SECTIONS.some((s) => s.id === hash) ? hash : HASH_ALIASES[hash]) as SectionId | undefined ?? "ai"
  const go = (id: string) => {
    navigate({ hash: id }, { replace: true })
    const top = document.getElementById("settings-top")
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" })
  }

  const save = useMutation({
    mutationFn: (s: Partial<Settings>) => api.saveSettings(s),
    onSuccess: (next) => {
      qc.setQueryData(["settings"], next)
      setEdit(null)
      void qc.invalidateQueries({ queryKey: ["health"] })
      void qc.invalidateQueries({ queryKey: ["sources"] })
      toast.success("Settings saved")
    },
    onError: (e) => toast.error(e.message),
  })

  const dirty = useMemo(() => !!edit && !!data && JSON.stringify(edit) !== JSON.stringify(data), [edit, data])
  const preview = useMemo(() => {
    if (!draft) return []
    const meta = { artists: ["Buju Banton", "Beenie Man"], relation: "vs" as const, featuring: [], title: "Live Clash", version: "Dubplate", year: 1993 }
    const meta2 = { artists: ["Chronixx"], featuring: ["Protoje"], title: "Here Comes Trouble", version: "Special", year: 2013, label: "Soul Circle" }
    return [renderTemplate(draft.naming.template, meta, draft.naming), renderTemplate(draft.naming.template, meta2, draft.naming)]
  }, [draft])

  const header = <PageHeader eyebrow="Mixing desk" title="Settings" description="How Dubplate reads, matches, names and tags your music." />
  if (!draft) {
    return (
      <>
        {header}
        {error ? (
          <QueryError error={error} onRetry={() => void refetch()} />
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
            <Skeleton className="hidden h-72 rounded-2xl lg:block" />
            <div className="space-y-4">
              <Skeleton className="h-80 rounded-4xl" />
              <Skeleton className="h-48 rounded-4xl" />
            </div>
          </div>
        )}
      </>
    )
  }
  const set = (fn: (d: PublicSettings) => void) => {
    const next = structuredClone(draft)
    fn(next)
    setEdit(next)
  }
  const changed = (edits: (s: Settings) => unknown) => !!edit && !!data && JSON.stringify(edits(edit)) !== JSON.stringify(edits(data))
  const navItems: SectionItem[] = SECTIONS.map((s) => ({ id: s.id, label: s.label, icon: s.icon, dirty: changed(s.edits) }))

  return (
    <>
      {header}
      <div id="settings-top" className="grid scroll-mt-20 grid-cols-[minmax(0,1fr)] gap-6 pb-24 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <SectionNav items={navItems} value={section} onChange={go} label="Settings sections" />

        <div key={section} className="animate-in fade-in slide-in-from-bottom-1 min-w-0 space-y-4 duration-200">
          {section === "ai" && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Provider</CardTitle>
                  <CardDescription>Local via Ollama, or a cloud model. The one in use reads each filename and returns a structured guess; open a provider to set it up.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ProviderList draft={draft} set={set} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>How it reads</CardTitle>
                </CardHeader>
                <CardContent>
                  <SettingRows>
                    <SettingRow title="Temperature" description="Keep it low - this is transcription, not creative writing.">
                      <SliderControl label="Temperature" value={draft.llm.temperature} min={0} max={1} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => set((d) => void (d.llm.temperature = v))} />
                    </SettingRow>
                    <SettingRow title="Parallel requests" description="1–2 for a local Ollama, higher for cloud APIs.">
                      <SliderControl label="Parallel requests" value={draft.llm.concurrency} min={1} max={8} step={1} onChange={(v) => set((d) => void (d.llm.concurrency = v))} />
                    </SettingRow>
                    <SettingRow title="Learn from my corrections" description="Show the AI your past approvals as examples for similar filenames.">
                      <Switch checked={draft.llm.useCorrections} onCheckedChange={(v) => set((d) => void (d.llm.useCorrections = v))} aria-label="Learn from my corrections" />
                    </SettingRow>
                  </SettingRows>
                </CardContent>
              </Card>
            </>
          )}

          {section === "crates" && (
            <Card>
              <CardHeader>
                <CardTitle>What's in your crates</CardTitle>
                <CardDescription>
                  Pick the genres and kinds of recording you've got. It tells the AI what to expect when a name could be read more than one way. Nothing picked means any genre.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SettingRows>
                  <div className="pb-4">
                    <GenrePicker value={draft.llm.genres} onChange={(genres) => set((d) => void (d.llm.genres = genres))} />
                  </div>
                  <SettingRow stack htmlFor="scene-hint" title="Anything else" description="Optional. A sentence about the collection, e.g. where most of it came from.">
                    <Textarea
                      id="scene-hint"
                      value={draft.llm.sceneHint}
                      onChange={(e) => set((d) => void (d.llm.sceneHint = e.target.value))}
                      rows={2}
                      placeholder="e.g. Mostly 90s pirate radio tapes and CD-R rips"
                    />
                  </SettingRow>
                </SettingRows>
              </CardContent>
            </Card>
          )}

          {section === "confidence" && (
            <Card>
              <CardHeader>
                <CardTitle>Confidence</CardTitle>
                <CardDescription>Where the lines sit between matched, review and unmatched.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <Bands review={draft.confidence.reviewThreshold} auto={draft.confidence.autoThreshold} />
                <SettingRows>
                  <SettingRow title="Matched from" description="At or above this, a track counts as a confident match.">
                    <SliderControl
                      label="Matched from"
                      value={draft.confidence.autoThreshold}
                      min={60}
                      max={100}
                      step={1}
                      tone="text-rasta-green"
                      onChange={(v) => set((d) => void (d.confidence.autoThreshold = v))}
                    />
                  </SettingRow>
                  <SettingRow title="Review from" description="Between this and “matched from”, a track waits for your ear. Below it, it's left alone.">
                    <SliderControl
                      label="Review from"
                      value={draft.confidence.reviewThreshold}
                      min={20}
                      max={95}
                      step={1}
                      tone="text-rasta-gold"
                      onChange={(v) => set((d) => void (d.confidence.reviewThreshold = Math.min(v, d.confidence.autoThreshold)))}
                    />
                  </SettingRow>
                  <SettingRow title="Cap without a source" description="The most a reading no database confirms can score. Keep it below “matched from” so dubplates and specials always get a human check.">
                    <SliderControl label="Cap without a source" value={draft.confidence.parseOnlyMax} min={30} max={95} step={1} onChange={(v) => set((d) => void (d.confidence.parseOnlyMax = v))} />
                  </SettingRow>
                  <SettingRow title="Approve matches automatically" description="Skip the sign-off for matched tracks. They still wait in Cut & Tag until you cut.">
                    <Switch checked={draft.confidence.autoApprove} onCheckedChange={(v) => set((d) => void (d.confidence.autoApprove = v))} aria-label="Approve matches automatically" />
                  </SettingRow>
                </SettingRows>
              </CardContent>
            </Card>
          )}

          {section === "naming" && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Filenames</CardTitle>
                  <CardDescription>What approved tracks are renamed to. Names that would collide are blocked, never overwritten.</CardDescription>
                </CardHeader>
                <CardContent>
                  <SettingRows>
                    <SettingRow stack htmlFor="template" title="Template" description="Click a token to add it.">
                      <div className="space-y-2">
                        <Input id="template" value={draft.naming.template} onChange={(e) => set((d) => void (d.naming.template = e.target.value))} className="font-mono" />
                        <div className="flex flex-wrap gap-1">
                          {TOKENS.map((t) => (
                            <button
                              key={t}
                              type="button"
                              onClick={() => set((d) => void (d.naming.template = `${d.naming.template}{${t}}`))}
                              className="bg-muted hover:bg-muted/70 rounded-md px-1.5 py-0.5 font-mono text-[11px] transition-colors"
                            >
                              {`{${t}}`}
                            </button>
                          ))}
                        </div>
                        <div className="bg-muted/50 space-y-0.5 rounded-xl p-2.5 font-mono text-xs">
                          {preview.map((p) => (
                            <div key={p} className="truncate">
                              {p}.mp3
                            </div>
                          ))}
                        </div>
                      </div>
                    </SettingRow>
                    <SettingRow title="Featured artists" description="Where guests go in the name.">
                      <Choice value={draft.naming.featuring} items={FEATURING} onChange={(v) => set((d) => void (d.naming.featuring = v))} />
                    </SettingRow>
                    <SettingRow title="Joiners" description="Between collaborators, and between the sides of a clash.">
                      <div className="flex gap-2">
                        <Input aria-label="Collab joiner" className="w-20 text-center" value={draft.naming.artistJoiner} onChange={(e) => set((d) => void (d.naming.artistJoiner = e.target.value))} />
                        <Input aria-label="Clash joiner" className="w-20 text-center" value={draft.naming.clashJoiner} onChange={(e) => set((d) => void (d.naming.clashJoiner = e.target.value))} />
                      </div>
                    </SettingRow>
                    <SettingRow title="Add the version to the title" description="“Here Comes Trouble (Special)”.">
                      <Switch checked={draft.naming.appendVersion} onCheckedChange={(v) => set((d) => void (d.naming.appendVersion = v))} aria-label="Add the version to the title" />
                    </SettingRow>
                    <SettingRow title="Rename files" description="Off: only tags are written.">
                      <Switch checked={draft.naming.renameFiles} onCheckedChange={(v) => set((d) => void (d.naming.renameFiles = v))} aria-label="Rename files" />
                    </SettingRow>
                  </SettingRows>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Tags</CardTitle>
                  <CardDescription>
                    BPM, key and artwork have their own switches under{" "}
                    <button type="button" className="underline underline-offset-2" onClick={() => go("extras")}>
                      Artwork & tempo
                    </button>
                    .
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <SettingRows>
                    <SettingRow title="Write tags" description="Artist and title always; album, year, genre and label only where the file has none.">
                      <Switch checked={draft.naming.writeTags} onCheckedChange={(v) => set((d) => void (d.naming.writeTags = v))} aria-label="Write tags" />
                    </SettingRow>
                    <SettingRow title="Sign the comment" description="Adds “Identified by Dubplate” to the comment tag.">
                      <Switch checked={draft.naming.tagComment} onCheckedChange={(v) => set((d) => void (d.naming.tagComment = v))} aria-label="Sign the comment" />
                    </SettingRow>
                  </SettingRows>
                </CardContent>
              </Card>
            </>
          )}

          {section === "extras" && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Artwork</CardTitle>
                  <CardDescription>Covers come from the sources that identified a track.</CardDescription>
                </CardHeader>
                <CardContent>
                  <SettingRows>
                    <SettingRow title="Look for cover art" description="While identifying tracks.">
                      <Switch checked={draft.artwork.fetch} onCheckedChange={(v) => set((d) => void (d.artwork.fetch = v))} aria-label="Look for cover art" />
                    </SettingRow>
                    <SettingRow title="Embed it when cutting" description="Written as the front cover; other pictures in the file are left alone.">
                      <Switch checked={draft.artwork.embed} onCheckedChange={(v) => set((d) => void (d.artwork.embed = v))} aria-label="Embed artwork when cutting" />
                    </SettingRow>
                    <SettingRow title="Replace covers files already have" description="Off: files with their own picture keep it.">
                      <Switch checked={draft.artwork.replaceExisting} onCheckedChange={(v) => set((d) => void (d.artwork.replaceExisting = v))} aria-label="Replace existing covers" />
                    </SettingRow>
                  </SettingRows>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Tempo & key</CardTitle>
                  <CardDescription>Worked out by listening to the audio. Tags already in the file and your own edits always win.</CardDescription>
                </CardHeader>
                <CardContent>
                  <SettingRows>
                    <SettingRow title="Analyse while identifying" description="Or run it on a selection from Tracks.">
                      <Switch checked={draft.analysis.onProcess} onCheckedChange={(v) => set((d) => void (d.analysis.onProcess = v))} aria-label="Analyse BPM and key while identifying" />
                    </SettingRow>
                    <SettingRow title="Write BPM & key to tags" description="When cutting.">
                      <Switch checked={draft.analysis.writeTags} onCheckedChange={(v) => set((d) => void (d.analysis.writeTags = v))} aria-label="Write BPM and key to tags" />
                    </SettingRow>
                    <SettingRow title="Key notation" description="How keys are shown and written.">
                      <Choice value={draft.analysis.keyNotation} items={KEY_NOTATIONS} onChange={(v) => set((d) => void (d.analysis.keyNotation = v))} />
                    </SettingRow>
                    <SettingRow title="BPM range" description="Tempos are doubled or halved into this range: in 88–175 a one-drop at 75 reads 150 and jungle stays at 170.">
                      <Choice value={String(draft.analysis.bpmMin)} items={BPM_RANGES} onChange={(v) => set((d) => void (d.analysis.bpmMin = Number(v)))} />
                    </SettingRow>
                  </SettingRows>
                </CardContent>
              </Card>
            </>
          )}

          {section === "automation" && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Automation</CardTitle>
                  <CardDescription>
                    Switch watching on per folder in{" "}
                    <Link to="/libraries" className="underline underline-offset-2">
                      Libraries
                    </Link>
                    . Times follow the server's clock{health?.timeZone ? ` (${health.timeZone})` : ""}.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <SettingRows>
                    <SettingRow title="Identify new files" description="Files that watching or the nightly scan picks up are identified straight away.">
                      <Switch checked={draft.automation.autoProcess} onCheckedChange={(v) => set((d) => void (d.automation.autoProcess = v))} aria-label="Identify new files automatically" />
                    </SettingRow>
                    <SettingRow title="Re-check watched folders" description="A safety net for network shares and Docker mounts that don't report new files.">
                      <Choice value={String(draft.automation.pollMinutes)} items={POLL_OPTIONS} onChange={(v) => set((d) => void (d.automation.pollMinutes = Number(v)))} />
                    </SettingRow>
                    <SettingRow title="Nightly scan" description="Rescans every library once a night, watched or not.">
                      <div className="flex items-center gap-3">
                        <Input
                          type="time"
                          aria-label="Nightly scan time"
                          className="w-32"
                          disabled={!draft.automation.nightly}
                          value={draft.automation.nightlyAt}
                          onChange={(e) => set((d) => void (d.automation.nightlyAt = e.target.value || "03:00"))}
                        />
                        <Switch checked={draft.automation.nightly} onCheckedChange={(v) => set((d) => void (d.automation.nightly = v))} aria-label="Nightly scan" />
                      </div>
                    </SettingRow>
                  </SettingRows>
                </CardContent>
              </Card>
              <NotificationsCard />
            </>
          )}

          {section === "safety" && (
            <>
              <Card className={cn(!draft.safety.readOnly && "border-rasta-red/40")}>
                <CardHeader>
                  <CardTitle>Safety</CardTitle>
                </CardHeader>
                <CardContent>
                  <SettingRows>
                    <SettingRow title="Read-only mode" description="Blocks every rename and tag write. Dry runs still work.">
                      <Switch checked={draft.safety.readOnly} onCheckedChange={(v) => set((d) => void (d.safety.readOnly = v))} aria-label="Read-only mode" />
                    </SettingRow>
                  </SettingRows>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Scanner</CardTitle>
                </CardHeader>
                <CardContent>
                  <SettingRows>
                    <SettingRow title="Fingerprint file contents" description="Spots exact duplicates and follows files moved outside Dubplate.">
                      <Switch checked={draft.scanner.hashFiles} onCheckedChange={(v) => set((d) => void (d.scanner.hashFiles = v))} aria-label="Fingerprint file contents" />
                    </SettingRow>
                    <SettingRow stack htmlFor="exts" title="Audio extensions" description="Comma-separated.">
                      <Input
                        id="exts"
                        className="font-mono text-xs"
                        value={draft.scanner.extensions.join(", ")}
                        onChange={(e) =>
                          set(
                            (d) =>
                              void (d.scanner.extensions = e.target.value
                                .split(",")
                                .map((x) => x.trim().replace(/^\./, "").toLowerCase())
                                .filter(Boolean))
                          )
                        }
                      />
                    </SettingRow>
                    <SettingRow stack htmlFor="ignore" title="Ignore" description="Folder or file names to skip; * and ? work as wildcards.">
                      <Input
                        id="ignore"
                        className="font-mono text-xs"
                        value={draft.scanner.ignore.join(", ")}
                        onChange={(e) =>
                          set(
                            (d) =>
                              void (d.scanner.ignore = e.target.value
                                .split(",")
                                .map((x) => x.trim())
                                .filter(Boolean))
                          )
                        }
                      />
                    </SettingRow>
                  </SettingRows>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Contact</CardTitle>
                </CardHeader>
                <CardContent>
                  <SettingRows>
                    <SettingRow stack htmlFor="contact" title="How APIs can reach you" description="MusicBrainz asks every client to identify itself; this goes in the User-Agent.">
                      <Input id="contact" value={draft.contact} onChange={(e) => set((d) => void (d.contact = e.target.value))} placeholder="you@example.com or a URL" />
                    </SettingRow>
                  </SettingRows>
                </CardContent>
              </Card>
            </>
          )}

          {section === "learning" && <Learning />}
        </div>
      </div>

      <div
        className={cn(
          "bg-card/95 fixed right-4 bottom-4 z-30 flex items-center gap-3 rounded-full border p-2 pl-5 shadow-2xl backdrop-blur transition-all",
          dirty ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-4 opacity-0"
        )}
      >
        <span className="text-sm">Unsaved changes</span>
        <Button variant="ghost" size="sm" onClick={() => setEdit(null)}>
          Discard
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const { secretsFromEnv: _env, zdrFromEnv: _zdr, ...rest } = draft
            save.mutate(rest)
          }}
          disabled={save.isPending}
        >
          Save settings
        </Button>
      </div>
    </>
  )
}
