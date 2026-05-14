use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

/// 获取 ffmpeg 内置存放目录
fn ffmpeg_bin_dir() -> PathBuf {
    if cfg!(windows) {
        let local = env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(local).join("subextract").join("bin")
    } else {
        let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".subextract").join("bin")
    }
}

/// 内置 ffmpeg 的完整路径
fn bundled_ffmpeg_path() -> PathBuf {
    let mut p = ffmpeg_bin_dir();
    p.push(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    p
}

/// 检查 ffmpeg 是否在系统 PATH 中可用
pub fn find_system_ffmpeg() -> Option<PathBuf> {
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    // 先检查常见安装位置
    let extra_paths: &[&str] = if cfg!(windows) {
        &[
            "C:\\ffmpeg\\bin",
            "C:\\Program Files\\ffmpeg\\bin",
            "C:\\Program Files (x86)\\ffmpeg\\bin",
        ]
    } else {
        &[
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/usr/bin",
            "/opt/ffmpeg/bin",
        ]
    };

    // 先在 PATH 中查找
    if let Ok(paths) = env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in paths.split(sep).chain(extra_paths.iter().copied()) {
            let candidate = PathBuf::from(dir).join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 再检查内置目录
    let bundled = bundled_ffmpeg_path();
    if bundled.is_file() {
        return Some(bundled);
    }

    None
}

/// 下载文件到指定路径，返回是否成功
fn download(url: &str, dest: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dest.parent().unwrap_or(dest))
        .map_err(|e| format!("创建下载目录失败: {e}"))?;

    if cfg!(windows) {
        // PowerShell Invoke-WebRequest
        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Invoke-WebRequest -Uri '{}' -OutFile '{}' -UseBasicParsing",
                    url,
                    dest.display()
                ),
            ])
            .status()
            .map_err(|e| format!("无法启动 PowerShell 下载: {e}"))?;

        if !status.success() {
            return Err(format!("PowerShell 下载失败，退出码: {}", status));
        }
    } else {
        // 优先 curl，其次 wget
        let has_curl = Command::new("curl").arg("--version").output().is_ok();
        if has_curl {
            let status = Command::new("curl")
                .args(["-L", "-o", &dest.to_string_lossy(), url])
                .status()
                .map_err(|e| format!("无法启动 curl 下载: {e}"))?;
            if !status.success() {
                return Err(format!("curl 下载失败，退出码: {}", status));
            }
        } else {
            let status = Command::new("wget")
                .args(["-O", &dest.to_string_lossy(), url])
                .status()
                .map_err(|e| format!("无法启动 wget 下载: {e}。请安装 curl 或 wget",))?;
            if !status.success() {
                return Err(format!("wget 下载失败，退出码: {}", status));
            }
        }
    }

    if !dest.is_file() || dest.metadata().map(|m| m.len()).unwrap_or(0) == 0 {
        return Err("下载的文件为空或不存在".to_string());
    }
    Ok(())
}

/// 解压并提取 ffmpeg 二进制到目标目录
fn extract_ffmpeg(archive: &std::path::Path, bin_dir: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(bin_dir)
        .map_err(|e| format!("创建目录失败: {e}"))?;

    if cfg!(windows) {
        // Windows: 使用 PowerShell Expand-Archive
        let temp_extract = bin_dir.join("_extract");
        if temp_extract.exists() {
            fs::remove_dir_all(&temp_extract).ok();
        }

        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}'",
                    archive.display(),
                    temp_extract.display()
                ),
            ])
            .status()
            .map_err(|e| format!("PowerShell 解压失败: {e}"))?;

        if !status.success() {
            return Err("PowerShell 解压失败".to_string());
        }

        // 查找 ffmpeg.exe
        match find_and_copy_exe(&temp_extract, "ffmpeg.exe", bin_dir) {
            Ok(_) => {}
            Err(e) => return Err(e),
        }

        fs::remove_dir_all(&temp_extract).ok();
    } else if cfg!(target_os = "linux") {
        // Linux: tar.xz
        let status = Command::new("tar")
            .args([
                "-xf",
                &archive.to_string_lossy(),
                "-C",
                &bin_dir.to_string_lossy(),
                "--strip-components=1",
                "--wildcards",
                "*/ffmpeg",
            ])
            .status()
            .map_err(|e| format!("tar 解压失败: {e}"))?;

        if !status.success() {
            // 备选：不带 strip 解压然后手动查找
            return Err("tar 解压失败".to_string());
        }

        // 确保可执行
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let ffmpeg = bin_dir.join("ffmpeg");
            if let Ok(meta) = fs::metadata(&ffmpeg) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&ffmpeg, perms).ok();
            }
        }
    } else {
        // macOS: zip 文件
        let temp_extract = bin_dir.join("_extract");
        if temp_extract.exists() {
            fs::remove_dir_all(&temp_extract).ok();
        }

        let status = Command::new("unzip")
            .args([
                "-o",
                &archive.to_string_lossy(),
                "-d",
                &temp_extract.to_string_lossy(),
            ])
            .status()
            .map_err(|e| format!("unzip 解压失败: {e}"))?;

        if !status.success() {
            return Err("unzip 解压失败".to_string());
        }

        match find_and_copy_exe(&temp_extract, "ffmpeg", bin_dir) {
            Ok(_) => {}
            Err(e) => return Err(e),
        }

        fs::remove_dir_all(&temp_extract).ok();

        // 确保可执行
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let ffmpeg = bin_dir.join("ffmpeg");
            if let Ok(meta) = fs::metadata(&ffmpeg) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&ffmpeg, perms).ok();
            }
        }
    }

    Ok(())
}

/// 递归查找指定可执行文件并复制到目标目录
fn find_and_copy_exe(
    dir: &std::path::Path,
    name: &str,
    dest_dir: &std::path::Path,
) -> Result<(), String> {
    fn walk(dir: &std::path::Path, name: &str) -> Option<PathBuf> {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.file_name().map(|n| n == name).unwrap_or(false) {
                    return Some(path);
                }
                if path.is_dir() {
                    if let Some(found) = walk(&path, name) {
                        return Some(found);
                    }
                }
            }
        }
        None
    }

    let found = walk(dir, name)
        .ok_or_else(|| format!("在解压目录中未找到 {}", name))?;

    let dest = dest_dir.join(name);
    fs::copy(&found, &dest)
        .map_err(|e| format!("复制 {} 失败: {}", dest.display(), e))?;

    Ok(())
}

/// 获取 ffmpeg 下载链接
fn ffmpeg_download_url() -> &'static str {
    if cfg!(windows) {
        "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    } else if cfg!(target_os = "linux") {
        "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
    } else {
        // macOS
        "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip"
    }
}

/// 获取归档文件扩展名
fn archive_ext() -> &'static str {
    if cfg!(windows) {
        "zip"
    } else if cfg!(target_os = "linux") {
        "tar.xz"
    } else {
        "zip"
    }
}

/// 下载并安装 ffmpeg 到内置目录
pub fn download_ffmpeg() -> Result<PathBuf, String> {
    let bin_dir = ffmpeg_bin_dir();
    let url = ffmpeg_download_url();
    let archive_name = format!("ffmpeg.{}", archive_ext());
    let archive_path = bin_dir.join(&archive_name);

    eprintln!("未在系统中检测到 ffmpeg，正在自动下载...");
    eprintln!("下载地址: {url}");
    eprintln!("存放位置: {}", bin_dir.display());

    // 清理旧文件
    if archive_path.exists() {
        fs::remove_file(&archive_path).ok();
    }

    download(url, &archive_path)?;

    eprintln!("下载完成，正在解压...");
    extract_ffmpeg(&archive_path, &bin_dir)?;

    // 清理归档文件
    fs::remove_file(&archive_path).ok();

    let ffmpeg = bundled_ffmpeg_path();
    if !ffmpeg.is_file() {
        return Err(format!("ffmpeg 安装失败，未找到: {}", ffmpeg.display()));
    }

    eprintln!("ffmpeg 已安装到: {}", ffmpeg.display());
    Ok(ffmpeg)
}

/// 确保 ffmpeg 可用（系统或内置），返回 ffmpeg 路径
pub fn ensure_ffmpeg() -> Result<PathBuf, String> {
    if let Some(path) = find_system_ffmpeg() {
        return Ok(path);
    }
    download_ffmpeg()
}
