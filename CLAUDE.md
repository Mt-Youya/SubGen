<!-- HIGHEST PRIORITY RULE -->
## 🔴 语言规则（最高优先级）
**必须用简体中文回答所有问题，无例外。**
- 代码注释可以用英文
- 所有解释、分析、建议必须是中文
- 即使用户用英文提问，也用中文回答

# SubGen

端到端字幕生成工具集：Tauri 桌面应用 + Web 前端 + Rust 音频提取 CLI。

- **desktop** (`apps/desktop`): Tauri v2 + Next.js 桌面应用，本地 Whisper ASR + 云端翻译
- **web** (`apps/web`): Next.js 纯 Web 版，云端 ASR + 翻译
- **extractor** (`extractor/`): Rust CLI 工具 `subextract`，从媒体文件提取音频
- **server** (`server/`): FastAPI 本地开发服务，提供 ffmpeg 音频提取 + faster-whisper 转录

## 关键路径

| 路径 | 说明 |
|------|------|
| `apps/desktop/src-tauri/src/commands/` | Rust 命令模块目录（拆分自 commands.rs） |
| `apps/desktop/src-tauri/src/commands/asr.rs` | ASR 转录命令 |
| `apps/desktop/src-tauri/src/commands/pipeline.rs` | 并行任务管道（GPU 并发调度） |
| `apps/desktop/src-tauri/src/commands/translation.rs` | 翻译命令 |
| `apps/desktop/src-tauri/src/commands/deps.rs` | 依赖检查命令 |
| `apps/desktop/src-tauri/src/commands/gpu_cmd.rs` | GPU 下载/安装命令 |
| `apps/desktop/src-tauri/src/commands/ffmpeg_cmd.rs` | FFmpeg 相关命令 |
| `apps/desktop/src-tauri/src/commands/whisper_cmd.rs` | Whisper 相关命令 |
| `apps/desktop/src-tauri/src/commands/types.rs` | 命令共用类型定义 |
| `apps/desktop/src-tauri/src/commands/utils.rs` | 命令工具函数 |
| `apps/desktop/src-tauri/src/lib.rs` | Tauri 命令注册 |
| `apps/desktop/src-tauri/src/gpu.rs` | GPU 检测模块（CUDA/Vulkan/Metal 跨平台） |
| `apps/desktop/app/page.tsx` | 桌面版首页（依赖检查 + Tab 切换 + ThemeToggle） |
| `apps/desktop/components/DesktopSubtitlePanel.tsx` | 字幕生成面板（设置 + 文件列表 + 结果 + 停止/重试） |
| `apps/desktop/components/ExtractPanel.tsx` | 音频提取面板（多文件/文件夹 + 进度 + 结果） |
| `apps/desktop/components/TranscriptPanel.tsx` | 转录面板（音频 → SRT，本地 Whisper + 云端 ASR） |
| `apps/desktop/components/TranslatePanel.tsx` | 翻译面板（SRT 翻译，支持 Tencent/DeepL） |
| `apps/web/app/page.tsx` | Web 版首页（Tab 切换：音频提取 / 转录 / 翻译 / 字幕生成） |
| `apps/web/app/globals.css` | 全局 CSS 变量（配色 / 字体 / 圆角，dark/light/system 三主题） |
| `apps/web/components/SubtitleGenerator.tsx` | 字幕生成 Tab（全管线：压缩 → 上传 → ASR → 翻译 → SRT） |
| `apps/web/components/WebExtractPanel.tsx` | Web 音频提取 Tab（上传视频 → 服务端提取 → 下载 WAV） |
| `apps/web/components/WebTranscriptPanel.tsx` | Web 转录 Tab（上传音频 → 云端 ASR → 下载 SRT） |
| `apps/web/components/WebTranslatePanel.tsx` | Web 翻译 Tab（上传 SRT → 云端翻译 → 下载译文） |
| `apps/web/components/ui/ThemeToggle.tsx` | 主题切换组件（浅色/深色/跟随系统，持久化 localStorage） |
| `apps/web/app/api/transcribe/route.ts` | 转录 API（dev: 转发 Python 后端，prod: 云端 ASR fallback 链） |
| `apps/web/app/api/translate/route.ts` | 翻译 API |
| `apps/web/app/api/extract/route.ts` | 音频提取 API（dev: 转发 Python 后端） |
| `apps/web/lib/process.ts` | 浏览器端全管线处理（分片 + 上传 + 轮询 + 翻译） |
| `apps/desktop/src-tauri/tauri.windows.conf.json` | Windows 平台 bundle 资源声明 |
| `apps/desktop/src-tauri/tauri.macos.conf.json` | macOS 平台 bundle 资源声明 |
| `apps/desktop/src-tauri/tauri.linux.conf.json` | Linux 平台 bundle 资源声明 |
| `apps/desktop/src-tauri/.cargo/config.toml` | Rust 链接器配置（`rust-lld`） |
| `server/api.py` | FastAPI 本地服务（`/transcribe` + `/extract`） |
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

## CI 注意事项

修改 `.github/workflows/build-desktop.yml` 时，每个平台的步骤必须完全隔离，不得影响其他平台：

- macOS 步骤只改 `if: matrix.platform == 'macos'` 块
- Windows 步骤只改 `if: matrix.platform == 'windows-x64'` 块
- Linux 步骤只改 `if: matrix.platform == 'linux-x64'` 块

改动前先确认各平台边界，改动后在 commit 说明中注明"仅影响 macOS / Windows / Linux"。

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

> ⚠️ Reminder: Always respond in Simplified Chinese.
