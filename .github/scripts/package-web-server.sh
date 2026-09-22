#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCH="$(uname -m)"
OUT_DIR="$ROOT/dist-web-server"
PKG_NAME="llm-wiki-web-${VERSION}-linux-${ARCH}"
STAGE="$OUT_DIR/$PKG_NAME"

rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/web" "$STAGE/gateway"

cp "$ROOT/src-tauri/target/release/llm-wiki-server" "$STAGE/bin/"
cp -R "$ROOT/dist-web/." "$STAGE/web/"
cp -R "$ROOT/mcp-server/dist" "$STAGE/gateway/"
cp "$ROOT/mcp-server/package.json" "$ROOT/mcp-server/package-lock.json" "$STAGE/gateway/"

(
  cd "$STAGE/gateway"
  npm ci --omit=dev --ignore-scripts
)

cp "$ROOT/deploy/llm-wiki-web/start.sh" "$STAGE/start.sh"
cp "$ROOT/deploy/llm-wiki-web/llm-wiki-web.service" "$STAGE/llm-wiki-web.service"
chmod +x "$STAGE/start.sh" "$STAGE/bin/llm-wiki-server"

cat > "$STAGE/README.txt" <<EOF
LLM Wiki Web Edition $VERSION

Requirements:
- Linux $ARCH
- Node.js >= 20

Start:
  LLM_WIKI_DATA_DIR=/var/lib/llm-wiki ./start.sh

Default unified endpoint:
  Web UI: http://<host>:8080/
  HTTP API: http://<host>:8080/api/v1/
  HTTP MCP: http://<host>:8080/mcp

The Rust backend listens only on 127.0.0.1:19829 by default.
EOF

mkdir -p "$OUT_DIR"
tar -C "$OUT_DIR" -czf "$OUT_DIR/$PKG_NAME.tar.gz" "$PKG_NAME"
sha256sum "$OUT_DIR/$PKG_NAME.tar.gz" > "$OUT_DIR/$PKG_NAME.tar.gz.sha256"
ls -lh "$OUT_DIR/$PKG_NAME.tar.gz" "$OUT_DIR/$PKG_NAME.tar.gz.sha256"
