# SubGen — 视频字幕生成工具

自动从视频/音频提取字幕，并翻译为目标语言。

## 项目结构

```
SubGen/
├── server/            # Python CLI（本地 Whisper + 翻译）
│   ├── main.py
│   └── pyproject.toml
├── packages/          # pnpm workspace（JS/TS）
│   ├── web/           # Next.js Web 前端（Vercel）
│   └── shared/        # 共享类型 & SRT 工具
└── pnpm-workspace.yaml
```

---

## server/ — Python CLI

本地运行，使用 Whisper 模型离线识别，无需 API Key。

### 环境安装(Conda)
```bash
conda create -n subgen python=3.13 -y
conda activate subgen
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -e .

python -c "import whisper; print('Whisper OK')"
python -c "from deep_translator import GoogleTranslator; print('Translator OK')"
```

### 安装依赖

```bash
# 安装 ffmpeg
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Ubuntu
winget install ffmpeg        # Windows

# 进入 server 目录，用 uv 或 pip 安装
cd server

# 推荐：uv（更快）
uv sync

# 或 pip
pip install -e .
```

### 使用方法

```bash
cd server

# 处理单个视频（日文 → 中文）
python main.py video.mp4

# 指定输出目录
python main.py video.mp4 -o ./subtitles

# 使用更大的 Whisper 模型（更准确）
python main.py video.mp4 --model large-v3

# 批量处理整个目录
python main.py /path/to/videos/ --batch

# 韩文 → 中文
python main.py video.mp4 --source ko --target zh-CN

# 禁用缓存
python main.py video.mp4 --no-cache
```

### 输出文件

- `video.ja.srt` — 原文字幕
- `video.zh.srt` — 中文字幕
- `video.bilingual.srt` — 双语字幕

---

## packages/web — Next.js + Vercel

云端运行，调用 Groq Whisper API + DeepL API，无需本地 ffmpeg。

### 本地开发

```bash
cd packages/web
pnpm install   # 或在根目录 pnpm install
cp .env.example .env.local
# 编辑 .env.local 填入 API Key
pnpm dev
# 访问 http://localhost:3000
```

### 获取 API Key

| 服务 | 用途 | 申请地址 |
|---|---|---|
| Groq | 语音识别（免费） | https://console.groq.com |
| DeepL | 字幕翻译（免费版 500k 字符/月） | https://www.deepl.com/pro-api |

### 部署到 Vercel

```bash
# 方式一：Vercel CLI
cd packages/web
npx vercel deploy

# 方式二：GitHub 集成
# 推送到 GitHub → vercel.com 导入仓库
# Root Directory 设为 packages/web
```

在 Vercel Dashboard → Settings → Environment Variables 添加：
- `GROQ_API_KEY`
- `DEEPL_API_KEY`

> Vercel Hobby 版 Function 超时 60s；处理长音频建议升级 Pro（300s）。
