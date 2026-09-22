import { randomUUID } from "node:crypto"
import { createServer as createNodeHttpServer, type IncomingMessage, type ServerResponse } from "node:http"
import { networkInterfaces } from "node:os"
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"

export type McpTransportMode = "stdio" | "http"

export interface McpHttpOptions {
  host: string
  port: number
  path: string
  authToken?: string
}

export interface McpLaunchOptions {
  transport: McpTransportMode
  http: McpHttpOptions
}

export type McpHttpFallbackHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => boolean | Promise<boolean>

interface HttpSession {
  transport: StreamableHTTPServerTransport
  server: McpServer
}

const DEFAULT_HTTP_HOST = "127.0.0.1"
const DEFAULT_HTTP_PORT = 19898
const DEFAULT_HTTP_PATH = "/mcp"
const MAX_BODY_BYTES = 1024 * 1024

export function parseMcpLaunchOptions(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): McpLaunchOptions {
  const transport = valueArg(argv, "--transport")
    ?? env.LLM_WIKI_MCP_TRANSPORT
    ?? "stdio"
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Unsupported MCP transport: ${transport}. Use stdio or http.`)
  }

  const host = (
    valueArg(argv, "--host")
    ?? env.LLM_WIKI_MCP_HOST
    ?? DEFAULT_HTTP_HOST
  ).trim()
  if (!host || /[\s/]/.test(host)) {
    throw new Error(`Invalid MCP HTTP host: ${host || "(empty)"}`)
  }

  const portText = valueArg(argv, "--port") ?? env.LLM_WIKI_MCP_PORT ?? String(DEFAULT_HTTP_PORT)
  const port = Number.parseInt(portText, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP HTTP port: ${portText}`)
  }

  const path = normalizeMcpPath(valueArg(argv, "--path") ?? env.LLM_WIKI_MCP_PATH ?? DEFAULT_HTTP_PATH)
  const authToken = (
    valueArg(argv, "--auth-token")
    ?? env.LLM_WIKI_MCP_AUTH_TOKEN
    ?? ""
  ).trim() || undefined

  return {
    transport,
    http: { host, port, path, authToken },
  }
}

export async function startHttpMcpServer(
  createMcpServer: () => McpServer,
  options: McpHttpOptions,
  fallbackHandler?: McpHttpFallbackHandler,
): Promise<void> {
  const sessions = new Map<string, HttpSession>()
  const lanAddresses = options.host === "0.0.0.0" ? getLanIpv4Addresses() : []
  const httpServer = createNodeHttpServer(async (req, res) => {
    try {
      setCommonHeaders(res)
      if (req.method === "OPTIONS") {
        res.statusCode = 204
        res.end()
        return
      }

      const requestUrl = new URL(req.url ?? "/", "http://localhost")
      if (requestUrl.pathname === "/health") {
        writeJson(res, 200, buildHealthPayload(options, lanAddresses, sessions.size))
        return
      }
      if (requestUrl.pathname !== options.path) {
        if (fallbackHandler && await fallbackHandler(req, res, requestUrl)) return
        writeJson(res, 404, { error: "Not found" })
        return
      }
      if (!isAuthorized(req, options.authToken)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="llm-wiki-mcp"')
        writeJson(res, 401, { error: "Unauthorized" })
        return
      }
      if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) {
        res.setHeader("Allow", "GET, POST, DELETE, OPTIONS")
        writeJson(res, 405, { error: "Method not allowed" })
        return
      }

      const sessionId = headerValue(req, "mcp-session-id")
      let session = sessionId ? sessions.get(sessionId) : undefined
      let body: unknown

      if (req.method === "POST") {
        body = await readJsonBody(req)
      }

      if (!session) {
        if (sessionId) {
          writeJson(res, 404, {
            jsonrpc: "2.0",
            error: { code: -32001, message: "Unknown or expired MCP session" },
            id: null,
          })
          return
        }
        if (req.method !== "POST" || !isInitializeRequest(body)) {
          writeJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32000, message: "MCP session is not initialized" },
            id: null,
          })
          return
        }

        let transport!: StreamableHTTPServerTransport
        const mcpServer = createMcpServer()
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server: mcpServer })
          },
        })
        transport.onclose = () => {
          const sid = transport.sessionId
          if (sid) sessions.delete(sid)
        }
        await mcpServer.connect(transport)
        session = { transport, server: mcpServer }
      }

      await session.transport.handleRequest(req, res, body)
    } catch (error) {
      console.error("[MCP HTTP] request failed:", error)
      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        })
      } else if (!res.writableEnded) {
        res.end()
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    httpServer.once("error", onError)
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", onError)
      resolve()
    })
  })

  const localHealth = `http://127.0.0.1:${options.port}/health`
  const localMcp = `http://127.0.0.1:${options.port}${options.path}`
  console.error(`LLM Wiki MCP HTTP listening on ${options.host}:${options.port}${options.path}`)
  console.error(`Health: ${localHealth}`)
  console.error(`Local MCP: ${localMcp}`)
  if (options.host === "0.0.0.0") {
    if (lanAddresses.length === 0) {
      console.error("[MCP HTTP] 0.0.0.0 is active, but no non-loopback IPv4 address was detected.")
    } else {
      for (const address of lanAddresses) {
        console.error(`LAN MCP: http://${address}:${options.port}${options.path}`)
      }
    }
    if (!options.authToken) {
      console.error("[MCP HTTP] WARNING: LAN binding is enabled without LLM_WIKI_MCP_AUTH_TOKEN.")
    }
  }
}

type NetworkInterfaceSnapshot = Record<
  string,
  Array<{ address: string; family: string | number; internal: boolean }> | undefined
>

export function getLanIpv4Addresses(
  interfaces: NetworkInterfaceSnapshot = networkInterfaces() as NetworkInterfaceSnapshot,
): string[] {
  const addresses = new Set<string>()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = typeof entry.family === "string" ? entry.family : String(entry.family)
      if (!entry.internal && family === "IPv4") addresses.add(entry.address)
    }
  }
  return [...addresses].sort()
}

function buildHealthPayload(
  options: McpHttpOptions,
  lanAddresses: string[],
  sessions: number,
) {
  const localMcpUrl = `http://127.0.0.1:${options.port}${options.path}`
  return {
    status: "ok",
    transport: "streamable-http",
    listenHost: options.host,
    port: options.port,
    path: options.path,
    sessions,
    authEnabled: Boolean(options.authToken),
    localMcpUrl,
    lanMcpUrls: options.host === "0.0.0.0"
      ? lanAddresses.map((address) => `http://${address}:${options.port}${options.path}`)
      : [],
  }
}

function normalizeMcpPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return DEFAULT_HTTP_PATH
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  if (withSlash.includes("?") || withSlash.includes("#")) {
    throw new Error(`Invalid MCP HTTP path: ${value}`)
  }
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash
}

function valueArg(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === name) {
      const next = argv[i + 1]
      if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`)
      return next
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

function isAuthorized(req: IncomingMessage, token?: string): boolean {
  if (!token) return true
  const authorization = headerValue(req, "authorization")
  const apiKey = headerValue(req, "x-api-key")
  return authorization === `Bearer ${token}` || apiKey === token
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error("MCP HTTP request body is too large")
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  const raw = Buffer.concat(chunks).toString("utf8")
  return JSON.parse(raw)
}

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store")
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, X-API-Key, MCP-Session-Id, MCP-Protocol-Version",
  )
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.end(JSON.stringify(body))
}
