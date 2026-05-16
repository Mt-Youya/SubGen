"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── 图标 ──────────────────────────────────────────────────
function VideoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SrtIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="3" y1="5.5" x2="11" y2="5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="3" y1="8.5" x2="8" y2="8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// ── 下载行组件 ─────────────────────────────────────────────
function DownloadRow({ icon, title, subtitle, onClick }: {
  icon: React.ReactNode; title: string; subtitle: string; onClick: () => void;
}) {
  const [clicked, setClicked] = useState(false);
  return (
    <button
      onClick={() => { onClick(); setClicked(true); setTimeout(() => setClicked(false), 2000); }}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-all duration-150"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border-subtle)" }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--color-border)"; (e.currentTarget as HTMLElement).style.background = "var(--color-surface-3)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--color-border-subtle)"; (e.currentTarget as HTMLElement).style.background = "var(--color-surface-2)"; }}
    >
      <span className="shrink-0" style={{ color: "var(--color-text-tertiary)" }}>{icon}</span>
      <span className="text-xs font-medium" style={{ color: "var(--color-text-primary)" }}>{title}</span>
      <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>· {subtitle}</span>
      <span className="ml-auto transition-all duration-200" style={{ color: clicked ? "var(--color-success)" : "var(--color-text-tertiary)" }}>
        {clicked ? (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M3 8l4 4 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v7M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        )}
      </span>
    </button>
  );
}

// ── 横排下载 Chip ─────────────────────────────────────────
function DownloadChip({ title, subtitle, onClick }: {
  title: string; subtitle: string; onClick: () => void;
}) {
  const [clicked, setClicked] = useState(false);
  return (
    <button
      onClick={() => { onClick(); setClicked(true); setTimeout(() => setClicked(false), 2000); }}
      className="flex-1 flex flex-col items-center gap-0.5 py-2 rounded-lg transition-all duration-150"
      style={{
        background: clicked ? "var(--color-accent-muted)" : "var(--color-surface-3)",
        border: `1px solid ${clicked ? "oklch(65% 0.22 265 / 30%)" : "transparent"}`,
      }}
      onMouseEnter={e => { if (!clicked) (e.currentTarget as HTMLElement).style.background = "var(--color-surface-1)"; }}
      onMouseLeave={e => { if (!clicked) (e.currentTarget as HTMLElement).style.background = "var(--color-surface-3)"; }}
    >
      {clicked ? (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ color: "var(--color-accent)" }}>
          <path d="M3 8l4 4 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ color: "var(--color-text-tertiary)" }}>
          <path d="M8 3v7M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
      <span className="text-xs font-medium" style={{ color: clicked ? "var(--color-accent)" : "var(--color-text-primary)" }}>{title}</span>
      <span className="text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>{subtitle}</span>
    </button>
  );
}

// ── 字幕预览 tabs + 列表 ───────────────────────────────────
function SubtitlePreview({ result, sourceLang, targetLang }: {
  result: GenerateResult; sourceLang: string; targetLang: string;
}) {
  const [tab, setTab] = useState<"original" | "translated" | "bilingual">("translated");
  const items = tab === "translated"
    ? result.translated.map(s => ({ primary: s.text, secondary: null as string | null }))
    : tab === "bilingual"
    ? result.segments.map((s, i) => ({ primary: s.text, secondary: result.translated[i]?.text ?? null }))
    : result.segments.map(s => ({ primary: s.text, secondary: null as string | null }));

  return (
    <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--color-border-subtle)" }}>
      <div className="px-4 py-2.5 flex items-center"
        style={{ background: "var(--color-surface-1)", borderBottom: "1px solid var(--color-border-subtle)" }}>
        <div className="flex items-center gap-1">
          {(["original", "translated", "bilingual"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className="px-2.5 py-1 rounded-lg text-xs transition-all duration-150"
              style={{
                background: tab === t ? "var(--color-surface-3)" : "transparent",
                color: tab === t ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
                fontWeight: tab === t ? 500 : 400,
              }}>
              {{ original: "原文", translated: "译文", bilingual: "双语" }[t]}
            </button>
          ))}
        </div>
        <span className="text-xs ml-auto" style={{ color: "var(--color-text-tertiary)" }}>
          共 {result.segments.length} 条
        </span>
      </div>
      <div className="overflow-y-auto divide-y" style={{ maxHeight: "200px", background: "var(--color-surface-1)", borderColor: "var(--color-border-subtle)" } as React.CSSProperties}>
        {items.slice(0, 10).map((item, i) => (
          <div key={i} className="px-4 py-2.5 flex gap-3" style={{ borderColor: "var(--color-border-subtle)" }}>
            <span className="text-xs tabular-nums shrink-0 pt-0.5" style={{ color: "var(--color-text-tertiary)" }}>{i + 1}</span>
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm" style={{ color: "var(--color-text-primary)" }}>{item.primary}</p>
              {item.secondary && <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>{item.secondary}</p>}
            </div>
          </div>
        ))}
        {result.segments.length > 10 && (
          <div className="px-4 py-2.5 text-xs text-center" style={{ color: "var(--color-text-tertiary)" }}>
            ··· 剩余 {result.segments.length - 10} 条
          </div>
        )}
      </div>
    </div>
  );
}

type AsrProvider = "groq" | "siliconflow" | "local-whisper";
type TranslateProvider = "deepl" | "tencent";
type Status = "idle" | "processing" | "done" | "error";

interface ProgressPayload { stage: string; ratio: number; message: string; elapsed_secs?: number }

// 阶段定义：与 Rust emit_progress 的 stage 字符串对应
const PIPELINE_STEPS = [
  { key: "extracting",   label: "提取音频", icon: "⚙" },
  { key: "loading_model", label: "加载模型", icon: "⬇" },
  { key: "transcribing", label: "语音识别", icon: "◎" },
  { key: "translating",  label: "翻译字幕", icon: "↔" },
  { key: "done",         label: "完成",     icon: "✓" },
] as const;

type PipelineStepKey = typeof PIPELINE_STEPS[number]["key"] | "starting";

// 当前 stage 对应哪个 step 的索引（-1 = 未开始）
function stageToStepIdx(stage: string): number {
  if (stage === "done") return PIPELINE_STEPS.length - 1;
  const idx = PIPELINE_STEPS.findIndex(s => s.key === stage);
  return idx === -1 ? 0 : idx;
}
interface Segment { start: number; end: number; text: string }
interface GenerateResult {
  segments: Segment[];
  translated: Segment[];
  originalSrt: string;
  translatedSrt: string;
  bilingualSrt: string | null;
  originalPath: string;
  translatedPath: string;
  bilingualPath: string | null;
}
type WhisperModel = "base" | "small" | "medium" | "large-v3";

interface Settings {
  asrProvider: AsrProvider;
  translateProvider: TranslateProvider;
  groqApiKey: string;
  siliconflowApiKey: string;
  deeplApiKey: string;
  tencentSecretId: string;
  tencentSecretKey: string;
  chunkSeconds: number;
  skipCache: boolean;
  whisperModel: WhisperModel;
}

const DEFAULT_SETTINGS: Settings = {
  asrProvider: "local-whisper",
  translateProvider: "tencent",
  groqApiKey: "",
  siliconflowApiKey: "",
  deeplApiKey: "",
  tencentSecretId: "",
  tencentSecretKey: "",
  chunkSeconds: 240,
  skipCache: false,
  whisperModel: "small",
};

const WHISPER_MODELS: { name: WhisperModel; label: string; size: string }[] = [
  // { name: "tiny",     label: "Tiny",     size: "75MB"  },
  { name: "base",     label: "Base",     size: "142MB" },
  { name: "small",    label: "Small",    size: "466MB" },
  { name: "medium",   label: "Medium",   size: "1.5GB" },
  { name: "large-v3", label: "Large v3", size: "3.1GB" },
];

const SOURCE_LANGS = [
  { code: "ja", label: "日语" }, { code: "zh", label: "中文" },
  { code: "en", label: "英语" }, { code: "ko", label: "韩语" },
  { code: "fr", label: "法语" }, { code: "de", label: "德语" },
  { code: "es", label: "西班牙语" },
];
const TARGET_LANGS = [
  { code: "ZH", label: "中文简体" }, { code: "ZH-TW", label: "中文繁体" },
  { code: "EN-US", label: "英语" }, { code: "JA", label: "日语" },
  { code: "KO", label: "韩语" },
];

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function settingsComplete(s: Settings, modelReady: boolean, downloadedModels?: Set<WhisperModel>): boolean {
  const asrOk = s.asrProvider === "local-whisper"
    ? (downloadedModels ? downloadedModels.has(s.whisperModel) : modelReady)
    : s.asrProvider === "groq" ? !!s.groqApiKey.trim() : !!s.siliconflowApiKey.trim();
  const trlOk = s.translateProvider === "tencent"
    ? !!(s.tencentSecretId.trim() && s.tencentSecretKey.trim())
    : !!s.deeplApiKey.trim();
  return asrOk && trlOk;
}

function toCamelResult(raw: Record<string, unknown>): GenerateResult {
  return {
    segments: (raw.segments as Segment[]) ?? [],
    translated: (raw.translated as Segment[]) ?? [],
    originalSrt: String(raw.original_srt ?? ""),
    translatedSrt: String(raw.translated_srt ?? ""),
    bilingualSrt: raw.bilingual_srt ? String(raw.bilingual_srt) : null,
    originalPath: String(raw.original_path ?? ""),
    translatedPath: String(raw.translated_path ?? ""),
    bilingualPath: raw.bilingual_path ? String(raw.bilingual_path) : null,
  };
}

// ── 自定义 Select ─────────────────────────────────────────
function CustomSelect<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { code: T; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = options.find(o => o.code === value)?.label ?? value;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between rounded-lg px-3 py-2 text-sm text-left"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text-primary)",
        }}
      >
        <span>{label}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          style={{ color: "var(--color-text-tertiary)", transform: open ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.15s" }}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg overflow-hidden py-1"
          style={{
            background: "var(--color-surface-3)",
            border: "1px solid var(--color-border)",
            boxShadow: "0 8px 24px oklch(0% 0 0 / 40%)",
          }}>
          {options.map(o => (
            <button
              key={o.code}
              type="button"
              onClick={() => { onChange(o.code); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm transition-colors"
              style={{
                color: o.code === value ? "var(--color-accent)" : "var(--color-text-primary)",
                background: o.code === value ? "var(--color-accent-muted)" : "transparent",
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 模型选择下拉（含下载进度）────────────────────────────
function ModelSelect({ value, onChange, downloadedModels, downloadingModel, downloadProgress, onDownload, onDelete }: {
  value: WhisperModel;
  onChange: (v: WhisperModel) => void;
  downloadedModels: Set<WhisperModel>;
  downloadingModel: WhisperModel | null;
  downloadProgress: Record<string, number>;
  onDownload: (m: WhisperModel) => void;
  onDelete: (m: WhisperModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = WHISPER_MODELS.find(m => m.name === value);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const downloadingInfo = downloadingModel ? WHISPER_MODELS.find(m => m.name === downloadingModel) : null;
  const downloadingPct = downloadingModel ? Math.round((downloadProgress[downloadingModel] ?? 0) * 100) : 0;

  return (
    <div ref={ref} className="relative w-full">
      {/* 触发按钮 */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full relative overflow-hidden flex items-center justify-between rounded-lg px-3 py-2 text-sm text-left"
        style={{
          background: "var(--color-surface-2)",
          border: `1px solid ${downloadingInfo && !open ? "var(--color-accent)" : "var(--color-border)"}`,
          color: "var(--color-text-primary)",
        }}
      >
        {/* 下载中时的进度填充背景 */}
        {downloadingInfo && !open && (
          <div className="absolute inset-0 pointer-events-none transition-all duration-300"
            style={{ width: `${downloadingPct}%`, background: "oklch(50% 0.22 265 / 20%)" }} />
        )}
        <span className="relative flex items-center gap-2">
          {downloadingInfo && !open ? (
            <>
              <span className="font-medium" style={{ color: "var(--color-accent)" }}>{downloadingInfo.label}</span>
              <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>{downloadingInfo.size}</span>
              <span className="text-xs tabular-nums" style={{ color: "var(--color-accent)" }}>{downloadingPct}%</span>
            </>
          ) : (
            <>
              <span>{selected?.label}</span>
              <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>{selected?.size}</span>
              {downloadedModels.has(value) && <span className="text-xs" style={{ color: "var(--color-success)" }}>✓</span>}
            </>
          )}
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          style={{ color: "var(--color-text-tertiary)", transform: open ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.15s", flexShrink: 0 }}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* 下拉列表 */}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg"
          style={{
            background: "var(--color-surface-3)",
            border: "1px solid var(--color-border)",
            boxShadow: "0 8px 24px oklch(0% 0 0 / 40%)",
            overflow: "hidden",
          }}>
          {WHISPER_MODELS.map((m) => {
            const downloaded = downloadedModels.has(m.name);
            const isDownloading = downloadingModel === m.name;
            const pct = Math.round((downloadProgress[m.name] ?? 0) * 100);
            const isSelected = m.name === value;

            return (
              <div key={m.name} className="relative">
                {/* 进度填充背景：容器 overflow:hidden 负责裁剪圆角 */}
                {isDownloading && (
                  <div className="absolute inset-0 pointer-events-none transition-all duration-300"
                    style={{ width: `${pct}%`, background: "oklch(50% 0.22 265 / 20%)" }} />
                )}
                <div className="relative flex items-center justify-between px-3 py-2">
                  {/* 左侧：点击选择（仅已下载可选） */}
                  <button
                    type="button"
                    disabled={!downloaded}
                    onClick={() => { if (downloaded) { onChange(m.name); setOpen(false); } }}
                    className="flex items-center gap-2 flex-1 text-left text-sm min-w-0"
                    style={{
                      color: isSelected ? "var(--color-accent)" : downloaded ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
                      cursor: downloaded ? "pointer" : "default",
                    }}
                  >
                    <span className="font-medium">{m.label}</span>
                    <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>{m.size}</span>
                    {isDownloading && <span className="text-xs tabular-nums" style={{ color: "var(--color-accent)" }}>{pct}%</span>}
                  </button>
                  {/* 右侧操作区 */}
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    {downloaded && !isDownloading && (
                      <>
                        <span className="text-xs" style={{ color: "var(--color-success)" }}>✓</span>
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); onDelete(m.name); }}
                          className="p-1 rounded transition-opacity opacity-40 hover:opacity-100"
                          style={{ color: "var(--color-text-tertiary)" }}
                          title="删除模型"
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path d="M2 3h8M5 3V2h2v1M4.5 3l.5 6h2l.5-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </>
                    )}
                    {!downloaded && (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); onDownload(m.name); }}
                        disabled={!!downloadingModel}
                        className="rounded-full px-2.5 py-0.5 text-xs font-medium transition-opacity disabled:opacity-40"
                        style={{ background: "var(--color-accent)", color: "white" }}
                      >
                        {isDownloading ? "下载中" : "下载"}
                      </button>
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

// ── 布局辅助 ──────────────────────────────────────────────
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 min-h-[36px]">
      <span className="w-20 shrink-0 text-xs text-right" style={{ color: "var(--color-text-tertiary)" }}>
        {label}
      </span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function TextInput({ value, onChange, placeholder, type = "text", readOnly, onClick }: {
  value: string; onChange?: (v: string) => void; placeholder?: string;
  type?: string; readOnly?: boolean; onClick?: () => void;
}) {
  return (
    <input
      type={type}
      value={value}
      readOnly={readOnly}
      onClick={onClick}
      onChange={e => onChange?.(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg px-3 py-2 text-sm outline-none"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        color: "var(--color-text-primary)",
        cursor: readOnly ? "pointer" : "text",
      }}
    />
  );
}

function formatBytes(b: number) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + " GB";
  if (b >= 1048576)    return (b / 1048576).toFixed(1) + " MB";
  if (b >= 1024)       return (b / 1024).toFixed(0) + " KB";
  return b + " B";
}

// ── 每个文件的处理结果 ────────────────────────────────────
interface FileTask {
  path: string;
  size?: number;
  status: "pending" | "processing" | "done" | "error";
  progress: ProgressPayload;
  displayRatio: number;
  result: GenerateResult | null;
  error: string;
  totalElapsed?: number;  // 完成时的总用时
}

// ── 主组件 ────────────────────────────────────────────────
export function DesktopSubtitlePanel() {
  const [inputPaths, setInputPaths] = useState<string[]>([]);
  const [outputDir, setOutputDir] = useState("");
  const [sourceLang, setSourceLang] = useState("ja");
  const [targetLang, setTargetLang] = useState("ZH");
  const [bilingual, setBilingual] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isTauri, setIsTauri] = useState(false);
  // 多文件任务列表
  const [tasks, setTasks] = useState<FileTask[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  // 每个文件的目标进度（path -> ratio），RAF 平滑插值到 task.displayRatio
  const targetRatioRef = useRef<Record<string, number>>({});
  const rafRef = useRef<number>(0);
  const currentTaskRef = useRef<string>("");  // 当前处理文件路径
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [downloadingModel, setDownloadingModel] = useState<WhisperModel | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [downloadedModels, setDownloadedModels] = useState<Set<WhisperModel>>(new Set());
  const initialized = useRef(false);

  const whisperModelRef = useRef(settings.whisperModel);
  useEffect(() => { whisperModelRef.current = settings.whisperModel; }, [settings.whisperModel]);

  const checkModel = useCallback(async () => {
    if (!hasTauriRuntime()) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<{
      whisper: boolean;
      model: boolean;
      models: { name: WhisperModel; downloaded: boolean }[];
    }>("check_whisper_model", { model: whisperModelRef.current })
      .catch(() => ({ whisper: false, model: false, models: [] }));
    setModelReady(info.model && info.whisper);
    setDownloadedModels(new Set(info.models.filter(m => m.downloaded).map(m => m.name)));
  }, []); // 不依赖 settings，通过 ref 读取当前值

  const downloadModel = useCallback(async (modelName: WhisperModel) => {
    setDownloadingModel(modelName);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("download_whisper_model", { model: modelName });
      setDownloadedModels(prev => new Set([...prev, modelName]));
      if (modelName === settings.whisperModel) setModelReady(true);
    } catch (e) {
      alert(`模型下载失败: ${e}`);
    } finally {
      setDownloadingModel(null);
      setDownloadProgress(prev => { const next = { ...prev }; delete next[modelName]; return next; });
    }
  }, [settings.whisperModel]);

  const deleteModel = useCallback(async (modelName: WhisperModel) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_whisper_model", { model: modelName });
      setDownloadedModels(prev => { const next = new Set(prev); next.delete(modelName); return next; });
      if (modelName === settings.whisperModel) setModelReady(false);
    } catch (e) {
      alert(`删除失败: ${e}`);
    }
  }, [settings.whisperModel]);

  // 只在挂载时跑一次
  useEffect(() => {
    setIsTauri(hasTauriRuntime());
    const saved = window.localStorage.getItem("subgen-desktop-settings");
    if (saved) {
      try {
        const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
        setSettings(parsed);
        setSettingsOpen(!settingsComplete(parsed, true));
      } catch {
        window.localStorage.removeItem("subgen-desktop-settings");
        setSettingsOpen(true);
      }
    } else {
      setSettingsOpen(true);
    }
    initialized.current = true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // isTauri 就绪时初始检查
  useEffect(() => {
    if (isTauri) checkModel();
  }, [isTauri, checkModel]);

  // 切换模型时重新检查
  useEffect(() => {
    if (isTauri) checkModel();
  }, [settings.whisperModel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!initialized.current) return;
    window.localStorage.setItem("subgen-desktop-settings", JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<ProgressPayload>("subtitle-progress", e => {
        const path = currentTaskRef.current;
        targetRatioRef.current[path] = e.payload.ratio;
        setTasks(prev => prev.map(t =>
          t.path === path ? { ...t, progress: e.payload } : t
        ));
      }))
      .then(u => { if (disposed) u(); else off = u; })
      .catch(() => { });
    return () => { disposed = true; off?.(); };
  }, [isTauri]);

  // 监听模型下载进度
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<{ model: string; ratio: number }>("model-download-progress", e => {
        setDownloadProgress(prev => ({ ...prev, [e.payload.model]: e.payload.ratio }));
      }))
      .then(u => { if (disposed) u(); else off = u; })
      .catch(() => { });
    return () => { disposed = true; off?.(); };
  }, [isTauri]);

  // 进度平滑动画：对每个文件的 displayRatio 做插值
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

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings(p => ({ ...p, [k]: v }));

  const pickInputs = useCallback(async () => {
    if (!isTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ multiple: true, filters: [{ name: "媒体文件", extensions: ["mp4", "mkv", "ts", "m2ts", "webm", "avi", "mov", "wmv", "flv", "mp3", "wav", "m4a", "aac"] }] });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    const { invoke } = await import("@tauri-apps/api/core");
    const sizes = await invoke<number[]>("get_file_sizes", { paths }).catch(() => paths.map(() => 0));
    setTasks(paths.map((p, i) => ({
      path: p, size: sizes[i] ?? 0, status: "pending",
      progress: { stage: "", ratio: 0, message: "" },
      displayRatio: 0, result: null, error: "",
    })));
  }, [isTauri]);

  const pickOutput = useCallback(async () => {
    if (!isTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") setOutputDir(sel);
  }, [isTauri]);

  const removeTask = useCallback((path: string) => {
    setTasks(prev => prev.filter(t => t.path !== path));
  }, []);

  const canSubmit = useMemo(() =>
    isTauri && tasks.length > 0 && !!outputDir && !isRunning && settingsComplete(settings, modelReady, downloadedModels),
    [isTauri, tasks, outputDir, isRunning, settings, modelReady]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setIsRunning(true);
    const { invoke } = await import("@tauri-apps/api/core");

    // 串行处理每个文件
    for (const task of tasks) {
      if (task.status === "done") continue;
      currentTaskRef.current = task.path;
      targetRatioRef.current[task.path] = 0;
      setTasks(prev => prev.map(t => t.path === task.path ? { ...t, displayRatio: 0 } : t));
      const taskStart = Date.now();
      setTasks(prev => prev.map(t =>
        t.path === task.path ? { ...t, status: "processing", progress: { stage: "starting", ratio: 0, message: "启动中..." } } : t
      ));
      try {
        const raw = await invoke<Record<string, unknown>>("generate_subtitles", {
          opts: {
            input: task.path, output_dir: outputDir,
            source_lang: sourceLang, target_lang: targetLang, bilingual,
            asr_provider: settings.asrProvider,
            translate_provider: settings.translateProvider,
            groq_api_key: settings.groqApiKey || null,
            siliconflow_api_key: settings.siliconflowApiKey || null,
            deepl_api_key: settings.deeplApiKey || null,
            tencent_secret_id: settings.tencentSecretId || null,
            tencent_secret_key: settings.tencentSecretKey || null,
            chunk_seconds: settings.chunkSeconds,
            skip_cache: settings.skipCache,
            whisper_model: settings.whisperModel,
          },
        });
        const totalElapsed = (Date.now() - taskStart) / 1000;
        targetRatioRef.current[task.path] = 1;
        await new Promise(r => setTimeout(r, 400));
        setTasks(prev => prev.map(t =>
          t.path === task.path ? { ...t, status: "done", result: toCamelResult(raw), totalElapsed } : t
        ));
        setExpandedTasks(prev => new Set([...prev, task.path]));
      } catch (e) {
        setTasks(prev => prev.map(t =>
          t.path === task.path ? { ...t, status: "error", error: String(e) } : t
        ));
      }
    }
    setIsRunning(false);
    currentTaskRef.current = "";
  }, [canSubmit, tasks, outputDir, sourceLang, targetLang, bilingual, settings]);

  const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

  return (
    <div className="flex flex-col gap-3 max-w-xl mx-auto w-full">

      {/* ── 主卡片 ── */}
      <div className="rounded-2xl p-5 flex flex-col gap-3"
        style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border-subtle)" }}>

        <Row label="媒体文件">
          <div className="flex gap-2">
            <button onClick={pickInputs} className="flex-1 min-w-0 rounded-lg px-3 py-2 text-sm text-left truncate"
              style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: tasks.length ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>
              {tasks.length === 0 ? "点击选择（支持多选）" : tasks.length === 1 ? basename(tasks[0].path) : `已选 ${tasks.length} 个文件`}
            </button>
            <button onClick={pickInputs} className="rounded-lg px-4 py-2 text-sm font-medium shrink-0"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-primary)" }}>
              浏览
            </button>
          </div>
        </Row>

        <Row label="输出目录">
          <div className="flex gap-2">
            <button onClick={pickOutput} className="flex-1 min-w-0 rounded-lg px-3 py-2 text-sm text-left truncate"
              style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: outputDir ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>
              {outputDir ? basename(outputDir) : "点击选择保存目录"}
            </button>
            <button onClick={pickOutput} className="rounded-lg px-4 py-2 text-sm font-medium shrink-0"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-primary)" }}>
              浏览
            </button>
          </div>
        </Row>

        <Row label="语言">
          <div className="flex items-center gap-2">
            <div className="flex-1"><CustomSelect value={sourceLang} onChange={setSourceLang} options={SOURCE_LANGS.map(l => ({ code: l.code, label: l.label }))} /></div>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}>
              <path d="M3 7h8M8 4l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="flex-1"><CustomSelect value={targetLang} onChange={setTargetLang} options={TARGET_LANGS.map(l => ({ code: l.code, label: l.label }))} /></div>
          </div>
        </Row>

        <Row label="">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={bilingual} onChange={e => setBilingual(e.target.checked)}
              className="h-4 w-4 rounded" style={{ accentColor: "var(--color-accent)" }} />
            <span className="text-sm" style={{ color: "var(--color-text-secondary)" }}>生成双语字幕</span>
          </label>
        </Row>

        <button onClick={handleSubmit} disabled={!canSubmit}
          className="mt-1 w-full rounded-xl py-2.5 text-sm font-semibold transition-opacity disabled:opacity-40"
          style={{ background: "var(--color-accent)", color: "white" }}>
          {isRunning ? `生成中 (${tasks.filter(t => t.status === "done").length}/${tasks.length})...` : "开始生成字幕"}
        </button>
      </div>

      {/* ── 批量完成 header ── */}
      {(() => {
        const doneTasks = tasks.filter(t => t.status === "done" && t.result);
        const errorTasks = tasks.filter(t => t.status === "error");
        if (doneTasks.length === 0 && errorTasks.length === 0) return null;
        const totalSegments = doneTasks.reduce((sum, t) => sum + (t.result?.segments.length ?? 0), 0);
        return (
          <div className="flex items-center justify-between px-4 py-3 rounded-xl"
            style={{ background: "var(--color-accent-muted)", border: "1px solid oklch(65% 0.22 265 / 20%)" }}>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--color-accent)" }} />
              <span className="text-sm" style={{ color: "var(--color-accent)" }}>批量完成</span>
            </div>
            <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
              {doneTasks.length} 个文件 · {totalSegments} 条字幕
              {errorTasks.length > 0 && ` · ${errorTasks.length} 个失败`}
            </span>
          </div>
        );
      })()}

      {/* ── 文件任务列表 ── */}
      <div className="rounded-xl overflow-hidden"
        style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border-subtle)" }}>
        {/* 文件数量 header */}
        {tasks.length > 0 && (
          <div className="px-4 py-3 text-xs" style={{ color: "var(--color-text-tertiary)", borderBottom: "1px solid var(--color-border-subtle)" }}>
            {tasks.length} 个文件
          </div>
        )}

        {/* 空状态 */}
        {tasks.length === 0 && (
          <div className="px-4 py-8 text-sm text-center" style={{ color: "var(--color-text-tertiary)" }}>
            暂无待处理文件
          </div>
        )}

        {/* 文件列表 */}
        <div className="divide-y" style={{ borderColor: "var(--color-border-subtle)" }}>
          {tasks.map(task => {
            const isExpanded = expandedTasks.has(task.path);
            const toggleExpand = () => setExpandedTasks(prev => {
              const next = new Set(prev);
              next.has(task.path) ? next.delete(task.path) : next.add(task.path);
              return next;
            });

            return (
              <div key={task.path} style={{ borderColor: "var(--color-border-subtle)" }}>
                {/* 文件行 header */}
                <div className="px-4 py-3 flex items-center gap-3"
                  style={{ background: task.status === "processing" ? "var(--color-surface-2)" : "transparent" }}>
                  {/* 状态图标 */}
                  <div className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
                    style={{ background: "var(--color-surface-2)", color: "var(--color-text-secondary)" }}>
                    {task.status === "processing" ? (
                      <span className="w-3 h-3 rounded-full border-2 border-t-transparent animate-spin"
                        style={{ borderColor: "var(--color-accent) transparent var(--color-accent) var(--color-accent)" }} />
                    ) : task.status === "done" ? (
                      <span style={{ color: "oklch(65% 0.15 145)" }}>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                          <path d="M5 8l2.5 2.5L11 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    ) : task.status === "error" ? (
                      <span style={{ color: "var(--color-danger)" }}>✗</span>
                    ) : (
                      <VideoIcon />
                    )}
                  </div>

                  {/* 文件名 + 大小 */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: "var(--color-text-primary)" }}>
                      {basename(task.path)}
                    </p>
                    {task.size != null && task.size > 0 && (
                      <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
                        {formatBytes(task.size)}
                      </p>
                    )}
                  </div>

                  {/* 右侧操作 */}
                  <div className="flex items-center gap-2 shrink-0">
                    {task.status === "pending" && !isRunning && (
                      <button onClick={() => removeTask(task.path)}
                        className="text-xs px-2 py-0.5 rounded"
                        style={{ color: "var(--color-text-tertiary)", background: "var(--color-surface-2)" }}>
                        移除
                      </button>
                    )}
                    {task.status === "done" && (
                      <button onClick={toggleExpand} style={{ color: "var(--color-text-tertiary)" }}>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
                          style={{ transform: isExpanded ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s" }}>
                          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>

                {/* 进度详情（处理中） */}
                {task.status === "processing" && (() => {
                  const activeStepIdx = stageToStepIdx(task.progress.stage);
                  const pct = Math.round(task.displayRatio * 100);
                  return (
                    <div className="px-4 pb-3 space-y-2.5">
                      <div className="flex items-center gap-0">
                        {PIPELINE_STEPS.map((s, i) => {
                          const isDone = i < activeStepIdx;
                          const isActive = i === activeStepIdx;
                          return (
                            <div key={s.key} className="flex items-center flex-1 last:flex-none">
                              <div className="flex items-center gap-1 shrink-0">
                                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-300"
                                  style={{
                                    background: isDone || isActive ? "var(--color-accent)" : "var(--color-surface-3)",
                                    color: isDone || isActive ? "white" : "var(--color-text-tertiary)",
                                    boxShadow: isActive ? "0 0 10px var(--color-accent-glow, var(--color-accent))" : "none",
                                  }}>
                                  {isDone ? "✓" : s.icon}
                                </div>
                                <span className="text-[11px]" style={{ color: isDone || isActive ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>
                                  {s.label}
                                </span>
                              </div>
                              {i < PIPELINE_STEPS.length - 1 && (
                                <div className="flex-1 h-px mx-1 rounded-full transition-all duration-500"
                                  style={{ background: isDone ? "var(--color-accent)" : "var(--color-border-subtle)" }} />
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="space-y-1">
                        <div className="flex justify-between items-center text-xs">
                          <span style={{ color: "var(--color-text-secondary)" }}>
                            {task.progress.message || task.progress.stage || "处理中..."}
                          </span>
                          <span className="flex items-center gap-2 tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
                            {task.progress.elapsed_secs != null && `${task.progress.elapsed_secs.toFixed(0)}s`}
                            <span style={{ color: "var(--color-text-primary)", fontWeight: 600 }}>{pct}%</span>
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--color-surface-3)" }}>
                          <div className="h-full rounded-full transition-all duration-300"
                            style={{ width: `${pct}%`, background: "var(--color-accent)", boxShadow: "0 0 8px var(--color-accent-glow, var(--color-accent))" }} />
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* 错误 */}
                {task.status === "error" && (
                  <div className="px-4 pb-3 text-xs" style={{ color: "var(--color-danger)" }}>{task.error}</div>
                )}

                {/* 完成结果（展开时） */}
                {task.status === "done" && task.result && isExpanded && (
                  <div className="px-4 pb-3 space-y-2">
                    {/* 下载区：横排 */}
                    <div className="flex gap-1.5 p-2 rounded-lg" style={{ background: "var(--color-surface-2)" }}>
                      {[
                        { title: "原文", subtitle: sourceLang.toUpperCase(), onClick: async () => {
                          if (!isTauri || !task.result) return;
                          const { invoke } = await import("@tauri-apps/api/core");
                          await invoke("save_srt", { path: task.result.originalPath, content: task.result.originalSrt });
                          invoke("reveal_in_finder", { path: task.result.originalPath });
                        }},
                        { title: "译文", subtitle: targetLang, onClick: async () => {
                          if (!isTauri || !task.result) return;
                          const { invoke } = await import("@tauri-apps/api/core");
                          await invoke("save_srt", { path: task.result.translatedPath, content: task.result.translatedSrt });
                          invoke("reveal_in_finder", { path: task.result.translatedPath });
                        }},
                        ...(task.result.bilingualSrt ? [{ title: "双语", subtitle: "双轨", onClick: async () => {
                          if (!isTauri || !task.result?.bilingualSrt) return;
                          const { invoke } = await import("@tauri-apps/api/core");
                          await invoke("save_srt", { path: task.result.bilingualPath, content: task.result.bilingualSrt });
                          invoke("reveal_in_finder", { path: task.result.bilingualPath });
                        }}] : []),
                      ].map(item => <DownloadChip key={item.title} {...item} />)}
                    </div>
                    <SubtitlePreview result={task.result} sourceLang={sourceLang} targetLang={targetLang} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 设置面板 ── */}
      <div className="rounded-2xl overflow-hidden"
        style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border-subtle)" }}>

        <button onClick={() => setSettingsOpen(o => !o)}
          className="w-full flex items-center justify-between px-5 py-3.5">
          <span className="text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>API 设置</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
            style={{ color: "var(--color-text-tertiary)", transform: settingsOpen ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s" }}>
            <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {settingsOpen && (
          <div className="px-5 pb-5 flex flex-col gap-3"
            style={{ borderTop: "1px solid var(--color-border-subtle)" }}>
            <div className="pt-3" />

            <Row label="转录">
              <CustomSelect value={settings.asrProvider} onChange={v => set("asrProvider", v as AsrProvider)}
                options={[
                  { code: "local-whisper", label: "本地 Whisper（离线）" },
                  { code: "groq", label: "Groq Whisper（云端）" },
                  { code: "siliconflow", label: "SiliconFlow（云端）" },
                ]} />
            </Row>

            {settings.asrProvider === "local-whisper" && (
              <Row label="模型">
                <ModelSelect
                  value={settings.whisperModel}
                  onChange={v => set("whisperModel", v)}
                  downloadedModels={downloadedModels}
                  downloadingModel={downloadingModel}
                  downloadProgress={downloadProgress}
                  onDownload={downloadModel}
                  onDelete={deleteModel}
                />
              </Row>
            )}
            {settings.asrProvider === "groq" && (
              <Row label="Groq Key">
                <TextInput type="password" value={settings.groqApiKey} onChange={v => set("groqApiKey", v)} placeholder="gsk_..." />
              </Row>
            )}
            {settings.asrProvider === "siliconflow" && (
              <Row label="SF Key">
                <TextInput type="password" value={settings.siliconflowApiKey} onChange={v => set("siliconflowApiKey", v)} />
              </Row>
            )}

            <Row label="翻译">
              <CustomSelect value={settings.translateProvider} onChange={v => set("translateProvider", v)}
                options={[{ code: "tencent", label: "腾讯云翻译" }, { code: "deepl", label: "DeepL" }]} />
            </Row>

            {settings.translateProvider === "tencent" && (<>
              <Row label="SecretId">
                <TextInput type="password" value={settings.tencentSecretId} onChange={v => set("tencentSecretId", v)} />
              </Row>
              <Row label="SecretKey">
                <TextInput type="password" value={settings.tencentSecretKey} onChange={v => set("tencentSecretKey", v)} />
              </Row>
            </>)}
            {settings.translateProvider === "deepl" && (
              <Row label="DeepL Key">
                <TextInput type="password" value={settings.deeplApiKey} onChange={v => set("deeplApiKey", v)} />
              </Row>
            )}

            <Row label="分片秒数">
              <input type="number" min={60} max={600} value={settings.chunkSeconds}
                onChange={e => set("chunkSeconds", Number(e.target.value))}
                className="w-24 rounded-lg px-3 py-2 text-sm outline-none"
                style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }} />
            </Row>

            <Row label="">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={settings.skipCache}
                  onChange={e => set("skipCache", e.target.checked)}
                  className="h-4 w-4 rounded" style={{ accentColor: "var(--color-accent)" }} />
                <span className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
                  忽略缓存（重新转录和翻译）
                </span>
              </label>
            </Row>
          </div>
        )}
      </div>
    </div>
  );
}
