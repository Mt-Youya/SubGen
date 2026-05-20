use std::path::{Path, PathBuf};
use std::fs;

use tauri::{AppHandle, Emitter, Manager};

use super::deps::resolve_ffmpeg;
use super::types::{ExtractFileResult, ExtractOptions, ExtractResult};
use super::utils::silent_command;

/// 检查 ffmpeg 是否可用，返回可执行文件路径字符串；不可用时返回 None。
/// 供前端 DependencyCheck 组件判断是否需要提示用户下载 ffmpeg。
#[tauri::command]
pub fn check_ffmpeg(app: AppHandle) -> Option<String> {
    resolve_ffmpeg(&app).ok().map(|p| p.to_string_lossy().to_string())
}

/// 返回当前使用的 ffmpeg 路径，找不到则返回错误（供调试用）。
#[tauri::command]
pub fn get_ffmpeg_path(app: AppHandle) -> Result<String, String> {
    resolve_ffmpeg(&app).map(|p| p.to_string_lossy().to_string())
}

/// 下载静态编译版 ffmpeg 到应用 resource 目录。
///
/// 各平台选择不同的下载源：
/// - macOS arm64：evermeet.cx 提供 universal/arm64 静态构建
/// - macOS x86_64 / Windows：BtbN 提供 GPL 静态构建
/// - Linux：BtbN，运行时检测 aarch64 / x86_64 选择对应包
///
/// 用 curl 而非 reqwest 下载，避免为此单一功能引入 async HTTP 依赖，
/// 同时 curl 在大多数操作系统上已经预装。
#[tauri::command]
pub async fn download_ffmpeg(app: AppHandle) -> Result<String, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("获取 resource 目录失败: {e}"))?;
    fs::create_dir_all(&resource_dir).map_err(|e| format!("创建目录失败: {e}"))?;

    let ffmpeg_path = resource_dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });

    // 根据平台和架构选择下载地址
    let url = if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            // evermeet 提供 macOS arm64 静态构建，含 M 系列芯片优化
            "https://evermeet.cx/ffmpeg/get/zip"
        } else {
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-macos64-gpl.zip"
        }
    } else if cfg!(target_os = "windows") {
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    } else {
        // Linux 运行时检测 CPU 架构（cfg! 宏在交叉编译时反映目标架构，不一定是运行时架构）
        let arch = std::process::Command::new("uname")
            .arg("-m")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default();
        if arch.trim().contains("aarch64") {
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz"
        } else {
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
        }
    };

    // 用 curl -L 下载（-L 跟随重定向，GitHub Releases 通常有 302 重定向）
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

    // 解压（macOS/Windows 用 zip，Linux 用 tar.xz）
    if cfg!(target_os = "macos") || cfg!(target_os = "windows") {
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
        // BtbN 包解压后有子目录（如 ffmpeg-master-latest-macos64-gpl/bin/ffmpeg），
        // evermeet 包解压后直接是 ffmpeg；递归查找，找到后移到 resource 根目录
        if !ffmpeg_path.exists() {
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
        // Linux tar.xz 解压
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

    // 清理临时压缩包
    fs::remove_file(&archive).ok();

    if !ffmpeg_path.exists() {
        return Err("下载解压后未找到 ffmpeg 文件".to_string());
    }

    // Unix 需要手动设置可执行权限（zip/tar 解压后权限位可能丢失）
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&ffmpeg_path)
            .map_err(|e| format!("读取权限失败: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ffmpeg_path, perms)
            .map_err(|e| format!("设置权限失败: {e}"))?;
    }

    Ok(ffmpeg_path.to_string_lossy().to_string())
}

/// 批量提取音频：将视频/音频文件转为 16kHz 单声道 WAV，并实时上报进度。
///
/// 每个文件独立 spawn 一个 Tokio task 并发处理，最大化多核利用率。
/// 每个 task 内部通过 ffmpeg -progress 解析进度事件，
/// 推送 "extract-progress" 事件到前端实现精确进度条。
#[tauri::command]
pub async fn extract_audio(app: AppHandle, opts: ExtractOptions) -> Result<ExtractResult, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    let ffmpeg = resolve_ffmpeg(&app)?;
    fs::create_dir_all(&opts.output_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;

    let total = opts.inputs.len();
    if total == 0 {
        return Err("请至少选择一个文件".to_string());
    }

    // 每个文件独立 spawn，互不阻塞
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
                .and_then(|s| s.to_str())
                .unwrap_or("audio")
                .to_string();
            let output = output_dir.join(format!("{stem}.wav"));
            let output_clone = output.clone();
            let ffmpeg_clone = ffmpeg.clone();
            let input_clone = input.clone();
            let app_clone = app.clone();

            // 立即发出"分析中"事件，让用户知道文件已开始处理，避免长时间无响应
            let _ = app_clone.emit("extract-progress", serde_json::json!({
                "index": i, "total": total, "ratio": 0.01,
                "message": format!("分析文件 {}/{}", i + 1, total),
            }));

            // ffmpeg 在 blocking 线程中执行，不阻塞 Tokio 运行时
            let result = tokio::task::spawn_blocking(move || {
                let mut cmd = silent_command(&ffmpeg_clone);
                cmd
                    .args(["-y", "-hide_banner", "-loglevel", "quiet"])
                    .arg("-i").arg(&input_clone)
                    .arg("-vn")                      // 忽略视频流
                    .arg("-acodec").arg("pcm_s16le")  // 16-bit PCM WAV
                    .arg("-ar").arg("16000")           // 16kHz 采样率
                    .arg("-ac").arg("1")               // 单声道
                    .arg("-progress").arg("pipe:1")    // 进度写 stdout
                    .arg("-nostats");

                // duration > 0 时限制提取时长（用于预览/测试）
                if duration > 0.0 {
                    cmd.arg("-t").arg(duration.to_string());
                }

                cmd.arg(&output_clone)
                   .stdout(Stdio::piped())
                   .stderr(Stdio::null());

                let mut child = cmd.spawn().map_err(|e| format!("ffmpeg 启动失败: {e}"))?;
                let stdout = child.stdout.take().unwrap();
                let reader = BufReader::new(stdout);

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
                            // duration 参数限制时取较小值作为 100% 参考
                            let max_us = if duration > 0.0 { duration * 1_000_000.0 } else { total_us };
                            let ratio = if max_us > 0.0 {
                                (us / max_us).min(0.99)
                            } else {
                                // 没有总时长信息：假设总时长 10 分钟作为参考（兜底）
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

                // stdout 读完表示 ffmpeg 主体完成，推到 99% 避免进度条长时间卡住
                let _ = app_clone.emit("extract-progress", serde_json::json!({
                    "index": i, "total": total, "ratio": 0.99,
                    "message": format!("收尾 {}/{}", i + 1, total),
                }));

                let status = child.wait().map_err(|e| format!("ffmpeg 等待失败: {e}"))?;
                if !status.success() {
                    return Err(format!("ffmpeg 返回错误: {status}"));
                }
                Ok(output_clone.to_string_lossy().to_string())
            })
            .await;

            // 展开 JoinError + 内部 Result
            let result: Result<String, String> = match result {
                Ok(Ok(s))  => Ok(s),
                Ok(Err(e)) => Err(e),
                Err(e)     => Err(format!("任务异常: {e}")),
            };

            let elapsed = t_file.elapsed().as_secs_f64();
            // 完成后推 100%，无论成功还是失败都要更新，让进度条不卡住
            let _ = app.emit("extract-progress", serde_json::json!({
                "index": i, "total": total, "ratio": 1.0,
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

    // 收集所有结果（保持原始输入顺序）
    let mut files = Vec::new();
    for h in handles {
        if let Ok(r) = h.await {
            files.push(r);
        }
    }

    Ok(ExtractResult { files })
}
