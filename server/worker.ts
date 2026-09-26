// Worker-thread entry for CPU-heavy work — decoding audio for BPM/key and
// shrinking cover art — so the API stays responsive while it runs.

import { parentPort } from "node:worker_threads"
import { analyseFile, type AnalyseRequest } from "./analysis/analyse"
import { makeThumbnail } from "./art-image"

export type WorkerTask = { type: "analyse"; req: AnalyseRequest } | { type: "thumbnail"; bytes: Uint8Array; size: number }

async function run(task: WorkerTask) {
  if (task.type === "analyse") return analyseFile(task.req)
  return makeThumbnail(task.bytes, task.size)
}

parentPort?.on("message", async (msg: { id: number; task: WorkerTask }) => {
  try {
    parentPort!.postMessage({ id: msg.id, result: await run(msg.task) })
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
  }
})
