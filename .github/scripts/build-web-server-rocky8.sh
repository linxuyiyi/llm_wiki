#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
mkdir -p "$HOME"

EXPECTED_GLIBC="glibc 2.28"
ACTUAL_GLIBC="$(getconf GNU_LIBC_VERSION)"
if [ "$ACTUAL_GLIBC" != "$EXPECTED_GLIBC" ]; then
  echo "Expected build runtime '$EXPECTED_GLIBC', got '$ACTUAL_GLIBC'." >&2
  exit 1
fi

ARCH="$(uname -m)"
if [ "$ARCH" != "aarch64" ]; then
  echo "Expected native aarch64 build environment, got '$ARCH'." >&2
  exit 1
fi

echo "Building LLM Wiki Web Edition on $ACTUAL_GLIBC / $ARCH"

dnf -y install \
  binutils \
  ca-certificates \
  clang \
  cmake \
  curl \
  file \
  gcc \
  gcc-c++ \
  git \
  make \
  openssl-devel \
  perl \
  pkgconf-pkg-config \
  protobuf-compiler \
  python3 \
  tar \
  xz

update-ca-trust || true
git config --global --add safe.directory "$ROOT"

NODE_VERSION="${NODE_VERSION:-20.20.2}"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-arm64.tar.xz"
NODE_DIR="/opt/node-v${NODE_VERSION}-linux-arm64"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  curl -fsSLo "/tmp/$NODE_ARCHIVE" "https://nodejs.org/dist/v${NODE_VERSION}/$NODE_ARCHIVE"
  curl -fsSLo /tmp/SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  (
    cd /tmp
    grep " $NODE_ARCHIVE\$" SHASUMS256.txt | sha256sum -c -
  )
  mkdir -p "$NODE_DIR"
  tar -xJf "/tmp/$NODE_ARCHIVE" --strip-components=1 -C "$NODE_DIR"
fi
export PATH="$NODE_DIR/bin:$PATH"

node --version
npm --version
node -e 'const [major] = process.versions.node.split(".").map(Number); if (major < 20) process.exit(1)'

RUST_VERSION="${RUST_VERSION:-1.91.0}"
if [ ! -x "$HOME/.cargo/bin/rustc" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain "$RUST_VERSION"
fi
export PATH="$HOME/.cargo/bin:$PATH"
rustup default "$RUST_VERSION"
rustc --version
cargo --version

rm -rf "$ROOT/target-glibc228" "$ROOT/dist-web-server"

npm install
npm run build:web
npm --prefix mcp-server ci
npm run mcp:build
npm run mcp:test

export CARGO_TARGET_DIR="$ROOT/target-glibc228"
cargo build \
  --manifest-path src-tauri/Cargo.toml \
  --bin llm-wiki-server \
  --release \
  --no-default-features \
  --features server

SERVER_BIN="$CARGO_TARGET_DIR/release/llm-wiki-server"
file "$SERVER_BIN"
bash "$ROOT/.github/scripts/verify-glibc-baseline.sh" "$SERVER_BIN"

export LLM_WIKI_SERVER_BIN="$SERVER_BIN"
export LLM_WIKI_RELEASE_ARCH="aarch64"

bash "$ROOT/.github/scripts/smoke-web-edition.sh"
bash "$ROOT/.github/scripts/package-web-server.sh"
bash "$ROOT/.github/scripts/smoke-packaged-web-release.sh"

EXPECTED_TARBALL="$ROOT/dist-web-server/llm-wiki-web-0.6.11-linux-aarch64.tar.gz"
if [ ! -f "$EXPECTED_TARBALL" ]; then
  echo "Expected release package was not generated: $EXPECTED_TARBALL" >&2
  exit 1
fi

echo "Rocky Linux 8 / GLIBC 2.28 ARM64 release validation passed."
