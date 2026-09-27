import { HugeiconsIcon } from "@hugeicons/react"
import { Add01Icon, ArrowRight02Icon, Delete02Icon, Download04Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import type { DjFormat, PathMapping } from "@shared/types"
import { SettingRow, SettingRows } from "@/components/settings-layout"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api, type PublicSettings, type Selection } from "@/lib/api"
import { cn } from "@/lib/utils"

const DJ_FORMATS: { id: DjFormat; label: string; file: string; how: string; multi: boolean }[] = [
  {
    id: "rekordbox",
    label: "Rekordbox",
    file: "XML",
    how: "In Rekordbox: Preferences → Advanced → Database → rekordbox xml, pick this file. The playlists show under “rekordbox xml” in the tree.",
    multi: true,
  },
  { id: "traktor", label: "Traktor", file: "NML", how: "In Traktor: right-click Playlists → Import Playlist, and pick this file.", multi: true },
  {
    id: "serato",
    label: "Serato",
    file: "crate",
    how: "Put it in the _Serato_/Subcrates folder on the drive the music's on (in your Music folder for the computer's own drive), then restart Serato.",
    multi: false,
  },
  { id: "m3u", label: "M3U playlist", file: "M3U8", how: "Opens in VirtualDJ, Engine DJ, djay, Mixxx and most music players.", multi: false },
]

const DJ_LABELS = { from: "Folder Dubplate sees", to: "The same folder on the DJ computer", fromHint: "/music", toHint: "D:\\Music or /Volumes/Music" }

/** Folder-prefix rewrites, e.g. /music → D:\Music for a laptop that sees the files elsewhere. */
export function PathMapEditor({ value, onChange, labels = DJ_LABELS }: { value: PathMapping[]; onChange: (v: PathMapping[]) => void; labels?: typeof DJ_LABELS }) {
  return (
    <div className="space-y-2">
      {value.map((m, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label={labels.from}
            className="font-mono text-xs"
            placeholder={labels.fromHint}
            value={m.from}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))}
          />
          <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} className="text-muted-foreground size-4 shrink-0" />
          <Input
            aria-label={labels.to}
            className="font-mono text-xs"
            placeholder={labels.toHint}
            value={m.to}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))}
          />
          <Button variant="ghost" size="icon" aria-label="Remove this folder" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...value, { from: "", to: "" }])}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
        Add a folder
      </Button>
    </div>
  )
}

/** Settings → DJ software: where the DJ computer finds the files. */
export function DjSoftwareSettings({ draft, set }: { draft: PublicSettings; set: (fn: (d: PublicSettings) => void) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>DJ software</CardTitle>
        <CardDescription>
          Export a selection from Tracks, or a crate from Crates, as a Rekordbox, Traktor or Serato playlist or an M3U. If the DJ software runs on another computer (or Dubplate runs in Docker), say where
          it finds the same folders.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SettingRows>
          <SettingRow stack title="Same folders on the DJ computer" description="The first folder a file is in is rewritten. Leave empty when the DJ software runs here.">
            <PathMapEditor value={draft.exports.pathMap} onChange={(v) => set((d) => void (d.exports.pathMap = v))} />
          </SettingRow>
          <SettingRow htmlFor="traktor-volume" title="Traktor's name for the drive" description='The disk the music is on, as Traktor sees it on a Mac - usually "Macintosh HD". Windows paths use their drive letter.'>
            <Input id="traktor-volume" className="w-full sm:w-56" value={draft.exports.traktorVolume} onChange={(e) => set((d) => void (d.exports.traktorVolume = e.target.value))} />
          </SettingRow>
        </SettingRows>
      </CardContent>
    </Card>
  )
}

/**
 * Export tracks (a selection) or crates as a file for DJ software. Path folders
 * start from Settings and can be saved back as the default.
 */
export function DjExportDialog({
  open,
  onOpenChange,
  selection,
  crateIds,
  defaultName,
  count,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selection?: Selection
  crateIds?: number[]
  defaultName: string
  /** how many tracks, for the button */
  count?: number
}) {
  const qc = useQueryClient()
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const [picked, setFormat] = useState<DjFormat>("rekordbox")
  // Unset until edited, so each opening starts from what the page passes in.
  const [nameEdit, setName] = useState<string | null>(null)
  const [pathMap, setPathMap] = useState<PathMapping[] | null>(null)
  const [remember, setRemember] = useState(false)
  const name = nameEdit ?? defaultName
  const map = pathMap ?? settings?.exports.pathMap ?? []
  const many = (crateIds?.length ?? 0) > 1
  const format: DjFormat = many && !DJ_FORMATS.find((f) => f.id === picked)?.multi ? "rekordbox" : picked
  const chosen = DJ_FORMATS.find((f) => f.id === format)!
  const close = () => {
    onOpenChange(false)
    setName(null)
    setPathMap(null)
    setRemember(false)
  }
  const run = useMutation({
    mutationFn: async () => {
      const clean = map.filter((m) => m.from.trim())
      if (remember && settings) {
        const next = await api.saveSettings({ exports: { ...settings.exports, pathMap: clean } })
        qc.setQueryData(["settings"], next)
      }
      return api.exportDj({ format, name: name.trim() || defaultName, selection, crateIds, pathMap: clean, traktorVolume: settings?.exports.traktorVolume })
    },
    onSuccess: (file) => {
      toast.success(`Saved ${file}`, { description: chosen.how, duration: 12_000 })
      close()
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Export for DJ software</DialogTitle>
          <DialogDescription>
            {many ? `${crateIds!.length} crates, one playlist each.` : count !== undefined ? `${count} track${count === 1 ? "" : "s"} as a playlist.` : "As a playlist."} Tags and names come from
            Dubplate; BPM and key go along where the software takes them.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Software">
          {DJ_FORMATS.map((f) => {
            const disabled = many && !f.multi
            return (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={format === f.id}
                disabled={disabled}
                onClick={() => setFormat(f.id)}
                className={cn(
                  "focus-visible:ring-ring/30 rounded-2xl border p-3 text-left transition-colors outline-none focus-visible:ring-3 disabled:opacity-40",
                  format === f.id ? "border-primary/50 bg-primary/5" : "hover:border-foreground/20 hover:bg-muted/40"
                )}
              >
                <div className="text-sm font-medium">{f.label}</div>
                <div className="text-muted-foreground text-xs">{disabled ? "one crate at a time" : `${f.file} file`}</div>
              </button>
            )
          })}
        </div>
        <p className="text-muted-foreground text-xs text-pretty">{chosen.how}</p>
        {!crateIds?.length && (
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Playlist name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <div className="space-y-2">
          <div className="text-sm font-medium">Same folders on the DJ computer</div>
          <PathMapEditor value={map} onChange={setPathMap} />
          {pathMap !== null && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={remember} onCheckedChange={(v) => setRemember(!!v)} />
              Use these every time
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={Download04Icon} strokeWidth={2} data-icon="inline-start" />}
            Export {chosen.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
