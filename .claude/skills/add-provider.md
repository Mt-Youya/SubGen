---
name: add-provider
description: 为 SubGen 添加新的 ASR（语音识别）或翻译服务 Provider
---

SubGen 支持插件式 Provider 模式。添加新 Provider 的步骤：

## 当前生产 Provider

| 类型 | Provider | 文件 | 状态 |
|------|----------|------|------|
| ASR  | 硅基流动 SenseVoice | `lib/siliconflow.ts` | **生产使用** |
| 翻译 | 腾讯云翻译 | `lib/tencent.ts` | **生产使用** |
| ASR  | Groq Whisper | `lib/groq.ts` | 备用，未接入 route |
| ASR  | 讯飞 | `lib/xunfei.ts` | 备用，未接入 route |
| 翻译 | DeepL | `lib/deepl.ts` | 备用，未接入 route |

## 添加 ASR Provider（语音识别）

1. **新建 lib 文件** `packages/web/lib/<provider>.ts`，参考 `lib/siliconflow.ts`：

```ts
import type { Segment } from "@subgen/shared";

export async function transcribeWith<ProviderName>(
  buffer: Buffer,
  filename: string,
  language: string
): Promise<Segment[]> {
  // 注意：Buffer → BlobPart 需要用 new Uint8Array(buffer)
  const blob = new Blob([new Uint8Array(buffer)], { type: "audio/mpeg" });
  // ...
}
```

> ⚠️ 不要直接把 `Buffer` 传给 `new Blob()`，TypeScript 严格模式下会报类型错误，需用 `new Uint8Array(buffer)` 包裹。

2. **在 `route.ts` 中替换**：编辑 `packages/web/app/api/transcribe/route.ts` 生产分支的 `transcribeWithSiliconFlow` 调用。

3. **添加环境变量**：在 `packages/web/.env.example` 和 `.env.local` 中添加对应 Key。

## 添加翻译 Provider

1. **新建 lib 文件** `packages/web/lib/<provider>.ts`，参考 `lib/tencent.ts`：

```ts
import type { Segment } from "@subgen/shared";

export async function translateSegments(
  segments: Segment[],
  targetLang: string
): Promise<Segment[]>
```

2. **在 `route.ts` 中替换** `translateSegments` 调用处。

3. **添加环境变量**。

## 验证新 Provider

```bash
# 构建确认无类型错误
pnpm build

# curl 测试 API（dev 模式）
curl -X POST http://localhost:3000/api/transcribe \
  -F "file=@test.mp3" \
  -F "sourceLang=ja" \
  -F "targetLang=ZH"
```
