import { useState } from "react"
import { parseKey, toCamelot } from "@shared/keys"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { BulkChanges } from "@/lib/api"
import { cn } from "@/lib/utils"

const FIELDS = [
  { key: "artists", label: "Artists", placeholder: "Comma-separated, e.g. Sly & Robbie, Black Uhuru" },
  { key: "featuring", label: "Featuring", placeholder: "Comma-separated" },
  { key: "version", label: "Version", placeholder: "Dubplate, Special, VIP, Dub…" },
  { key: "album", label: "Album", placeholder: "" },
  { key: "year", label: "Year", placeholder: "e.g. 1994" },
  { key: "label", label: "Label", placeholder: "e.g. Greensleeves" },
  { key: "riddim", label: "Riddim", placeholder: "e.g. Stalag" },
  { key: "genre", label: "Genre", placeholder: "e.g. Dancehall" },
  { key: "bpm", label: "BPM", placeholder: "e.g. 140" },
  { key: "key", label: "Key", placeholder: "Am, F#, or Camelot 8A" },
] as const

type FieldKey = (typeof FIELDS)[number]["key"]

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)

/** Turn the ticked fields into the API's changes, or explain what's wrong. */
function toChanges(values: Partial<Record<FieldKey, string>>, on: Set<FieldKey>): { changes: BulkChanges; error?: string } {
  const changes: BulkChanges = {}
  for (const k of on) {
    const v = (values[k] ?? "").trim()
    if (k === "artists") {
      if (!list(v).length) return { changes, error: "Artists can't be blank - untick it to leave them alone." }
      changes.artists = list(v)
    } else if (k === "featuring") changes.featuring = list(v)
    else if (k === "year") {
      if (v && !/^(19|20)\d\d$/.test(v)) return { changes, error: "Year should look like 1994." }
      changes.year = v ? Number(v) : null
    } else if (k === "bpm") {
      const n = Number(v)
      if (v && !(n >= 30 && n <= 300)) return { changes, error: "BPM should be a number between 30 and 300." }
      changes.bpm = v ? n : null
    } else if (k === "key") {
      if (v && !parseKey(v)) return { changes, error: `"${v}" isn't a key Dubplate knows - try Am, F# or 8A.` }
      changes.key = v || null
    } else changes[k] = v || null
  }
  return { changes }
}

/** Set the same fields on every selected track. Ticked but empty clears a field. */
export function BulkEditDialog({
  open,
  onOpenChange,
  count,
  onApply,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  onApply: (changes: BulkChanges) => Promise<unknown>
}) {
  const [values, setValues] = useState<Partial<Record<FieldKey, string>>>({})
  const [on, setOn] = useState<Set<FieldKey>>(new Set())
  const [busy, setBusy] = useState(false)
  const { changes, error } = toChanges(values, on)

  const reset = () => {
    setValues({})
    setOn(new Set())
  }
  const toggle = (k: FieldKey, checked: boolean) => {
    const next = new Set(on)
    if (checked) next.add(k)
    else next.delete(k)
    setOn(next)
  }
  const apply = async () => {
    setBusy(true)
    try {
      await onApply(changes)
      reset()
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }
  const keyHint = values.key && parseKey(values.key) ? `${parseKey(values.key)} · ${toCamelot(values.key)}` : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={(o) => !o && reset()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Edit {count} track{count === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>Tick the fields to change. A ticked field left empty is cleared. Titles stay as they are.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2.5">
          {FIELDS.map((f) => {
            const checked = on.has(f.key)
            return (
              <div key={f.key} className="grid grid-cols-[auto_5.5rem_1fr] items-center gap-3">
                <Checkbox checked={checked} onCheckedChange={(c) => toggle(f.key, !!c)} aria-label={`Change ${f.label}`} />
                <label htmlFor={`bulk-${f.key}`} className={cn("text-sm transition-colors", checked ? "text-foreground font-medium" : "text-muted-foreground")}>
                  {f.label}
                </label>
                <div className="relative">
                  <Input
                    id={`bulk-${f.key}`}
                    value={values[f.key] ?? ""}
                    placeholder={checked ? (f.placeholder ? `${f.placeholder} - empty clears it` : "Empty clears it") : f.placeholder}
                    inputMode={f.key === "year" || f.key === "bpm" ? "decimal" : undefined}
                    onChange={(e) => {
                      setValues({ ...values, [f.key]: e.target.value })
                      if (!checked) toggle(f.key, true)
                    }}
                  />
                  {f.key === "key" && keyHint && <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs">{keyHint}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <p className={cn("text-sm", error ? "text-rasta-red" : "text-muted-foreground")} aria-live="polite">
          {error ?? (on.size ? "Tracks not identified yet keep their fields until they have an artist and title; BPM and key always apply." : "Nothing ticked yet.")}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={busy || !on.size || !!error}>
            {busy && <Spinner data-icon="inline-start" />}
            Apply to {count}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
