use std::path::PathBuf;

// serde::Serialize 让枚举/结构体可以被序列化为 JSON，
// 这样 detect_gpu() 的结果才能通过 Tauri IPC 返回给前端。
use serde::Serialize;

// derive(Debug) 方便在日志/panic 信息中打印值；
// Clone/Copy 允许按值复制（枚举很小，复制比引用传递更简洁）；
// PartialEq/Eq 允许用 == 比较，在 commands.rs 里判断是否 CPU 时会用到。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
// serde rename_all = "lowercase"：序列化时变体名全部小写（Metal→"metal"），
// 与前端 TypeScript 类型保持一致，避免大小写不匹配导致的前端逻辑错误。
#[serde(rename_all = "lowercase")]
// dead_code 的 allow：Cpu 变体目前只做"无 GPU"的占位符，没有业务逻辑直接引用，
// 但不加 allow 会产生编译警告，影响 CI 输出清晰度。
#[allow(dead_code)]
pub enum GpuType {
    Metal,  // macOS Apple Silicon / AMD GPU，使用 Metal 框架加速
    Cuda,   // NVIDIA GPU，使用 CUDA 加速（Windows/Linux）
    Vulkan, // 其他 GPU（AMD/Intel on Windows/Linux），使用 Vulkan 加速
    Cpu,    // 没有可用 GPU，回退到纯 CPU 推理
}

// GpuInfo 聚合了一次检测的全部结果，作为单一数据包传给 commands 层，
// 避免多次调用平台 API 带来的性能损耗。
#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    pub gpu_type: GpuType,
    pub name: String,      // 人类可读的 GPU 型号名称，供 UI 展示
    pub available: bool,   // 是否检测到可用 GPU（false 时回退 CPU）
    pub vram_mb: Option<u64>, // 显存 MB；Apple Silicon 统一内存估算值，CPU 为 None
}

/// 跨平台 GPU 检测入口。
/// 使用编译期条件分支（#[cfg]）而非运行时判断，可以把不相关平台的代码完全剔除出二进制，
/// 既减小包体积，也避免在 macOS 上调用 Windows 专属 API 导致链接失败。
pub fn detect_gpu() -> GpuInfo {
    // 每个分支末尾的 return 是必要的：Rust 要求所有分支都返回相同类型，
    // 而 #[cfg] 分支在编译期已确定只有一个生效，加 return 让语意更清晰。
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
    // 兜底：FreeBSD 等非主流平台，直接标记为无 GPU，不做任何系统调用。
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        return GpuInfo { gpu_type: GpuType::Cpu, name: "未知平台".into(), available: false, vram_mb: None };
    }
}

// macOS 专属实现。cfg 编译条件保证此函数只在 macOS 目标下编译，
// 在其他平台编译时完全不存在，不会产生"未使用函数"警告。
#[cfg(target_os = "macos")]
fn detect_macos() -> GpuInfo {
    // system_profiler 是 macOS 内置的硬件信息工具，-json 输出结构化数据便于解析。
    // 之所以不用第三方 crate，是为了避免增加编译依赖和二进制体积；
    // ok() 把 Err 转为 None，任何步骤失败都不会 panic，而是优雅降级。
    let sp = std::process::Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .ok()
        .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok());

    // SPDisplaysDataType 是一个数组，每个元素对应一块显示适配器。
    // 取第一个即为主 GPU（MacBook 通常只有一个）。
    let display = sp.as_ref()
        .and_then(|v| v.get("SPDisplaysDataType")?.as_array()?.first().cloned());

    // sppci_model 字段存放人类可读的 GPU 型号，如 "Apple M3 Pro"。
    // 若字段不存在（老版 macOS / 虚拟机），使用通用描述兜底。
    let name = display.as_ref()
        .and_then(|d| d.get("sppci_model")?.as_str().map(String::from))
        .unwrap_or_else(|| "Apple GPU (Metal)".into());

    // Apple Silicon 统一内存：从 SPHardwareDataType 读 RAM 作为显存上限
    // 独立 GPU 从 spdisplays_vram 读
    let vram_mb = display.as_ref().and_then(|d| {
        // 独显路径：spdisplays_vram 格式如 "8 GB" 或 "1024 MB"。
        // 优先读这个字段，因为独显有专属显存，比统一内存估算更精确。
        if let Some(s) = d.get("spdisplays_vram").and_then(|v| v.as_str()) {
            let s = s.to_lowercase();
            if s.contains("gb") {
                // 单位换算：GB → MB（乘 1024）
                let n: f64 = s.split_whitespace().next()?.parse().ok()?;
                return Some((n * 1024.0) as u64);
            } else if s.contains("mb") {
                let n: u64 = s.split_whitespace().next()?.parse().ok()?;
                return Some(n);
            }
        }
        // Apple Silicon 统一内存路径：spdisplays_vram_shared 字段，值为系统总 RAM。
        // Metal 可按需使用全部内存作为显存，这里直接取全量作为可用显存上限。
        if let Some(s) = d.get("spdisplays_vram_shared").and_then(|v| v.as_str()) {
            let s = s.to_lowercase();
            if s.contains("gb") {
                let n: f64 = s.split_whitespace().next()?.parse().ok()?;
                return Some((n * 1024.0) as u64);
            }
        }
        None
    }).or_else(|| {
        // 终极 fallback：两个 spdisplays_vram* 字段都读不到时，
        // 用 SPHardwareDataType 里的 physical_memory（系统总 RAM），
        // 取一半作为 Apple Silicon 可分配给 GPU 的保守估算。
        let hw = std::process::Command::new("system_profiler")
            .args(["SPHardwareDataType", "-json"])
            .output().ok()
            .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())?;
        let mem_str = hw.get("SPHardwareDataType")?.as_array()?.first()?
            .get("physical_memory")?.as_str()?;
        // "16 GB" → 8192 MB（只取一半，给操作系统/其他进程留余量）
        let s = mem_str.to_lowercase();
        if s.contains("gb") {
            let n: f64 = s.split_whitespace().next()?.parse().ok()?;
            Some((n * 512.0) as u64) // ÷2 再 ×1024 = ×512
        } else {
            None
        }
    });

    // macOS 上凡是能运行本应用的机器都支持 Metal，因此 available 固定为 true。
    GpuInfo { gpu_type: GpuType::Metal, name, available: true, vram_mb }
}

#[cfg(target_os = "windows")]
fn detect_windows() -> GpuInfo {
    // SystemRoot 指向 Windows 系统目录（通常是 C:\Windows）。
    // 取不到环境变量时用硬编码默认值，因为该变量在正常 Windows 安装下必然存在。
    let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());

    // 1. 检测 NVIDIA CUDA：查找 nvcuda.dll 是否存在于 System32。
    // 这个 DLL 只有在安装了 NVIDIA 驱动后才会出现，是判断 CUDA 可用性的最可靠方式，
    // 无需运行任何外部程序，也不需要管理员权限。
    let cuda_dll = PathBuf::from(&sys_root).join("System32").join("nvcuda.dll");
    if cuda_dll.exists() {
        let name = get_nvidia_name_windows();
        let vram_mb = get_vram_windows();
        return GpuInfo { gpu_type: GpuType::Cuda, name, available: true, vram_mb };
    }

    // 2. 检测 Vulkan：查找 vulkan-1.dll。
    // AMD/Intel 显卡安装了 Vulkan 运行时后才有此 DLL，
    // whisper.cpp 的 Vulkan 后端即依赖它。
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

    // 两者都不存在，说明没有可用 GPU 加速。
    GpuInfo { gpu_type: GpuType::Cpu, name: "未检测到 GPU".into(), available: false, vram_mb: None }
}

#[cfg(target_os = "windows")]
fn get_vram_windows() -> Option<u64> {
    // nvidia-smi 优先：wmic AdapterRAM 是 32 位字段，4GB 以上不准确
    if let Ok(out) = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
    {
        if let Some(mib) = String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .and_then(|l| l.trim().parse::<u64>().ok())
        {
            return Some(mib);
        }
    }
    // 兜底：wmic
    let out = std::process::Command::new("wmic")
        .args(["path", "win32_VideoController", "get", "AdapterRAM,Name", "/format:csv"])
        .output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
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
    // 通过 wmic 获取 NVIDIA GPU 名称（兼容性好，不依赖额外 DLL）。
    // 使用 wmic 而非 nvml.dll 的原因：nvml 需要额外的 DLL 依赖和复杂的 FFI 绑定，
    // 而 wmic 在所有 Windows 版本上都可用，且只需要读取公开的 WMI 数据。
    std::process::Command::new("wmic")
        .args(["path", "win32_VideoController", "get", "name", "/format:csv"])
        .output()
        .ok()
        .and_then(|o| {
            let out = String::from_utf8_lossy(&o.stdout);
            // 在所有行中找第一个包含 "nvidia" 的行，取第二个 CSV 字段作为 GPU 名。
            out.lines()
                .find(|l| l.to_lowercase().contains("nvidia"))
                .map(|l| l.split(',').nth(1).unwrap_or("NVIDIA GPU").trim().to_string())
        })
        .unwrap_or_else(|| "NVIDIA GPU".into())
}

#[cfg(target_os = "linux")]
fn detect_linux() -> GpuInfo {
    // 1. 检测 NVIDIA CUDA：/dev/nvidia0 是 NVIDIA 内核模块创建的字符设备。
    // 只要驱动已加载且 GPU 可用，该文件就必然存在；无需 root 权限也能检查。
    if std::path::Path::new("/dev/nvidia0").exists() {
        let name = get_nvidia_name_linux();
        let vram_mb = get_nvidia_vram_linux();
        return GpuInfo { gpu_type: GpuType::Cuda, name, available: true, vram_mb };
    }

    // 2. 检测 Vulkan：通过 /sys/class/drm/ 下的 renderD* 节点判断。
    // DRM render 节点（renderD128、renderD129 等）在任何有内核驱动的 GPU 上都会创建，
    // 包括 AMD、Intel、NVIDIA（nouveau/NVIDIA 闭源驱动均支持）。
    // 这比检查 vulkan-1.so 更可靠，因为用户可能安装了 GPU 驱动但未安装 Vulkan 运行时。
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

    // 3. lspci 兜底：当 /dev/nvidia0 和 renderD* 都没有时，尝试 lspci。
    // -nn 选项同时输出设备名和 PCI vendor/device ID，便于关键词匹配。
    // 此场景通常出现在驱动未加载但硬件存在的情况（如刚安装系统）。
    if let Ok(o) = std::process::Command::new("lspci").arg("-nn").output() {
        let out = String::from_utf8_lossy(&o.stdout);
        if out.contains("nvidia") {
            return GpuInfo {
                gpu_type: GpuType::Cuda,
                name: "NVIDIA GPU (驱动未加载)".into(),
                available: true, // 硬件存在，用户安装驱动后即可使用
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

    // 所有检测方式都没发现 GPU，返回纯 CPU 模式。
    GpuInfo { gpu_type: GpuType::Cpu, name: "未检测到 GPU".into(), available: false, vram_mb: None }
}

#[cfg(target_os = "linux")]
fn get_nvidia_vram_linux() -> Option<u64> {
    // nvidia-smi 是 NVIDIA 官方提供的管理工具，随闭源驱动一起安装。
    // --query-gpu=memory.total 精确查询显存总量；
    // --format=csv,noheader,nounits 去掉表头和单位，输出裸数字（MiB），便于直接 parse。
    let out = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output().ok()?;
    // 输出格式示例："8192\n"（单位 MiB），直接解析为 u64 即为 MB 近似值。
    String::from_utf8_lossy(&out.stdout)
        .lines().next()
        .and_then(|l| l.trim().parse::<u64>().ok())
}

#[cfg(target_os = "linux")]
fn get_nvidia_name_linux() -> String {
    // 同样使用 nvidia-smi 查询 GPU 名称；--format=csv,noheader 让输出只有名称字符串。
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

/// 返回 GPU 加速二进制的缓存目录（{cache}/bin/）。
/// - Windows: {exe目录}\.subgen_cache\bin\
/// - macOS/Linux: ~/.subgen_cache/bin/
pub fn gpu_bin_dir() -> PathBuf {
    // super:: 引用父模块（crate 根），通过 commands/mod.rs 重导出的 dirs_cache()。
    // 这里不重复实现目录逻辑，保持单一数据源原则。
    super::commands::dirs_cache().join("bin")
}

/// 把 GpuType 枚举值转换为发布包文件名中的变体标签。
/// 与 GitHub Releases 的压缩包命名规则保持一致，如 whisper-cuda-xxx.zip。
pub fn gpu_variant_label(gpu_type: GpuType) -> &'static str {
    match gpu_type {
        GpuType::Metal  => "metal",
        GpuType::Cuda   => "cuda",
        GpuType::Vulkan => "vulkan",
        GpuType::Cpu    => "cpu",
    }
}

/// 判断 GPU 加速版 whisper 二进制是否已下载到本地缓存目录。
/// 只检查文件是否存在，不验证版本或完整性，以保持检测速度（每次启动都会调用）。
pub fn gpu_bin_installed(_gpu_type: GpuType) -> bool {
    let dir = gpu_bin_dir();
    // 平台区分可执行文件名：Windows 需要 .exe 后缀，Unix 无后缀。
    // server 和 cli 任意一个存在即视为已安装（有些用户可能只下载了其中一个）。
    let server = if cfg!(windows) { "whisper-server.exe" } else { "whisper-server" };
    let cli    = if cfg!(windows) { "whisper-cli.exe"    } else { "whisper-cli"    };
    dir.join(cli).is_file() || dir.join(server).is_file()
}
