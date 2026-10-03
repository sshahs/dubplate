import { useQueryClient } from "@tanstack/react-query"
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { Job, ServerEvent } from "@shared/types"
import { jobFinished } from "@/lib/notify"

type LogEvent = Extract<ServerEvent, { type: "log" }>

type LogListener = (e: LogEvent) => void

interface LiveState {
  jobs: Job[]
  /** the latest lines, without the step-by-step detail */
  logs: LogEvent[]
  connected: boolean
  /** every line as it arrives, detail included (the Console page listens) */
  onLog: (l: LogListener) => () => void
}

const LiveContext = createContext<LiveState>({ jobs: [], logs: [], connected: false, onLog: () => () => {} })

/** Streams job progress + logs from the server and keeps query caches fresh. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [jobs, setJobs] = useState<Map<string, Job>>(new Map())
  const [logs, setLogs] = useState<LogEvent[]>([])
  const [connected, setConnected] = useState(false)
  const pending = useRef({ tracks: false, stats: false })
  const logListeners = useRef(new Set<LogListener>())
  const onLog = useMemo(
    () => (l: LogListener) => {
      logListeners.current.add(l)
      return () => void logListeners.current.delete(l)
    },
    []
  )

  useEffect(() => {
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    // Coalesce cache invalidations so a busy job doesn't hammer the API.
    const flush = setInterval(() => {
      if (pending.current.tracks) {
        void qc.invalidateQueries({ queryKey: ["tracks"] })
        void qc.invalidateQueries({ queryKey: ["track"] })
      }
      if (pending.current.stats) void qc.invalidateQueries({ queryKey: ["stats"] })
      pending.current = { tracks: false, stats: false }
    }, 1200)

    let dropped = false
    const connect = () => {
      es = new EventSource("/api/events")
      es.onopen = () => {
        setConnected(true)
        // Back after an outage: anything on screen may be stale (and error screens can clear).
        if (dropped) void qc.invalidateQueries()
        dropped = false
      }
      es.onerror = () => {
        dropped = true
        setConnected(false)
        es?.close()
        retry = setTimeout(connect, 3000)
      }
      es.onmessage = (msg) => {
        let e: ServerEvent
        try {
          e = JSON.parse(msg.data)
        } catch {
          return
        }
        if (e.type === "job") {
          setJobs((prev) => new Map(prev).set(e.job.id, e.job))
          if (e.job.status === "done" || e.job.status === "failed" || e.job.status === "cancelled") {
            pending.current = { tracks: true, stats: true }
            void qc.invalidateQueries({ queryKey: ["jobs"] })
            void qc.invalidateQueries({ queryKey: ["libraries"] })
            void qc.invalidateQueries({ queryKey: ["batches"] })
            void qc.invalidateQueries({ queryKey: ["videos"] })
            if (e.job.status === "done") toast.success(e.job.label, { description: `${e.job.done} done${e.job.failed ? ` · ${e.job.failed} failed` : ""}` })
            if (e.job.status === "failed") toast.error(e.job.label, { description: e.job.message ?? "Failed" })
            // In another tab? Flag it in the title (and a system notification, if allowed).
            jobFinished(e.job)
          }
        } else if (e.type === "log") {
          for (const l of logListeners.current) l(e)
          // Step-by-step detail can come in fast: only the Console page shows it.
          if (e.level !== "debug") setLogs((prev) => (prev.some((p) => p.id === e.id && e.id > 0) ? prev : [...prev.slice(-199), e]))
        } else if (e.type === "tracks") {
          pending.current.tracks = true
          pending.current.stats = true
        } else if (e.type === "stats") {
          pending.current.stats = true
        }
      }
    }
    connect()
    return () => {
      clearInterval(flush)
      clearTimeout(retry)
      es?.close()
    }
  }, [qc])

  const value = useMemo(() => {
    const list = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return { jobs: list, logs, connected, onLog }
  }, [jobs, logs, connected, onLog])

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLive() {
  return useContext(LiveContext)
}

// eslint-disable-next-line react-refresh/only-export-components
export function useActiveJobs() {
  return useLive().jobs.filter((j) => j.status === "running" || j.status === "queued")
}
