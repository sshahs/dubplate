import type { TrackStatus } from "@shared/types"
import { confidenceTone, STATUS_META, TONE_BG, TONE_SOFT, TONE_TEXT } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Red → gold → green confidence bar with the number. */
export function ConfidenceMeter({ value, className, showValue = true }: { value: number | null | undefined; className?: string; showValue?: boolean }) {
  const tone = confidenceTone(value)
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="bg-muted relative h-1.5 w-16 overflow-hidden rounded-full">
        <div className={cn("absolute inset-y-0 left-0 rounded-full transition-[width]", TONE_BG[tone])} style={{ width: `${value ?? 0}%` }} />
      </div>
      {showValue && <span className={cn("w-8 text-right font-mono text-xs tabular-nums", TONE_TEXT[tone])}>{value ?? "–"}</span>}
    </div>
  )
}

/** Big circular gauge for the detail view. */
export function ConfidenceDial({ value, size = 96 }: { value: number | null | undefined; size?: number }) {
  const tone = confidenceTone(value)
  const r = 40
  const circ = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, value ?? 0))
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="size-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeWidth="9" className="text-muted" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - v / 100)}
          className={cn("transition-[stroke-dashoffset] duration-700", tone === "red" ? "stroke-rasta-red" : tone === "gold" ? "stroke-rasta-gold" : tone === "green" ? "stroke-rasta-green" : "stroke-muted-foreground")}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn("font-heading text-2xl font-bold tabular-nums", TONE_TEXT[tone])}>{value ?? "–"}</span>
        <span className="text-muted-foreground text-[8px] tracking-[0.14em] uppercase">confidence</span>
      </div>
    </div>
  )
}

export function StatusBadge({ status, className }: { status: TrackStatus; className?: string }) {
  const meta = STATUS_META[status]
  return (
    <span title={meta.hint} className={cn("inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap", TONE_SOFT[meta.tone], className)}>
      <span className={cn("size-1.5 rounded-full", TONE_BG[meta.tone])} />
      {meta.label}
    </span>
  )
}
