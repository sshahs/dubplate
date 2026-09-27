import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router"
import App from "@/App"
import { AuthGate } from "@/components/auth-gate"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LiveProvider } from "@/lib/events"
import "./index.css"

// A tab left open across an upgrade asks for page chunks that no longer exist.
// Reload once to pick up the new build instead of breaking mid-navigation.
window.addEventListener("vite:preloadError", (event) => {
  const key = "dubplate-reloaded-at"
  let last: number
  try {
    last = Number(sessionStorage.getItem(key) ?? 0)
    sessionStorage.setItem(key, String(Date.now()))
  } catch {
    return // can't guard against a reload loop; let the page's error screen offer a reload
  }
  if (Date.now() - last > 10_000) {
    event.preventDefault()
    window.location.reload()
  }
})

// Installable as an app on phones; the worker only shows a page when the server's unreachable.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}))
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthGate>
            <LiveProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </LiveProvider>
          </AuthGate>
          <Toaster position="bottom-right" richColors closeButton />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>
)
