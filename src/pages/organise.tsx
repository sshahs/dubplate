import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, ArrowDown01Icon, ArrowRight02Icon, Folder01Icon, FolderLibraryIcon, FolderTreeIcon, MusicNote03Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useRef, useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { FOLDER_PRESETS, FOLDER_TOKENS, renderFolderTemplate, unknownFolderTokens, type FolderToken, type FolderValues } from "@core/folders"
import type { Library, OrganiseMove, OrganisePreview } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { BatchRow } from "@/components/batch-row"
import { QueryError } from "@/components/query-error"
import { SettingRow, SettingRows } from "@/components/settings-layout"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useDebounced } from "@/hooks/use-debounced"
import { api, type OrganiseRequest, type PublicSettings } from "@/lib/api"
import { useActiveJobs } from "@/lib/events"
import { cn } from "@/lib/utils"

/** Three very different tracks, so a template's effect shows at a glance. */
const SAMPLES: { file: string; values: FolderValues }[] = [
  {
    file: "Chronixx - Here Comes Trouble.mp3",
    values: { artist: "Chronixx", firstartist: "Chronixx", albumartist: "Chronixx", album: "Dread & Terrible", year: "2014", decade: "2010s", label: "Soul Circle", genre: "Reggae", initial: "C", bpm: "76", bpmrange: "70-79", key: "Am", camelot: "8A", format: "MP3" },
  },
  {
    file: "Skepta - Shutdown.flac",
    values: { artist: "Skepta", firstartist: "Skepta", albumartist: "Skepta", album: "Konnichiwa", year: "2016", decade: "2010s", label: "Boy Better Know", genre: "Grime", initial: "S", bpm: "140", bpmrange: "140-149", key: "Gm", camelot: "6A", format: "FLAC" },
  },
  {
    file: "Buju Banton vs Beenie Man - Live Clash (Dubplate).mp3",
    values: { artist: "Buju Banton vs Beenie Man", firstartist: "Buju Banton", albumartist: "Buju Banton vs Beenie Man", year: "1993", decade: "1990s", genre: "Dancehall", version: "Dubplate", initial: "B", format: "MP3" },
  },
]

const MISSING = [
  { value: "skip", label: "Skip that folder level" },
  { value: "unknown", label: 'Name it "Unknown …"' },
]

interface Layout {
  template: string
  onCut: boolean
  missing: "skip" | "unknown"
  tidy: boolean
  sidecars: boolean
}

function PathLine({ folder, file, className }: { folder: string; file?: string; className?: string }) {
  const levels = folder ? folder.split("/") : []
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-sm", className)}>
      {levels.length === 0 && <span className="text-muted-foreground italic">top folder</span>}
      {levels.map((l, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="text-rasta-gold size-3.5 shrink-0" />
          <span className="truncate font-medium">{l}</span>
          <span className="text-muted-foreground">/</span>
        </span>
      ))}
      {file && <span className="text-muted-foreground truncate">{file}</span>}
    </div>
  )
}

// ---------- the folder tree preview ----------

interface Node {
  name: string
  path: string
  files: number
  total: number
  samples: string[]
  children: Node[]
}

function buildTree(folders: OrganisePreview["folders"]): Node {
  const root: Node = { name: "", path: "", files: 0, total: 0, samples: [], children: [] }
  const index = new Map<string, Node>([["", root]])
  for (const f of folders) {
    let cur = root
    root.total += f.count
    let at = ""
    for (const level of f.path ? f.path.split("/") : []) {
      at = at ? `${at}/${level}` : level
      let next = index.get(at)
      if (!next) {
        next = { name: level, path: at, files: 0, total: 0, samples: [], children: [] }
        cur.children.push(next)
        index.set(at, next)
      }
      next.total += f.count
      cur = next
    }
    cur.files += f.count
    cur.samples = f.samples
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name))
    n.children.forEach(sort)
  }
  sort(root)
  return root
}

const SHOW_CHILDREN = 150

function FileRows({ node, depth }: { node: Node; depth: number }) {
  if (!node.files) return null
  const pad = { paddingLeft: depth * 16 + 30 }
  return (
    <>
      {node.samples.map((s) => (
        <li key={s} className="text-muted-foreground flex items-center gap-2 py-0.5 pr-2 text-xs" style={pad}>
          <HugeiconsIcon icon={MusicNote03Icon} strokeWidth={2} className="size-3 shrink-0 opacity-60" />
          <span className="truncate">{s}</span>
        </li>
      ))}
      {node.files > node.samples.length && (
        <li className="text-muted-foreground py-0.5 text-xs italic" style={pad}>
          + {node.files - node.samples.length} more
        </li>
      )}
    </>
  )
}

function TreeNode({ node, depth, defaultOpen }: { node: Node; depth: number; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="hover:bg-muted/60 flex w-full items-center gap-2 rounded-lg py-1 pr-2 text-left text-sm transition-colors"
        style={{ paddingLeft: depth * 16 + 6 }}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className={cn("text-muted-foreground size-3.5 shrink-0 transition-transform duration-150", !open && "-rotate-90")} />
        <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="text-rasta-gold size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{node.total}</span>
      </button>
      {open && (
        <ul>
          {node.children.slice(0, SHOW_CHILDREN).map((c) => (
            <TreeNode key={c.path} node={c} depth={depth + 1} defaultOpen={false} />
          ))}
          {node.children.length > SHOW_CHILDREN && (
            <li className="text-muted-foreground py-0.5 text-xs italic" style={{ paddingLeft: (depth + 1) * 16 + 30 }}>
              … and {node.children.length - SHOW_CHILDREN} more folders
            </li>
          )}
          <FileRows node={node} depth={depth + 1} />
        </ul>
      )}
    </li>
  )
}

function FolderTree({ folders }: { folders: OrganisePreview["folders"] }) {
  const root = useMemo(() => buildTree(folders), [folders])
  const openTop = root.children.length <= 12
  return (
    <ul className="py-1">
      {root.children.slice(0, SHOW_CHILDREN * 4).map((c) => (
        <TreeNode key={c.path} node={c} depth={0} defaultOpen={openTop} />
      ))}
      {root.files > 0 && (
        <li>
          <div className="text-muted-foreground flex items-center gap-2 px-1.5 py-1 text-sm italic">
            <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} className="size-4" />
            top folder
            <span className="ml-auto text-xs not-italic tabular-nums">{root.files}</span>
          </div>
          <ul>
            <FileRows node={root} depth={0} />
          </ul>
        </li>
      )}
    </ul>
  )
}

function MoveRows({ moves }: { moves: OrganiseMove[] }) {
  return (
    <ul className="divide-border/60 divide-y">
      {moves.map((m) => (
        <li key={m.from} className="space-y-0.5 py-2 text-xs">
          <div className="text-muted-foreground truncate font-mono" title={m.from}>
            {m.fromRel}
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} className="text-rasta-gold size-3 shrink-0" />
            <span className="truncate font-medium" title={m.to}>
              {m.toRel}
            </span>
            {m.sidecar && (
              <Badge variant="outline" className="shrink-0 font-normal">
                follows its folder
              </Badge>
            )}
          </div>
          {m.issues.map((i) => (
            <div key={i} className="text-rasta-gold flex items-center gap-1">
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3" />
              {i}
            </div>
          ))}
        </li>
      ))}
    </ul>
  )
}

// ---------- the page ----------

function savedLayout(settings: PublicSettings, lib: Library | undefined): Layout {
  return {
    template: lib?.settings.folderTemplate ?? settings.organise.template,
    onCut: lib?.settings.organiseOnCut ?? settings.organise.onCut,
    missing: settings.organise.missing,
    tidy: settings.organise.tidy,
    sidecars: settings.organise.sidecars,
  }
}

export default function OrganisePage() {
  const qc = useQueryClient()
  const { data: settings, error: settingsError, refetch } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const { data: libraries } = useQuery({ queryKey: ["libraries"], queryFn: api.libraries })
  const { data: batches } = useQuery({ queryKey: ["batches"], queryFn: api.batches })
  const [pickedLib, setPickedLib] = useState<number | null>(null)
  const lib = libraries?.find((l) => l.id === pickedLib) ?? libraries?.[0]
  const own = lib?.settings.folderTemplate !== undefined
  const scope = own && lib ? `lib:${lib.id}` : "app"
  const [edit, setEdit] = useState<{ scope: string; layout: Layout } | null>(null)
  const saved = settings ? savedLayout(settings, lib) : null
  const layout = edit?.scope === scope ? edit.layout : saved
  const dirty = !!layout && !!saved && JSON.stringify(layout) !== JSON.stringify(saved)
  const set = (patch: Partial<Layout>) => layout && setEdit({ scope, layout: { ...layout, ...patch } })
  const [include, setInclude] = useState<"cut" | "approved">("cut")
  const [rename, setRename] = useState(false)
  const [tab, setTab] = useState("folders")
  const templateRef = useRef<HTMLInputElement>(null)
  const organising = useActiveJobs().find((j) => j.kind === "organise")

  const template = useDebounced(layout?.template ?? "", 350)
  const req: OrganiseRequest | null = lib && layout ? { libraryId: lib.id, template, missing: layout.missing, sidecars: layout.sidecars, include, rename } : null
  const preview = useQuery({
    // Under "tracks" so it refreshes whenever tracks change or a job finishes.
    queryKey: ["tracks", "organise", req],
    queryFn: () => api.organisePreview(req!),
    enabled: !!req && !!template.trim(),
    placeholderData: keepPreviousData,
  })

  const save = useMutation({
    mutationFn: async (next: Layout) => {
      if (own && lib) await api.updateLibrary(lib.id, { settings: { ...lib.settings, folderTemplate: next.template, organiseOnCut: next.onCut } })
      const app = own ? { missing: next.missing, tidy: next.tidy, sidecars: next.sidecars } : next
      return api.saveSettings({ organise: app })
    },
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s)
      void qc.invalidateQueries({ queryKey: ["libraries"] })
      setEdit(null)
      toast.success(own ? `Layout saved for ${lib?.name}` : "Layout saved")
    },
    onError: (e) => toast.error(e.message),
  })
  const scopeChange = useMutation({
    mutationFn: async (toOwn: boolean) => {
      if (!lib || !layout) return
      const { folderTemplate: _t, organiseOnCut: _c, ...rest } = lib.settings
      await api.updateLibrary(lib.id, { settings: toOwn ? { ...rest, folderTemplate: layout.template, organiseOnCut: layout.onCut } : rest })
    },
    onSuccess: (_, toOwn) => {
      void qc.invalidateQueries({ queryKey: ["libraries"] })
      setEdit(null)
      toast(toOwn ? `${lib?.name} now has its own layout` : `${lib?.name} follows the app's layout again`)
    },
    onError: (e) => toast.error(e.message),
  })
  const run = useMutation({
    mutationFn: () => api.organise(req!),
    onSuccess: (j) => toast(j.label, { description: "Moving files - you can rewind the whole thing below." }),
    onError: (e) => toast.error(e.message),
  })

  const insertToken = (token: string) => {
    if (!layout) return
    const el = templateRef.current
    const at = el?.selectionStart ?? layout.template.length
    const end = el?.selectionEnd ?? at
    const next = layout.template.slice(0, at) + token + layout.template.slice(end)
    set({ template: next })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + token.length, at + token.length)
    })
  }

  const header = (
    <PageHeader
      eyebrow="Shelve the crates"
      title="Organise"
      description="Put identified tracks into a tidy folder layout inside each library. Nothing moves until you say so, and every move can be rewound."
    />
  )
  if (settingsError && !settings) {
    return (
      <>
        {header}
        <QueryError error={settingsError} onRetry={() => void refetch()} />
      </>
    )
  }
  if (!settings || !libraries || !layout) {
    return (
      <>
        {header}
        <div className="space-y-4">
          <Skeleton className="h-96 rounded-4xl" />
          <Skeleton className="h-64 rounded-4xl" />
        </div>
      </>
    )
  }
  if (!lib) {
    return (
      <>
        {header}
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={FolderTreeIcon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No libraries yet</EmptyTitle>
            <EmptyDescription>Add a folder of music first; once tracks are identified and cut, they can be organised here.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button nativeButton={false} render={<Link to="/libraries" />}>
              Go to Libraries
            </Button>
          </EmptyContent>
        </Empty>
      </>
    )
  }

  const p = preview.data
  const examples = SAMPLES.map((s) => ({ ...s, folder: renderFolderTemplate(layout.template, s.values, { missing: layout.missing }) }))
  const flat = examples.every((e) => !e.folder)
  const unknown = unknownFolderTokens(layout.template)
  const history = (batches ?? []).filter((b) => b.label === "Organise").slice(0, 5)
  const readOnly = settings.safety.readOnly

  return (
    <>
      {header}
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Folder layout</CardTitle>
            <CardDescription>
              {own ? (
                <>
                  {lib.name} has its own layout.{" "}
                  <button type="button" className="underline underline-offset-2" onClick={() => scopeChange.mutate(false)} disabled={scopeChange.isPending}>
                    Use the app's layout instead
                  </button>
                </>
              ) : (
                <>
                  Used by every library{libraries.length > 1 ? " that hasn't got its own" : ""}.{" "}
                  <button type="button" className="underline underline-offset-2" onClick={() => scopeChange.mutate(true)} disabled={scopeChange.isPending}>
                    Give {lib.name} its own
                  </button>
                </>
              )}
            </CardDescription>
            {libraries.length > 1 && (
              <CardAction>
                <Select items={libraries.map((l) => ({ value: String(l.id), label: l.name }))} value={String(lib.id)} onValueChange={(v) => setPickedLib(Number(v))}>
                  <SelectTrigger className="w-44" aria-label="Library">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {libraries.map((l) => (
                      <SelectItem key={l.id} value={String(l.id)}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
              {FOLDER_PRESETS.map((preset) => {
                const active = preset.template === layout.template
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => set({ template: preset.template })}
                    className={cn(
                      "focus-visible:ring-ring/30 group relative flex min-w-0 flex-col gap-1 rounded-2xl border p-3 text-left transition-[border-color,background-color] duration-150 outline-none focus-visible:ring-3",
                      active ? "border-primary/50 bg-primary/5" : "hover:border-foreground/20 hover:bg-muted/40"
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {preset.label}
                      {active && <HugeiconsIcon icon={Tick02Icon} strokeWidth={2.5} className="text-primary size-3.5" />}
                    </span>
                    <span className="text-muted-foreground hidden text-xs sm:block">{preset.about}</span>
                    <PathLine folder={renderFolderTemplate(preset.template, SAMPLES[0].values)} className="mt-1 text-xs" />
                  </button>
                )
              })}
            </div>

            <div className="space-y-2">
              <label htmlFor="folder-template" className="text-sm font-medium">
                Template
              </label>
              <Input
                ref={templateRef}
                id="folder-template"
                value={layout.template}
                onChange={(e) => set({ template: e.target.value })}
                className="font-mono"
                placeholder="{artist}/[{year} - ]{album}"
                spellCheck={false}
                aria-invalid={unknown.length > 0 || undefined}
                aria-describedby={unknown.length ? "folder-template-unknown" : undefined}
              />
              {unknown.length > 0 && (
                <p id="folder-template-unknown" className="text-destructive flex items-center gap-1.5 text-xs">
                  <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3.5 shrink-0" />
                  {unknown.map((t) => `{${t}}`).join(", ")} {unknown.length === 1 ? "isn't a folder tag, so it's always empty." : "aren't folder tags, so they're always empty."} Pick from the tags below.
                </p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(FOLDER_TOKENS) as FolderToken[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    title={FOLDER_TOKENS[t]}
                    onClick={() => insertToken(`{${t}}`)}
                    className="bg-muted hover:bg-muted/70 rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors"
                  >
                    {`{${t}}`}
                  </button>
                ))}
              </div>
              <p className="text-muted-foreground text-xs text-pretty">
                <code className="bg-muted rounded px-1 font-mono">/</code> starts a new folder level. Anything in <code className="bg-muted rounded px-1 font-mono">[ ]</code> only
                shows when it has a value, so <code className="bg-muted rounded px-1 font-mono">{"[{year} - ]{album}"}</code> is just the album when the year's unknown, and a
                level whose tag is missing (a single with no album) isn't made at all. Files keep their names{rename ? " (or take the naming template's, below)" : ""}.
              </p>
            </div>

            <div className="bg-muted/40 space-y-2 rounded-2xl p-3">
              <div className="text-muted-foreground text-xs font-medium">How it looks</div>
              {examples.map((e) => (
                <PathLine key={e.file} folder={e.folder} file={e.file} />
              ))}
              {flat && (
                <p className="text-rasta-gold flex items-center gap-1.5 text-xs">
                  <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3.5" />
                  This puts every file at the top of the library.
                </p>
              )}
            </div>

            <SettingRows>
              <SettingRow title="When a folder level has nothing to show" description='E.g. an album folder for a single. Skipping keeps it in the level above.'>
                <Select items={MISSING} value={layout.missing} onValueChange={(v) => set({ missing: v as Layout["missing"] })}>
                  <SelectTrigger className="w-full sm:w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MISSING.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow title="Bring cover images and cue sheets along" description="When all of a folder's audio goes to the same place, its artwork, cue sheets and notes follow.">
                <Switch checked={layout.sidecars} onCheckedChange={(v) => set({ sidecars: v })} aria-label="Bring cover images and cue sheets along" />
              </SettingRow>
              <SettingRow title="Remove folders left empty" description="Only folders a move emptied; anything else in them keeps them.">
                <Switch checked={layout.tidy} onCheckedChange={(v) => set({ tidy: v })} aria-label="Remove folders left empty" />
              </SettingRow>
              <SettingRow title="Also move files into place when cutting" description="Approved tracks go straight into their folder when you rename and tag them in Cut & Tag.">
                <Switch checked={layout.onCut} onCheckedChange={(v) => set({ onCut: v })} aria-label="Also move files into place when cutting" />
              </SettingRow>
            </SettingRows>

            {dirty && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className="text-muted-foreground mr-auto text-xs">Unsaved - the preview below already uses it.</span>
                <Button variant="ghost" onClick={() => setEdit(null)}>
                  Discard
                </Button>
                <Button onClick={() => save.mutate(layout)} disabled={save.isPending || !layout.template.trim() || unknown.length > 0}>
                  {save.isPending && <Spinner data-icon="inline-start" />}
                  Save layout
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Preview {libraries.length > 1 ? `- ${lib.name}` : ""}</CardTitle>
            <CardDescription>Where every file ends up. Nothing has moved yet.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Tabs value={include} onValueChange={(v) => setInclude(v as typeof include)}>
                <TabsList>
                  <TabsTrigger value="cut">Cut tracks</TabsTrigger>
                  <TabsTrigger value="approved">Cut and approved</TabsTrigger>
                </TabsList>
              </Tabs>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={rename} onCheckedChange={setRename} size="sm" />
                Also rename to the naming template
              </label>
            </div>

            {preview.error && !p ? (
              <QueryError compact error={preview.error} onRetry={() => void preview.refetch()} />
            ) : !p ? (
              <Skeleton className="h-64 rounded-2xl" />
            ) : (
              <div className={cn("space-y-4 transition-opacity", preview.isPlaceholderData && "opacity-60")}>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">
                    {p.counts.moving} file{p.counts.moving === 1 ? "" : "s"} move
                  </Badge>
                  {p.counts.sidecars > 0 && (
                    <Badge variant="outline">{p.counts.sidecars === 1 ? "1 cover or extra file follows its folder" : `${p.counts.sidecars} covers and extra files follow their folders`}</Badge>
                  )}
                  {p.counts.unchanged > 0 && <Badge variant="outline">{p.counts.unchanged} already in place</Badge>}
                  <Badge variant="outline">
                    {p.counts.folders} folder{p.counts.folders === 1 ? "" : "s"}
                  </Badge>
                  {p.counts.blocked > 0 && (
                    <Badge variant="outline" className="text-rasta-gold">
                      {p.counts.blocked} can't move
                    </Badge>
                  )}
                  {p.counts.notReady > 0 && (
                    <Badge variant="outline" className="text-muted-foreground">
                      {p.counts.notReady} not {include === "cut" ? "cut" : "approved"} yet - they stay put
                    </Badge>
                  )}
                </div>

                <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
                  <TabsList>
                    <TabsTrigger value="folders">Folders</TabsTrigger>
                    <TabsTrigger value="moves">Moves</TabsTrigger>
                    {p.blocked.length > 0 && <TabsTrigger value="blocked">Can't move ({p.counts.blocked})</TabsTrigger>}
                  </TabsList>
                </Tabs>
                <ScrollArea className="h-[26rem] rounded-2xl border">
                  <div className="px-2">
                    {tab === "folders" &&
                      (p.folders.length ? <FolderTree folders={p.folders} /> : <p className="text-muted-foreground p-4 text-sm">No {include === "cut" ? "cut" : "approved"} tracks in this library yet.</p>)}
                    {tab === "moves" &&
                      (p.moves.length ? (
                        <>
                          <MoveRows moves={p.moves} />
                          {p.counts.moving + p.counts.sidecars > p.moves.length && (
                            <p className="text-muted-foreground py-2 text-xs">
                              Showing {p.moves.length} of {p.counts.moving + p.counts.sidecars}.
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-muted-foreground p-4 text-sm">Everything is already where this layout puts it.</p>
                      ))}
                    {tab === "blocked" && p.blocked.length > 0 && <MoveRows moves={p.blocked} />}
                  </div>
                </ScrollArea>

                <div className="flex flex-wrap items-center justify-end gap-3">
                  {readOnly && (
                    <span className="text-muted-foreground mr-auto text-sm">
                      Read-only mode is on.{" "}
                      <Link to="/execute#safety" className="underline underline-offset-2">
                        Switch it off in Cut & Tag
                      </Link>{" "}
                      to move files.
                    </span>
                  )}
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button disabled={readOnly || !p.counts.moving || !!organising || run.isPending || preview.isPlaceholderData || template !== layout.template}>
                          {organising ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={FolderTreeIcon} strokeWidth={2} data-icon="inline-start" />}
                          {organising ? `Moving ${organising.done + organising.failed}/${organising.total || "?"}` : `Organise ${p.counts.moving} file${p.counts.moving === 1 ? "" : "s"}`}
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Organise {lib.name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {p.counts.moving} file{p.counts.moving === 1 ? "" : "s"}
                          {p.counts.sidecars ? ` and ${p.counts.sidecars} cover${p.counts.sidecars === 1 ? "" : "s"} and extra files` : ""} move into {p.counts.folders} folder
                          {p.counts.folders === 1 ? "" : "s"}
                          {rename ? " and take the naming template's names" : ""}. Every move is journalled - rewind the whole thing from the history below.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Not yet</AlertDialogCancel>
                        <AlertDialogAction onClick={() => run.mutate()}>Organise</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {history.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Recent organising</CardTitle>
              <CardDescription>Rewind puts every file back in the folder it came from.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {history.map((b) => (
                <BatchRow key={b.batchId} batch={b} busy={!!organising} />
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  )
}
