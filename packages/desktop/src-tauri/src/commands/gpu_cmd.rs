use std::path::{Path, PathBuf};
use std::fs;

use futures_util::StreamExt;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::gpu;

/// whisper.cpp 发行版本号（锁定以保证二进制稳定，不随上游滚动更新）
const WHISPER_CPP_TAG: &str = "v1.8.4";

/// GitHub 下载镜像前缀（国内加速），为空则直连。
/// ghproxy.net 对 GitHub Release 下载有缓存，大幅提升国内下载速度。
const GITHUB_MIRROR: &str = "https://ghproxy.net/";

/// 构造 GPU 加速版 whisper 二进制的下载 URL。
/// 目前只支持 Windows（CUDA/Vulkan），因为 macOS Metal 已内置，Linux 用户自行编译较少。
/// 返回空字符串表示该 variant 暂无预编译包。
fn gpu_release_url(variant: &str) -> String {
    let base = match variant {
        // CUDA 12.4：匹配 NVIDIA 30xx/40xx 系列最常用的驱动版本
        "cuda" if cfg!(windows) => format!(
            "https://github.com/ggml-org/whisper.cpp/releases/download/{WHISPER_CPP_TAG}/whisper-cublas-12.4.0-bin-x64.zip"
        ),
        // Vulkan：适用于 AMD/Intel GPU 的通用后端
        "vulkan" if cfg!(windows) => format!(
            "https://github.com/ggml-org/whisper.cpp/releases/download/{WHISPER_CPP_TAG}/whisper-blas-bin-x64.zip"
        ),
        _ => return String::new(),
    };
    // 拼接镜像前缀，国内用户可直接使用
    format!("{GITHUB_MIRROR}{base}")
}

/// 发送 GPU 下载进度事件到前端。
/// 同时附带 url，让前端在下载阶段能展示"正在下载 xxx" 的详细信息。
fn emit_gpu_progress(app: &AppHandle, variant: &str, ratio: f64, message: &str) {
    let url = gpu_release_url(variant);
    app.emit("gpu-download-progress", json!({
        "variant": variant,
        "ratio": ratio,
        "message": message,
        "url": url,
    })).ok();
}

/// 将子目录内的文件全部提升到目标根目录（处理压缩包内有单层根目录的情况）。
///
/// 大多数 zip 包解压后会产生一个子目录（如 whisper-cublas-xxx/），
/// 里面才是真正的 exe/dll。flatten_dir 把这些文件移到 `dir` 根，
/// 然后删掉空的子目录，方便后续直接按文件名查找。
fn flatten_dir(dir: &Path) {
    let mut files: Vec<PathBuf> = Vec::new();
    collect_files(dir, &mut files);
    for src in &files {
        if let Some(name) = src.file_name() {
            let dest = dir.join(name);
            // 若目标已存在（同名文件在根目录），跳过，避免覆盖已有版本
            if !dest.exists() {
                fs::rename(src, &dest).ok();
            }
        }
    }
    // 清理移空的子目录
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                fs::remove_dir_all(&path).ok();
            }
        }
    }
}

/// 递归收集目录下所有文件路径（不含目录本身）。
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

/// 解压 zip 或 tar.xz 压缩包到目标目录。
///
/// Windows 用 PowerShell 内置的 Expand-Archive 解压 zip，无需额外工具。
/// macOS/Linux 用系统自带的 unzip 或 tar，也是零依赖。
/// 不使用 Rust 的 zip crate 是为了避免增加编译依赖和二进制体积。
fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let ext = archive.extension().and_then(|s| s.to_str()).unwrap_or("");
    match ext {
        "zip" => {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // PowerShell Expand-Archive 支持 -Force 覆盖已存在文件
                let status = std::process::Command::new("powershell")
                    .args([
                        "-Command",
                        &format!(
                            "Expand-Archive -Path \"{}\" -DestinationPath \"{}\" -Force",
                            archive.display(),
                            dest.display()
                        ),
                    ])
                    .creation_flags(0x08000000) // 隐藏 PowerShell 窗口
                    .status()
                    .map_err(|e| format!("解压 zip 失败: {e}"))?;
                if !status.success() {
                    return Err("解压 zip 失败".into());
                }
            }
            #[cfg(not(windows))]
            {
                // -o：覆盖已有文件；-d：指定输出目录
                use super::utils::silent_command;
                let status = silent_command("unzip")
                    .args(["-o", &archive.to_string_lossy(), "-d", &dest.to_string_lossy()])
                    .status()
                    .map_err(|e| format!("解压 zip 失败: {e}"))?;
                if !status.success() {
                    return Err("解压 zip 失败".into());
                }
            }
        }
        // tar.xz 及其他格式统一用 tar -xf（GNU/BSD tar 均支持自动探测格式）
        "xz" | _ => {
            use super::utils::silent_command;
            let status = silent_command("tar")
                .args(["-xf", &archive.to_string_lossy(), "-C", &dest.to_string_lossy()])
                .status()
                .map_err(|e| format!("解压 tar.xz 失败: {e}"))?;
            if !status.success() {
                return Err("解压失败".into());
            }
        }
    }
    Ok(())
}

/// 检测当前平台的 GPU 类型，返回 JSON 供前端展示。
#[tauri::command]
pub fn detect_gpu() -> serde_json::Value {
    let info = gpu::detect_gpu();
    serde_json::to_value(info)
        .unwrap_or(json!({"gpu_type":"cpu","name":"检测失败","available":false}))
}

/// 返回 GPU 完整状态：检测结果 + 当前激活的 variant + 推荐下载信息。
///
/// active_variant 决定实际使用哪套二进制：
/// - macOS 始终是 "metal"（内置支持）
/// - Windows/Linux：有 GPU 且已下载 GPU 版 → GPU variant；否则 "cpu"
///
/// recommended 是建议用户下载但尚未下载的 variant（非空时前端显示下载提示）。
#[tauri::command]
pub fn get_gpu_status() -> serde_json::Value {
    let detected = gpu::detect_gpu();

    // 判断当前实际激活的加速 variant
    let active_var = if detected.available && gpu::gpu_bin_installed(detected.gpu_type) {
        gpu::gpu_variant_label(detected.gpu_type)
    } else if cfg!(target_os = "macos") {
        "metal" // macOS Metal 内置，无需额外下载
    } else {
        "cpu"
    };

    // macOS 无需推荐下载；没有 GPU 的机器也无需推荐
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

    // 只有推荐了且未下载时才提供下载链接
    let download_url = if !recommended.is_empty() && !recommended_downloaded {
        gpu_release_url(recommended)
    } else {
        String::new()
    };

    json!({
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
        "download_size_mb": 50, // 经验估算值，供前端显示"约 50 MB"
    })
}

/// 根据显存大小返回建议的并发转录任务数。
///
/// whisper small 模型单次推理约占 ~1.5 GB 显存，保守按 2 GB 算；
/// 系统预留 1 GB 给驱动 / 其他进程，剩余显存均分给并发任务。
/// 无 GPU 时返回 1（串行），避免多进程抢 CPU 导致性能下降。
#[tauri::command]
pub fn get_concurrency() -> serde_json::Value {
    let info = gpu::detect_gpu();
    let is_gpu = info.available && !matches!(info.gpu_type, gpu::GpuType::Cpu);
    let concurrency = if is_gpu {
        let vram = info.vram_mb.unwrap_or(2048);
        // 公式：(可用显存 MB - 1024 MB 系统预留) / 2048 MB，最少 1，最多 8
        let n = ((vram.saturating_sub(1024)) / 2048).max(1).min(8) as usize;
        n
    } else {
        1
    };
    json!({
        "concurrency": concurrency,
        "gpu": is_gpu,
        "vram_mb": info.vram_mb,
        "gpu_name": info.name,
    })
}

/// 从 GitHub/镜像站下载 GPU 加速版 whisper 二进制，支持多线程分块下载。
///
/// 流程：
/// 1. HEAD 请求获取文件大小，判断服务器是否支持 Range 请求
/// 2. 支持 Range 且文件 > 10 MB → 3 个并发块同时下载（预分配文件后 seek 写入）
/// 3. 不支持 Range → 单线程流式下载
/// 4. 下载完成后解压，展平目录，设置执行权限
#[tauri::command]
pub async fn download_gpu_whisper(
    app: AppHandle,
    variant: Option<String>,
) -> Result<String, String> {
    use std::io::{Seek, SeekFrom, Write};

    let gpu_info = gpu::detect_gpu();
    // variant 未指定时，根据检测到的 GPU 自动选择
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
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let download_path = target_dir.join(format!("whisper-{variant}.{ext}"));

    let client = reqwest::Client::new();

    // HEAD 请求：获取文件大小和是否支持断点续传
    let head = client.head(&remote).send().await
        .map_err(|e| format!("无法连接: {e}"))?;
    let total = head.content_length().unwrap_or(0);
    let accepts_ranges = head.headers()
        .get("accept-ranges")
        .map(|v| v.to_str().unwrap_or("") == "bytes")
        .unwrap_or(false);

    let total_mb = total as f64 / 1_048_576.0;
    emit_gpu_progress(&app, &variant, 0.0, &format!("开始下载 {} ({:.0} MB)", variant, total_mb));

    // 文件 > 10 MB 且服务器支持 Range 时启用多线程分块下载
    let concurrency = if accepts_ranges && total > 10_000_000 { 3usize } else { 1 };

    if concurrency > 1 {
        let chunk_size = total / concurrency as u64;
        let mut handles = Vec::new();
        let download_path_c = download_path.clone();
        let remote_c = remote.clone();

        // 预分配文件大小，使各分块可以并行 seek 写入不同偏移量
        let file = fs::File::create(&download_path_c)
            .map_err(|e| format!("创建文件失败: {e}"))?;
        file.set_len(total).map_err(|e| format!("预分配失败: {e}"))?;
        drop(file);

        for i in 0..concurrency {
            let client = client.clone();
            let remote = remote_c.clone();
            let download_path = download_path_c.clone();
            let start = i as u64 * chunk_size;
            // 最后一块包含余下所有字节（避免因整除截断丢失尾部数据）
            let end = if i == concurrency - 1 { total - 1 } else { (i as u64 + 1) * chunk_size - 1 };

            handles.push(tokio::spawn(async move {
                let resp = client.get(&remote)
                    .header("Range", format!("bytes={start}-{end}"))
                    .send().await
                    .map_err(|e| format!("分块 {i} 请求失败: {e}"))?;

                // 206 Partial Content 是正确响应；200 也接受（服务器可能忽略 Range）
                if !resp.status().is_success() && resp.status().as_u16() != 206 {
                    return Err(format!("分块 {i} HTTP {}", resp.status()));
                }

                let mut stream = resp.bytes_stream();
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&download_path)
                    .map_err(|e| format!("打开文件失败: {e}"))?;
                // 定位到该分块对应的文件偏移量
                file.seek(SeekFrom::Start(start))
                    .map_err(|e| format!("seek 失败: {e}"))?;

                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| format!("分块 {i} 读取失败: {e}"))?;
                    file.write_all(&chunk).map_err(|e| format!("分块 {i} 写入失败: {e}"))?;
                }
                Ok::<_, String>(i)
            }));
        }

        // 按顺序等待所有分块完成，汇报进度
        let mut completed = 0usize;
        for h in handles {
            h.await.map_err(|e| format!("分块任务崩溃: {e}"))??;
            completed += 1;
            emit_gpu_progress(
                &app, &variant,
                completed as f64 / concurrency as f64 * 0.95,
                &format!("下载中 {completed}/{concurrency}"),
            );
        }
    } else {
        // 单线程流式下载：不支持 Range 或文件较小时使用
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
            // 乘以 0.95 留出最后 5% 给解压阶段
            emit_gpu_progress(&app, &variant, ratio * 0.95, &format!("下载中 {:.0}%", ratio * 100.0));
        }
        drop(file);
    }

    // 解压：在 blocking 线程池中执行，避免阻塞 Tokio 异步调度器
    emit_gpu_progress(&app, &variant, 0.96, "正在解压...");
    let target_dir_block = target_dir.clone();
    let download_path_block = download_path.clone();
    tokio::task::spawn_blocking(move || {
        extract_archive(&download_path_block, &target_dir_block)?;
        flatten_dir(&target_dir_block);
        // 清理压缩包，释放磁盘空间
        fs::remove_file(&download_path_block).ok();

        // Unix 上赋予解压出的所有文件可执行权限
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for entry in fs::read_dir(&target_dir_block).map_err(|e| format!("读取目录失败: {e}"))? {
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
    })
    .await
    .map_err(|e| format!("解压任务异常: {e}"))??;

    emit_gpu_progress(&app, &variant, 1.0, "下载完成");
    Ok(target_dir.to_string_lossy().to_string())
}

/// 安装用户手动下载的 GPU 加速压缩包（zip 或 tar.xz）。
///
/// 适用场景：国内网络无法访问 GitHub，用户通过其他方式下载后手动选择文件安装。
#[tauri::command]
pub fn install_gpu_archive(app: AppHandle, path: String) -> Result<String, String> {
    let src = Path::new(&path);
    if !src.is_file() {
        return Err(format!("文件不存在: {path}"));
    }
    let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("");
    if ext != "zip" && ext != "xz" {
        return Err(format!("不支持的文件格式: .{ext}，请选择 .zip 或 .tar.xz 文件"));
    }

    let target_dir = gpu::gpu_bin_dir();
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建目录失败: {e}"))?;

    extract_archive(src, &target_dir)?;
    flatten_dir(&target_dir);

    // Unix 可执行权限
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for entry in fs::read_dir(&target_dir).map_err(|e| format!("读取目录失败: {e}"))? {
            let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
            let path = entry.path();
            if path.is_file() {
                let mut perms = fs::metadata(&path)
                    .map_err(|e| format!("获取权限失败: {e}"))?.permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&path, perms).ok();
            }
        }
    }

    // 通知前端安装完成（与自动下载使用相同事件名，前端只需监听一处）
    app.emit("gpu-download-progress", json!({
        "variant": "manual",
        "ratio": 1.0,
        "message": "手动安装完成",
    })).ok();

    Ok(target_dir.to_string_lossy().to_string())
}
