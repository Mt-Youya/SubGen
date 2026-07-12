import crypto from "crypto"
import type { Segment } from "@subgen/shared"

const ENDPOINT = "tmt.tencentcloudapi.com"
const SERVICE = "tmt"
const VERSION = "2018-03-21"
const REGION = "ap-guangzhou"
const BATCH_SIZE = 50 // 腾讯翻译单次最多 50 条

function sign(secretId: string, secretKey: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const action = "TextTranslateBatch"

  const canonicalRequest = [
    "POST",
    "/",
    "",
    "content-type:application/json\nhost:" + ENDPOINT + "\n",
    "content-type;host",
    crypto.createHash("sha256").update(body).digest("hex"),
  ].join("\n")

  const credentialScope = `${date}/${SERVICE}/tc3_request`
  const stringToSign = [
    "TC3-HMAC-SHA256",
    timestamp,
    credentialScope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n")

  const hmac = (key: Buffer | string, data: string) => crypto.createHmac("sha256", key).update(data).digest()

  const secretDate = hmac("TC3" + secretKey, date)
  const secretService = hmac(secretDate, SERVICE)
  const secretSigning = hmac(secretService, "tc3_request")
  const signature = crypto.createHmac("sha256", secretSigning).update(stringToSign).digest("hex")

  return {
    "Content-Type": "application/json",
    Host: ENDPOINT,
    "X-TC-Action": action,
    "X-TC-Version": VERSION,
    "X-TC-Region": REGION,
    "X-TC-Timestamp": String(timestamp),
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`,
  }
}

export async function translateSegments(
  segments: Segment[],
  sourceLang: string = "ja",
  targetLang: string = "zh"
): Promise<Segment[]> {
  const secretId = process.env.TENCENT_SECRET_ID
  const secretKey = process.env.TENCENT_SECRET_KEY
  if (!secretId || !secretKey) throw new Error("TENCENT_SECRET_ID 或 TENCENT_SECRET_KEY 未设置")

  const src = sourceLang.toLowerCase()
  const tgt = targetLang.toLowerCase().replace("zh-tw", "zh-TW").replace("en-us", "en")

  const texts = segments.map((s) => s.text)
  const translated: string[] = []

  // 按字符数分批：腾讯翻译单次总文本 < 6000 字符，最多 50 条
  const batches: string[][] = []
  let cur: string[] = [],
    curChars = 0
  for (const t of texts) {
    if (cur.length > 0 && (curChars + t.length > 5000 || cur.length >= BATCH_SIZE)) {
      batches.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(t)
    curChars += t.length
  }
  if (cur.length > 0) batches.push(cur)

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  for (const batch of batches) {
    const body = JSON.stringify({
      SourceTextList: batch,
      Source: src,
      Target: tgt,
      ProjectId: 0,
    })

    let lastErr = ""
    let data: Record<string, unknown> | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1))
      const headers = sign(secretId, secretKey, body)
      const res = await fetch(`https://${ENDPOINT}`, { method: "POST", headers, body })
      const json = await res.json()
      if (json.Response?.Error) {
        const { Code, Message } = json.Response.Error
        if (String(Code).includes("Internal")) {
          lastErr = `${Code} ${Message}`
          continue
        }
        throw new Error(`腾讯翻译错误: ${Code} ${Message}`)
      }
      data = json
      break
    }
    if (!data) throw new Error(`腾讯翻译错误: ${lastErr}`)

    ;(data as Record<string, { TargetTextList: string[] }>).Response.TargetTextList.forEach((t: string) =>
      translated.push(t)
    )
  }

  const result = segments.map((seg, i) => ({ ...seg, text: translated[i] ?? seg.text }))

  // 检测翻译是否生效：源语言和目标语言不同时，结果不应全等于原文
  if (src !== tgt && segments.every((s, i) => s.text === (result[i]?.text ?? ""))) {
    console.warn("[tencent] 翻译结果与原文一致，翻译可能未生效")
  }

  return result
}
