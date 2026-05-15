---
name: dev
description: 启动 SubGen 开发环境（Web 前端 / Tauri 桌面应用 / extractor CLI）
---

SubGen 支持三种开发模式。

## Tauri 桌面应用（主开发模式）

```bash
pnpm dev:desktop
# 或
cd packages/desktop && pnpm dev
```

- Rust 后端：自动编译（`cargo run`）
- Next.js 前端：http://localhost:3001
- 首次启动需授权安装 ffmpeg + Whisper 模型（UI 引导）
- 依赖：`publish/whisper-cli.exe` + `publish/ffmpeg.exe`（由 CI 下载或手动放入 `resources/`）

## Web 前端（独立 Next.js）

```bash
pnpm dev:web
# 或
cd packages/web && pnpm dev
```

> Web 模式调用云端 ASR/翻译 API，不走本地 Whisper。

## Extractor CLI（纯 Rust）

```bash
cd extractor && cargo run --release -- input.mp4 -o ./output
```

跨平台媒体文件音频提取，发布流程见 `.github/workflows/build-extractor.yml`。

## 验证

- Tauri 桌面：窗口打开后访问 http://localhost:3001，或在应用内操作
- Web 前端：http://localhost:3000
- Extractor：`cd extractor && cargo run -- --help`

## 常见问题

- **端口 3001 占用**：`taskkill /PID <pid> /F`（Win）或 `lsof -ti:3001 | xargs kill`
- **whisper-cli / ffmpeg 未找到**：启动后 UI 会提示下载，或手动放到 `packages/desktop/src-tauri/resources/`
- **Rust 编译失败（dlltool / gcc）**：需 `m2w64-binutils` + `m2w64-gcc`（conda），或切换到 MSVC 工具链
- **cdylib 导出符号超限**：`Cargo.toml` 中 `crate-type` 只保留 `["staticlib", "rlib"]`
- **Windows 链接 `GetHostNameW` 失败**：`.cargo/config.toml` 已配置 `rust-lld` 替代旧版 MinGW ld
