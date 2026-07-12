use std::path::PathBuf;
use std::env;

use tauri::{AppHandle, Manager};

use crate::gpu;
use super::utils::dirs_cache;
#[cfg(unix)]
use super::utils::set_executable;

/// 查找可用的 ffmpeg 可执行文件，返回完整路径。
///
/// 优先级：
/// 1. Tauri resource 目录内置的 ffmpeg（打包时随应用分发，最可靠）
/// 2. 系统 PATH 中的 ffmpeg（用户自行安装）
/// 3. 各平台常见安装路径（如 Homebrew、BtbN 等）
///
/// 内置优先的原因：保证不同系统环境下行为一致，避免因系统 ffmpeg 版本差异导致的兼容问题。
pub fn resolve_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };

    // 1. 先找 Tauri resource 目录（打包版在此，开发时在 src-tauri/resources/）
    if let Ok(resource_path) = app.path().resource_dir() {
        // 同时检查根目录和 resources/ 子目录，兼容不同打包工具的目录约定
        for dir in [resource_path.clone(), resource_path.join("resources")] {
            let bundled = dir.join(name);
            if bundled.is_file() {
                // Unix 下需要确保可执行位已设置（zip/tar 解压后可能丢失）
                #[cfg(unix)]
                set_executable(&bundled);
                return Ok(bundled);
            }
        }
    }

    // 2. 系统 PATH + 各平台常见安装路径
    let sep = if cfg!(windows) { ';' } else { ':' };
    let path_str = env::var("PATH").unwrap_or_default();
    let extra: &[&str] = if cfg!(windows) {
        &[
            "C:\\ffmpeg\\bin",
            "C:\\Program Files\\ffmpeg\\bin",
            "C:\\Program Files (x86)\\ffmpeg\\bin",
        ]
    } else if cfg!(target_os = "macos") {
        &[
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/opt/homebrew/opt/ffmpeg/bin",
            "/usr/bin",
        ]
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

/// 查找 whisper-cli 可执行文件（每个 chunk 独立进程的兜底方案）。
pub fn resolve_whisper(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" };
    resolve_binary(app, name)
}

/// 查找 whisper-server 可执行文件（HTTP 模式，性能更好）。
pub fn resolve_whisper_server(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "whisper-server.exe" } else { "whisper-server" };
    resolve_binary(app, name)
}

/// 通用二进制文件查找逻辑。
///
/// 优先级：
/// 1. GPU 版缓存目录（~/.subgen_cache/bin/）：用户下载的 GPU 加速版
/// 2. Tauri resource 目录：打包时内置的 CPU 版
/// 3. 系统 PATH：用户自行安装的版本
///
/// GPU 版优先是因为它性能更好；但若 GPU 版损坏，回退到内置版保证基本可用。
pub fn resolve_binary(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    // GPU 加速版二进制（用户主动下载后存放在缓存目录）
    let cache_bin = gpu::gpu_bin_dir().join(name);
    if cache_bin.is_file() {
        #[cfg(unix)]
        set_executable(&cache_bin);
        return Ok(cache_bin);
    }

    // Tauri resource 目录（应用打包时内置）
    if let Ok(resource_path) = app.path().resource_dir() {
        for dir in [resource_path.clone(), resource_path.join("resources")] {
            let p = dir.join(name);
            if p.is_file() {
                #[cfg(unix)]
                set_executable(&p);
                return Ok(p);
            }
        }
    }

    // 系统 PATH（最后兜底）
    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in env::var("PATH").unwrap_or_default().split(sep) {
        let p = PathBuf::from(dir).join(name);
        if p.is_file() {
            return Ok(p);
        }
    }

    Err(format!("未找到 {name}，请重新安装 SubGen"))
}

/// 构造指定模型的本地文件路径（~/.subgen_cache/models/ggml-{name}.bin）。
/// GGML 格式是 whisper.cpp 使用的量化模型格式，文件名固定前缀 ggml-。
pub fn model_path(name: &str) -> PathBuf {
    dirs_cache().join("models").join(format!("ggml-{name}.bin"))
}

/// 返回默认模型路径（small 模型）。
/// small 是速度和精度的平衡点，作为未指定模型时的兜底。
pub fn default_model_path() -> PathBuf {
    model_path("small")
}
