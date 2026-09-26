// node:sqlite prints an ExperimentalWarning on load; it's stable enough for
// our use, so keep the console clean. Imported before anything else.
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message
  if (text?.includes("SQLite is an experimental feature")) return
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning
