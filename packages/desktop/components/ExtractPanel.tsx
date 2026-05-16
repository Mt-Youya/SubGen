"use client";

import { useState, useCallback, useEffect, useRef } from "react";

interface ExtractOptions {
  inputs: string[];
  output_dir: string;
  duration: number;
}

interface ExtractFileResult {
  input: string;
  output: string;
  elapsed_secs?: number;
  error: string | null;
}

interface ExtractResult {
  files: ExtractFileResult[];
}

interface ExtractProgress {
  index: number;
  total: number;
  ratio: number;
  message: string;
  elapsed_secs?: number;
}

type Status = "idle" | "extracting" | "done" | "error";

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

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

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

function formatBytes(b: number) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + " GB";
  if (b >= 1048576)    return (b / 1048576).toFixed(1) + " MB";
  if (b >= 1024)       return (b / 1024).toFixed(0) + " KB";
  return b + " B";
}

export function ExtractPanel() {
  const [inputs, setInputs] = useState<string[]>([]);
  const [inputSizes, setInputSizes] = useState<number[]>([]);
  const [outputDir, setOutputDir] = useState("");
  const [duration, setDuration] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [results, setResults] = useState<ExtractFileResult[]>([]);
  const [error, setError] = useState("");
  const [isTauri, setIsTauri] = useState(false);

  // 进度：每个文件独立进度 + 平滑插值
  const [fileProgress, setFileProgress] = useState<number[]>([]);
  const [displayProgress, setDisplayProgress] = useState<number[]>([]);
  const targetProgressRef = useRef<number[]>([]);
  const rafRef = useRef<number>(0);
  const [progressMessage, setProgressMessage] = useState("");

  useEffect(() => {
    setIsTauri(hasTauriRuntime());
  }, []);

  // 监听 extract-progress 事件
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<ExtractProgress>("extract-progress", e => {
        const { index, total, ratio, message } = e.payload;
        setProgressMessage(message);
        setFileProgress(prev => {
          const next = prev.length === total ? [...prev] : new Array(total).fill(0);
          next[index] = ratio;
          return next;
        });
        targetProgressRef.current = (() => {
          const arr = targetProgressRef.current.length === total
            ? [...targetProgressRef.current]
            : new Array(total).fill(0);
          arr[index] = ratio;
          return arr;
        })();
      }))
      .then(u => { if (disposed) u(); else off = u; })
      .catch(() => { });
    return () => { disposed = true; off?.(); };
  }, [isTauri]);

  // 进度平滑动画
  useEffect(() => {
    if (status !== "extracting") {
      cancelAnimationFrame(rafRef.current);
      return;
    }
    const animate = () => {
      setDisplayProgress(prev => {
        const targets = targetProgressRef.current;
        if (!targets.length) return prev;
        const next = targets.length === prev.length ? [...prev] : new Array(targets.length).fill(0);
        let changed = false;
        for (let i = 0; i < targets.length; i++) {
          const diff = targets[i] - (next[i] ?? 0);
          if (Math.abs(diff) > 0.002) {
            next[i] = (next[i] ?? 0) + diff * 0.08;
            changed = true;
          } else {
            next[i] = targets[i];
          }
        }
        return changed ? next : prev;
      });
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [status]);

  const pickInputs = useCallback(async () => {
    if (!isTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: true,
      filters: [{ name: "视频文件", extensions: ["mp4", "mkv", "ts", "m2ts", "webm", "avi", "mov", "wmv", "flv"] }],
    });
    if (selected) {
      const paths = Array.isArray(selected) ? selected : [selected];
      setInputs(paths);
      const { invoke } = await import("@tauri-apps/api/core");
      const sizes = await invoke<number[]>("get_file_sizes", { paths }).catch(() => paths.map(() => 0));
      setInputSizes(sizes);
    }
  }, [isTauri]);

  const pickOutput = useCallback(async () => {
    if (!isTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") setOutputDir(sel);
  }, [isTauri]);

  const handleExtract = useCallback(async () => {
    if (!inputs.length || !outputDir) return;
    setStatus("extracting");
    setError("");
    setResults([]);
    targetProgressRef.current = new Array(inputs.length).fill(0);
    setDisplayProgress(new Array(inputs.length).fill(0));
    setFileProgress(new Array(inputs.length).fill(0));
    setProgressMessage("启动中...");

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<ExtractResult>("extract_audio", {
        opts: { inputs, output_dir: outputDir, duration } as ExtractOptions,
      });
      // 完成，推满进度
      targetProgressRef.current = new Array(inputs.length).fill(1);
      await new Promise(r => setTimeout(r, 400));
      setResults(res.files);
      setStatus("done");
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  }, [inputs, outputDir, duration]);

  // 整体进度 = 所有文件进度均值
  const overallDisplay = displayProgress.length
    ? displayProgress.reduce((a, b) => a + b, 0) / displayProgress.length
    : 0;

  return (
    <div className="flex flex-col gap-3 max-w-xl mx-auto w-full">
      <div className="rounded-2xl p-5 flex flex-col gap-3"
        style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border-subtle)" }}>

        <Row label="视频文件">
          <div className="flex gap-2">
            <button onClick={pickInputs}
              className="flex-1 min-w-0 rounded-lg px-3 py-2 text-sm text-left truncate"
              style={{
                background: "var(--color-surface-2)", border: "1px solid var(--color-border)",
                color: inputs.length ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
              }}>
              {inputs.length === 0
                ? "点击选择视频（支持多选）"
                : inputs.length === 1
                  ? basename(inputs[0])
                  : `已选 ${inputs.length} 个文件`}
            </button>
            <button onClick={pickInputs}
              className="rounded-lg px-4 py-2 text-sm font-medium shrink-0"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-primary)" }}>
              浏览
            </button>
          </div>
        </Row>

        {inputs.length > 0 && (
          <Row label="">
            <div className="flex flex-col gap-1 max-h-28 overflow-y-auto">
              {inputs.map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-xs"
                  style={{ color: "var(--color-text-tertiary)" }}>
                  {inputs.length > 1 && <span className="shrink-0">{i + 1}.</span>}
                  <span className="truncate flex-1">{basename(f)}</span>
                  {inputSizes[i] != null && inputSizes[i] > 0 && (
                    <span className="shrink-0 tabular-nums">{formatBytes(inputSizes[i])}</span>
                  )}
                </div>
              ))}
            </div>
          </Row>
        )}

        <Row label="输出目录">
          <div className="flex gap-2">
            <button onClick={pickOutput}
              className="flex-1 min-w-0 rounded-lg px-3 py-2 text-sm text-left truncate"
              style={{
                background: "var(--color-surface-2)", border: "1px solid var(--color-border)",
                color: outputDir ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
              }}>
              {outputDir ? basename(outputDir) : "点击选择保存目录"}
            </button>
            <button onClick={pickOutput}
              className="rounded-lg px-4 py-2 text-sm font-medium shrink-0"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-primary)" }}>
              浏览
            </button>
          </div>
        </Row>

        <Row label="时长(秒)">
          <div className="flex items-center gap-2">
            <input type="number" min={0} value={duration}
              onChange={e => setDuration(Number(e.target.value))}
              className="w-24 rounded-lg px-3 py-2 text-sm outline-none"
              style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }} />
            <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>0 = 完整</span>
          </div>
        </Row>

        <button onClick={handleExtract}
          disabled={!inputs.length || !outputDir || status === "extracting"}
          className="mt-1 w-full rounded-xl py-2.5 text-sm font-semibold transition-opacity disabled:opacity-40"
          style={{ background: "var(--color-accent)", color: "white" }}>
          {status === "extracting" ? "提取中..." : "开始提取"}
        </button>

        {status === "extracting" && (
          <div>
            <div className="flex justify-between text-xs mb-1.5" style={{ color: "var(--color-text-tertiary)" }}>
              <span>{progressMessage}</span>
              <span>{Math.round(overallDisplay * 100)}%</span>
            </div>
            {/* 多文件时显示每个文件的进度条 */}
            {inputs.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                {inputs.map((f, i) => (
                  <div key={i}>
                    <div className="flex justify-between text-xs mb-0.5" style={{ color: "var(--color-text-tertiary)" }}>
                      <span className="truncate max-w-[200px]">{basename(f)}</span>
                      <span>{Math.round((displayProgress[i] ?? 0) * 100)}%</span>
                    </div>
                    <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--color-surface-3)" }}>
                      <div className="h-full rounded-full transition-none"
                        style={{ width: `${Math.round((displayProgress[i] ?? 0) * 100)}%`, background: "var(--color-accent)" }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--color-surface-3)" }}>
                <div className="h-full rounded-full"
                  style={{ width: `${Math.round(overallDisplay * 100)}%`, background: "var(--color-accent)" }} />
              </div>
            )}
          </div>
        )}

        {status === "error" && (
          <div className="rounded-xl px-4 py-3 text-sm"
            style={{ background: "oklch(65% 0.20 20 / 8%)", color: "var(--color-danger)" }}>
            ✗ {error}
          </div>
        )}
      </div>

      {status === "done" && results.length > 0 && (
        <div className="rounded-2xl p-4 flex flex-col gap-2"
          style={{ background: "oklch(72% 0.16 145 / 8%)", border: "1px solid oklch(72% 0.16 145 / 20%)" }}>
          {results.map((r, i) => (
            <div key={i} className="flex items-center justify-between gap-2 text-sm">
              {r.error ? (
                <span style={{ color: "var(--color-danger)" }}>✗ {basename(r.input)}: {r.error}</span>
              ) : (
                <span style={{ color: "var(--color-success)" }}>✓ {basename(r.output)}</span>
              )}
              {r.elapsed_secs != null && !r.error && (
                <span className="text-xs shrink-0" style={{ color: "var(--color-text-tertiary)" }}>
                  {r.elapsed_secs.toFixed(1)}s
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
