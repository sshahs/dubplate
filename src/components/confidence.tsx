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

/**
 * Circular gauge for the detail view. The label sits under the ring, not inside it,
 * so it stays legible at every size and never runs into the arc.
 */
export function ConfidenceDial({ value, size = 96 }: { value: number | null | undefined; size?: number }) {
  const tone = confidenceTone(value)
  const stroke = 7
  const r = 50 - stroke / 2 - 0.5
  const circ = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, value ?? 0))
  const arc = tone === "red" ? "stroke-rasta-red" : tone === "gold" ? "stroke-rasta-gold" : tone === "green" ? "stroke-rasta-green" : "stroke-muted-foreground"
  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5" style={{ width: size }} role="img" aria-label={value === null || value === undefined ? "Not scored yet" : `Confidence ${value} out of 100`}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
          <circle cx="50" cy="50" r={r} fill="none" strokeWidth={stroke} className="stroke-muted" />
          {/* A zero-length arc would still draw its round cap as a stray dot. */}
          {v > 0 && (
            <circle
              cx="50"
              cy="50"
              r={r}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap={v >= 100 ? "butt" : "round"}
              strokeDasharray={circ}
              strokeDashoffset={circ * (1 - v / 100)}
              className={cn("transition-[stroke-dashoffset] duration-700 ease-(--ease-out)", arc)}
            />
          )}
        </svg>
        <span
          aria-hidden
          className={cn("font-heading absolute inset-0 flex items-center justify-center leading-none font-extrabold tracking-tight tabular-nums", TONE_TEXT[tone])}
          style={{ fontSize: Math.round(size * (value !== null && value !== undefined && value >= 100 ? 0.27 : 0.32)) }}
        >
          {value ?? "–"}
        </span>
      </div>
      <span aria-hidden className="text-muted-foreground text-[11px] leading-none font-medium tracking-wide">
        Confidence
      </span>
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
