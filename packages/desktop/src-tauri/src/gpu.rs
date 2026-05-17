use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum GpuType {
    Metal,
    Cuda,
    Vulkan,
    Cpu,
}

#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    pub gpu_type: GpuType,
    pub name: String,
    pub available: bool,
}

/// 跨平台 GPU 检测
pub fn detect_gpu() -> GpuInfo {
    #[cfg(target_os = "macos")]
    {
        return detect_macos();
    }
    #[cfg(target_os = "windows")]
    {
        return detect_windows();
    }
    #[cfg(target_os = "linux")]
    {
        return detect_linux();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        return GpuInfo { gpu_type: GpuType::Cpu, name: "未知平台".into(), available: false };
    }
}

#[cfg(target_os = "macos")]
fn detect_macos() -> GpuInfo {
    // macOS 统一走 Metal，用 system_profiler 获取 GPU 名称
    let name = std::process::Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .ok()
        .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
        .and_then(|v| {
            v.get("SPDisplaysDataType")?
                .as_array()?
                .first()?
                .get("sppci_model")?
                .as_str()
                .map(String::from)
        })
        .unwrap_or_else(|| "Apple GPU (Metal)".into());

    GpuInfo { gpu_type: GpuType::Metal, name, available: true }
}

#[cfg(target_os = "windows")]
fn detect_windows() -> GpuInfo {
    let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());

    // 1. NVIDIA CUDA: 检查 nvcuda.dll
    let cuda_dll = PathBuf::from(&sys_root).join("System32").join("nvcuda.dll");
    if cuda_dll.exists() {
        let name = get_nvidia_name_windows();
        return GpuInfo { gpu_type: GpuType::Cuda, name, available: true };
    }

    // 2. Vulkan: 检查 vulkan-1.dll
    let vulkan_dll = PathBuf::from(&sys_root).join("System32").join("vulkan-1.dll");
    if vulkan_dll.exists() {
        return GpuInfo {
            gpu_type: GpuType::Vulkan,
            name: "支持 Vulkan 的 GPU".into(),
            available: true,
        };
    }

    GpuInfo { gpu_type: GpuType::Cpu, name: "未检测到 GPU".into(), available: false }
}

#[cfg(target_os = "windows")]
fn get_nvidia_name_windows() -> String {
    // 通过 wmic 获取 NVIDIA GPU 名称（兼容性好，不依赖额外 DLL）
    std::process::Command::new("wmic")
        .args(["path", "win32_VideoController", "get", "name", "/format:csv"])
        .output()
        .ok()
        .and_then(|o| {
            let out = String::from_utf8_lossy(&o.stdout);
            out.lines()
                .find(|l| l.to_lowercase().contains("nvidia"))
                .map(|l| l.split(',').nth(1).unwrap_or("NVIDIA GPU").trim().to_string())
        })
        .unwrap_or_else(|| "NVIDIA GPU".into())
}

#[cfg(target_os = "linux")]
fn detect_linux() -> GpuInfo {
    // 1. NVIDIA CUDA: 检查 /dev/nvidia0
    if std::path::Path::new("/dev/nvidia0").exists() {
        let name = get_nvidia_name_linux();
        return GpuInfo { gpu_type: GpuType::Cuda, name, available: true };
    }

    // 2. Vulkan: 检查 /sys/class/drm/ 下是否有 render 节点
    if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
        if entries.filter_map(|e| e.ok()).any(|e| {
            e.file_name().to_string_lossy().starts_with("renderD")
        }) {
            return GpuInfo {
                gpu_type: GpuType::Vulkan,
                name: "支持 Vulkan 的 GPU".into(),
                available: true,
            };
        }
    }

    // 3. lspci 兜底
    if let Ok(o) = std::process::Command::new("lspci").arg("-nn").output() {
        let out = String::from_utf8_lossy(&o.stdout);
        if out.contains("nvidia") {
            return GpuInfo {
                gpu_type: GpuType::Cuda,
                name: "NVIDIA GPU (驱动未加载)".into(),
                available: true,
            };
        }
        if out.contains("amd") || out.contains("intel") {
            return GpuInfo {
                gpu_type: GpuType::Vulkan,
                name: "检测到 GPU".into(),
                available: true,
            };
        }
    }

    GpuInfo { gpu_type: GpuType::Cpu, name: "未检测到 GPU".into(), available: false }
}

#[cfg(target_os = "linux")]
fn get_nvidia_name_linux() -> String {
    std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .map(|l| l.trim().to_string())
        })
        .unwrap_or_else(|| "NVIDIA GPU".into())
}

/// GPU 二进制缓存目录
pub fn gpu_bin_dir() -> PathBuf {
    super::commands::dirs_cache().join("bin")
}

/// 构建 GPU variant 下载文件名
pub fn gpu_variant_label(gpu_type: GpuType) -> &'static str {
    match gpu_type {
        GpuType::Metal => "metal",
        GpuType::Cuda => "cuda",
        GpuType::Vulkan => "vulkan",
        GpuType::Cpu => "cpu",
    }
}

/// 判断 GPU variant 二进制是否已下载到缓存目录
pub fn gpu_bin_installed(_gpu_type: GpuType) -> bool {
    let dir = gpu_bin_dir();
    let server = if cfg!(windows) { "whisper-server.exe" } else { "whisper-server" };
    let cli = if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" };
    dir.join(cli).is_file() || dir.join(server).is_file()
}
