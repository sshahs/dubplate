import { HugeiconsIcon } from "@hugeicons/react"
import { Copy01Icon } from "@hugeicons/core-free-icons"
import { useQuery } from "@tanstack/react-query"
import { PageHeader } from "@/components/app-shell"
import { QueryError } from "@/components/query-error"
import { ConfidenceMeter, StatusBadge } from "@/components/confidence"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { api } from "@/lib/api"
import { fmtBytes, fmtDuration } from "@/lib/format"

export default function DuplicatesPage() {
  const { data: groups, error, refetch } = useQuery({ queryKey: ["tracks", "duplicates"], queryFn: api.duplicates })
  return (
    <>
      <PageHeader
        eyebrow="Doubles"
        title="Duplicates"
        description="Identical audio (same content fingerprint) and different files that would end up with the same name. Dubplate never deletes - this is for your information."
      />
      {error && !groups && <QueryError error={error} onRetry={() => void refetch()} />}
      {groups?.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No doubles found</EmptyTitle>
            <EmptyDescription>Every file is unique, and no two proposed names collide.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <div className="space-y-3">
        {groups?.map((g) => (
          <Card key={`${g.kind}:${g.key}`} size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Badge variant={g.kind === "hash" ? "secondary" : "outline"}>{g.kind === "hash" ? "identical audio" : "same proposed name"}</Badge>
                <span className="truncate text-sm font-medium">{g.kind === "name" ? g.key : `${g.tracks.length} copies`}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {g.tracks.map((t) => (
                <div key={t.id} className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono" title={t.path}>
                    {t.relDir ? `${t.relDir}/` : ""}
                    {t.filename}
                  </span>
                  <span className="text-muted-foreground font-mono">{fmtDuration(t.duration)}</span>
                  <span className="text-muted-foreground font-mono">{t.bitrate ? `${Math.round(t.bitrate / 1000)}k` : ""}</span>
                  <span className="text-muted-foreground font-mono">{fmtBytes(t.size)}</span>
                  <ConfidenceMeter value={t.confidence} />
                  <StatusBadge status={t.status} />
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  )
}
