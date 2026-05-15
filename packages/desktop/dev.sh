#!/bin/sh
# macOS 开发启动脚本：编译 → 签名 → 启动 Tauri dev
set -e

# 启动 Next.js dev server（后台）
pnpm dev:next &
NEXT_PID=$!

# 等待 Next.js 就绪
echo "等待 Next.js 启动..."
until curl -s http://localhost:3001 > /dev/null 2>&1; do sleep 0.5; done
echo "Next.js 已就绪"

# 编译 Rust
cargo build --manifest-path src-tauri/Cargo.toml

# 对 debug 二进制签名（解决 macOS WebKit 沙箱限制）
codesign --force --deep --sign - src-tauri/target/debug/subgen-desktop

# 启动 Tauri（跳过 beforeDevCommand，直接用已启动的 Next.js）
TAURI_SKIP_DEVSERVER_CHECK=true pnpm tauri dev

# 清理
kill $NEXT_PID 2>/dev/null || true
