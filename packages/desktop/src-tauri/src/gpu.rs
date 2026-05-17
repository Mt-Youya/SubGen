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
    pub vram_mb: Option<u64>,
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
    let sp = std::process::Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .ok()
        .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok());

    let display = sp.as_ref()
        .and_then(|v| v.get("SPDisplaysDataType")?.as_array()?.first().cloned());

    let name = display.as_ref()
        .and_then(|d| d.get("sppci_model")?.as_str().map(String::from))
        .unwrap_or_else(|| "Apple GPU (Metal)".into());

    // Apple Silicon 统一内存：从 SPHardwareDataType 读 RAM 作为显存上限
    // 独立 GPU 从 spdisplays_vram 读
    let vram_mb = display.as_ref().and_then(|d| {
        // 独显：spdisplays_vram 格式如 "8 GB" 或 "1024 MB"
        if let Some(s) = d.get("spdisplays_vram").and_then(|v| v.as_str()) {
            let s = s.to_lowercase();
            if s.contains("gb") {
                let n: f64 = s.split_whitespace().next()?.parse().ok()?;
                return Some((n * 1024.0) as u64);
            } else if s.contains("mb") {
                let n: u64 = s.split_whitespace().next()?.parse().ok()?;
                return Some(n);
            }
        }
        // Apple Silicon 统一内存：读总 RAM 的一半作为可用显存估算
        if let Some(s) = d.get("spdisplays_vram_shared").and_then(|v| v.as_str()) {
            let s = s.to_lowercase();
            if s.contains("gb") {
                let n: f64 = s.split_whitespace().next()?.parse().ok()?;
                return Some((n * 1024.0) as u64);
            }
        }
        None
    }).or_else(|| {
        // fallback：读 system_profiler SPHardwareDataType 里的 physical_memory
        let hw = std::process::Command::new("system_profiler")
            .args(["SPHardwareDataType", "-json"])
            .output().ok()
            .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())?;
        let mem_str = hw.get("SPHardwareDataType")?.as_array()?.first()?
            .get("physical_memory")?.as_str()?;
        // "16 GB" → 16384 MB，Apple Silicon 显存 = 总内存的一半估算
        let s = mem_str.to_lowercase();
        if s.contains("gb") {
            let n: f64 = s.split_whitespace().next()?.parse().ok()?;
            Some((n * 512.0) as u64) // 一半
        } else {
            None
        }
    });

    GpuInfo { gpu_type: GpuType::Metal, name, available: true, vram_mb }
}

#[cfg(target_os = "windows")]
fn detect_windows() -> GpuInfo {
    let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());

    // 1. NVIDIA CUDA: 检查 nvcuda.dll
    let cuda_dll = PathBuf::from(&sys_root).join("System32").join("nvcuda.dll");
    if cuda_dll.exists() {
        let name = get_nvidia_name_windows();
        let vram_mb = get_vram_windows();
        return GpuInfo { gpu_type: GpuType::Cuda, name, available: true, vram_mb };
    }

    // 2. Vulkan: 检查 vulkan-1.dll
    let vulkan_dll = PathBuf::from(&sys_root).join("System32").join("vulkan-1.dll");
    if vulkan_dll.exists() {
        let vram_mb = get_vram_windows();
        return GpuInfo {
            gpu_type: GpuType::Vulkan,
            name: "支持 Vulkan 的 GPU".into(),
            available: true,
            vram_mb,
        };
    }

    GpuInfo { gpu_type: GpuType::Cpu, name: "未检测到 GPU".into(), available: false, vram_mb: None }
}

#[cfg(target_os = "windows")]
fn get_vram_windows() -> Option<u64> {
    // wmic path win32_videocontroller get AdapterRAM /format:csv
    let out = std::process::Command::new("wmic")
        .args(["path", "win32_VideoController", "get", "AdapterRAM,Name", "/format:csv"])
        .output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // 优先取 NVIDIA，否则第一个非空行
    for line in text.lines() {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 3 { continue; }
        let ram_str = parts[1].trim();
        let name = parts[2].trim().to_lowercase();
        if name.contains("nvidia") || name.contains("amd") || name.contains("intel") {
            if let Ok(bytes) = ram_str.parse::<u64>() {
                if bytes > 0 { return Some(bytes / 1024 / 1024); }
            }
        }
    }
    None
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
        let vram_mb = get_nvidia_vram_linux();
        return GpuInfo { gpu_type: GpuType::Cuda, name, available: true, vram_mb };
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
                vram_mb: None,
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
                vram_mb: None,
            };
        }
        if out.contains("amd") || out.contains("intel") {
            return GpuInfo {
                gpu_type: GpuType::Vulkan,
                name: "检测到 GPU".into(),
                available: true,
                vram_mb: None,
            };
        }
    }

    GpuInfo { gpu_type: GpuType::Cpu, name: "未检测到 GPU".into(), available: false, vram_mb: None }
}

#[cfg(target_os = "linux")]
fn get_nvidia_vram_linux() -> Option<u64> {
    let out = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output().ok()?;
    // 输出格式: "8192\n"（MiB）
    String::from_utf8_lossy(&out.stdout)
        .lines().next()
        .and_then(|l| l.trim().parse::<u64>().ok())
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
