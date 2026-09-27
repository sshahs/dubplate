import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { AuthStatus } from "@shared/types"
import { api } from "@/lib/api"

export const AUTH_KEY = ["auth"] as const

/**
 * Switch the sign-in state, dropping everything else that was loaded. (Clearing the
 * whole cache would also drop the sign-in query the gate is watching, so it'd never
 * hear about the change.)
 */
export function setAuth(qc: QueryClient, status: AuthStatus) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== AUTH_KEY[0] })
  qc.setQueryData<AuthStatus>(AUTH_KEY, status)
}

/** The sign-in state; `signedOut` flips the app back to the sign-in screen. */
export function useAuth() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: AUTH_KEY, queryFn: api.authStatus, staleTime: Infinity })
  const signedOut = () => setAuth(qc, { enabled: true, authenticated: false, fromEnv: data?.fromEnv ?? false })
  return { status: data, signedOut }
}
