import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowLeft01Icon, Folder01Icon, FolderOpenIcon } from "@hugeicons/core-free-icons"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { api } from "@/lib/api"

/** Browse the server's folders (read-only) and pick one. */
export function FolderPicker({ onPick }: { onPick: (path: string) => void }) {
  const [path, setPath] = useState<string | undefined>()
  const { data, error, isFetching } = useQuery({ queryKey: ["browse", path], queryFn: () => api.browse(path) })
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon-sm" disabled={!data?.parent} onClick={() => data?.parent && setPath(data.parent)} aria-label="Up one folder">
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
        </Button>
        <div className="bg-muted/60 min-w-0 flex-1 truncate rounded-full px-3 py-1.5 font-mono text-xs">{data?.path ?? "…"}</div>
      </div>
      <ScrollArea className="h-64 rounded-2xl border">
        <div className="p-1">
          {error && <div className="text-rasta-red p-3 text-sm">{(error as Error).message}</div>}
          {data?.dirs.length === 0 && <div className="text-muted-foreground p-3 text-sm">No sub-folders.</div>}
          {data?.dirs.map((d) => (
            <button
              key={d.path}
              type="button"
              onClick={() => setPath(d.path)}
              className="hover:bg-muted flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm"
            >
              <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="text-rasta-gold size-4" />
              <span className="truncate">{d.name}</span>
            </button>
          ))}
        </div>
      </ScrollArea>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">{isFetching ? "Loading…" : `${data?.audioCount ?? 0} audio files directly in this folder`}</span>
        <Button size="sm" variant="secondary" disabled={!data} onClick={() => data && onPick(data.path)}>
          <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={2} data-icon="inline-start" />
          Use this folder
        </Button>
      </div>
    </div>
  )
}
