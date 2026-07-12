import type { Segment } from "@subgen/shared";

interface WhisperResponse {
  text: string;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
  }>;
}

export async function transcribeWithSiliconFlow(
  audioBuffer: Buffer,
  filename: string,
  language: string = "ja"
): Promise<Segment[]> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) throw new Error("SILICONFLOW_API_KEY is not set");

  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(audioBuffer)]), filename);
  formData.append("model", "FunAudioLLM/SenseVoiceSmall");
  formData.append("language", language);
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "segment");

  const res = await fetch("https://api.siliconflow.cn/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SiliconFlow API error ${res.status}: ${err}`);
  }

  const data: WhisperResponse = await res.json();

  if (data.segments && data.segments.length > 0) {
    return data.segments
      .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
      .filter((s) => s.text.length > 0);
  }

  return [{ start: 0, end: 0, text: data.text.trim() }];
}
