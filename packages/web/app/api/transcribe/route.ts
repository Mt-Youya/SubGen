import { NextRequest, NextResponse } from "next/server";
import { transcribeWithSiliconFlow } from "@/lib/siliconflow";
import { translateSegments } from "@/lib/tencent";
import { segmentsToSrt, mergeBilingual } from "@subgen/shared";

export const maxDuration = 300;

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

  // ── 生产模式：讯飞 + 腾讯 ────────────────────────────────────────
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
        { error: `文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 4.5 MB。请使用较短的音频片段。` },
        { status: 413 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const segments = await transcribeWithSiliconFlow(buffer, file.name, sourceLang);

    if (segments.length === 0) {
      return NextResponse.json({ error: "No speech detected" }, { status: 422 });
    }

    // targetLang=none 表示分片模式，只返回 segments，翻译由 /api/translate 统一处理
    if (targetLang === "none") {
      return NextResponse.json({ segments });
    }

    const translated = await translateSegments(segments, targetLang);

    return NextResponse.json({
      segments,
      translated,
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
