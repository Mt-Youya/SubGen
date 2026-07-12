import type { Segment } from "@subgen/shared"

interface CfWord {
  word: string
  start: number
  end: number
}

interface CfSegment {
  vtt: string // "00:00:01.000 --> 00:00:03.500\nHello world"
}

interface CfResponse {
  text: string
  word_count?: number
  words?: CfWord[]
  segments?: CfSegment[]
  vtt?: string
}

/**
 * Cloudflare Workers AI — whisper-large-v3-turbo
 * 全球可用，$0.00051/min，有免费额度
 * REST API 文档：https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
 *
 * 请求格式：POST JSON，audio 字段为 base64 字符串
 */
export async function transcribeWithCloudflare(audioBuffer: Buffer, language = "ja"): Promise<Segment[]> {
  const accountId = process.env.CF_ACCOUNT_ID
  const apiToken = process.env.CF_API_TOKEN
  if (!accountId || !apiToken) throw new Error("CF_ACCOUNT_ID 或 CF_API_TOKEN 未设置")

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/openai/whisper-large-v3-turbo`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio: audioBuffer.toString("base64"),
        language,
      }),
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Cloudflare AI error ${res.status}: ${err}`)
  }

  const json = (await res.json()) as { result: CfResponse; success: boolean }
  if (!json.success) throw new Error("Cloudflare AI 返回 success=false")
  const data = json.result

  // 优先：words 有 start/end 数字时间戳，聚合成句
  if (data.words && data.words.length > 0) {
    return groupWords(data.words)
  }

  // 次选：解析 segments[].vtt 里的时间戳
  if (data.segments && data.segments.length > 0) {
    const parsed = data.segments.flatMap((s) => parseVttBlock(s.vtt))
    if (parsed.length > 0) return parsed
  }

  // 次次选：解析顶层 vtt 字段
  if (data.vtt) {
    const parsed = parseVtt(data.vtt)
    if (parsed.length > 0) return parsed
  }

  // 兜底：整段文本，时间戳未知
  if (data.text.trim()) {
    return [{ start: 0, end: 0, text: data.text.trim() }]
  }

  return []
}

// ── VTT 解析 ─────────────────────────────────────────────────────────

/**
 * 解析单个 vtt 块，格式：
 *   "00:00:01.000 --> 00:00:03.500\nHello world"
 */
function parseVttBlock(block: string): Segment[] {
  const lines = block.trim().split("\n")
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})/)
    if (m) {
      const text = lines
        .slice(i + 1)
        .join(" ")
        .trim()
      if (!text) return []
      return [{ start: vttToSec(m[1]), end: vttToSec(m[2]), text }]
    }
  }
  return []
}

/**
 * 解析完整 VTT 文件
 */
function parseVtt(vtt: string): Segment[] {
  const blocks = vtt.split(/\n\n+/)
  return blocks.flatMap((b) => parseVttBlock(b))
}

/** "HH:MM:SS.mmm" 或 "MM:SS.mmm" → 秒 */
function vttToSec(ts: string): number {
  const parts = ts.replace(",", ".").split(":").map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return parts[0] * 60 + parts[1]
}

// ── Word 聚合 ─────────────────────────────────────────────────────────

/** 把 word 级时间戳按静音间隔聚合成 segment（间隔 > 1s 切断） */
function groupWords(words: CfWord[]): Segment[] {
  const GAP = 1.0
  const segments: Segment[] = []
  let buf: CfWord[] = []

  for (const w of words) {
    if (buf.length > 0 && w.start - buf[buf.length - 1].end > GAP) {
      segments.push(flushWords(buf))
      buf = []
    }
    buf.push(w)
  }
  if (buf.length > 0) segments.push(flushWords(buf))
  return segments
}

function flushWords(words: CfWord[]): Segment {
  return {
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words
      .map((w) => w.word)
      .join(" ")
      .trim(),
  }
}
