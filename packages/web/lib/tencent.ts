import crypto from "crypto";
import type { Segment } from "@subgen/shared";

const ENDPOINT = "tmt.tencentcloudapi.com";
const SERVICE  = "tmt";
const VERSION  = "2018-03-21";
const REGION   = "ap-guangzhou";
const BATCH_SIZE = 50; // 腾讯翻译单次最多 50 条

function sign(secretId: string, secretKey: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const action = "TextTranslateBatch";

  const canonicalRequest = [
    "POST",
    "/",
    "",
    "content-type:application/json\nhost:" + ENDPOINT + "\n",
    "content-type;host",
    crypto.createHash("sha256").update(body).digest("hex"),
  ].join("\n");

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    timestamp,
    credentialScope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const hmac = (key: Buffer | string, data: string) =>
    crypto.createHmac("sha256", key).update(data).digest();

  const secretDate    = hmac("TC3" + secretKey, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature     = crypto.createHmac("sha256", secretSigning).update(stringToSign).digest("hex");

  return {
    "Content-Type":  "application/json",
    "Host":          ENDPOINT,
    "X-TC-Action":   action,
    "X-TC-Version":  VERSION,
    "X-TC-Region":   REGION,
    "X-TC-Timestamp": String(timestamp),
    "Authorization": `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`,
  };
}

export async function translateSegments(
  segments: Segment[],
  sourceLang: string = "ja",
  targetLang: string = "zh"
): Promise<Segment[]> {
  const secretId  = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) throw new Error("TENCENT_SECRET_ID 或 TENCENT_SECRET_KEY 未设置");

  const src = sourceLang.toLowerCase();
  const tgt = targetLang.toLowerCase().replace("zh-tw", "zh-TW").replace("en-us", "en");

  const texts = segments.map((s) => s.text);
  const translated: string[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const body = JSON.stringify({
      SourceTextList: batch,
      Source: src,
      Target: tgt,
      ProjectId: 0,
    });

    const headers = sign(secretId, secretKey, body);
    const res = await fetch(`https://${ENDPOINT}`, {
      method:  "POST",
      headers,
      body,
    });

    const data = await res.json();
    if (data.Response?.Error) {
      throw new Error(`腾讯翻译错误: ${data.Response.Error.Code} ${data.Response.Error.Message}`);
    }

    data.Response.TargetTextList.forEach((t: string) => translated.push(t));
  }

  const result = segments.map((seg, i) => ({ ...seg, text: translated[i] ?? seg.text }));

  // 检测翻译是否生效：源语言和目标语言不同时，结果不应全等于原文
  if (src !== tgt && segments.every((s, i) => s.text === (result[i]?.text ?? ""))) {
    console.warn("[tencent] 翻译结果与原文一致，翻译可能未生效");
  }

  return result;
}
