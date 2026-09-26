import type { TrackStatus } from "@shared/types"

export function fmtDuration(sec: number | null | undefined) {
  if (!sec || !Number.isFinite(sec)) return "–"
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`
}

export function fmtBytes(n: number | null | undefined) {
  if (!n) return "–"
  const units = ["B", "KB", "MB", "GB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function fmtAgo(iso: string | null | undefined) {
  if (!iso) return "never"
  const t = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime()
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export const STATUS_META: Record<TrackStatus, { label: string; tone: "red" | "gold" | "green" | "muted" | "primary"; hint: string }> = {
  new: { label: "New", tone: "muted", hint: "Scanned - not yet interpreted" },
  interpreted: { label: "Interpreted", tone: "muted", hint: "AI has read the filename" },
  scoured: { label: "Scoured", tone: "muted", hint: "Sources queried, awaiting score" },
  matched: { label: "Matched", tone: "green", hint: "High-confidence consensus - ready to approve" },
  review: { label: "Review", tone: "gold", hint: "Medium confidence - needs a selector's ear" },
  conflict: { label: "Conflict", tone: "red", hint: "Sources disagree with each other" },
  unmatched: { label: "Unmatched", tone: "red", hint: "Nothing trustworthy found" },
  approved: { label: "Approved", tone: "primary", hint: "Signed off - ready to cut" },
  done: { label: "Done", tone: "green", hint: "Renamed / tagged on disk" },
  rejected: { label: "Rejected", tone: "muted", hint: "Left untouched" },
  error: { label: "Error", tone: "red", hint: "Something went wrong - see note" },
}

export function confidenceTone(c: number | null | undefined, auto = 90, review = 60): "red" | "gold" | "green" | "muted" {
  if (c === null || c === undefined) return "muted"
  if (c >= auto) return "green"
  if (c >= review) return "gold"
  return "red"
}

export const TONE_TEXT = {
  red: "text-rasta-red",
  gold: "text-rasta-gold",
  green: "text-rasta-green",
  muted: "text-muted-foreground",
  primary: "text-primary",
} as const

export const TONE_BG = {
  red: "bg-rasta-red",
  gold: "bg-rasta-gold",
  green: "bg-rasta-green",
  muted: "bg-muted-foreground/40",
  primary: "bg-primary",
} as const

export const TONE_SOFT = {
  red: "bg-rasta-red/12 text-rasta-red ring-1 ring-inset ring-rasta-red/25",
  gold: "bg-rasta-gold/15 text-rasta-gold ring-1 ring-inset ring-rasta-gold/30",
  green: "bg-rasta-green/12 text-rasta-green ring-1 ring-inset ring-rasta-green/25",
  muted: "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
  primary: "bg-primary/12 text-primary ring-1 ring-inset ring-primary/25",
} as const
