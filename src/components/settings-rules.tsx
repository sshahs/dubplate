import { HugeiconsIcon } from "@hugeicons/react"
import { Add01Icon, Delete02Icon, FileExportIcon, FileImportIcon, RefreshIcon } from "@hugeicons/core-free-icons"
import { useQuery } from "@tanstack/react-query"
import { useId, useRef } from "react"
import { toast } from "sonner"
import { STARTER_GENRE_RULES } from "@shared/genres"
import type { GenreRule } from "@shared/types"
import { SettingRow, SettingRows } from "@/components/settings-layout"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { api, type PublicSettings } from "@/lib/api"

type Set = (fn: (d: PublicSettings) => void) => void

/** A provider and one of its models; the models it lists are offered as you type. */
function ModelPicker({ draft, providerId, model, onProvider, onModel, label }: { draft: PublicSettings; providerId: string; model: string; onProvider: (id: string) => void; onModel: (m: string) => void; label: string }) {
  const listId = useId()
  const items = draft.llm.providers.map((p) => ({ value: p.id, label: p.label }))
  const { data } = useQuery({ queryKey: ["models", providerId], queryFn: () => api.models(providerId), enabled: !!providerId, staleTime: 5 * 60_000, retry: false })
  return (
    <div className="flex w-full flex-col gap-2 sm:w-64">
      <Select items={items} value={providerId} onValueChange={(v) => onProvider(String(v))}>
        <SelectTrigger className="w-full" aria-label={`${label} provider`}>
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
      <Input list={listId} value={model} onChange={(e) => onModel(e.target.value)} placeholder="model name" aria-label={`${label} model`} className="font-mono text-xs" />
      <datalist id={listId}>
        {data?.models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  )
}

/** Settings → AI: a bigger model for the uncertain ones, and a vision model for covers in doubt. */
export function SecondOpinionCard({ draft, set }: { draft: PublicSettings; set: Set }) {
  const e = draft.llm.escalation
  const v = draft.llm.vision
  return (
    <Card>
      <CardHeader>
        <CardTitle>Second opinion</CardTitle>
        <CardDescription className="text-pretty">
          A small fast model reads everything; a bigger one looks again only where it matters. Whatever the second one reads goes to Review - it's never approved automatically. A track no source
          knows isn't sent: a bigger model can't make up for missing data.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SettingRows>
          <SettingRow title="Ask a bigger model when unsure" description="When the score falls in the range below, or the sources disagree.">
            <Switch checked={e.enabled} onCheckedChange={(on) => set((d) => void (d.llm.escalation.enabled = on))} aria-label="Ask a bigger model when unsure" />
          </SettingRow>
          {e.enabled && (
            <>
              <SettingRow title="Model" description="On a local Ollama, a 27–35B model is a good second opinion if the machine can run it.">
                <ModelPicker
                  draft={draft}
                  label="Second opinion"
                  providerId={e.providerId}
                  model={e.model}
                  onProvider={(id) => set((d) => void (d.llm.escalation.providerId = id))}
                  onModel={(m) => set((d) => void (d.llm.escalation.model = m))}
                />
              </SettingRow>
              <SettingRow title="Scores that get one" description={`From ${e.from} to ${e.to}. Below that is the cap for tracks no source knows; above it, the first reading is sure enough.`}>
                <div className="flex w-full items-center gap-3 sm:w-64">
                  <Slider
                    min={30}
                    max={99}
                    step={1}
                    value={[e.from, e.to]}
                    onValueChange={(val) => {
                      const [from, to] = Array.isArray(val) ? val : [val, val]
                      set((d) => void (d.llm.escalation = { ...d.llm.escalation, from, to }))
                    }}
                    className="flex-1"
                    aria-label="Scores that get a second opinion"
                  />
                  <span className="w-14 text-right font-mono text-sm tabular-nums">
                    {e.from}–{e.to}
                  </span>
                </div>
              </SettingRow>
            </>
          )}
          <SettingRow title="Check covers with a vision model" description="Before a cover is used for a track whose match is in doubt (a second opinion, a conflict, or a compilation kept over the artist's own release). It needs a model that can see images.">
            <Switch checked={v.enabled} onCheckedChange={(on) => set((d) => void (d.llm.vision.enabled = on))} aria-label="Check covers with a vision model" />
          </SettingRow>
          {v.enabled && (
            <SettingRow title="Vision model" description="e.g. gemma4 or qwen2.5vl on Ollama, or a cloud model that takes images.">
              <ModelPicker
                draft={draft}
                label="Vision"
                providerId={v.providerId}
                model={v.model}
                onProvider={(id) => set((d) => void (d.llm.vision.providerId = id))}
                onModel={(m) => set((d) => void (d.llm.vision.model = m))}
              />
            </SettingRow>
          )}
        </SettingRows>
      </CardContent>
    </Card>
  )
}

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)

/** Rules read from a file: a list of rules, or { rules: [...] } as exported. */
function parseRules(text: string): GenreRule[] {
  const data = JSON.parse(text) as unknown
  const raw = Array.isArray(data) ? data : (data as { rules?: unknown })?.rules
  if (!Array.isArray(raw)) throw new Error("Expected a list of rules")
  const words = (v: unknown) => (Array.isArray(v) ? v.filter((m): m is string => typeof m === "string" && !!m.trim()) : [])
  return raw.map((r, i) => {
    const o = r as Partial<GenreRule>
    if (typeof o?.genre !== "string" || !o.genre.trim()) throw new Error(`Rule ${i + 1} has no genre`)
    const titles = words(o.titles)
    const exclude = words(o.exclude)
    const regions = words(o.regions)
    return {
      genre: o.genre.trim(),
      ...(typeof o.folder === "string" && o.folder.trim() ? { folder: o.folder.trim() } : {}),
      region: typeof o.region === "string" ? o.region.trim() : "",
      match: words(o.match),
      ...(titles.length ? { titles } : {}),
      ...(exclude.length ? { exclude } : {}),
      ...(regions.length ? { regions } : {}),
    }
  })
}

/** A comma-separated list, committed when you leave the field (so typing a comma doesn't lose it). */
function WordsInput({ value, onChange, label, placeholder, upper }: { value: string[] | undefined; onChange: (v: string[] | undefined) => void; label: string; placeholder: string; upper?: boolean }) {
  const text = value?.join(", ") ?? ""
  return (
    <label className="grid gap-1">
      <span className="text-muted-foreground text-[11px]">{label}</span>
      <Input
        key={text}
        className="text-xs"
        defaultValue={text}
        onBlur={(e) => {
          const next = list(e.target.value).map((x) => (upper && x !== "?" ? x.toUpperCase() : x))
          if (next.join(", ") !== text) onChange(next.length ? next : undefined)
        }}
        placeholder={placeholder}
      />
    </label>
  )
}

function saveFile(name: string, text: string) {
  const href = URL.createObjectURL(new Blob([text], { type: "application/json" }))
  const a = document.createElement("a")
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
}

/** Settings → Genres: one genre per track from your own list, decided by region and style. */
export function CanonicalGenresCard({ draft, set }: { draft: PublicSettings; set: Set }) {
  const cg = draft.canonicalGenres
  const file = useRef<HTMLInputElement>(null)
  const setRule = (i: number, patch: Partial<GenreRule>) => set((d) => void (d.canonicalGenres.rules[i] = { ...d.canonicalGenres.rules[i], ...patch }))

  const load = async (f: File) => {
    try {
      const rules = parseRules(await f.text())
      set((d) => void (d.canonicalGenres.rules = rules))
      toast.success(`Loaded ${rules.length} rule${rules.length === 1 ? "" : "s"}`, { description: "Save to use them." })
    } catch (err) {
      toast.error(`Couldn't read ${f.name}`, { description: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Canonical genres</CardTitle>
          <CardDescription className="text-pretty">
            Every track gets exactly one genre from your list, decided by where the music's from and its style, not by whatever a source called it that day. The sources' own genres are kept for
            reference; only yours are written to the files. Use {"{genre}"} and {"{region}"} in a folder template to file by them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRows>
            <SettingRow title="Use canonical genres" description="Off: files keep their genre, or get the sources' where they have none.">
              <Switch checked={cg.enabled} onCheckedChange={(on) => set((d) => void (d.canonicalGenres.enabled = on))} aria-label="Use canonical genres" />
            </SettingRow>
            <SettingRow title="Replace genres files already have" description="Off: only files without a genre get one.">
              <Switch checked={cg.overwrite} onCheckedChange={(on) => set((d) => void (d.canonicalGenres.overwrite = on))} aria-label="Replace genres files already have" />
            </SettingRow>
          </SettingRows>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>The list</CardTitle>
          <CardDescription className="text-pretty">
            Each genre, its folder, and the source genres that mean it. Title words send a series (Daily Duppy, SBTV) or instrumentals to their folder whatever the style. “Only if the music's
            from” limits a rule to music from those places, so UK rap and US hip hop can share the word “rap”; a genre that names a place (“UK drill”) counts as from there. The most specific match
            wins; on a tie, the rule higher up.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => file.current?.click()}>
              <HugeiconsIcon icon={FileImportIcon} strokeWidth={2} data-icon="inline-start" />
              Load from a file
            </Button>
            <Button size="sm" variant="outline" onClick={() => saveFile("dubplate-genres.json", JSON.stringify({ rules: cg.rules }, null, 2))} disabled={!cg.rules.length}>
              <HugeiconsIcon icon={FileExportIcon} strokeWidth={2} data-icon="inline-start" />
              Save as a file
            </Button>
            <Button size="sm" variant="ghost" onClick={() => set((d) => void (d.canonicalGenres.rules = structuredClone(STARTER_GENRE_RULES)))}>
              <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />
              Back to the built-in list
            </Button>
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void load(f)
                e.target.value = ""
              }}
            />
          </div>

          {!cg.rules.length && <p className="text-muted-foreground text-sm">No rules yet.</p>}
          <ol className="space-y-2">
            {cg.rules.map((r, i) => (
              <li key={i} className="bg-card/60 grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-3 rounded-2xl border p-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_6rem]">
                  <label className="grid gap-1">
                    <span className="text-muted-foreground text-[11px]">Genre (the tag)</span>
                    <Input value={r.genre} onChange={(e) => setRule(i, { genre: e.target.value })} placeholder="e.g. UK Grime" />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-muted-foreground text-[11px]">Folder name, if different</span>
                    <Input value={r.folder ?? ""} onChange={(e) => setRule(i, { folder: e.target.value || undefined })} placeholder={r.genre || "same as the genre"} />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-muted-foreground text-[11px]">Folder above</span>
                    <Input value={r.region} onChange={(e) => setRule(i, { region: e.target.value })} placeholder="none" />
                  </label>
                </div>
                <Button variant="ghost" size="icon" className="mt-5" aria-label={`Remove ${r.genre || `rule ${i + 1}`}`} onClick={() => set((d) => void d.canonicalGenres.rules.splice(i, 1))}>
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                </Button>
                <div className="col-span-2 grid gap-2 sm:grid-cols-2">
                  <WordsInput label="Source genres that mean it" value={r.match} onChange={(v) => setRule(i, { match: v ?? [] })} placeholder="grime, grime revival…" />
                  <WordsInput label="Or when the title says" value={r.titles} onChange={(v) => setRule(i, { titles: v })} placeholder="e.g. daily duppy (whatever its style)" />
                  <WordsInput label="Not when the genre says" value={r.exclude} onChange={(v) => setRule(i, { exclude: v })} placeholder="e.g. rock, so garage rock isn't UK Garage" />
                  <WordsInput label="Only if the music's from" value={r.regions} onChange={(v) => setRule(i, { regions: v })} placeholder="anywhere (or UK, US, JM, ? for unknown)" upper />
                </div>
              </li>
            ))}
          </ol>
          <Button size="sm" variant="outline" onClick={() => set((d) => void d.canonicalGenres.rules.push({ genre: "", region: "", match: [] }))}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
            Add a genre
          </Button>
        </CardContent>
      </Card>
    </>
  )
}
