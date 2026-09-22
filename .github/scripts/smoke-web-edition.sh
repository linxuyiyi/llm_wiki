#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA_DIR="${LLM_WIKI_SMOKE_DATA_DIR:-/tmp/llm-wiki-web-test}"
BACKEND_PORT="${LLM_WIKI_SMOKE_BACKEND_PORT:-19829}"
WEB_PORT="${LLM_WIKI_SMOKE_WEB_PORT:-8080}"
FAKE_LLM_PORT=19000
SERVER_BIN="${LLM_WIKI_SERVER_BIN:-$ROOT/src-tauri/target/release/llm-wiki-server}"

if [ ! -x "$SERVER_BIN" ]; then
  echo "llm-wiki-server is missing or not executable: $SERVER_BIN" >&2
  exit 1
fi

rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR/projects"

python3 "$ROOT/.github/scripts/fake-openai-server.py" >/tmp/llm-wiki-fake-llm.log 2>&1 &
FAKE_PID=$!

"$SERVER_BIN" \
  --host 127.0.0.1 \
  --port "$BACKEND_PORT" \
  --data-dir "$DATA_DIR" \
  --web-dir "$ROOT/dist-web" >/tmp/llm-wiki-server.log 2>&1 &
BACKEND_PID=$!

LLM_WIKI_API_BASE_URL="http://127.0.0.1:$BACKEND_PORT" \
  node "$ROOT/mcp-server/dist/src/web-gateway.js" \
    --host 127.0.0.1 \
    --port "$WEB_PORT" \
    --backend "http://127.0.0.1:$BACKEND_PORT" \
    --web-dir "$ROOT/dist-web" >/tmp/llm-wiki-gateway.log 2>&1 &
GATEWAY_PID=$!

cleanup() {
  kill "$GATEWAY_PID" "$BACKEND_PID" "$FAKE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$WEB_PORT/api/v1/health" >/tmp/llm-wiki-health.json; then
    break
  fi
  sleep 1
done

grep -q '"status":"running"' /tmp/llm-wiki-health.json
curl -fsS "http://127.0.0.1:$WEB_PORT/" | grep -qi '<html'
curl -fsS "http://127.0.0.1:$WEB_PORT/health" | grep -q '"transport":"streamable-http"'

curl -fsS \
  -H 'Content-Type: application/json' \
  -d '{"command":"create_project","args":{"name":"smoke","path":"'"$DATA_DIR"'/projects"}}' \
  "http://127.0.0.1:$WEB_PORT/api/web/invoke" \
  | grep -q '"ok":true'

PROJECT="$DATA_DIR/projects/smoke"

curl -fsS -H 'Content-Type: application/json' \
  -d '{"command":"create_directory","args":{"path":"'"$PROJECT"'/.llm-wiki"}}' \
  "http://127.0.0.1:$WEB_PORT/api/web/invoke" >/dev/null

curl -fsS -H 'Content-Type: application/json' \
  -d '{"command":"write_file","args":{"path":"'"$PROJECT"'/.llm-wiki/project.json","contents":"{\"id\":\"smoke-id\",\"createdAt\":1}"}}' \
  "http://127.0.0.1:$WEB_PORT/api/web/invoke" >/dev/null

curl -fsS -H 'Content-Type: application/json' \
  -d '{"name":"app-state.json","op":"set","key":"recentProjects","value":[{"id":"smoke-id","name":"smoke","path":"'"$PROJECT"'"}]}' \
  "http://127.0.0.1:$WEB_PORT/api/web/store" >/dev/null

curl -fsS -H 'Content-Type: application/json' \
  -d '{"name":"app-state.json","op":"set","key":"lastProject","value":{"id":"smoke-id","name":"smoke","path":"'"$PROJECT"'"}}' \
  "http://127.0.0.1:$WEB_PORT/api/web/store" >/dev/null

curl -fsS -X PUT -H 'Content-Type: application/json' \
  -d '{"path":"smoke/source.md","content":"ARM Web Edition source smoke test"}' \
  "http://127.0.0.1:$WEB_PORT/api/v1/projects/smoke-id/sources/file" \
  | tee /tmp/llm-wiki-source.json \
  | grep -q '"ok":true'

curl -fsS -H 'Content-Type: application/json' \
  -d '{"query":"Project","topK":5,"includeContent":false}' \
  "http://127.0.0.1:$WEB_PORT/api/v1/projects/smoke-id/search" \
  | tee /tmp/llm-wiki-search.json \
  | grep -q '"ok":true'

curl -fsS "http://127.0.0.1:$WEB_PORT/api/v1/projects" | grep -q '"smoke-id"'

cat >/tmp/llm-wiki-agent-request.json <<EOF
{
  "projectId": "smoke-id",
  "llmConfig": {
    "provider": "custom",
    "apiKey": "fake-key",
    "model": "fake-model",
    "customEndpoint": "http://127.0.0.1:$FAKE_LLM_PORT"
  },
  "request": {
    "message": "Return the deterministic smoke response.",
    "sessionId": "smoke-session",
    "runId": "smoke-run",
    "mode": "standard",
    "retrievalMode": "standard",
    "tools": {
      "wiki": true,
      "web": false,
      "anytxt": false
    },
    "history": [],
    "historyExplicit": true,
    "skills": [],
    "contextFiles": [],
    "skillMode": "auto",
    "persistSession": true,
    "stream": true
  }
}
EOF

curl -fsS -N \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  --data-binary @/tmp/llm-wiki-agent-request.json \
  "http://127.0.0.1:$WEB_PORT/api/web/agent/stream" \
  | tee /tmp/llm-wiki-agent.sse

grep -q 'web-agent-ok' /tmp/llm-wiki-agent.sse
grep -q 'messageDelta' /tmp/llm-wiki-agent.sse
grep -q 'event: done' /tmp/llm-wiki-agent.sse
grep -q 'web-agent-ok' "$PROJECT/.llm-wiki/agent-sessions/smoke-session.json"

echo "Unified Web UI/API/MCP/Agent smoke test passed"
