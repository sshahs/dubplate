import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiMagicIcon,
  CheckListIcon,
  Copy01Icon,
  DashboardSquare01Icon,
  DatabaseIcon,
  FolderLibraryIcon,
  CloudUploadIcon,
  FolderTreeIcon,
  HealthIcon,
  Moon02Icon,
  MusicNote03Icon,
  Scissor01Icon,
  Logout03Icon,
  Search01Icon,
  Settings02Icon,
  SquareLock02Icon,
  Sun03Icon,
  Video01Icon,
  Vynil02Icon,
} from "@hugeicons/core-free-icons"
import { useQuery } from "@tanstack/react-query"
import { useState, ViewTransition, type MouseEvent, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { NavLink, useLocation } from "react-router"
import type { Stats } from "@shared/types"
import { CommandPalette } from "@/components/command-palette"
import { DubplateMark, RastaStripe } from "@/components/brand"
import { JobDock } from "@/components/job-dock"
import { ConnectionBanner } from "@/components/query-error"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { useLive } from "@/lib/events"
import { cn } from "@/lib/utils"

export const NAV = [
  { to: "/", label: "Dashboard", icon: DashboardSquare01Icon, group: "Selector" },
  { to: "/libraries", label: "Libraries", icon: FolderLibraryIcon, group: "Selector" },
  { to: "/upload", label: "Upload", icon: CloudUploadIcon, group: "Selector" },
  { to: "/tracks", label: "Tracks", icon: MusicNote03Icon, group: "Selector", badge: "pending" as const },
  { to: "/review", label: "Review", icon: CheckListIcon, group: "Selector", badge: "review" as const },
  { to: "/execute", label: "Cut & Tag", icon: Scissor01Icon, group: "Selector", badge: "approved" as const },
  { to: "/organise", label: "Organise", icon: FolderTreeIcon, group: "Selector" },
  { to: "/crates", label: "Crates", icon: Vynil02Icon, group: "Selector" },
  { to: "/untangler", label: "Untangler", icon: AiMagicIcon, group: "Tools" },
  { to: "/sources", label: "Sources", icon: DatabaseIcon, group: "Tools" },
  { to: "/duplicates", label: "Duplicates", icon: Copy01Icon, group: "Tools" },
  { to: "/videos", label: "Videos", icon: Video01Icon, group: "Tools", badge: "videos" as const },
  { to: "/health", label: "Health", icon: HealthIcon, group: "Tools" },
  { to: "/settings", label: "Settings", icon: Settings02Icon, group: "Tools" },
]

type BadgeKind = "pending" | "review" | "approved" | "videos"

/** Sidebar counters: what each one counts, how it reads to a screen reader, and its colour. */
const BADGES: Record<BadgeKind, { count: (s: Stats) => number; says: string; text: string; dot: string }> = {
  // Everything still waiting for your sign-off, including the confident matches.
  pending: { count: (s) => s.byStatus.matched + s.byStatus.review + s.byStatus.conflict, says: "waiting for approval", text: "text-rasta-green", dot: "bg-rasta-green" },
  review: { count: (s) => s.byStatus.review + s.byStatus.conflict, says: "need a listen", text: "text-rasta-gold", dot: "bg-rasta-gold" },
  approved: { count: (s) => s.byStatus.approved, says: "approved, ready to cut", text: "text-primary", dot: "bg-primary" },
  videos: { count: (s) => s.videos ?? 0, says: "videos to convert", text: "text-muted-foreground", dot: "bg-muted-foreground" },
}

const compactCount = (n: number) => (n >= 10_000 ? `${Math.floor(n / 1000)}k` : String(n))

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    const next = resolvedTheme === "dark" ? "light" : "dark"
    const root = document.documentElement
    if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return setTheme(next)
    // Wipe the new theme in as a circle growing out of the button.
    const { left, top, width, height } = e.currentTarget.getBoundingClientRect()
    const x = left + width / 2
    const y = top + height / 2
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
    root.classList.add("theme-reveal")
    const vt = document.startViewTransition(() => {
      root.classList.toggle("dark", next === "dark")
      flushSync(() => setTheme(next))
    })
    vt.ready
      .then(() =>
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          { duration: 550, easing: "cubic-bezier(0.22, 1, 0.36, 1)", pseudoElement: "::view-transition-new(root)" }
        )
      )
      .catch(() => {})
    void vt.finished.finally(() => root.classList.remove("theme-reveal"))
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={toggle} aria-label="Toggle theme" />}>
        <HugeiconsIcon icon={resolvedTheme === "dark" ? Sun03Icon : Moon02Icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>{resolvedTheme === "dark" ? "Daytime" : "Night session"}</TooltipContent>
    </Tooltip>
  )
}

function AppSidebar() {
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: api.stats })
  const { connected } = useLive()
  const location = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const groups = [...new Set(NAV.map((n) => n.group))]
  const badgeFor = (b?: BadgeKind) => (b && stats ? BADGES[b].count(stats) : 0)
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        {/* Everything keeps its place in both states (the logo shares the icons' centre line); text fades out and the rail clips it. */}
        <div className="flex items-center gap-2.5 px-0.5 py-1.5">
          <DubplateMark className="size-8 shrink-0" />
          <div className="leading-tight whitespace-nowrap transition-opacity duration-200 delay-75 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0 group-data-[collapsible=icon]:duration-100">
            <div className="font-heading text-base font-extrabold tracking-tight">Dubplate</div>
            <div className="text-muted-foreground text-[11px]">selector's tagging rig</div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((g) => (
          <SidebarGroup key={g}>
            <SidebarGroupLabel>{g}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.filter((n) => n.group === g).map((n) => {
                  const active = n.to === "/" ? location.pathname === "/" : location.pathname.startsWith(n.to)
                  const count = badgeFor(n.badge)
                  return (
                    <SidebarMenuItem key={n.to}>
                      {active && (
                        // Shared name: on navigation the marker glides to the new item.
                        <ViewTransition name="nav-indicator">
                          <span
                            aria-hidden
                            className="from-rasta-red via-rasta-gold to-rasta-green pointer-events-none absolute top-1.5 bottom-1.5 -left-1 z-10 w-1 rounded-full bg-linear-to-b"
                          />
                        </ViewTransition>
                      )}
                      <SidebarMenuButton
                        isActive={active}
                        tooltip={n.label}
                        // On phones the sidebar is a sheet: put it away once a page is picked.
                        render={<NavLink to={n.to} onClick={() => isMobile && setOpenMobile(false)} />}
                      >
                        <HugeiconsIcon icon={n.icon} strokeWidth={2} />
                        <span>{n.label}</span>
                      </SidebarMenuButton>
                      {count > 0 && (
                        <>
                          {/* Pops in when work appears; no re-pop on every tick so a running job stays calm. */}
                          <SidebarMenuBadge className={cn("animate-in zoom-in-50 fade-in tabular-nums duration-300", BADGES[n.badge!].text)}>
                            {compactCount(count)}
                            <span className="sr-only"> {BADGES[n.badge!].says}</span>
                          </SidebarMenuBadge>
                          {/* Collapsed rail: the count becomes a dot on the icon. */}
                          <span
                            aria-hidden
                            className={cn(
                              "pointer-events-none absolute top-1.5 left-6 size-1.5 rounded-full opacity-0 transition-opacity duration-200 group-data-[collapsible=icon]:opacity-100 group-data-[collapsible=icon]:delay-100",
                              BADGES[n.badge!].dot
                            )}
                          />
                        </>
                      )}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        {/* The status dot stays on the icons' centre line when collapsed; only the words fade. */}
        <div className="text-muted-foreground flex items-center gap-2 px-3.5 pb-1 text-[11px] whitespace-nowrap" title={connected ? "Sound system online" : "Reconnecting…"}>
          <span className={cn("size-2 shrink-0 rounded-full", connected ? "bg-rasta-green" : "bg-rasta-red animate-pulse")} />
          <span className="transition-opacity duration-200 delay-75 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0 group-data-[collapsible=icon]:duration-100">
            {connected ? "Sound system online" : "Reconnecting…"}
          </span>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}

function ReadOnlyPill() {
  const { data } = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 })
  // Hold the pill's space while loading so the header doesn't shuffle.
  if (!data) return <span aria-hidden className="bg-input/40 inline-block h-7 w-7 animate-pulse rounded-full sm:w-24" />
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <NavLink
            to="/execute#safety"
            aria-label={data.readOnly ? "Read-only mode" : "Writes enabled"}
            className={
              data.readOnly
                ? "bg-rasta-green/12 text-rasta-green ring-rasta-green/25 inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset"
                : "bg-rasta-red/12 text-rasta-red ring-rasta-red/30 inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset"
            }
          />
        }
      >
        <HugeiconsIcon icon={SquareLock02Icon} strokeWidth={2} className="size-3.5" />
        <span className="hidden whitespace-nowrap sm:inline">{data.readOnly ? "Read-only" : "Live - writes enabled"}</span>
      </TooltipTrigger>
      <TooltipContent>{data.readOnly ? "Files cannot be changed. Turn off in Settings → Safety." : "Dubplate can rename and tag files."}</TooltipContent>
    </Tooltip>
  )
}

function SignOutButton() {
  const { status, signedOut } = useAuth()
  if (!status?.enabled) return null
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Sign out" onClick={() => void api.logout().finally(signedOut)} />}>
        <HugeiconsIcon icon={Logout03Icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>Sign out</TooltipContent>
    </Tooltip>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="yard-backdrop overflow-clip">
        <RastaStripe />
        <header className="bg-background/70 sticky top-0 z-20 flex h-14 items-center gap-2 border-b px-3 backdrop-blur-xl md:px-5">
          <SidebarTrigger />
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="text-muted-foreground bg-input/40 hover:bg-input/60 flex h-8 w-full max-w-xs items-center gap-2 rounded-full px-3 text-sm transition-colors"
          >
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="size-4" />
            <span className="flex-1 text-left">Jump to…</span>
            <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <JobDock />
            <ReadOnlyPill />
            <ThemeToggle />
            <SignOutButton />
          </div>
        </header>
        <ConnectionBanner />
        {/* The inset is already the page's <main> landmark. */}
        <div className="mx-auto w-full max-w-7xl flex-1 px-3 py-5 md:px-6 md:py-7">{children}</div>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </SidebarProvider>
  )
}

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: ReactNode; actions?: ReactNode; eyebrow?: string }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="text-rasta-gold mb-1 text-xs font-semibold tracking-[0.2em] uppercase">{eyebrow}</div>}
        <h1 className="text-2xl font-extrabold md:text-3xl">{title}</h1>
        {description && <p className="text-muted-foreground mt-1 max-w-2xl text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
