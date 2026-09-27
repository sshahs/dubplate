import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { Component, lazy, Suspense, useEffect, useLayoutEffect, ViewTransition, type ReactNode } from "react"
import { Route, Routes, useLocation } from "react-router"
import { AppShell } from "@/components/app-shell"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

const PAGES = {
  crates: () => import("@/pages/crates"),
  dashboard: () => import("@/pages/dashboard"),
  duplicates: () => import("@/pages/duplicates"),
  execute: () => import("@/pages/execute"),
  health: () => import("@/pages/health"),
  upload: () => import("@/pages/upload"),
  libraries: () => import("@/pages/libraries"),
  organise: () => import("@/pages/organise"),
  review: () => import("@/pages/review"),
  settings: () => import("@/pages/settings"),
  sources: () => import("@/pages/sources"),
  tracks: () => import("@/pages/tracks"),
  untangler: () => import("@/pages/untangler"),
}

const CratesPage = lazy(PAGES.crates)
const DashboardPage = lazy(PAGES.dashboard)
const DuplicatesPage = lazy(PAGES.duplicates)
const ExecutePage = lazy(PAGES.execute)
const HealthPage = lazy(PAGES.health)
const LibrariesPage = lazy(PAGES.libraries)
const OrganisePage = lazy(PAGES.organise)
const ReviewPage = lazy(PAGES.review)
const SettingsPage = lazy(PAGES.settings)
const SourcesPage = lazy(PAGES.sources)
const TracksPage = lazy(PAGES.tracks)
const UntanglerPage = lazy(PAGES.untangler)
const UploadPage = lazy(PAGES.upload)

function PageFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

/** Catches a page that fails to render (or load) so the rest of the app keeps working. */
class PageErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null; resetKey: string }> {
  state = { error: null as Error | null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { resetKey: string }) {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
        <div className="bg-rasta-red/15 text-rasta-red flex size-12 items-center justify-center rounded-2xl">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
        </div>
        <h1 className="mt-5 text-2xl font-extrabold">This page skipped</h1>
        <p className="text-muted-foreground mt-2 text-sm">{this.state.error.message}</p>
        <Button className="mt-5" onClick={() => window.location.reload()}>
          Reload Dubplate
        </Button>
      </div>
    )
  }
}

export default function App() {
  const location = useLocation()

  // Every page starts at the top; runs inside the transition so the new page is captured scrolled up.
  useLayoutEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

  // Warm every page chunk once the first screen is up, so navigating never waits on the network.
  useEffect(() => {
    const load = () => Object.values(PAGES).forEach((page) => void page().catch(() => {}))
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(load, { timeout: 3000 })
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(load, 1500)
    return () => clearTimeout(id)
  }, [])

  return (
    <AppShell>
      <PageErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<PageFallback />}>
          {/* Keyed by path: switching pages exits the old one and enters the new one. */}
          <ViewTransition key={location.pathname} enter="page-enter" exit="page-exit" default="none">
            <div>
              <Routes location={location}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/libraries" element={<LibrariesPage />} />
                <Route path="/tracks" element={<TracksPage />} />
                <Route path="/review" element={<ReviewPage />} />
                <Route path="/execute" element={<ExecutePage />} />
                <Route path="/organise" element={<OrganisePage />} />
                <Route path="/crates" element={<CratesPage />} />
                <Route path="/untangler" element={<UntanglerPage />} />
                <Route path="/sources" element={<SourcesPage />} />
                <Route path="/duplicates" element={<DuplicatesPage />} />
                <Route path="/health" element={<HealthPage />} />
                <Route path="/upload" element={<UploadPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<DashboardPage />} />
              </Routes>
            </div>
          </ViewTransition>
        </Suspense>
      </PageErrorBoundary>
    </AppShell>
  )
}
