mod ffmpeg;

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const DEFAULT_EXT: &[&str] = &[
    "mp4", "mkv", "ts", "m2ts", "webm", "avi", "mov", "wmv", "flv",
];

fn print_usage() {
    eprintln!(
        "subextract v0.1.0 — 从视频提取 16kHz 单声道 WAV 音频\n\
         \n\
         用法: subextract <输入...> [选项]\n\
         \n\
         输入:  视频文件路径 / 多个文件 / 文件夹\n\
         \n\
         选项:\n  \
           -o, --output <dir>      输出目录 [默认: output]\n  \
           -d, --duration <秒>     提取时长，0=完整 [默认: 120]\n  \
           -r, --recursive         递归搜索子文件夹\n  \
           -j, --jobs <N>          并行数 [默认: 2]\n  \
           --ext <ext1,ext2,...>   扩展名过滤 [默认: mp4,mkv,...]\n  \
           -h, --help              显示帮助"
    );
}

fn has_ext(path: &Path, ext_filter: &[String]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| ext_filter.iter().any(|f| f.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

fn scan_dir(dir: &Path, ext_filter: &[String], recursive: bool, files: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && has_ext(&path, ext_filter) {
                files.push(path);
            } else if recursive && path.is_dir() {
                scan_dir(&path, ext_filter, recursive, files);
            }
        }
    }
}

fn collect_files(inputs: &[String], ext_filter: &[String], recursive: bool) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for input in inputs {
        let path = Path::new(input);
        if !path.exists() {
            eprintln!("[跳过] 路径不存在: {}", input);
            continue;
        }
        if path.is_file() {
            if has_ext(path, ext_filter) {
                files.push(path.to_path_buf());
            } else {
                eprintln!("[跳过] 格式不支持: {}", path.display());
            }
        } else if path.is_dir() {
            scan_dir(path, ext_filter, recursive, &mut files);
        }
    }
    files.sort();
    files.dedup();
    files
}

fn extract_audio(
    ffmpeg_path: &Path,
    input: &Path,
    output_dir: &Path,
    duration: f64,
) -> Result<PathBuf, String> {
    fs::create_dir_all(output_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;

    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio");
    let output = output_dir.join(format!("{}.wav", stem));

    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(input)
        .arg("-vn")
        .arg("-acodec")
        .arg("pcm_s16le")
        .arg("-ar")
        .arg("16000")
        .arg("-ac")
        .arg("1");

    if duration > 0.0 {
        cmd.arg("-t").arg(duration.to_string());
    }

    cmd.arg(&output);

    let status = cmd
        .status()
        .map_err(|e| format!("ffmpeg 执行失败: {e}"))?;

    if status.success() {
        Ok(output)
    } else {
        Err(format!("ffmpeg 返回错误码: {}", status))
    }
}

fn main() {
    // 确保 ffmpeg 可用（系统已安装或自动下载）
    let ffmpeg_path = match ffmpeg::ensure_ffmpeg() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ffmpeg 不可用: {e}");
            exit(1);
        }
    };

    let args: Vec<String> = env::args().collect();

    let mut inputs: Vec<String> = Vec::new();
    let mut output = String::from("output");
    let mut duration: f64 = 120.0;
    let mut recursive = false;
    let mut jobs: usize = 2;
    let mut ext_str = String::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => {
                print_usage();
                return;
            }
            "-o" | "--output" => {
                i += 1;
                if i < args.len() {
                    output = args[i].clone();
                }
            }
            "-d" | "--duration" => {
                i += 1;
                if i < args.len() {
                    duration = args[i].parse().unwrap_or(120.0);
                }
            }
            "-r" | "--recursive" => recursive = true,
            "-j" | "--jobs" => {
                i += 1;
                if i < args.len() {
                    jobs = args[i].parse().unwrap_or(2);
                }
            }
            "--ext" => {
                i += 1;
                if i < args.len() {
                    ext_str = args[i].clone();
                }
            }
            other => {
                if !other.starts_with('-') {
                    inputs.push(other.to_string());
                }
            }
        }
        i += 1;
    }

    if inputs.is_empty() {
        print_usage();
        exit(1);
    }

    let ext_filter: Vec<String> = if ext_str.is_empty() {
        DEFAULT_EXT.iter().map(|s| s.to_string()).collect()
    } else {
        ext_str.split(',').map(|s| s.trim().to_lowercase()).collect()
    };

    let files = collect_files(&inputs, &ext_filter, recursive);

    if files.is_empty() {
        eprintln!("未找到匹配的视频文件。");
        exit(1);
    }

    let output_dir = Path::new(&output);
    let total = files.len();
    let jobs = jobs.max(1);

    println!("找到 {} 个视频文件", total);
    if duration > 0.0 {
        println!(
            "提取时长: {:.0} 秒（前 {:.1} 分钟）",
            duration,
            duration / 60.0
        );
    } else {
        println!("提取时长: 完整音频");
    }
    println!("输出目录: {}", output_dir.display());
    println!("并行任务: {}", jobs);
    println!("---");

    let done = AtomicUsize::new(0);
    let errors = Mutex::new(Vec::new());

    std::thread::scope(|s| {
        let handles: Vec<_> = (0..jobs)
            .map(|_| {
                s.spawn(|| loop {
                    let idx = done.fetch_add(1, Ordering::SeqCst);
                    if idx >= total {
                        break;
                    }
                    let input = &files[idx];
                    let name = input
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("?");

                    let display = if name.len() > 50 { &name[..50] } else { name };
                    print!("\r[{}/{}] {} ...", idx + 1, total, display);
                    std::io::stdout().flush().ok();

                    match extract_audio(&ffmpeg_path, input, output_dir, duration) {
                        Ok(out) => {
                            println!(
                                "\r[{}/{}] ✓ {}",
                                idx + 1,
                                total,
                                out.file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or("?")
                            );
                        }
                        Err(e) => {
                            println!("\r[{}/{}] ✗ {} — {}", idx + 1, total, name, e);
                            errors.lock().unwrap().push((input.clone(), e));
                        }
                    }
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }
    });

    let errs = errors.lock().unwrap();
    println!("\n---");
    println!("完成: {}/{} 成功", total - errs.len(), total);
    if !errs.is_empty() {
        eprintln!("{} 个失败:", errs.len());
        for (path, msg) in errs.iter() {
            eprintln!("  - {}: {}", path.display(), msg);
        }
    }
}
