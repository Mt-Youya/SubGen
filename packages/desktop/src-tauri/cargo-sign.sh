#!/bin/sh
# tauri dev --runner 的替代脚本
# 先用 cargo build，然后对二进制签名
set -e
cargo "$@"
# 签名 debug 二进制
BINARY="target/debug/subgen-desktop"
if [ -f "$BINARY" ]; then
  ENTITLEMENTS="$(dirname "$0")/entitlements.debug.plist"
  if [ -f "$ENTITLEMENTS" ]; then
    codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" "$BINARY" 2>/dev/null || true
  else
    codesign --force --deep --sign - "$BINARY" 2>/dev/null || true
  fi
fi
