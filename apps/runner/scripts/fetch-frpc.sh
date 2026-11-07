#!/usr/bin/env bash
# Vendors `frpc-{linux,darwin}-{amd64,arm64}` into apps/runner/vendor/. Called
# by `prepublishOnly` so we always ship the pinned version. Safe to re-run.
# Agents run on the host now, so the runner's own platform is what matters.
set -euo pipefail

FRP_VERSION="${FRP_VERSION:-0.66.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"

mkdir -p "$VENDOR"

fetch() {
  local os="$1"
  local arch="$2"
  local out="$VENDOR/frpc-$os-$arch"
  if [ -f "$out" ]; then
    echo "have $out (skip; delete to refresh)"
    return
  fi
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  local url="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_${os}_${arch}.tar.gz"
  echo "fetch $url"
  curl -fsSL "$url" -o "$tmp/frp.tar.gz"
  tar -xzf "$tmp/frp.tar.gz" -C "$tmp"
  mv "$tmp/frp_${FRP_VERSION}_${os}_${arch}/frpc" "$out"
  chmod +x "$out"
  echo "wrote $out"
}

for os in linux darwin; do
  fetch "$os" amd64
  fetch "$os" arm64
done
