// How each library is being watched right now. Kept apart from the watcher so
// the data layer can report it without importing the watcher (and its timers).

import type { Library } from "../shared/types"

const states = new Map<number, Library["watchState"]>()

export function setWatchState(libraryId: number, state: Library["watchState"]) {
  if (state === "off") states.delete(libraryId)
  else states.set(libraryId, state)
}

export function watchState(libraryId: number): Library["watchState"] {
  return states.get(libraryId) ?? "off"
}
