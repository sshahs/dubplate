// A scraper's recipe - where it searches and how it reads the answer - as a
// short fingerprint. It tells a preset copy nobody has edited (safe to bring up
// to date when the site changes) from one the owner has, and keeps lookups
// cached under an old recipe from answering for a new one.

import { createHash } from "node:crypto"
import type { ScraperDefinition } from "../../shared/types"

export function recipeKey(def: Pick<ScraperDefinition, "kind" | "searchUrl" | "items" | "fields" | "embedded">): string {
  const fields = Object.entries(def.fields ?? {})
    .map(([k, v]) => [k, String(v ?? "").trim()])
    .filter(([, v]) => v)
    .sort(([a], [b]) => a.localeCompare(b))
  const recipe = [def.kind, def.searchUrl.trim(), (def.items ?? "").trim(), fields, (def.embedded ?? "").trim()]
  return createHash("sha1").update(JSON.stringify(recipe)).digest("hex").slice(0, 10)
}
