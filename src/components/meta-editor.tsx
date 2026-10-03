import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, MagicWand01Icon } from "@hugeicons/core-free-icons"
import { useMemo } from "react"
import { checkFields } from "@shared/fields"
import type { FinalMeta } from "@shared/types"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export interface MetaDraft {
  artists: string
  featuring: string
  relation: "" | "&" | "vs" | "x"
  title: string
  version: string
  year: string
  album: string
  label: string
  riddim: string
  genre: string
}

export function toDraft(m: Partial<FinalMeta> | null | undefined): MetaDraft {
  return {
    artists: (m?.artists ?? []).join(", "),
    featuring: (m?.featuring ?? []).join(", "),
    relation: m?.relation ?? "",
    title: m?.title ?? "",
    version: m?.version ?? "",
    year: m?.year ? String(m.year) : "",
    album: m?.album ?? "",
    label: m?.label ?? "",
    riddim: m?.riddim ?? "",
    genre: m?.genre ?? "",
  }
}

const splitList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)

export function fromDraft(d: MetaDraft): FinalMeta {
  const artists = splitList(d.artists)
  return {
    artists,
    featuring: splitList(d.featuring),
    relation: d.relation || (artists.length > 1 ? "&" : undefined),
    title: d.title.trim(),
    version: d.version.trim() || undefined,
    year: d.year ? Number(d.year) : undefined,
    album: d.album.trim() || undefined,
    label: d.label.trim() || undefined,
    riddim: d.riddim.trim() || undefined,
    genre: d.genre.trim() || undefined,
  }
}

const RELATIONS = [
  { value: "", label: "Solo / auto" },
  { value: "&", label: "& (collab)" },
  { value: "vs", label: "vs (clash)" },
  { value: "x", label: "x" },
]

/** The same checks the server runs, as you type: what will be put right when it's saved, and what needs you. */
function FieldChecks({ value, onChange }: { value: MetaDraft; onChange: (d: MetaDraft) => void }) {
  const { fields, notes } = useMemo(() => checkFields(fromDraft(value)), [value])
  if (!notes.length) return null
  const look = notes.filter((n) => !n.fixed)
  const fixable = notes.filter((n) => n.fixed)
  return (
    <div role="status" className="space-y-2 rounded-2xl border p-3 text-sm">
      {look.map((n, i) => (
        <div key={`l${i}`} className="flex gap-2">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="text-rasta-gold mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{n.message}</span>
        </div>
      ))}
      {fixable.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="text-muted-foreground space-y-1">
            <div className="text-foreground text-xs font-medium">Put right when saved</div>
            {fixable.map((n, i) => (
              <div key={`f${i}`} className="text-xs">
                {n.message}
              </div>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => onChange(toDraft({ ...fields, relation: fields.artists.length > 1 ? fields.relation : undefined }))}>
            <HugeiconsIcon icon={MagicWand01Icon} strokeWidth={2} data-icon="inline-start" />
            Put right now
          </Button>
        </div>
      )}
    </div>
  )
}

export function MetaEditor({ value, onChange }: { value: MetaDraft; onChange: (d: MetaDraft) => void }) {
  const set = <K extends keyof MetaDraft>(k: K, v: MetaDraft[K]) => onChange({ ...value, [k]: v })
  return (
    <FieldGroup className="gap-4">
      <FieldChecks value={value} onChange={onChange} />
      <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
        <Field>
          <FieldLabel htmlFor="md-artists">Artists</FieldLabel>
          <Input id="md-artists" value={value.artists} onChange={(e) => set("artists", e.target.value)} placeholder="Buju Banton, Beenie Man" />
          <FieldDescription>Comma-separated main artists</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Joined by</FieldLabel>
          <Select items={RELATIONS} value={value.relation} onValueChange={(v) => set("relation", (v ?? "") as MetaDraft["relation"])}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RELATIONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="md-title">Title</FieldLabel>
        <Input id="md-title" value={value.title} onChange={(e) => set("title", e.target.value)} placeholder="Murderer" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="md-feat">Featuring</FieldLabel>
          <Input id="md-feat" value={value.featuring} onChange={(e) => set("featuring", e.target.value)} placeholder="optional" />
        </Field>
        <Field>
          <FieldLabel htmlFor="md-version">Version</FieldLabel>
          <Input id="md-version" value={value.version} onChange={(e) => set("version", e.target.value)} placeholder="Dubplate, Special, VIP…" />
        </Field>
        <Field>
          <FieldLabel htmlFor="md-riddim">Riddim</FieldLabel>
          <Input id="md-riddim" value={value.riddim} onChange={(e) => set("riddim", e.target.value)} placeholder="Stalag, Sleng Teng…" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Field>
          <FieldLabel htmlFor="md-year">Year</FieldLabel>
          <Input id="md-year" inputMode="numeric" value={value.year} onChange={(e) => set("year", e.target.value.replace(/\D/g, "").slice(0, 4))} />
        </Field>
        <Field>
          <FieldLabel htmlFor="md-album">Album</FieldLabel>
          <Input id="md-album" value={value.album} onChange={(e) => set("album", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="md-label">Label</FieldLabel>
          <Input id="md-label" value={value.label} onChange={(e) => set("label", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="md-genre">Genre</FieldLabel>
          <Input id="md-genre" value={value.genre} onChange={(e) => set("genre", e.target.value)} />
        </Field>
      </div>
    </FieldGroup>
  )
}
