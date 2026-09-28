// Hands-off libraries: after identifying, matches the sources are sure of are
// approved and cut straight away (and moved into place, or out of an inbox) -
// the same plan, checks and journal as a cut from Cut & Tag, so Rewind undoes
// it. Anything less certain waits in Review as usual.

import { riskOf } from "../shared/risk"
import type { Settings, Track } from "../shared/types"
import { decisionToFinal } from "./core/naming"
import { buildPlan, executePlan, proposedFilename } from "./executor"
import { enqueueJob, type JobContext } from "./jobs"
import { librarySettings } from "./library-settings"
import { topUpLyrics } from "./lyrics"
import { getLibrary, getTrack, getTracks, updateTrack } from "./repo"
import { settingsNow } from "./settings"

/** A track the sources agree on firmly enough to cut without asking. */
export function handsOffReady(t: Track, settings: Settings): boolean {
  if (t.missing || !librarySettings(t.libraryId).handsOff) return false
  if (t.status !== "matched" && t.status !== "approved") return false
  const d = t.decision
  if (!d || d.status !== "matched" || d.basis !== "sources" || (t.confidence ?? 0) < settings.automation.handsOffMin || !d.title || !d.artists.length) return false
  // Sure isn't enough: it also has to be safe to change without a person looking.
  return riskOf(t).level === "low"
}

/**
 * Approve the sure matches among `ids` and queue a cut for them. Returns the
 * ids approved (cut later by the queued job, unless read-only mode is on).
 */
export function handsOff(ids: number[], settings: Settings, ctx: Pick<JobContext, "log">): number[] {
  const ready = getTracks(ids).filter((t) => handsOffReady(t, settings))
  if (!ready.length) return []
  for (const t of ready) {
    if (t.status === "approved" && t.final) continue
    const final = t.final ?? decisionToFinal(t.decision!)
    updateTrack(t.id, { final, status: "approved", approvedBy: "hands-off", proposedName: proposedFilename({ ...t, final }, settings) })
  }
  const approved = ready.map((t) => t.id)
  const libs = [...new Set(ready.map((t) => getLibrary(t.libraryId)?.name).filter(Boolean))].join(", ")
  const n = `${approved.length} track${approved.length === 1 ? "" : "s"}`
  if (settings.safety.readOnly) {
    ctx.log("warn", `Hands-off: approved ${n} in ${libs}, but read-only mode is on so nothing was cut`)
    return approved
  }
  enqueueJob("execute", `Hands-off: cut ${n} in ${libs}`, (job) => cutApproved(approved, job))
  return approved
}

/** Cut whichever of these are still approved; the rest (name clashes and so on) wait in Cut & Tag. */
export async function cutApproved(ids: number[], ctx: JobContext) {
  const settings = settingsNow()
  const approved = () => ids.map((id) => getTrack(id)).filter((t): t is Track => !!t && t.status === "approved")
  await topUpLyrics(approved(), settings, ctx)
  const plan = buildPlan(approved(), settings)
  const runnable = plan.filter((p) => !p.blocked)
  const held = plan.length - runnable.length
  if (runnable.length) await executePlan(runnable, settings, { dryRun: false, label: "Hands-off" }, ctx)
  else ctx.setTotal(0)
  if (held) ctx.log("warn", `Hands-off: ${held} approved track${held === 1 ? "" : "s"} need a look in Cut & Tag before cutting`)
  ctx.message(`${ctx.job.done} cut${held ? ` · ${held} waiting in Cut & Tag` : ""}`)
}
