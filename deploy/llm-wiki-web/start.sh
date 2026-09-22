#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${LLM_WIKI_DATA_DIR:-/var/lib/llm-wiki}"
HOST="${LLM_WIKI_WEB_HOST:-0.0.0.0}"
PORT="${LLM_WIKI_WEB_PORT:-8080}"
BACKEND_PORT="${LLM_WIKI_WEB_BACKEND_PORT:-19829}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 20 is required to run the unified MCP/Web gateway." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js >= 20 is required; found $(node --version)." >&2
  exit 1
fi

mkdir -p "$DATA_DIR"

"$ROOT/bin/llm-wiki-server"   --host 127.0.0.1   --port "$BACKEND_PORT"   --data-dir "$DATA_DIR"   --web-dir "$ROOT/web" &
BACKEND_PID=$!

cleanup() {
  kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

export LLM_WIKI_API_BASE_URL="http://127.0.0.1:$BACKEND_PORT"
exec node "$ROOT/gateway/dist/src/web-gateway.js"   --host "$HOST"   --port "$PORT"   --backend "$LLM_WIKI_API_BASE_URL"   --web-dir "$ROOT/web"
