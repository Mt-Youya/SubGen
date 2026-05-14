import { NextRequest, NextResponse } from "next/server";
import { transcribeWithGroq } from "@/lib/groq";
import { transcribeWithCloudflare } from "@/lib/cloudflare";
import { transcribeWithSiliconFlow } from "@/lib/siliconflow";
import { translateSegments } from "@/lib/tencent";
import { segmentsToSrt, mergeBilingual } from "@subgen/shared";
import { hashBuffer, cacheGet, cacheSet } from "@/lib/cache";

export const maxDuration = 300;

/**
 * ASR fallback 链：Groq → Cloudflare → SiliconFlow
 *
 * - Groq：whisper-large-v3-turbo，最快，有真实 segments 时间戳，部分地区封锁
 * - Cloudflare：whisper-large-v3-turbo，全球可用，按分钟计费
 * - SiliconFlow：SenseVoiceSmall，兜底，无 segments 时间戳（整段返回）
 */
async function transcribeWithFallback(
  buffer: Buffer,
  filename: string,
  sourceLang: string
): Promise<{ segments: Awaited<ReturnType<typeof transcribeWithGroq>>; provider: string }> {
  const errors: string[] = [];

  // 1. Groq
  if (process.env.GROQ_API_KEY) {
    try {
      const segments = await transcribeWithGroq(buffer, filename, sourceLang);
      return { segments, provider: "groq" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Groq: ${msg}`);
      console.warn("[transcribe] Groq failed, trying Cloudflare...", msg);
    }
  }

  // 2. Cloudflare Workers AI
  if (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) {
    try {
      const segments = await transcribeWithCloudflare(buffer, sourceLang);
      return { segments, provider: "cloudflare" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Cloudflare: ${msg}`);
      console.warn("[transcribe] Cloudflare failed, trying SiliconFlow...", msg);
    }
  }

  // 3. SiliconFlow（兜底，无精确时间戳）
  if (process.env.SILICONFLOW_API_KEY) {
    try {
      const segments = await transcribeWithSiliconFlow(buffer, filename, sourceLang);
      return { segments, provider: "siliconflow" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`SiliconFlow: ${msg}`);
    }
  }

  throw new Error(`所有 ASR 服务均失败：${errors.join(" | ")}`);
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();

  // ── dev 模式：转发到本地 Python 服务 ──────────────────────────────
  if (process.env.NODE_ENV === "development") {
    try {
      const res = await fetch("http://localhost:8000/transcribe", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) return NextResponse.json(data, { status: res.status });
      return NextResponse.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `本地 Python 服务未启动，请先运行：\ncd server && uvicorn api:app --reload\n\n原始错误：${msg}` },
        { status: 503 }
      );
    }
  }

  // ── 生产模式 ─────────────────────────────────────────────────────
  try {
    const file = formData.get("file") as File | null;
    const sourceLang = (formData.get("sourceLang") as string) || "ja";
    const targetLang = (formData.get("targetLang") as string) || "ZH";
    const bilingual = formData.get("bilingual") === "true";

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const maxSize = 4.5 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: `文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 4.5 MB。` },
        { status: 413 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // ── 缓存查询 ──────────────────────────────────────────────────
    const cacheKey = hashBuffer(buffer, sourceLang);
    const cached = await cacheGet(cacheKey);

    let segments: Awaited<ReturnType<typeof transcribeWithGroq>>;
    let provider: string;

    if (cached) {
      segments = cached.segments;
      provider = `${cached.provider}(cached)`;
      console.log(`[transcribe] cache hit key=${cacheKey.slice(0, 16)}… provider=${cached.provider}`);
    } else {
      ({ segments, provider } = await transcribeWithFallback(buffer, file.name, sourceLang));
      // 异步写缓存，不阻塞响应
      cacheSet(cacheKey, { segments, provider }).catch(() => {});
    }

    if (segments.length === 0) {
      return NextResponse.json({ error: "No speech detected" }, { status: 422 });
    }

    // targetLang=none 表示分片模式，只返回 segments，翻译由 /api/translate 统一处理
    if (targetLang === "none") {
      return NextResponse.json({ segments, provider });
    }

    const translated = await translateSegments(segments, sourceLang, targetLang);

    return NextResponse.json({
      segments,
      translated,
      provider,
      srt: {
        original: segmentsToSrt(segments),
        translated: segmentsToSrt(translated),
        bilingual: bilingual ? mergeBilingual(segments, translated) : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/transcribe]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
