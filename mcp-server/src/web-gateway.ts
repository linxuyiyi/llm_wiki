#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs"
import { extname, resolve, sep } from "node:path"
import { request as httpRequest } from "node:http"
import { fileURLToPath } from "node:url"

import { createMcpServer } from "./index.js"
import { startHttpMcpServer, type McpHttpFallbackHandler } from "./http-server.js"

interface GatewayOptions {
  host: string
  port: number
  backendUrl: URL
  webDir: string
  authToken?: string
}

function valueArg(argv: string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === name) {
      const next = argv[index + 1]
      if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`)
      return next
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function parseOptions(argv = process.argv.slice(2), env = process.env): GatewayOptions {
  const host = valueArg(argv, "--host") ?? env.LLM_WIKI_WEB_HOST ?? "0.0.0.0"
  const portText = valueArg(argv, "--port") ?? env.LLM_WIKI_WEB_PORT ?? "8080"
  const port = Number.parseInt(portText, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid web port: ${portText}`)
  }

  const backendText = valueArg(argv, "--backend")
    ?? env.LLM_WIKI_WEB_BACKEND_URL
    ?? "http://127.0.0.1:19829"
  const backendUrl = new URL(backendText)
  if (backendUrl.protocol !== "http:") {
    throw new Error("The internal LLM Wiki backend must use http://")
  }

  const here = resolve(fileURLToPath(new URL("..", import.meta.url)))
  const defaultWebDir = resolve(here, "../../../dist-web")
  const webDir = resolve(valueArg(argv, "--web-dir") ?? env.LLM_WIKI_WEB_DIR ?? defaultWebDir)
  const authToken = (env.LLM_WIKI_MCP_AUTH_TOKEN ?? "").trim() || undefined

  return { host, port, backendUrl, webDir, authToken }
}

function createFallback(options: GatewayOptions): McpHttpFallbackHandler {
  return async (req, res, url) => {
    if (url.pathname.startsWith("/api/")) {
      proxyToBackend(req, res, options.backendUrl)
      return true
    }

    if (!["GET", "HEAD"].includes(req.method ?? "")) return false
    serveStatic(res, options.webDir, url.pathname, req.method === "HEAD")
    return true
  }
}

function proxyToBackend(
  req: Parameters<McpHttpFallbackHandler>[0],
  res: Parameters<McpHttpFallbackHandler>[1],
  backendUrl: URL,
): void {
  const target = new URL(req.url ?? "/", backendUrl)
  const headers = { ...req.headers }
  delete headers.host
  delete headers.connection

  const upstream = httpRequest(
    target,
    {
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode ?? 502
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined && name.toLowerCase() !== "connection") {
          res.setHeader(name, value)
        }
      }
      upstreamRes.pipe(res)
    },
  )

  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.statusCode = 502
      res.setHeader("Content-Type", "application/json; charset=utf-8")
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ ok: false, error: `Backend unavailable: ${error.message}` }))
    }
  })

  req.pipe(upstream)
}

function serveStatic(
  res: Parameters<McpHttpFallbackHandler>[1],
  webDir: string,
  pathname: string,
  headOnly: boolean,
): void {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    res.statusCode = 400
    res.end("Bad request")
    return
  }

  const relative = decoded.replace(/^\/+/, "")
  const candidate = resolve(webDir, relative || "index.html")
  const root = resolve(webDir)
  const insideRoot = candidate === root || candidate.startsWith(`${root}${sep}`)
  if (!insideRoot) {
    res.statusCode = 403
    res.end("Forbidden")
    return
  }

  let target = candidate
  if (!existsSync(target) || !statSync(target).isFile()) {
    target = resolve(webDir, "index.html")
  }

  if (!existsSync(target) || !statSync(target).isFile()) {
    res.statusCode = 503
    res.setHeader("Content-Type", "application/json; charset=utf-8")
    res.end(JSON.stringify({
      ok: false,
      error: "Web UI is not built. Run npm run build:web.",
    }))
    return
  }

  res.statusCode = 200
  res.setHeader("Content-Type", contentType(target))
  res.setHeader(
    "Cache-Control",
    target.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  )
  res.setHeader("X-Content-Type-Options", "nosniff")
  if (headOnly) {
    res.end()
    return
  }
  createReadStream(target)
    .on("error", () => {
      if (!res.headersSent) res.statusCode = 500
      if (!res.writableEnded) res.end()
    })
    .pipe(res)
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8"
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8"
    case ".css": return "text/css; charset=utf-8"
    case ".json": return "application/json; charset=utf-8"
    case ".svg": return "image/svg+xml"
    case ".png": return "image/png"
    case ".jpg":
    case ".jpeg": return "image/jpeg"
    case ".gif": return "image/gif"
    case ".webp": return "image/webp"
    case ".ico": return "image/x-icon"
    case ".woff": return "font/woff"
    case ".woff2": return "font/woff2"
    default: return "application/octet-stream"
  }
}

async function main(): Promise<void> {
  const options = parseOptions()
  process.env.LLM_WIKI_API_BASE_URL = options.backendUrl.toString().replace(/\/+$/, "")

  await startHttpMcpServer(
    createMcpServer,
    {
      host: options.host,
      port: options.port,
      path: "/mcp",
      authToken: options.authToken,
    },
    createFallback(options),
  )

  console.error(`LLM Wiki Web UI: http://127.0.0.1:${options.port}/`)
  console.error(`LLM Wiki API: http://127.0.0.1:${options.port}/api/v1`)
  console.error(`LLM Wiki MCP: http://127.0.0.1:${options.port}/mcp`)
  console.error(`Internal backend: ${options.backendUrl.toString()}`)
}

main().catch((error) => {
  console.error("Failed to start LLM Wiki Web gateway:", error)
  process.exit(1)
})
