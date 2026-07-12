---
name: add-provider
description: 为 SubGen 添加新的 ASR 或翻译 Provider（Tauri 桌面版 + Web 版）
---

## 当前 Provider

| 类型 | Provider                  | 桌面版文件                                       | Web 版文件           |
| ---- | ------------------------- | ------------------------------------------------ | -------------------- |
| ASR  | 本地 Whisper (server/cli) | `commands.rs` → `transcribe_with_whisper_server` | —                    |
| ASR  | Groq Whisper              | `commands.rs` → `transcribe_with_groq`           | `lib/groq.ts`        |
| ASR  | SiliconFlow SenseVoice    | `commands.rs` → `transcribe_with_siliconflow`    | `lib/siliconflow.ts` |
| 翻译 | 腾讯云翻译                | `commands.rs` → `translate_with_tencent`         | `lib/tencent.ts`     |
| 翻译 | DeepL                     | `commands.rs` → `translate_with_deepl`           | `lib/deepl.ts`       |

## Tauri 桌面版：添加 ASR Provider

1. 在 `packages/desktop/src-tauri/src/commands.rs` 添加转录函数：

```rust
async fn transcribe_with_xxx(
    client: &reqwest::Client,
    path: &Path,
    language: &str,
    api_key: &str,
) -> Result<Vec<Segment>, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取音频失败: {e}"))?;
    let part = Part::bytes(bytes)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("构造上传分片失败: {e}"))?;
    let form = Form::new()
        .part("file", part)
        .text("model", "your-model")
        .text("language", language.to_string())
        .text("response_format", "verbose_json");

    let res = client
        .post("https://api.example.com/v1/audio/transcriptions")
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    let body = res.text().await.unwrap_or_default();
    // 解析 segments JSON
    // 返回 Vec<Segment>
}
```

2. 在 `transcribe_chunk` 函数添加分支：

```rust
"xxx" => {
    let key = clean_key(&opts.xxx_api_key).ok_or("请先设置 XXX API Key")?;
    transcribe_with_xxx(client, path, language, &key).await
}
```

3. 在 `GenerateOptions` struct 添加 `xxx_api_key: Option<String>`

4. 前端 `DesktopSubtitlePanel.tsx` 的 `Settings` 接口和 `ASR_PROVIDERS` 列表添加新选项

## Tauri 桌面版：添加翻译 Provider

参考 `translate_with_deepl` / `translate_with_tencent` 模式，在 `translate_segments` 函数添加分支即可。

## Web 版：添加 Provider

见旧版本文档（`packages/web/lib/` 下创建文件 → `route.ts` 接入 → 环境变量配置）。

## 验证

```bash
# 桌面版：编译并运行
pnpm dev:desktop
# 在 UI 中选择新 Provider 测试转录/翻译

# Web 版
curl -X POST http://localhost:3000/api/transcribe -F "file=@test.mp3" ...
```
