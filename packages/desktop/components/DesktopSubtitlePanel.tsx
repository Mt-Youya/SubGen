"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AsrProvider = "groq" | "siliconflow" | "local-whisper";
type TranslateProvider = "deepl" | "tencent";
type Status = "idle" | "processing" | "done" | "error";

interface ProgressPayload { stage: string; ratio: number; message: string; elapsed_secs?: number }
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
type WhisperModel = "tiny" | "base" | "small" | "medium" | "large-v3";

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
  { name: "tiny",     label: "Tiny",     size: "75MB"  },
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

// ── 每个文件的处理结果 ────────────────────────────────────
interface FileTask {
  path: string;
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
  // 当前正在处理的文件进度（平滑插值）
  const [displayRatio, setDisplayRatio] = useState(0);
  const targetRatioRef = useRef(0);
  const rafRef = useRef<number>(0);
  const currentTaskRef = useRef<string>("");  // 当前处理文件路径
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [downloadingModel, setDownloadingModel] = useState<WhisperModel | null>(null);
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
        targetRatioRef.current = e.payload.ratio;
        const path = currentTaskRef.current;
        setTasks(prev => prev.map(t =>
          t.path === path ? { ...t, progress: e.payload } : t
        ));
      }))
      .then(u => { if (disposed) u(); else off = u; })
      .catch(() => { });
    return () => { disposed = true; off?.(); };
  }, [isTauri]);

  // 进度平滑动画（针对当前处理文件）
  useEffect(() => {
    if (!isRunning) { cancelAnimationFrame(rafRef.current); return; }
    const animate = () => {
      setDisplayRatio(prev => {
        const diff = targetRatioRef.current - prev;
        return Math.abs(diff) < 0.002 ? targetRatioRef.current : prev + diff * 0.08;
      });
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
    setTasks(paths.map(p => ({
      path: p, status: "pending",
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
      targetRatioRef.current = 0;
      setDisplayRatio(0);
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
        targetRatioRef.current = 1;
        await new Promise(r => setTimeout(r, 400));
        setTasks(prev => prev.map(t =>
          t.path === task.path ? { ...t, status: "done", result: toCamelResult(raw), totalElapsed } : t
        ));
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

      {/* ── 文件任务列表 ── */}
      {tasks.length > 0 && (
        <div className="flex flex-col gap-2">
          {tasks.map(task => (
            <div key={task.path} className="rounded-xl p-4 flex flex-col gap-2"
              style={{ background: "var(--color-surface-1)", border: `1px solid ${
                task.status === "done" ? "oklch(72% 0.16 145 / 30%)" :
                task.status === "error" ? "oklch(65% 0.20 20 / 30%)" :
                "var(--color-border-subtle)"
              }` }}>

              {/* 文件名 + 删除 */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm truncate font-medium" style={{ color: "var(--color-text-primary)" }}>
                  {basename(task.path)}
                </span>
                {task.status === "pending" && !isRunning && (
                  <button onClick={() => removeTask(task.path)}
                    className="shrink-0 text-xs px-2 py-0.5 rounded"
                    style={{ color: "var(--color-text-tertiary)", background: "var(--color-surface-2)" }}>
                    移除
                  </button>
                )}
                {task.status === "processing" && (
                  <span className="text-xs shrink-0" style={{ color: "var(--color-accent)" }}>
                    {task.progress.message || "处理中..."}
                  </span>
                )}
                {task.status === "done" && (
                  <span className="text-xs shrink-0" style={{ color: "var(--color-success)" }}>
                    ✓ 完成{task.totalElapsed != null ? `  ${task.totalElapsed.toFixed(0)}s` : ""}
                  </span>
                )}
                {task.status === "error" && (
                  <span className="text-xs shrink-0" style={{ color: "var(--color-danger)" }}>✗ 失败</span>
                )}
              </div>

              {/* 进度条 */}
              {task.status === "processing" && (
                <div>
                  <div className="flex justify-between text-xs mb-1" style={{ color: "var(--color-text-tertiary)" }}>
                    <span>{task.progress.message || task.progress.stage}</span>
                    <span className="flex items-center gap-2">
                      {task.progress.elapsed_secs != null && (
                        <span style={{ color: "var(--color-text-tertiary)" }}>
                          {task.progress.elapsed_secs.toFixed(0)}s
                        </span>
                      )}
                      {Math.round(displayRatio * 100)}%
                    </span>
                  </div>
                  <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--color-surface-3)" }}>
                    <div className="h-full rounded-full"
                      style={{ width: `${Math.round(displayRatio * 100)}%`, background: "var(--color-accent)" }} />
                  </div>
                </div>
              )}

              {/* 错误 */}
              {task.status === "error" && (
                <div className="text-xs" style={{ color: "var(--color-danger)" }}>{task.error}</div>
              )}

              {/* 结果：让用户选择保存哪种字幕 */}
              {task.status === "done" && task.result && (
                <div className="flex flex-col gap-2">
                  <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
                    共 {task.result.segments.length} 条字幕，选择要保存的格式：
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { label: "原文字幕", content: task.result.originalSrt, path: task.result.originalPath },
                      { label: "译文字幕", content: task.result.translatedSrt, path: task.result.translatedPath },
                      ...(task.result.bilingualSrt ? [{ label: "双语字幕", content: task.result.bilingualSrt, path: task.result.bilingualPath ?? "" }] : []),
                    ].map(({ label, content, path }) => (
                      <button key={label}
                        onClick={async () => {
                          if (!isTauri) return;
                          const { invoke } = await import("@tauri-apps/api/core");
                          await invoke("save_srt", { path, content });
                          invoke("reveal_in_finder", { path });
                        }}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium"
                        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }}>
                        ↓ {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

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
                <div className="flex flex-col gap-1.5">
                  {WHISPER_MODELS.map(m => {
                    const downloaded = downloadedModels.has(m.name);
                    const isSelected = settings.whisperModel === m.name;
                    const isDownloading = downloadingModel === m.name;
                    return (
                      <div key={m.name} className="flex items-center justify-between gap-2">
                        <button
                          onClick={() => set("whisperModel", m.name)}
                          className="flex items-center gap-2 flex-1 text-left rounded-lg px-3 py-1.5 text-xs transition-all"
                          style={{
                            background: isSelected ? "var(--color-accent-muted)" : "var(--color-surface-2)",
                            border: `1px solid ${isSelected ? "var(--color-accent)" : "var(--color-border)"}`,
                            color: isSelected ? "var(--color-accent)" : "var(--color-text-primary)",
                          }}>
                          <span className="font-medium">{m.label}</span>
                          <span style={{ color: "var(--color-text-tertiary)" }}>{m.size}</span>
                          {downloaded && <span style={{ color: "var(--color-success)" }}>✓</span>}
                        </button>
                        {!downloaded && (
                          <button
                            onClick={() => downloadModel(m.name)}
                            disabled={isDownloading}
                            className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium disabled:opacity-50"
                            style={{ background: "var(--color-accent)", color: "white" }}>
                            {isDownloading ? "下载中..." : "下载"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
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
