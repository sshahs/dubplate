import type { QueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"

let last: { undoId: string; run: () => Promise<void> } | null = null

function refresh(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["tracks"] })
  void qc.invalidateQueries({ queryKey: ["track"] })
  void qc.invalidateQueries({ queryKey: ["stats"] })
}

/**
 * A toast with an Undo button for a change the server snapshotted. `onUndone`
 * runs after the restore (e.g. to bring the track back into view).
 */
export function toastUndoable(qc: QueryClient, message: string, undoId: string | null, opts: { description?: string; onUndone?: () => void } = {}) {
  if (!undoId) {
    toast(message, { description: opts.description })
    return
  }
  const run = async () => {
    if (last?.undoId === undoId) last = null
    try {
      const r = await api.undo(undoId)
      toast(`Undone: ${message.replace(/[.!—].*$/, "").trim()}`, { description: `${r.restored} track${r.restored === 1 ? "" : "s"} put back` })
      refresh(qc)
      opts.onUndone?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  last = { undoId, run }
  toast(message, { description: opts.description, duration: 8000, action: { label: "Undo", onClick: () => void run() } })
}

/** Undo the most recent undoable change, if it's still on offer (the Z key in Review). */
export function undoLast(): boolean {
  if (!last) return false
  void last.run()
  return true
}
