// After each job: rescan media servers if files changed, and send chat
// messages about it. Failures only log - they never affect the job.

import { log, onJobFinished } from "../jobs"
import { settingsNow } from "../settings"
import { messageForJob, sendChat } from "./chat"
import { refreshMediaServers } from "./media-servers"

let started = false

export function startIntegrations() {
  if (started) return
  started = true
  onJobFinished(async (job, outcome) => {
    const settings = settingsNow()
    if (outcome.filesChanged) {
      for (const r of await refreshMediaServers(settings)) log(r.ok ? "info" : "warn", `${r.name}: ${r.message}`)
    }
    const msg = messageForJob(job, outcome, settings)
    if (msg) for (const r of await sendChat(settings, msg)) if (!r.ok) log("warn", `Couldn't message ${r.channel === "discord" ? "Discord" : "Telegram"}: ${r.message}`)
  })
}
