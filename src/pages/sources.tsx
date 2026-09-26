import { HugeiconsIcon } from "@hugeicons/react"
import { Add01Icon, Copy01Icon, Delete02Icon, Edit02Icon, LinkSquare02Icon, TestTube01Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import type { Candidate, ScraperDefinition, SourceConfig } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { QueryError } from "@/components/query-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { api, type SourceStatus } from "@/lib/api"
import { cn } from "@/lib/utils"

function CandidateList({ items }: { items: Candidate[] }) {
  if (!items.length) return <div className="text-muted-foreground text-xs">No results.</div>
  return (
    <div className="space-y-1">
      {items.slice(0, 8).map((c, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate">
            {c.artist || "?"} — {c.title}
            {c.year ? ` · ${c.year}` : ""}
            {c.album ? ` · ${c.album}` : ""}
          </span>
          {c.url && (
            <a href={c.url} target="_blank" rel="noreferrer noopener" className="text-muted-foreground hover:text-foreground">
              <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} className="size-3.5" />
            </a>
          )}
        </div>
      ))}
    </div>
  )
}

function SourceCard({ s, cfg, probe }: { s: SourceStatus; cfg: SourceConfig; probe: { artist: string; title: string } }) {
  const qc = useQueryClient()
  const [key, setKey] = useState(cfg.apiKey ?? "")
  const [secret, setSecret] = useState(cfg.apiSecret ?? "")
  const [result, setResult] = useState<{ candidates?: Candidate[]; error?: string; ms: number } | null>(null)
  const save = useMutation({
    mutationFn: (patch: Partial<SourceConfig>) => api.saveSettings({ sources: { [s.id]: { ...cfg, apiKey: key, apiSecret: secret, ...patch } } }),
    onSuccess: (next) => {
      qc.setQueryData(["settings"], next)
      void qc.invalidateQueries({ queryKey: ["sources"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const test = useMutation({
    mutationFn: () => api.testSource(s.id, probe.artist, probe.title),
    onSuccess: setResult,
    onError: (e) => setResult({ error: e.message, ms: 0 }),
  })
  const meta = s.meta
  return (
    <Card size="sm" className={cn(!cfg.enabled && "opacity-70")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {s.label}
          {s.unavailable && cfg.enabled && (
            <Badge variant="outline" className="text-rasta-gold font-normal">
              {s.unavailable}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{meta?.about}</CardDescription>
        <div className="col-start-2 row-span-2 row-start-1 self-start justify-self-end">
          <Switch checked={cfg.enabled} onCheckedChange={(v) => save.mutate({ enabled: v })} aria-label={`Enable ${s.label}`} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {meta?.needs.includes("apiKey") && (
          <Field>
            <FieldLabel>{meta.keyLabel ?? "API key"}</FieldLabel>
            <div className="flex gap-2">
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="not set" autoComplete="off" />
              {meta.needs.includes("apiSecret") || (
                <Button variant="secondary" onClick={() => save.mutate({})} disabled={save.isPending}>
                  Save
                </Button>
              )}
            </div>
          </Field>
        )}
        {meta?.needs.includes("apiSecret") && (
          <Field>
            <FieldLabel>{meta.secretLabel ?? "Secret"}</FieldLabel>
            <div className="flex gap-2">
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="not set" autoComplete="off" />
              <Button variant="secondary" onClick={() => save.mutate({})} disabled={save.isPending}>
                Save
              </Button>
            </div>
          </Field>
        )}
        <Field>
          <FieldLabel>
            Trust weight <span className="text-muted-foreground font-mono">{cfg.weight.toFixed(2)}</span>
          </FieldLabel>
          <Slider min={0} max={1.5} step={0.05} value={[cfg.weight]} onValueCommitted={(v) => save.mutate({ weight: Array.isArray(v) ? v[0] : v })} />
        </Field>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !probe.title}>
            {test.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} data-icon="inline-start" />}
            Test
          </Button>
          {meta?.signup && (
            <a href={meta.signup} target="_blank" rel="noreferrer noopener" className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2">
              get a key
            </a>
          )}
          {result && <span className="text-muted-foreground ml-auto text-xs">{result.ms} ms</span>}
        </div>
        {result && (result.error ? <div className="text-rasta-red text-xs">{result.error}</div> : <CandidateList items={result.candidates ?? []} />)}
      </CardContent>
    </Card>
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
            <Slider min={0} max={1.5} step={0.05} value={[d.weight]} onValueChange={(v) => setD({ ...d, weight: Array.isArray(v) ? v[0] : v })} />
            <FieldDescription>How much a hit here counts towards consensus.</FieldDescription>
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

export default function SourcesPage() {
  const qc = useQueryClient()
  const { data: settings, error: settingsError, refetch: refetchSettings } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const { data: sources, error: sourcesError, refetch: refetchSources } = useQuery({ queryKey: ["sources"], queryFn: api.sources })
  const loadError = (!settings && settingsError) || (!sources && sourcesError)
  const [probe, setProbe] = useState({ artist: "Buju Banton", title: "Murderer" })
  const [editing, setEditing] = useState<ScraperDefinition | null>(null)

  const saveScrapers = useMutation({
    mutationFn: (scrapers: ScraperDefinition[]) => api.saveSettings({ scrapers }),
    onSuccess: (next) => {
      qc.setQueryData(["settings"], next)
      void qc.invalidateQueries({ queryKey: ["sources"] })
      toast("Scrapers saved")
    },
  })
  const clearCache = useMutation({ mutationFn: api.clearCache, onSuccess: (r) => toast(`Cleared ${r.cleared} cached responses`) })

  const builtIn = sources?.filter((s) => !s.id.startsWith("scraper:")) ?? []
  const scrapers = settings?.scrapers ?? []

  return (
    <>
      <PageHeader
        eyebrow="The scourer"
        title="Sources"
        description="Where Dubplate looks for confirmation. Hits from different sources that agree push confidence up; trusted sources count for more."
        actions={
          <Button variant="outline" onClick={() => clearCache.mutate()}>
            Clear response cache
          </Button>
        }
      />
      <Card size="sm" className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3">
          <Field className="max-w-56">
            <FieldLabel>Test artist</FieldLabel>
            <Input value={probe.artist} onChange={(e) => setProbe({ ...probe, artist: e.target.value })} />
          </Field>
          <Field className="max-w-56">
            <FieldLabel>Test title</FieldLabel>
            <Input value={probe.title} onChange={(e) => setProbe({ ...probe, title: e.target.value })} />
          </Field>
          <p className="text-muted-foreground max-w-sm pb-2 text-xs">Used by each source's Test button. Responses are cached for a week to stay polite with rate limits.</p>
        </CardContent>
      </Card>

      {loadError && (
        <QueryError
          className="mb-4"
          error={loadError}
          onRetry={() => {
            void refetchSettings()
            void refetchSources()
          }}
        />
      )}
      <div className={cn("grid gap-3 md:grid-cols-2 xl:grid-cols-3", loadError && "hidden")}>
        {settings && sources
          ? builtIn.map((s) => <SourceCard key={s.id} s={s} cfg={settings.sources[s.id] ?? { enabled: false, weight: 0.5 }} probe={probe} />)
          : Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-56 rounded-4xl" />)}
      </div>

      <div className="mt-8 mb-3 flex items-end justify-between gap-2">
        <div>
          <h2 className="text-xl font-extrabold">Custom scrapers</h2>
          <p className="text-muted-foreground text-sm">Grime archives, clash databases, label shops — anything with a search page.</p>
        </div>
        <Button onClick={() => setEditing({ ...BLANK_SCRAPER })}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
          New scraper
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {scrapers.map((sc) => (
          <Card key={sc.id} size="sm" className={cn(!sc.enabled && "opacity-75")}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {sc.name}
                <Badge variant="outline">{sc.kind}</Badge>
                {!sc.verified && (
                  <Badge variant="outline" className="text-rasta-gold">
                    unverified
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>{sc.scene || sc.notes}</CardDescription>
              <div className="col-start-2 row-span-2 row-start-1 self-start justify-self-end">
                <Switch
                  checked={sc.enabled}
                  onCheckedChange={(v) => saveScrapers.mutate(scrapers.map((x) => (x.id === sc.id ? { ...x, enabled: v } : x)))}
                  aria-label={`Enable ${sc.name}`}
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-muted-foreground truncate font-mono text-[11px]">{sc.searchUrl}</div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" onClick={() => setEditing(sc)}>
                  <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} data-icon="inline-start" />
                  Edit & test
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ ...sc, id: "", name: `${sc.name} copy`, enabled: false })}>
                  <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} data-icon="inline-start" />
                  Duplicate
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (confirm(`Delete scraper "${sc.name}"?`)) saveScrapers.mutate(scrapers.filter((x) => x.id !== sc.id))
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} data-icon="inline-start" />
                  Delete
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {editing && (
        <ScraperDialog
          key={editing.id || "new"}
          value={editing}
          onClose={() => setEditing(null)}
          onSave={(def) => {
            const exists = scrapers.some((x) => x.id === def.id)
            saveScrapers.mutate(exists ? scrapers.map((x) => (x.id === def.id ? def : x)) : [...scrapers, def])
            setEditing(null)
          }}
        />
      )}
    </>
  )
}
