use std::path::Path;
use std::fs;

use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::types::{GenerateOptions, Segment};
use super::utils::clean_key;

/// HMAC-SHA256 类型别名，仅在本模块内部使用
type HmacSha256 = Hmac<Sha256>;

// ─────────────────────────────────────────────
// DeepL 翻译
// ─────────────────────────────────────────────

/// 调用 DeepL API 批量翻译 Segment 列表。
///
/// 每批最多发送 50 条文本（DeepL 的批量接口限制），
/// 返回翻译后的 Segment 列表（时间戳保持不变，只替换文本）。
///
/// DeepL 免费版（:fx 后缀 key）和专业版使用不同的 API 域名，
/// 需要根据 key 后缀自动切换，否则会返回 403 鉴权失败。
pub async fn translate_with_deepl(
    client: &Client,
    segments: &[Segment],
    target_lang: &str,
    api_key: &str,
) -> Result<Vec<Segment>, String> {
    // 通过 key 是否以 ":fx" 结尾判断是否为免费版
    let api_url = if api_key.ends_with(":fx") {
        "https://api-free.deepl.com/v2/translate"
    } else {
        "https://api.deepl.com/v2/translate"
    };

    let mut translated = Vec::new();
    // 每次最多 50 条，分批请求，避免超过 API 单次限制
    for batch in segments.chunks(50) {
        let mut params = Vec::new();
        for seg in batch {
            params.push(("text", seg.text.clone()));
        }
        params.push(("target_lang", target_lang.to_string()));

        let res = client
            .post(api_url)
            .header("Authorization", format!("DeepL-Auth-Key {api_key}"))
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("DeepL 请求失败: {e}"))?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(format!("DeepL API 错误 {status}: {text}"));
        }

        let data: Value = res.json().await.map_err(|e| format!("解析 DeepL 响应失败: {e}"))?;
        let values = data
            .get("translations")
            .and_then(Value::as_array)
            .ok_or("DeepL 响应缺少 translations")?;
        for item in values {
            translated.push(
                item.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
            );
        }
    }

    // 将翻译文本与原始 Segment 的时间戳合并，保持一一对应
    Ok(segments
        .iter()
        .enumerate()
        .map(|(i, seg)| Segment {
            start: seg.start,
            end: seg.end,
            text: translated.get(i).cloned().unwrap_or_else(|| seg.text.clone()),
        })
        .collect())
}

// ─────────────────────────────────────────────
// 腾讯翻译 签名
// ─────────────────────────────────────────────

/// 计算 SHA256 哈希并返回 16 进制字符串，用于腾讯云 TC3 签名。
fn sha256_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

/// 计算 HMAC-SHA256，用于生成腾讯云 TC3 签名的各级密钥。
fn hmac_sha256(key: &[u8], input: &str) -> Vec<u8> {
    // new_from_slice 接受任意长度密钥，此处 expect 不会 panic
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(input.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// 生成腾讯云 API TC3-HMAC-SHA256 签名所需的 HTTP 请求头列表。
///
/// TC3 签名算法步骤：
/// 1. 构造规范化请求（CanonicalRequest）
/// 2. 构造待签字符串（StringToSign）
/// 3. 逐级派生签名密钥：SecretKey → SecretDate → SecretService → SecretSigning
/// 4. 用最终密钥签名 StringToSign 得到 Signature
///
/// 返回需要附加到 HTTP 请求的所有头部（Content-Type、Host、X-TC-* 等）。
fn sign_tencent(secret_id: &str, secret_key: &str, body: &str) -> Vec<(String, String)> {
    let endpoint = "tmt.tencentcloudapi.com";
    let service = "tmt";
    let version = "2018-03-21";
    let region = "ap-guangzhou"; // 使用广州区域，国内延迟最低
    let action = "TextTranslateBatch";
    let timestamp = Utc::now().timestamp();
    let date = chrono::DateTime::from_timestamp(timestamp, 0)
        .unwrap()
        .format("%Y-%m-%d")
        .to_string();

    // 规范化请求：将请求方法、路径、查询字符串、头部、签名头、body hash 拼接
    let canonical_request = [
        "POST".to_string(),
        "/".to_string(),
        "".to_string(), // 无查询字符串
        format!("content-type:application/json\nhost:{endpoint}\n"),
        "content-type;host".to_string(),
        sha256_hex(body),
    ]
    .join("\n");

    let credential_scope = format!("{date}/{service}/tc3_request");
    let string_to_sign = [
        "TC3-HMAC-SHA256".to_string(),
        timestamp.to_string(),
        credential_scope.clone(),
        sha256_hex(&canonical_request),
    ]
    .join("\n");

    // 逐级 HMAC 派生签名密钥（腾讯云 TC3 固定算法）
    let secret_date    = hmac_sha256(format!("TC3{secret_key}").as_bytes(), &date);
    let secret_service = hmac_sha256(&secret_date, service);
    let secret_signing = hmac_sha256(&secret_service, "tc3_request");
    let signature = hex::encode(hmac_sha256(&secret_signing, &string_to_sign));

    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, SignedHeaders=content-type;host, Signature={signature}"
    );

    vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Host".to_string(), endpoint.to_string()),
        ("X-TC-Action".to_string(), action.to_string()),
        ("X-TC-Version".to_string(), version.to_string()),
        ("X-TC-Region".to_string(), region.to_string()),
        ("X-TC-Timestamp".to_string(), timestamp.to_string()),
        ("Authorization".to_string(), authorization),
    ]
}

// ─────────────────────────────────────────────
// 腾讯翻译 API 调用
// ─────────────────────────────────────────────

/// 调用腾讯翻译 API 翻译一批文本，带指数退避重试（最多 4 次）。
///
/// 重试逻辑：
/// - Internal / LimitExceeded 错误：可能是临时限流，退避后重试
/// - 其他 API 错误（如鉴权失败）：直接返回，重试无意义
/// - 网络错误 / 响应解析失败：继续重试
async fn translate_batch_tencent(
    client: &Client,
    texts: Vec<String>,
    src: &str,
    tgt: &str,
    secret_id: &str,
    secret_key: &str,
) -> Result<Vec<String>, String> {
    let body = json!({
        "SourceTextList": texts,
        "Source": src,
        "Target": tgt,
        "ProjectId": 0 // 默认项目 ID
    })
    .to_string();

    let mut last_err = String::from("未知错误");

    for attempt in 0u32..4 {
        // 指数退避：第 1 次立即，第 2 次等 300ms，第 3 次 600ms，第 4 次 1200ms
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(
                300 * 2u64.pow(attempt - 1),
            ))
            .await;
        }

        // 每次请求都需要重新签名（timestamp 会变化）
        let mut req = client.post("https://tmt.tencentcloudapi.com").body(body.clone());
        for (k, v) in sign_tencent(secret_id, secret_key, &body) {
            req = req.header(k, v);
        }

        let res = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("网络请求失败: {e}");
                continue;
            }
        };
        if !res.status().is_success() {
            last_err = format!("HTTP {}", res.status());
            continue;
        }

        let data: Value = match res.json().await {
            Ok(d) => d,
            Err(e) => {
                last_err = format!("响应解析失败: {e}");
                continue;
            }
        };

        // 检查 API 层错误（与 HTTP 状态码无关）
        if let Some(error) = data.pointer("/Response/Error") {
            let code = error.get("Code").and_then(Value::as_str).unwrap_or("");
            let msg  = error.get("Message").and_then(Value::as_str).unwrap_or("");
            last_err = format!("腾讯翻译 API 错误 [{code}]: {msg}");
            // 限流 / 内部错误可重试；鉴权失败等直接终止
            if code.contains("Internal") || code.contains("LimitExceeded") {
                continue;
            }
            return Err(last_err);
        }

        if let Some(arr) = data.pointer("/Response/TargetTextList").and_then(Value::as_array) {
            let result: Vec<String> = arr.iter()
                .map(|v| v.as_str().unwrap_or("").to_string())
                .collect();
            if result.len() == texts.len() {
                return Ok(result);
            }
            last_err = format!("返回条数不匹配（期望 {}，实际 {}）", texts.len(), result.len());
        }
    }
    Err(format!("翻译失败（重试 4 次）: {last_err}"))
}

/// 腾讯翻译主函数：支持翻译缓存 + 分批（≤5000 字符 / ≤50 条）+ 串行请求。
///
/// 缓存机制：
/// - 缓存 key = 源文本 hash + 语言对，存为 trl_<hash>.json
/// - 命中缓存且长度匹配时直接返回，跳过网络请求
/// - skip_cache=true 时删除已有缓存，强制重新翻译
///
/// 分批原因：腾讯翻译 API 单次请求最多 50 条且不超过 5000 字符，
/// 长字幕需要拆成多批发送。
///
/// 串行原因：腾讯翻译 API 限速约 5 次/秒，并发容易触发 LimitExceeded，
/// 批次间加 250ms 间隔可在大多数情况下避免限流。
pub async fn translate_with_tencent(
    client: &Client,
    segments: &[Segment],
    source_lang: &str,
    target_lang: &str,
    secret_id: &str,
    secret_key: &str,
    cache_dir: Option<&Path>,
    skip_cache: bool,
) -> Result<Vec<Segment>, String> {
    // 统一语言代码格式（腾讯 API 要求小写）
    let src = source_lang.to_lowercase();
    let tgt = target_lang
        .to_lowercase()
        .replace("zh-tw", "zh-TW") // 腾讯繁体中文代码使用混合大小写
        .replace("en-us", "en");   // 腾讯不区分 en 变体

    // 缓存 key：基于所有源文本 + 语言对的哈希，前 16 位已足够唯一
    let cache_key = {
        let all_text: String = segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join("\n");
        let hash = hex::encode(sha2::Sha256::digest(
            format!("{all_text}|{src}|{tgt}").as_bytes(),
        ));
        hash[..16].to_string()
    };
    let cache_file = cache_dir.map(|d| d.join(format!("trl_{cache_key}.json")));

    // 尝试读取缓存
    if !skip_cache {
        if let Some(ref f) = cache_file {
            if let Ok(raw) = fs::read_to_string(f) {
                if let Ok(cached) = serde_json::from_str::<Vec<Segment>>(&raw) {
                    // 条数一致才使用缓存，防止因源文本变化导致时间轴错位
                    if cached.len() == segments.len() {
                        return Ok(cached);
                    }
                }
            }
        }
    } else if let Some(ref f) = cache_file {
        fs::remove_file(f).ok(); // 强制刷新：删除旧缓存
    }

    // 分批：每批 ≤50 条且 ≤5000 字符（按 Unicode 字符计，与腾讯限制一致）
    let mut batches: Vec<(usize, Vec<String>)> = Vec::new();
    let mut cur_texts: Vec<String> = Vec::new();
    let mut cur_start = 0usize;
    let mut cur_chars = 0usize;

    for (i, seg) in segments.iter().enumerate() {
        let len = seg.text.chars().count();
        if !cur_texts.is_empty() && (cur_chars + len > 5000 || cur_texts.len() >= 50) {
            batches.push((cur_start, std::mem::take(&mut cur_texts)));
            cur_start = i;
            cur_chars = 0;
        }
        cur_texts.push(seg.text.clone());
        cur_chars += len;
    }
    if !cur_texts.is_empty() {
        batches.push((cur_start, cur_texts));
    }

    // 串行翻译，批次间等 250ms，避免触发腾讯 API 限速
    let mut translated = vec![String::new(); segments.len()];
    for (batch_no, (start_idx, texts)) in batches.into_iter().enumerate() {
        if batch_no > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        let result = translate_batch_tencent(
            client, texts.clone(), &src, &tgt, secret_id, secret_key,
        ).await?;
        for (i, text) in result.into_iter().enumerate() {
            if start_idx + i < translated.len() {
                // 翻译结果为空时回退到原文（避免字幕出现空白行）
                translated[start_idx + i] = if text.is_empty() { texts[i].clone() } else { text };
            }
        }
    }

    let result: Vec<Segment> = segments.iter().enumerate().map(|(i, seg)| Segment {
        start: seg.start,
        end: seg.end,
        text: translated.get(i).cloned().unwrap_or_else(|| seg.text.clone()),
    }).collect();

    // 写入缓存，供下次跳过翻译步骤
    if let Some(ref f) = cache_file {
        if let Ok(json) = serde_json::to_string(&result) {
            fs::write(f, json).ok();
        }
    }

    Ok(result)
}

// ─────────────────────────────────────────────
// 统一翻译入口
// ─────────────────────────────────────────────

/// 根据 GenerateOptions.translate_provider 路由到对应翻译实现。
pub async fn translate_segments(
    client: &Client,
    segments: &[Segment],
    opts: &GenerateOptions,
    cache_dir: Option<&Path>,
) -> Result<Vec<Segment>, String> {
    match opts.translate_provider.as_str() {
        "deepl" => {
            let key = clean_key(&opts.deepl_api_key).ok_or("请先在设置中填写 DeepL API Key")?;
            translate_with_deepl(client, segments, &opts.target_lang, &key).await
        }
        "tencent" => {
            let secret_id =
                clean_key(&opts.tencent_secret_id).ok_or("请先在设置中填写腾讯云 SecretId")?;
            let secret_key =
                clean_key(&opts.tencent_secret_key).ok_or("请先在设置中填写腾讯云 SecretKey")?;
            translate_with_tencent(
                client,
                segments,
                &opts.source_lang,
                &opts.target_lang,
                &secret_id,
                &secret_key,
                cache_dir,
                opts.skip_cache.unwrap_or(false),
            )
            .await
        }
        _ => Err("请选择 DeepL 或腾讯翻译".to_string()),
    }
}
