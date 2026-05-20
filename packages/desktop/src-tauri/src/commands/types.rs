use serde::{Deserialize, Serialize};

/// 音频提取选项（前端传入）
#[derive(Debug, Serialize, Deserialize)]
pub struct ExtractOptions {
    /// 输入文件路径列表，支持同时提取多个文件
    pub inputs: Vec<String>,
    /// 输出目录
    pub output_dir: String,
    /// 限制提取时长（秒），0 表示提取完整音频
    pub duration: f64,
}

/// 单个文件的提取结果
#[derive(Debug, Serialize, Clone)]
pub struct ExtractFileResult {
    /// 原始输入文件路径
    pub input: String,
    /// 输出 WAV 文件路径
    pub output: String,
    /// 输出文件大小（字节），失败时为 None
    pub output_size: Option<u64>,
    /// 提取耗时（秒），失败时为 None
    pub elapsed_secs: Option<f64>,
    /// 错误信息，成功时为 None
    pub error: Option<String>,
}

/// 批量提取的整体结果
#[derive(Debug, Serialize)]
pub struct ExtractResult {
    pub files: Vec<ExtractFileResult>,
}

/// 字幕片段（时间轴 + 文本）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Segment {
    /// 开始时间（秒）
    pub start: f64,
    /// 结束时间（秒）
    pub end: f64,
    /// 字幕文本
    pub text: String,
}

/// 字幕生成完整选项（前端传入）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GenerateOptions {
    /// 输入媒体文件路径
    pub input: String,
    /// 输出目录
    pub output_dir: String,
    /// 源语言代码（如 "zh"、"en"）
    pub source_lang: String,
    /// 目标翻译语言代码
    pub target_lang: String,
    /// 是否生成双语字幕
    pub bilingual: bool,
    /// ASR 提供商："local-whisper" | "groq" | "siliconflow"
    pub asr_provider: String,
    /// 翻译提供商："deepl" | "tencent"
    pub translate_provider: String,
    pub groq_api_key: Option<String>,
    pub siliconflow_api_key: Option<String>,
    pub deepl_api_key: Option<String>,
    pub tencent_secret_id: Option<String>,
    pub tencent_secret_key: Option<String>,
    /// 音频分片时长（秒），默认 240s，范围 60~600
    pub chunk_seconds: Option<u32>,
    /// 是否跳过缓存（true = 强制重新转录/翻译）
    pub skip_cache: Option<bool>,
    /// 使用的 Whisper 模型名称（"small"/"medium" 等）
    pub whisper_model: Option<String>,
}

/// 字幕生成结果（返回给前端）
#[derive(Debug, Serialize)]
pub struct GenerateResult {
    /// 原始转录 Segment 列表
    pub segments: Vec<Segment>,
    /// 翻译后的 Segment 列表（与 segments 一一对应）
    pub translated: Vec<Segment>,
    /// 原文 SRT 字符串
    pub original_srt: String,
    /// 译文 SRT 字符串
    pub translated_srt: String,
    /// 双语 SRT 字符串（bilingual=true 时才有）
    pub bilingual_srt: Option<String>,
    /// 原文 SRT 建议保存路径
    pub original_path: String,
    /// 译文 SRT 建议保存路径
    pub translated_path: String,
    /// 双语 SRT 建议保存路径
    pub bilingual_path: Option<String>,
}

/// 实时进度事件负载（通过 Tauri event 推给前端）
#[derive(Debug, Serialize, Clone)]
pub struct ProgressPayload {
    /// 对应的输入文件路径，用于前端多任务路由
    pub input: String,
    /// 阶段标识："extracting" | "loading_model" | "transcribing" | "translating" | "saving" | "done"
    pub stage: String,
    /// 进度比例 [0.0, 1.0]
    pub ratio: f64,
    /// 人类可读的进度描述
    pub message: String,
    /// 当前阶段已用秒数（进行中时更新）
    pub elapsed_secs: Option<f64>,
    /// 该阶段完成时的总耗时（仅阶段完成时设置，方便前端展示）
    pub stage_elapsed_secs: Option<f64>,
}

/// Whisper API（Groq / SiliconFlow）返回的单个片段结构
#[derive(Debug, Deserialize)]
pub struct ApiSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Whisper API 响应外层结构
#[derive(Debug, Deserialize)]
pub struct WhisperResponse {
    pub segments: Option<Vec<ApiSegment>>,
}
