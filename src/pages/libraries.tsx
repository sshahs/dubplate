import { HugeiconsIcon } from "@hugeicons/react"
import { Add01Icon, Delete02Icon, FolderLibraryIcon, RefreshIcon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { PageHeader } from "@/components/app-shell"
import { FolderPicker } from "@/components/folder-picker"
import { LibrarySettingsDialog } from "@/components/library-settings-dialog"
import { QueryError } from "@/components/query-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import type { Library, LibrarySettings } from "@shared/types"
import { api } from "@/lib/api"
import { useActiveJobs } from "@/lib/events"
import { fmtAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

/** What a library has of its own, for badges on its card. */
function overrides(ls: LibrarySettings): string[] {
  const out: string[] = []
  if (ls.genres || ls.sceneHint) out.push("own crates")
  if (ls.template) out.push("own file names")
  if (ls.folderTemplate || ls.organiseOnCut !== undefined) out.push("own folders")
  return out
}

function AddLibraryDialog() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState("")
  const [name, setName] = useState("")
  const [browsing, setBrowsing] = useState(false)
  const add = useMutation({
    mutationFn: () => api.addLibrary(path, name || undefined),
    onSuccess: (lib) => {
      toast.success(`Added ${lib.name}`, { description: "Scanning (read-only)…" })
      void qc.invalidateQueries({ queryKey: ["libraries"] })
      setOpen(false)
      setPath("")
      setName("")
      setBrowsing(false)
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
            Add library
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a library</DialogTitle>
          <DialogDescription>A folder on this machine (or mounted into the container). It's scanned read-only - every subfolder included.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field>
            <FieldLabel htmlFor="lib-path">Folder</FieldLabel>
            <div className="flex gap-2">
              <Input id="lib-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/Music/Dubplates" className="font-mono" />
              <Button variant="outline" onClick={() => setBrowsing((b) => !b)}>
                Browse
              </Button>
            </div>
          </Field>
          {browsing && (
            <FolderPicker
              onPick={(p) => {
                setPath(p)
                setBrowsing(false)
              }}
            />
          )}
          <Field>
            <FieldLabel htmlFor="lib-name">Name (optional)</FieldLabel>
            <Input id="lib-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sound clash tapes" />
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={() => add.mutate()} disabled={!path.trim() || add.isPending}>
            Add & scan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function LibrariesPage() {
  const qc = useQueryClient()
  const { data: libraries, error, refetch } = useQuery({ queryKey: ["libraries"], queryFn: api.libraries })
  const active = useActiveJobs()
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const scan = useMutation({ mutationFn: api.scanLibrary, onSuccess: (j) => toast(j.label), onError: (e) => toast.error(e.message) })
  const watch = useMutation({
    mutationFn: ({ id, on }: { id: number; on: boolean }) => api.updateLibrary(id, { watch: on }),
    onSuccess: (lib) => {
      qc.setQueryData<Library[]>(["libraries"], (prev) => prev?.map((l) => (l.id === lib.id ? lib : l)))
      toast(lib.watch ? `Watching ${lib.name}` : `Stopped watching ${lib.name}`, {
        description: lib.watch ? (settings?.automation.autoProcess ? "New files will be scanned and identified." : "New files will be scanned.") : undefined,
      })
    },
    onError: (e) => toast.error(e.message),
  })
  const pollMinutes = settings?.automation.pollMinutes ?? 15
  const remove = useMutation({
    mutationFn: api.removeLibrary,
    onSuccess: () => {
      toast("Library removed from staging (files untouched)")
      void qc.invalidateQueries()
    },
  })

  return (
    <>
      <PageHeader
        eyebrow="Crates"
        title="Libraries"
        description="Folders Dubplate watches. Scans only ever read - they never modify, move or tag anything."
        actions={<AddLibraryDialog />}
      />
      {error && !libraries && <QueryError error={error} onRetry={() => void refetch()} />}
      {libraries?.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>Nothing inna di crates yet</EmptyTitle>
            <EmptyDescription>Add a folder of music to start building the staging database.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <AddLibraryDialog />
          </EmptyContent>
        </Empty>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {libraries?.map((lib) => {
          const scanning = active.find((j) => j.kind === "scan" && j.label.endsWith(lib.name) && j.status === "running")
          return (
            <Card key={lib.id}>
              <CardContent className="space-y-3">
                <div className="flex items-start gap-3">
                  <div className="bg-rasta-gold/15 text-rasta-gold flex size-10 shrink-0 items-center justify-center rounded-2xl">
                    <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-heading font-bold">{lib.name}</div>
                    <div className="text-muted-foreground truncate font-mono text-xs" title={lib.path}>
                      {lib.path}
                    </div>
                  </div>
                  {!lib.exists && <Badge variant="destructive">folder missing</Badge>}
                </div>
                {overrides(lib.settings).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {overrides(lib.settings).map((o) => (
                      <Badge key={o} variant="outline" className="font-normal">
                        {o}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-4 text-sm">
                  <Link to={`/tracks?libraryId=${lib.id}`} className="hover:underline">
                    <span className="font-mono font-semibold">{lib.fileCount}</span> <span className="text-muted-foreground">tracks</span>
                  </Link>
                  <span className="text-muted-foreground">scanned {fmtAgo(lib.lastScanAt)}</span>
                </div>
                <label className="bg-muted/40 flex items-center gap-3 rounded-2xl px-3 py-2">
                  <Switch checked={lib.watch} disabled={!lib.exists || watch.isPending} onCheckedChange={(on) => watch.mutate({ id: lib.id, on })} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      Watch for new files
                      {lib.watchState !== "off" && <span className={cn("size-1.5 rounded-full", lib.watchState === "watching" ? "bg-rasta-green animate-pulse" : "bg-rasta-gold")} />}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {lib.watchState === "watching"
                        ? `Picked up as they land${pollMinutes ? `, and re-checked every ${pollMinutes} min` : ""}.`
                        : lib.watchState === "polling"
                          ? `This folder doesn't report changes (network share?), so it's checked every ${pollMinutes || 15} min.`
                          : "Off - rescan by hand, or turn on the nightly scan in Settings."}
                    </span>
                  </span>
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => scan.mutate(lib.id)} disabled={!!scanning || !lib.exists}>
                    <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" className={scanning ? "animate-spin" : ""} />
                    {scanning ? `Scanning ${scanning.done}/${scanning.total || "…"}` : "Rescan"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`Remove "${lib.name}" from Dubplate? Staging data is deleted; your files are not touched.`)) remove.mutate(lib.id)
                    }}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} data-icon="inline-start" />
                    Remove
                  </Button>
                  {settings && <LibrarySettingsDialog lib={lib} settings={settings} />}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </>
  )
}
