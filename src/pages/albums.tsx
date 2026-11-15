import { HugeiconsIcon } from "@hugeicons/react"
import { Album02Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import type { AlbumSummary } from "@shared/types"
import { AlbumDialog } from "@/components/album-dialog"
import { PageHeader } from "@/components/app-shell"
import { QueryError } from "@/components/query-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"

function AlbumCard({ album, onOpen }: { album: AlbumSummary; onOpen: () => void }) {
  const ready = album.toApprove === 0
  return (
    <li className="bg-card flex gap-3 rounded-2xl border p-3">
      <div className="bg-muted size-20 shrink-0 overflow-hidden rounded-lg border">
        {album.cover ? (
          <img src={api.artUrlFor(album.cover.trackId, album.cover.which, album.cover.hash, 160)} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <HugeiconsIcon icon={Album02Icon} strokeWidth={1.5} className="text-muted-foreground size-full p-5" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="font-medium break-words">{album.title}</div>
        {album.artist && <div className="text-muted-foreground text-sm break-words">{album.artist}</div>}
        <div className="text-muted-foreground truncate text-xs" title={`${album.library}/${album.folder}`}>
          {album.library} / {album.folder || "(top of the library)"}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{album.tracks} tracks</Badge>
          {album.toApprove > 0 && <Badge variant="secondary">{album.toApprove} to approve</Badge>}
          {album.approved > 0 && <Badge variant="outline">{album.approved} approved</Badge>}
          {album.done > 0 && <Badge variant="outline">{album.done} cut</Badge>}
          {album.locked && <Badge variant="outline">kept together</Badge>}
        </div>
      </div>
      <div className="flex shrink-0 items-start">
        <Button size="sm" variant={ready ? "outline" : "default"} onClick={onOpen}>
          {!ready && <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} data-icon="inline-start" />}
          {ready ? "Open" : "Review & approve"}
        </Button>
      </div>
    </li>
  )
}

/** Albums: each record's tracks tagged together, and approved with one OK. */
export default function AlbumsPage() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["albums"], queryFn: api.albums })
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<AlbumSummary | null>(null)
  const list = (data ?? []).filter((a) => all || a.toApprove > 0)
  const waiting = (data ?? []).filter((a) => a.toApprove > 0).length

  return (
    <div className="space-y-4">
      <PageHeader
        title="Albums"
        description="The tracks of one record, tagged together: the same album, album artist, year, label and cover on every track, each with its number on the release - and approved with one OK."
        actions={
          <div className="flex gap-1">
            <Button size="sm" variant={all ? "outline" : "default"} onClick={() => setAll(false)} aria-pressed={!all}>
              To approve{data ? ` (${waiting})` : ""}
            </Button>
            <Button size="sm" variant={all ? "default" : "outline"} onClick={() => setAll(true)} aria-pressed={all}>
              All{data ? ` (${data.length})` : ""}
            </Button>
          </div>
        }
      />
      {error && <QueryError error={error} onRetry={() => void refetch()} />}
      {isLoading && <Skeleton className="h-48 w-full" />}
      {data && !list.length && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Album02Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>{data.length ? "Every album is approved" : "No albums yet"}</EmptyTitle>
            <EmptyDescription>
              {data.length
                ? "Show all to open one again."
                : "A folder shows up here when most of its tracks are on one album. For any other tracks, select them in Tracks and choose \"Tag as one album\"."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {list.length > 0 && (
        <ul className="grid gap-2 lg:grid-cols-2">
          {list.map((a) => (
            <AlbumCard key={`${a.libraryId}:${a.folder}`} album={a} onOpen={() => setOpen(a)} />
          ))}
        </ul>
      )}
      {open && (
        <AlbumDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setOpen(null)
              void refetch()
            }
          }}
          target={{ libraryId: open.libraryId, folder: open.folder }}
        />
      )}
    </div>
  )
}
