import { cn } from "@/lib/utils"

/** A dubplate: black lacquer, tricolour label, spindle hole. */
export function DubplateMark({ className, spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 64 64" className={cn("shrink-0", spinning && "animate-spin-slow", className)} aria-hidden>
      <defs>
        <clipPath id="dp-label">
          <circle cx="32" cy="32" r="12" />
        </clipPath>
      </defs>
      <circle cx="32" cy="32" r="31" fill="oklch(0.16 0.005 50)" />
      {[27, 23.5, 20, 16.5].map((r) => (
        <circle key={r} cx="32" cy="32" r={r} fill="none" stroke="oklch(1 0 0 / 0.07)" strokeWidth="0.8" />
      ))}
      <path d="M12 20 A24 24 0 0 1 26 9" stroke="oklch(1 0 0 / 0.18)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <g clipPath="url(#dp-label)">
        <rect x="20" y="20" width="24" height="8" fill="var(--rasta-red)" />
        <rect x="20" y="28" width="24" height="8" fill="var(--rasta-gold)" />
        <rect x="20" y="36" width="24" height="8" fill="var(--rasta-green)" />
      </g>
      <circle cx="32" cy="32" r="1.8" fill="oklch(0.16 0.005 50)" />
    </svg>
  )
}

export function RastaStripe({ className }: { className?: string }) {
  return <div className={cn("rasta-stripe h-1 w-full", className)} aria-hidden />
}

/** Little animated VU meter - shown while jobs are running. */
export function VuMeter({ className, active = true }: { className?: string; active?: boolean }) {
  const bars = [
    { c: "bg-rasta-green", d: "0s" },
    { c: "bg-rasta-green", d: "0.15s" },
    { c: "bg-rasta-gold", d: "0.3s" },
    { c: "bg-rasta-gold", d: "0.05s" },
    { c: "bg-rasta-red", d: "0.22s" },
  ]
  return (
    <span className={cn("inline-flex h-4 items-end gap-[2px]", className)} aria-hidden>
      {bars.map((b, i) => (
        <span
          key={i}
          className={cn("w-[3px] origin-bottom rounded-full", b.c, active ? "animate-vu" : "opacity-40")}
          style={{ height: "100%", animationDelay: b.d, transform: active ? undefined : `scaleY(${0.3 + i * 0.12})` }}
        />
      ))}
    </span>
  )
}
