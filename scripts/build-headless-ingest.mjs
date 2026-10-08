import { build } from 'esbuild'
import { resolve } from 'node:path'
const root = process.cwd()
const shim = file => resolve(root, 'src/web', file)
await build({
  entryPoints: ['src/server/ingest-worker.ts'],
  outfile: 'mcp-server/dist/src/ingest-worker.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  alias: {
    '@': resolve(root, 'src'),
    '@/lib/ingest-queue': resolve(root, 'src/server/ingest-queue.ts'),
    '@/lib/tauri-fetch': resolve(root, 'src/server/tauri-fetch.ts'),
    '@tauri-apps/api/core': shim('tauri-core.ts'),
    '@tauri-apps/api/event': shim('tauri-event.ts'),
    '@tauri-apps/plugin-store': shim('tauri-store.ts'),
    '@tauri-apps/plugin-http': shim('tauri-http.ts'),
    '@tauri-apps/plugin-opener': shim('tauri-opener.ts'),
    '@tauri-apps/plugin-dialog': shim('tauri-dialog.ts'),
  },
  define: { 'import.meta.env': '{"VITE_LLM_WIKI_RUNTIME":"headless","DEV":false}', '__APP_VERSION__': '"0.6.11"' },
})
