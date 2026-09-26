// A small pool of worker threads (see worker.ts). Idle workers exit after a
// minute; if workers can't start, tasks run on the main thread instead.

import os from "node:os"
import { Worker } from "node:worker_threads"
import { analyseFile } from "./analysis/analyse"
import { makeThumbnail } from "./art-image"
import type { WorkerTask } from "./worker"

const TIMEOUT_MS = 120_000
const IDLE_MS = 60_000

export const POOL_SIZE = Math.max(1, Math.min(2, (os.availableParallelism?.() ?? os.cpus().length) - 1))

interface Slot {
  worker: Worker
  busy: boolean
  idle?: ReturnType<typeof setTimeout>
}

let nextId = 1
const slots: Slot[] = []
const waiting: (() => void)[] = []
let inProcess = false
/** Workers that died before finishing a task; after a few, stop trying and work in-process. */
let crashes = 0

function spawn(): Slot | null {
  try {
    // The server runs through tsx, whose loader doesn't reach worker threads by itself:
    // bootstrap the worker with tsx's API so worker.ts and its imports resolve as TypeScript.
    // Both resolved here, so it works whatever directory the server was started from.
    const entry = new URL("./worker.ts", import.meta.url).href
    const tsxApi = import.meta.resolve("tsx/esm/api")
    const worker = new Worker(`import(${JSON.stringify(tsxApi)}).then(({ tsImport }) => tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)}))`, { eval: true })
    worker.unref()
    const slot: Slot = { worker, busy: false }
    const died = () => {
      if (slots.includes(slot) && ++crashes >= 3) {
        inProcess = true
        console.error("[dubplate] worker threads keep failing — analysing on the main thread instead")
      }
      retire(slot)
    }
    worker.on("error", died)
    worker.on("exit", (code) => (code === 0 ? retire(slot) : died()))
    slots.push(slot)
    return slot
  } catch {
    inProcess = true
    return null
  }
}

function retire(slot: Slot) {
  const i = slots.indexOf(slot)
  if (i < 0) return
  slots.splice(i, 1)
  clearTimeout(slot.idle)
  void slot.worker.terminate()
  waiting.shift()?.()
}

async function acquire(): Promise<Slot | null> {
  while (true) {
    const free = slots.find((s) => !s.busy)
    if (free) {
      clearTimeout(free.idle)
      free.busy = true
      return free
    }
    if (inProcess) return null
    if (slots.length < POOL_SIZE) {
      const s = spawn()
      if (!s) return null
      s.busy = true
      return s
    }
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
}

function release(slot: Slot) {
  slot.busy = false
  // Decoders hold on to memory; let idle workers go.
  slot.idle = setTimeout(() => retire(slot), IDLE_MS)
  slot.idle.unref()
  waiting.shift()?.()
}

function runHere(task: WorkerTask): Promise<unknown> {
  return task.type === "analyse" ? analyseFile(task.req) : Promise.resolve(makeThumbnail(task.bytes, task.size))
}

export async function runTask<T>(task: WorkerTask): Promise<T> {
  const slot = await acquire()
  if (!slot) return (await runHere(task)) as T
  const id = nextId++
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out"))
        retire(slot)
      }, TIMEOUT_MS)
      const onMessage = (msg: { id: number; result?: T; error?: string }) => {
        if (msg.id !== id) return
        crashes = 0
        clearTimeout(timer)
        slot.worker.off("message", onMessage)
        slot.worker.off("exit", onExit)
        if (msg.error) reject(new Error(msg.error))
        else resolve(msg.result as T)
      }
      const onExit = () => {
        clearTimeout(timer)
        slot.worker.off("message", onMessage)
        reject(new Error("Worker stopped"))
      }
      slot.worker.on("message", onMessage)
      slot.worker.once("exit", onExit)
      slot.worker.postMessage({ id, task })
    })
  } finally {
    if (slots.includes(slot)) release(slot)
  }
}
