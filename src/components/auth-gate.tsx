import { HugeiconsIcon } from "@hugeicons/react"
import { SquareLock02Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, type ReactNode } from "react"
import type { AuthStatus } from "@shared/types"
import { DubplateMark, RastaStripe } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api, SIGNED_OUT } from "@/lib/api"
import { AUTH_KEY, setAuth } from "@/lib/auth"

function SignIn({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("")
  const login = useMutation({ mutationFn: () => api.login(password), onSuccess: onDone })
  return (
    <div className="yard-backdrop bg-background flex min-h-svh flex-col">
      <RastaStripe />
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <form
          className="animate-in fade-in slide-in-from-bottom-2 bg-card w-full max-w-sm rounded-4xl border p-7 shadow-2xl duration-300"
          onSubmit={(e) => {
            e.preventDefault()
            if (password) login.mutate()
          }}
        >
          <div className="flex items-center gap-3">
            <DubplateMark className="size-11" />
            <div>
              <h1 className="font-heading text-2xl font-extrabold tracking-tight">Dubplate</h1>
              <p className="text-muted-foreground text-sm">Sign in to the sound system</p>
            </div>
          </div>
          {/* Lets password managers file the password under a name. */}
          <input type="text" name="username" autoComplete="username" value="dubplate" readOnly hidden />
          <label htmlFor="password" className="mt-7 mb-2 block text-sm font-medium">
            Password
          </label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={login.isError || undefined}
            aria-describedby={login.isError ? "password-error" : undefined}
          />
          {login.isError && (
            <p id="password-error" role="alert" className="text-destructive mt-2 text-sm">
              {login.error.message}
            </p>
          )}
          <Button type="submit" className="mt-5 w-full" disabled={!password || login.isPending}>
            {login.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={SquareLock02Icon} strokeWidth={2} data-icon="inline-start" />}
            Sign in
          </Button>
        </form>
      </main>
    </div>
  )
}

/**
 * Holds the app back until you're signed in (when a password is set), so nothing
 * - not even the live event stream - starts without a session.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const { data, isPending } = useQuery({ queryKey: AUTH_KEY, queryFn: api.authStatus, staleTime: Infinity, retry: 1 })

  useEffect(() => {
    const onSignedOut = () => {
      const was = qc.getQueryData<AuthStatus>(AUTH_KEY)
      if (was && !was.authenticated) return
      setAuth(qc, { enabled: true, authenticated: false, fromEnv: was?.fromEnv ?? false })
    }
    window.addEventListener(SIGNED_OUT, onSignedOut)
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut)
  }, [qc])

  if (isPending) {
    return (
      <div className="bg-background flex min-h-svh items-center justify-center">
        <DubplateMark className="size-12" spinning />
      </div>
    )
  }
  if (data && !data.authenticated) {
    return (
      <SignIn
        onDone={() => setAuth(qc, { ...data, authenticated: true })}
      />
    )
  }
  // Server unreachable: let the app in, where the connection banner explains.
  return children
}
