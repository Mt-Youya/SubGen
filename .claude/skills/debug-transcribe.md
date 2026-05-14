---
name: debug-transcribe
description: 排查 SubGen 转录/翻译流程故障，定位 ASR 或翻译报错
---

排查 `/api/transcribe` 路由的问题。先确认是哪个阶段出错：

## 快速定位

**1. 看错误信息来自哪一层**

| 错误关键词 | 所在层 | 相关文件 |
|-----------|--------|---------|
| `本地 Python 服务未启动` | dev 模式代理 | `route.ts:14` |
| `File too large` | 文件校验（>25 MB） | `route.ts:41` |
| `No speech detected` | ASR 返回空 | `siliconflow.ts` |
| `SiliconFlow API error` | ASR 请求失败 | `lib/siliconflow.ts` |
| `SILICONFLOW_API_KEY is not set` | 环境变量缺失 | `lib/siliconflow.ts` |
| `腾讯翻译错误` | 翻译失败 | `lib/tencent.ts` |
| `TENCENT_SECRET_ID 或 TENCENT_SECRET_KEY 未设置` | 环境变量缺失 | `lib/tencent.ts` |

**2. 检查环境变量**

```bash
grep -E "(SILICONFLOW|TENCENT)" packages/web/.env.local
```

Vercel 生产环境需要在 Dashboard → Settings → Environment Variables 配置：
- `SILICONFLOW_API_KEY`
- `TENCENT_SECRET_ID`
- `TENCENT_SECRET_KEY`

**3. dev 模式：测试 Python 后端**

```bash
# 确认 Python API 正常
curl http://localhost:8000/health

# 直接测试转录
curl -X POST http://localhost:8000/transcribe -F "file=@test.mp3"
```

**4. 查看 Next.js 服务端日志**

控制台会打印 `[/api/transcribe] <错误信息>`，在运行 `pnpm dev` 的终端查看。

**5. 常见修复**

| 问题 | 原因 | 修复 |
|------|------|------|
| Vercel 超时 | Hobby 版限制 60s | 升级 Pro 或压缩音频 |
| 文件格式不支持 | SenseVoice 支持 mp3/mp4/wav/flac/ogg/webm | 用 ffmpeg 转换 |
| 翻译语言代码错误 | 腾讯翻译用 `ZH`，识别语言用 ISO 639-1（`ja`/`en`/`ko`） | 对照 `.env.example` 注释 |
| TypeScript build 报 Buffer 类型错误 | `Buffer` 不能直接传 `new Blob()` | 改为 `new Uint8Array(buffer)` |
