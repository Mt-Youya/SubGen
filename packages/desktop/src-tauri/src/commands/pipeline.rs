use std::path::{Path, PathBuf};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}, LazyLock, Mutex};
use std::collections::HashMap;
use std::{env, fs};

use chrono::Utc;
use sha2::Digest;
use tauri::AppHandle;

use super::asr::{split_audio_for_asr, transcribe_chunk, transcribe_with_whisper_server, transcribe_with_whisper_legacy};
use super::deps::{model_path, resolve_whisper, resolve_whisper_server};
use super::translation::translate_segments;
use super::types::{GenerateOptions, GenerateResult, Segment, TranslateFileOptions, TranslateFileResult};
use super::utils::{dirs_cache, emit_progress, emit_stage_done, find_free_port, num_cpus};

/// 全局取消标志：input_path → 取消信号
static CANCEL_FLAGS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 函数退出时自动从 CANCEL_FLAGS 中移除对应条目
struct CancelGuard(String);
impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = CANCEL_FLAGS.lock() {
            map.remove(&self.0);
        }
    }
}

// ─────────────────────────────────────────────
// SRT 格式化工具
// ─────────────────────────────────────────────

/// 从文件路径提取文件名（不含扩展名），用于构造输出 SRT 文件名。
fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("subtitle")
        .to_string()
}

/// 把秒数转换为 SRT 时间格式（HH:MM:SS,mmm）。
/// max(0.0) 防止负数时间（理论上不应出现，但作为保护）。
/// 毫秒取整而非四舍五入，与大多数字幕工具行为一致。
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

/// 把 Segment 列表序列化为 SRT 字符串。
/// SRT 格式：序号 → 时间轴 → 文本 → 空行（分隔符）
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

/// 将原文和译文合并为双语 SRT，每条字幕上行原文、下行译文。
/// 若 translated 条数不足，缺失的行留空（不会 panic）。
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

// ─────────────────────────────────────────────
// Tauri 命令
// ─────────────────────────────────────────────

/// 在系统文件管理器中定位并高亮指定文件。
/// 各平台实现：macOS → `open -R`；Windows → `explorer /select,`；Linux → `xdg-open`（只能打开目录）
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    use super::utils::silent_command;

    #[cfg(target_os = "macos")]
    {
        // -R 让 Finder 在父目录中选中该文件，而非直接打开
        silent_command("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        // /select, 让资源管理器选中该文件（注意逗号是语法的一部分）
        silent_command("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        // Linux 各桌面环境不统一，xdg-open 只能打开目录，无法选中文件
        silent_command("xdg-open")
            .arg(std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new("/")))
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {e}"))?;
    }
    Ok(())
}

/// 批量获取文件大小（字节）。文件不存在时返回 0。
/// 前端用于在文件列表中展示文件大小，避免多次 IPC 调用。
#[tauri::command]
pub fn get_file_sizes(paths: Vec<String>) -> Vec<u64> {
    paths.iter()
        .map(|p| fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        .collect()
}

/// 将 SRT 字符串内容写入指定路径。
/// 自动创建父目录，避免因目录不存在导致写入失败。
/// 由前端决定保存路径（generate_subtitles 只返回建议路径，不自动写入）。
#[tauri::command]
pub fn save_srt(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(&path, content).map_err(|e| format!("保存失败: {e}"))
}

/// 取消指定文件的字幕生成任务。
#[tauri::command]
pub fn cancel_subtitle(input: String) {
    if let Ok(map) = CANCEL_FLAGS.lock() {
        if let Some(flag) = map.get(&input) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

/// 字幕生成主流程：音频提取 → ASR 转录 → 翻译 → 返回 SRT 内容。
///
/// 完整流程：
/// 1. 音频分片：用 ffmpeg 将媒体文件切成 chunk_seconds（默认 240s）的 WAV 分片
/// 2. ASR 转录：根据 asr_provider 选择本地 whisper-server/cli 或云 API（Groq/SiliconFlow）
/// 3. 翻译：根据 translate_provider 选择 DeepL 或腾讯翻译
/// 4. SRT 格式化：生成原文、译文、双语三个版本的 SRT 字符串
/// 5. 返回结果（不自动保存文件，由前端控制保存路径）
///
/// 缓存机制：ASR 结果和翻译结果分别缓存到 ~/.subgen_cache/<file_hash>/，
/// 同一文件再次处理时跳过对应步骤，节省时间和 API 费用。
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

    // 注册取消标志，函数退出时自动清理
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = CANCEL_FLAGS.lock().map_err(|e| format!("锁取消标志失败: {e}"))?;
        map.insert(opts.input.clone(), cancel.clone());
    }
    let _cleanup = CancelGuard(opts.input.clone());

    // 将 chunk_seconds 限制在 [60, 600] 范围内，避免分片过短（频繁 API 调用）或过长（超限）
    let chunk_seconds = opts.chunk_seconds.unwrap_or(240).clamp(60, 600);

    // 缓存目录：基于输入文件路径 + 大小 + 修改时间的哈希，
    // 文件内容变化时自动使用新缓存目录，不污染旧缓存
    let cache_dir = {
        let meta = fs::metadata(input).ok();
        let hash_src = format!(
            "{}|{}|{}",
            opts.input,
            meta.as_ref().map(|m| m.len()).unwrap_or(0),
            meta.as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0)
        );
        let hash = &hex::encode(sha2::Sha256::digest(hash_src.as_bytes()))[..16];
        let dir = dirs_cache().join(hash);
        fs::create_dir_all(&dir).ok();
        dir
    };

    let t_start = std::time::Instant::now();
    let skip_cache = opts.skip_cache.unwrap_or(false);

    // ── 阶段 1：ASR 转录（含音频提取）──────────────────────
    // ASR 缓存文件名包含 provider + 语言，不同 provider 不互相污染
    let asr_cache_file = cache_dir.join(format!(
        "asr_{}_{}.json",
        opts.asr_provider,
        opts.source_lang
    ));

    let segments = if !skip_cache && asr_cache_file.exists() {
        // 命中 ASR 缓存，跳过耗时的音频提取和转录
        emit_progress(&app, &opts.input, "transcribing", 0.65, "从缓存加载转录结果...");
        let raw = fs::read_to_string(&asr_cache_file).unwrap_or_default();
        serde_json::from_str::<Vec<Segment>>(&raw).unwrap_or_default()
    } else {
        if skip_cache {
            fs::remove_file(&asr_cache_file).ok();
        }

        // 使用带时间戳的临时目录，防止多个并发任务互相干扰
        let temp_dir = env::temp_dir().join(format!(
            "subgen-desktop-{}",
            Utc::now().timestamp_millis()
        ));
        let t_extract = std::time::Instant::now();
        emit_progress(&app, &opts.input, "extracting", 0.02, "正在本地提取并分片音频...");
        let chunks = split_audio_for_asr(&app, input, &temp_dir, chunk_seconds, cancel.clone()).await?;
        if cancel.load(Ordering::SeqCst) { return Err("已取消".to_string()); }
        let extract_elapsed = t_extract.elapsed().as_secs_f64();
        emit_stage_done(
            &app, &opts.input, "extracting", extract_elapsed,
            format!("音频提取完成，用时 {:.1}s", extract_elapsed),
        );
        let total = chunks.len();

        if cancel.load(Ordering::SeqCst) { return Err("已取消".to_string()); }
        let segs = if opts.asr_provider == "local-whisper" {
            // ── 本地 Whisper 模式 ──────────────────────────────
            // server 优先（模型常驻内存，多 chunk 复用），cli 兜底（每次重新加载模型）
            let server_bin = resolve_whisper_server(&app)
                .or_else(|_| resolve_whisper(&app))?;
            let model_name = opts.whisper_model.as_deref().unwrap_or("small");
            let model = model_path(model_name);
            if !model.exists() {
                return Err(format!(
                    "请先下载 Whisper 模型 {model_name}（在设置中点击下载）"
                ));
            }

            // 判断找到的是 server 还是 cli（文件名含 "server" 则用 server 模式）
            let use_server = server_bin
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.contains("server"))
                .unwrap_or(false);

            if use_server {
                // whisper-server 模式：单实例，所有 chunk 通过 HTTP 队列串行处理，
                // 比多进程竞争 CPU 资源效率更高
                let port = find_free_port().unwrap_or(18200);
                let t_load = std::time::Instant::now();
                emit_progress(&app, &opts.input, "loading_model", 0.32,
                    format!("正在加载 Whisper 模型（{}）...", model_name));

                let threads = num_cpus();
                let srv = super::utils::silent_command(&server_bin)
                    .args([
                        "-m", &model.to_string_lossy(),
                        "--port", &port.to_string(),
                        "-t", &threads.to_string(), // 使用全部 CPU 核心
                    ])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|e| format!("启动 whisper-server 失败: {e}"))?;
                let mut servers = vec![srv];

                // 轮询等待 server 就绪（GET / 返回 200 即就绪），超时 120s
                let client = reqwest::Client::new();
                let start = std::time::Instant::now();
                loop {
                    if cancel.load(Ordering::SeqCst) {
                        for s in &mut servers { s.kill().ok(); }
                        return Err("已取消".to_string());
                    }
                    if start.elapsed().as_secs() > 120 {
                        for s in &mut servers { s.kill().ok(); }
                        return Err("whisper-server 启动超时（>120s）".to_string());
                    }
                    if client.get(format!("http://127.0.0.1:{port}/")).send().await.is_ok() {
                        let load_elapsed = t_load.elapsed().as_secs_f64();
                        emit_stage_done(
                            &app, &opts.input, "loading_model", load_elapsed,
                            format!("模型就绪，用时 {:.1}s", load_elapsed),
                        );
                        break;
                    }
                    let elapsed = start.elapsed().as_secs();
                    // 每 5 秒发一次进度更新，让用户知道还在加载
                    if elapsed % 5 == 0 && elapsed > 0 {
                        emit_progress(&app, &opts.input, "loading_model", 0.34,
                            format!("正在加载模型... ({elapsed}s)"));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                }

                // 并发发送所有 chunk 请求（server 内部队列串行处理，HTTP 客户端并发）
                let done_count = std::sync::Arc::new(
                    std::sync::atomic::AtomicUsize::new(0),
                );
                let mut handles = Vec::new();
                let cancel_srv = cancel.clone();

                for (i, chunk) in chunks.iter().enumerate() {
                    let client = client.clone();
                    let chunk = chunk.clone();
                    let lang = opts.source_lang.clone();
                    let offset = i as f64 * chunk_seconds as f64;
                    let done_count = done_count.clone();
                    let app = app.clone();
                    let input_path = opts.input.clone();
                    let cancel = cancel_srv.clone();
                    handles.push(tokio::spawn(async move {
                        if cancel.load(Ordering::SeqCst) { return Err("已取消".to_string()); }
                        let result = transcribe_with_whisper_server(
                            &client, port, &chunk, &lang, offset,
                        ).await;
                        let done = done_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                        emit_progress(
                            &app, &input_path, "transcribing",
                            0.38 + 0.28 * (done as f64 / total as f64),
                            format!("转录完成 {done}/{total}"),
                        );
                        result.map(|s| (i, s))
                    }));
                }

                let mut results = Vec::new();
                for h in handles {
                    if cancel.load(Ordering::SeqCst) {
                        for s in &mut servers { s.kill().ok(); }
                        return Err("已取消".to_string());
                    }
                    match h.await {
                        Ok(Ok(r))  => results.push(r),
                        Ok(Err(e)) => { for s in &mut servers { s.kill().ok(); } return Err(e); }
                        Err(e)     => { for s in &mut servers { s.kill().ok(); } return Err(format!("转录任务崩溃: {e}")); }
                    }
                }
                for s in &mut servers { s.kill().ok(); }
                // 按 chunk 索引排序，保证合并后时间轴连续
                results.sort_by_key(|(i, _)| *i);
                results.into_iter().flat_map(|(_, s)| s).collect::<Vec<_>>()
            } else {
                // whisper-cli 兜底模式：信号量限制并发数为 4，防止 OOM
                let whisper = server_bin;
                let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
                let done_count = std::sync::Arc::new(
                    std::sync::atomic::AtomicUsize::new(0),
                );
                let mut handles = Vec::new();
                let cancel_cli = cancel.clone();

                for (i, chunk) in chunks.iter().enumerate() {
                    let whisper = whisper.clone();
                    let model = model.clone();
                    let chunk = chunk.clone();
                    let lang = opts.source_lang.clone();
                    let offset = i as f64 * chunk_seconds as f64;
                    let sem = sem.clone();
                    let done_count = done_count.clone();
                    let app = app.clone();
                    let input_path = opts.input.clone();
                    let cancel = cancel_cli.clone();
                    handles.push(tokio::spawn(async move {
                        if cancel.load(Ordering::SeqCst) { return Err("已取消".to_string()); }
                        let _permit = sem.acquire().await.unwrap();
                        let result = transcribe_with_whisper_legacy(
                            &whisper, &model, &chunk, &lang, offset,
                        ).await;
                        let done = done_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                        emit_progress(
                            &app, &input_path, "transcribing",
                            0.38 + 0.28 * (done as f64 / total as f64),
                            format!("转录完成 {done}/{total}"),
                        );
                        result.map(|s| (i, s))
                    }));
                }

                let mut results = Vec::new();
                for h in handles {
                    if cancel.load(Ordering::SeqCst) { return Err("已取消".to_string()); }
                    match h.await {
                        Ok(Ok(r))  => results.push(r),
                        Ok(Err(e)) => return Err(e),
                        Err(e)     => return Err(format!("转录任务崩溃: {e}")),
                    }
                }
                results.sort_by_key(|(i, _)| *i);
                results.into_iter().flat_map(|(_, s)| s).collect::<Vec<_>>()
            }
        } else {
            // ── 云 API 转录（Groq / SiliconFlow）全并发 ───────────
            let client_ref = reqwest::Client::new();
            let mut handles = Vec::new();
            let cancel_cloud = cancel.clone();
            for (i, chunk) in chunks.iter().enumerate() {
                let client = client_ref.clone();
                let chunk = chunk.clone();
                let provider = opts.asr_provider.clone();
                let lang = opts.source_lang.clone();
                let groq_key = opts.groq_api_key.clone();
                let sf_key = opts.siliconflow_api_key.clone();
                let offset = i as f64 * chunk_seconds as f64;
                let cancel = cancel_cloud.clone();
                handles.push(tokio::spawn(async move {
                    if cancel.load(Ordering::SeqCst) { return Err("已取消".to_string()); }
                    // 构造一个最小化的 GenerateOptions 供 transcribe_chunk 读取 API key
                    let opts_clone = GenerateOptions {
                        input: String::new(),
                        output_dir: String::new(),
                        source_lang: lang.clone(),
                        target_lang: String::new(),
                        bilingual: false,
                        asr_provider: provider.clone(),
                        translate_provider: String::new(),
                        groq_api_key: groq_key,
                        siliconflow_api_key: sf_key,
                        deepl_api_key: None,
                        tencent_secret_id: None,
                        tencent_secret_key: None,
                        chunk_seconds: None,
                        skip_cache: None,
                        whisper_model: None,
                    };
                    transcribe_chunk(&client, &provider, &chunk, &lang, &opts_clone)
                        .await
                        .map(|mut segs| {
                            // 将 segment 时间轴从相对 chunk 起始偏移到绝对时间
                            for seg in &mut segs {
                                seg.start += offset;
                                seg.end = if seg.end > 0.0 {
                                    seg.end + offset
                                } else {
                                    offset + 240.0 // end=0 时用 chunk 时长兜底
                                };
                            }
                            (i, segs)
                        })
                }));
            }

            let mut results: Vec<(usize, Vec<Segment>)> = Vec::new();
            for handle in handles {
                if cancel.load(Ordering::SeqCst) { return Err("已取消".to_string()); }
                match handle.await {
                    Ok(Ok(r)) => {
                        let done = results.len() + 1;
                        emit_progress(
                            &app, &opts.input, "transcribing",
                            0.32 + 0.33 * (done as f64 / total as f64),
                            format!("转录完成 {done}/{total}..."),
                        );
                        results.push(r);
                    }
                    Ok(Err(e)) => return Err(e),
                    Err(e)     => return Err(format!("转录任务崩溃: {e}")),
                }
            }
            results.sort_by_key(|(i, _)| *i);
            results.into_iter().flat_map(|(_, s)| s).collect::<Vec<_>>()
        };

        // 清理临时分片目录（忽略错误，不影响主流程）
        let _ = fs::remove_dir_all(&temp_dir);

        if segs.is_empty() {
            return Err("未检测到语音内容".to_string());
        }

        let asr_elapsed = t_extract.elapsed().as_secs_f64();
        emit_stage_done(
            &app, &opts.input, "transcribing", asr_elapsed,
            format!("转录完成，用时 {:.1}s", asr_elapsed),
        );
        // 写 ASR 缓存（JSON 格式），下次处理同一文件可直接跳过转录
        if let Ok(json) = serde_json::to_string(&segs) {
            fs::write(&asr_cache_file, json).ok();
        }
        segs
    };

    // ── 阶段 2：翻译 ────────────────────────────────────────
    let client = reqwest::Client::new();
    let t_translate = std::time::Instant::now();
    emit_progress(&app, &opts.input, "translating", 0.72, "正在翻译字幕...");
    let translated = translate_segments(&client, &segments, &opts, Some(&cache_dir)).await?;
    let trl_elapsed = t_translate.elapsed().as_secs_f64();
    emit_stage_done(
        &app, &opts.input, "translating", trl_elapsed,
        format!("翻译完成，用时 {:.1}s", trl_elapsed),
    );

    // ── 阶段 3：格式化 & 构造返回值 ──────────────────────────
    emit_progress(&app, &opts.input, "saving", 0.94, "正在写入字幕文件...");
    let stem = file_stem(input);
    let output_dir = PathBuf::from(&opts.output_dir);
    let original_path = output_dir.join(format!("{stem}.original.srt"));
    let translated_path = output_dir.join(format!("{stem}.{}.srt", opts.target_lang.to_lowercase()));
    let bilingual_path = opts
        .bilingual
        .then(|| output_dir.join(format!("{stem}.bilingual.srt")));

    let original_srt   = segments_to_srt(&segments);
    let translated_srt = segments_to_srt(&translated);
    let bilingual_srt  = if opts.bilingual {
        Some(merge_bilingual(&segments, &translated))
    } else {
        None
    };

    let total_elapsed = t_start.elapsed().as_secs_f64();
    emit_stage_done(
        &app, &opts.input, "done", total_elapsed,
        format!("完成，总用时 {:.1}s", total_elapsed),
    );

    // 不自动写文件：返回 SRT 内容，让前端决定保存路径（用户可能想改文件名）
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

// ─────────────────────────────────────────────
// SRT 解析工具
// ─────────────────────────────────────────────

/// 把 SRT 时间字符串（HH:MM:SS,mmm）解析为秒。
fn parse_srt_time(s: &str) -> Result<f64, String> {
    // 格式：HH:MM:SS,mmm 或 HH:MM:SS.mmm
    let s = s.replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 {
        return Err(format!("无效时间格式: {s}"));
    }
    let h: f64 = parts[0].trim().parse().map_err(|_| format!("无效时间: {s}"))?;
    let m: f64 = parts[1].trim().parse().map_err(|_| format!("无效时间: {s}"))?;
    let sec: f64 = parts[2].trim().parse().map_err(|_| format!("无效时间: {s}"))?;
    Ok(h * 3600.0 + m * 60.0 + sec)
}

/// 解析 SRT 文本为 Segment 列表。
fn parse_srt(content: &str) -> Result<Vec<Segment>, String> {
    let text = content.replace("\r\n", "\n");
    let blocks: Vec<&str> = text.split("\n\n").filter(|b| !b.trim().is_empty()).collect();
    let mut segments = Vec::new();

    for block in blocks {
        let lines: Vec<&str> = block.trim().lines().collect();
        if lines.len() < 2 {
            continue;
        }
        // 跳过序号行（纯数字），找到时间轴行
        let mut time_idx = 0;
        for (i, line) in lines.iter().enumerate() {
            if line.contains("-->") {
                time_idx = i;
                break;
            }
        }
        if time_idx == 0 || time_idx >= lines.len() {
            continue;
        }
        let time_parts: Vec<&str> = lines[time_idx].split("-->").collect();
        if time_parts.len() != 2 {
            continue;
        }
        let start = parse_srt_time(time_parts[0].trim())?;
        let end = parse_srt_time(time_parts[1].trim())?;
        let text = lines[time_idx + 1..].join("\n").trim().to_string();
        if text.is_empty() {
            continue;
        }
        segments.push(Segment { start, end, text });
    }

    if segments.is_empty() {
        return Err("未能在 SRT 文件中解析到有效字幕条目".to_string());
    }
    Ok(segments)
}

/// 直接翻译 SRT 字幕文件：解析 SRT → 翻译 → 返回结果。
/// 跳过 ASR 转录阶段，仅做纯翻译。
#[tauri::command]
pub async fn translate_file(
    app: AppHandle,
    opts: TranslateFileOptions,
) -> Result<TranslateFileResult, String> {
    let input = Path::new(&opts.input);
    if !input.exists() {
        return Err(format!("输入文件不存在: {}", opts.input));
    }
    fs::create_dir_all(&opts.output_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;

    let t_start = std::time::Instant::now();

    // 缓存目录
    let cache_dir = {
        let meta = fs::metadata(input).ok();
        let hash_src = format!(
            "{}|{}|{}",
            opts.input,
            meta.as_ref().map(|m| m.len()).unwrap_or(0),
            meta.as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0)
        );
        let hash = &hex::encode(sha2::Sha256::digest(hash_src.as_bytes()))[..16];
        let dir = dirs_cache().join(hash);
        fs::create_dir_all(&dir).ok();
        dir
    };

    // 解析 SRT
    emit_progress(&app, &opts.input, "parsing", 0.05, "正在解析 SRT 文件...");
    let srt_content = fs::read_to_string(input)
        .map_err(|e| format!("读取 SRT 文件失败: {e}"))?;
    let segments = parse_srt(&srt_content)?;
    emit_stage_done(
        &app, &opts.input, "parsing", t_start.elapsed().as_secs_f64(),
        format!("解析完成，共 {} 条字幕", segments.len()),
    );

    // 构造 GenerateOptions 用于调用 translate_segments
    let gen_opts = GenerateOptions {
        input: opts.input.clone(),
        output_dir: opts.output_dir.clone(),
        source_lang: opts.source_lang.clone(),
        target_lang: opts.target_lang.clone(),
        bilingual: opts.bilingual,
        asr_provider: String::new(),
        translate_provider: opts.translate_provider.clone(),
        groq_api_key: None,
        siliconflow_api_key: None,
        deepl_api_key: opts.deepl_api_key.clone(),
        tencent_secret_id: opts.tencent_secret_id.clone(),
        tencent_secret_key: opts.tencent_secret_key.clone(),
        chunk_seconds: None,
        skip_cache: opts.skip_cache,
        whisper_model: None,
    };

    // 翻译
    let client = reqwest::Client::new();
    let t_translate = std::time::Instant::now();
    emit_progress(&app, &opts.input, "translating", 0.15, "正在翻译字幕...");
    let translated = translate_segments(&client, &segments, &gen_opts, Some(&cache_dir)).await?;
    let trl_elapsed = t_translate.elapsed().as_secs_f64();
    emit_stage_done(
        &app, &opts.input, "translating", trl_elapsed,
        format!("翻译完成，用时 {:.1}s", trl_elapsed),
    );

    // 格式化
    emit_progress(&app, &opts.input, "saving", 0.92, "正在写入字幕文件...");
    let stem = file_stem(input);
    let output_dir = PathBuf::from(&opts.output_dir);
    let original_path = output_dir.join(format!("{stem}.original.srt"));
    let translated_path = output_dir.join(format!("{stem}.{}.srt", opts.target_lang.to_lowercase()));
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
    emit_stage_done(
        &app, &opts.input, "done", total_elapsed,
        format!("完成，总用时 {:.1}s", total_elapsed),
    );

    Ok(TranslateFileResult {
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
