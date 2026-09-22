import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { resolve } from "node:path"

const args = process.argv.slice(2)

function valueArg(name, fallback) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === name) return args[i + 1] ?? fallback
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return fallback
}

const host = valueArg("--host", process.env.LLM_WIKI_WEB_HOST || "0.0.0.0")
const port = valueArg("--port", process.env.LLM_WIKI_WEB_PORT || "8080")
const backendHost = "127.0.0.1"
const backendPort = valueArg("--backend-port", process.env.LLM_WIKI_WEB_BACKEND_PORT || "19829")
const dataDir = valueArg("--data-dir", process.env.LLM_WIKI_DATA_DIR || resolve("data/llm-wiki"))
const webDir = valueArg("--web-dir", process.env.LLM_WIKI_WEB_DIR || resolve("dist-web"))
const gatewayEntry = resolve("mcp-server/dist/src/web-gateway.js")

if (!existsSync(gatewayEntry)) {
  throw new Error("Web gateway is not built. Run npm run mcp:build first.")
}

const explicitBackend = valueArg("--backend-bin", process.env.LLM_WIKI_WEB_BACKEND_BIN)
const releaseBackend = resolve(
  "src-tauri/target/release",
  process.platform === "win32" ? "llm-wiki-server.exe" : "llm-wiki-server",
)
const backendCommand = explicitBackend || (existsSync(releaseBackend) ? releaseBackend : null)

const backendArgs = [
  "--host", backendHost,
  "--port", backendPort,
  "--data-dir", dataDir,
  "--web-dir", webDir,
]

let backend
if (backendCommand) {
  backend = spawn(backendCommand, backendArgs, { stdio: "inherit", env: process.env })
} else {
  backend = spawn(
    "cargo",
    [
      "run",
      "--manifest-path", "src-tauri/Cargo.toml",
      "--bin", "llm-wiki-server",
      "--",
      ...backendArgs,
    ],
    { stdio: "inherit", env: process.env },
  )
}

const gateway = spawn(
  process.execPath,
  [
    gatewayEntry,
    "--host", host,
    "--port", port,
    "--backend", `http://${backendHost}:${backendPort}`,
    "--web-dir", webDir,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      LLM_WIKI_API_BASE_URL: `http://${backendHost}:${backendPort}`,
    },
  },
)

let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  gateway.kill("SIGTERM")
  backend.kill("SIGTERM")
  setTimeout(() => process.exit(code), 500).unref()
}

gateway.on("exit", (code) => {
  if (!shuttingDown) shutdown(code ?? 1)
})
backend.on("exit", (code) => {
  if (!shuttingDown) shutdown(code ?? 1)
})

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))

console.error(`LLM Wiki Web starting at http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`)
console.error(`Data directory: ${dataDir}`)
