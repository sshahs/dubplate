import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, CloudOffIcon, SecurityBlockIcon } from "@hugeicons/core-free-icons"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { api, ApiError } from "@/lib/api"
import { useLive } from "@/lib/events"
import { cn } from "@/lib/utils"

/** Plain-words explanation of why a request failed, with what to do about it. */
function explainError(error: unknown): { title: string; detail: string; kind: "host" | "offline" | "other" } {
  if (error instanceof ApiError && error.hostBlocked) {
    return {
      kind: "host",
      title: "This address isn't allowed",
      detail: `Dubplate only answers to addresses it knows. Add "${location.hostname}" to DUBPLATE_ALLOWED_HOSTS on the server and restart it.`,
    }
  }
  if (error instanceof ApiError && error.offline) {
    return { kind: "offline", title: "Can't reach Dubplate", detail: "The server isn't answering. It may be restarting — this retries on its own." }
  }
  return { kind: "other", title: "That didn't load", detail: error instanceof Error ? error.message : String(error) }
}

const ICONS = { host: SecurityBlockIcon, offline: CloudOffIcon, other: Alert02Icon }

/** Stands in for a page or panel whose data failed to load. */
export function QueryError({ error, onRetry, className, compact = false }: { error: unknown; onRetry?: () => void; className?: string; compact?: boolean }) {
  const e = explainError(error)
  return (
    <Empty role="alert" className={cn("animate-in fade-in border duration-300", compact && "p-6", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className={e.kind === "other" ? "bg-rasta-red/15 text-rasta-red" : "bg-rasta-gold/15 text-rasta-gold"}>
          <HugeiconsIcon icon={ICONS[e.kind]} strokeWidth={2} />
        </EmptyMedia>
        <EmptyTitle>{e.title}</EmptyTitle>
        <EmptyDescription>{e.detail}</EmptyDescription>
      </EmptyHeader>
      {onRetry && (
        <EmptyContent>
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}

/**
 * App-wide banner for problems that break every page at once: the address
 * isn't allowed, or the server has gone away.
 */
export function ConnectionBanner() {
  const { error } = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000, retry: false })
  // The live event stream notices a dead server within seconds; give it a moment to reconnect first.
  const { connected } = useLive()
  const [lost, setLost] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setLost(!connected), connected ? 0 : 5000)
    return () => clearTimeout(t)
  }, [connected])
  const e = error ? explainError(error) : lost ? explainError(new ApiError(0, "")) : null
  if (!e || e.kind === "other") return null
  return (
    <div role="alert" className="animate-in fade-in slide-in-from-top-1 bg-rasta-gold/12 text-foreground border-rasta-gold/30 mx-3 mt-3 flex items-start gap-3 rounded-2xl border p-3 text-sm duration-300 md:mx-6">
      <HugeiconsIcon icon={ICONS[e.kind]} strokeWidth={2} className="text-rasta-gold mt-0.5 size-4 shrink-0" />
      <div>
        <div className="font-medium">{e.title}</div>
        <div className="text-muted-foreground">{e.detail}</div>
      </div>
    </div>
  )
}
