import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export interface SectionItem {
  id: string
  label: string
  icon: IconSvgElement
  /** a quiet note on the right, e.g. a count */
  meta?: ReactNode
  /** unsaved changes in this section */
  dirty?: boolean
  /** something here needs a look; shown as a dot with this text as its tooltip */
  attention?: string
}

/**
 * Section switcher for long settings pages: a sticky list down the side on
 * wide screens, a row of pills on narrow ones.
 */
export function SectionNav({ items, value, onChange, label }: { items: SectionItem[]; value: string; onChange: (id: string) => void; label: string }) {
  return (
    <nav aria-label={label} className="lg:sticky lg:top-20 lg:self-start">
      <ul className="no-scrollbar -mx-3 flex gap-1 overflow-x-auto px-3 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
        {items.map((it) => {
          const active = it.id === value
          return (
            <li key={it.id} className="shrink-0">
              <button
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onChange(it.id)}
                className={cn(
                  "flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm whitespace-nowrap transition-colors",
                  active ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
              >
                <HugeiconsIcon icon={it.icon} strokeWidth={2} className={cn("size-4 shrink-0", active && "text-primary")} />
                <span className="flex-1">{it.label}</span>
                {(it.dirty || it.attention) && (
                  <span className="bg-rasta-gold size-1.5 rounded-full" title={it.dirty ? "Unsaved changes" : it.attention}>
                    <span className="sr-only">{it.dirty ? "Unsaved changes" : it.attention}</span>
                  </span>
                )}
                {it.meta !== undefined && <span className="text-muted-foreground text-xs tabular-nums">{it.meta}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * One setting: what it is and what it does on the left, the control on the
 * right. `stack` puts wide controls (text areas, templates) underneath.
 */
export function SettingRow({
  title,
  description,
  children,
  htmlFor,
  stack = false,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  htmlFor?: string
  stack?: boolean
  className?: string
}) {
  const Label = htmlFor ? "label" : "div"
  return (
    <div className={cn("flex gap-3 py-4 first:pt-0 last:pb-0", stack ? "flex-col" : "flex-col sm:flex-row sm:items-center sm:justify-between sm:gap-8", className)}>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={htmlFor} className="block text-sm font-medium">
          {title}
        </Label>
        {description && <p className="text-muted-foreground max-w-prose text-xs text-pretty">{description}</p>}
      </div>
      <div className={cn(stack ? "w-full" : "flex shrink-0 items-center sm:justify-end")}>{children}</div>
    </div>
  )
}

/** A group of SettingRows with hairlines between them. */
export function SettingRows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("divide-border/70 divide-y", className)}>{children}</div>
}
