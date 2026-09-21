import { copyFileSync, mkdirSync, chmodSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const runtimeDir = join(root, "mcp-server", "runtime")
const target = join(runtimeDir, process.platform === "win32" ? "node.exe" : "node")

mkdirSync(runtimeDir, { recursive: true })
copyFileSync(process.execPath, target)
if (process.platform !== "win32") {
  chmodSync(target, 0o755)
}
console.log(`Prepared bundled Node runtime: ${target}`)
