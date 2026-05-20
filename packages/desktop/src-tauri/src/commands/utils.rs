use std::path::PathBuf;
use std::process::Command;
use std::{env, fs};

use tauri::{AppHandle, Emitter};

use super::types::ProgressPayload;

/// 创建不弹窗的系统命令。
/// Windows release 构建下，默认每次启动子进程都会短暂出现黑色 cmd 窗口；
/// CREATE_NO_WINDOW (0x08000000) 标志让子进程在后台静默运行，改善用户体验。
/// Unix 上没有此问题，直接返回标准 Command。
pub fn silent_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
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

/// 发送进行中的进度事件到前端。
/// ratio 是 [0.0, 1.0] 的进度比例，前端据此更新进度条；
/// elapsed_secs / stage_elapsed_secs 均为 None，表示阶段尚未完成。
pub fn emit_progress(app: &AppHandle, input: &str, stage: &str, ratio: f64, message: impl Into<String>) {
    let _ = app.emit("subtitle-progress", ProgressPayload {
        input: input.to_string(),
        stage: stage.to_string(),
        ratio,
        message: message.into(),
        elapsed_secs: None,
        stage_elapsed_secs: None,
    });
}

/// 发送阶段完成事件。
/// ratio 固定为 1.0 表示该阶段 100% 完成；
/// stage_elapsed_secs 记录本阶段耗时，前端可用来展示各阶段用时明细。
pub fn emit_stage_done(app: &AppHandle, input: &str, stage: &str, stage_elapsed: f64, message: impl Into<String>) {
    let _ = app.emit("subtitle-progress", ProgressPayload {
        input: input.to_string(),
        stage: stage.to_string(),
        ratio: 1.0,
        message: message.into(),
        elapsed_secs: Some(stage_elapsed),
        stage_elapsed_secs: Some(stage_elapsed),
    });
}

/// 清理 API Key 字符串：去除首尾空白，过滤空字符串。
/// 前端 input 控件可能会携带不可见空格，统一在 Rust 侧处理，
/// 避免把带空格的无效 key 发送给第三方 API 导致鉴权失败。
pub fn clean_key(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 获取可用的逻辑 CPU 核心数，用于设置 whisper-server 的转录线程数。
/// 失败时返回保守值 4，避免 panic 影响主流程。
pub fn num_cpus() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

/// 绑定 port 0 让 OS 分配一个空闲端口，立即释放后返回端口号，
/// 供 whisper-server 监听。这样避免写死端口导致多实例冲突。
/// TcpListener 析构时会自动释放绑定，OS 通常会在短时间内保持该端口可用。
pub fn find_free_port() -> Option<u16> {
    use std::net::TcpListener;
    TcpListener::bind("127.0.0.1:0").ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
}

/// 返回 SubGen 的用户级缓存目录（~/.subgen_cache）。
/// 模型、翻译缓存、GPU 二进制都存放在这里，与应用安装目录解耦，
/// 重装应用不会丢失已下载的模型。
/// Windows 下优先用 USERPROFILE，其次 APPDATA，最终兜底用当前目录 "."。
pub fn dirs_cache() -> PathBuf {
    let base = if cfg!(windows) {
        env::var("USERPROFILE").or_else(|_| env::var("APPDATA")).unwrap_or_else(|_| ".".into())
    } else {
        env::var("HOME").unwrap_or_else(|_| ".".into())
    };
    PathBuf::from(base).join(".subgen_cache")
}

/// 给文件设置 Unix 可执行权限（0o755）。
/// 从 HTTP 下载或解压出来的二进制默认没有执行位，调用前必须手动设置，
/// 否则 spawn() 会返回 Permission denied 错误。
/// Windows 上文件权限模型不同，不需要此操作，因此用 cfg(unix) 限制。
#[cfg(unix)]
pub fn set_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).ok();
    }
}
