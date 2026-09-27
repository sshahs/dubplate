import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, ArrowDown01Icon, RefreshIcon, TestTube01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { LlmProviderConfig } from "@shared/types"
import { FolderPicker } from "@/components/folder-picker"
import { GenrePicker } from "@/components/genre-picker"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { api, type PublicSettings } from "@/lib/api"
import { cn } from "@/lib/utils"

type StepId = "crates" | "ai" | "contact" | "library"

const needsKey = (p: LlmProviderConfig) => p.kind !== "ollama" && p.kind !== "openai-compatible"

function Step({
  n,
  title,
  summary,
  done,
  open,
  onOpen,
  children,
}: {
  n: number
  title: string
  summary?: ReactNode
  done: boolean
  open: boolean
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <li className={cn("rounded-3xl border transition-colors", open ? "bg-card shadow-sm" : "bg-card/40")}>
      <button type="button" onClick={onOpen} aria-expanded={open} className="flex w-full items-center gap-3 p-4 text-left">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold transition-colors",
            done ? "bg-rasta-green text-white" : open ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
          )}
        >
          {done ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={3} className="size-3.5" /> : n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{title}</span>
          {summary && !open && <span className="text-muted-foreground block truncate text-xs">{summary}</span>}
        </span>
        <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className={cn("text-muted-foreground size-4 shrink-0 transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && <div className="animate-in fade-in slide-in-from-top-1 space-y-4 px-4 pb-4 duration-200">{children}</div>}
    </li>
  )
}

function CratesStep({ settings, onDone }: { settings: PublicSettings; onDone: () => void }) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<string[] | null>(null)
  const save = useMutation({
    // One queue for every tap, so quick picks are saved in order and the last one wins.
    scope: { id: "crates" },
    mutationFn: (genres: string[]) => api.saveSettings({ llm: { genres } }),
    onSuccess: (next) => qc.setQueryData(["settings"], next),
    onError: (e) => toast.error(`Couldn't save your genres: ${e.message}`),
  })
  return (
    <>
      <p className="text-muted-foreground text-sm">Optional. Pick what you've got and the AI knows what to expect; skip it and Dubplate reads any genre.</p>
      <GenrePicker
        value={picked ?? settings.llm.genres}
        onChange={(genres) => {
          setPicked(genres)
          save.mutate(genres)
        }}
      />
      <div className="flex justify-end">
        <Button onClick={onDone} disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {(picked ?? settings.llm.genres).length ? "Next" : "Skip - any genre"}
        </Button>
      </div>
    </>
  )
}

function AiStep({ settings, onDone }: { settings: PublicSettings; onDone: () => void }) {
  const qc = useQueryClient()
  const offered = settings.llm.providers.filter((p) => p.enabled)
  const [id, setId] = useState(settings.llm.activeProvider)
  const [edits, setEdits] = useState<Record<string, Partial<LlmProviderConfig>>>({})
  const [result, setResult] = useState<{ id: string; ok: boolean; message: string } | null>(null)
  const [models, setModels] = useState<Record<string, string[]>>({})
  const base = offered.find((p) => p.id === id) ?? offered[0]
  const p = base ? { ...base, ...edits[base.id] } : null
  const fromEnv = !!p && settings.secretsFromEnv.includes(`llm:${p.id}`)
  const edit = (patch: Partial<LlmProviderConfig>) => p && setEdits((e) => ({ ...e, [p.id]: { ...e[p.id], ...patch } }))

  const test = useMutation({
    mutationFn: async () => {
      if (!p) throw new Error("Pick a provider")
      const providers = settings.llm.providers.map((x) => (x.id === p.id ? p : x))
      const saved = await api.saveSettings({ llm: { activeProvider: p.id, providers } })
      qc.setQueryData(["settings"], saved)
      void qc.invalidateQueries({ queryKey: ["health"] })
      return api.testLlm(p.id)
    },
    onSuccess: (r) => {
      setResult({ id: p!.id, ok: r.ok, message: r.ok ? `${r.message} · ${r.latencyMs} ms` : r.message })
      if (r.ok) setTimeout(onDone, 700)
    },
    onError: (e) => setResult({ id: p?.id ?? "", ok: false, message: e.message }),
  })
  const fetchModels = useMutation({
    mutationFn: () => api.models(p!.id),
    onSuccess: (r) => {
      if (r.error) toast.error(r.error)
      setModels((m) => ({ ...m, [p!.id]: r.models }))
    },
  })

  if (!p) return <p className="text-muted-foreground text-sm">No AI providers are switched on - turn one on in Settings → AI interpreter.</p>
  const shown = result?.id === p.id ? result : null
  return (
    <>
      <p className="text-muted-foreground text-sm">The AI reads each messy filename first. A local Ollama keeps everything on this machine; cloud models need a key.</p>
      <div role="radiogroup" aria-label="AI provider" className="grid gap-2 sm:grid-cols-2">
        {offered.map((x) => (
          <button
            key={x.id}
            type="button"
            role="radio"
            aria-checked={x.id === p.id}
            onClick={() => {
              setId(x.id)
              setResult(null)
            }}
            className={cn("rounded-2xl border p-3 text-left text-sm transition-colors", x.id === p.id ? "border-primary/50 bg-primary/5" : "hover:bg-muted/40")}
          >
            <span className="block font-medium">{x.label}</span>
            <span className="text-muted-foreground block text-xs">{x.kind === "ollama" ? "Runs on your machine, free" : needsKey(x) ? "Cloud, needs an API key" : "Any OpenAI-style server"}</span>
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(p.kind === "ollama" || p.kind === "openai-compatible") && (
          <label className="space-y-1.5 text-sm sm:col-span-2">
            <span className="font-medium">Address</span>
            <Input value={p.baseUrl} onChange={(e) => edit({ baseUrl: e.target.value })} className="font-mono text-xs" />
          </label>
        )}
        {(needsKey(p) || p.kind === "openai-compatible") && (
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">API key {fromEnv && <span className="text-muted-foreground font-normal">(from the environment)</span>}</span>
            <Input type="password" value={p.apiKey ?? ""} onChange={(e) => edit({ apiKey: e.target.value })} placeholder={p.kind === "openai-compatible" ? "if the server needs one" : "paste your key"} autoComplete="off" />
          </label>
        )}
        <label className={cn("space-y-1.5 text-sm", !(needsKey(p) || p.kind === "openai-compatible") && "sm:col-span-2")}>
          <span className="font-medium">Model</span>
          <div className="flex gap-2">
            <Input value={p.model} onChange={(e) => edit({ model: e.target.value })} list="setup-models" className="font-mono text-xs" placeholder="pick or type" />
            <Button variant="outline" size="icon" onClick={() => fetchModels.mutate()} disabled={fetchModels.isPending} aria-label="Fetch model list">
              {fetchModels.isPending ? <Spinner /> : <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />}
            </Button>
          </div>
          <datalist id="setup-models">{models[p.id]?.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
      </div>
      {shown && (
        <p className={cn("flex items-start gap-2 text-sm", shown.ok ? "text-rasta-green" : "text-rasta-red")}>
          <HugeiconsIcon icon={shown.ok ? Tick02Icon : Alert02Icon} strokeWidth={2} className="mt-0.5 size-4 shrink-0" />
          {shown.message}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Skip for now
        </Button>
        <Button onClick={() => test.mutate()} disabled={test.isPending || (needsKey(p) && !p.apiKey && !fromEnv)}>
          {test.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} data-icon="inline-start" />}
          Save & test
        </Button>
      </div>
    </>
  )
}

function ContactStep({ settings, onDone }: { settings: PublicSettings; onDone: () => void }) {
  const qc = useQueryClient()
  const [contact, setContact] = useState(settings.contact)
  const save = useMutation({
    mutationFn: () => api.saveSettings({ contact: contact.trim() }),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s)
      onDone()
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <p className="text-muted-foreground text-sm">MusicBrainz asks every app to say how to reach whoever's making the requests. It's only sent to the music databases, nowhere else.</p>
      <Input type="email" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="you@example.com" aria-label="Contact email" autoComplete="email" />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Skip
        </Button>
        <Button type="submit" disabled={save.isPending || !contact.trim()}>
          Save
        </Button>
      </div>
    </form>
  )
}

function LibraryStep() {
  const qc = useQueryClient()
  const [path, setPath] = useState("")
  const [browsing, setBrowsing] = useState(false)
  const [watch, setWatch] = useState(true)
  const add = useMutation({
    mutationFn: () => api.addLibrary(path.trim(), undefined, { process: true, watch }),
    onSuccess: (lib) => {
      toast.success(`Added ${lib.name}`, { description: "Scanning (read-only), then identifying every track…" })
      void qc.invalidateQueries({ queryKey: ["libraries"] })
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <>
      <p className="text-muted-foreground text-sm">A folder on this machine (or mounted into the container). It's scanned read-only, then every track is identified. Nothing is renamed until you approve it.</p>
      <div className="flex gap-2">
        <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/Music/Dubplates" className="font-mono" aria-label="Folder" />
        <Button variant="outline" onClick={() => setBrowsing((b) => !b)}>
          Browse
        </Button>
      </div>
      {browsing && (
        <FolderPicker
          onPick={(p) => {
            setPath(p)
            setBrowsing(false)
          }}
        />
      )}
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={watch} onCheckedChange={setWatch} size="sm" />
        Watch it for new files
      </label>
      <div className="flex justify-end">
        <Button onClick={() => add.mutate()} disabled={!path.trim() || add.isPending}>
          {add.isPending && <Spinner data-icon="inline-start" />}
          Add & start identifying
        </Button>
      </div>
    </>
  )
}

/** First run: the four things worth setting before the first scan. */
export function SetupChecklist() {
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const [open, setOpen] = useState<StepId>("crates")
  const [done, setDone] = useState<Set<StepId>>(new Set())
  const finish = (id: StepId, next: StepId) => {
    setDone((d) => new Set(d).add(id))
    setOpen(next)
  }
  if (!settings) return <Skeleton className="mt-8 h-72 w-full rounded-4xl" />
  const active = settings.llm.providers.find((p) => p.id === settings.llm.activeProvider)
  return (
    <Card className="mt-8 w-full p-2 text-left">
      <ol className="space-y-2">
        <Step
          n={1}
          title="What's in your crates?"
          summary={settings.llm.genres.length ? settings.llm.genres.join(", ") : "Any genre"}
          done={done.has("crates")}
          open={open === "crates"}
          onOpen={() => setOpen("crates")}
        >
          <CratesStep settings={settings} onDone={() => finish("crates", "ai")} />
        </Step>
        <Step n={2} title="How names get read" summary={active ? `${active.label}${active.model ? ` · ${active.model}` : ""}` : undefined} done={done.has("ai")} open={open === "ai"} onOpen={() => setOpen("ai")}>
          <AiStep settings={settings} onDone={() => finish("ai", "contact")} />
        </Step>
        <Step n={3} title="Your contact email" summary={settings.contact || "Optional"} done={done.has("contact")} open={open === "contact"} onOpen={() => setOpen("contact")}>
          <ContactStep settings={settings} onDone={() => finish("contact", "library")} />
        </Step>
        <Step n={4} title="Your first library" done={false} open={open === "library"} onOpen={() => setOpen("library")}>
          <LibraryStep />
        </Step>
      </ol>
    </Card>
  )
}
