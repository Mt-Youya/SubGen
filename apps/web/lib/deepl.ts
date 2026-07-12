import type { Segment } from "@subgen/shared";

interface DeepLResponse {
  translations: { text: string }[];
}

const BATCH_SIZE = 50;

function getApiUrl(apiKey: string): string {
  return apiKey.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";
}

export async function translateSegments(
  segments: Segment[],
  targetLang: string = "ZH"
): Promise<Segment[]> {
  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) throw new Error("DEEPL_API_KEY is not set");

  const apiUrl = getApiUrl(apiKey);
  const texts = segments.map((s) => s.text);
  const translatedTexts: string[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const body = new URLSearchParams();
    batch.forEach((t) => body.append("text", t));
    body.append("target_lang", targetLang);

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`DeepL API error ${res.status}: ${err}`);
    }

    const data: DeepLResponse = await res.json();
    data.translations.forEach((t) => translatedTexts.push(t.text));
  }

  return segments.map((seg, i) => ({
    ...seg,
    text: translatedTexts[i] ?? seg.text,
  }));
}
