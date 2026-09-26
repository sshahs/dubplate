import { cn } from "@/lib/utils"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "bg-muted text-muted-foreground in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:text-background dark:in-data-[slot=tooltip-content]:bg-background/10 h-5.5 w-fit min-w-5.5 gap-1 rounded-lg px-1.5 font-sans text-xs font-medium [&_svg:not([class*='size-'])]:size-3 in-data-[slot=input-group]:bg-input pointer-events-none inline-flex items-center justify-center select-none",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("gap-1 inline-flex items-center", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
