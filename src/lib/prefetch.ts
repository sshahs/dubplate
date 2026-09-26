import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { api } from "@/lib/api"

/** Warm the detail cache for the tracks you're likely to open next, so stepping through is instant. */
export function usePrefetchTracks(ids: (number | undefined)[]) {
  const qc = useQueryClient()
  const key = ids.join(",")
  useEffect(() => {
    for (const id of key.split(",").map(Number)) {
      if (id) void qc.prefetchQuery({ queryKey: ["track", id], queryFn: () => api.track(id), staleTime: 10_000 })
    }
  }, [qc, key])
}
