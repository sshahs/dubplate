import type { FinalMeta } from "@shared/types"
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
    genre: d.genre.trim() || undefined,
  }
}

const RELATIONS = [
  { value: "", label: "Solo / auto" },
  { value: "&", label: "& (collab)" },
  { value: "vs", label: "vs (clash)" },
  { value: "x", label: "x" },
]

export function MetaEditor({ value, onChange }: { value: MetaDraft; onChange: (d: MetaDraft) => void }) {
  const set = <K extends keyof MetaDraft>(k: K, v: MetaDraft[K]) => onChange({ ...value, [k]: v })
  return (
    <FieldGroup className="gap-4">
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="md-feat">Featuring</FieldLabel>
          <Input id="md-feat" value={value.featuring} onChange={(e) => set("featuring", e.target.value)} placeholder="optional" />
        </Field>
        <Field>
          <FieldLabel htmlFor="md-version">Version</FieldLabel>
          <Input id="md-version" value={value.version} onChange={(e) => set("version", e.target.value)} placeholder="Dubplate, Special, VIP…" />
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
