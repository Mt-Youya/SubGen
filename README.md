# SubGen — 端到端字幕生成工具

自动从视频/音频提取字幕并翻译为目标语言。支持本地离线 ASR 和云端 API。

## 项目结构

```
SubGen/
├── apps/
│   ├── desktop/       # Tauri v2 桌面应用（主线）
│   │   ├── src-tauri/ # Rust 后端（whisper + ffmpeg + 翻译 API）
│   │   ├── app/       # Next.js 前端
│   │   └── components/
│   ├── web/           # Next.js Web 前端（Vercel 部署，四 Tab）
│   └── shared/        # 共享类型 & SRT 工具
├── server/            # FastAPI 本地开发服务
├── extractor/         # Rust CLI 音频提取工具
└── .github/workflows/ # CI/CD（desktop + extractor）
```

## apps/desktop — Tauri 桌面应用（主线）

跨平台桌面应用（Windows / macOS / Linux），内置本地 Whisper 语音识别。

```bash
pnpm install
pnpm dev:desktop
```

首次启动会检查依赖（ffmpeg + whisper-cli + Whisper 模型），缺失项点击「授权安装」即可下载到应用内部，无需手动安装。

### 功能

- 本地 Whisper 离线语音识别（whisper-server，模型常驻内存）
- 云端 ASR：Groq Whisper / SiliconFlow SenseVoice
- 翻译：DeepL / 腾讯云翻译
- 多文件批量处理
- 原文字幕 / 译文字幕 / 双语字幕导出

### Provider 配置

在应用「API 设置」面板中配置对应的 API Key。

### 发布

推送 `desktop-v*` tag 触发 CI 构建全平台 Release：

```bash
git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
```

## extractor/ — 音频提取 CLI

纯 Rust 编译，单文件可执行，跨平台。从媒体文件提取 16kHz 单声道 WAV。

### 构建

```bash
cd extractor && cargo build --release
```

### 使用

```bash
subextract video.mp4 -o ./output
subextract a.mp4 b.mkv c.ts -o ./output
subextract video.mp4 -d 120 -o ./output  # 只提取前 120 秒
```

## apps/web — Web 前端

云端运行，调用 ASR / 翻译 API。适合 Vercel 部署。四个功能 Tab：音频提取 / 转录 / 翻译 / 字幕生成。

```bash
cp apps/web/.env.example apps/web/.env.local
# 编辑 .env.local 填入 API Key
pnpm dev:web
```

| 变量名 | 说明 |
|--------|------|
| `SILICONFLOW_API_KEY` | 硅基流动 API Key |
| `TENCENT_SECRET_ID` | 腾讯云 SecretId |
| `TENCENT_SECRET_KEY` | 腾讯云 SecretKey |

## 技术栈

| 层 | 桌面版 | Web 版 |
|----|--------|--------|
| 框架 | Tauri v2 + Next.js 16 | Next.js 16 |
| 语音识别 | whisper.cpp (server) / Groq / SiliconFlow | 硅基流动 SenseVoice |
| 翻译 | DeepL / 腾讯云翻译 | 腾讯云翻译 |
| 字幕 | Rust SRT 生成 | TypeScript SRT (shared) |
| 音频提取 | ffmpeg (内置) | ffmpeg (系统) |
| CI/CD | GitHub Actions + tauri-action | Vercel |
