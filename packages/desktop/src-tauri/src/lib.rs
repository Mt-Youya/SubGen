// 声明子模块，让 Rust 编译器把 commands/ 和 gpu.rs 纳入当前 crate。
// 不声明则这两个目录/文件不会被编译，里面的公开符号也无法被外部引用。
mod commands;
mod gpu;

// mobile_entry_point 宏：在编译 iOS/Android 目标时，把 run() 替换为移动平台
// 所需的入口函数签名（如 `#[no_mangle] pub extern "C" fn ...`）。
// 桌面编译时该宏什么都不做，无副作用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 注册 tauri-plugin-shell：允许 Rust 代码通过 Tauri 执行子进程。
        .plugin(tauri_plugin_shell::init())
        // 注册 tauri-plugin-dialog：提供文件选择、保存对话框等原生弹窗能力。
        .plugin(tauri_plugin_dialog::init())
        // 注册 tauri-plugin-fs：允许 Rust 侧通过 Tauri 安全地读写文件系统。
        .plugin(tauri_plugin_fs::init())
        // generate_handler! 宏要求命令函数的路径能解析到编译期生成的 __cmd__xxx 符号，
        // pub use 重导出不会携带这些宏生成的辅助符号，因此必须使用完整的子模块路径。
        .invoke_handler(tauri::generate_handler![
            // ffmpeg 相关
            commands::ffmpeg_cmd::check_ffmpeg,
            commands::ffmpeg_cmd::download_ffmpeg,
            commands::ffmpeg_cmd::get_ffmpeg_path,
            commands::ffmpeg_cmd::extract_audio,
            // Whisper 模型与依赖检查
            commands::whisper_cmd::check_dependencies,
            commands::whisper_cmd::check_whisper_model,
            commands::whisper_cmd::download_whisper_model,
            commands::whisper_cmd::delete_whisper_model,
            // GPU 检测与加速包管理
            commands::gpu_cmd::detect_gpu,
            commands::gpu_cmd::get_gpu_status,
            commands::gpu_cmd::get_concurrency,
            commands::gpu_cmd::download_gpu_whisper,
            commands::gpu_cmd::install_gpu_archive,
            // 主业务流程与文件工具
            commands::pipeline::generate_subtitles,
            commands::pipeline::reveal_in_finder,
            commands::pipeline::save_srt,
            commands::pipeline::get_file_sizes,
        ])
        // generate_context! 宏读取 tauri.conf.json，把应用元数据嵌入到二进制中。
        .run(tauri::generate_context!())
        // 初始化失败时 panic 并打印原因，便于诊断运行环境异常。
        .expect("error while running tauri application");
}
