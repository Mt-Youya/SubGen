# 语言要求
所有回答都使用中文。无论上下文有多长都使用中文回答。这是第一优先级，整个项目的重中之重，绝对的核心。
Output with CHINESE.

# SubGen

端到端字幕生成工具集：Tauri 桌面应用 + Web 前端 + Rust 音频提取 CLI。

- **desktop** (`packages/desktop`): Tauri v2 + Next.js 桌面应用，本地 Whisper ASR + 云端翻译
- **web** (`packages/web`): Next.js 纯 Web 版，云端 ASR + 翻译
- **extractor** (`extractor/`): Rust CLI 工具 `subextract`，从媒体文件提取音频

## 关键路径

| 路径 | 说明 |
|------|------|
| `packages/desktop/src-tauri/src/commands.rs` | 所有 Rust 命令（转录、翻译、依赖检查、GPU 下载/安装） |
| `packages/desktop/src-tauri/src/lib.rs` | Tauri 命令注册 |
| `packages/desktop/src-tauri/src/gpu.rs` | GPU 检测模块（CUDA/Vulkan/Metal 跨平台） |
| `packages/desktop/app/page.tsx` | 桌面版首页（依赖检查 + Tab 切换 + ThemeToggle） |
| `packages/desktop/components/DesktopSubtitlePanel.tsx` | 字幕生成面板（设置 + 文件列表 + 结果 + 停止/重试） |
| `packages/desktop/components/ExtractPanel.tsx` | 音频提取面板（多文件/文件夹 + 进度 + 结果） |
| `packages/web/app/globals.css` | 全局 CSS 变量（配色 / 字体 / 圆角，dark/light/system 三主题） |
| `packages/web/components/ui/ThemeToggle.tsx` | 主题切换组件（浅色/深色/跟随系统，持久化 localStorage） |
| `packages/desktop/src-tauri/tauri.windows.conf.json` | Windows 平台 bundle 资源声明 |
| `packages/desktop/src-tauri/tauri.macos.conf.json` | macOS 平台 bundle 资源声明 |
| `packages/desktop/src-tauri/tauri.linux.conf.json` | Linux 平台 bundle 资源声明 |
| `packages/desktop/src-tauri/.cargo/config.toml` | Rust 链接器配置（`rust-lld`） |
| `.github/workflows/build-desktop.yml` | Desktop CI（tag: `desktop-v*`）；Linux whisper.cpp tag 取失败时 fallback 到 v1.8.4 |
| `.github/workflows/build-whisper-gpu.yml` | GPU 二进制构建 CI（CUDA/Vulkan for Win/Linux，tag 触发 + workflow_dispatch） |
| `.github/workflows/build-extractor.yml` | Extractor CI（tag: `extractor-v*`） |

## 桌面版依赖

| 依赖 | 开发模式位置 | 打包后位置 |
|------|-------------|-----------|
| `whisper-server.exe` | `src-tauri/resources/`（gitignored） | 应用 resource 目录 |
| `whisper-cli.exe` | 同上 | 同上 |
| `whisper.dll` `ggml*.dll` | 同上 | 同上 |
| `ffmpeg.exe` | 同上 | 同上 |
| `ggml-small.bin`（模型） | `~/.subgen_cache/models/` | 同路径 |
| GPU 加速版 whisper | `~/.subgen_cache/bin/` | 同路径（首次启动按需下载） |

二进制文件由 CI 下载或用户通过 UI 授权安装。

# [CLAUDE.md](https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md)

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.