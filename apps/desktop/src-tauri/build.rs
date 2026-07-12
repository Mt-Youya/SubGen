fn main() {
    tauri_build::build();

    // macOS: 对 debug 二进制自动签名，解决 WebKit 沙箱限制
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        // OUT_DIR 在 target/debug/build/... 里，向上找到 target/debug/
        let out_dir = std::env::var("OUT_DIR").unwrap_or_default();
        // 找到 target/debug 目录
        if let Some(target_debug) = find_target_debug(&out_dir) {
            let binary = format!("{}/subgen-desktop", target_debug);
            // 只在二进制存在时签名（首次编译时还不存在）
            if std::path::Path::new(&binary).exists() {
                Command::new("codesign")
                    .args(["--force", "--deep", "--sign", "-", &binary])
                    .status()
                    .ok();
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn find_target_debug(out_dir: &str) -> Option<String> {
    let mut path = std::path::Path::new(out_dir);
    loop {
        if path.ends_with("debug") {
            return Some(path.to_string_lossy().to_string());
        }
        path = path.parent()?;
    }
}
