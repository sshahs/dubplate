// Tell someone who's switched tabs that a long job has finished: a system
// notification if they've allowed it, and always a marker in the tab title.
import type { Job } from "@shared/types"

const KEY = "dubplate-notify"
/** Jobs quicker than this finish while you're still looking; no need to shout. */
const MIN_MS = 5_000

let unseen = 0
let baseTitle = typeof document !== "undefined" ? document.title : "Dubplate"

export type NotifySupport = "ok" | "insecure" | "unsupported"

export function notifySupport(): NotifySupport {
  if (typeof Notification === "undefined") return "unsupported"
  // Browsers only offer notifications over HTTPS or on localhost.
  return window.isSecureContext ? "ok" : "insecure"
}

export function notifyWanted(): boolean {
  try {
    return localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

export function notifyEnabled(): boolean {
  return notifySupport() === "ok" && notifyWanted() && Notification.permission === "granted"
}

/** Ask for permission (must run from a click) and remember the choice. */
export async function enableNotify(): Promise<NotificationPermission | "insecure" | "unsupported"> {
  const support = notifySupport()
  if (support !== "ok") return support
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission
  try {
    localStorage.setItem(KEY, permission === "granted" ? "1" : "0")
  } catch {
    // no storage: works for this visit only
  }
  return permission
}

export function disableNotify() {
  try {
    localStorage.setItem(KEY, "0")
  } catch {
    // nothing to forget
  }
}

export function jobFinished(job: Job) {
  if (!document.hidden) return
  const ran = job.startedAt && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : 0
  if (ran < MIN_MS || job.status === "cancelled") return
  if (!unseen) baseTitle = document.title
  unseen++
  const ok = job.status === "done"
  document.title = `(${unseen}) ${ok ? "✓" : "✗"} ${job.label} - Dubplate`
  if (notifyEnabled()) {
    const body = ok ? `${job.done} done${job.failed ? ` · ${job.failed} failed` : ""}` : (job.message ?? "Failed")
    const n = new Notification(`${ok ? "Finished" : "Failed"}: ${job.label}`, { body, tag: job.id, icon: "/favicon.svg" })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && unseen) {
      unseen = 0
      document.title = baseTitle
    }
  })
}
