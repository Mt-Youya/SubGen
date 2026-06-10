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
  output_size?: number;
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

function basename(p: string) { return p.split(/[\\/]/).pop() ?? p; }

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

  const MEDIA_EXTS = ["mp4", "mkv", "ts", "m2ts", "webm", "avi", "mov", "wmv", "flv"];

  const addPaths = useCallback(async (newPaths: string[]) => {
    if (newPaths.length === 0) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const sizes = await invoke<number[]>("get_file_sizes", { paths: newPaths }).catch(() => newPaths.map(() => 0));
    setInputs(prev => {
      const existing = new Set(prev);
      const toAdd = newPaths.filter(p => !existing.has(p));
      if (toAdd.length === 0) return prev;
      setInputSizes(prevSizes => [
        ...prevSizes,
        ...toAdd.map(p => sizes[newPaths.indexOf(p)] ?? 0),
      ]);
      return [...prev, ...toAdd];
    });
  }, []);

  const pickInputs = useCallback(async () => {
    if (!isTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: true,
      filters: [{ name: "视频文件", extensions: MEDIA_EXTS }],
    });
    if (selected) {
      await addPaths(Array.isArray(selected) ? selected : [selected]);
    }
  }, [isTauri, addPaths]);

  const pickFolders = useCallback(async () => {
    if (!isTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: true });
    if (!sel) return;
    const dirs = Array.isArray(sel) ? sel : [sel];

    const { readDir } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    const extSet = new Set(MEDIA_EXTS);

    async function collectFiles(dir: string): Promise<string[]> {
      try {
        const entries = await readDir(dir);
        const results: string[] = [];
        for (const entry of entries) {
          const fullPath = await join(dir, entry.name);
          if (entry.isDirectory) {
            results.push(...await collectFiles(fullPath));
          } else if (entry.isFile) {
            const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
            if (extSet.has(ext)) results.push(fullPath);
          }
        }
        return results;
      } catch {
        return [];
      }
    }

    const allFiles: string[] = [];
    for (const dir of dirs) allFiles.push(...await collectFiles(dir));
    allFiles.sort();
    await addPaths(allFiles);
  }, [isTauri, addPaths]);

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
    <div className="flex flex-col gap-3 max-w-3xl mx-auto w-full">
      <div className="rounded-md p-5 flex flex-col gap-3"
        style={{ background: "var(--color-surface-1)", border: "0.5px solid var(--color-border-subtle)" }}>

        <Row label="视频文件">
          <div className="flex gap-2">
            <button onClick={pickInputs}
              className="flex-1 min-w-0 rounded-md px-3 py-2 text-sm text-left truncate"
              style={{
                background: "var(--color-surface-2)", border: "1px solid var(--color-border)",
                color: inputs.length ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
              }}>
              {inputs.length === 0
                ? "点击选择文件或文件夹"
                : inputs.length === 1
                  ? basename(inputs[0])
                  : `已选 ${inputs.length} 个文件`}
            </button>
            <button onClick={pickInputs}
              className="rounded-md px-3 py-2 text-sm font-medium shrink-0"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-primary)" }}
              title="选择文件">
              文件
            </button>
            <button onClick={pickFolders}
              className="rounded-md px-3 py-2 text-sm font-medium shrink-0"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-primary)" }}
              title="选择文件夹（自动递归扫描）">
              文件夹
            </button>
          </div>
        </Row>

        {inputs.length > 0 && (
          <Row label="">
            <div className="flex flex-col gap-1 max-h-28 overflow-y-auto">
              {inputs.map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-xs"
                  style={{ color: "var(--color-text-tertiary)" }}>
                  <span style={{ fontSize: "11px", fontFamily: "JetBrains Mono, monospace", color: "var(--color-text-tertiary)", width: "18px", flexShrink: 0 }}>{i + 1}.</span>
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
              className="flex-1 min-w-0 rounded-md px-3 py-2 text-sm text-left truncate"
              style={{
                background: "var(--color-surface-2)", border: "1px solid var(--color-border)",
                color: outputDir ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
              }}>
              {outputDir ? basename(outputDir) : "点击选择保存目录"}
            </button>
            <button onClick={pickOutput}
              className="rounded-md px-4 py-2 text-sm font-medium shrink-0"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-primary)" }}>
              浏览
            </button>
          </div>
        </Row>

        <Row label="时长(秒)">
          <div className="flex items-center gap-2">
            <input type="number" min={0} value={duration}
              onChange={e => setDuration(Number(e.target.value))}
              className="w-24 rounded-md px-3 py-2 text-sm outline-none"
              style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }} />
            <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>0 = 完整</span>
          </div>
        </Row>

        <button onClick={handleExtract}
          disabled={!inputs.length || !outputDir || status === "extracting"}
          className="mt-1 w-full rounded-md py-2.5 text-sm font-semibold transition-opacity disabled:opacity-40"
          style={{ background: "var(--color-accent)", color: "white" }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--color-accent-hover)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "var(--color-accent)"; }}>
          {status === "extracting"
            ? `提取中 (${fileProgress.filter(p => p >= 1).length}/${inputs.length})...`
            : "开始提取"}
        </button>

        {status === "error" && (
          <div className="rounded-md px-4 py-3 text-sm"
            style={{ background: "oklch(65% 0.20 20 / 8%)", color: "var(--color-danger)" }}>
            ✗ {error}
          </div>
        )}
      </div>

      {/* ── 批量完成 header ── */}
      {status === "done" && results.length > 0 && (() => {
        const doneCount = results.filter(r => !r.error).length;
        const errCount = results.filter(r => r.error).length;
        return (
          <div className="flex items-center justify-between px-4 py-3 rounded-md"
            style={{ background: "var(--color-accent-muted)", border: "1px solid oklch(65% 0.22 265 / 20%)" }}>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--color-accent)" }} />
              <span className="text-sm" style={{ color: "var(--color-accent)" }}>提取完成</span>
            </div>
            <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
              {doneCount} 个成功{errCount > 0 && ` · ${errCount} 个失败`}
            </span>
          </div>
        );
      })()}

      {/* ── 文件任务列表 ── */}
      {(status === "extracting" || status === "done" || status === "error") && inputs.length > 0 && (
        <div className="rounded-md overflow-hidden"
          style={{ background: "var(--color-surface-1)", border: "0.5px solid var(--color-border-subtle)" }}>
          <div className="px-4 py-2.5 flex items-center justify-between" style={{ borderBottom: "0.5px solid var(--color-border-subtle)" }}>
            <div className="flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                style={{ color: "var(--color-accent)", flexShrink: 0 }}>
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
              <span className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>提取队列</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-medium"
                style={{ background: "var(--color-accent-muted)", color: "var(--color-accent)", border: "0.5px solid rgba(99,102,241,0.25)" }}>
                {inputs.length} 个文件
              </span>
              {status !== "extracting" && (
                <button onClick={() => { setInputs([]); setInputSizes([]); setResults([]); setStatus("idle"); setError(""); }}
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ color: "var(--color-danger)", background: "rgba(220,50,50,0.08)", border: "0.5px solid rgba(220,50,50,0.2)" }}>
                  清空
                </button>
              )}
            </div>
          </div>
          <div className="divide-y" style={{ borderColor: "var(--color-border-subtle)" }}>
            {inputs.map((f, i) => {
              const prog = displayProgress[i] ?? 0;
              const rawProg = fileProgress[i] ?? 0;
              const result = results[i];
              const isDone = status === "done" && result != null;
              const isActive = status === "extracting";
              const hasError = isDone && !!result.error;

              return (
                <div key={i} style={{ borderColor: "var(--color-border-subtle)" }}>
                  <div className="px-4 py-3 flex items-center gap-3"
                    style={{ background: isActive ? "var(--color-surface-2)" : "transparent" }}>
                    {/* 序号 */}
                    <span style={{ fontSize: "11px", fontFamily: "JetBrains Mono, monospace", color: "var(--color-text-tertiary)", width: "18px", flexShrink: 0 }}>{i + 1}.</span>
                    {/* 状态图标 */}
                    <div className="shrink-0 w-8 h-8 rounded-md flex items-center justify-center"
                      style={{ background: "var(--color-surface-2)", color: "var(--color-text-secondary)" }}>
                      {isActive ? (
                        rawProg >= 1 ? (
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <circle cx="8" cy="8" r="7" stroke="oklch(65% 0.15 145)" strokeWidth="1.5" />
                            <path d="M5 8l2.5 2.5L11 5.5" stroke="oklch(65% 0.15 145)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          <span className="w-3 h-3 rounded-full border-2 animate-spin"
                            style={{ borderColor: "var(--color-accent) var(--color-accent-track) var(--color-accent-track) var(--color-accent-track)" }} />
                        )
                      ) : hasError ? (
                        <span style={{ color: "var(--color-danger)" }}>✗</span>
                      ) : isDone ? (
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <circle cx="8" cy="8" r="7" stroke="oklch(65% 0.15 145)" strokeWidth="1.5" />
                          <path d="M5 8l2.5 2.5L11 5.5" stroke="oklch(65% 0.15 145)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="4" width="20" height="16" rx="2" />
                          <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
                        </svg>
                      )}
                    </div>

                    {/* 文件名 + 大小 / 进度条 */}
                    <div className="flex-1 min-w-0">
                      {/* 第一行：视频文件名 + 视频大小 */}
                      <p className="text-sm font-medium truncate" style={{ color: "var(--color-text-primary)", fontFamily: "JetBrains Mono, monospace", fontSize: "13px" }}>
                        {basename(f)}
                        {inputSizes[i] > 0 && (
                          <span className="ml-2 text-xs font-normal" style={{ color: "var(--color-text-tertiary)" }}>
                            {formatBytes(inputSizes[i])}
                          </span>
                        )}
                      </p>
                      {isActive && rawProg < 1 ? (
                        /* 提取中：进度条 */
                        <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: "var(--color-accent-track)" }}>
                          <div className="h-full rounded-full"
                            style={{ transform: `scaleX(${prog})`, transformOrigin: "left", background: "var(--color-accent)" }} />
                        </div>
                      ) : isDone && !hasError && result.output ? (
                        /* 第二行：音频文件名 + 音频大小 */
                        <p className="text-xs truncate" style={{ color: "var(--color-accent)", fontFamily: "JetBrains Mono, monospace" }}>
                          ↓ {basename(result.output)}
                          {result.output_size != null && result.output_size > 0 && (
                            <span style={{ color: "var(--color-text-tertiary)" }}> · {formatBytes(result.output_size)}</span>
                          )}
                        </p>
                      ) : null}
                    </div>

                    {/* 右侧：百分比 / 用时 */}
                    <div className="shrink-0 text-xs tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
                      {isActive && rawProg < 1
                        ? `${Math.round(prog * 100)}%`
                        : isDone && !hasError && result.elapsed_secs != null
                          ? `${result.elapsed_secs.toFixed(1)}s`
                          : isDone && hasError
                            ? <span style={{ color: "var(--color-danger)" }}>失败</span>
                            : null}
                    </div>
                  </div>

                  {/* 错误详情 */}
                  {isDone && hasError && (
                    <div className="px-4 pb-3 text-xs" style={{ color: "var(--color-danger)" }}>
                      {result.error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
