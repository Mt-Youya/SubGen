import type { Segment } from "@subgen/shared";

interface GroqSegment {
  start: number;
  end: number;
  text: string;
}

interface GroqResponse {
  text: string;
  segments?: GroqSegment[];
}

export async function transcribeWithGroq(
  audioBuffer: Buffer,
  filename: string,
  language: string = "ja"
): Promise<Segment[]> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
  formData.append("file", blob, filename);
  formData.append("model", "whisper-large-v3");
  formData.append("language", language);
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "segment");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err}`);
  }

  const data: GroqResponse = await res.json();

  if (data.segments && data.segments.length > 0) {
    return data.segments
      .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
      .filter((s) => s.text.length > 0);
  }

  return [{ start: 0, end: 0, text: data.text.trim() }];
}
