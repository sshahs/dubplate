import "./quiet"
import fs from "node:fs"
import path from "node:path"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { createApp } from "./app"
import { config, VERSION } from "./config"
import { getDb } from "./db"
import { startIntegrations } from "./integrations"
import { markInterruptedJobs } from "./jobs"
import { log, startLogging } from "./logs"
import { repairMarkupOnce } from "./pipeline"
import { upsertAlias } from "./repo"
import { settingsNow } from "./settings"
import { pruneHttpCache } from "./sources/http"
import { startAutomation } from "./watcher"

/** A starter set of common shorthand → credited names. Editable in Settings → Learning. */
const STARTER_ALIASES: [string, string][] = [
  ["buju", "Buju Banton"],
  ["beenie", "Beenie Man"],
  ["kartel", "Vybz Kartel"],
  ["bounty", "Bounty Killer"],
  ["shabba", "Shabba Ranks"],
  ["sizzla kalonji", "Sizzla"],
  ["sly and robbie", "Sly & Robbie"],
  ["chaka demus and pliers", "Chaka Demus & Pliers"],
  ["king tubbys", "King Tubby"],
  ["dizzee", "Dizzee Rascal"],
  ["d double", "D Double E"],
  ["wiley kat", "Wiley"],
  ["ghetto", "Ghetts"],
  ["tempa", "Tempa T"],
  ["jammer", "Jammer"],
]

function firstRunSeed() {
  const db = getDb()
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM aliases").get() as { n: number }
  const seeded = db.prepare("SELECT 1 FROM settings WHERE key = 'seeded'").get()
  if (n === 0 && !seeded) {
    for (const [alias, canonical] of STARTER_ALIASES) upsertAlias(alias, canonical)
  }
  db.prepare("INSERT OR IGNORE INTO settings (key, value_json) VALUES ('seeded', 'true')").run()
}

getDb()
// Settings first: they say how long the log is kept and whether it has the step-by-step detail.
settingsNow()
startLogging()
markInterruptedJobs()
firstRunSeed()
pruneHttpCache()

const app = createApp()

const distDir = path.resolve(import.meta.dirname, "../dist")
if (fs.existsSync(path.join(distDir, "index.html"))) {
  const root = path.relative(process.cwd(), distDir) || "."
  app.use(
    "/*",
    serveStatic({
      root,
      // Hashed build output never changes; index.html must always be revalidated.
      onFound: (file, c) => c.header("cache-control", file.includes(`${path.sep}assets${path.sep}`) || file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"),
    })
  )
  const indexHtml = fs.readFileSync(path.join(distDir, "index.html"), "utf8")
  app.get("*", (c) => {
    // A missing asset or API route is a 404, not the app shell - otherwise a stale
    // tab asking for an old chunk after an upgrade gets HTML back and breaks.
    if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(c.req.path)) return c.notFound()
    c.header("cache-control", "no-cache")
    return c.html(indexHtml)
  })
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const host = config.host === "0.0.0.0" ? "localhost" : config.host
  console.log(`\n  ◉ Dubplate ${VERSION} - selector ready`)
  console.log(`  ➜ http://${host}:${info.port}`)
  console.log(`  ➜ data: ${config.dataDir}\n`)
  log("info", `Dubplate ${VERSION} started on http://${host}:${info.port} (Node ${process.versions.node})`, { area: "server", detail: `Data: ${config.dataDir}` }, false)
  // Watched folders, periodic re-checks and the nightly scan.
  startAutomation()
  // Media server rescans and chat messages after jobs.
  startIntegrations()
  // Tracks a site's links reached before every answer was cleaned.
  repairMarkupOnce()
})
