import { HugeiconsIcon } from "@hugeicons/react"
import { Delete02Icon, RefreshIcon, TestTube01Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { Link, useLocation } from "react-router"
import { toast } from "sonner"
import { renderTemplate } from "@core/naming"
import type { LlmProviderConfig, Settings } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { QueryError } from "@/components/query-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
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

function ProviderRow({
  p,
  active,
  onActivate,
  onChange,
  fromEnv,
  zdrFromEnv,
}: {
  p: LlmProviderConfig
  active: boolean
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
  return (
    <div className={cn("rounded-2xl border p-4 transition-colors", active && "border-primary/50 bg-primary/5")}>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onActivate} className="flex items-center gap-2 text-left" aria-pressed={active}>
          <span className={cn("flex size-4 items-center justify-center rounded-full border-2", active ? "border-primary" : "border-muted-foreground/40")}>
            {active && <span className="bg-primary size-2 rounded-full" />}
          </span>
          <span className="font-heading font-bold">{p.label}</span>
        </button>
        {active && <Badge>active</Badge>}
        {fromEnv && <Badge variant="outline">key from env</Badge>}
        {p.kind === "commandcode" && (p.zdr || zdrFromEnv) && <Badge variant="secondary">ZDR</Badge>}
        <label className="text-muted-foreground ml-auto flex items-center gap-2 text-xs">
          <Switch checked={p.enabled} onCheckedChange={(v) => onChange({ ...p, enabled: v })} size="sm" />
          enabled
        </label>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel>Base URL</FieldLabel>
          <Input value={p.baseUrl} onChange={(e) => onChange({ ...p, baseUrl: e.target.value })} className="font-mono text-xs" />
        </Field>
        <Field>
          <FieldLabel>Model</FieldLabel>
          <div className="flex gap-2">
            <Input value={p.model} onChange={(e) => onChange({ ...p, model: e.target.value })} list={`models-${p.id}`} className="font-mono text-xs" placeholder="pick or type" />
            <Button variant="outline" size="icon" onClick={() => fetchModels.mutate()} disabled={fetchModels.isPending} aria-label="Fetch model list">
              {fetchModels.isPending ? <Spinner /> : <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />}
            </Button>
          </div>
          <datalist id={`models-${p.id}`}>{models?.map((m) => <option key={m} value={m} />)}</datalist>
          {models && <FieldDescription>{models.length} models available — start typing to pick.</FieldDescription>}
        </Field>
        {(needsKey || p.kind === "openai-compatible") && (
          <Field className="sm:col-span-2">
            <FieldLabel>API key {p.kind === "openai-compatible" && <span className="text-muted-foreground font-normal">(if required)</span>}</FieldLabel>
            <Input type="password" value={p.apiKey ?? ""} onChange={(e) => onChange({ ...p, apiKey: e.target.value })} placeholder="not set" autoComplete="off" />
          </Field>
        )}
      </div>
      {p.kind === "commandcode" && (
        <label className="mt-3 flex items-start gap-3 rounded-xl border border-dashed p-3 text-sm">
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
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} data-icon="inline-start" />}
          Test (saved settings)
        </Button>
      </div>
    </div>
  )
}

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
    <Card id="learning">
      <CardHeader>
        <CardTitle>Learning</CardTitle>
        <CardDescription>
          Aliases map shorthand to the credited name ("buju" → Buju Banton). Every approval is remembered as a correction and shown to the AI as an example for
          similar filenames.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="text-sm font-semibold">Artist aliases</div>
          <div className="flex gap-2">
            <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="alias (e.g. kartel)" />
            <Input value={canonical} onChange={(e) => setCanonical(e.target.value)} placeholder="Vybz Kartel" />
            <Button variant="secondary" onClick={() => add.mutate()} disabled={!alias || !canonical}>
              Add
            </Button>
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto">
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
        </div>
        <div className="space-y-3">
          <div className="text-sm font-semibold">Remembered corrections ({corrections?.length ?? 0})</div>
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {!corrections?.length && <div className="text-muted-foreground text-sm">Approve a few tracks and they'll show up here.</div>}
            {corrections?.map((c) => (
              <div key={c.id} className="hover:bg-muted/50 flex items-center gap-2 rounded-xl px-2 py-1">
                <div className="min-w-0 flex-1">
                  <div className="text-muted-foreground truncate font-mono text-[11px]">{c.filename}</div>
                  <div className="truncate text-sm">
                    {c.artists.join(" & ")} — {c.title}
                    {c.version ? ` (${c.version})` : ""}
                  </div>
                </div>
                <Button size="icon-xs" variant="ghost" onClick={() => delCorrection.mutate(c.id)} aria-label="Forget correction">
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

const KEY_NOTATIONS = [
  { value: "musical", label: "Musical — Am, F#" },
  { value: "camelot", label: "Camelot — 8A, 2B" },
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

/** Per-browser: whether this browser shows a system notification when a long job finishes. */
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
    <Card id="notifications">
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>When a long scan, identify or cut finishes while you're in another tab, the tab title shows it. This browser can also pop up a notification.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={on} disabled={support !== "ok"} onCheckedChange={(v) => void toggle(v)} />
          Notify me in this browser when long jobs finish
        </label>
        {support === "insecure" && (
          <p className="text-muted-foreground text-xs">
            Browsers only allow notifications on HTTPS or localhost. Open Dubplate through an HTTPS reverse proxy to use them — the tab title still flags finished jobs.
          </p>
        )}
        {support === "unsupported" && <p className="text-muted-foreground text-xs">This browser doesn't support notifications; the tab title still flags finished jobs.</p>}
        {denied && <p className="text-rasta-gold text-xs">Notifications are blocked for this site — allow them in the browser's site settings, then switch this on.</p>}
      </CardContent>
    </Card>
  )
}

const FEATURING = [
  { value: "artist", label: "Artist feat. Guest - Title" },
  { value: "title", label: "Artist - Title (feat. Guest)" },
  { value: "drop", label: "Leave featuring out" },
]

export default function SettingsPage() {
  const qc = useQueryClient()
  const location = useLocation()
  const { data, error, refetch } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: api.health })
  // Unsaved edits sit on top of the loaded settings; derived in render so the form never flashes empty.
  const [edit, setEdit] = useState<PublicSettings | null>(null)
  const draft = edit ?? data ?? null
  useEffect(() => {
    if (location.hash && draft) document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: "smooth" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash, !!draft])

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
    if (!draft) return ""
    const meta = { artists: ["Buju Banton", "Beenie Man"], relation: "vs" as const, featuring: [], title: "Live Clash", version: "Dubplate", year: 1993 }
    const meta2 = { artists: ["Chronixx"], featuring: ["Protoje"], title: "Here Comes Trouble", version: "Special", year: 2013, label: "Soul Circle" }
    return [renderTemplate(draft.naming.template, meta, draft.naming), renderTemplate(draft.naming.template, meta2, draft.naming)]
  }, [draft])

  if (!draft) {
    return (
      <>
        <PageHeader eyebrow="Mixing desk" title="Settings" description="AI providers, confidence thresholds, naming and safety." />
        {error ? (
          <QueryError error={error} onRetry={() => void refetch()} />
        ) : (
          <div className="space-y-4">
            <Skeleton className="h-96 rounded-4xl" />
            <Skeleton className="h-56 rounded-4xl" />
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

  return (
    <>
      <PageHeader eyebrow="Mixing desk" title="Settings" description="AI providers, confidence thresholds, naming and safety." />
      <div className="space-y-4 pb-24">
        <Card id="ai">
          <CardHeader>
            <CardTitle>AI interpreter</CardTitle>
            <CardDescription>Local via Ollama, or cloud. The active provider reads each filename and returns a structured guess.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {draft.llm.providers.map((p, i) => (
              <ProviderRow
                key={p.id}
                p={p}
                active={draft.llm.activeProvider === p.id}
                fromEnv={draft.secretsFromEnv.includes(`llm:${p.id}`)}
                zdrFromEnv={draft.zdrFromEnv}
                onActivate={() => set((d) => void (d.llm.activeProvider = p.id))}
                onChange={(np) => set((d) => void (d.llm.providers[i] = np))}
              />
            ))}
            <FieldGroup className="grid gap-4 pt-2 sm:grid-cols-2">
              <Field>
                <FieldLabel>
                  Temperature <span className="text-muted-foreground font-mono">{draft.llm.temperature.toFixed(2)}</span>
                </FieldLabel>
                <Slider min={0} max={1} step={0.05} value={[draft.llm.temperature]} onValueChange={(v) => set((d) => void (d.llm.temperature = Array.isArray(v) ? v[0] : v))} />
                <FieldDescription>Keep low — this is transcription, not creative writing.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>
                  Parallel requests <span className="text-muted-foreground font-mono">{draft.llm.concurrency}</span>
                </FieldLabel>
                <Slider min={1} max={8} step={1} value={[draft.llm.concurrency]} onValueChange={(v) => set((d) => void (d.llm.concurrency = Array.isArray(v) ? v[0] : v))} />
                <FieldDescription>1–2 for local Ollama, higher for cloud APIs.</FieldDescription>
              </Field>
              <Field className="sm:col-span-2">
                <FieldLabel>Collection context</FieldLabel>
                <Textarea value={draft.llm.sceneHint} onChange={(e) => set((d) => void (d.llm.sceneHint = e.target.value))} rows={2} />
                <FieldDescription>Tell the AI what's in your crates — it shapes how ambiguous names are read.</FieldDescription>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.llm.useCorrections} onCheckedChange={(v) => set((d) => void (d.llm.useCorrections = v))} />
                Show the AI my past corrections as examples
              </label>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card id="confidence">
          <CardHeader>
            <CardTitle>Confidence engine</CardTitle>
            <CardDescription>Where the lines sit between auto-match, review and unmatched.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel>
                  Auto-match at <span className="text-rasta-green font-mono">{draft.confidence.autoThreshold}</span>
                </FieldLabel>
                <Slider min={60} max={100} step={1} value={[draft.confidence.autoThreshold]} onValueChange={(v) => set((d) => void (d.confidence.autoThreshold = Array.isArray(v) ? v[0] : v))} />
              </Field>
              <Field>
                <FieldLabel>
                  Review from <span className="text-rasta-gold font-mono">{draft.confidence.reviewThreshold}</span>
                </FieldLabel>
                <Slider min={20} max={95} step={1} value={[draft.confidence.reviewThreshold]} onValueChange={(v) => set((d) => void (d.confidence.reviewThreshold = Array.isArray(v) ? v[0] : v))} />
              </Field>
              <Field>
                <FieldLabel>
                  Cap without source confirmation <span className="font-mono">{draft.confidence.parseOnlyMax}</span>
                </FieldLabel>
                <Slider min={30} max={95} step={1} value={[draft.confidence.parseOnlyMax]} onValueChange={(v) => set((d) => void (d.confidence.parseOnlyMax = Array.isArray(v) ? v[0] : v))} />
                <FieldDescription>Dubplates rarely appear in databases; keep this below auto-match so they always get a human check.</FieldDescription>
              </Field>
              <label className="flex items-center gap-2 self-center text-sm">
                <Switch checked={draft.confidence.autoApprove} onCheckedChange={(v) => set((d) => void (d.confidence.autoApprove = v))} />
                Auto-approve matched tracks
              </label>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card id="naming">
          <CardHeader>
            <CardTitle>Naming & tagging</CardTitle>
            <CardDescription>
              Tokens: <code>{"{artist}"}</code> <code>{"{title}"}</code> <code>{"{version}"}</code> <code>{"{year}"}</code> <code>{"{album}"}</code> <code>{"{label}"}</code>{" "}
              <code>{"{featuring}"}</code> <code>{"{song}"}</code>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <Field className="sm:col-span-2">
                <FieldLabel>Filename template</FieldLabel>
                <Input value={draft.naming.template} onChange={(e) => set((d) => void (d.naming.template = e.target.value))} className="font-mono" />
                <div className="bg-muted/50 mt-1 space-y-0.5 rounded-xl p-2 font-mono text-xs">
                  {Array.isArray(preview) && preview.map((p) => <div key={p}>{p}.mp3</div>)}
                </div>
              </Field>
              <Field>
                <FieldLabel>Featured artists</FieldLabel>
                <Select items={FEATURING} value={draft.naming.featuring} onValueChange={(v) => set((d) => void (d.naming.featuring = v as Settings["naming"]["featuring"]))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FEATURING.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>Collab joiner</FieldLabel>
                  <Input value={draft.naming.artistJoiner} onChange={(e) => set((d) => void (d.naming.artistJoiner = e.target.value))} />
                </Field>
                <Field>
                  <FieldLabel>Clash joiner</FieldLabel>
                  <Input value={draft.naming.clashJoiner} onChange={(e) => set((d) => void (d.naming.clashJoiner = e.target.value))} />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.naming.appendVersion} onCheckedChange={(v) => set((d) => void (d.naming.appendVersion = v))} />
                Append version to title — "Title (Dubplate)"
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.naming.renameFiles} onCheckedChange={(v) => set((d) => void (d.naming.renameFiles = v))} />
                Rename files
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.naming.writeTags} onCheckedChange={(v) => set((d) => void (d.naming.writeTags = v))} />
                Write tags (artist & title; fills empty album/year/genre/label)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.naming.tagComment} onCheckedChange={(v) => set((d) => void (d.naming.tagComment = v))} />
                Add an "Identified by Dubplate" comment
              </label>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card id="extras">
          <CardHeader>
            <CardTitle>Artwork, tempo & key</CardTitle>
            <CardDescription>Covers come from the sources that identified a track; tempo and key are worked out by listening to it.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.artwork.fetch} onCheckedChange={(v) => set((d) => void (d.artwork.fetch = v))} />
                Look for cover art when identifying
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.artwork.embed} onCheckedChange={(v) => set((d) => void (d.artwork.embed = v))} />
                Embed found artwork when cutting
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.artwork.replaceExisting} onCheckedChange={(v) => set((d) => void (d.artwork.replaceExisting = v))} />
                Replace artwork a file already has
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.analysis.onProcess} onCheckedChange={(v) => set((d) => void (d.analysis.onProcess = v))} />
                Analyse BPM & key when identifying
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.analysis.writeTags} onCheckedChange={(v) => set((d) => void (d.analysis.writeTags = v))} />
                Write BPM & key to tags when cutting
              </label>
              <div />
              <Field>
                <FieldLabel>Key notation</FieldLabel>
                <Select items={KEY_NOTATIONS} value={draft.analysis.keyNotation} onValueChange={(v) => set((d) => void (d.analysis.keyNotation = v as Settings["analysis"]["keyNotation"]))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KEY_NOTATIONS.map((k) => (
                      <SelectItem key={k.value} value={k.value}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>How keys are shown and written to tags.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>BPM range</FieldLabel>
                <Select items={BPM_RANGES} value={String(draft.analysis.bpmMin)} onValueChange={(v) => set((d) => void (d.analysis.bpmMin = Number(v)))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BPM_RANGES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Detected tempos are doubled or halved into this range. In 88–175 a one-drop at 75 reads 150 and jungle stays at 170.</FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card id="automation">
          <CardHeader>
            <CardTitle>Automation</CardTitle>
            <CardDescription>
              Turn on watching per folder in{" "}
              <Link to="/libraries" className="underline underline-offset-2">
                Libraries
              </Link>
              . Times are the server's clock{health?.timeZone ? ` (${health.timeZone})` : ""}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <Switch checked={draft.automation.autoProcess} onCheckedChange={(v) => set((d) => void (d.automation.autoProcess = v))} />
                Identify new files that watching or the nightly scan picks up
              </label>
              <Field>
                <FieldLabel>Re-check watched folders</FieldLabel>
                <Select items={POLL_OPTIONS} value={String(draft.automation.pollMinutes)} onValueChange={(v) => set((d) => void (d.automation.pollMinutes = Number(v)))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {POLL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>A safety net for network shares and Docker mounts that don't report new files. Folders that can't report changes are checked every 15 minutes regardless.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Nightly scan</FieldLabel>
                <div className="flex items-center gap-3">
                  <Switch checked={draft.automation.nightly} onCheckedChange={(v) => set((d) => void (d.automation.nightly = v))} aria-label="Nightly scan" />
                  <Input
                    type="time"
                    className="w-32"
                    disabled={!draft.automation.nightly}
                    value={draft.automation.nightlyAt}
                    onChange={(e) => set((d) => void (d.automation.nightlyAt = e.target.value || "03:00"))}
                  />
                </div>
                <FieldDescription>Rescans every library once a night, watched or not.</FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <NotificationsCard />

        <Card id="safety">
          <CardHeader>
            <CardTitle>Safety & scanner</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Switch checked={draft.safety.readOnly} onCheckedChange={(v) => set((d) => void (d.safety.readOnly = v))} />
                Read-only mode (blocks all renames and tag writes)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.scanner.hashFiles} onCheckedChange={(v) => set((d) => void (d.scanner.hashFiles = v))} />
                Fingerprint file contents (duplicate + move detection)
              </label>
              <Field>
                <FieldLabel>Audio extensions</FieldLabel>
                <Input
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
              </Field>
              <Field>
                <FieldLabel>Ignore (globs)</FieldLabel>
                <Input
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
              </Field>
              <Field className="sm:col-span-2">
                <FieldLabel>Contact for API User-Agent</FieldLabel>
                <Input value={draft.contact} onChange={(e) => set((d) => void (d.contact = e.target.value))} placeholder="you@example.com or a URL" />
                <FieldDescription>MusicBrainz asks every client to identify itself with a way to reach you.</FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <Learning />
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
