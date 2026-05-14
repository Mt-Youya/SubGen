import { NextRequest, NextResponse } from "next/server";
import { translateSegments } from "@/lib/tencent";
import { segmentsToSrt, mergeBilingual } from "@subgen/shared";
import type { Segment } from "@subgen/shared";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const segmentsJson = formData.get("segments") as string | null;
    const targetLang = (formData.get("targetLang") as string) || "ZH";
    const bilingual = formData.get("bilingual") === "true";

    if (!segmentsJson) {
      return NextResponse.json({ error: "Missing segments" }, { status: 400 });
    }

    let segments: Segment[];
    try {
      segments = JSON.parse(segmentsJson);
    } catch {
      return NextResponse.json({ error: "Invalid segments JSON" }, { status: 400 });
    }

    if (!Array.isArray(segments) || segments.length === 0) {
      return NextResponse.json({ error: "segments must be a non-empty array" }, { status: 400 });
    }

    const translated = await translateSegments(segments, targetLang);

    return NextResponse.json({
      translated,
      srt: {
        original: segmentsToSrt(segments),
        translated: segmentsToSrt(translated),
        bilingual: bilingual ? mergeBilingual(segments, translated) : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/translate]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
