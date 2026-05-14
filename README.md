# SubGen — 视频字幕生成工具

自动从视频/音频提取字幕，并翻译为目标语言。

## 项目结构

```
SubGen/
├── server/            # Python CLI（本地 Whisper + 翻译，离线运行）
│   ├── api.py
│   ├── main.py
│   └── pyproject.toml
├── packages/
│   ├── web/           # Next.js Web 前端（Vercel 部署）
│   └── shared/        # 共享类型 & SRT 工具函数
├── extractor/         # 音频提取工具（Python CLI，跨平台）
│   └── extract.py
└── pnpm-workspace.yaml
```

## extractor/ — 音频提取工具

从视频文件提取 16kHz 单声道 WAV，解决浏览器无法处理大文件/移动硬盘/编码兼容问题。

```bash
# 单文件
python extractor/extract.py video.mp4

# 多个文件
python extractor/extract.py a.mp4 b.mkv c.ts

# 整个文件夹（递归）
python extractor/extract.py ./videos/ -r

# 自定义参数
python extractor/extract.py video.mp4 -d 300 -o audio -j 4

# 提取完整音频（不截取）
python extractor/extract.py video.mp4 -d 0
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-o, --output` | 输出目录 | `output` |
| `-d, --duration` | 提取秒数，0=完整 | `120` |
| `-r, --recursive` | 递归子文件夹 | 否 |
| `-j, --jobs` | 并行数 | `2` |
| `--ext` | 扩展名过滤 | `mp4,mkv,ts,...` |

输出为 16kHz 单声道 WAV PCM，可直接上传 SubGen Web 前端。需要 `ffmpeg` 在 PATH 中。

---

## packages/web — Next.js + Vercel（主线）

云端运行，调用 **硅基流动 SenseVoice**（语音识别）+ **腾讯云翻译**（字幕翻译），无需本地 ffmpeg。

### 本地开发

```bash
pnpm install
cp packages/web/.env.example packages/web/.env.local
# 编辑 .env.local 填入 API Key
pnpm dev
# 访问 http://localhost:3000
```

> dev 模式下，`/api/transcribe` 会自动转发到本地 Python 服务（`localhost:8000`）。若只测试前端 UI 不需要转录，可跳过启动 Python 服务。

### 获取 API Key

| 服务 | 用途 | 免费额度 | 申请地址 |
|------|------|---------|---------|
| 硅基流动 | 语音识别（SenseVoice） | 有免费额度 | https://siliconflow.cn |
| 腾讯云翻译 | 字幕翻译 | 500 万字符/月 | https://console.cloud.tencent.com → 机器翻译 |

### 部署到 Vercel

```bash
# 方式一：Vercel CLI（在项目根目录）
vercel deploy

# 方式二：GitHub 集成
# 推送到 GitHub → vercel.com 导入仓库
# Root Directory 留空（vercel.json 在 packages/web/）
```

在 Vercel Dashboard → Settings → Environment Variables 添加：

| 变量名 | 说明 |
|--------|------|
| `SILICONFLOW_API_KEY` | 硅基流动 API Key |
| `TENCENT_SECRET_ID` | 腾讯云 SecretId |
| `TENCENT_SECRET_KEY` | 腾讯云 SecretKey |

> Vercel Hobby 版 Function 超时 60s；处理长音频建议升级 Pro（300s）。`vercel.json` 已配置 `maxDuration: 300`。

### 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Next.js 16（App Router） |
| 语音识别 | 硅基流动 SenseVoice（`FunAudioLLM/SenseVoiceSmall`） |
| 翻译 | 腾讯云机器翻译 `TextTranslateBatch` |
| 字幕格式 | 自研 SRT 生成（`@subgen/shared`） |

---

## server/ — Python CLI（本地离线）

本地运行，使用 Whisper 模型离线识别，无需 API Key。dev 模式下作为 Next.js 的后端代理。

### 安装依赖

```bash
# 安装 ffmpeg
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Ubuntu

# 安装 Python 依赖
cd server
uv sync                      # 推荐
# 或 pip install -e .
```

### 启动 API 服务（供 Next.js dev 模式使用）

```bash
cd server
uvicorn api:app --reload --port 8000
# FastAPI Swagger UI：http://localhost:8000/docs
```

### CLI 直接使用

```bash
cd server

# 处理单个视频（日文 → 中文）
python main.py video.mp4

# 指定输出目录
python main.py video.mp4 -o ./subtitles

# 使用更大的 Whisper 模型
python main.py video.mp4 --model large-v3

# 韩文 → 中文
python main.py video.mp4 --source ko --target zh-CN
```

### 输出文件

- `video.ja.srt` — 原文字幕
- `video.zh.srt` — 中文字幕
- `video.bilingual.srt` — 双语字幕
