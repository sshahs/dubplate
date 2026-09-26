import { HugeiconsIcon } from "@hugeicons/react"
import { MusicNote01Icon } from "@hugeicons/core-free-icons"
import { useState } from "react"
import type { ArtRef } from "@shared/types"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

type WithArt = { id: number; art: ArtRef | null; artFound: ArtRef | null }

/**
 * A track's cover: the artwork waiting to be embedded if there is some (marked
 * with a gold dot), otherwise the picture already in the file.
 */
export function Cover({ track, size = 40, which, className, rounded = "rounded-lg" }: { track: WithArt; size?: number; which?: "current" | "found"; className?: string; rounded?: string }) {
  const show = which ?? (track.artFound ? "found" : "current")
  // Ask for twice the pixels on high-density screens.
  const url = api.artUrl(track, show, size * (typeof devicePixelRatio === "number" && devicePixelRatio > 1 ? 2 : 1))
  const [failed, setFailed] = useState<string | null>(null)
  const pending = show === "found" && !!track.artFound
  return (
    <span className={cn("bg-muted relative inline-flex shrink-0 items-center justify-center overflow-hidden", rounded, className)} style={{ width: size, height: size }}>
      {url && failed !== url ? (
        <img src={url} alt="" width={size} height={size} loading="lazy" decoding="async" className="size-full object-cover" onError={() => setFailed(url)} />
      ) : (
        <HugeiconsIcon icon={MusicNote01Icon} strokeWidth={2} className="text-muted-foreground/60 size-[45%]" />
      )}
      {pending && !which && <span title="New artwork — embedded when you cut" className="bg-rasta-gold ring-background absolute top-0.5 right-0.5 size-2 rounded-full ring-2" />}
    </span>
  )
}
