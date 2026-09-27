// What's wrong with a file itself, as opposed to its name or tags: the wrong
// extension, a download that didn't finish, a damaged stretch, long silence.
// Shared so the server (filters, Health, duplicates) and the UI agree.

import type { FileProblem, Track } from "./types"

/** Silence longer than this at the start is worth knowing about (a DJ has to skip it). */
export const SILENCE_START_S = 2
/** …and at the end (a hidden track, or a rip left running). */
export const SILENCE_END_S = 5

function clock(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`
}

function secs(s: number): string {
  return s >= 60 ? clock(s) : `${Math.round(s)} s`
}

/** Everything the scanner and the analyser found wrong with the file, worst first. */
export function fileProblems(t: Pick<Track, "fileCheck" | "analysis" | "ext">): FileProblem[] {
  const out: FileProblem[] = []
  const f = t.fileCheck
  const i = t.analysis?.integrity
  if (f?.empty) out.push({ kind: "empty", severity: "error", label: "Empty file", detail: "The file has nothing in it (0 bytes)." })
  if (i?.damagedAt !== null && i?.damagedAt !== undefined) {
    out.push({
      kind: "damaged",
      severity: "error",
      label: "Damaged",
      detail: `The audio breaks off ${clock(i.damagedAt)} in${i.expectedSeconds ? ` of ${clock(i.expectedSeconds)}` : ""}: the rest can't be decoded.`,
    })
  } else if (i?.truncated && i.expectedSeconds) {
    out.push({
      kind: "truncated",
      severity: "error",
      label: "Cut short",
      detail: `Only ${clock(i.decodedSeconds)} of its ${clock(i.expectedSeconds)} is there - a download or copy that didn't finish.`,
    })
  }
  if (f?.realExt) {
    out.push({
      kind: "format",
      severity: "warn",
      label: `Really ${f.realFormat ?? f.realExt.toUpperCase()}`,
      detail: `It's named .${t.ext.toLowerCase()} but it's ${f.realFormat ?? `a .${f.realExt} file`}, which some players and DJ software won't open. Cutting it gives it the right extension.`,
    })
  }
  if (f?.unreadable) out.push({ kind: "unreadable", severity: "warn", label: "Tags unreadable", detail: `The tags couldn't be read: ${f.unreadable}` })
  if (i && (i.silenceStart >= SILENCE_START_S || i.silenceEnd >= SILENCE_END_S)) {
    const bits = [i.silenceStart >= SILENCE_START_S && `${secs(i.silenceStart)} of silence at the start`, i.silenceEnd >= SILENCE_END_S && `${secs(i.silenceEnd)} at the end`].filter(Boolean)
    const text = bits.join(" and ")
    out.push({ kind: "silence", severity: "info", label: "Silence", detail: `${text.charAt(0).toUpperCase()}${text.slice(1)}.` })
  }
  return out
}
