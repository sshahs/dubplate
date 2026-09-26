import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router"
import App from "@/App"
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={queryClient}>
        <LiveProvider>
          <TooltipProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
            <Toaster position="bottom-right" richColors closeButton />
          </TooltipProvider>
        </LiveProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>
)
