import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

/** Controls that need their own horizontal drags (sliders, text) never start a swipe. */
const NO_SWIPE = "input, textarea, select, [role=slider], [data-no-swipe], [contenteditable]"

/**
 * On touch screens: swipe the card right to approve, left to leave as-is. It
 * presses the same buttons the A and X keys do, so the result is identical.
 */
export function SwipeToDecide({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; y: number; id: number; axis: "x" | "y" | null } | null>(null)
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  // How far to drag before letting go decides: set from the card's width when a swipe starts.
  const [threshold, setThreshold] = useState(120)
  const progress = Math.min(1, Math.abs(dx) / threshold)

  const reset = () => {
    start.current = null
    setDragging(false)
    setDx(0)
  }

  const press = (action: "approve" | "reject") => {
    const button = ref.current?.querySelector<HTMLButtonElement>(`[data-review-action=${action}]`)
    if (!button || button.disabled) {
      toast(action === "approve" ? "Needs an artist and a title before it can be approved" : "Can't leave this one yet")
      return
    }
    navigator.vibrate?.(12)
    button.click()
  }

  return (
    <div className={cn("relative", className)}>
      {/* What letting go will do, revealed as the card slides. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-between rounded-4xl px-6">
        <span
          className="bg-rasta-green/15 text-rasta-green flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold"
          style={{ opacity: dx > 0 ? progress : 0, transform: `scale(${0.85 + 0.15 * (dx > 0 ? progress : 0)})` }}
        >
          <HugeiconsIcon icon={Tick02Icon} strokeWidth={2.5} className="size-4" />
          Approve
        </span>
        <span
          className="bg-rasta-gold/15 text-rasta-gold flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold"
          style={{ opacity: dx < 0 ? progress : 0, transform: `scale(${0.85 + 0.15 * (dx < 0 ? progress : 0)})` }}
        >
          Leave as-is
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2.5} className="size-4" />
        </span>
      </div>
      <div
        ref={ref}
        className={cn("relative touch-pan-y", !dragging && "transition-transform duration-300 ease-(--ease-out)")}
        style={{ transform: dx ? `translateX(${dx}px) rotate(${dx / 60}deg)` : undefined }}
        onPointerDown={(e) => {
          if (e.pointerType !== "touch" || (e.target as HTMLElement).closest(NO_SWIPE)) return
          start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: null }
        }}
        onPointerMove={(e) => {
          const s = start.current
          if (!s || s.id !== e.pointerId) return
          const mx = e.clientX - s.x
          const my = e.clientY - s.y
          if (!s.axis) {
            if (Math.abs(mx) < 10 && Math.abs(my) < 10) return
            // Mostly sideways is a swipe; anything else is the page scrolling.
            s.axis = Math.abs(mx) > Math.abs(my) * 1.3 ? "x" : "y"
            if (s.axis === "x") {
              ref.current?.setPointerCapture(e.pointerId)
              setThreshold(Math.min(140, (ref.current?.offsetWidth ?? 320) * 0.3))
              setDragging(true)
            }
          }
          if (s.axis === "x") setDx(mx)
        }}
        onPointerUp={(e) => {
          const s = start.current
          if (!s || s.id !== e.pointerId || s.axis !== "x") return reset()
          const decided = dx > threshold ? "approve" : dx < -threshold ? "reject" : null
          reset()
          if (decided) press(decided)
        }}
        onPointerCancel={reset}
      >
        {children}
      </div>
    </div>
  )
}
