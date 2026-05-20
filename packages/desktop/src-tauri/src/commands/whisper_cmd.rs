use std::fs;
use std::io::Write;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

use crate::gpu;
use super::deps::{resolve_whisper, model_path, default_model_path};

/// 一次性检查所有运行时依赖：ffmpeg、whisper 二进制、Whisper 模型、GPU 状态。
/// 供首页 DependencyCheck 组件调用，用户打开应用时可以一眼看到缺少哪些依赖。
#[tauri::command]
pub fn check_dependencies(app: AppHandle) -> serde_json::Value {
    use super::deps::resolve_ffmpeg;

    let ffmpeg_ok = resolve_ffmpeg(&app).is_ok();
    let whisper_ok = resolve_whisper(&app).is_ok();
    // 只要有任意一个模型文件存在就视为"已下载"，
    // 避免用户下载了非默认（small）模型时误报缺失，产生不必要的困惑。
    let any_model = ["base", "small", "medium", "large-v3"]
        .iter()
        .any(|m| model_path(m).exists());
    let default_mp = default_model_path();

    let gpu = gpu::detect_gpu();
    let using_gpu = if cfg!(target_os = "macos") {
        // macOS Metal 由 whisper.cpp 内置支持，无需额外下载，始终视为 GPU 加速可用
        true
    } else {
        // Windows/Linux：需要 GPU 存在且已下载对应的 GPU 版二进制
        gpu.available && gpu::gpu_bin_installed(gpu.gpu_type)
    };

    serde_json::json!({
        "ffmpeg": ffmpeg_ok,
        "whisper": whisper_ok,
        "model": any_model,
        "model_path": default_mp.to_string_lossy(),
        "gpu_type": gpu::gpu_variant_label(gpu.gpu_type),
        "gpu_available": gpu.available,
        "using_gpu": using_gpu,
    })
}

/// 检查指定 Whisper 模型是否已下载，并返回所有模型的状态列表。
/// model 参数为 None 时默认检查 "small" 模型。
#[tauri::command]
pub fn check_whisper_model(app: AppHandle, model: Option<String>) -> serde_json::Value {
    let whisper_ok = resolve_whisper(&app).is_ok();
    let name = model.as_deref().unwrap_or("small");
    let mp = model_path(name);
    // 返回所有支持模型的下载状态，供前端模型选择器展示
    let models = ["base", "small", "medium", "large-v3"].iter().map(|m| {
        let p = model_path(m);
        serde_json::json!({
            "name": m,
            "downloaded": p.exists(),
            "path": p.to_string_lossy()
        })
    }).collect::<Vec<_>>();
    serde_json::json!({
        "whisper": whisper_ok,
        "model": mp.exists(),
        "model_path": mp.to_string_lossy(),
        "models": models,
    })
}

/// 从 hf-mirror 下载指定 GGML 格式 Whisper 模型到 ~/.subgen_cache/models/。
///
/// 使用 hf-mirror.com 而非 huggingface.co 直连，是因为国内访问 HuggingFace 经常超时；
/// hf-mirror 是国内可稳定访问的镜像站，下载速度更快。
///
/// 下载时先写入 .tmp 临时文件，完成后原子性重命名，
/// 避免下载中途中断导致存留损坏的模型文件。
#[tauri::command]
pub async fn download_whisper_model(
    app: AppHandle,
    model: Option<String>,
) -> Result<String, String> {
    let name = model.as_deref().unwrap_or("small").to_string();
    let target_path = model_path(&name);

    // 已存在则直接返回，不重复下载
    if target_path.exists() {
        return Ok(target_path.to_string_lossy().to_string());
    }

    // 确保 models 目录存在
    fs::create_dir_all(target_path.parent().unwrap())
        .map_err(|e| format!("创建模型目录失败: {e}"))?;

    let url = format!(
        "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin"
    );

    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await.map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    // 先写到 .tmp 文件，完成后再重命名，防止中途中断留下残缺文件
    let tmp_path = target_path.with_extension("bin.tmp");
    let mut file = fs::File::create(&tmp_path).map_err(|e| format!("创建文件失败: {e}"))?;
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("写入失败: {e}"))?;
        downloaded += chunk.len() as u64;
        let ratio = if total > 0 { downloaded as f64 / total as f64 } else { 0.0 };
        // 每个 chunk 都发送进度事件，前端据此更新进度条
        app.emit("model-download-progress", serde_json::json!({
            "model": name,
            "ratio": ratio,
        })).ok();
    }

    // 确保文件句柄已关闭再重命名（Windows 上未关闭的句柄会阻止 rename）
    drop(file);
    fs::rename(&tmp_path, &target_path).map_err(|e| format!("重命名失败: {e}"))?;
    // 下载完成发送 ratio=1.0 让前端标记完成状态
    app.emit("model-download-progress", serde_json::json!({
        "model": name,
        "ratio": 1.0,
    })).ok();
    Ok(target_path.to_string_lossy().to_string())
}

/// 返回模型目录路径，供前端打开文件夹。
#[tauri::command]
pub fn get_models_dir() -> String {
    super::utils::dirs_cache().join("models").to_string_lossy().to_string()
}

/// 删除已下载的 Whisper 模型文件，释放磁盘空间。
/// 文件不存在时静默成功，避免前端重复点击时报错。
#[tauri::command]
pub fn delete_whisper_model(model: String) -> Result<(), String> {
    let path = model_path(&model);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
}
