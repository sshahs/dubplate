import { useQueryClient } from "@tanstack/react-query"
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { Job, ServerEvent } from "@shared/types"

type LogEvent = Extract<ServerEvent, { type: "log" }>

interface LiveState {
  jobs: Job[]
  logs: LogEvent[]
  connected: boolean
}

const LiveContext = createContext<LiveState>({ jobs: [], logs: [], connected: false })

/** Streams job progress + logs from the server and keeps query caches fresh. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [jobs, setJobs] = useState<Map<string, Job>>(new Map())
  const [logs, setLogs] = useState<LogEvent[]>([])
  const [connected, setConnected] = useState(false)
  const pending = useRef({ tracks: false, stats: false })

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

    const connect = () => {
      es = new EventSource("/api/events")
      es.onopen = () => setConnected(true)
      es.onerror = () => {
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
            if (e.job.status === "done") toast.success(e.job.label, { description: `${e.job.done} done${e.job.failed ? ` · ${e.job.failed} failed` : ""}` })
            if (e.job.status === "failed") toast.error(e.job.label, { description: e.job.message ?? "Failed" })
          }
        } else if (e.type === "log") {
          setLogs((prev) => [...prev.slice(-199), e])
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
    return { jobs: list, logs, connected }
  }, [jobs, logs, connected])

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
