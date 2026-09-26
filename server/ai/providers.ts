// Thin clients for the LLM back-ends. Every provider returns JSON that
// matches a schema — natively where supported, by instruction otherwise.

import type { LlmProviderConfig } from "../../shared/types"

export interface JsonRequest {
  system: string
  user: string
  schema: Record<string, unknown>
  schemaName: string
  temperature: number
  signal?: AbortSignal
  timeoutMs?: number
}

export class LlmError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

function joinUrl(base: string, p: string) {
  return base.replace(/\/+$/, "") + p
}

async function post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal, timeoutMs = 120_000) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text.slice(0, 400)
    try {
      const j = JSON.parse(text)
      msg = j.error?.message ?? j.error ?? j.message ?? msg
    } catch {
      // keep raw text
    }
    throw new LlmError(`${res.status} ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, res.status)
  }
  return text
}

async function get(url: string, headers: Record<string, string>, timeoutMs = 15_000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  if (!res.ok) throw new LlmError(`${res.status} ${text.slice(0, 200)}`, res.status)
  return JSON.parse(text)
}

/** Pull the first JSON object out of a model reply (handles ```json fences and <think> blocks). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // fall through
  }
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    try {
      return JSON.parse(fence[1])
    } catch {
      // fall through
    }
  }
  const start = cleaned.indexOf("{")
  if (start >= 0) {
    let depth = 0
    let inStr = false
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i]
      if (inStr) {
        if (ch === "\\") i++
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === "{") depth++
      else if (ch === "}" && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1))
    }
  }
  throw new LlmError("Model reply did not contain JSON")
}

function authHeaders(p: LlmProviderConfig): Record<string, string> {
  return p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}
}

// ---------- Ollama (local + cloud) ----------

async function ollamaJson(p: LlmProviderConfig, req: JsonRequest) {
  const text = await post(
    joinUrl(p.baseUrl, "/api/chat"),
    {
      model: p.model,
      stream: false,
      format: req.schema,
      options: { temperature: req.temperature },
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    },
    authHeaders(p),
    req.signal,
    req.timeoutMs ?? 180_000
  )
  const j = JSON.parse(text)
  return extractJson(j.message?.content ?? "")
}

// ---------- OpenAI + compatible (Command Code, LM Studio, OpenRouter, …) ----------

function openAiTemperature(p: LlmProviderConfig, t: number) {
  // Reasoning models reject non-default temperatures.
  return /^(o\d|gpt-5)/i.test(p.model) ? {} : { temperature: t }
}

async function openAiJson(p: LlmProviderConfig, req: JsonRequest) {
  const messages = [
    { role: "system", content: req.system },
    { role: "user", content: req.user },
  ]
  const url = joinUrl(p.baseUrl, "/chat/completions")
  const formats: unknown[] =
    p.kind === "openai"
      ? [{ type: "json_schema", json_schema: { name: req.schemaName, schema: req.schema, strict: true } }]
      : [
          { type: "json_schema", json_schema: { name: req.schemaName, schema: req.schema, strict: true } },
          { type: "json_object" },
          undefined,
        ]
  let lastErr: unknown
  for (const response_format of formats) {
    try {
      const sys =
        response_format === undefined || (response_format as { type: string }).type === "json_object"
          ? `${req.system}\n\nReply with a single JSON object matching this JSON Schema:\n${JSON.stringify(req.schema)}`
          : req.system
      const text = await post(
        url,
        {
          model: p.model,
          messages: [{ role: "system", content: sys }, messages[1]],
          ...openAiTemperature(p, req.temperature),
          ...(response_format ? { response_format } : {}),
        },
        authHeaders(p),
        req.signal,
        req.timeoutMs
      )
      const j = JSON.parse(text)
      return extractJson(j.choices?.[0]?.message?.content ?? "")
    } catch (err) {
      lastErr = err
      // Only fall back when the server rejected the request shape.
      if (!(err instanceof LlmError) || (err.status !== 400 && err.status !== 422)) throw err
    }
  }
  throw lastErr
}

// ---------- Anthropic ----------

async function anthropicJson(p: LlmProviderConfig, req: JsonRequest) {
  const text = await post(
    joinUrl(p.baseUrl, "/v1/messages"),
    {
      model: p.model,
      max_tokens: 1500,
      temperature: req.temperature,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      tools: [{ name: req.schemaName, description: "Record the identified track.", input_schema: req.schema }],
      tool_choice: { type: "tool", name: req.schemaName },
    },
    { "x-api-key": p.apiKey ?? "", "anthropic-version": "2023-06-01" },
    req.signal,
    req.timeoutMs
  )
  const j = JSON.parse(text)
  const block = (j.content as { type: string; input?: unknown; text?: string }[] | undefined)?.find((b) => b.type === "tool_use")
  if (block?.input) return block.input
  const textBlock = (j.content as { type: string; text?: string }[] | undefined)?.find((b) => b.type === "text")
  return extractJson(textBlock?.text ?? "")
}

export async function completeJson(p: LlmProviderConfig, req: JsonRequest): Promise<unknown> {
  if (!p.model) throw new LlmError(`No model selected for ${p.label}`)
  if ((p.kind === "openai" || p.kind === "anthropic" || p.kind === "ollama-cloud" || p.kind === "commandcode") && !p.apiKey) {
    throw new LlmError(`${p.label} needs an API key`)
  }
  switch (p.kind) {
    case "ollama":
    case "ollama-cloud":
      return ollamaJson(p, req)
    case "anthropic":
      return anthropicJson(p, req)
    default:
      return openAiJson(p, req)
  }
}

export async function listModels(p: LlmProviderConfig): Promise<string[]> {
  switch (p.kind) {
    case "ollama":
    case "ollama-cloud": {
      const j = await get(joinUrl(p.baseUrl, "/api/tags"), authHeaders(p))
      return ((j.models ?? []) as { name: string }[]).map((m) => m.name).sort()
    }
    case "anthropic": {
      const j = await get(joinUrl(p.baseUrl, "/v1/models?limit=100"), { "x-api-key": p.apiKey ?? "", "anthropic-version": "2023-06-01" })
      return ((j.data ?? []) as { id: string }[]).map((m) => m.id)
    }
    default: {
      const j = await get(joinUrl(p.baseUrl, "/models"), authHeaders(p))
      return ((j.data ?? j.models ?? []) as { id?: string; name?: string }[]).map((m) => m.id ?? m.name ?? "").filter(Boolean).sort()
    }
  }
}

export async function testProvider(p: LlmProviderConfig): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const started = Date.now()
  try {
    const out = (await completeJson(p, {
      system: "You are a connectivity check. Reply with JSON only.",
      user: 'Return {"ok": true, "artist": "Bob Marley"}',
      schemaName: "ping",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok", "artist"],
        properties: { ok: { type: "boolean" }, artist: { type: "string" } },
      },
      temperature: 0,
      timeoutMs: 60_000,
    })) as { ok?: boolean }
    return { ok: out?.ok === true, message: out?.ok ? `${p.model} is responding` : "Unexpected reply", latencyMs: Date.now() - started }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started }
  }
}
