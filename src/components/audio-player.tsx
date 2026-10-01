import { HugeiconsIcon } from "@hugeicons/react"
import { GoBackward10SecIcon, PauseIcon, PlayIcon } from "@hugeicons/core-free-icons"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { fmtDuration } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Compact preview player - listen before you commit a name. */
export function AudioPlayer({ src, className }: { src: string; className?: string }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState(false)
  const [reason, setReason] = useState<string | null>(null)

  useEffect(() => {
    setPlaying(false)
    setTime(0)
    setError(false)
    setReason(null)
  }, [src])

  // The server says why it can't (a format browsers can't play, without ffmpeg to convert it).
  const failed = () => {
    setError(true)
    void fetch(src, { headers: { range: "bytes=0-1", "x-dubplate": "1" } })
      .then((r) => (r.ok ? null : r.json()))
      .then((j: { error?: string } | null) => setReason(j?.error ?? null))
      .catch(() => {})
  }

  const toggle = () => {
    const a = ref.current
    if (!a) return
    if (a.paused) void a.play().catch(failed)
    else a.pause()
  }

  return (
    <div className={cn("bg-muted/50 flex items-center gap-2 rounded-full p-1 pr-4", className)}>
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onError={failed}
      />
      <Button size="icon-sm" className="rounded-full" onClick={toggle} disabled={error} aria-label={playing ? "Pause" : "Play"}>
        <HugeiconsIcon icon={playing ? PauseIcon : PlayIcon} strokeWidth={2} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => ref.current && (ref.current.currentTime = Math.max(0, ref.current.currentTime - 10))}
        aria-label="Back 10 seconds"
      >
        <HugeiconsIcon icon={GoBackward10SecIcon} strokeWidth={2} />
      </Button>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={time}
        onChange={(e) => ref.current && (ref.current.currentTime = Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer accent-[var(--rasta-gold)]"
        aria-label="Seek"
      />
      <span className="text-muted-foreground w-20 text-right font-mono text-[11px] tabular-nums" title={reason ?? undefined}>
        {error ? "can't play" : `${fmtDuration(time)} / ${fmtDuration(duration)}`}
      </span>
    </div>
  )
}
