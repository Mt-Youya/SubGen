// 子模块声明：Rust 编译器按此列表找到各源文件并编译
pub mod asr;
pub mod deps;
pub mod ffmpeg_cmd;
pub mod gpu_cmd;
pub mod pipeline;
pub mod translation;
pub mod types;
pub mod utils;
pub mod whisper_cmd;

// dirs_cache 被 gpu.rs（crate 根同级模块）通过 super::commands::dirs_cache() 调用，
// 需要在此处重导出为 pub，使外部路径可见。
// 其余命令由 lib.rs 通过 commands::子模块::函数名 的完整路径直接引用，无需重导出。
pub use utils::dirs_cache;
