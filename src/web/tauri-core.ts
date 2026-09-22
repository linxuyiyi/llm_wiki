import { emitWebEvent } from "./event-bus"

export interface InvokeArgs { [key: string]: unknown }

interface AgentInvokeArgs extends InvokeArgs {
  projectId?: string
  llmConfig?: unknown
  request?: Record<string, unknown>
  sessionId?: string
  runId?: string
}

export function isTauri(): boolean {
  return false
}

export function convertFileSrc(filePath: string): string {
  return `/api/web/file?path=${encodeURIComponent(filePath)}`
}

async function readJsonResponse<T>(response: Response, context: string): Promise<T> {
  const payload = await response.json().catch(() => ({
    ok: false,
    error: `HTTP ${response.status}`,
  }))
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || context)
  }
  return payload.result as T
}

async function invokeAgentTurn<T>(args: AgentInvokeArgs): Promise<T> {
  const response = await fetch("/api/web/agent/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: args.projectId ?? "current",
      llmConfig: args.llmConfig,
      request: args.request ?? {},
    }),
  })
  return readJsonResponse<T>(response, "Agent turn failed")
}

async function invokeAgentCancel<T>(args: AgentInvokeArgs): Promise<T> {
  const response = await fetch("/api/web/agent/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: args.projectId ?? "current",
      sessionId: args.sessionId ?? "",
      runId: args.runId,
    }),
  })
  return readJsonResponse<T>(response, "Agent cancellation failed")
}

interface ParsedSseFrame {
  event: string
  data: unknown
}

function parseSseFrame(frame: string): ParsedSseFrame | null {
  let event = "message"
  const data: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim()
      continue
    }
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart())
    }
  }
  if (data.length === 0) return null
  const raw = data.join("\n")
  try {
    return { event, data: JSON.parse(raw) }
  } catch {
    return { event, data: raw }
  }
}

async function invokeAgentStream<T>(args: AgentInvokeArgs): Promise<T> {
  const request = args.request ?? {}
  const sessionId = typeof request.sessionId === "string" ? request.sessionId : ""
  const runId = typeof request.runId === "string" ? request.runId : ""
  const response = await fetch("/api/web/agent/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      projectId: args.projectId ?? "current",
      llmConfig: args.llmConfig,
      request,
    }),
  })
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.error || `Agent stream failed: HTTP ${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let resolvedSessionId = sessionId
  let sawRuntimeDone = false

  const dispatchFrame = (rawFrame: string) => {
    const frame = parseSseFrame(rawFrame)
    if (!frame) return
    if (frame.event === "agent" && frame.data && typeof frame.data === "object") {
      const agentEvent = frame.data as Record<string, unknown>
      if (agentEvent.type === "agentStart" && typeof agentEvent.sessionId === "string") {
        resolvedSessionId = agentEvent.sessionId
      }
      if (agentEvent.type === "done") sawRuntimeDone = true
      emitWebEvent("agent-event", {
        sessionId: resolvedSessionId || sessionId,
        runId,
        event: agentEvent,
      })
      return
    }
    if (frame.event === "done") {
      const payload = frame.data as Record<string, unknown> | null
      if (payload && typeof payload.sessionId === "string") {
        resolvedSessionId = payload.sessionId
      }
      if (!sawRuntimeDone) {
        emitWebEvent("agent-event", {
          sessionId: resolvedSessionId || sessionId,
          runId,
          event: { type: "done", sessionId: resolvedSessionId || sessionId },
        })
        sawRuntimeDone = true
      }
      return
    }
    if (frame.event === "cancelled") {
      throw new DOMException("Agent turn cancelled", "AbortError")
    }
    if (frame.event === "error") {
      const payload = frame.data as Record<string, unknown> | null
      throw new Error(typeof payload?.error === "string" ? payload.error : "Agent stream failed")
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (frame.trim()) dispatchFrame(frame)
        boundary = buffer.indexOf("\n\n")
      }
      if (done) break
    }
    if (buffer.trim()) dispatchFrame(buffer)
  } finally {
    reader.releaseLock()
  }

  return resolvedSessionId as T
}

export async function invoke<T>(command: string, args: InvokeArgs = {}): Promise<T> {
  if (command === "agent_start_turn_stream") {
    return invokeAgentStream<T>(args as AgentInvokeArgs)
  }
  if (command === "agent_start_turn") {
    return invokeAgentTurn<T>(args as AgentInvokeArgs)
  }
  if (command === "agent_cancel_turn") {
    return invokeAgentCancel<T>(args as AgentInvokeArgs)
  }

  const response = await fetch("/api/web/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args }),
  })
  return readJsonResponse<T>(response, `Web runtime command failed: ${command}`)
}
