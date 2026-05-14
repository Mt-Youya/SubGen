---
name: dev
description: 启动 SubGen 完整本地开发环境（Python API + Next.js Web）
---

SubGen 本地开发需要同时运行两个服务。

## 启动步骤

**步骤 1：启动 Python 后端**（供 Next.js dev 模式转发用）

```bash
cd server && uvicorn api:app --reload --port 8000
```

**步骤 2：启动 Next.js 前端**

```bash
pnpm --filter web dev
```

或通过 `preview_start` 启动 dev server（已配置在 `.claude/launch.json`）。

## 验证

- Python API：http://localhost:8000/docs（FastAPI Swagger UI）
- Web 前端：http://localhost:3000

> dev 模式下，`/api/transcribe` 会自动转发到 `localhost:8000`。生产模式直接调用硅基流动 + 腾讯翻译 API。

## 常见问题

- **Python 依赖未安装**：`cd server && uv sync`（或 `pip install -e .`）
- **端口占用**：`lsof -ti:8000 | xargs kill` 或 `lsof -ti:3000 | xargs kill`
- **环境变量缺失**：检查 `packages/web/.env.local`，参考 `.env.example`
- **ffmpeg 未安装**：`brew install ffmpeg`（Python 转录依赖）
- **大文件无法上传**：浏览器无法加载超大文件到内存。用 `extractor/extract.py` 先提取音频，再上传 WAV 到 SubGen：
  ```bash
  python extractor/extract.py video.mp4 -d 120 -o ./audio
  ```
