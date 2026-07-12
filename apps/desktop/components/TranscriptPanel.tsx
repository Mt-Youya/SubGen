"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── 图标 ──────────────────────────────────────────────────
function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

// ── 日志面板 ──────────────────────────────────────────────
interface LogEntry { time: string; message: string; stage?: string }
function LogPanel({ logs, collapsed, onToggle }: { logs: LogEntry[]; collapsed: boolean; onToggle: () => void }) {
  if (logs.length === 0) return null;
  const stageLabels: Record<string, string> = {
    extracting: "提取音频", loading_model: "加载模型", transcribing: "语音识别", saving: "保存", done: "完成",
  };
  return (
    <div className="rounded-md overflow-hidden" style={{ border: "0.5px solid var(--color-border-subtle)" }}>
      <button onClick={onToggle}
        className="w-full px-3 py-2 flex items-center justify-between text-left"
        style={{ background: "var(--color-surface-2)", borderBottom: collapsed ? "none" : "0.5px solid var(--color-border-subtle)" }}>
        <span className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>日志</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>{logs.length} 条</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
            style={{ color: "var(--color-text-tertiary)", transform: collapsed ? "rotate(0)" : "rotate(180deg)", transition: "transform 0.15s" }}>
            <path d="M2 3l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </button>
      {!collapsed && (
        <div className="overflow-y-auto" style={{ maxHeight: "160px", background: "var(--color-surface-1)" }}>
          {logs.map((entry, i) => (
            <div key={i} className="px-3 py-1.5 flex gap-2 text-xs"
              style={{ borderBottom: i < logs.length - 1 ? "0.5px solid var(--color-border-subtle)" : "none" }}>
              <span className="shrink-0 tabular-nums" style={{ color: "var(--color-text-tertiary)", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>{entry.time}</span>
              {entry.stage && (
                <span className="shrink-0 px-1 rounded text-[10px]"
                  style={{
                    background: entry.stage === "transcribing" ? "oklch(65% 0.15 260 / 12%)" :
                      entry.stage === "done" ? "var(--color-accent-muted)" : "var(--color-surface-3)",
                    color: entry.stage === "transcribing" ? "oklch(65% 0.15 260)" :
                      entry.stage === "done" ? "var(--color-accent)" : "var(--color-text-tertiary)",
                  }}>
                  {stageLabels[entry.stage] ?? entry.stage}
                </span>
              )}
              <span className="flex-1 min-w-0 truncate" style={{ color: "var(--color-text-primary)" }}>{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 字幕预览 ──────────────────────────────────────────────
function SubtitlePreview({ segments }: { segments: Segment[] }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div className="rounded-md overflow-hidden" style={{ border: "0.5px solid var(--color-border-subtle)" }}>
      <div className="px-4 py-2.5 flex items-center cursor-pointer select-none"
        style={{ background: "var(--color-surface-2)", borderBottom: collapsed ? "none" : "0.5px solid var(--color-border-subtle)" }}
        onClick={() => setCollapsed(c => !c)}>
        <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>转录文本</span>
        <span className="text-xs mx-2" style={{ color: "var(--color-text-tertiary)" }}>{segments.length} 条</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="ml-auto"
          style={{ color: "var(--color-text-tertiary)", transform: collapsed ? "rotate(0)" : "rotate(180deg)", transition: "transform 0.2s" }}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      {!collapsed && (
        <div className="overflow-y-auto divide-y" style={{ maxHeight: "220px", background: "var(--color-surface-1)", borderColor: "var(--color-border-subtle)" } as React.CSSProperties}>
          {segments.slice(0, 20).map((seg, i) => (
            <div key={i} className="px-4 py-2.5 flex gap-3">
              <span className="text-xs tabular-nums shrink-0 pt-0.5" style={{ color: "var(--color-text-tertiary)", fontFamily: "JetBrains Mono, monospace" }}>{i + 1}</span>
              <p className="text-sm" style={{ color: "var(--color-text-primary)" }}>{seg.text}</p>
            </div>
          ))}
          {segments.length > 20 && (
            <div className="px-4 py-2.5 text-xs text-center" style={{ color: "var(--color-text-tertiary)" }}>
              ··· 剩余 {segments.length - 20} 条
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type AsrProvider = "groq" | "siliconflow" | "local-whisper";
type WhisperModel = "base" | "small" | "medium" | "large-v3";

interface ProgressPayload { stage: string; ratio: number; message: string; elapsed_secs?: number; stage_elapsed_secs?: number }

const PIPELINE_STEPS = [
  { key: "extracting",   label: "提取音频", icon: "⚙" },
  { key: "transcribing", label: "语音识别", icon: "◎" },
  { key: "done",         label: "完成",     icon: "✓" },
] as const;

function stageToStepIdx(stage: string): number {
  if (stage === "done") return 2;
  if (stage === "transcribing") return 1;
  if (stage === "extracting" || stage === "loading_model") return 0;
  return 0;
}

interface Segment { start: number; end: number; text: string }
interface TranscribeResult {
  segments: Segment[];
  originalSrt: string;
  originalPath: string;
}

interface Settings {
  asrProvider: AsrProvider;
  groqApiKey: string;
  siliconflowApiKey: string;
  chunkSeconds: number;
  skipCache: boolean;
  whisperModel: WhisperModel;
}

const DEFAULT_SETTINGS: Settings = {
  asrProvider: "local-whisper",
  groqApiKey: "",
  siliconflowApiKey: "",
  chunkSeconds: 240,
  skipCache: false,
  whisperModel: "small",
};

const WHISPER_MODELS: { name: WhisperModel; label: string; size: string; desc: string }[] = [
  { name: "base",     label: "Base",     size: "142MB", desc: "速度最快，适合简单内容" },
  { name: "small",    label: "Small",    size: "466MB", desc: "推荐，速度与精度平衡" },
  { name: "medium",   label: "Medium",   size: "1.5GB", desc: "高精度，适合复杂语音" },
  { name: "large-v3", label: "Large v3", size: "3.1GB", desc: "最高精度，需要更多内存" },
];

const SOURCE_LANGS = [
  { code: "auto", label: "🌐 自动检测" },
  { code: "zh",   label: "🇨🇳 中文简体" },
  { code: "zh-TW",label: "🇹🇼 中文繁体" },
  { code: "en",   label: "🇺🇸 英语" },
  { code: "ja",   label: "🇯🇵 日语" },
  { code: "ko",   label: "🇰🇷 韩语" },
  { code: "fr",   label: "🇫🇷 法语" },
  { code: "de",   label: "🇩🇪 德语" },
  { code: "es",   label: "🇪🇸 西班牙语" },
  { code: "it",   label: "🇮🇹 意大利语" },
  { code: "pt",   label: "🇵🇹 葡萄牙语" },
  { code: "ru",   label: "🇷🇺 俄语" },
  { code: "tr",   label: "🇹🇷 土耳其语" },
  { code: "vi",   label: "🇻🇳 越南语" },
  { code: "id",   label: "🇮🇩 印尼语" },
  { code: "th",   label: "🇹🇭 泰语" },
  { code: "ms",   label: "🇲🇾 马来语" },
  { code: "ar",   label: "🇸🇦 阿拉伯语" },
  { code: "hi",   label: "🇮🇳 印地语" },
];

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function settingsComplete(s: Settings, modelReady: boolean, downloadedModels?: Set<WhisperModel>): boolean {
  if (s.asrProvider === "local-whisper") {
    return downloadedModels ? downloadedModels.has(s.whisperModel) : modelReady;
  }
  return s.asrProvider === "groq" ? !!s.groqApiKey.trim() : !!s.siliconflowApiKey.trim();
}

function toCamelResult(raw: Record<string, unknown>): TranscribeResult {
  return {
    segments: (raw.segments as Segment[]) ?? [],
    originalSrt: String(raw.original_srt ?? ""),
    originalPath: String(raw.original_path ?? ""),
  };
}

function CustomSelect<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { code: T; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = options.find(o => o.code === value)?.label ?? value;
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  return (
    <div ref={ref} className="relative w-full">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between rounded-md px-3 py-2 text-sm text-left"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }}>
        <span>{label}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          style={{ color: "var(--color-text-tertiary)", transform: open ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.15s" }}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md overflow-hidden py-1"
          style={{ background: "var(--color-surface-3)", border: "1px solid var(--color-border)", boxShadow: "0 8px 24px oklch(0% 0 0 / 40%)" }}>
          {options.map(o => (
            <button key={o.code} type="button" onClick={() => { onChange(o.code); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm transition-colors"
              style={{ color: o.code === value ? "var(--color-accent)" : "var(--color-text-primary)", background: o.code === value ? "var(--color-accent-muted)" : "transparent" }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelSelect({ value, onChange, downloadedModels, downloadingModel, downloadProgress, onDownload, onDelete }: {
  value: WhisperModel; onChange: (v: WhisperModel) => void;
  downloadedModels: Set<WhisperModel>; downloadingModel: WhisperModel | null;
  downloadProgress: Record<string, number>;
  onDownload: (m: WhisperModel) => void; onDelete: (m: WhisperModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = WHISPER_MODELS.find(m => m.name === value);
  const downloadingInfo = downloadingModel ? WHISPER_MODELS.find(m => m.name === downloadingModel) : null;
  const downloadingPct = downloadingModel ? Math.round((downloadProgress[downloadingModel] ?? 0) * 100) : 0;
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  return (
    <div ref={ref} className="relative w-full">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full relative overflow-hidden flex items-center justify-between rounded-md px-3 py-2 text-sm text-left"
        style={{ background: "var(--color-surface-2)", border: `1px solid ${downloadingInfo && !open ? "var(--color-accent)" : "var(--color-border)"}`, color: "var(--color-text-primary)" }}>
        {downloadingInfo && !open && (
          <div className="absolute inset-0 pointer-events-none" style={{ transform: `scaleX(${downloadingPct / 100})`, transformOrigin: "left", transition: "transform 0.3s ease-out", background: "var(--color-accent)" }} />
        )}
        <span className="relative flex items-center gap-2">
          <span>{selected?.label}</span>
          <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>{selected?.size}</span>
          {downloadedModels.has(value) && <span className="text-xs" style={{ color: "var(--color-success)" }}>✓</span>}
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          style={{ color: "var(--color-text-tertiary)", transform: open ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.15s", flexShrink: 0 }}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md"
          style={{ background: "var(--color-surface-3)", border: "1px solid var(--color-border)", boxShadow: "0 8px 24px oklch(0% 0 0 / 40%)", overflow: "hidden" }}>
          <div className="flex items-center justify-between px-3 py-1.5" style={{ borderBottom: "0.5px solid var(--color-border)" }}>
            <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>Whisper 模型</span>
            <button type="button"
              onClick={async e => {
                e.stopPropagation();
                const { invoke } = await import("@tauri-apps/api/core");
                const dir = await invoke<string>("get_models_dir");
                await invoke("reveal_in_finder", { path: dir });
              }}
              className="rounded px-1.5 py-0.5 text-xs" style={{ color: "var(--color-accent)" }}>打开目录</button>
          </div>
          {WHISPER_MODELS.map((m) => {
            const downloaded = downloadedModels.has(m.name);
            const isDownloading = downloadingModel === m.name;
            const pct = Math.round((downloadProgress[m.name] ?? 0) * 100);
            const isSelected = m.name === value;
            return (
              <div key={m.name} className="relative">
                {isDownloading && <div className="absolute inset-0 pointer-events-none transition-all duration-300" style={{ width: `${pct}%`, background: "var(--color-accent-muted)" }} />}
                <div className="relative flex items-center justify-between px-3 py-2">
                  <button type="button" onClick={() => { if (downloaded) { onChange(m.name); setOpen(false); } }}
                    className="flex flex-col gap-0.5 flex-1 text-left min-w-0" style={{ cursor: downloaded ? "pointer" : "default" }}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium" style={{ color: downloaded ? (isSelected ? "var(--color-accent)" : "var(--color-text-primary)") : "var(--color-text-tertiary)" }}>{m.label}</span>
                      <span className="text-xs" style={{ color: "var(--color-text-tertiary)", fontFamily: "JetBrains Mono, monospace" }}>{m.size}</span>
                    </div>
                    <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>{m.desc}</span>
                  </button>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    {downloaded && !isDownloading && (
                      <>
                        <span className="text-xs" style={{ color: "var(--color-success)" }}>✓</span>
                        <button type="button" onClick={e => { e.stopPropagation(); onDelete(m.name); }}
                          className="p-1 rounded transition-opacity opacity-40 hover:opacity-100" style={{ color: "var(--color-text-tertiary)" }} title="删除模型">
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3h8M5 3V2h2v1M4.5 3l.5 6h2l.5-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </button>
                      </>
                    )}
                    {!downloaded && (
                      <button type="button" onClick={e => { e.stopPropagation(); onDownload(m.name); }}
                        disabled={!!downloadingModel}
                        className="rounded-full px-2.5 py-0.5 text-xs font-medium transition-opacity disabled:opacity-40"
                        style={{ background: "var(--color-accent)", color: "white" }}>{isDownloading ? "下载中" : "下载"}</button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatBytes(b: number) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + " GB";
  if (b >= 1048576)    return (b / 1048576).toFixed(1) + " MB";
  if (b >= 1024)       return (b / 1024).toFixed(0) + " KB";
  return b + " B";
}

function SettingGroup({ label }: { label: string }) {
  return <p className="text-sm font-semibold pt-1" style={{ color: "var(--color-text-secondary)" }}>{label}</p>;
}
function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-xs text-right" style={{ color: "var(--color-text-tertiary)" }}>{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

interface FileTask {
  path: string; size?: number;
  status: "pending" | "processing" | "done" | "error";
  progress: ProgressPayload; displayRatio: number;
  result: TranscribeResult | null; error: string;
  totalElapsed?: number; stageTiming: Record<string, number>; logs: LogEntry[];
}

const AUDIO_EXTS = ["wav", "mp3", "m4a", "aac", "flac", "ogg", "wma", "opus"];

export function TranscriptPanel() {
  const [outputDir, setOutputDir] = useState("");
  const [sourceLang, setSourceLang] = useState("ja");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isTauri, setIsTauri] = useState(false);
  const [tasks, setTasks] = useState<FileTask[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const [isRunning, setIsRunning] = useState(false);
  const targetRatioRef = useRef<Record<string, number>>({});
  const rafRef = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [downloadingModel, setDownloadingModel] = useState<WhisperModel | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [downloadedModels, setDownloadedModels] = useState<Set<WhisperModel>>(new Set());
  const [gpuStatus, setGpuStatus] = useState<{
    detected: { gpu_type: string; name: string; available: boolean };
    active_variant: string; active_is_gpu: boolean;
    recommended: string; recommended_downloaded: boolean; download_url: string;
  } | null>(null);
  const [gpuDownloading, setGpuDownloading] = useState(false);
  const [concurrency, setConcurrency] = useState(1);
  const [queueStartTime, setQueueStartTime] = useState<number | null>(null);
  const [queueElapsed, setQueueElapsed] = useState<number | null>(null);
  const initialized = useRef(false);

  const whisperModelRef = useRef(settings.whisperModel);
  useEffect(() => { whisperModelRef.current = settings.whisperModel; }, [settings.whisperModel]);

  const checkModel = useCallback(async () => {
    if (!hasTauriRuntime()) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<{ whisper: boolean; model: boolean; models: { name: WhisperModel; downloaded: boolean }[] }>(
      "check_whisper_model", { model: whisperModelRef.current }
    ).catch(() => ({ whisper: false, model: false, models: [] }));
    setModelReady(info.model && info.whisper);
    setDownloadedModels(new Set(info.models.filter(m => m.downloaded).map(m => m.name)));
  }, []);

  const downloadModel = useCallback(async (modelName: WhisperModel) => {
    setDownloadingModel(modelName);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("download_whisper_model", { model: modelName });
      setDownloadedModels(prev => new Set([...prev, modelName]));
      if (modelName === settings.whisperModel) setModelReady(true);
    } catch (e) { alert(`模型下载失败: ${e}`); }
    finally { setDownloadingModel(null); setDownloadProgress(prev => { const next = { ...prev }; delete next[modelName]; return next; }); }
  }, [settings.whisperModel]);

  const deleteModel = useCallback(async (modelName: WhisperModel) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_whisper_model", { model: modelName });
      setDownloadedModels(prev => { const next = new Set(prev); next.delete(modelName); return next; });
      if (modelName === settings.whisperModel) setModelReady(false);
    } catch (e) { alert(`删除失败: ${e}`); }
  }, [settings.whisperModel]);

  const downloadGpuWhisper = useCallback(async () => {
    setGpuDownloading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("download_gpu_whisper");
      const s = await invoke<typeof gpuStatus>("get_gpu_status"); setGpuStatus(s);
    } catch (e) { alert(`GPU 加速版下载失败: ${e}`); }
    finally { setGpuDownloading(false); }
  }, []);

  // 初始化
  useEffect(() => {
    setIsTauri(hasTauriRuntime());
    const saved = window.localStorage.getItem("subgen-desktop-settings");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSettings({
          asrProvider: parsed.asrProvider ?? DEFAULT_SETTINGS.asrProvider,
          groqApiKey: parsed.groqApiKey ?? "", siliconflowApiKey: parsed.siliconflowApiKey ?? "",
          chunkSeconds: parsed.chunkSeconds ?? 240, skipCache: parsed.skipCache ?? false,
          whisperModel: parsed.whisperModel ?? "small",
        });
      } catch { window.localStorage.removeItem("subgen-desktop-settings"); }
    }
    initialized.current = true;
  }, []);
  useEffect(() => { if (isTauri) checkModel(); }, [isTauri, checkModel]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isTauri) checkModel(); }, [settings.whisperModel]);

  // 持久化设置（与字幕生成 Tab 共享）
  useEffect(() => {
    if (!initialized.current) return;
    const saved = window.localStorage.getItem("subgen-desktop-settings");
    const base = saved ? JSON.parse(saved) : {};
    window.localStorage.setItem("subgen-desktop-settings", JSON.stringify({ ...base, ...settings }));
  }, [settings]);

  // GPU 状态 + 并发数
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<typeof gpuStatus>("get_gpu_status").then(s => setGpuStatus(s)).catch(() => null);
      invoke<{ concurrency: number }>("get_concurrency", { model: settings.whisperModel })
        .then(r => setConcurrency(r.concurrency)).catch(() => null);
    });
  }, [isTauri]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<{ concurrency: number }>("get_concurrency", { model: settings.whisperModel })
        .then(r => setConcurrency(r.concurrency)).catch(() => null);
    });
  }, [isTauri, settings.whisperModel]);

  // 进度事件
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined; let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<ProgressPayload & { input: string }>("subtitle-progress", e => {
        const path = e.payload.input;
        const isStageDone = e.payload.stage_elapsed_secs != null;
        if (!isStageDone) targetRatioRef.current[path] = e.payload.ratio;
        const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        const logEntry: LogEntry = { time: now, message: e.payload.message, stage: e.payload.stage };
        setTasks(prev => prev.map(t => {
          if (t.path !== path) return t;
          let stageTiming = t.stageTiming;
          const elapsed = e.payload.stage_elapsed_secs;
          if (isStageDone && elapsed != null) stageTiming = { ...stageTiming, [e.payload.stage]: elapsed as number };
          return { ...t, progress: e.payload, stageTiming, logs: [...t.logs, logEntry] };
        }));
      })).then(u => { if (disposed) u(); else off = u; }).catch(() => {});
    return () => { disposed = true; off?.(); };
  }, [isTauri]);

  // 模型下载进度
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined; let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<{ model: string; ratio: number }>("model-download-progress", e => {
        setDownloadProgress(prev => ({ ...prev, [e.payload.model]: e.payload.ratio }));
      })).then(u => { if (disposed) u(); else off = u; }).catch(() => {});
    return () => { disposed = true; off?.(); };
  }, [isTauri]);

  // GPU 下载
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined; let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<{ variant: string; ratio: number; message: string }>("gpu-download-progress", e => {
        if (e.payload.ratio >= 1.0) { setGpuDownloading(false); import("@tauri-apps/api/core").then(({ invoke }) => invoke<typeof gpuStatus>("get_gpu_status").then(s => setGpuStatus(s))); }
      })).then(u => { if (disposed) u(); else off = u; }).catch(() => {});
    return () => { disposed = true; off?.(); };
  }, [isTauri]);

  // 进度动画
  useEffect(() => {
    if (!isRunning) { cancelAnimationFrame(rafRef.current); return; }
    const animate = () => {
      setTasks(prev => prev.map(t => {
        const target = targetRatioRef.current[t.path] ?? t.displayRatio;
        const diff = target - t.displayRatio;
        if (Math.abs(diff) < 0.002) return t.displayRatio === target ? t : { ...t, displayRatio: target };
        return { ...t, displayRatio: t.displayRatio + diff * 0.08 };
      }));
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isRunning]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings(p => ({ ...p, [k]: v }));

  const addPaths = useCallback(async (newPaths: string[]) => {
    if (newPaths.length === 0) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const sizes = await invoke<number[]>("get_file_sizes", { paths: newPaths }).catch(() => newPaths.map(() => 0));
    setTasks(newPaths.map((p, i) => ({
      path: p, size: sizes[i] ?? 0, status: "pending" as const,
      progress: { stage: "", ratio: 0, message: "" },
      displayRatio: 0, result: null, error: "", stageTiming: {}, logs: [] as LogEntry[],
    })));
    setQueueElapsed(null); setQueueStartTime(null);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); dragCounterRef.current = 0; setIsDragging(false);
    if (isRunning) return;
    const paths: string[] = [];
    for (const item of Array.from(e.dataTransfer.items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f && (f as unknown as { path?: string }).path) paths.push((f as unknown as { path: string }).path);
      }
    }
    if (paths.length > 0) await addPaths(paths);
  }, [isRunning, addPaths]);

  const pickInputs = useCallback(async () => {
    if (!isTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ multiple: true, filters: [{ name: "音频文件", extensions: AUDIO_EXTS }] });
    if (!sel) return;
    await addPaths(Array.isArray(sel) ? sel : [sel]);
  }, [isTauri, addPaths]);

  const pickFolders = useCallback(async () => {
    if (!isTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: true });
    if (!sel) return;
    const dirs = Array.isArray(sel) ? sel : [sel];
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    const extSet = new Set(AUDIO_EXTS);
    async function collectFiles(dir: string): Promise<string[]> {
      try {
        const entries = await readDir(dir); const results: string[] = [];
        for (const entry of entries) {
          const fullPath = await join(dir, entry.name);
          if (entry.isDirectory) results.push(...await collectFiles(fullPath));
          else if (entry.isFile) { const ext = entry.name.split(".").pop()?.toLowerCase() ?? ""; if (extSet.has(ext)) results.push(fullPath); }
        }
        return results;
      } catch { return []; }
    }
    const allFiles: string[] = [];
    for (const dir of dirs) allFiles.push(...await collectFiles(dir));
    allFiles.sort(); await addPaths(allFiles);
  }, [isTauri, addPaths]);

  const pickOutput = useCallback(async () => {
    if (!isTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") setOutputDir(sel);
  }, [isTauri]);

  const canSubmit = useMemo(() =>
    isTauri && tasks.length > 0 && !!outputDir && !isRunning && settingsComplete(settings, modelReady, downloadedModels),
    [isTauri, tasks, outputDir, isRunning, settings, modelReady, downloadedModels]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setIsRunning(true); setQueueElapsed(null);
    const queueStart = Date.now(); setQueueStartTime(queueStart);
    const abort = new AbortController(); abortRef.current = abort;
    const { invoke } = await import("@tauri-apps/api/core");

    const pending = tasks.filter(t => t.status !== "done");
    const sem = { count: 0, max: concurrency };
    const runTask = async (task: FileTask) => {
      if (abort.signal.aborted) { setTasks(prev => prev.map(t => t.path === task.path ? { ...t, status: "error", error: "已停止" } : t)); return; }
      targetRatioRef.current[task.path] = 0;
      const taskStart = Date.now();
      setTasks(prev => prev.map(t =>
        t.path === task.path ? { ...t, displayRatio: 0, status: "processing", stageTiming: {}, progress: { stage: "starting", ratio: 0, message: "启动中..." } } : t));
      try {
        const raw = await invoke<Record<string, unknown>>("transcribe_audio", {
          opts: {
            input: task.path, output_dir: outputDir, source_lang: sourceLang,
            asr_provider: settings.asrProvider,
            groq_api_key: settings.groqApiKey || null,
            siliconflow_api_key: settings.siliconflowApiKey || null,
            chunk_seconds: settings.chunkSeconds, skip_cache: settings.skipCache,
            whisper_model: settings.whisperModel,
          },
        });
        if (abort.signal.aborted) return;
        const totalElapsed = (Date.now() - taskStart) / 1000;
        targetRatioRef.current[task.path] = 1;
        await new Promise(r => setTimeout(r, 400));
        setTasks(prev => prev.map(t => t.path === task.path ? { ...t, status: "done", result: toCamelResult(raw), totalElapsed } : t));
        setExpandedTasks(prev => new Set([...prev, task.path]));
      } catch (e) {
        if (abort.signal.aborted) return;
        setTasks(prev => prev.map(t => t.path === task.path ? { ...t, status: "error", error: String(e) } : t));
      }
    };

    await new Promise<void>(resolve => {
      let started = 0, finished = 0;
      function next() {
        while (sem.count < sem.max && started < pending.length) {
          const task = pending[started++]; sem.count++;
          runTask(task).finally(() => { sem.count--; finished++; if (finished === pending.length) resolve(); else next(); });
        }
      }
      next(); if (pending.length === 0) resolve();
    });

    setQueueElapsed((Date.now() - queueStart) / 1000); setQueueStartTime(null);
    abortRef.current = null; setIsRunning(false);
  }, [canSubmit, tasks, concurrency, outputDir, sourceLang, settings]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    import("@tauri-apps/api/core").then(({ invoke }) => {
      setTasks(prev => { for (const t of prev) { if (t.status === "processing") invoke("cancel_subtitle", { input: t.path }).catch(() => {}); } return prev; });
    });
  }, []);

  function basename(p: string) { return p.split(/[\\/]/).pop() ?? p; }

  return (
    <div className="flex flex-col gap-3 max-w-3xl mx-auto w-full">

      {/* ── 主卡片 ── */}
      <div className="rounded-md p-5 flex flex-col gap-4"
        style={{ background: "var(--color-surface-1)", border: "0.5px solid var(--color-border-subtle)" }}>

        {/* 音频文件 */}
        {tasks.length === 0 ? (
          <div className="rounded-md transition-all duration-200"
            style={{ border: `1.5px dashed ${isDragging ? "var(--color-accent)" : "var(--color-border)"}`, background: isDragging ? "var(--color-accent-muted)" : "var(--color-surface-2)", padding: "28px 20px" }}
            onDragEnter={e => { e.preventDefault(); dragCounterRef.current++; setIsDragging(true); }}
            onDragOver={e => e.preventDefault()}
            onDragLeave={() => { dragCounterRef.current--; if (dragCounterRef.current === 0) setIsDragging(false); }}
            onDrop={handleDrop}>
            <div className="flex flex-col items-center gap-3 text-center">
              <MicIcon />
              <div>
                <p className="text-sm font-medium" style={{ color: isDragging ? "var(--color-accent)" : "var(--color-text-primary)" }}>
                  {isDragging ? "松开即可添加" : "拖放音频文件"}
                </p>
                <p className="text-xs mt-1" style={{ color: "var(--color-text-tertiary)" }}>支持多文件、文件夹递归扫描</p>
              </div>
              {!isDragging && (
                <div className="flex gap-2">
                  <button onClick={pickInputs} className="rounded-md px-4 py-1.5 text-sm font-medium" style={{ background: "var(--color-accent)", color: "white" }}>选择文件</button>
                  <button onClick={pickFolders} className="rounded-md px-4 py-1.5 text-sm font-medium" style={{ background: "var(--color-surface-3)", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}>选择文件夹</button>
                </div>
              )}
              <div className="flex items-center gap-1.5 flex-wrap justify-center mt-1">
                {["WAV","MP3","M4A","AAC","FLAC","OGG","WMA","OPUS"].map(fmt => (
                  <span key={fmt} className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)", border: "0.5px solid var(--color-border-subtle)", fontFamily: "JetBrains Mono, monospace" }}>{fmt}</span>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>音频文件</p>
            <div className="flex gap-2">
              <button onClick={pickInputs} className="flex-1 min-w-0 rounded-md px-3 py-2 text-sm text-left truncate"
                style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }}>
                {tasks.length === 1 ? basename(tasks[0].path) : `已选 ${tasks.length} 个文件`}
              </button>
              <button onClick={pickInputs} className="rounded-md px-3 py-2 text-sm font-medium shrink-0" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }} title="添加文件">+ 文件</button>
              <button onClick={pickFolders} className="rounded-md px-3 py-2 text-sm font-medium shrink-0" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }} title="添加文件夹（递归扫描）">+ 文件夹</button>
            </div>
          </div>
        )}

        {/* 输出目录 */}
        <div className="flex flex-col gap-1.5">
          <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>输出目录</p>
          <div className="flex gap-2">
            <button onClick={pickOutput} className="flex-1 min-w-0 rounded-md px-3 py-2 text-sm text-left truncate"
              style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: outputDir ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>
              {outputDir ? basename(outputDir) : "点击选择保存目录"}
            </button>
            <button onClick={pickOutput} className="rounded-md px-4 py-2 text-sm font-medium shrink-0" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }}>浏览</button>
          </div>
        </div>

        {/* 语言 */}
        <div className="flex flex-col gap-1.5">
          <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>语言</p>
          <CustomSelect value={sourceLang} onChange={setSourceLang} options={SOURCE_LANGS.map(l => ({ code: l.code, label: l.label }))} />
        </div>

        <div className="flex gap-2">
          <button onClick={handleSubmit} disabled={!canSubmit}
            className="flex-1 rounded-md py-2.5 text-sm font-semibold transition-opacity disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "white" }}
            onMouseEnter={e => { if (!isRunning) (e.currentTarget as HTMLElement).style.background = "var(--color-accent-hover)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "var(--color-accent)"; }}>
            {isRunning ? `转录中 (${tasks.filter(t => t.status === "done").length}/${tasks.length})...` : "开始转录"}
          </button>
          {isRunning && (
            <button onClick={handleStop} className="rounded-md px-4 py-2.5 text-sm font-medium"
              style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-danger)" }}>停止</button>
          )}
        </div>
      </div>

      {/* ── 批量完成 header ── */}
      {(() => {
        const doneTasks = tasks.filter(t => t.status === "done" && t.result);
        const errorTasks = tasks.filter(t => t.status === "error");
        if (doneTasks.length === 0 && errorTasks.length === 0) return null;
        return (
          <div className="flex items-center justify-between px-4 py-3 rounded-md"
            style={{ background: "var(--color-accent-muted)", border: "0.5px solid rgba(99,102,241,0.25)" }}>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--color-accent)" }} />
              <span className="text-sm" style={{ color: "var(--color-accent)" }}>转录完成</span>
            </div>
            <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
              {doneTasks.length} 个文件{errorTasks.length > 0 && ` · ${errorTasks.length} 个失败`}
            </span>
          </div>
        );
      })()}

      {/* ── 文件任务列表 ── */}
      {tasks.length > 0 && (
        <div className="rounded-md overflow-hidden" style={{ background: "var(--color-surface-1)", border: "0.5px solid var(--color-border-subtle)" }}>
          <div className="px-4 py-2.5 flex items-center justify-between" style={{ borderBottom: "0.5px solid var(--color-border-subtle)" }}>
            <div className="flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                style={{ color: "var(--color-accent)", flexShrink: 0 }}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
              <span className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>转录队列</span>
            </div>
            <div className="flex items-center gap-2">
              {queueElapsed != null && <span className="text-xs tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>总用时 {queueElapsed.toFixed(1)}s</span>}
              <span className="px-2.5 py-0.5 rounded-full text-xs font-medium" style={{ background: "var(--color-accent-muted)", color: "var(--color-accent)", border: "0.5px solid rgba(99,102,241,0.25)" }}>{tasks.length} 个文件</span>
              {!isRunning && (
                <button onClick={() => setTasks([])} className="text-xs px-2 py-0.5 rounded" style={{ color: "var(--color-danger)", background: "rgba(220,50,50,0.08)", border: "0.5px solid rgba(220,50,50,0.2)" }}>清空</button>
              )}
            </div>
          </div>
          <div className="divide-y" style={{ borderColor: "var(--color-border-subtle)" }}>
            {tasks.map((task, taskIdx) => {
              const isExpanded = expandedTasks.has(task.path);
              const toggleExpand = () => setExpandedTasks(prev => { const next = new Set(prev); next.has(task.path) ? next.delete(task.path) : next.add(task.path); return next; });
              const logCollapsed = !expandedLogs.has(task.path);
              const toggleLog = () => setExpandedLogs(prev => { const next = new Set(prev); next.has(task.path) ? next.delete(task.path) : next.add(task.path); return next; });

              return (
                <div key={task.path} style={{ borderColor: "var(--color-border-subtle)" }}>
                  <div className="px-4 py-3 flex items-center gap-3" style={{ background: task.status === "processing" ? "var(--color-surface-2)" : "transparent" }}>
                    <span style={{ fontSize: "11px", fontFamily: "JetBrains Mono, monospace", color: "var(--color-text-tertiary)", width: "18px", flexShrink: 0 }}>{taskIdx + 1}.</span>
                    <div className="shrink-0 w-8 h-8 rounded-md flex items-center justify-center" style={{ background: "var(--color-surface-2)", color: "var(--color-text-secondary)" }}>
                      {task.status === "processing" ? (
                        <span className="w-3 h-3 rounded-full border-2 animate-spin" style={{ borderColor: "var(--color-accent) var(--color-accent-track) var(--color-accent-track) var(--color-accent-track)" }} />
                      ) : task.status === "done" ? (
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ color: "oklch(65% 0.15 145)" }}><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" /><path d="M5 8l2.5 2.5L11 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      ) : task.status === "error" ? (
                        <span style={{ color: "var(--color-danger)" }}>✗</span>
                      ) : <MicIcon />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: "var(--color-text-primary)", fontFamily: "JetBrains Mono, monospace", fontSize: "13px" }}>{basename(task.path)}</p>
                      {task.status !== "processing" && task.size != null && task.size > 0 && <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>{formatBytes(task.size)}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {task.status === "done" && task.totalElapsed != null && <span className="text-xs tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>{task.totalElapsed.toFixed(0)}s</span>}
                      {task.status === "error" && !isRunning && <button onClick={() => setTasks(prev => prev.map(t => t.path === task.path ? { ...t, status: "pending", error: "", result: null } : t))} className="text-xs px-2 py-0.5 rounded" style={{ color: "var(--color-accent)", background: "var(--color-accent-muted)", border: "1px solid rgba(99,102,241,0.2)" }}>重试</button>}
                      {task.status === "pending" && !isRunning && <button onClick={() => setTasks(prev => prev.filter(t => t.path !== task.path))} className="text-xs px-2 py-0.5 rounded" style={{ color: "var(--color-text-tertiary)", background: "var(--color-surface-2)" }}>移除</button>}
                      {(task.status === "done" || task.status === "error") && (
                        <button onClick={toggleExpand} style={{ color: "var(--color-text-tertiary)" }}>
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ transform: isExpanded ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s" }}><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 进度详情 */}
                  {task.status === "processing" && (() => {
                    const activeStepIdx = stageToStepIdx(task.progress.stage);
                    const pct = Math.round(task.displayRatio * 100);
                    return (<>
                      <div className="px-4 pb-3 space-y-2.5" style={{ borderTop: "1px solid var(--color-border-subtle)", background: "var(--color-surface-2)" }}>
                        <div className="flex items-center pt-2.5">
                          {PIPELINE_STEPS.map((s, i) => {
                            const isDone = i < activeStepIdx; const isActive = i === activeStepIdx;
                            const stepElapsed = (() => {
                              if (i === 0) return task.stageTiming["extracting"] ?? task.stageTiming["loading_model"];
                              if (i === 1) return task.stageTiming["transcribing"];
                              return task.stageTiming["done"];
                            })();
                            return (
                              <div key={s.key} className="flex items-center flex-1 last:flex-none">
                                <div className="flex flex-col items-center gap-0.5 shrink-0">
                                  <div className="flex items-center gap-1">
                                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-300"
                                      style={{ background: isDone || isActive ? "var(--color-accent)" : "var(--color-surface-3)", color: isDone || isActive ? "white" : "var(--color-text-tertiary)", boxShadow: isActive ? "0 0 8px var(--color-accent-glow)" : "none" }}>{isDone ? "✓" : s.icon}</div>
                                    <span className="text-[11px]" style={{ color: isDone || isActive ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>{s.label}</span>
                                  </div>
                                  <span className="text-[10px] tabular-nums h-[12px]" style={{ color: "var(--color-accent)", opacity: stepElapsed != null ? 1 : 0 }}>{stepElapsed != null ? `${stepElapsed.toFixed(1)}s` : "0.0s"}</span>
                                </div>
                                {i < PIPELINE_STEPS.length - 1 && <div className="flex-1 h-px mx-1 rounded-full transition-all duration-500 self-start mt-2.5" style={{ background: isDone ? "var(--color-accent)" : "var(--color-border-subtle)" }} />}
                              </div>
                            );
                          })}
                        </div>
                        <div className="space-y-1">
                          <div className="flex justify-between items-center text-xs">
                            <span style={{ color: "var(--color-text-secondary)" }}>{task.progress.message || "处理中..."}</span>
                            <span className="flex items-center gap-2 tabular-nums">{task.progress.elapsed_secs != null && <span style={{ color: "var(--color-text-tertiary)" }}>{task.progress.elapsed_secs.toFixed(0)}s</span>}<span style={{ color: "var(--color-text-primary)", fontWeight: 600 }}>{pct}%</span></span>
                          </div>
                          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--color-accent-track)" }}>
                            <div className="h-full rounded-full" style={{ transform: `scaleX(${pct / 100})`, transformOrigin: "left", transition: "transform 0.3s ease-out", background: "var(--color-accent)", boxShadow: "0 0 8px var(--color-accent-glow)" }} />
                          </div>
                        </div>
                      </div>
                      <LogPanel logs={task.logs} collapsed={logCollapsed} onToggle={toggleLog} />
                    </>);
                  })()}

                  {/* 错误 */}
                  {task.status === "error" && isExpanded && (
                    <div className="px-4 pb-3 pt-2 space-y-2" style={{ borderTop: "1px solid var(--color-border-subtle)" }}>
                      <p className="text-xs font-medium" style={{ color: "var(--color-danger)" }}>错误详情</p>
                      <pre className="text-xs p-3 rounded-md overflow-x-auto whitespace-pre-wrap break-all" style={{ background: "var(--color-surface-2)", color: "var(--color-text-secondary)", fontFamily: "JetBrains Mono, monospace", lineHeight: 1.6 }}>{task.error}</pre>
                      <LogPanel logs={task.logs} collapsed={logCollapsed} onToggle={toggleLog} />
                    </div>
                  )}

                  {/* 完成 */}
                  {task.status === "done" && task.result && isExpanded && (
                    <div className="px-4 pb-3 space-y-2" style={{ borderTop: "1px solid var(--color-border-subtle)" }}>
                      {Object.keys(task.stageTiming).length > 0 && (
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-2">
                          {PIPELINE_STEPS.filter(s => {
                            if (s.key === "extracting") return task.stageTiming["extracting"] != null;
                            return task.stageTiming[s.key] != null;
                          }).map(s => {
                            const elapsed = s.key === "extracting" ? task.stageTiming["extracting"] : task.stageTiming[s.key];
                            return <span key={s.key} className="text-[11px] tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>{s.label} <span style={{ color: "var(--color-accent)" }}>{elapsed!.toFixed(1)}s</span></span>;
                          })}
                        </div>
                      )}
                      <button onClick={async () => {
                        if (!isTauri || !task.result) return;
                        const { invoke } = await import("@tauri-apps/api/core");
                        await invoke("reveal_in_finder", { path: task.result.originalPath });
                      }}
                        className="w-full rounded-md py-2 text-sm font-medium transition-all duration-150"
                        style={{ background: "var(--color-surface-3)", color: "var(--color-text-primary)", border: "1px solid var(--color-border)" }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--color-accent-muted)"}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "var(--color-surface-3)"}
                      >
                        打开文件夹
                      </button>
                      <LogPanel logs={task.logs} collapsed={logCollapsed} onToggle={toggleLog} />
                      <SubtitlePreview segments={task.result.segments} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 设置面板 ── */}
      <div className="rounded-md" style={{ background: "var(--color-surface-1)", border: "0.5px solid var(--color-border-subtle)" }}>
        <button onClick={() => setSettingsOpen(o => !o)} className="w-full flex items-center justify-between px-5 py-3.5">
          <span className="text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>转录设置</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: "var(--color-text-tertiary)", transform: settingsOpen ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s" }}><path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {settingsOpen && (
          <div className="px-5 pb-5 flex flex-col gap-4" style={{ borderTop: "1px solid var(--color-border-subtle)" }}>
            <div className="flex flex-col gap-2.5 pt-4">
              <div className="flex items-baseline justify-between">
                <SettingGroup label="引擎" />
                <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>{settings.asrProvider === "local-whisper" ? "离线，无需网络" : "云端 API，速度更快"}</span>
              </div>
              <SettingRow label="提供商">
                <CustomSelect value={settings.asrProvider} onChange={v => set("asrProvider", v as AsrProvider)}
                  options={[{ code: "local-whisper", label: "本地 Whisper（离线）" }, { code: "groq", label: "Groq Whisper（云端）" }, { code: "siliconflow", label: "SiliconFlow（云端）" }]} />
              </SettingRow>
              {settings.asrProvider === "local-whisper" && (
                <SettingRow label="模型">
                  <ModelSelect value={settings.whisperModel} onChange={v => set("whisperModel", v)} downloadedModels={downloadedModels} downloadingModel={downloadingModel} downloadProgress={downloadProgress} onDownload={downloadModel} onDelete={deleteModel} />
                </SettingRow>
              )}
              {settings.asrProvider === "local-whisper" && gpuStatus && (
                <SettingRow label="GPU 加速">
                  {gpuStatus.active_is_gpu ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>{gpuStatus.detected.name} ({gpuStatus.active_variant.toUpperCase()}) ✓ 已启用</span>
                      <button onClick={async () => { const { invoke } = await import("@tauri-apps/api/core"); const dir = await invoke<string>("get_gpu_bin_dir"); await invoke("reveal_in_finder", { path: dir }); }} className="rounded px-2 py-0.5 text-xs" style={{ border: "0.5px solid var(--color-accent)", color: "var(--color-accent)" }}>打开目录</button>
                      <button onClick={async () => { const { invoke } = await import("@tauri-apps/api/core"); await invoke("clear_gpu_cache"); const s = await invoke<typeof gpuStatus>("get_gpu_status"); setGpuStatus(s); }} className="rounded px-2 py-0.5 text-xs" style={{ border: "0.5px solid var(--color-border)", color: "var(--color-text-tertiary)" }}>清除</button>
                    </div>
                  ) : gpuStatus.recommended ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>{gpuStatus.detected.name} 已检测到</span>
                        <button onClick={downloadGpuWhisper} disabled={gpuDownloading} className="rounded px-2 py-0.5 text-xs font-medium" style={{ background: gpuDownloading ? "var(--color-border)" : "var(--color-accent)", color: "white", opacity: gpuDownloading ? 0.6 : 1 }}>{gpuDownloading ? "下载中..." : "自动下载"}</button>
                      </div>
                    </div>
                  ) : <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>使用 CPU 模式</span>}
                </SettingRow>
              )}
              {settings.asrProvider === "groq" && (
                <SettingRow label="API Key">
                  <div className="flex flex-col gap-1">
                    <input type="password" value={settings.groqApiKey} onChange={e => set("groqApiKey", e.target.value)} placeholder="gsk_..." className="w-full rounded-md px-3 py-2 text-sm outline-none" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontFamily: "JetBrains Mono, monospace" }} />
                    <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>在 <span style={{ color: "var(--color-accent)" }}>console.groq.com</span> 免费获取</p>
                  </div>
                </SettingRow>
              )}
              {settings.asrProvider === "siliconflow" && (
                <SettingRow label="API Key">
                  <div className="flex flex-col gap-1">
                    <input type="password" value={settings.siliconflowApiKey} onChange={e => set("siliconflowApiKey", e.target.value)} placeholder="sk-..." className="w-full rounded-md px-3 py-2 text-sm outline-none" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontFamily: "JetBrains Mono, monospace" }} />
                    <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>在 <span style={{ color: "var(--color-accent)" }}>siliconflow.cn</span> 注册获取</p>
                  </div>
                </SettingRow>
              )}
            </div>
            <div style={{ height: 1, background: "var(--color-border-subtle)" }} />
            <button onClick={() => setAdvancedOpen(o => !o)} className="flex items-center justify-between text-xs" style={{ color: "var(--color-text-tertiary)" }}>
              <span>高级选项</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transform: advancedOpen ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.15s" }}><path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {advancedOpen && (
              <div className="flex flex-col gap-2.5">
                <SettingRow label="分片时长">
                  <div className="flex items-center gap-3">
                    <input type="number" min={60} max={600} value={settings.chunkSeconds} onChange={e => set("chunkSeconds", Number(e.target.value))} className="w-24 rounded-md px-3 py-2 text-sm outline-none" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }} />
                    <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>秒</span>
                  </div>
                </SettingRow>
                <SettingRow label="">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={settings.skipCache} onChange={e => set("skipCache", e.target.checked)} className="h-4 w-4 rounded" style={{ accentColor: "var(--color-accent)" }} />
                    <span className="text-sm" style={{ color: "var(--color-text-secondary)" }}>忽略缓存</span>
                  </label>
                </SettingRow>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
