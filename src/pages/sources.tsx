import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowDown01Icon,
  Copy01Icon,
  Database01Icon,
  Delete02Icon,
  Edit02Icon,
  FingerPrintIcon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  RefreshIcon,
  SourceCodeIcon,
  TestTube01Icon,
  Vynil01Icon,
} from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router"
import { toast } from "sonner"
import type { Candidate, ScraperDefinition, SourceConfig } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { QueryError } from "@/components/query-error"
import { SectionNav, SettingRow, SettingRows, type SectionItem } from "@/components/settings-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { api, type PublicSettings, type SourceStatus } from "@/lib/api"
import { useActiveJobs } from "@/lib/events"
import { fmtAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

type GroupId = "catalogues" | "underground" | "fingerprint" | "scrapers"

/** Built-in sources by where they look; anything not listed is a catalogue. */
const GROUPS: { id: GroupId; label: string; icon: SectionItem["icon"]; title: string; description: string; ids?: string[] }[] = [
  { id: "catalogues", label: "Catalogues", icon: Database01Icon, title: "Catalogues", description: "The big databases and stores. Best for anything that was properly released." },
  {
    id: "underground",
    label: "Underground",
    icon: Vynil01Icon,
    title: "Underground",
    description: "Where specials, clash tapes, radio sets and white labels actually turn up.",
    ids: ["bandcamp", "archive", "mixcloud", "youtube"],
  },
  {
    id: "fingerprint",
    label: "Fingerprint",
    icon: FingerPrintIcon,
    title: "Audio fingerprint",
    description: "Recognises the recording itself, so it still works when the filename is nonsense.",
    ids: ["acoustid"],
  },
  { id: "scrapers", label: "Custom scrapers", icon: SourceCodeIcon, title: "Custom scrapers", description: "Grime archives, clash databases, label shops - anything with a search page." },
]

const groupOf = (id: string): GroupId => (id.startsWith("scraper:") ? "scrapers" : (GROUPS.find((g) => g.ids?.includes(id))?.id ?? "catalogues"))

const MAX_WEIGHT = 1.5
const one = (v: number | readonly number[]) => (Array.isArray(v) ? v[0] : (v as number))

/** Genre weights as they're typed: "Reggae: 1.3, Dancehall: 1.2". */
const formatWeights = (w: Record<string, number> | undefined | null) =>
  Object.entries(w ?? {})
    .map(([g, n]) => `${g}: ${n}`)
    .join(", ")

function parseWeights(text: string): Record<string, number> | undefined {
  const out: Record<string, number> = {}
  for (const part of text.split(",")) {
    const m = part.match(/^\s*(.+?)\s*[:=]\s*([\d.]+)\s*$/)
    if (m && Number.isFinite(Number(m[2]))) out[m[1]] = Math.min(2, Math.max(0.5, Number(m[2])))
  }
  return Object.keys(out).length ? out : undefined
}

function hostOf(url: string) {
  try {
    return new URL(url.replace(/\{[^}]+\}/g, "x")).host
  } catch {
    return url
  }
}

function CandidateList({ items }: { items: Candidate[] }) {
  if (!items.length) return <div className="text-muted-foreground text-xs">No results.</div>
  return (
    <div className="space-y-1">
      {items.slice(0, 8).map((c, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate">
            {c.artist || "?"} - {c.title}
            {c.year ? ` · ${c.year}` : ""}
            {c.album ? ` · ${c.album}` : ""}
          </span>
          {c.url && (
            <a href={c.url} target="_blank" rel="noreferrer noopener" className="text-muted-foreground hover:text-foreground" aria-label="Open result">
              <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} className="size-3.5" />
            </a>
          )}
        </div>
      ))}
    </div>
  )
}

/** Trust weight as a short bar, so sources compare at a glance down the list. */
function WeightMeter({ value, dim }: { value: number; dim?: boolean }) {
  return (
    <span className="hidden shrink-0 items-center gap-2 sm:flex" title={`Trust weight ${value.toFixed(2)}`}>
      <span className="bg-muted h-1.5 w-14 overflow-hidden rounded-full">
        <span className={cn("block h-full rounded-full transition-[width] duration-200", dim ? "bg-muted-foreground/30" : "bg-foreground/60")} style={{ width: `${Math.min(100, (value / MAX_WEIGHT) * 100)}%` }} />
      </span>
      <span className="text-muted-foreground w-8 text-right font-mono text-xs tabular-nums">
        <span className="sr-only">trust weight </span>
        {value.toFixed(2)}
      </span>
    </span>
  )
}

function Chevron() {
  return <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="text-muted-foreground size-4 shrink-0 transition-transform duration-200 group-data-[panel-open]/trigger:rotate-180" />
}

type TestResult = { candidates?: Candidate[]; error?: string; ms: number }

function TestOutput({ result }: { result: TestResult }) {
  const n = result.candidates?.length ?? 0
  return (
    <div className="bg-muted/40 mt-3 space-y-2 rounded-2xl p-3">
      <div className="text-muted-foreground flex justify-between text-xs">
        <span>{result.error ? "Failed" : `${n} result${n === 1 ? "" : "s"}`}</span>
        <span className="tabular-nums">{result.ms} ms</span>
      </div>
      {result.error ? <div className="text-rasta-red text-xs">{result.error}</div> : <CandidateList items={result.candidates ?? []} />}
    </div>
  )
}

/** One built-in source: a single line until opened, then its key, weight and a test. */
function SourceRow({
  s,
  cfg,
  keyFromEnv,
  probe,
  open,
  onOpenChange,
}: {
  s: SourceStatus
  cfg: SourceConfig
  keyFromEnv: boolean
  probe: { artist: string; title: string }
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [key, setKey] = useState(cfg.apiKey ?? "")
  const [secret, setSecret] = useState(cfg.apiSecret ?? "")
  const [weight, setWeight] = useState(cfg.weight)
  const [result, setResult] = useState<TestResult | null>(null)
  const save = useMutation({
    mutationFn: (patch: Partial<SourceConfig>) => api.saveSettings({ sources: { [s.id]: { ...cfg, apiKey: key, apiSecret: secret, ...patch } } }),
    onSuccess: (next) => {
      qc.setQueryData(["settings"], next)
      void qc.invalidateQueries({ queryKey: ["sources"] })
      // The server hands keys back masked; hold those so the form reads as saved.
      setKey(next.sources[s.id]?.apiKey ?? "")
      setSecret(next.sources[s.id]?.apiSecret ?? "")
    },
    onError: (e) => toast.error(e.message),
  })
  const test = useMutation({
    mutationFn: () => api.testSource(s.id, probe.artist, probe.title),
    onSuccess: setResult,
    onError: (e) => setResult({ error: e.message, ms: 0 }),
  })
  const meta = s.meta
  const needs = meta?.needs ?? []
  const { data: settingsData } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const settingsSources = settingsData?.sources
  const keysChanged = key !== (cfg.apiKey ?? "") || secret !== (cfg.apiSecret ?? "")
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="flex items-center gap-3 px-4 py-3">
        <CollapsibleTrigger className="group/trigger flex min-w-0 flex-1 items-center gap-3 text-left outline-none">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("font-medium", !cfg.enabled && "text-muted-foreground")}>{s.label}</span>
              {keyFromEnv && <Badge variant="outline">key from env</Badge>}
              {s.boost > 1 && (
                <Badge variant="outline" className="text-rasta-green font-normal" title={`Counts ×${s.boost} for your crates`}>
                  suits your crates
                </Badge>
              )}
              {s.unavailable && cfg.enabled && (
                <Badge variant="outline" className="text-rasta-gold font-normal">
                  {s.unavailable}
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground truncate text-xs group-data-[panel-open]/trigger:whitespace-normal">{meta?.about}</p>
          </div>
          <WeightMeter value={weight} dim={!cfg.enabled} />
          <Chevron />
        </CollapsibleTrigger>
        <Switch checked={cfg.enabled} onCheckedChange={(v) => save.mutate({ enabled: v })} size="sm" aria-label={`Use ${s.label}`} />
      </div>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-(--ease-out) data-ending-style:h-0 data-starting-style:h-0">
        <div className="px-4 pt-1 pb-4">
          <SettingRows>
            {needs.length > 0 && (
              <SettingRow
                stack
                title={needs.length > 1 ? "Credentials" : (meta?.keyLabel ?? "API key")}
                description={
                  meta?.signup ? (
                    <>
                      Free to get:{" "}
                      <a href={meta.signup} target="_blank" rel="noreferrer noopener" className="text-foreground underline underline-offset-2">
                        {hostOf(meta.signup)}
                      </a>
                      {keyFromEnv && " - currently read from the environment."}
                    </>
                  ) : undefined
                }
              >
                <form
                  className="flex flex-col gap-2 sm:flex-row"
                  onSubmit={(e) => {
                    e.preventDefault()
                    save.mutate({}, { onSuccess: () => toast.success(`${s.label} key saved`) })
                  }}
                >
                  <Input
                    type="password"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder={needs.length > 1 ? (meta?.keyLabel ?? "Key") : "not set"}
                    aria-label={meta?.keyLabel ?? "API key"}
                    autoComplete="off"
                  />
                  {needs.includes("apiSecret") && (
                    <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={meta?.secretLabel ?? "Secret"} aria-label={meta?.secretLabel ?? "Secret"} autoComplete="off" />
                  )}
                  <Button type="submit" variant="secondary" disabled={save.isPending || !keysChanged}>
                    Save
                  </Button>
                </form>
              </SettingRow>
            )}
            {s.id === "discogs-collection" && <CollectionSync hasToken={!!settingsSources?.discogs?.apiKey} />}
            {s.id === "acoustid" && settingsData && <AcoustIdSending settings={settingsData} />}
            <SettingRow title="Trust weight" description="How much a hit here counts towards the consensus. 1 is a solid source; above 1 is near-certain.">
              <div className="flex w-full items-center gap-3 sm:w-64">
                <Slider
                  min={0}
                  max={MAX_WEIGHT}
                  step={0.05}
                  value={[weight]}
                  onValueChange={(v) => setWeight(one(v))}
                  onValueCommitted={(v) => save.mutate({ weight: one(v) })}
                  className="flex-1"
                  aria-label={`${s.label} trust weight`}
                />
                <span className="w-10 text-right font-mono text-sm tabular-nums">{weight.toFixed(2)}</span>
              </div>
            </SettingRow>
            <SettingRow stack title="Genre weights" description="Optional: counts this much more (or less) when your crates hold that genre, e.g. Reggae: 1.3. 0.5 to 2.">
              <Input
                key={formatWeights(cfg.genreWeights)}
                defaultValue={formatWeights(cfg.genreWeights)}
                onBlur={(e) => {
                  const next = parseWeights(e.target.value)
                  // {} rather than nothing, so clearing the field clears the weights.
                  if (formatWeights(next) !== formatWeights(cfg.genreWeights)) save.mutate({ genreWeights: next ?? {} })
                }}
                placeholder="none"
                aria-label={`${s.label} genre weights`}
              />
            </SettingRow>
            <SettingRow
              title="Try it"
              description={
                <>
                  Searches for the test track, <span className="text-foreground">{[probe.artist, probe.title].filter(Boolean).join(" – ") || "nothing yet"}</span>.
                </>
              }
            >
              <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !probe.title}>
                {test.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} data-icon="inline-start" />}
                Test
              </Button>
            </SettingRow>
          </SettingRows>
          {result && <TestOutput result={result} />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Your Discogs collection: how much is synced, and a button to fetch it again. */
function CollectionSync({ hasToken }: { hasToken: boolean }) {
  const qc = useQueryClient()
  const syncing = useActiveJobs().some((j) => j.kind === "sync")
  const { data } = useQuery({ queryKey: ["discogs-collection"], queryFn: api.collection })
  const wasSyncing = useRef(false)
  useEffect(() => {
    // A sync just finished: show the new count.
    if (wasSyncing.current && !syncing) {
      void qc.invalidateQueries({ queryKey: ["discogs-collection"] })
      void qc.invalidateQueries({ queryKey: ["sources"] })
    }
    wasSyncing.current = syncing
  }, [syncing, qc])
  const sync = useMutation({ mutationFn: api.syncCollection, onSuccess: (j) => toast(j.label, { description: "A page of 100 releases a second." }), onError: (e) => toast.error(e.message) })
  return (
    <SettingRow
      title="Your collection"
      description={
        !hasToken
          ? "Save a Discogs personal access token on Discogs above first."
          : data?.count
            ? `${data.count.toLocaleString()} release${data.count === 1 ? "" : "s"} from ${data.username}'s collection, synced ${fmtAgo(data.syncedAt)}.`
            : "Not synced yet."
      }
    >
      <Button size="sm" variant="outline" onClick={() => sync.mutate()} disabled={!hasToken || syncing || sync.isPending}>
        {syncing || sync.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />}
        {data?.count ? "Sync again" : "Sync now"}
      </Button>
    </SettingRow>
  )
}

/** Sending fingerprints of verified tracks back to AcoustID, so the next person's copy is recognised. */
function AcoustIdSending({ settings }: { settings: PublicSettings }) {
  const qc = useQueryClient()
  const [key, setKey] = useState(settings.acoustid.userKey ?? "")
  const { data } = useQuery({ queryKey: ["acoustid-submissions"], queryFn: api.acoustidSubmissions })
  const save = useMutation({
    mutationFn: (patch: Partial<PublicSettings["acoustid"]>) => api.saveSettings({ acoustid: { ...settings.acoustid, userKey: key, ...patch } }),
    onSuccess: (next) => {
      qc.setQueryData(["settings"], next)
      setKey(next.acoustid.userKey ?? "")
      void qc.invalidateQueries({ queryKey: ["acoustid-submissions"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const check = useMutation({
    mutationFn: api.acoustidCheck,
    onSuccess: (r) => {
      qc.setQueryData(["acoustid-submissions"], r)
      toast(r.imported ? `${r.imported} imported since the last look` : "Nothing new imported yet")
    },
    onError: (e) => toast.error(e.message),
  })
  const sendAll = useMutation({ mutationFn: () => api.acoustidSubmit(), onSuccess: (j) => toast(j.label), onError: (e) => toast.error(e.message) })
  const c = data?.counts
  return (
    <>
      <SettingRow
        stack
        title="Your AcoustID user key"
        description={
          <>
            To send fingerprints back. Sign in at{" "}
            <a href="https://acoustid.org/" target="_blank" rel="noreferrer noopener" className="text-foreground underline underline-offset-2">
              acoustid.org
            </a>{" "}
            and copy the user API key (not the application key above).
          </>
        }
      >
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate({}, { onSuccess: () => toast.success("AcoustID user key saved") })
          }}
        >
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="not set" aria-label="AcoustID user key" autoComplete="off" />
          <Button type="submit" variant="secondary" disabled={save.isPending || key === (settings.acoustid.userKey ?? "")}>
            Save
          </Button>
        </form>
      </SettingRow>
      <SettingRow
        title="Send fingerprints after cutting"
        description="Only for tracks you approved yourself (or that two independent sources agree on), with no conflict or second opinion, once each. MusicBrainz's recording ID goes along when it knows the song."
      >
        <Switch checked={settings.acoustid.submit} onCheckedChange={(v) => save.mutate({ submit: v })} disabled={!settings.acoustid.userKey && !key} size="sm" aria-label="Send fingerprints after cutting" />
      </SettingRow>
      <SettingRow
        title="Sent so far"
        description={c ? `${c.imported} imported, ${c.pending} waiting for AcoustID${c.failed ? `, ${c.failed} failed` : ""}.` : "Nothing sent yet."}
      >
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => sendAll.mutate()} disabled={sendAll.isPending || !settings.acoustid.userKey}>
            Send what's ready
          </Button>
          <Button size="sm" variant="ghost" onClick={() => check.mutate()} disabled={check.isPending || !c?.pending}>
            {check.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />}
            Check
          </Button>
        </div>
      </SettingRow>
      {!!data?.items.some((i) => i.status === "failed") && (
        <ul className="text-muted-foreground space-y-1 pb-3 text-xs">
          {data.items
            .filter((i) => i.status === "failed")
            .slice(0, 5)
            .map((i) => (
              <li key={i.id}>
                <span className="text-rasta-red">Failed</span> {fmtAgo(i.submittedAt)}: {i.error}
              </li>
            ))}
        </ul>
      )}
    </>
  )
}

/** One custom scraper: its switch, weight and actions; editing happens in the dialog. */
function ScraperRow({
  sc,
  unavailable,
  suits,
  health,
  onToggle,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  sc: ScraperDefinition
  unavailable: string | null
  /** suits the picked genres (and counts a little more for it) */
  suits: boolean
  health: SourceStatus["health"]
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left outline-none" aria-label={`Edit ${sc.name}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("font-medium", !sc.enabled && "text-muted-foreground")}>{sc.name}</span>
          <Badge variant="outline" className="font-mono font-normal uppercase">
            {sc.kind}
          </Badge>
          {suits && (
            <Badge variant="outline" className="text-rasta-green font-normal">
              {sc.enabled ? "suits your crates" : "suggested for your crates"}
            </Badge>
          )}
          {sc.supportingOnly && (
            <Badge variant="outline" className="font-normal" title="Backs up a match but never confirms one on its own">
              supporting only
            </Badge>
          )}
          {!sc.enabled && sc.disabledReason ? (
            <Badge variant="outline" className="text-rasta-red font-normal">
              switched off by the health check
            </Badge>
          ) : unavailable ? (
            <Badge variant="outline" className="text-rasta-gold font-normal">
              {unavailable}
            </Badge>
          ) : sc.enabled && health && health.badInARow > 0 ? (
            <Badge variant="outline" className="text-rasta-gold font-normal" title={health.lastBad ?? undefined}>
              {health.badInARow} bad answer{health.badInARow === 1 ? "" : "s"} in a row
            </Badge>
          ) : (
            !sc.verified && (
              <Badge variant="outline" className="text-rasta-gold font-normal">
                unverified
              </Badge>
            )
          )}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {!sc.enabled && sc.disabledReason ? (
            <span className="text-rasta-red">{sc.disabledReason}</span>
          ) : (
            <>
              {sc.scene || sc.notes || "No notes"} · <span className="font-mono">{hostOf(sc.searchUrl)}</span>
            </>
          )}
        </p>
      </button>
      <WeightMeter value={sc.weight} dim={!sc.enabled} />
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`${sc.name} actions`} />}>
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>
            <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
            Edit & test
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDuplicate}>
            <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Switch checked={sc.enabled} onCheckedChange={onToggle} size="sm" aria-label={`Use ${sc.name}`} />
    </div>
  )
}

/** Whether sources that suit the picked genres count a little more. */
function CratesTuning({ settings }: { settings: PublicSettings }) {
  const qc = useQueryClient()
  const genres = settings.llm.genres
  const toggle = useMutation({
    mutationFn: (genreAware: boolean) => api.saveSettings({ confidence: { genreAware } }),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s)
      void qc.invalidateQueries({ queryKey: ["sources"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const listed = genres.length > 3 ? `${genres.slice(0, 3).join(", ")} and ${genres.length - 3} more` : genres.join(", ")
  return (
    <div className="bg-muted/40 space-y-2 rounded-2xl p-3">
      <label className="flex items-center justify-between gap-2 text-sm font-medium">
        <span className="flex items-center gap-2">
          <HugeiconsIcon icon={Vynil01Icon} strokeWidth={2} className="text-primary size-4" />
          Tuned to your crates
        </span>
        <Switch checked={settings.confidence.genreAware} onCheckedChange={(v) => toggle.mutate(v)} size="sm" disabled={toggle.isPending} aria-label="Tune sources to your crates" />
      </label>
      <p className="text-muted-foreground text-xs text-pretty">
        {!genres.length ? (
          <>
            Pick genres in{" "}
            <Link to="/settings#crates" className="text-foreground underline underline-offset-2">
              Your crates
            </Link>{" "}
            and sources that suit them count a little more.
          </>
        ) : settings.confidence.genreAware ? (
          `Sources that suit ${listed} count ×1.2.`
        ) : (
          "Every source counts the same, whatever's in your crates."
        )}
      </p>
    </div>
  )
}

/** The artist and title every Test button searches for. */
function TestTrack({ value, onChange }: { value: { artist: string; title: string }; onChange: (v: { artist: string; title: string }) => void }) {
  return (
    <div className="bg-muted/40 space-y-2.5 rounded-2xl p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} className="text-primary size-4" />
        Test track
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
        <Input value={value.artist} onChange={(e) => onChange({ ...value, artist: e.target.value })} placeholder="Artist" aria-label="Test artist" />
        <Input value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} placeholder="Title" aria-label="Test title" />
      </div>
      <p className="text-muted-foreground text-xs text-pretty">What each source's Test searches for. Answers are cached for a week to go easy on rate limits.</p>
    </div>
  )
}

const BLANK_SCRAPER: ScraperDefinition = {
  id: "",
  name: "New scraper",
  enabled: false,
  weight: 0.5,
  kind: "html",
  searchUrl: "https://example.com/search?q={query}",
  items: ".result",
  fields: { artist: ".artist", title: ".title", url: "a@href" },
  scene: "",
  verified: false,
}

function ScraperDialog({ value, onClose, onSave }: { value: ScraperDefinition | null; onClose: () => void; onSave: (d: ScraperDefinition) => void }) {
  const [d, setD] = useState<ScraperDefinition>(value ?? BLANK_SCRAPER)
  const [query, setQuery] = useState("Buju Banton Murderer")
  const [result, setResult] = useState<{ candidates: Candidate[]; itemCount: number; error?: string } | null>(null)
  const test = useMutation({ mutationFn: () => api.testScraper(d, query), onSuccess: setResult })
  const setField = (k: keyof ScraperDefinition["fields"], v: string) => setD({ ...d, fields: { ...d.fields, [k]: v || undefined } })
  const kinds = [
    { value: "html", label: "HTML (CSS selectors)" },
    { value: "json", label: "JSON API (dot paths)" },
  ]
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{value?.id ? "Edit scraper" : "New scraper"}</DialogTitle>
          <DialogDescription>
            Point Dubplate at any specialist site's search. Use <code>{"{query}"}</code>, <code>{"{artist}"}</code> or <code>{"{title}"}</code> in the URL. For HTML,
            fields are CSS selectors inside each result (<code>selector@attr</code> reads an attribute); for JSON they're dot paths.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel>Type</FieldLabel>
            <Select items={kinds} value={d.kind} onValueChange={(v) => setD({ ...d, kind: v as ScraperDefinition["kind"] })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kinds.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel>Search URL</FieldLabel>
            <Input value={d.searchUrl} onChange={(e) => setD({ ...d, searchUrl: e.target.value })} className="font-mono text-xs" />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel>{d.kind === "html" ? "Result selector" : "Results array path"}</FieldLabel>
            <Input value={d.items} onChange={(e) => setD({ ...d, items: e.target.value })} className="font-mono text-xs" placeholder={d.kind === "json" ? "(empty = root array)" : ".search-result"} />
          </Field>
          {(["artist", "title", "combined", "url", "year", "label", "album", "artwork"] as const).map((k) => (
            <Field key={k}>
              <FieldLabel className="capitalize">{k === "combined" ? '"Artist - Title" text' : k}</FieldLabel>
              <Input value={d.fields[k] ?? ""} onChange={(e) => setField(k, e.target.value)} className="font-mono text-xs" />
            </Field>
          ))}
          <Field>
            <FieldLabel>Scene / notes</FieldLabel>
            <Input value={d.scene} onChange={(e) => setD({ ...d, scene: e.target.value })} placeholder="e.g. 90s dancehall 7-inches" />
          </Field>
          <Field>
            <FieldLabel>
              Trust weight <span className="text-muted-foreground font-mono">{d.weight.toFixed(2)}</span>
            </FieldLabel>
            <Slider min={0} max={MAX_WEIGHT} step={0.05} value={[d.weight]} onValueChange={(v) => setD({ ...d, weight: one(v) })} aria-label="Trust weight" />
            <FieldDescription>How much a hit here counts towards consensus.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Genre weights</FieldLabel>
            <Input key={formatWeights(value?.genreWeights)} defaultValue={formatWeights(d.genreWeights)} onBlur={(e) => setD({ ...d, genreWeights: parseWeights(e.target.value) })} placeholder="e.g. Grime: 1.2, UK rap: 1.25" />
            <FieldDescription>Counts this much more when your crates hold that genre (0.5 to 2).</FieldDescription>
          </Field>
          <Field>
            <label className="flex items-center justify-between gap-2">
              <FieldLabel>Supporting only</FieldLabel>
              <Switch checked={!!d.supportingOnly} onCheckedChange={(v) => setD({ ...d, supportingOnly: v || undefined })} size="sm" aria-label="Supporting only" />
            </label>
            <FieldDescription>Backs up a match other sources found, but never confirms one alone - for event listings, forums and the like.</FieldDescription>
          </Field>
        </div>
        <div className="space-y-2 rounded-2xl border p-3">
          <div className="flex gap-2">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="test query" />
            <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
              {test.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} data-icon="inline-start" />}
              Test
            </Button>
          </div>
          {result &&
            (result.error ? (
              <div className="text-rasta-red text-xs">{result.error}</div>
            ) : (
              <>
                <div className="text-muted-foreground text-xs">{result.itemCount} results matched the selector</div>
                <CandidateList items={result.candidates} />
              </>
            ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave({ ...d, id: d.id || d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `scraper-${Date.now()}`, verified: !!result?.candidates.length || d.verified })}>
            Save scraper
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SourceList({ items, settings, probe }: { items: SourceStatus[]; settings: PublicSettings; probe: { artist: string; title: string } }) {
  const [openId, setOpenId] = useState<string | null>(null)
  return (
    <div className="divide-border/70 divide-y overflow-hidden rounded-2xl border">
      {items.map((s) => (
        <SourceRow
          key={s.id}
          s={s}
          cfg={settings.sources[s.id] ?? { enabled: false, weight: 0.5 }}
          keyFromEnv={settings.secretsFromEnv.includes(`source:${s.id}`)}
          probe={probe}
          open={openId === s.id}
          onOpenChange={(o) => setOpenId(o ? s.id : null)}
        />
      ))}
    </div>
  )
}

export default function SourcesPage() {
  const qc = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const { data: settings, error: settingsError, refetch: refetchSettings } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const { data: sources, error: sourcesError, refetch: refetchSources } = useQuery({ queryKey: ["sources"], queryFn: api.sources })
  const loadError = (!settings && settingsError) || (!sources && sourcesError)
  const [probe, setProbe] = useState({ artist: "Buju Banton", title: "Murderer" })
  const [editing, setEditing] = useState<ScraperDefinition | null>(null)

  const hash = location.hash.slice(1)
  const section: GroupId = GROUPS.find((g) => g.id === hash)?.id ?? "catalogues"
  const go = (id: string) => {
    navigate({ hash: id }, { replace: true })
    const top = document.getElementById("sources-top")
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" })
  }

  const saveScrapers = useMutation({
    mutationFn: (scrapers: ScraperDefinition[]) => api.saveSettings({ scrapers }),
    onSuccess: (next) => {
      qc.setQueryData(["settings"], next)
      void qc.invalidateQueries({ queryKey: ["sources"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const clearCache = useMutation({ mutationFn: api.clearCache, onSuccess: (r) => toast(`Cleared ${r.cleared} cached responses`) })

  const scrapers = settings?.scrapers ?? []
  const byGroup = (id: GroupId) => sources?.filter((s) => groupOf(s.id) === id) ?? []
  const navItems: SectionItem[] = GROUPS.map((g) => {
    const items = byGroup(g.id)
    const blocked = items.some((s) => s.enabled && s.unavailable)
    return {
      id: g.id,
      label: g.label,
      icon: g.icon,
      meta: sources ? `${items.filter((s) => s.enabled).length}/${items.length}` : undefined,
      attention: blocked ? "A source that's switched on can't run yet" : undefined,
    }
  })
  const group = GROUPS.find((g) => g.id === section)!
  const enabledIn = byGroup(section).filter((s) => s.enabled).length

  const deleteScraper = (sc: ScraperDefinition) => {
    const before = scrapers
    saveScrapers.mutate(
      scrapers.filter((x) => x.id !== sc.id),
      { onSuccess: () => toast(`Deleted “${sc.name}”`, { action: { label: "Undo", onClick: () => saveScrapers.mutate(before) } }) }
    )
  }

  return (
    <>
      <PageHeader
        eyebrow="The scourer"
        title="Sources"
        description="Where Dubplate looks for confirmation. Sources that agree push confidence up; trusted ones count for more."
        actions={
          <Button variant="outline" onClick={() => clearCache.mutate()} disabled={clearCache.isPending}>
            Clear response cache
          </Button>
        }
      />
      {loadError ? (
        <QueryError
          error={loadError}
          onRetry={() => {
            void refetchSettings()
            void refetchSources()
          }}
        />
      ) : (
        <div id="sources-top" className="grid scroll-mt-20 grid-cols-[minmax(0,1fr)] gap-6 pb-12 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            <SectionNav items={navItems} value={section} onChange={go} label="Source groups" />
            <TestTrack value={probe} onChange={setProbe} />
            {settings && <CratesTuning settings={settings} />}
          </div>

          <div key={section} className="animate-in fade-in slide-in-from-bottom-1 min-w-0 duration-200">
            <Card>
              <CardHeader>
                <CardTitle>{group.title}</CardTitle>
                <CardDescription>
                  {group.description}
                  {section === "scrapers" && " Presets ship switched off and unverified - test one before trusting it."}
                </CardDescription>
                <CardAction>
                  {section === "scrapers" ? (
                    <Button size="sm" onClick={() => setEditing({ ...BLANK_SCRAPER })}>
                      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
                      New scraper
                    </Button>
                  ) : (
                    sources && (
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {enabledIn} of {byGroup(section).length} on
                      </span>
                    )
                  )}
                </CardAction>
              </CardHeader>
              <CardContent>
                {!settings || !sources ? (
                  <div className="space-y-2">
                    {Array.from({ length: 4 }, (_, i) => (
                      <Skeleton key={i} className="h-14 rounded-2xl" />
                    ))}
                  </div>
                ) : section !== "scrapers" ? (
                  <SourceList key={section} items={byGroup(section)} settings={settings} probe={probe} />
                ) : scrapers.length ? (
                  <div className="divide-border/70 divide-y overflow-hidden rounded-2xl border">
                    {scrapers.map((sc) => (
                      <ScraperRow
                        key={sc.id}
                        sc={sc}
                        unavailable={sc.enabled ? (sources.find((s) => s.id === `scraper:${sc.id}`)?.unavailable ?? null) : null}
                        suits={(sources.find((s) => s.id === `scraper:${sc.id}`)?.boost ?? 1) > 1}
                        health={sources.find((s) => s.id === `scraper:${sc.id}`)?.health ?? null}
                        onToggle={(v) => saveScrapers.mutate(scrapers.map((x) => (x.id === sc.id ? { ...x, enabled: v } : x)))}
                        onEdit={() => setEditing(sc)}
                        onDuplicate={() => setEditing({ ...sc, id: "", name: `${sc.name} copy`, enabled: false })}
                        onDelete={() => deleteScraper(sc)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="text-muted-foreground rounded-2xl border border-dashed p-6 text-center text-sm">No custom scrapers yet. Add one for any site with a search page.</div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
      {editing && (
        <ScraperDialog
          key={editing.id || "new"}
          value={editing}
          onClose={() => setEditing(null)}
          onSave={(def) => {
            const exists = scrapers.some((x) => x.id === def.id)
            saveScrapers.mutate(exists ? scrapers.map((x) => (x.id === def.id ? def : x)) : [...scrapers, def], { onSuccess: () => toast.success(`Saved “${def.name}”`) })
            setEditing(null)
          }}
        />
      )}
    </>
  )
}
