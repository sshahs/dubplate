import { HugeiconsIcon } from "@hugeicons/react"
import { AiMagicIcon, RefreshIcon } from "@hugeicons/core-free-icons"
import { useEffect } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { NAV } from "@/components/app-shell"
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { api } from "@/lib/api"

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onOpenChange])

  const run = (fn: () => void) => {
    onOpenChange(false)
    fn()
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Where to, selector?" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        <CommandGroup heading="Go to">
          {NAV.map((n) => (
            <CommandItem key={n.to} value={n.label} onSelect={() => run(() => navigate(n.to))}>
              <HugeiconsIcon icon={n.icon} strokeWidth={2} />
              {n.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem
            value="Rescan all libraries"
            onSelect={() => run(() => api.scanAll().then(() => toast("Rescanning all libraries")).catch((e) => toast.error(e.message)))}
          >
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
            Rescan all libraries
          </CommandItem>
          <CommandItem
            value="Process new tracks interpret scour score"
            onSelect={() => run(() => api.process(null, {}).then((j) => toast(j.label)).catch((e) => toast.error(e.message)))}
          >
            <HugeiconsIcon icon={AiMagicIcon} strokeWidth={2} />
            Process all new tracks
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
