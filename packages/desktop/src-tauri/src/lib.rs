mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::extract_audio,
            commands::generate_subtitles,
            commands::get_ffmpeg_path,
            commands::save_srt,
            commands::reveal_in_finder,
            commands::check_ffmpeg,
            commands::download_ffmpeg,
            commands::check_whisper_model,
            commands::download_whisper_model,
            commands::delete_whisper_model,
            commands::check_dependencies,
            commands::get_file_sizes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
