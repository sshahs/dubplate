import { HugeiconsIcon } from "@hugeicons/react"
import { Settings02Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { renderFolderTemplate, unknownFolderTokens } from "@core/folders"
import { renderTemplate } from "@core/naming"
import type { Library, LibrarySettings } from "@shared/types"
import { GenrePicker } from "@/components/genre-picker"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { api, type PublicSettings } from "@/lib/api"

const SAMPLE = { artists: ["Chronixx"], featuring: ["Protoje"], title: "Here Comes Trouble", version: "Special", year: 2013, album: "Dread & Terrible", label: "Soul Circle", genre: "Reggae" }
const SAMPLE_FOLDER = { artist: "Chronixx", firstartist: "Chronixx", albumartist: "Chronixx", album: "Dread & Terrible", year: "2013", decade: "2010s", label: "Soul Circle", genre: "Reggae", version: "Special", initial: "C", format: "MP3" }

function Section({ title, own, onOwn, same, children }: { title: string; own: boolean; onOwn: (v: boolean) => void; same: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border p-4">
      <label className="flex items-center justify-between gap-4">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground flex items-center gap-2 text-sm">
          Its own
          <Switch checked={own} onCheckedChange={onOwn} size="sm" aria-label={`${title}: this library's own`} />
        </span>
      </label>
      {own ? children : <p className="text-muted-foreground text-sm">Same as the app: {same}</p>}
    </section>
  )
}

export function LibrarySettingsDialog({ lib, settings }: { lib: Library; settings: PublicSettings }) {
  const qc = useQueryClient()
  const { data: libraries } = useQuery({ queryKey: ["libraries"], queryFn: api.libraries })
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<LibrarySettings>(lib.settings)
  const save = useMutation({
    mutationFn: () => api.updateLibrary(lib.id, { settings: draft }),
    onSuccess: (next) => {
      qc.setQueryData<Library[]>(["libraries"], (prev) => prev?.map((l) => (l.id === next.id ? next : l)))
      void qc.invalidateQueries({ queryKey: ["tracks"] })
      toast.success(`Saved settings for ${next.name}`, { description: "New readings and cuts in this library use them." })
      setOpen(false)
    },
    onError: (e) => toast.error(e.message),
  })
  const set = (patch: Partial<LibrarySettings>) => setDraft((d) => ({ ...d, ...patch }))
  const drop = (...keys: (keyof LibrarySettings)[]) =>
    setDraft((d) => {
      const next = { ...d }
      for (const k of keys) delete next[k]
      return next
    })
  const appGenres = settings.llm.genres.length ? settings.llm.genres.join(", ") : "any genre"
  const naming = { ...settings.naming, template: draft.template ?? settings.naming.template }
  const folderTemplate = draft.folderTemplate ?? settings.organise.template
  const unknown = unknownFolderTokens(draft.folderTemplate ?? "")
  // An inbox feeds a library that isn't an inbox itself; a library something feeds can't be one.
  const fedBy = (libraries ?? []).filter((l) => l.id !== lib.id && l.settings.inboxFor === lib.id)
  const targets = (libraries ?? []).filter((l) => l.id !== lib.id && !l.settings.inboxFor)
  const inboxItems = [{ value: "none", label: "Keep them in this library" }, ...targets.map((l) => ({ value: String(l.id), label: `Move them into ${l.name}` }))]

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setDraft(lib.settings)
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm" variant="ghost">
            <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} data-icon="inline-start" />
            Customise
          </Button>
        }
      />
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{lib.name}</DialogTitle>
          <DialogDescription>Give this library its own crates, file names or folder layout. Anything left off follows the app's settings.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Section
            title="What's in these crates"
            own={draft.genres !== undefined || draft.sceneHint !== undefined}
            onOwn={(v) => (v ? set({ genres: settings.llm.genres, sceneHint: settings.llm.sceneHint }) : drop("genres", "sceneHint"))}
            same={appGenres}
          >
            <GenrePicker value={draft.genres ?? []} onChange={(genres) => set({ genres })} />
            <Textarea value={draft.sceneHint ?? ""} onChange={(e) => set({ sceneHint: e.target.value })} rows={2} placeholder="Anything else about this library, e.g. mostly 90s tapes" />
          </Section>
          <Section title="File names" own={draft.template !== undefined} onOwn={(v) => (v ? set({ template: settings.naming.template }) : drop("template"))} same={<code className="font-mono text-xs">{settings.naming.template}</code>}>
            <Input value={draft.template ?? ""} onChange={(e) => set({ template: e.target.value })} className="font-mono" aria-label="Naming template" />
            <p className="text-muted-foreground text-xs">
              e.g. <span className="text-foreground">{renderTemplate(naming.template, SAMPLE, naming) || "-"}.mp3</span> ·{" "}
              <Link to="/settings#naming" className="underline underline-offset-2">
                tokens
              </Link>
            </p>
          </Section>
          <Section
            title="Folders"
            own={draft.folderTemplate !== undefined || draft.organiseOnCut !== undefined}
            onOwn={(v) => (v ? set({ folderTemplate: settings.organise.template, organiseOnCut: settings.organise.onCut }) : drop("folderTemplate", "organiseOnCut"))}
            same={
              <>
                <code className="font-mono text-xs">{settings.organise.template}</code>, {settings.organise.onCut ? "moved into place when cutting" : "organised by hand"}
              </>
            }
          >
            <Input value={draft.folderTemplate ?? ""} onChange={(e) => set({ folderTemplate: e.target.value })} className="font-mono" aria-label="Folder template" aria-invalid={unknown.length > 0 || undefined} />
            {unknown.length > 0 && (
              <p className="text-destructive text-xs">
                {unknown.map((t) => `{${t}}`).join(", ")} {unknown.length === 1 ? "isn't a folder tag, so it's always empty." : "aren't folder tags, so they're always empty."}
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              e.g. <span className="text-foreground">{renderFolderTemplate(folderTemplate, SAMPLE_FOLDER) || "top folder"}/</span> · layouts and a preview in{" "}
              <Link to="/organise" className="underline underline-offset-2">
                Organise
              </Link>
            </p>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={draft.organiseOnCut ?? settings.organise.onCut} onCheckedChange={(v) => set({ organiseOnCut: v })} size="sm" />
              Move files into place when cutting
            </label>
          </Section>
          <section className="space-y-4 rounded-2xl border p-4">
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="font-medium">Hands-off</span>
                <span className="text-muted-foreground block text-sm text-pretty">
                  Matches the sources are at least {settings.automation.handsOffMin}% sure of are approved and cut without asking. Anything less certain waits in Review, and Rewind undoes any cut.
                </span>
              </span>
              <Switch checked={!!draft.handsOff} onCheckedChange={(v) => (v ? set({ handsOff: true }) : drop("handsOff"))} aria-label="Hands-off" />
            </label>
            <div className="space-y-2">
              <div>
                <div className="font-medium">When tracks are cut</div>
                <p className="text-muted-foreground text-sm text-pretty">
                  {fedBy.length
                    ? `${fedBy.map((l) => l.name).join(" and ")} ${fedBy.length === 1 ? "feeds" : "feed"} this library, so it can't be an inbox itself.`
                    : "Make this an inbox (a Downloads folder, say): cut tracks move into another library, named and filed by that library's templates."}
                </p>
              </div>
              <Select
                items={inboxItems}
                value={draft.inboxFor ? String(draft.inboxFor) : "none"}
                disabled={fedBy.length > 0}
                onValueChange={(v) => (v === "none" ? drop("inboxFor") : set({ inboxFor: Number(v) }))}
              >
                <SelectTrigger className="w-full sm:w-80" aria-label="When tracks are cut">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {inboxItems.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || unknown.length > 0}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
