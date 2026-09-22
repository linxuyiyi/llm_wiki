#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARBALL="$ROOT/dist-web-server/llm-wiki-web-0.6.11-linux-aarch64.tar.gz"
PACKAGE_NAME="llm-wiki-web-0.6.11-linux-aarch64"
TEST_ROOT="/tmp/llm-wiki-packaged-release-test"
DATA_DIR="$TEST_ROOT/data"

if [ ! -f "$TARBALL" ]; then
  echo "Release tarball not found: $TARBALL" >&2
  exit 1
fi

rm -rf "$TEST_ROOT"
mkdir -p "$TEST_ROOT"
tar -xzf "$TARBALL" -C "$TEST_ROOT"

PACKAGE_ROOT="$TEST_ROOT/$PACKAGE_NAME"
if [ ! -x "$PACKAGE_ROOT/bin/llm-wiki-server" ]; then
  echo "Packaged backend is missing or not executable." >&2
  exit 1
fi

(
  cd "$PACKAGE_ROOT"
  LLM_WIKI_DATA_DIR="$DATA_DIR" \
  LLM_WIKI_WEB_HOST=0.0.0.0 \
  LLM_WIKI_WEB_PORT=8080 \
  LLM_WIKI_WEB_BACKEND_PORT=19829 \
  LLM_WIKI_BACKEND_READY_TIMEOUT=30 \
  bash ./start.sh
) >/tmp/llm-wiki-packaged-start.log 2>&1 &
START_PID=$!

cleanup() {
  kill "$START_PID" 2>/dev/null || true
  wait "$START_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ready=0
for _ in $(seq 1 120); do
  if ! kill -0 "$START_PID" 2>/dev/null; then
    echo "Packaged start.sh exited before the unified endpoint became ready." >&2
    cat /tmp/llm-wiki-packaged-start.log >&2 || true
    exit 1
  fi
  if curl -fsS http://127.0.0.1:8080/api/v1/health >/tmp/packaged-api-health.json; then
    ready=1
    break
  fi
  sleep 0.25
done

if [ "$ready" -ne 1 ]; then
  echo "Packaged Web Edition did not become ready." >&2
  cat /tmp/llm-wiki-packaged-start.log >&2 || true
  exit 1
fi

grep -q '"status":"running"' /tmp/packaged-api-health.json
curl -fsS http://127.0.0.1:8080/ | grep -qi '<html'
curl -fsS http://127.0.0.1:8080/health | grep -q '"transport":"streamable-http"'
curl -fsS http://127.0.0.1:19829/health | grep -q '"status":"running"'

cleanup
trap - EXIT INT TERM

# Fail-fast regression: a dead backend must prevent the Node gateway from
# starting, and start.sh must return non-zero.
FAIL_ROOT="$TEST_ROOT/fail-fast"
FAIL_DATA="$FAIL_ROOT/data"
GATEWAY_MARKER="$FAIL_ROOT/gateway-started"
mkdir -p "$FAIL_ROOT/bin" "$FAIL_ROOT/gateway/dist/src" "$FAIL_ROOT/web" "$FAIL_DATA"
cp "$PACKAGE_ROOT/start.sh" "$FAIL_ROOT/start.sh"

cat >"$FAIL_ROOT/bin/llm-wiki-server" <<'EOF'
#!/usr/bin/env bash
echo "intentional backend startup failure" >&2
exit 42
EOF
chmod +x "$FAIL_ROOT/bin/llm-wiki-server"

cat >"$FAIL_ROOT/gateway/dist/src/web-gateway.js" <<EOF
const fs = require("node:fs");
fs.writeFileSync("$GATEWAY_MARKER", "gateway should not have started");
process.exit(99);
EOF

set +e
(
  cd "$FAIL_ROOT"
  LLM_WIKI_DATA_DIR="$FAIL_DATA" \
  LLM_WIKI_WEB_PORT=18080 \
  LLM_WIKI_WEB_BACKEND_PORT=19839 \
  LLM_WIKI_BACKEND_READY_TIMEOUT=5 \
  bash ./start.sh
) >/tmp/llm-wiki-fail-fast.log 2>&1
fail_code=$?
set -e

if [ "$fail_code" -eq 0 ]; then
  echo "start.sh incorrectly returned success for a failed backend." >&2
  cat /tmp/llm-wiki-fail-fast.log >&2 || true
  exit 1
fi

if [ -e "$GATEWAY_MARKER" ]; then
  echo "Node gateway started even though backend failed." >&2
  cat /tmp/llm-wiki-fail-fast.log >&2 || true
  exit 1
fi

grep -q "backend exited before becoming ready" /tmp/llm-wiki-fail-fast.log
grep -q "intentional backend startup failure" /tmp/llm-wiki-fail-fast.log

echo "Packaged start.sh readiness and fail-fast validation passed."
