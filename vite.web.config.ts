import path from "path"
import { readFileSync } from "fs"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const pkgJson = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"))
const shim = (file: string) => path.resolve(__dirname, "src/web", file)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: shim("tauri-core.ts") },
      { find: "@tauri-apps/api/event", replacement: shim("tauri-event.ts") },
      { find: "@tauri-apps/api/window", replacement: shim("tauri-window.ts") },
      { find: "@tauri-apps/plugin-store", replacement: shim("tauri-store.ts") },
      { find: "@tauri-apps/plugin-dialog", replacement: shim("tauri-dialog.ts") },
      { find: "@tauri-apps/plugin-http", replacement: shim("tauri-http.ts") },
      { find: "@tauri-apps/plugin-opener", replacement: shim("tauri-opener.ts") },
      { find: "@tauri-apps/plugin-autostart", replacement: shim("tauri-autostart.ts") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkgJson.version),
    "import.meta.env.VITE_LLM_WIKI_RUNTIME": JSON.stringify("web"),
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/mcp": "http://127.0.0.1:8080",
      "/health": "http://127.0.0.1:8080",
    },
  },
})
