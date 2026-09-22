#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${LLM_WIKI_DATA_DIR:-/var/lib/llm-wiki}"
HOST="${LLM_WIKI_WEB_HOST:-0.0.0.0}"
PORT="${LLM_WIKI_WEB_PORT:-8080}"
BACKEND_PORT="${LLM_WIKI_WEB_BACKEND_PORT:-19829}"
BACKEND_READY_TIMEOUT="${LLM_WIKI_BACKEND_READY_TIMEOUT:-30}"
BACKEND_LOG="${LLM_WIKI_BACKEND_LOG:-$DATA_DIR/llm-wiki-backend.log}"

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
touch "$BACKEND_LOG"

BACKEND_PID=""
GATEWAY_PID=""

cleanup() {
  local code=${1:-0}
  trap - EXIT INT TERM

  if [ -n "$GATEWAY_PID" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi
  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  exit "$code"
}

trap 'cleanup 130' INT
trap 'cleanup 143' TERM
trap 'cleanup $?' EXIT

"$ROOT/bin/llm-wiki-server" \
  --host 127.0.0.1 \
  --port "$BACKEND_PORT" \
  --data-dir "$DATA_DIR" \
  --web-dir "$ROOT/web" \
  >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

echo "Starting LLM Wiki backend on 127.0.0.1:$BACKEND_PORT (pid=$BACKEND_PID)"

deadline=$((SECONDS + BACKEND_READY_TIMEOUT))
backend_ready=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    set +e
    wait "$BACKEND_PID"
    backend_code=$?
    set -e
    echo "LLM Wiki backend exited before becoming ready (exit=$backend_code)." >&2
    echo "---- backend log ----" >&2
    tail -n 200 "$BACKEND_LOG" >&2 || true
    echo "---------------------" >&2
    BACKEND_PID=""
    exit ${backend_code:-1}
  fi

  if node -e '
    const port = Number(process.argv[1]);
    const http = require("node:http");
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        let ok = res.statusCode === 200;
        try {
          const parsed = JSON.parse(body);
          ok = ok && parsed && parsed.status === "running";
        } catch {
          ok = false;
        }
        process.exit(ok ? 0 : 1);
      });
    });
    req.on("timeout", () => { req.destroy(); });
    req.on("error", () => process.exit(1));
  ' "$BACKEND_PORT" >/dev/null 2>&1; then
    backend_ready=1
    break
  fi

  sleep 0.25
done

if [ "$backend_ready" -ne 1 ]; then
  echo "LLM Wiki backend did not become ready within ${BACKEND_READY_TIMEOUT}s." >&2
  echo "---- backend log ----" >&2
  tail -n 200 "$BACKEND_LOG" >&2 || true
  echo "---------------------" >&2
  exit 1
fi

echo "LLM Wiki backend ready: http://127.0.0.1:$BACKEND_PORT"

export LLM_WIKI_API_BASE_URL="http://127.0.0.1:$BACKEND_PORT"

node "$ROOT/gateway/dist/src/web-gateway.js" \
  --host "$HOST" \
  --port "$PORT" \
  --backend "$LLM_WIKI_API_BASE_URL" \
  --web-dir "$ROOT/web" &
GATEWAY_PID=$!

echo "LLM Wiki Web gateway ready to serve on $HOST:$PORT (pid=$GATEWAY_PID)"

set +e
wait "$GATEWAY_PID"
gateway_code=$?
set -e
GATEWAY_PID=""

if [ "$gateway_code" -ne 0 ]; then
  echo "LLM Wiki Web gateway exited with code $gateway_code." >&2
fi

cleanup "$gateway_code"
