import { useEffect, useRef, useState } from "react"

/** Counts smoothly to a new value instead of snapping; instant under reduced motion. */
export function AnimatedNumber({ value, from, duration = 700 }: { value: number; from?: number; duration?: number }) {
  const [shown, setShown] = useState(from ?? value)
  const current = useRef(from ?? value)

  useEffect(() => {
    const start = current.current
    if (start === value || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      current.current = value
      setShown(value)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration)
      const next = Math.round(start + (value - start) * (1 - Math.pow(1 - p, 3)))
      current.current = next
      setShown(next)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])

  return <>{shown}</>
}
