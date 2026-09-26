// Keep test runs out of ~/.dubplate: the artwork cache and friends live in a temp data dir.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.DUBPLATE_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "dubplate-data-"))
