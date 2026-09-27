import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, ArrowRight02Icon, Cancel01Icon, CheckmarkCircle02Icon, CloudUploadIcon, FolderLibraryIcon, RefreshIcon } from "@hugeicons/core-free-icons"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { toast } from "sonner"
import type { Library } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { QueryError } from "@/components/query-error"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, uploadFile } from "@/lib/api"
import { fmtBytes } from "@/lib/format"
import { takeSharedFiles } from "@/lib/shared-files"
import { cn } from "@/lib/utils"

const LIBRARY_KEY = "dubplate:upload-library"
/** Two at a time: quicker than one, without starving a phone's connection. */
const AT_ONCE = 2

interface Item {
  id: number
  file: File
  /** where it goes: the library picked when it was added */
  libraryId: number
  status: "waiting" | "uploading" | "done" | "failed"
  sent: number
  savedAs?: string
  error?: string
}

function remembered(): number | null {
  try {
    return Number(localStorage.getItem(LIBRARY_KEY)) || null
  } catch {
    return null
  }
}

function remember(id: number) {
  try {
    localStorage.setItem(LIBRARY_KEY, String(id))
  } catch {
    // private mode: it just won't be remembered
  }
}

/** The library uploads go to unless you pick another: the last one used, else an inbox, else the first. */
function defaultLibrary(libs: Library[]): Library | undefined {
  const last = remembered()
  return libs.find((l) => l.id === last && l.exists) ?? libs.find((l) => l.settings.inboxFor && l.exists) ?? libs.find((l) => l.exists)
}

function whatHappens(lib: Library, libs: Library[]): string {
  const target = lib.settings.inboxFor ? libs.find((l) => l.id === lib.settings.inboxFor) : null
  const into = target ? `They're identified here, and cutting moves them into ${target.name}.` : "They're identified as soon as they land."
  const then = lib.settings.handsOff ? " Hands-off is on, so sure matches are cut without a stop in Review." : " Then they wait for you in Review."
  return into + then
}

export default function UploadPage() {
  const qc = useQueryClient()
  const { data: libs, error, refetch } = useQuery({ queryKey: ["libraries"], queryFn: api.libraries })
  const [picked, setPicked] = useState<number | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [over, setOver] = useState(false)
  const [params, setParams] = useSearchParams()
  const input = useRef<HTMLInputElement>(null)
  const queue = useRef<Item[]>([])
  const active = useRef(0)
  const nextId = useRef(1)
  const lib = libs?.find((l) => l.id === picked) ?? (libs ? defaultLibrary(libs) : undefined)

  const patch = (id: number, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)))

  const pump = useCallback(
    function pumpNext() {
      while (active.current < AT_ONCE && queue.current.length) {
        const item = queue.current.shift()!
        active.current++
        patch(item.id, { status: "uploading", sent: 0, error: undefined })
        uploadFile(item.file, item.libraryId, (sent) => patch(item.id, { sent }))
          .then((r) => {
            patch(item.id, { status: "done", sent: item.file.size, savedAs: r.name })
            void qc.invalidateQueries({ queryKey: ["libraries"] })
          })
          .catch((e: Error) => patch(item.id, { status: "failed", error: e.message }))
          .finally(() => {
            active.current--
            pumpNext()
          })
      }
    },
    [qc]
  )

  const add = useCallback(
    (files: File[], libraryId: number | undefined) => {
      if (!files.length || !libraryId) return
      const fresh = files.map((file): Item => ({ id: nextId.current++, file, libraryId, status: "waiting", sent: 0 }))
      setItems((xs) => [...xs, ...fresh])
      queue.current.push(...fresh)
      pump()
    },
    [pump]
  )

  // Shared from another app on the phone (see public/sw.js).
  const shared = params.get("shared")
  useEffect(() => {
    if (shared === null || !libs) return
    setParams({}, { replace: true })
    if (shared === "0") {
      toast.error("Nothing came through from the share", { description: "Choose the files here instead." })
      return
    }
    const target = defaultLibrary(libs)?.id
    void takeSharedFiles().then((files) => (files.length ? add(files, target) : toast("Nothing was shared")))
  }, [shared, libs, add, setParams])

  // Leaving mid-upload would cut it off.
  const busy = items.some((i) => i.status === "uploading" || i.status === "waiting")
  useEffect(() => {
    if (!busy) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [busy])

  if (error) return <QueryError error={error} onRetry={() => void refetch()} />
  const usable = libs?.filter((l) => l.exists) ?? []
  const done = items.filter((i) => i.status === "done").length
  const failed = items.filter((i) => i.status === "failed")
  const libItems = usable.map((l) => ({ value: String(l.id), label: l.settings.inboxFor ? `${l.name} (inbox)` : l.name }))

  return (
    <>
      <PageHeader eyebrow="Selector" title="Upload" description="Send tunes from your phone or this computer straight into a library, to be identified as soon as they land." />
      {libs && !usable.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No library to upload into</EmptyTitle>
            <EmptyDescription>Add a folder first - an inbox like Downloads is ideal.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button nativeButton={false} render={<Link to="/libraries" />}>
              Libraries
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="upload-library">
                  Upload into
                </label>
                <Select
                  items={libItems}
                  value={lib ? String(lib.id) : null}
                  onValueChange={(v) => {
                    setPicked(Number(v))
                    remember(Number(v))
                  }}
                >
                  <SelectTrigger id="upload-library" className="w-full sm:w-80">
                    <SelectValue placeholder="Choose a library" />
                  </SelectTrigger>
                  <SelectContent>
                    {libItems.map((l) => (
                      <SelectItem key={l.value} value={l.value}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {lib && libs && <p className="text-muted-foreground text-xs text-pretty">{whatHappens(lib, libs)}</p>}
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setOver(true)
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setOver(false)
                  add([...e.dataTransfer.files], lib?.id)
                }}
                className={cn(
                  "flex flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed px-4 py-10 text-center transition-colors",
                  over ? "border-primary bg-primary/5" : "border-border"
                )}
              >
                <div className="bg-primary/10 text-primary flex size-14 items-center justify-center rounded-full">
                  <HugeiconsIcon icon={CloudUploadIcon} strokeWidth={2} className="size-7" />
                </div>
                <div>
                  <div className="font-medium">Drop audio files here</div>
                  <div className="text-muted-foreground text-sm">or pick them - several at once is fine</div>
                </div>
                <Button size="lg" onClick={() => input.current?.click()} disabled={!lib}>
                  Choose files
                </Button>
                <input
                  ref={input}
                  type="file"
                  multiple
                  accept="audio/*,.mp3,.flac,.m4a,.aac,.ogg,.oga,.opus,.wav,.aif,.aiff,.wma,.ape,.wv,.mpc"
                  className="hidden"
                  onChange={(e) => {
                    add([...(e.target.files ?? [])], lib?.id)
                    e.target.value = ""
                  }}
                />
              </div>
            </CardContent>
          </Card>

          {items.length > 0 && (
            <Card>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-medium tabular-nums">
                    {done} of {items.length} uploaded{failed.length ? ` · ${failed.length} failed` : ""}
                  </div>
                  <div className="ml-auto flex gap-2">
                    {failed.length > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          failed.forEach((f) => patch(f.id, { status: "waiting", error: undefined }))
                          queue.current.push(...failed)
                          pump()
                        }}
                      >
                        <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />
                        Try again
                      </Button>
                    )}
                    {!busy && (
                      <Button size="sm" variant="ghost" onClick={() => setItems([])}>
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
                <ul className="divide-y">
                  {items.map((i) => {
                    const pct = i.file.size ? Math.round((i.sent / i.file.size) * 100) : 0
                    return (
                      <li key={i.id} className="flex items-center gap-3 py-2.5">
                        <HugeiconsIcon
                          icon={i.status === "done" ? CheckmarkCircle02Icon : i.status === "failed" ? Alert02Icon : CloudUploadIcon}
                          strokeWidth={2}
                          className={cn("size-4.5 shrink-0", i.status === "done" ? "text-rasta-green" : i.status === "failed" ? "text-rasta-gold" : "text-muted-foreground")}
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm" title={i.file.name}>
                              {i.savedAs ?? i.file.name}
                            </span>
                            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                              {i.status === "uploading" ? `${pct}%` : i.status === "waiting" ? "waiting" : fmtBytes(i.file.size)}
                            </span>
                          </div>
                          {i.status === "uploading" && <Progress value={pct} aria-label={`Uploading ${i.file.name}`} className="[&_[data-slot=progress-track]]:h-1.5" />}
                          {i.status === "failed" && <p className="text-rasta-gold text-xs">{i.error}</p>}
                          {i.status === "done" && i.savedAs && i.savedAs !== i.file.name && <p className="text-muted-foreground text-xs">Saved as {i.savedAs} - that name was taken.</p>}
                        </div>
                        {i.status === "waiting" && (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Don't upload ${i.file.name}`}
                            onClick={() => {
                              queue.current = queue.current.filter((q) => q.id !== i.id)
                              setItems((xs) => xs.filter((x) => x.id !== i.id))
                            }}
                          >
                            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ul>
                {done > 0 && !busy && lib && (
                  <div className="bg-muted/40 flex flex-wrap items-center gap-3 rounded-2xl p-3 text-sm">
                    <span className="min-w-0 flex-1">Identifying them now - watch the job dock.</span>
                    <Button size="sm" variant="outline" nativeButton={false} render={<Link to={`/tracks?libraryId=${lib.id}`} />}>
                      See them in Tracks
                      <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} data-icon="inline-end" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </>
  )
}
