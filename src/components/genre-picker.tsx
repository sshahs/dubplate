import { HugeiconsIcon } from "@hugeicons/react"
import { Add01Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { GENRE_GROUPS, KNOWN_GENRES } from "@/lib/genres"
import { cn } from "@/lib/utils"

function Chip({ name, on, custom, onToggle }: { name: string; on: boolean; custom?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={custom ? undefined : on}
      aria-label={custom ? `Remove ${name}` : undefined}
      onClick={onToggle}
      className={cn(
        "focus-visible:ring-ring/30 inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-[background-color,border-color,color] duration-150 outline-none focus-visible:ring-3",
        on ? "border-primary/40 bg-primary/10 text-foreground" : "text-muted-foreground hover:border-foreground/20 hover:text-foreground"
      )}
    >
      {on && <HugeiconsIcon icon={custom ? Cancel01Icon : Tick02Icon} strokeWidth={2.5} className="text-primary size-3.5" />}
      {name}
    </button>
  )
}

/**
 * "What's in your crates": pick from common genres and kinds of recording, or add
 * your own. Nothing picked means any genre.
 */
export function GenrePicker({ value, onChange, className }: { value: string[]; onChange: (next: string[]) => void; className?: string }) {
  const [draft, setDraft] = useState("")
  const picked = new Set(value.map((v) => v.toLowerCase()))
  const custom = value.filter((v) => !KNOWN_GENRES.has(v.toLowerCase()))
  const toggle = (g: string) => onChange(picked.has(g.toLowerCase()) ? value.filter((v) => v.toLowerCase() !== g.toLowerCase()) : [...value, g])
  const add = () => {
    const name = draft.replace(/\s+/g, " ").trim()
    if (!name) return
    // Typing a suggestion ("house") picks the suggestion rather than adding a copy.
    const known = GENRE_GROUPS.flatMap((g) => g.genres).find((g) => g.toLowerCase() === name.toLowerCase())
    if (!picked.has(name.toLowerCase())) onChange([...value, known ?? name])
    setDraft("")
  }
  const rows = [...GENRE_GROUPS, ...(custom.length ? [{ label: "Added by you", genres: custom }] : [])]

  return (
    <div className={cn("space-y-4", className)}>
      <div className="space-y-3">
        {rows.map((group) => (
          <div key={group.label} role="group" aria-label={group.label} className="grid gap-2 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:items-start">
            <div className="text-muted-foreground text-xs font-medium sm:pt-2">{group.label}</div>
            <div className="flex flex-wrap gap-1.5">
              {group.genres.map((g) => (
                <Chip key={g} name={g} on={picked.has(g.toLowerCase())} custom={group.label === "Added by you"} onToggle={() => toggle(g)} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <form
          className="flex max-w-sm flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Something else?" aria-label="Add a genre" maxLength={40} />
          <Button type="submit" variant="outline" disabled={!draft.trim()}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
            Add
          </Button>
        </form>
        <p className="text-muted-foreground shrink-0 text-xs" aria-live="polite">
          {value.length ? (
            <>
              {value.length} picked ·{" "}
              <button type="button" onClick={() => onChange([])} className="hover:text-foreground underline underline-offset-2">
                clear
              </button>
            </>
          ) : (
            "Nothing picked: any genre"
          )}
        </p>
      </div>
    </div>
  )
}
