import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon, ComputerTerminal01Icon } from "@hugeicons/core-free-icons"
import { VuMeter } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { api } from "@/lib/api"
import { useActiveJobs, useLive } from "@/lib/events"
import { cn } from "@/lib/utils"

const LEVEL_CLASS = {
  info: "text-muted-foreground",
  success: "text-rasta-green",
  warn: "text-rasta-gold",
  error: "text-rasta-red",
} as const

export function JobDock() {
  const active = useActiveJobs()
  const { logs } = useLive()
  const running = active.find((j) => j.status === "running")
  const pct = running && running.total ? Math.round(((running.done + running.failed) / running.total) * 100) : null

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className={cn("gap-2", running && "border-rasta-gold/40")}>
            {running ? <VuMeter /> : <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} />}
            <span className="hidden max-w-40 truncate md:inline">{running ? running.label : "Console"}</span>
            {pct !== null && <span className="text-rasta-gold font-mono text-xs">{pct}%</span>}
            {active.length > 1 && <span className="text-muted-foreground text-xs">+{active.length - 1}</span>}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-[min(92vw,28rem)] p-0">
        <div className="border-b p-3">
          <div className="text-sm font-semibold">Jobs</div>
          {active.length === 0 && <div className="text-muted-foreground mt-1 text-xs">Nothing running — the rig is idle.</div>}
          <div className="mt-2 space-y-3">
            {active.map((j) => {
              const p = j.total ? ((j.done + j.failed) / j.total) * 100 : 0
              return (
                <div key={j.id} className="space-y-1.5">
                  <div className="flex items-center gap-2 text-xs">
                    {j.status === "running" ? <VuMeter className="h-3" /> : <span className="text-muted-foreground">queued</span>}
                    <span className="flex-1 truncate font-medium">{j.label}</span>
                    <span className="text-muted-foreground font-mono">
                      {j.done + j.failed}/{j.total || "?"}
                    </span>
                    <Button variant="ghost" size="icon-xs" onClick={() => api.cancelJob(j.id)} aria-label="Cancel job">
                      <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                    </Button>
                  </div>
                  <Progress value={p} />
                  {j.message && <div className="text-muted-foreground truncate text-[11px]">{j.message}</div>}
                </div>
              )
            })}
          </div>
        </div>
        <div className="p-3 pb-1 text-sm font-semibold">Console</div>
        <ScrollArea className="h-56 px-3 pb-3">
          <div className="space-y-1 font-mono text-[11px] leading-relaxed">
            {logs.length === 0 && <div className="text-muted-foreground">No messages yet.</div>}
            {[...logs].reverse().map((l, i) => (
              <div key={i} className={LEVEL_CLASS[l.level]}>
                <span className="text-muted-foreground/60">{new Date(l.at).toLocaleTimeString()} </span>
                {l.message}
              </div>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
