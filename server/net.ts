/** A readable reason for a request to another service that never got an answer. */
export function networkMessage(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "No answer within 10 seconds"
  switch (e?.cause?.code) {
    case "ECONNREFUSED":
      return "Connection refused - is it running at that address?"
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "Couldn't find that host name"
    case "ECONNRESET":
      return "The connection was dropped"
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return "The HTTPS certificate isn't trusted - try its http:// address"
  }
  const cause = e?.cause?.message
  return cause && e?.message === "fetch failed" ? `Couldn't connect (${cause})` : (e?.message ?? String(err))
}
