import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const VERSION = "0.1.0"

export const config = {
  port: Number(process.env.DUBPLATE_PORT ?? process.env.PORT ?? 4455),
  host: process.env.DUBPLATE_HOST ?? "127.0.0.1",
  dataDir: path.resolve(process.env.DUBPLATE_DATA_DIR ?? path.join(os.homedir(), ".dubplate")),
  /** extra hostnames allowed in the Host header (DNS-rebinding guard) */
  allowedHosts: (process.env.DUBPLATE_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
}

export function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true })
  return config.dataDir
}
