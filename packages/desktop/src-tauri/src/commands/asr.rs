use std::path::{Path, PathBuf};
use std::fs;

use reqwest::multipart::{Form, Part};
use serde_json::Value;
use tauri::AppHandle;

use super::types::{GenerateOptions, Segment, WhisperResponse};
use super::utils::{silent_command, emit_progress, clean_key};

// ─────────────────────────────────────────────
// 音频分片
// ─────────────────────────────────────────────

/// 使用 ffmpeg 把输入媒体文件切成固定时长的 16kHz 单声道 WAV 分片。
///
/// 分片而非整段处理的原因：
/// 1. 云 API 有单次请求文件大小限制（Groq ~25 MB）
/// 2. 大文件全量转录失败后需要全部重来，分片可以按 chunk 粒度重试
/// 3. 多个 chunk 可以并发上传，加快整体速度
///
/// 使用 ffmpeg -progress pipe:1 输出进度信息，通过解析 out_time_us 实现实时进度上报，
/// 而非轮询输出文件大小（后者在大多数情况下不准确）。
pub async fn split_audio_for_asr(
    app: &AppHandle,
    input: &Path,
    chunk_dir: &Path,
    chunk_seconds: u32,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<Vec<PathBuf>, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use std::sync::atomic::Ordering;
    use super::deps::resolve_ffmpeg;

    let ffmpeg = resolve_ffmpeg(app)?;
    fs::create_dir_all(chunk_dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    let output_pattern = chunk_dir.join("chunk_%05d.wav");

    let app_clone = app.clone();
    let input = input.to_path_buf();
    let input_str = input.to_string_lossy().to_string();
    let output_pattern = output_pattern.clone();

    tokio::task::spawn_blocking(move || {
        let mut cmd = silent_command(&ffmpeg);
        cmd
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .arg("-i").arg(&input)
            .arg("-vn")
            .arg("-acodec").arg("pcm_s16le")
            .arg("-ar").arg("16000")
            .arg("-ac").arg("1")
            .arg("-progress").arg("pipe:1")
            .arg("-nostats")
            .arg("-f").arg("segment")
            .arg("-segment_time").arg(chunk_seconds.to_string())
            .arg("-reset_timestamps").arg("1")
            .arg(&output_pattern)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("ffmpeg 分片启动失败: {e}"))?;
        let stdout = child.stdout.take().unwrap();
        let stderr_handle = child.stderr.take();
        let reader = BufReader::new(stdout);

        let mut total_us: f64 = 0.0;
        for line in reader.lines().map_while(Result::ok) {
            if cancel.load(Ordering::SeqCst) {
                child.kill().ok();
                return Err("已取消".to_string());
            }
            if let Some(val) = line.strip_prefix("duration=") {
                if let Ok(us) = val.trim().parse::<f64>() {
                    if us > 0.0 { total_us = us; }
                }
            } else if let Some(val) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = val.trim().parse::<f64>() {
                    let ratio = if total_us > 0.0 { (us / total_us).min(0.90) } else { 0.3 };
                    emit_progress(&app_clone, &input_str, "extracting", ratio * 0.3,
                        format!("提取音频 {:.0}%", ratio * 100.0));
                }
            }
        }
        if cancel.load(Ordering::SeqCst) {
            child.kill().ok();
            return Err("已取消".to_string());
        }
        emit_progress(&app_clone, &input_str, "extracting", 0.30, "音频提取完成");

        let status = child.wait().map_err(|e| format!("ffmpeg 等待失败: {e}"))?;
        if !status.success() {
            let stderr_msg = stderr_handle.map(|mut s| {
                use std::io::Read;
                let mut buf = String::new();
                s.read_to_string(&mut buf).ok();
                buf
            }).unwrap_or_default();
            let detail = if stderr_msg.trim().is_empty() {
                String::new()
            } else {
                format!("\n{}", stderr_msg.trim())
            };
            return Err(format!("ffmpeg 分片返回错误: {status}{detail}"));
        }

        let chunk_dir = output_pattern.parent().unwrap();
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
    })
    .await
    .map_err(|e| format!("音频提取任务异常: {e}"))?
}

// ─────────────────────────────────────────────
// 本地 Whisper 转录
// ─────────────────────────────────────────────

/// 通过 whisper-server HTTP API 转录单个 WAV 文件。
///
/// whisper-server 是 whisper.cpp 提供的 HTTP 服务器模式，
/// 相比 CLI 模式的优势：模型只需加载一次，多个请求复用同一实例，
/// 大幅减少 I/O 和内存分配开销，适合批量分片场景。
///
/// time_offset 是该 chunk 在整段音频中的起始时间（秒），
/// 加到每个 segment 的 start/end 上，使时间轴在合并后连续正确。
pub async fn transcribe_with_whisper_server(
    client: &reqwest::Client,
    server_port: u16,
    wav: &Path,
    language: &str,
    time_offset: f64,
) -> Result<Vec<Segment>, String> {
    let audio = fs::read(wav).map_err(|e| format!("读取音频失败: {e}"))?;

    // multipart/form-data 格式：whisper-server 遵循 OpenAI Audio API 接口规范
    let part = Part::bytes(audio)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("构造上传分片失败: {e}"))?;
    let form = Form::new()
        .part("file", part)
        .text("language", language.to_string())
        .text("response_format", "verbose_json"); // verbose_json 返回含时间戳的 segments

    let res = client
        .post(format!("http://127.0.0.1:{server_port}/inference"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("whisper-server 请求失败: {e}"))?;

    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("whisper-server 错误: {body}"));
    }

    let data: Value = res.json().await.map_err(|e| format!("解析响应失败: {e}"))?;

    let segs: Vec<Segment> = data
        .get("segments")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let text = s.get("text")?.as_str()?.trim().to_string();
                    if text.is_empty() { return None; } // 过滤空文本（静音段）
                    Some(Segment {
                        start: s.get("start")?.as_f64()? + time_offset,
                        end: s.get("end")?.as_f64()? + time_offset,
                        text,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // segments 为空但整体 text 不空时，生成一个覆盖全段的 fallback segment
    // 这种情况很少见，主要是 whisper-server 版本差异导致响应格式不同
    if segs.is_empty() {
        if let Some(text) = data.get("text").and_then(|t| t.as_str()) {
            let text = text.trim().to_string();
            if !text.is_empty() {
                return Ok(vec![Segment {
                    start: time_offset,
                    end: time_offset + 240.0, // 用分片时长兜底
                    text,
                }]);
            }
        }
    }

    Ok(segs)
}

/// 通过 whisper-cli 命令行转录单个 WAV（兜底方案，每次调用启动独立进程）。
///
/// 相比 whisper-server 的劣势：每次都要重新加载模型（~1-2s 启动时间），
/// 但优势是无需维护长进程，更简单健壮，适合系统没有 whisper-server 的情况。
pub async fn transcribe_with_whisper_legacy(
    whisper: &Path,
    model: &Path,
    wav: &Path,
    language: &str,
    time_offset: f64,
) -> Result<Vec<Segment>, String> {
    // 把路径拷贝进 blocking closure，因为 spawn_blocking 需要 'static 生命周期
    let whisper = whisper.to_path_buf();
    let model = model.to_path_buf();
    let wav = wav.to_path_buf();
    let language = language.to_string();

    tokio::task::spawn_blocking(move || {
        let srt_prefix = wav.with_extension("");
        let srt_path = wav.with_extension("srt");

        let output = silent_command(&whisper)
            .args([
                "-m", &model.to_string_lossy(),
                "-f", &wav.to_string_lossy(),
                "-l", &language,
                "-osrt",      // 输出 SRT 格式
                "-of", &srt_prefix.to_string_lossy(), // 输出文件前缀（不含 .srt）
                "-np",        // 不打印进度条（避免污染 stderr）
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

        let srt = fs::read_to_string(&srt_path).map_err(|e| format!("读取 SRT 失败: {e}"))?;
        fs::remove_file(&srt_path).ok(); // 清理临时 SRT 文件
        parse_srt_to_segments(&srt, time_offset)
    })
    .await
    .map_err(|e| format!("转录任务异常: {e}"))?
}

// ─────────────────────────────────────────────
// SRT 解析
// ─────────────────────────────────────────────

/// 解析 SRT 字幕文本为 Segment 列表，并为每个 segment 加上时间偏移量。
pub fn parse_srt_to_segments(srt: &str, offset: f64) -> Result<Vec<Segment>, String> {
    let mut segments = Vec::new();
    let mut lines = srt.lines().peekable();
    while let Some(line) = lines.next() {
        let line = line.trim();
        // 跳过空行和序号行（纯数字）
        if line.is_empty() || line.parse::<u64>().is_ok() {
            continue;
        }
        // 时间行格式：00:00:00,000 --> 00:00:01,500
        if line.contains("-->") {
            let parts: Vec<&str> = line.split("-->").collect();
            if parts.len() != 2 { continue; }
            let start = parse_srt_time(parts[0].trim()) + offset;
            let end   = parse_srt_time(parts[1].trim()) + offset;
            // 收集后续的文本行，直到遇到空行（SRT 块分隔符）
            let mut text_lines = Vec::new();
            while let Some(tl) = lines.peek() {
                let tl = tl.trim();
                if tl.is_empty() {
                    lines.next();
                    break;
                }
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

/// 把 SRT 时间字符串（HH:MM:SS,mmm）解析为秒数（浮点）。
pub fn parse_srt_time(s: &str) -> f64 {
    // SRT 用逗号分隔毫秒，替换为小数点后统一用浮点解析
    let s = s.trim().replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 { return 0.0; }
    let h: f64 = parts[0].parse().unwrap_or(0.0);
    let m: f64 = parts[1].parse().unwrap_or(0.0);
    let sec: f64 = parts[2].parse().unwrap_or(0.0); // 含毫秒小数部分
    h * 3600.0 + m * 60.0 + sec
}

// ─────────────────────────────────────────────
// 云 ASR API
// ─────────────────────────────────────────────

/// 调用 Groq API 转录音频分片。
/// Groq 使用的是 whisper-large-v3-turbo 模型，速度极快（~10x realtime）。
/// timestamp_granularities[]=segment 请求返回 segment 级时间戳。
pub async fn transcribe_with_groq(
    client: &reqwest::Client,
    path: &Path,
    language: &str,
    api_key: &str,
) -> Result<Vec<Segment>, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取音频分片失败: {e}"))?;
    let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or("audio.wav").to_string();

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

/// 调用 SiliconFlow API 转录音频分片。
/// SiliconFlow 使用 FunAudioLLM/SenseVoiceSmall 模型，
/// 该模型对中文语音效果好，同时支持情感和事件检测。
pub async fn transcribe_with_siliconflow(
    client: &reqwest::Client,
    path: &Path,
    language: &str,
    api_key: &str,
) -> Result<Vec<Segment>, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取音频分片失败: {e}"))?;
    let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or("audio.wav").to_string();

    let part = Part::bytes(bytes)
        .file_name(filename)
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

/// 解析 Groq/SiliconFlow 的 Whisper API 响应为统一的 Segment 列表。
/// segments 为空（静音段）时直接返回空列表，而非用整体 text 兜底，
/// 因为整体 text 没有时间戳信息，强行合并会导致时间轴不准。
pub fn parse_whisper_response(data: WhisperResponse) -> Result<Vec<Segment>, String> {
    if let Some(segments) = data.segments {
        let result = segments
            .into_iter()
            .map(|s| Segment { start: s.start, end: s.end, text: s.text.trim().to_string() })
            .filter(|s| !s.text.is_empty())
            .collect::<Vec<_>>();
        if !result.is_empty() {
            return Ok(result);
        }
    }
    // segments 为空说明该分片没有语音内容，返回空列表即可
    Ok(Vec::new())
}

/// 统一转录入口：根据 provider 路由到对应的 API 实现。
pub async fn transcribe_chunk(
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
        // local-whisper 由 pipeline.rs 的 generate_subtitles 直接处理，不经过此函数
        _ => Err("请选择 Groq 或 SiliconFlow 作为 ASR 提供商".to_string()),
    }
}
