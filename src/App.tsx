import { lazy, Suspense } from "react"
import { Route, Routes } from "react-router"
import { AppShell } from "@/components/app-shell"
import { Skeleton } from "@/components/ui/skeleton"

const DashboardPage = lazy(() => import("@/pages/dashboard"))
const DuplicatesPage = lazy(() => import("@/pages/duplicates"))
const ExecutePage = lazy(() => import("@/pages/execute"))
const LibrariesPage = lazy(() => import("@/pages/libraries"))
const ReviewPage = lazy(() => import("@/pages/review"))
const SettingsPage = lazy(() => import("@/pages/settings"))
const SourcesPage = lazy(() => import("@/pages/sources"))
const TracksPage = lazy(() => import("@/pages/tracks"))
const UntanglerPage = lazy(() => import("@/pages/untangler"))

function PageFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

export default function App() {
  return (
    <AppShell>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/libraries" element={<LibrariesPage />} />
          <Route path="/tracks" element={<TracksPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/execute" element={<ExecutePage />} />
          <Route path="/untangler" element={<UntanglerPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/duplicates" element={<DuplicatesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<DashboardPage />} />
        </Routes>
      </Suspense>
    </AppShell>
  )
}
