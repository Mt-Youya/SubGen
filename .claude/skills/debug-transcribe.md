---
name: debug-transcribe
description: 排查 SubGen 转录/翻译流程故障，支持 Tauri 桌面版和 Web 版
---

## Tauri 桌面版（主模式）

**1. 看前端错误提示**

界面会显示具体阶段：extracting → transcribing → translating → saving

| 错误关键词 | 所在层 | 相关文件 |
|-----------|--------|---------|
| `ffmpeg 分片失败` | 音频提取 | `commands.rs` → `split_audio_for_asr` |
| `whisper-server 错误` | 本地 ASR | `commands.rs` → `transcribe_with_whisper_server` |
| `whisper-cli 错误` | 本地 ASR 兜底 | `commands.rs` → `transcribe_with_whisper_legacy` |
| `Groq API 错误` | 云端 ASR | `commands.rs` → `transcribe_with_groq` |
| `SiliconFlow API 错误` | 云端 ASR | `commands.rs` → `transcribe_with_siliconflow` |
| `DeepL API 错误` | 翻译 | `commands.rs` → `translate_with_deepl` |
| `未找到 whisper-cli` | 二进制缺失 | `commands.rs` → `resolve_whisper` |
| `请先下载 Whisper 模型` | 模型缺失 | `commands.rs` → `default_model_path` |

**2. 检查依赖**

```bash
# whisper-server + whisper-cli + ffmpeg + DLLs
ls packages/desktop/src-tauri/resources/
# 应包含: whisper-server.exe whisper-cli.exe whisper.dll ggml*.dll ffmpeg.exe

# 模型文件
ls ~/.subgen_cache/models/ggml-small.bin
```

**3. 测试 whisper-server 独立运行**

```bash
./packages/desktop/src-tauri/resources/whisper-server.exe \
  -m ~/.subgen_cache/models/ggml-small.bin --port 18200
# 另开终端测试
curl -X POST http://127.0.0.1:18200/inference \
  -F "file=@test.wav" -F "language=ja" -F "response_format=verbose_json"
```

**4. 检查 Rust 日志**

```bash
cd packages/desktop && RUST_LOG=debug pnpm tauri dev
```

## Web 版（云 API 模式）

**1. 看错误信息来自哪一层**

| 错误关键词 | 所在层 | 相关文件 |
|-----------|--------|---------|
| `File too large` | 文件校验（>25 MB） | `packages/web/.../route.ts` |
| `No speech detected` | ASR 返回空 | `packages/web/lib/siliconflow.ts` |
| `SiliconFlow API error` | ASR 请求失败 | `packages/web/lib/siliconflow.ts` |
| `腾讯翻译错误` | 翻译失败 | `packages/web/lib/tencent.ts` |

**2. 检查环境变量**

```bash
grep -E "(SILICONFLOW|TENCENT)" packages/web/.env.local
```

**3. curl 测试 API**

```bash
curl -X POST http://localhost:3000/api/transcribe \
  -F "file=@test.mp3" \
  -F "sourceLang=ja" \
  -F "targetLang=ZH"
```
