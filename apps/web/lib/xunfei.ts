import crypto from "crypto"
import type { Segment } from "@subgen/shared"

const BASE_URL = "https://raasr.xfyun.cn/api"
const POLL_INTERVAL = 5000 // 5 秒轮询一次
const POLL_TIMEOUT = 10 * 60 * 1000 // 最多等 10 分钟

interface XunfeiResult {
  action: string
  code: string
  data: string // JSON string
}

interface XunfeiOrderResult {
  lattice: Array<{
    json_1best: string // JSON string
  }>
}

interface XunfeiOneBest {
  st: {
    bg: string // start ms
    ed: string // end ms
    rt: Array<{
      ws: Array<{
        cw: Array<{ w: string }>
      }>
    }>
  }
}

function sign(appId: string, apiKey: string): { ts: string; signa: string } {
  const ts = String(Math.floor(Date.now() / 1000))
  const base = crypto
    .createHash("md5")
    .update(appId + ts)
    .digest("hex")
  const signa = crypto.createHmac("sha1", apiKey).update(base).digest("base64")
  return { ts, signa }
}

async function request(
  path: string,
  appId: string,
  apiKey: string,
  extra: Record<string, string> = {}
): Promise<XunfeiResult> {
  const { ts, signa } = sign(appId, apiKey)
  const params = new URLSearchParams({ appId, ts, signa, ...extra })
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  })
  const json = await res.json()
  console.log(`[xunfei] ${path}`, JSON.stringify(json))
  return json
}

async function upload(appId: string, apiKey: string, orderId: string, audioBuffer: Buffer): Promise<void> {
  const { ts, signa } = sign(appId, apiKey)
  const form = new FormData()
  form.append("appId", appId)
  form.append("ts", ts)
  form.append("signa", signa)
  form.append("orderId", orderId)
  form.append("index", "1")
  form.append("indexSize", "1")
  form.append("file", new Blob([new Uint8Array(audioBuffer)]), "audio.wav")

  const res = await fetch(`${BASE_URL}/upload`, { method: "POST", body: form })
  const data: XunfeiResult = await res.json()
  if (data.code !== "000000") throw new Error(`讯飞上传失败: ${data.action} ${data.code}`)
}

/** 把讯飞结果 JSON 解析为 Segment 数组 */
function parseResult(resultJson: string): Segment[] {
  const order: XunfeiOrderResult = JSON.parse(resultJson)
  const segments: Segment[] = []

  for (const lattice of order.lattice ?? []) {
    const oneBest: XunfeiOneBest = JSON.parse(lattice.json_1best)
    const st = oneBest.st
    const start = Number(st.bg) / 1000
    const end = Number(st.ed) / 1000
    const text = st.rt
      .flatMap((r) => r.ws)
      .flatMap((ws) => ws.cw)
      .map((cw) => cw.w)
      .join("")
    if (text.trim()) segments.push({ start, end, text: text.trim() })
  }

  return segments
}

export async function transcribeWithXunfei(
  audioBuffer: Buffer,
  language: string = "cn" // cn | en | ja | ko 等
): Promise<Segment[]> {
  const appId = process.env.XUNFEI_APP_ID
  const apiKey = process.env.XUNFEI_API_KEY
  if (!appId || !apiKey) throw new Error("XUNFEI_APP_ID 或 XUNFEI_API_KEY 未设置")

  // 1. 预处理：获取 orderId
  const prepareRes = await request("/prepare", appId, apiKey, {
    fileName: "audio.wav",
    fileSize: String(audioBuffer.byteLength),
    sliceNum: "1",
    duration: "0",
    language,
  })
  if (prepareRes.code !== "000000") {
    throw new Error(`讯飞预处理失败: ${prepareRes.action} ${prepareRes.code}`)
  }
  const orderId: string = JSON.parse(prepareRes.data).orderId

  // 2. 上传音频
  await upload(appId, apiKey, orderId, audioBuffer)

  // 3. 合并（通知服务端开始转写）
  const mergeRes = await request("/merge", appId, apiKey, { orderId })
  if (mergeRes.code !== "000000") {
    throw new Error(`讯飞合并失败: ${mergeRes.action} ${mergeRes.code}`)
  }

  // 4. 轮询进度
  const deadline = Date.now() + POLL_TIMEOUT
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL))

    const progressRes = await request("/getProgress", appId, apiKey, { orderId })
    if (progressRes.code !== "000000") {
      throw new Error(`讯飞查询进度失败: ${progressRes.code}`)
    }
    const progress = JSON.parse(progressRes.data)
    // status 9 = 转写完成
    if (progress.status === 9) break
    // status 负数 = 转写失败
    if (progress.status < 0) {
      throw new Error(`讯飞转写失败，status=${progress.status}`)
    }
  }

  // 5. 获取结果
  const resultRes = await request("/getResult", appId, apiKey, { orderId })
  if (resultRes.code !== "000000") {
    throw new Error(`讯飞获取结果失败: ${resultRes.code}`)
  }

  return parseResult(resultRes.data)
}
