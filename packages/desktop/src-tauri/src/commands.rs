use std::path::{Path, PathBuf};
use std::process::Command;
use std::{env, fs};

use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Serialize, Deserialize)]
pub struct ExtractOptions {
    pub inputs: Vec<String>,  // 支持多文件
    pub output_dir: String,
    /// 0 = 完整音频
    pub duration: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ExtractFileResult {
    pub input: String,
    pub output: String,
    pub elapsed_secs: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ExtractResult {
    pub files: Vec<ExtractFileResult>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateOptions {
    pub input: String,
    pub output_dir: String,
    pub source_lang: String,
    pub target_lang: String,
    pub bilingual: bool,
    pub asr_provider: String,
    pub translate_provider: String,
    pub groq_api_key: Option<String>,
    pub siliconflow_api_key: Option<String>,
    pub deepl_api_key: Option<String>,
    pub tencent_secret_id: Option<String>,
    pub tencent_secret_key: Option<String>,
    pub chunk_seconds: Option<u32>,
    pub skip_cache: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct GenerateResult {
    pub segments: Vec<Segment>,
    pub translated: Vec<Segment>,
    pub original_srt: String,
    pub translated_srt: String,
    pub bilingual_srt: Option<String>,
    pub original_path: String,
    pub translated_path: String,
    pub bilingual_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProgressPayload {
    pub stage: String,
    pub ratio: f64,
    pub message: String,
    pub elapsed_secs: Option<f64>,  // 当前阶段已用秒数
}

#[derive(Debug, Deserialize)]
struct ApiSegment {
    start: f64,
    end: f64,
    text: String,
}

#[derive(Debug, Deserialize)]
struct WhisperResponse {
    segments: Option<Vec<ApiSegment>>,
}

/// 确保 ffmpeg 可用，返回路径
/// 优先级：Tauri resource 内置 → 系统 PATH → 常见安装路径
fn resolve_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };

    // 1. Tauri resource 目录内置 ffmpeg（最优先，独立于系统环境）
    if let Ok(resource_path) = app.path().resource_dir() {
        let bundled = resource_path.join(name);
        if bundled.is_file() {
            // 确保有执行权限
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&bundled) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    fs::set_permissions(&bundled, perms).ok();
                }
            }
            return Ok(bundled);
        }
    }

    // 2. 系统 PATH + 常见安装路径
    let sep = if cfg!(windows) { ';' } else { ':' };
    let path_str = env::var("PATH").unwrap_or_default();
    let extra: &[&str] = if cfg!(windows) {
        &["C:\\ffmpeg\\bin", "C:\\Program Files\\ffmpeg\\bin", "C:\\Program Files (x86)\\ffmpeg\\bin"]
    } else if cfg!(target_os = "macos") {
        &["/usr/local/bin", "/opt/homebrew/bin", "/opt/homebrew/opt/ffmpeg/bin", "/usr/bin"]
    } else {
        // Linux
        &["/usr/bin", "/usr/local/bin", "/snap/bin"]
    };
    for dir in path_str.split(sep).chain(extra.iter().copied()) {
        let p = PathBuf::from(dir).join(name);
        if p.is_file() {
            return Ok(p);
        }
    }

    Err("未找到 ffmpeg，请在系统中安装 ffmpeg 或重新安装 SubGen".to_string())
}

fn emit_progress(app: &AppHandle, stage: &str, ratio: f64, message: impl Into<String>) {
    emit_progress_with_elapsed(app, stage, ratio, message, None);
}

fn emit_progress_with_elapsed(app: &AppHandle, stage: &str, ratio: f64, message: impl Into<String>, elapsed: Option<f64>) {
    let _ = app.emit(
        "subtitle-progress",
        ProgressPayload {
            stage: stage.to_string(),
            ratio,
            message: message.into(),
            elapsed_secs: elapsed,
        },
    );
}


fn clean_key(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn dirs_cache() -> PathBuf {
    let base = env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join(".subgen_cache")
}

/// 获取内置 whisper-cli 路径
fn resolve_whisper(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" };
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join(name);
        if p.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&p) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    fs::set_permissions(&p, perms).ok();
                }
            }
            return Ok(p);
        }
    }
    // fallback 到系统 PATH
    for dir in env::var("PATH").unwrap_or_default().split(':') {
        let p = PathBuf::from(dir).join(name);
        if p.is_file() { return Ok(p); }
    }
    Err("未找到 whisper-cli，请重新安装 SubGen".to_string())
}

/// 默认模型路径 ~/.subgen_cache/models/ggml-small.bin
fn default_model_path() -> PathBuf {
    dirs_cache().join("models").join("ggml-small.bin")
}

/// 用 whisper-cli 转录单个 WAV，返回 segments（并发安全）
async fn transcribe_with_whisper(
    whisper: &Path,
    model: &Path,
    wav: &Path,
    language: &str,
    time_offset: f64,
) -> Result<Vec<Segment>, String> {
    let whisper = whisper.to_path_buf();
    let model = model.to_path_buf();
    let wav = wav.to_path_buf();
    let language = language.to_string();

    tokio::task::spawn_blocking(move || {
        // whisper-cli 输出 SRT 到 stdout
        // 用 -of 明确指定输出前缀，避免写权限问题
        let srt_prefix = wav.with_extension("");
        let srt_path = wav.with_extension("srt");

        let output = Command::new(&whisper)
            .args([
                "-m", &model.to_string_lossy(),
                "-f", &wav.to_string_lossy(),
                "-l", &language,
                "-osrt",                              // 生成 SRT
                "-of", &srt_prefix.to_string_lossy(), // 明确输出路径前缀
                "-np",                                // 不打印额外信息
            ])
            .output()
            .map_err(|e| format!("whisper-cli 执行失败: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(format!("whisper-cli 错误:\nstderr: {stderr}\nstdout: {stdout}"));
        }

        if !srt_path.exists() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(format!(
                "whisper-cli 未生成 SRT 文件: {}\nstderr: {}\nstdout: {}",
                srt_path.display(), stderr, stdout
            ));
        }

        let srt = fs::read_to_string(&srt_path)
            .map_err(|e| format!("读取 SRT 失败: {e}"))?;
        fs::remove_file(&srt_path).ok();

        parse_srt_to_segments(&srt, time_offset)
    })
    .await
    .map_err(|e| format!("转录任务异常: {e}"))?
}

/// 解析 SRT 文本为 Segment 列表，时间加上偏移量
fn parse_srt_to_segments(srt: &str, offset: f64) -> Result<Vec<Segment>, String> {
    let mut segments = Vec::new();
    let mut lines = srt.lines().peekable();
    while let Some(line) = lines.next() {
        let line = line.trim();
        if line.is_empty() || line.parse::<u64>().is_ok() { continue; }
        // 时间行：00:00:00,000 --> 00:00:01,500
        if line.contains("-->") {
            let parts: Vec<&str> = line.split("-->").collect();
            if parts.len() != 2 { continue; }
            let start = parse_srt_time(parts[0].trim()) + offset;
            let end   = parse_srt_time(parts[1].trim()) + offset;
            let mut text_lines = Vec::new();
            while let Some(tl) = lines.peek() {
                let tl = tl.trim();
                if tl.is_empty() { lines.next(); break; }
                text_lines.push(tl.to_string());
                lines.next();
            }
            let text = text_lines.join(" ").trim().to_string();
            if !text.is_empty() {
                segments.push(Segment { start, end, text });
            }
        }
    }
    Ok(segments)
}

fn parse_srt_time(s: &str) -> f64 {
    // HH:MM:SS,mmm
    let s = s.trim().replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 { return 0.0; }
    let h: f64 = parts[0].parse().unwrap_or(0.0);
    let m: f64 = parts[1].parse().unwrap_or(0.0);
    let sec: f64 = parts[2].parse().unwrap_or(0.0);
    h * 3600.0 + m * 60.0 + sec
}

/// 检查 whisper 模型是否存在
#[tauri::command]
pub fn check_whisper_model(app: AppHandle) -> serde_json::Value {
    let whisper_ok = resolve_whisper(&app).is_ok();
    let model_path = default_model_path();
    let model_ok = model_path.exists();
    serde_json::json!({
        "whisper": whisper_ok,
        "model": model_ok,
        "model_path": model_path.to_string_lossy()
    })
}

/// 下载 ggml-small 模型到 ~/.subgen_cache/models/
#[tauri::command]
pub async fn download_whisper_model() -> Result<String, String> {
    let model_path = default_model_path();
    if model_path.exists() {
        return Ok(model_path.to_string_lossy().to_string());
    }
    fs::create_dir_all(model_path.parent().unwrap())
        .map_err(|e| format!("创建模型目录失败: {e}"))?;

    // 优先用国内镜像，HuggingFace 在国内访问受限
    let url = "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";

    let status = Command::new("curl")
        .args(["-L", "--progress-bar", "-o"])
        .arg(&model_path)
        .arg(url)
        .status()
        .map_err(|e| format!("curl 不可用: {e}"))?;

    if !status.success() {
        fs::remove_file(&model_path).ok();
        return Err("模型下载失败，请检查网络".to_string());
    }
    Ok(model_path.to_string_lossy().to_string())
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("subtitle")
        .to_string()
}

fn to_srt_time(seconds: f64) -> String {
    let total_ms = (seconds.max(0.0) * 1000.0).floor() as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
}

fn segments_to_srt(segments: &[Segment]) -> String {
    segments
        .iter()
        .enumerate()
        .map(|(i, seg)| {
            format!(
                "{}\n{} --> {}\n{}\n",
                i + 1,
                to_srt_time(seg.start),
                to_srt_time(seg.end),
                seg.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn merge_bilingual(original: &[Segment], translated: &[Segment]) -> String {
    original
        .iter()
        .enumerate()
        .map(|(i, seg)| {
            let translated_text = translated.get(i).map(|s| s.text.as_str()).unwrap_or("");
            format!(
                "{}\n{} --> {}\n{}\n{}\n",
                i + 1,
                to_srt_time(seg.start),
                to_srt_time(seg.end),
                seg.text,
                translated_text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn split_audio_for_asr(
    app: &AppHandle,
    input: &Path,
    chunk_dir: &Path,
    chunk_seconds: u32,
) -> Result<Vec<PathBuf>, String> {
    let ffmpeg = resolve_ffmpeg(app)?;
    fs::create_dir_all(chunk_dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    let output_pattern = chunk_dir.join("chunk_%05d.wav");

    let status = Command::new(ffmpeg)
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(input)
        .arg("-vn")
        .arg("-acodec")
        .arg("pcm_s16le")
        .arg("-ar")
        .arg("16000")
        .arg("-ac")
        .arg("1")
        .arg("-f")
        .arg("segment")
        .arg("-segment_time")
        .arg(chunk_seconds.to_string())
        .arg("-reset_timestamps")
        .arg("1")
        .arg(output_pattern)
        .status()
        .map_err(|e| format!("ffmpeg 分片失败: {e}"))?;

    if !status.success() {
        return Err(format!("ffmpeg 分片返回错误: {status}"));
    }

    let mut chunks = fs::read_dir(chunk_dir)
        .map_err(|e| format!("读取临时分片失败: {e}"))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().and_then(|s| s.to_str()) == Some("wav"))
        .collect::<Vec<_>>();
    chunks.sort();

    if chunks.is_empty() {
        return Err("未能从媒体文件提取到音频".to_string());
    }

    Ok(chunks)
}

async fn transcribe_with_groq(
    client: &reqwest::Client,
    path: &Path,
    language: &str,
    api_key: &str,
) -> Result<Vec<Segment>, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取音频分片失败: {e}"))?;
    let _file_size = bytes.len();
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio.wav")
        .to_string();


    let part = Part::bytes(bytes)
        .file_name(filename)
        .mime_str("audio/wav")
        .map_err(|e| format!("构造上传分片失败: {e}"))?;
    let form = Form::new()
        .part("file", part)
        .text("model", "whisper-large-v3-turbo")
        .text("language", language.to_string())
        .text("response_format", "verbose_json")
        .text("timestamp_granularities[]", "segment");

    let res = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Groq 请求失败: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();

    if !status.is_success() {
        eprintln!("[Groq] 响应 body: {body}");
        return Err(format!("Groq API 错误 {status}: {body}"));
    }

    serde_json::from_str::<WhisperResponse>(&body)
        .map_err(|e| format!("解析 Groq 响应失败: {e}\nbody: {body}"))
        .and_then(parse_whisper_response)
}

async fn transcribe_with_siliconflow(
    client: &reqwest::Client,
    path: &Path,
    language: &str,
    api_key: &str,
) -> Result<Vec<Segment>, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取音频分片失败: {e}"))?;
    let _file_size = bytes.len();
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio.wav")
        .to_string();


    let part = Part::bytes(bytes)
        .file_name(filename.clone())
        .mime_str("audio/wav")
        .map_err(|e| format!("构造上传分片失败: {e}"))?;
    let form = Form::new()
        .part("file", part)
        .text("model", "FunAudioLLM/SenseVoiceSmall")
        .text("language", language.to_string())
        .text("response_format", "verbose_json")
        .text("timestamp_granularities[]", "segment");

    let res = client
        .post("https://api.siliconflow.cn/v1/audio/transcriptions")
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("SiliconFlow 请求失败: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();

    eprintln!("[SiliconFlow] 响应 body: {body}");

    if !status.is_success() {
        return Err(format!("SiliconFlow API 错误 {status}: {body}"));
    }

    let data: WhisperResponse = serde_json::from_str(&body)
        .map_err(|e| format!("解析 SiliconFlow 响应失败: {e}\nbody: {body}"))?;

    parse_whisper_response(data)
}

fn parse_whisper_response(data: WhisperResponse) -> Result<Vec<Segment>, String> {
    if let Some(segments) = data.segments {
        let result = segments
            .into_iter()
            .map(|s| Segment {
                start: s.start,
                end: s.end,
                text: s.text.trim().to_string(),
            })
            .filter(|s| !s.text.is_empty())
            .collect::<Vec<_>>();
        if !result.is_empty() {
            return Ok(result);
        }
    }

    // segments 为空说明该分片没有语音内容，直接返回空（不用整段文字 fallback）
    Ok(Vec::new())
}

async fn transcribe_chunk(
    client: &reqwest::Client,
    provider: &str,
    path: &Path,
    language: &str,
    opts: &GenerateOptions,
) -> Result<Vec<Segment>, String> {
    match provider {
        "groq" => {
            let key = clean_key(&opts.groq_api_key).ok_or("请先在设置中填写 Groq API Key")?;
            transcribe_with_groq(client, path, language, &key).await
        }
        "siliconflow" => {
            let key = clean_key(&opts.siliconflow_api_key)
                .ok_or("请先在设置中填写 SiliconFlow API Key")?;
            transcribe_with_siliconflow(client, path, language, &key).await
        }
        _ => Err("当前桌面版暂未内置本地 Whisper，请选择 Groq 或 SiliconFlow".to_string()),
    }
}

async fn translate_with_deepl(
    client: &reqwest::Client,
    segments: &[Segment],
    target_lang: &str,
    api_key: &str,
) -> Result<Vec<Segment>, String> {
    let api_url = if api_key.ends_with(":fx") {
        "https://api-free.deepl.com/v2/translate"
    } else {
        "https://api.deepl.com/v2/translate"
    };
    let mut translated = Vec::new();
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

        let data: Value = res
            .json()
            .await
            .map_err(|e| format!("解析 DeepL 响应失败: {e}"))?;
        let values = data
            .get("translations")
            .and_then(Value::as_array)
            .ok_or("DeepL 响应缺少 translations")?;
        for item in values {
            translated.push(
                item.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            );
        }
    }

    Ok(segments
        .iter()
        .enumerate()
        .map(|(i, seg)| Segment {
            start: seg.start,
            end: seg.end,
            text: translated
                .get(i)
                .cloned()
                .unwrap_or_else(|| seg.text.clone()),
        })
        .collect())
}

fn sha256_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

fn hmac_sha256(key: &[u8], input: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(input.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn sign_tencent(secret_id: &str, secret_key: &str, body: &str) -> Vec<(String, String)> {
    let endpoint = "tmt.tencentcloudapi.com";
    let service = "tmt";
    let version = "2018-03-21";
    let region = "ap-guangzhou";
    let action = "TextTranslateBatch";
    let timestamp = Utc::now().timestamp();
    let date = chrono::DateTime::from_timestamp(timestamp, 0)
        .unwrap()
        .format("%Y-%m-%d")
        .to_string();

    let canonical_request = [
        "POST".to_string(),
        "/".to_string(),
        "".to_string(),
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

    let secret_date = hmac_sha256(format!("TC3{secret_key}").as_bytes(), &date);
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

/// 单批翻译，带重试 + 兜底（失败返回原文）
async fn translate_batch_tencent(
    client: &reqwest::Client,
    texts: Vec<String>,
    src: &str,
    tgt: &str,
    secret_id: &str,
    secret_key: &str,
) -> Vec<String> {
    let body = json!({
        "SourceTextList": texts,
        "Source": src,
        "Target": tgt,
        "ProjectId": 0
    }).to_string();

    for attempt in 0u32..4 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(300 * 2u64.pow(attempt - 1))).await;
        }
        let mut req = client.post("https://tmt.tencentcloudapi.com").body(body.clone());
        for (k, v) in sign_tencent(secret_id, secret_key, &body) {
            req = req.header(k, v);
        }
        let res = match req.send().await {
            Ok(r) => r,
            Err(_) => continue,
        };
        if !res.status().is_success() { continue; }
        let data: Value = match res.json().await {
            Ok(d) => d,
            Err(_) => continue,
        };
        if let Some(error) = data.pointer("/Response/Error") {
            let code = error.get("Code").and_then(Value::as_str).unwrap_or("");
            // 可重试的错误：InternalError / RequestLimitExceeded
            if code.contains("Internal") || code.contains("LimitExceeded") { continue; }
            // 不可重试，兜底返回原文
            break;
        }
        if let Some(arr) = data.pointer("/Response/TargetTextList").and_then(Value::as_array) {
            let result: Vec<String> = arr.iter()
                .map(|v| v.as_str().unwrap_or("").to_string())
                .collect();
            if result.len() == texts.len() {
                return result;
            }
        }
    }
    // 所有重试失败 → 兜底：返回原文
    texts
}

async fn translate_with_tencent(
    client: &reqwest::Client,
    segments: &[Segment],
    source_lang: &str,
    target_lang: &str,
    secret_id: &str,
    secret_key: &str,
    cache_dir: Option<&Path>,
    skip_cache: bool,
) -> Result<Vec<Segment>, String> {
    let src = source_lang.to_lowercase();
    let tgt = target_lang
        .to_lowercase()
        .replace("zh-tw", "zh-TW")
        .replace("en-us", "en");

    // ── 缓存 key：源文本 hash + 语言对 ──────────────────────
    let cache_key = {
        let all_text: String = segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join("\n");
        let hash = hex::encode(sha2::Sha256::digest(format!("{all_text}|{src}|{tgt}").as_bytes()));
        hash[..16].to_string()
    };
    let cache_file = cache_dir.map(|d| d.join(format!("trl_{cache_key}.json")));

    // 命中缓存
    if !skip_cache {
        if let Some(ref f) = cache_file {
            if let Ok(raw) = fs::read_to_string(f) {
                if let Ok(cached) = serde_json::from_str::<Vec<Segment>>(&raw) {
                    if cached.len() == segments.len() {
                        return Ok(cached);
                    }
                }
            }
        }
    } else if let Some(ref f) = cache_file {
        fs::remove_file(f).ok();
    }

    // ── 分批，每批 ≤ 5000 字符 & ≤ 50 条 ────────────────────
    let mut batches: Vec<(usize, Vec<String>)> = Vec::new(); // (起始索引, 文本列表)
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

    // ── 并发翻译所有批次 ─────────────────────────────────────
    let src = std::sync::Arc::new(src);
    let tgt = std::sync::Arc::new(tgt);
    let secret_id = std::sync::Arc::new(secret_id.to_string());
    let secret_key = std::sync::Arc::new(secret_key.to_string());

    let mut handles = Vec::new();
    for (start_idx, texts) in batches {
        let client = client.clone();
        let src = src.clone();
        let tgt = tgt.clone();
        let sid = secret_id.clone();
        let skey = secret_key.clone();
        handles.push(tokio::spawn(async move {
            let result = translate_batch_tencent(&client, texts.clone(), &src, &tgt, &sid, &skey).await;
            (start_idx, texts, result)
        }));
    }

    let mut translated = vec![String::new(); segments.len()];
    for handle in handles {
        let (start_idx, originals, result) = handle.await.map_err(|e| format!("翻译任务异常: {e}"))?;
        for (i, text) in result.into_iter().enumerate() {
            if start_idx + i < translated.len() {
                // 兜底：空结果用原文
                translated[start_idx + i] = if text.is_empty() {
                    originals[i].clone()
                } else {
                    text
                };
            }
        }
    }

    let result: Vec<Segment> = segments.iter().enumerate().map(|(i, seg)| Segment {
        start: seg.start,
        end: seg.end,
        text: translated.get(i).cloned().unwrap_or_else(|| seg.text.clone()),
    }).collect();

    // 写缓存
    if let Some(ref f) = cache_file {
        if let Ok(json) = serde_json::to_string(&result) {
            fs::write(f, json).ok();
        }
    }

    Ok(result)
}

async fn translate_segments(
    client: &reqwest::Client,
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

/// 在 Finder/文件管理器中显示文件
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new("/")))
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {e}"))?;
    }
    Ok(())
}

/// 检查 ffmpeg 是否可用，返回路径（找不到返回 None）
#[tauri::command]
pub fn check_ffmpeg(app: AppHandle) -> Option<String> {
    resolve_ffmpeg(&app).ok().map(|p| p.to_string_lossy().to_string())
}

/// 下载静态 ffmpeg 到 resource 目录
#[tauri::command]
pub async fn download_ffmpeg(app: AppHandle) -> Result<String, String> {
    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("获取 resource 目录失败: {e}"))?;

    fs::create_dir_all(&resource_dir)
        .map_err(|e| format!("创建目录失败: {e}"))?;

    let ffmpeg_path = resource_dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });

    // 根据平台选下载地址（静态编译版，无外部依赖）
    let url = if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            // evermeet 提供 macOS universal/arm64 静态构建
            "https://evermeet.cx/ffmpeg/get/zip"
        } else {
            // macOS x86_64 用 BtbN
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-macos64-gpl.zip"
        }
    } else if cfg!(target_os = "windows") {
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    } else {
        // Linux，运行时检测架构
        let arch = std::process::Command::new("uname").arg("-m").output()
            .ok().and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default();
        if arch.trim().contains("aarch64") {
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz"
        } else {
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
        }
    };

    // 用系统 curl 下载（避免引入大型 HTTP 依赖）
    let archive = resource_dir.join("ffmpeg_download_tmp");
    let status = Command::new("curl")
        .args(["-L", "-o"])
        .arg(&archive)
        .arg(url)
        .status()
        .map_err(|e| format!("curl 不可用: {e}"))?;

    if !status.success() {
        return Err("下载失败，请检查网络连接".to_string());
    }

    // 解压
    if cfg!(target_os = "macos") || cfg!(target_os = "windows") {
        // zip
        let status = Command::new("unzip")
            .args(["-o"])
            .arg(&archive)
            .args(["-d"])
            .arg(&resource_dir)
            .status()
            .map_err(|e| format!("解压失败: {e}"))?;
        if !status.success() {
            return Err("解压失败".to_string());
        }
        // evermeet 解压出来直接是 ffmpeg 文件
        // 如果不在根目录，递归查找
        if !ffmpeg_path.exists() {
            // 在解压目录里找 ffmpeg
            fn find_ffmpeg(dir: &Path) -> Option<PathBuf> {
                for entry in fs::read_dir(dir).ok()?.flatten() {
                    let p = entry.path();
                    if p.is_file() && p.file_name().map(|n| n == "ffmpeg").unwrap_or(false) {
                        return Some(p);
                    }
                    if p.is_dir() {
                        if let Some(found) = find_ffmpeg(&p) {
                            return Some(found);
                        }
                    }
                }
                None
            }
            if let Some(found) = find_ffmpeg(&resource_dir) {
                fs::rename(&found, &ffmpeg_path)
                    .map_err(|e| format!("移动 ffmpeg 失败: {e}"))?;
            }
        }
    } else {
        // tar.xz (Linux)
        let status = Command::new("tar")
            .args(["-xf"])
            .arg(&archive)
            .args(["-C"])
            .arg(&resource_dir)
            .status()
            .map_err(|e| format!("解压失败: {e}"))?;
        if !status.success() {
            return Err("解压失败".to_string());
        }
    }

    // 清理临时文件
    fs::remove_file(&archive).ok();

    if !ffmpeg_path.exists() {
        return Err("下载解压后未找到 ffmpeg 文件".to_string());
    }

    // 赋予执行权限
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&ffmpeg_path)
            .map_err(|e| format!("读取权限失败: {e}"))?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ffmpeg_path, perms)
            .map_err(|e| format!("设置权限失败: {e}"))?;
    }

    Ok(ffmpeg_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_ffmpeg_path(app: AppHandle) -> Result<String, String> {
    resolve_ffmpeg(&app).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn extract_audio(app: AppHandle, opts: ExtractOptions) -> Result<ExtractResult, String> {
    let ffmpeg = resolve_ffmpeg(&app)?;
    fs::create_dir_all(&opts.output_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;

    let total = opts.inputs.len();
    if total == 0 {
        return Err("请至少选择一个文件".to_string());
    }

    // 每个文件独立 spawn，并发提取
    let mut handles = Vec::new();
    for (i, input_str) in opts.inputs.iter().enumerate() {
        let ffmpeg = ffmpeg.clone();
        let input = PathBuf::from(input_str);
        let output_dir = PathBuf::from(&opts.output_dir);
        let duration = opts.duration;
        let input_str = input_str.clone();
        let app = app.clone();

        handles.push(tokio::spawn(async move {
            let t_file = std::time::Instant::now();
            // 先获取时长用于计算进度
            let total_secs = get_duration(&ffmpeg, &input).unwrap_or(0.0);

            let stem = input.file_stem()
                .and_then(|s| s.to_str()).unwrap_or("audio").to_string();
            let output = output_dir.join(format!("{stem}.wav"));
            let output_clone = output.clone();
            let ffmpeg_clone = ffmpeg.clone();
            let app_clone = app.clone();

            // ffmpeg -progress 输出到 pipe，实时读取进度
            let result = tokio::task::spawn_blocking(move || {
                use std::io::{BufRead, BufReader};
                use std::process::Stdio;

                let mut cmd = Command::new(&ffmpeg_clone);
                cmd.args(["-y", "-hide_banner", "-loglevel", "quiet"])
                    .arg("-i").arg(&input)
                    .arg("-vn")
                    .arg("-acodec").arg("pcm_s16le")
                    .arg("-ar").arg("16000")
                    .arg("-ac").arg("1")
                    .arg("-progress").arg("pipe:2")  // 进度写到 stderr
                    .arg("-nostats");

                if duration > 0.0 {
                    cmd.arg("-t").arg(duration.to_string());
                }

                cmd.arg(&output_clone)
                   .stdout(Stdio::null())
                   .stderr(Stdio::piped());

                let mut child = cmd.spawn()
                    .map_err(|e| format!("ffmpeg 启动失败: {e}"))?;

                let stderr = child.stderr.take().unwrap();
                let reader = BufReader::new(stderr);

                let max_secs = if duration > 0.0 { duration } else { total_secs };

                for line in reader.lines().map_while(Result::ok) {
                    // ffmpeg -progress 输出格式：out_time_us=1234567
                    if let Some(val) = line.strip_prefix("out_time_us=") {
                        if let Ok(us) = val.trim().parse::<f64>() {
                            let secs = us / 1_000_000.0;
                            let ratio = if max_secs > 0.0 {
                                (secs / max_secs).min(0.99)
                            } else {
                                0.5
                            };
                            let _ = app_clone.emit("extract-progress", serde_json::json!({
                                "index": i,
                                "total": total,
                                "ratio": ratio,
                                "message": format!("提取中 {}/{}", i + 1, total),
                            }));
                        }
                    }
                }

                let status = child.wait()
                    .map_err(|e| format!("ffmpeg 等待失败: {e}"))?;

                if !status.success() {
                    return Err(format!("ffmpeg 返回错误: {status}"));
                }
                Ok(output_clone.to_string_lossy().to_string())
            }).await;

            let result: Result<String, String> = match result {
                Ok(Ok(s)) => Ok(s),
                Ok(Err(e)) => Err(e),
                Err(e) => Err(format!("任务异常: {e}")),
            };

            let elapsed = t_file.elapsed().as_secs_f64();
            // 完成后推 100%
            let _ = app.emit("extract-progress", serde_json::json!({
                "index": i,
                "total": total,
                "ratio": 1.0,
                "message": format!("完成 {}/{}", i + 1, total),
                "elapsed_secs": elapsed,
            }));

            ExtractFileResult {
                input: input_str,
                output: result.as_deref().unwrap_or("").to_string(),
                elapsed_secs: Some(elapsed),
                error: result.err(),
            }
        }));
    }

    let mut files = Vec::new();
    for h in handles {
        if let Ok(r) = h.await {
            files.push(r);
        }
    }

    Ok(ExtractResult { files })
}

/// 用 ffprobe/ffmpeg 获取媒体时长（秒）
fn get_duration(ffmpeg: &Path, input: &Path) -> Option<f64> {
    // 用 ffmpeg -i 读取时长
    let output = Command::new(ffmpeg)
        .args(["-i"])
        .arg(input)
        .args(["-f", "null", "-"])
        .output()
        .ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines() {
        if line.contains("Duration:") {
            // Duration: HH:MM:SS.ss
            let part = line.split("Duration:").nth(1)?.trim();
            let time = part.split(',').next()?.trim();
            let parts: Vec<&str> = time.split(':').collect();
            if parts.len() == 3 {
                let h: f64 = parts[0].parse().ok()?;
                let m: f64 = parts[1].parse().ok()?;
                let s: f64 = parts[2].parse().ok()?;
                return Some(h * 3600.0 + m * 60.0 + s);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn generate_subtitles(
    app: AppHandle,
    opts: GenerateOptions,
) -> Result<GenerateResult, String> {
    let input = Path::new(&opts.input);
    if !input.exists() {
        return Err(format!("输入文件不存在: {}", opts.input));
    }
    fs::create_dir_all(&opts.output_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;

    let chunk_seconds = opts.chunk_seconds.unwrap_or(240).clamp(60, 600);

    // 缓存目录：~/.subgen_cache/<input_hash>/
    let cache_dir = {
        let meta = fs::metadata(input).ok();
        let hash_src = format!(
            "{}|{}|{}",
            opts.input,
            meta.as_ref().map(|m| m.len()).unwrap_or(0),
            meta.as_ref().and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()).unwrap_or(0)
        );
        let hash = &hex::encode(sha2::Sha256::digest(hash_src.as_bytes()))[..16];
        let dir = dirs_cache().join(hash);
        fs::create_dir_all(&dir).ok();
        dir
    };

    let t_start = std::time::Instant::now();

    let skip_cache = opts.skip_cache.unwrap_or(false);

    // ASR 缓存
    let asr_cache_file = cache_dir.join(format!("asr_{}_{}.json", opts.asr_provider, opts.source_lang));
    let segments = if !skip_cache && asr_cache_file.exists() {
        emit_progress(&app, "transcribing", 0.65, "从缓存加载转录结果...");
        let raw = fs::read_to_string(&asr_cache_file).unwrap_or_default();
        serde_json::from_str::<Vec<Segment>>(&raw).unwrap_or_default()
    } else {
        if skip_cache { fs::remove_file(&asr_cache_file).ok(); }
        let temp_dir = env::temp_dir().join(format!("subgen-desktop-{}", Utc::now().timestamp_millis()));
        let t_extract = std::time::Instant::now();
        emit_progress(&app, "extracting", 0.05, "正在本地提取并分片音频...");
        let chunks = split_audio_for_asr(&app, input, &temp_dir, chunk_seconds)?;
        let total = chunks.len();

        let segs = if opts.asr_provider == "local-whisper" {
            // ── 本地 whisper-cli，信号量限流并发（Metal GPU unified memory）──
            // 实测单实例 ~823MB，GPU 推荐工作集 17GB，保守取 4 并发
            let whisper = resolve_whisper(&app)?;
            let model = default_model_path();
            if !model.exists() {
                return Err("请先下载 Whisper 模型（在设置中点击下载）".to_string());
            }

            let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
            let done_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let mut handles = Vec::new();

            for (i, chunk) in chunks.iter().enumerate() {
                let whisper = whisper.clone();
                let model = model.clone();
                let chunk = chunk.clone();
                let lang = opts.source_lang.clone();
                let offset = i as f64 * chunk_seconds as f64;
                let sem = sem.clone();
                let done_count = done_count.clone();
                let app = app.clone();
                handles.push(tokio::spawn(async move {
                    let _permit = sem.acquire().await.unwrap();
                    let result = transcribe_with_whisper(&whisper, &model, &chunk, &lang, offset).await;
                    let done = done_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    emit_progress(&app, "transcribing",
                        0.1 + 0.55 * (done as f64 / total as f64),
                        format!("转录完成 {done}/{total}"));
                    result.map(|s| (i, s))
                }));
            }

            let mut results = Vec::new();
            for h in handles {
                match h.await {
                    Ok(Ok(r)) => results.push(r),
                    Ok(Err(e)) => return Err(e),
                    Err(e) => return Err(format!("转录任务崩溃: {e}")),
                }
            }
            results.sort_by_key(|(i, _)| *i);
            results.into_iter().flat_map(|(_, s)| s).collect::<Vec<_>>()
        } else {
            // ── 云 API 转录（Groq / SiliconFlow）并发 ──────────────
            let client_ref = reqwest::Client::new();
            let mut handles = Vec::new();
            for (i, chunk) in chunks.iter().enumerate() {
                let client = client_ref.clone();
                let chunk = chunk.clone();
                let provider = opts.asr_provider.clone();
                let lang = opts.source_lang.clone();
                let groq_key = opts.groq_api_key.clone();
                let sf_key = opts.siliconflow_api_key.clone();
                let offset = i as f64 * chunk_seconds as f64;
                handles.push(tokio::spawn(async move {
                    let opts_clone = GenerateOptions {
                        input: String::new(), output_dir: String::new(),
                        source_lang: lang.clone(), target_lang: String::new(),
                        bilingual: false, asr_provider: provider.clone(),
                        translate_provider: String::new(),
                        groq_api_key: groq_key, siliconflow_api_key: sf_key,
                        deepl_api_key: None, tencent_secret_id: None,
                        tencent_secret_key: None, chunk_seconds: None, skip_cache: None,
                    };
                    transcribe_chunk(&client, &provider, &chunk, &lang, &opts_clone)
                        .await
                        .map(|mut segs| {
                            for seg in &mut segs {
                                seg.start += offset;
                                seg.end = if seg.end > 0.0 { seg.end + offset } else { offset + 240.0 };
                            }
                            (i, segs)
                        })
                }));
            }

            let mut results: Vec<(usize, Vec<Segment>)> = Vec::new();
            for handle in handles {
                match handle.await {
                    Ok(Ok(r)) => {
                        let done = results.len() + 1;
                        emit_progress(&app, "transcribing",
                            0.1 + 0.55 * (done as f64 / total as f64),
                            format!("转录完成 {done}/{total}..."));
                        results.push(r);
                    }
                    Ok(Err(e)) => return Err(e),
                    Err(e) => return Err(format!("转录任务崩溃: {e}")),
                }
            }
            results.sort_by_key(|(i, _)| *i);
            results.into_iter().flat_map(|(_, s)| s).collect::<Vec<_>>()
        };

        let _ = fs::remove_dir_all(&temp_dir);
        if segs.is_empty() {
            return Err("未检测到语音内容".to_string());
        }
        let asr_elapsed = t_extract.elapsed().as_secs_f64();
        emit_progress_with_elapsed(&app, "transcribing", 0.66,
            format!("转录完成，用时 {:.0}s", asr_elapsed), Some(asr_elapsed));
        if let Ok(json) = serde_json::to_string(&segs) {
            fs::write(&asr_cache_file, json).ok();
        }
        segs
    };

    let client = reqwest::Client::new();
    let t_translate = std::time::Instant::now();
    emit_progress(&app, "translating", 0.72, "正在翻译字幕...");
    let translated = translate_segments(&client, &segments, &opts, Some(&cache_dir)).await?;
    let trl_elapsed = t_translate.elapsed().as_secs_f64();
    emit_progress_with_elapsed(&app, "translating", 0.92,
        format!("翻译完成，用时 {:.0}s", trl_elapsed), Some(trl_elapsed));

    emit_progress(&app, "saving", 0.94, "正在写入字幕文件...");
    let stem = file_stem(input);
    let output_dir = PathBuf::from(&opts.output_dir);
    let original_path = output_dir.join(format!("{stem}.original.srt"));
    let translated_path =
        output_dir.join(format!("{stem}.{}.srt", opts.target_lang.to_lowercase()));
    let bilingual_path = opts
        .bilingual
        .then(|| output_dir.join(format!("{stem}.bilingual.srt")));

    let original_srt = segments_to_srt(&segments);
    let translated_srt = segments_to_srt(&translated);
    let bilingual_srt = if opts.bilingual {
        Some(merge_bilingual(&segments, &translated))
    } else {
        None
    };

    let total_elapsed = t_start.elapsed().as_secs_f64();
    emit_progress_with_elapsed(&app, "done", 1.0,
        format!("完成，总用时 {:.0}s", total_elapsed), Some(total_elapsed));

    // 不自动写文件，返回 SRT 内容让前端用户选择保存
    Ok(GenerateResult {
        segments,
        translated,
        original_srt,
        translated_srt,
        bilingual_srt,
        original_path: original_path.to_string_lossy().to_string(),
        translated_path: translated_path.to_string_lossy().to_string(),
        bilingual_path: bilingual_path.map(|p| p.to_string_lossy().to_string()),
    })
}

/// 保存 SRT 内容到指定路径（用户选择后调用）
#[tauri::command]
pub fn save_srt(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(&path, content).map_err(|e| format!("保存失败: {e}"))
}
