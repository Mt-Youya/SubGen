use std::path::{Path, PathBuf};
use std::process::Command;
use std::{env, fs};

use crate::gpu;

/// 创建不弹窗的 Command（Windows 上加 CREATE_NO_WINDOW）
fn silent_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new(program);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        return cmd;
    }
    #[cfg(not(windows))]
    Command::new(program)
}

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
    pub output_size: Option<u64>,
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
    pub whisper_model: Option<String>,
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
    pub input: String,                   // 对应的输入文件路径，用于前端多任务路由
    pub stage: String,
    pub ratio: f64,
    pub message: String,
    pub elapsed_secs: Option<f64>,       // 当前阶段已用秒数（进行中）
    pub stage_elapsed_secs: Option<f64>, // 该阶段完成时的耗时（仅阶段完成时设置）
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
        // 检查根目录和 resources/ 子目录
        for dir in [resource_path.clone(), resource_path.join("resources")] {
            let bundled = dir.join(name);
            if bundled.is_file() {
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

fn emit_progress(app: &AppHandle, input: &str, stage: &str, ratio: f64, message: impl Into<String>) {
    let _ = app.emit("subtitle-progress", ProgressPayload {
        input: input.to_string(), stage: stage.to_string(), ratio, message: message.into(),
        elapsed_secs: None, stage_elapsed_secs: None,
    });
}

fn emit_stage_done(app: &AppHandle, input: &str, stage: &str, stage_elapsed: f64, message: impl Into<String>) {
    let _ = app.emit("subtitle-progress", ProgressPayload {
        input: input.to_string(), stage: stage.to_string(), ratio: 1.0, message: message.into(),
        elapsed_secs: Some(stage_elapsed), stage_elapsed_secs: Some(stage_elapsed),
    });
}


fn clean_key(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn num_cpus() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

/// 绑定 port 0 让 OS 分配一个空闲端口，然后立即释放供 whisper-server 使用
fn find_free_port() -> Option<u16> {
    use std::net::TcpListener;
    TcpListener::bind("127.0.0.1:0").ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
}

pub fn dirs_cache() -> PathBuf {
    let base = if cfg!(windows) {
        env::var("USERPROFILE").or_else(|_| env::var("APPDATA")).unwrap_or_else(|_| ".".into())
    } else {
        env::var("HOME").unwrap_or_else(|_| ".".into())
    };
    PathBuf::from(base).join(".subgen_cache")
}

/// 获取内置 whisper 二进制路径（server 优先，cli 兜底）
fn resolve_whisper(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" };
    resolve_binary(app, name)
}

/// 获取内置 whisper-server 路径
fn resolve_whisper_server(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "whisper-server.exe" } else { "whisper-server" };
    resolve_binary(app, name)
}

fn resolve_binary(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    // GPU 下载的二进制优先（~/.subgen_cache/bin/）
    let cache_bin = gpu::gpu_bin_dir().join(name);
    if cache_bin.is_file() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(&cache_bin) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&cache_bin, perms).ok();
            }
        }
        return Ok(cache_bin);
    }

    if let Ok(resource_path) = app.path().resource_dir() {
        for dir in [resource_path.clone(), resource_path.join("resources")] {
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
    }
    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in env::var("PATH").unwrap_or_default().split(sep) {
        let p = PathBuf::from(dir).join(name);
        if p.is_file() { return Ok(p); }
    }
    Err(format!("未找到 {name}，请重新安装 SubGen"))
}

fn model_path(name: &str) -> PathBuf {
    dirs_cache().join("models").join(format!("ggml-{name}.bin"))
}

/// 默认模型路径（兜底用 small）
fn default_model_path() -> PathBuf {
    model_path("small")
}

/// 用 whisper-server HTTP API 转录单个 WAV，返回 segments
async fn transcribe_with_whisper_server(
    client: &reqwest::Client,
    server_port: u16,
    wav: &Path,
    language: &str,
    time_offset: f64,
) -> Result<Vec<Segment>, String> {
    let audio = fs::read(wav).map_err(|e| format!("读取音频失败: {e}"))?;

    let part = Part::bytes(audio)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("构造上传分片失败: {e}"))?;
    let form = Form::new()
        .part("file", part)
        .text("language", language.to_string())
        .text("response_format", "verbose_json");

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
                    if text.is_empty() { return None; }
                    Some(Segment {
                        start: s.get("start")?.as_f64()? + time_offset,
                        end: s.get("end")?.as_f64()? + time_offset,
                        text,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // 没有 segments 时 fallback 到整体 text
    if segs.is_empty() {
        if let Some(text) = data.get("text").and_then(|t| t.as_str()) {
            let text = text.trim().to_string();
            if !text.is_empty() {
                return Ok(vec![Segment { start: time_offset, end: time_offset + 240.0, text }]);
            }
        }
    }

    Ok(segs)
}

/// 用 whisper-cli 命令行转录（兜底，每 chunk 启动独立进程）
async fn transcribe_with_whisper_legacy(
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
        let srt_prefix = wav.with_extension("");
        let srt_path = wav.with_extension("srt");

        let output = silent_command(&whisper)
            .args([
                "-m", &model.to_string_lossy(),
                "-f", &wav.to_string_lossy(),
                "-l", &language,
                "-osrt",
                "-of", &srt_prefix.to_string_lossy(),
                "-np",
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
            return Err(format!("whisper-cli 未生成 SRT 文件: {}\nstderr: {}\nstdout: {}",
                srt_path.display(), stderr, stdout));
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

/// 统一检查所有依赖（ffmpeg、whisper-cli、whisper 模型）
#[tauri::command]
pub fn check_dependencies(app: AppHandle) -> serde_json::Value {
    let ffmpeg_ok = resolve_ffmpeg(&app).is_ok();
    let whisper_ok = resolve_whisper(&app).is_ok();
    // 只要有任意一个模型就算 ok，避免用户下载了非默认模型时误报缺失
    let any_model = ["base", "small", "medium", "large-v3"]
        .iter()
        .any(|m| model_path(m).exists());
    let default_mp = default_model_path();

    let gpu = gpu::detect_gpu();
    let using_gpu = if cfg!(target_os = "macos") {
        // macOS Metal 已内置
        true
    } else {
        // Windows/Linux: 检查是否已下载 GPU 版
        gpu.available && gpu::gpu_bin_installed(gpu.gpu_type)
    };

    serde_json::json!({
        "ffmpeg": ffmpeg_ok,
        "whisper": whisper_ok,
        "model": any_model,
        "model_path": default_mp.to_string_lossy(),
        "gpu_type": gpu::gpu_variant_label(gpu.gpu_type),
        "gpu_available": gpu.available,
        "using_gpu": using_gpu,
    })
}

/// 检查 whisper 模型是否存在
#[tauri::command]
pub fn check_whisper_model(app: AppHandle, model: Option<String>) -> serde_json::Value {
    let whisper_ok = resolve_whisper(&app).is_ok();
    let name = model.as_deref().unwrap_or("small");
    let mp = model_path(name);
    // 返回所有模型的下载状态
    let models = ["base","small","medium","large-v3"].iter().map(|m| {
        let p = model_path(m);
        serde_json::json!({"name": m, "downloaded": p.exists(), "path": p.to_string_lossy()})
    }).collect::<Vec<_>>();
    serde_json::json!({
        "whisper": whisper_ok,
        "model": mp.exists(),
        "model_path": mp.to_string_lossy(),
        "models": models,
    })
}

/// 下载指定模型到 ~/.subgen_cache/models/
#[tauri::command]
pub async fn download_whisper_model(
    app: AppHandle,
    model: Option<String>,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let name = model.as_deref().unwrap_or("small").to_string();
    let model_path = model_path(&name);
    if model_path.exists() {
        return Ok(model_path.to_string_lossy().to_string());
    }
    fs::create_dir_all(model_path.parent().unwrap())
        .map_err(|e| format!("创建模型目录失败: {e}"))?;

    let url = format!(
        "https://hf-mirror.com/ggml-org/whisper.cpp/resolve/main/ggml-{name}.bin"
    );

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let tmp_path = model_path.with_extension("bin.tmp");
    let mut file = fs::File::create(&tmp_path).map_err(|e| format!("创建文件失败: {e}"))?;
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("写入失败: {e}"))?;
        downloaded += chunk.len() as u64;
        let ratio = if total > 0 { downloaded as f64 / total as f64 } else { 0.0 };
        app.emit("model-download-progress", serde_json::json!({ "model": name, "ratio": ratio })).ok();
    }

    drop(file);
    fs::rename(&tmp_path, &model_path).map_err(|e| format!("重命名失败: {e}"))?;
    app.emit("model-download-progress", serde_json::json!({ "model": name, "ratio": 1.0 })).ok();
    Ok(model_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_whisper_model(model: String) -> Result<(), String> {
    let path = model_path(&model);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
}

/// 检测当前平台 GPU 类型
#[tauri::command]
pub fn detect_gpu() -> serde_json::Value {
    let info = gpu::detect_gpu();
    serde_json::to_value(info).unwrap_or(json!({"gpu_type":"cpu","name":"检测失败","available":false}))
}

/// GPU 状态：检测结果 + 安装状态 + 推荐
#[tauri::command]
pub fn get_gpu_status() -> serde_json::Value {
    let detected = gpu::detect_gpu();
    let active_var = if detected.available
        && gpu::gpu_bin_installed(detected.gpu_type)
    {
        gpu::gpu_variant_label(detected.gpu_type)
    } else if cfg!(target_os = "macos") {
        "metal"
    } else {
        "cpu"
    };

    let recommended = if cfg!(target_os = "macos") || !detected.available {
        ""
    } else {
        gpu::gpu_variant_label(detected.gpu_type)
    };

    let recommended_downloaded = if recommended.is_empty() {
        false
    } else {
        gpu::gpu_bin_installed(detected.gpu_type)
    };

    let download_url = if !recommended.is_empty() && !recommended_downloaded {
        gpu_release_url(recommended)
    } else {
        String::new()
    };

    serde_json::json!({
        "detected": {
            "gpu_type": gpu::gpu_variant_label(detected.gpu_type),
            "name": detected.name,
            "available": detected.available,
            "vram_mb": detected.vram_mb,
        },
        "active_variant": active_var,
        "active_is_gpu": matches!(active_var, "metal" | "cuda" | "vulkan"),
        "recommended": recommended,
        "recommended_downloaded": recommended_downloaded,
        "download_url": download_url,
        "download_size_mb": 50,
    })
}

/// 返回建议并发数：有 GPU 时按显存算，没有 GPU 串行
/// 每个 whisper small 模型推理约占 ~1.5 GB 显存，保守按 2 GB 算
#[tauri::command]
pub fn get_concurrency() -> serde_json::Value {
    let info = gpu::detect_gpu();
    let is_gpu = info.available && !matches!(info.gpu_type, gpu::GpuType::Cpu);
    let concurrency = if is_gpu {
        let vram = info.vram_mb.unwrap_or(2048);
        // 每个任务约 2 GB，保留 1 GB 给系统，最少 1，最多 8
        let n = ((vram.saturating_sub(1024)) / 2048).max(1).min(8) as usize;
        n
    } else {
        1
    };
    serde_json::json!({
        "concurrency": concurrency,
        "gpu": is_gpu,
        "vram_mb": info.vram_mb,
        "gpu_name": info.name,
    })
}

/// whisper.cpp 版本锁定
const WHISPER_CPP_TAG: &str = "v1.8.4";

/// GitHub 下载镜像前缀（国内加速），为空则直连
const GITHUB_MIRROR: &str = "https://ghproxy.net/";

fn gpu_release_url(variant: &str) -> String {
    let base = match variant {
        "cuda" if cfg!(windows) => {
            format!("https://github.com/ggml-org/whisper.cpp/releases/download/{WHISPER_CPP_TAG}/whisper-cublas-12.4.0-bin-x64.zip")
        }
        "vulkan" if cfg!(windows) => {
            format!("https://github.com/ggml-org/whisper.cpp/releases/download/{WHISPER_CPP_TAG}/whisper-blas-bin-x64.zip")
        }
        _ => return String::new(),
    };
    format!("{GITHUB_MIRROR}{base}")
}

/// 下载 GPU 加速版 whisper 二进制（多线程分块下载）
#[tauri::command]
pub async fn download_gpu_whisper(
    app: AppHandle,
    variant: Option<String>,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::io::{Seek, SeekFrom, Write};

    let gpu_info = gpu::detect_gpu();
    let variant = variant.unwrap_or_else(|| {
        gpu::gpu_variant_label(gpu_info.gpu_type).to_string()
    });

    if variant == "cpu" {
        return Err("CPU 版本无需下载，已内置在应用中".into());
    }

    let remote = gpu_release_url(&variant);
    if remote.is_empty() {
        return Err(format!("{variant} 加速版暂无预编译包，请在 GitHub 提交 issue 请求支持"));
    }

    let ext = if cfg!(windows) { "zip" } else { "tar.xz" };
    let target_dir = gpu::gpu_bin_dir();
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("创建目录失败: {e}"))?;
    let download_path = target_dir.join(format!("whisper-{variant}.{ext}"));

    let client = reqwest::Client::new();

    // HEAD 请求获取文件大小
    let head = client.head(&remote).send().await
        .map_err(|e| format!("无法连接: {e}"))?;
    let total = head.content_length().unwrap_or(0);
    let accepts_ranges = head.headers()
        .get("accept-ranges")
        .map(|v| v.to_str().unwrap_or("") == "bytes")
        .unwrap_or(false);

    let total_mb = total as f64 / 1_048_576.0;
    emit_gpu_progress(&app, &variant, 0.0, &format!("开始下载 {} ({:.0} MB)", variant, total_mb));

    // 多线程分块下载（3 个并发）
    let concurrency = if accepts_ranges && total > 10_000_000 { 3usize } else { 1 };
    if concurrency > 1 {
        let chunk_size = total / concurrency as u64;
        let mut handles = Vec::new();
        let download_path = download_path.clone();
        let remote = remote.clone();
        let variant = variant.clone();

        // 预分配文件
        let file = fs::File::create(&download_path)
            .map_err(|e| format!("创建文件失败: {e}"))?;
        file.set_len(total).map_err(|e| format!("预分配失败: {e}"))?;
        drop(file);

        for i in 0..concurrency {
            let client = client.clone();
            let remote = remote.clone();
            let download_path = download_path.clone();
            let start = i as u64 * chunk_size;
            let end = if i == concurrency - 1 { total - 1 } else { (i as u64 + 1) * chunk_size - 1 };

            handles.push(tokio::spawn(async move {
                let resp = client.get(&remote)
                    .header("Range", format!("bytes={start}-{end}"))
                    .send().await
                    .map_err(|e| format!("分块 {i} 请求失败: {e}"))?;

                if !resp.status().is_success() && resp.status().as_u16() != 206 {
                    return Err(format!("分块 {i} HTTP {}", resp.status()));
                }

                let mut stream = resp.bytes_stream();
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&download_path)
                    .map_err(|e| format!("打开文件失败: {e}"))?;
                file.seek(SeekFrom::Start(start))
                    .map_err(|e| format!("seek 失败: {e}"))?;

                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| format!("分块 {i} 读取失败: {e}"))?;
                    file.write_all(&chunk).map_err(|e| format!("分块 {i} 写入失败: {e}"))?;
                }
                Ok::<_, String>(i)
            }));
        }

        // 等待所有分块完成，期间汇报进度
        let mut completed = 0usize;
        for h in handles {
            h.await.map_err(|e| format!("分块任务崩溃: {e}"))??;
            completed += 1;
            emit_gpu_progress(&app, &variant,
                (concurrency - 1) as f64 / concurrency as f64 + completed as f64 / concurrency as f64 * 0.2,
                &format!("下载中 {completed}/{concurrency}"));
        }
    } else {
        // 单线程流式下载
        let resp = client.get(&remote).send().await
            .map_err(|e| format!("请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("下载失败: HTTP {}", resp.status()));
        }

        let mut file = fs::File::create(&download_path)
            .map_err(|e| format!("创建文件失败: {e}"))?;
        let mut downloaded: u64 = 0;
        let mut stream = resp.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
            file.write_all(&chunk).map_err(|e| format!("写入失败: {e}"))?;
            downloaded += chunk.len() as u64;
            let ratio = if total > 0 { downloaded as f64 / total as f64 } else { 0.0 };
            emit_gpu_progress(&app, &variant, ratio * 0.95, &format!("下载中 {:.0}%", ratio * 100.0));
        }
        drop(file);
    }

    // 解压
    emit_gpu_progress(&app, &variant, 0.96, "正在解压...");
    let target_dir_for_block = target_dir.clone();
    let download_path_block = download_path.clone();
    tokio::task::spawn_blocking(move || {
        extract_archive(&download_path_block, &target_dir_for_block)?;
        flatten_dir(&target_dir_for_block);
        fs::remove_file(&download_path_block).ok();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for entry in fs::read_dir(&target_dir_for_block).map_err(|e| format!("读取目录失败: {e}"))? {
                let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
                let path = entry.path();
                if path.is_file() {
                    let mut perms = fs::metadata(&path)
                        .map_err(|e| format!("获取权限失败: {e}"))?
                        .permissions();
                    perms.set_mode(0o755);
                    fs::set_permissions(&path, perms).ok();
                }
            }
        }
        Ok::<_, String>(())
    }).await.map_err(|e| format!("解压任务异常: {e}"))??;

    emit_gpu_progress(&app, &variant, 1.0, "下载完成");
    Ok(target_dir.to_string_lossy().to_string())
}

/// 手动安装 GPU 加速包：支持直接选择 exe/bin/dll 文件（复制到 bin 目录）或 zip/xz 压缩包（解压）
#[tauri::command]
pub fn install_gpu_archive(app: AppHandle, path: String) -> Result<String, String> {
    eprintln!("[install_gpu_archive] 收到文件路径: {path}");
    let src = Path::new(&path);
    if !src.is_file() {
        eprintln!("[install_gpu_archive] 文件不存在: {path}");
        return Err(format!("文件不存在: {path}"));
    }
    eprintln!("[install_gpu_archive] 文件存在, 大小: {:?}", src.metadata().ok().map(|m| m.len()));

    let target_dir = gpu::gpu_bin_dir();
    eprintln!("[install_gpu_archive] 目标目录: {:?}", target_dir);
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("创建目录失败: {e}"))?;
    eprintln!("[install_gpu_archive] 目标目录已就绪");

    let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    eprintln!("[install_gpu_archive] 文件扩展名(小写): '{ext}'");

    match ext.as_str() {
        "zip" | "xz" => {
            eprintln!("[install_gpu_archive] 走解压路径, 调用 extract_archive");
            extract_archive(src, &target_dir)?;
            eprintln!("[install_gpu_archive] 解压完成, 目录内容:");
            if let Ok(entries) = fs::read_dir(&target_dir) {
                for e in entries.flatten() {
                    eprintln!("  {:?} (is_file={})", e.path(), e.path().is_file());
                }
            }
            eprintln!("[install_gpu_archive] 调用 flatten_dir");
            flatten_dir(&target_dir);
            eprintln!("[install_gpu_archive] flatten 后目录内容:");
            if let Ok(entries) = fs::read_dir(&target_dir) {
                for e in entries.flatten() {
                    eprintln!("  {:?} (is_file={})", e.path(), e.path().is_file());
                }
            }
        }
        _ => {
            eprintln!("[install_gpu_archive] 走复制路径");
            let name = src.file_name().unwrap_or_default();
            let dest = target_dir.join(name);
            eprintln!("[install_gpu_archive] 复制 {:?} -> {:?}", src, dest);
            fs::copy(src, &dest).map_err(|e| format!("复制文件失败: {e}"))?;
            eprintln!("[install_gpu_archive] 复制完成");
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for entry in fs::read_dir(&target_dir).map_err(|e| format!("读取目录失败: {e}"))? {
            let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
            let path = entry.path();
            if path.is_file() {
                let mut perms = fs::metadata(&path).map_err(|e| format!("获取权限失败: {e}"))?.permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&path, perms).ok();
            }
        }
    }

    let installed = fs::read_dir(&target_dir)
        .ok()
        .map(|d| d.flatten().filter(|e| e.path().is_file()).count())
        .unwrap_or(0);
    eprintln!("[install_gpu_archive] 最终文件数: {installed}");

    if installed == 0 {
        return Err("解压/复制后未找到任何文件，请确认压缩包内容".into());
    }

    app.emit("gpu-download-progress", serde_json::json!({
        "variant": "manual",
        "ratio": 1.0,
        "message": format!("已安装 {installed} 个文件"),
    })).ok();

    Ok(target_dir.to_string_lossy().to_string())
}

/// 清除 GPU 加速二进制缓存（删除 ~/.subgen_cache/bin/ 目录）
#[tauri::command]
pub fn clear_gpu_cache() -> Result<String, String> {
    let dir = gpu::gpu_bin_dir();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))?;
        Ok("GPU 加速缓存已清除".into())
    } else {
        Ok("没有可清除的 GPU 缓存".into())
    }
}

fn emit_gpu_progress(app: &AppHandle, variant: &str, ratio: f64, message: &str) {
    let url = gpu_release_url(variant);
    app.emit("gpu-download-progress", serde_json::json!({
        "variant": variant,
        "ratio": ratio,
        "message": message,
        "url": url,
    })).ok();
}

/// 解压后将子目录中的文件移到目标根目录（处理 zip 包内有根目录的情况）
fn flatten_dir(dir: &Path) {
    eprintln!("[flatten_dir] 开始处理: {:?}", dir);
    let mut files: Vec<PathBuf> = Vec::new();
    collect_files(dir, &mut files);
    eprintln!("[flatten_dir] 收集到 {} 个文件", files.len());
    for src in &files {
        if let Some(name) = src.file_name() {
            let dest = dir.join(name);
            eprintln!("[flatten_dir] 移动 {:?} -> {:?} (dest_exists={})", src, dest, dest.exists());
            if !dest.exists() {
                match fs::rename(src, &dest) {
                    Ok(()) => eprintln!("[flatten_dir] 移动成功"),
                    Err(e) => eprintln!("[flatten_dir] 移动失败: {e}"),
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                eprintln!("[flatten_dir] 删除子目录: {:?}", path);
                fs::remove_dir_all(&path).ok();
            }
        }
    }
    eprintln!("[flatten_dir] 完成");
}

fn collect_files(dir: &Path, files: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                files.push(path);
            } else if path.is_dir() {
                collect_files(&path, files);
            }
        }
    }
}

/// 解压 zip 或 tar.xz
fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let ext = archive.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    eprintln!("[extract_archive] 解压 {:?} -> {:?}, ext='{ext}'", archive, dest);
    match ext.as_str() {
        "zip" => {
            eprintln!("[extract_archive] 匹配 zip 分支");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                use std::process::Stdio;
                let ps_cmd = format!(
                    "Expand-Archive -Path \"{}\" -DestinationPath \"{}\" -Force",
                    archive.display(), dest.display()
                );
                eprintln!("[extract_archive] PS 命令: {ps_cmd}");
                let output = std::process::Command::new("powershell")
                    .args(["-Command", &ps_cmd])
                    .creation_flags(0x08000000)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .map_err(|e| format!("启动 PowerShell 失败: {e}"))?;
                eprintln!("[extract_archive] PS exit: {}", output.status.code().unwrap_or(-1));
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!("[extract_archive] PS 失败, stderr: {stderr}");
                    eprintln!("[extract_archive] 尝试 tar 兜底");
                    let tar = silent_command("tar")
                        .args(["-xf", &archive.to_string_lossy(), "-C", &dest.to_string_lossy()])
                        .stdout(Stdio::null())
                        .stderr(Stdio::piped())
                        .output()
                        .map_err(|e| format!("tar 兜底解压失败: {e}"))?;
                    eprintln!("[extract_archive] tar exit: {}", tar.status.code().unwrap_or(-1));
                    if !tar.status.success() {
                        let tar_err = String::from_utf8_lossy(&tar.stderr);
                        eprintln!("[extract_archive] tar 也失败: {tar_err}");
                        return Err(format!("解压 zip 失败\nPowerShell: {stderr}\ntar: {tar_err}"));
                    }
                    eprintln!("[extract_archive] tar 兜底成功");
                } else {
                    eprintln!("[extract_archive] PS 解压成功");
                }
            }
            #[cfg(not(windows))]
            {
                let output = silent_command("unzip")
                    .args(["-o", &archive.to_string_lossy(), "-d", &dest.to_string_lossy()])
                    .output()
                    .map_err(|e| format!("解压 zip 失败: {e}"))?;
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(format!("解压 zip 失败: {stderr}"));
                }
            }
        }
        "xz" | _ => {
            use std::process::Stdio;
            let output = silent_command("tar")
                .args(["-xf", &archive.to_string_lossy(), "-C", &dest.to_string_lossy()])
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| format!("启动 tar 失败: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("解压失败: {stderr}"));
            }
        }
    }
    Ok(())
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

async fn split_audio_for_asr(
    app: &AppHandle,
    input: &Path,
    chunk_dir: &Path,
    chunk_seconds: u32,
) -> Result<Vec<PathBuf>, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    let ffmpeg = resolve_ffmpeg(app)?;
    fs::create_dir_all(chunk_dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    let output_pattern = chunk_dir.join("chunk_%05d.wav");

    let app_clone = app.clone();
    let input = input.to_path_buf();
    let input_str = input.to_string_lossy().to_string();
    let output_pattern = output_pattern.clone();

    tokio::task::spawn_blocking(move || {
        let mut cmd = silent_command(&ffmpeg);
        cmd.args(["-y", "-hide_banner", "-loglevel", "quiet"])
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
            .stderr(Stdio::null());

        let mut child = cmd.spawn()
            .map_err(|e| format!("ffmpeg 分片启动失败: {e}"))?;

        let stdout = child.stdout.take().unwrap();
        let reader = BufReader::new(stdout);

        let mut total_us: f64 = 0.0;
        for line in reader.lines().map_while(Result::ok) {
            if let Some(val) = line.strip_prefix("duration=") {
                if let Ok(us) = val.trim().parse::<f64>() {
                    if us > 0.0 { total_us = us; }
                }
            } else if let Some(val) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = val.trim().parse::<f64>() {
                    // 留出最后 5% 给 stdout 关闭→child.wait() 之间的收尾写盘
                    let ratio = if total_us > 0.0 { (us / total_us).min(0.90) } else { 0.3 };
                    emit_progress(&app_clone, &input_str, "extracting", ratio * 0.3,
                        format!("提取音频 {:.0}%", ratio * 100.0));
                }
            }
        }
        // stdout 关闭即代表 ffmpeg 已完成主要处理，直接推满到提取完成值
        emit_progress(&app_clone, &input_str, "extracting", 0.30, "音频提取完成");

        let status = child.wait()
            .map_err(|e| format!("ffmpeg 等待失败: {e}"))?;

        if !status.success() {
            return Err(format!("ffmpeg 分片返回错误: {status}"));
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

/// 单批翻译，带重试，失败返回 Err（附带具体错误信息）
async fn translate_batch_tencent(
    client: &reqwest::Client,
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
        "ProjectId": 0
    }).to_string();

    let mut last_err = String::from("未知错误");

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
            Err(e) => { last_err = format!("网络请求失败: {e}"); continue; }
        };
        if !res.status().is_success() {
            last_err = format!("HTTP {}", res.status());
            continue;
        }
        let data: Value = match res.json().await {
            Ok(d) => d,
            Err(e) => { last_err = format!("响应解析失败: {e}"); continue; }
        };
        if let Some(error) = data.pointer("/Response/Error") {
            let code = error.get("Code").and_then(Value::as_str).unwrap_or("");
            let msg  = error.get("Message").and_then(Value::as_str).unwrap_or("");
            last_err = format!("腾讯翻译 API 错误 [{code}]: {msg}");
            // 可重试
            if code.contains("Internal") || code.contains("LimitExceeded") { continue; }
            // 不可重试（如鉴权失败），直接返回错误
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

    // ── 串行翻译（避免超过腾讯 API 每秒 5 次限制），批次间隔 250ms ──
    let mut translated = vec![String::new(); segments.len()];
    for (batch_no, (start_idx, texts)) in batches.into_iter().enumerate() {
        if batch_no > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        let result = translate_batch_tencent(client, texts.clone(), &src, &tgt, secret_id, secret_key).await?;
        for (i, text) in result.into_iter().enumerate() {
            if start_idx + i < translated.len() {
                translated[start_idx + i] = if text.is_empty() { texts[i].clone() } else { text };
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
        silent_command("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        silent_command("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        silent_command("xdg-open")
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
    let status = silent_command("curl")
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
        let status = silent_command("unzip")
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
        let status = silent_command("tar")
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

            let stem = input.file_stem()
                .and_then(|s| s.to_str()).unwrap_or("audio").to_string();
            let output = output_dir.join(format!("{stem}.wav"));
            let output_clone = output.clone();
            let ffmpeg_clone = ffmpeg.clone();
            let input_clone = input.clone();
            let app_clone = app.clone();

            // 立即发出"分析中"事件，避免用户等待无响应
            let _ = app_clone.emit("extract-progress", serde_json::json!({
                "index": i, "total": total, "ratio": 0.01,
                "message": format!("分析文件 {}/{}", i + 1, total),
            }));

            // 在 spawn_blocking 里执行 ffmpeg 提取，同时从 stderr 读时长
            let result = tokio::task::spawn_blocking(move || {
                use std::io::{BufRead, BufReader};
                use std::process::Stdio;

                let mut cmd = silent_command(&ffmpeg_clone);
                cmd.args(["-y", "-hide_banner", "-loglevel", "quiet"])
                    .arg("-i").arg(&input_clone)
                    .arg("-vn")
                    .arg("-acodec").arg("pcm_s16le")
                    .arg("-ar").arg("16000")
                    .arg("-ac").arg("1")
                    .arg("-progress").arg("pipe:1")
                    .arg("-nostats");

                if duration > 0.0 {
                    cmd.arg("-t").arg(duration.to_string());
                }

                cmd.arg(&output_clone)
                   .stdout(Stdio::piped())
                   .stderr(Stdio::null());

                let mut child = cmd.spawn()
                    .map_err(|e| format!("ffmpeg 启动失败: {e}"))?;

                let stdout = child.stdout.take().unwrap();
                let reader = BufReader::new(stdout);

                // -progress 输出：duration= 是总时长(μs)，out_time_us= 是已处理时长
                let mut total_us: f64 = 0.0;
                let mut last_out_us: f64 = 0.0;
                for line in reader.lines().map_while(Result::ok) {
                    if let Some(val) = line.strip_prefix("duration=") {
                        let v = val.trim();
                        if v != "N/A" {
                            if let Ok(us) = v.parse::<f64>() {
                                if us > 0.0 { total_us = us; }
                            }
                        }
                    } else if let Some(val) = line.strip_prefix("out_time_us=") {
                        if let Ok(us) = val.trim().parse::<f64>() {
                            if us > 0.0 { last_out_us = us; }
                            let max_us = if duration > 0.0 { duration * 1_000_000.0 } else { total_us };
                            // total_us 未知时用脉冲动画（缓慢递增到 90% 兜底）
                            let ratio = if max_us > 0.0 {
                                (us / max_us).min(0.99)
                            } else {
                                // 无总时长：按已处理时长估算（每10分钟≈一般视频）
                                (last_out_us / (600.0 * 1_000_000.0)).min(0.90)
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

                // stdout 读完说明 ffmpeg 即将结束，推 99% 避免长时间卡住
                let _ = app_clone.emit("extract-progress", serde_json::json!({
                    "index": i, "total": total, "ratio": 0.99,
                    "message": format!("收尾 {}/{}", i + 1, total),
                }));

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

            let output_path = result.as_deref().unwrap_or("").to_string();
            let output_size = fs::metadata(&output_path).ok().map(|m| m.len());
            ExtractFileResult {
                input: input_str,
                output: output_path,
                output_size,
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
        emit_progress(&app, &opts.input, "transcribing", 0.65, "从缓存加载转录结果...");
        let raw = fs::read_to_string(&asr_cache_file).unwrap_or_default();
        serde_json::from_str::<Vec<Segment>>(&raw).unwrap_or_default()
    } else {
        if skip_cache { fs::remove_file(&asr_cache_file).ok(); }
        let temp_dir = env::temp_dir().join(format!("subgen-desktop-{}", Utc::now().timestamp_millis()));
        let t_extract = std::time::Instant::now();
        emit_progress(&app, &opts.input, "extracting", 0.02, "正在本地提取并分片音频...");
        let chunks = split_audio_for_asr(&app, input, &temp_dir, chunk_seconds).await?;
        let extract_elapsed = t_extract.elapsed().as_secs_f64();
        emit_stage_done(&app, &opts.input, "extracting", extract_elapsed,
            format!("音频提取完成，用时 {:.1}s", extract_elapsed));
        let total = chunks.len();

        let segs = if opts.asr_provider == "local-whisper" {
            // ── 本地 whisper-server 模式（模型常驻，HTTP 并发请求）──
            let server_bin = resolve_whisper_server(&app)
                .or_else(|_| resolve_whisper(&app))?; // 兜底：没有 server 就用 cli
            let model_name = opts.whisper_model.as_deref().unwrap_or("small");
            let model = model_path(model_name);
            if !model.exists() {
                return Err(format!("请先下载 Whisper 模型 {model_name}（在设置中点击下载）"));
            }

            let use_server = server_bin
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.contains("server"))
                .unwrap_or(false);

            if use_server {
                // 单实例模式：一个 whisper-server 用满所有线程，比多实例互抢资源更快
                // 随机端口：避免多个文件并发处理时端口冲突
                let port = find_free_port().unwrap_or(18200);
                let t_load = std::time::Instant::now();

                emit_progress(&app, &opts.input, "loading_model", 0.32,
                    format!("正在加载 Whisper 模型（{}）...", model_name));

                let threads = num_cpus();
                let srv = silent_command(&server_bin)
                    .args([
                        "-m", &model.to_string_lossy(),
                        "--port", &port.to_string(),
                        "-t", &threads.to_string(),
                    ])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|e| format!("启动 whisper-server 失败: {e}"))?;
                let mut servers = vec![srv];

                // 等待实例就绪
                let client = reqwest::Client::new();
                let start = std::time::Instant::now();
                loop {
                    if start.elapsed().as_secs() > 120 {
                        for s in &mut servers { s.kill().ok(); }
                        return Err("whisper-server 启动超时（>120s）".to_string());
                    }
                    if client.get(format!("http://127.0.0.1:{port}/")).send().await.is_ok() {
                        let load_elapsed = t_load.elapsed().as_secs_f64();
                        emit_stage_done(&app, &opts.input, "loading_model", load_elapsed,
                            format!("模型就绪，用时 {:.1}s", load_elapsed));
                        break;
                    }
                    let elapsed = start.elapsed().as_secs();
                    if elapsed % 5 == 0 && elapsed > 0 {
                        emit_progress(&app, &opts.input, "loading_model", 0.34,
                            format!("正在加载模型... ({elapsed}s)"));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                }

                // 并发转录（server 内部串行处理，HTTP 队列）
                let done_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
                let mut handles = Vec::new();

                for (i, chunk) in chunks.iter().enumerate() {
                    let client = client.clone();
                    let chunk = chunk.clone();
                    let lang = opts.source_lang.clone();
                    let offset = i as f64 * chunk_seconds as f64;
                    let done_count = done_count.clone();
                    let app = app.clone();
                    let input_path = opts.input.clone();
                    handles.push(tokio::spawn(async move {
                        let result = transcribe_with_whisper_server(&client, port, &chunk, &lang, offset).await;
                        let done = done_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                        emit_progress(&app, &input_path, "transcribing",
                            0.38 + 0.28 * (done as f64 / total as f64),
                            format!("转录完成 {done}/{total}"));
                        result.map(|s| (i, s))
                    }));
                }

                let mut results = Vec::new();
                for h in handles {
                    match h.await {
                        Ok(Ok(r)) => results.push(r),
                        Ok(Err(e)) => { for s in &mut servers { s.kill().ok(); } return Err(e); }
                        Err(e) => { for s in &mut servers { s.kill().ok(); } return Err(format!("转录任务崩溃: {e}")); }
                    }
                }
                for s in &mut servers { s.kill().ok(); }
                results.sort_by_key(|(i, _)| *i);
                results.into_iter().flat_map(|(_, s)| s).collect::<Vec<_>>()
            } else {
                // ── 兜底：whisper-cli 模式（每 chunk 独立进程）──
                let whisper = server_bin;
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
                    let input_path = opts.input.clone();
                    handles.push(tokio::spawn(async move {
                        let _permit = sem.acquire().await.unwrap();
                        let result = transcribe_with_whisper_legacy(&whisper, &model, &chunk, &lang, offset).await;
                        let done = done_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                        emit_progress(&app, &input_path, "transcribing",
                            0.38 + 0.28 * (done as f64 / total as f64),
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
            }
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
                        tencent_secret_key: None, chunk_seconds: None, skip_cache: None, whisper_model: None,
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
                        emit_progress(&app, &opts.input, "transcribing",
                            0.32 + 0.33 * (done as f64 / total as f64),
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
        emit_stage_done(&app, &opts.input, "transcribing", asr_elapsed,
            format!("转录完成，用时 {:.1}s", asr_elapsed));
        if let Ok(json) = serde_json::to_string(&segs) {
            fs::write(&asr_cache_file, json).ok();
        }
        segs
    };

    let client = reqwest::Client::new();
    let t_translate = std::time::Instant::now();
    emit_progress(&app, &opts.input, "translating", 0.72, "正在翻译字幕...");
    let translated = translate_segments(&client, &segments, &opts, Some(&cache_dir)).await?;
    let trl_elapsed = t_translate.elapsed().as_secs_f64();
    emit_stage_done(&app, &opts.input, "translating", trl_elapsed,
        format!("翻译完成，用时 {:.1}s", trl_elapsed));

    emit_progress(&app, &opts.input, "saving", 0.94, "正在写入字幕文件...");
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
    emit_stage_done(&app, &opts.input, "done", total_elapsed,
        format!("完成，总用时 {:.1}s", total_elapsed));

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

/// 批量获取文件大小（字节），找不到返回 0
#[tauri::command]
pub fn get_file_sizes(paths: Vec<String>) -> Vec<u64> {
    paths.iter().map(|p| fs::metadata(p).map(|m| m.len()).unwrap_or(0)).collect()
}

/// 保存 SRT 内容到指定路径（用户选择后调用）
#[tauri::command]
pub fn save_srt(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(&path, content).map_err(|e| format!("保存失败: {e}"))
}
