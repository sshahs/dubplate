// The server's event bus (streamed to browsers over SSE), and the scope code
// runs in: which job, and which track within it, so a log line written deep
// inside a source or a web request still knows where it came from.

import { AsyncLocalStorage } from "node:async_hooks"
import type { JobKind, ServerEvent } from "../shared/types"

type Listener = (e: ServerEvent) => void
const listeners = new Set<Listener>()

export function emit(e: ServerEvent) {
  for (const l of listeners) {
    try {
      l(e)
    } catch {
      // a broken SSE client must not break the job
    }
  }
}

export function subscribe(l: Listener) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export interface RunScope {
  job?: { id: string; kind: JobKind; label: string }
  trackId?: number
}

const scope = new AsyncLocalStorage<RunScope>()

export function runScope(): RunScope {
  return scope.getStore() ?? {}
}

/** Run `fn` with more of the scope known (the track a job is on, say). */
export function inScope<T>(patch: RunScope, fn: () => T): T {
  return scope.run({ ...scope.getStore(), ...patch }, fn)
}
