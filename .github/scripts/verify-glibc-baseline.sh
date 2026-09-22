#!/usr/bin/env bash
set -euo pipefail

BIN="${1:-}"
if [ -z "$BIN" ] || [ ! -f "$BIN" ]; then
  echo "Usage: $0 <ELF binary>" >&2
  exit 2
fi

if ! command -v readelf >/dev/null 2>&1; then
  echo "readelf is required for GLIBC compatibility validation." >&2
  exit 2
fi

machine="$(readelf -h "$BIN" | awk -F: '/Machine:/ {gsub(/^[[:space:]]+/, "", $2); print $2; exit}')"
if [ "$machine" != "AArch64" ]; then
  echo "Release binary must be AArch64; readelf reports: $machine" >&2
  exit 1
fi

versions="$(
  readelf --version-info "$BIN" 2>/dev/null     | grep -oE 'GLIBC_[0-9]+\.[0-9]+'     | sort -Vu     || true
)"

if [ -z "$versions" ]; then
  echo "No GLIBC symbol versions found in $BIN; refusing to publish an unverified binary." >&2
  exit 1
fi

bad="$(
  printf '%s\n' "$versions"     | sed 's/^GLIBC_//'     | awk -F. '$1 > 2 || ($1 == 2 && $2 > 28) { print "GLIBC_" $0 }'
)"

echo "GLIBC symbol requirements for $BIN:"
printf '  %s\n' $versions

if [ -n "$bad" ]; then
  echo "ERROR: binary exceeds GLIBC 2.28 compatibility baseline:" >&2
  printf '  %s\n' $bad >&2
  exit 1
fi

max_version="$(printf '%s\n' "$versions" | sort -V | tail -n 1)"
echo "PASS: AArch64 binary maximum GLIBC requirement is $max_version (baseline <= GLIBC_2.28)."
