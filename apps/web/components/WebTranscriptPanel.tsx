"use client";

import { useState, useCallback, useRef } from "react";
import type { Segment } from "@subgen/shared";
import { segmentsToSrt } from "@subgen/shared";
import { LanguageSelect } from "@/components/ui/LanguageSelect";

const SOURCE_LANGUAGES = [
  { code: "ja", label: "日语", flag: "🇯🇵" },
  { code: "zh", label: "中文", flag: "🇨🇳" },
  { code: "en", label: "英语", flag: "🇺🇸" },
  { code: "ko", label: "韩语", flag: "🇰🇷" },
  { code: "fr", label: "法语", flag: "🇫🇷" },
  { code: "de", label: "德语", flag: "🇩🇪" },
  { code: "es", label: "西班牙语", flag: "🇪🇸" },
];

const AUDIO_EXTS = ["wav", "mp3", "m4a", "aac", "flac", "ogg", "wma", "opus", "m4b", "webm"];

type FileStatus = "pending" | "uploading" | "processing" | "done" | "error";

interface FileTask {
  id: string;
  file: File;
  status: FileStatus;
  progress: string;
  segments: Segment[] | null;
  error: string;
}

function pollTask(taskId: string, signal?: AbortSignal): Promise<{ segments: Segment[] }> {
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      if (signal?.aborted) { clearInterval(interval); reject(new Error("已取消")); return; }
      try {
        const res = await fetch(`/api/transcribe/${taskId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.status === "done") { clearInterval(interval); resolve(data.result); }
        else if (data.status === "error") { clearInterval(interval); reject(new Error(data.message || "处理失败")); }
      } catch (err) {
        clearInterval(interval);
        reject(err);
      }
    }, 1500);
  });
}

function formatBytes(b: number) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + " GB";
  if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(0) + " KB";
  return b + " B";
}

export function WebTranscriptPanel() {
  const [tasks, setTasks] = useState<FileTask[]>([]);
  const [sourceLang, setSourceLang] = useState("ja");
  const [isRunning, setIsRunning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const addFiles = useCallback((fileList: FileList) => {
    const newTasks: FileTask[] = Array.from(fileList)
      .filter((f) => {
        const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
        return AUDIO_EXTS.includes(ext);
      })
      .map((f) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file: f,
        status: "pending" as FileStatus,
        progress: "",
        segments: null,
        error: "",
      }));

    setTasks((prev) => {
      const existing = new Set(prev.map((t) => t.file.name));
      return [...prev, ...newTasks.filter((t) => !existing.has(t.file.name))];
    });
  }, []);

  const handleSubmit = async () => {
    const pending = tasks.filter((t) => t.status === "pending" || t.status === "error");
    if (pending.length === 0) return;

    setIsRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;

    for (const task of pending) {
      if (controller.signal.aborted) break;

      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: "uploading", progress: "上传中..." } : t)));

      try {
        const fd = new FormData();
        fd.append("file", task.file);
        fd.append("sourceLang", sourceLang);
        fd.append("targetLang", "none"); // transcription only, no translation
        fd.append("bilingual", "false");
        fd.append("skipCache", "true");

        setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, progress: "识别中..." } : t)));

        const res = await fetch("/api/transcribe", { method: "POST", body: fd, signal: controller.signal });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        let segments: Segment[];

        if (data.task_id) {
          // Async processing (Python backend)
          setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, progress: "服务器处理中..." } : t)));
          const result = await pollTask(data.task_id, controller.signal);
          segments = result.segments ?? [];
        } else {
          // Sync response (production cloud API)
          segments = data.segments ?? [];
        }

        setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: "done", segments, progress: "" } : t)));
      } catch (err) {
        if (controller.signal.aborted) break;
        const msg = err instanceof Error ? err.message : "未知错误";
        setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: "error", error: msg, progress: "" } : t)));
      }
    }

    setIsRunning(false);
    abortRef.current = null;
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setIsRunning(false);
  };

  const downloadSrt = (name: string, segments: Segment[]) => {
    const srt = segmentsToSrt(segments);
    const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name.replace(/\.[^.]+$/, ".srt");
    a.click();
    URL.revokeObjectURL(url);
  };

  const doneCount = tasks.filter((t) => t.status === "done").length;
  const errorCount = tasks.filter((t) => t.status === "error").length;

  return (
    <div className="flex flex-col gap-3">
      <div
        className="rounded-md p-5 flex flex-col gap-4"
        style={{ background: "var(--color-surface-1)", border: "0.5px solid var(--color-border-subtle)" }}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.wma,.opus"
          className="sr-only"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {tasks.length === 0 ? (
          <div
            className="rounded-md transition-all duration-200 cursor-pointer"
            style={{ border: "1.5px dashed var(--color-border)", background: "var(--color-surface-2)", padding: "28px 20px" }}
            onClick={() => fileRef.current?.click()}
          >
            <div className="flex flex-col items-center gap-3 text-center">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
                style={{ color: "var(--color-text-tertiary)" }}>
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              </svg>
              <div>
                <p className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>点击选择音频文件</p>
                <p className="text-xs mt-1" style={{ color: "var(--color-text-tertiary)" }}>支持 WAV、MP3、M4A、FLAC 等常见音频格式</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>音频文件</p>
            {tasks.map((t, i) => (
              <div key={t.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded"
                style={{ background: "var(--color-surface-2)" }}>
                <span style={{ fontSize: "11px", fontFamily: "JetBrains Mono, monospace", color: "var(--color-text-tertiary)", width: "18px", flexShrink: 0 }}>{i + 1}.</span>
                <span className="truncate flex-1" style={{ color: "var(--color-text-secondary)" }}>{t.file.name}</span>
                <span style={{ color: "var(--color-text-tertiary)" }}>{formatBytes(t.file.size)}</span>
                <button
                  onClick={() => setTasks((prev) => prev.filter((x) => x.id !== t.id))}
                  className="px-1.5 py-0.5 rounded"
                  style={{ color: "var(--color-text-tertiary)" }}
                  disabled={isRunning}
                >
                  ✕
                </button>
              </div>
            ))}
            <button onClick={() => fileRef.current?.click()}
              className="text-xs px-2 py-1 rounded self-start"
              style={{ color: "var(--color-accent)" }}
              disabled={isRunning}>
              + 添加文件
            </button>
          </div>
        )}

        <div>
          <LanguageSelect label="识别语言" value={sourceLang} onChange={setSourceLang} options={SOURCE_LANGUAGES} disabled={isRunning} />
        </div>

        <div className="flex gap-2">
          {isRunning ? (
            <button onClick={handleCancel}
              className="w-full py-3.5 rounded-[var(--radius-lg)] text-sm font-medium"
              style={{ background: "var(--color-surface-2)", color: "var(--color-danger)", border: "1px solid oklch(65% 0.20 20 / 25%)" }}>
              停止
            </button>
          ) : (
            <button onClick={handleSubmit}
              disabled={tasks.length === 0}
              className="w-full py-3.5 rounded-[var(--radius-lg)] text-sm font-medium transition-all duration-200"
              style={{
                background: tasks.length === 0 ? "var(--color-surface-2)" : "var(--color-accent)",
                color: tasks.length === 0 ? "var(--color-text-tertiary)" : "white",
                cursor: tasks.length === 0 ? "not-allowed" : "pointer",
              }}>
              {tasks.length === 0 ? "请先选择音频文件" : `开始转录（${tasks.filter((t) => t.status === "pending" || t.status === "error").length} 个文件）`}
            </button>
          )}
        </div>
      </div>

      {tasks.some((t) => t.status === "uploading" || t.status === "processing" || t.status === "done" || t.status === "error") && (
        <div className="rounded-md overflow-hidden" style={{ background: "var(--color-surface-1)", border: "0.5px solid var(--color-border-subtle)" }}>
          <div className="px-4 py-2.5 flex items-center justify-between" style={{ borderBottom: "0.5px solid var(--color-border-subtle)" }}>
            <span className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>转录队列</span>
            <div className="flex items-center gap-2">
              {doneCount > 0 && <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>{doneCount} 完成</span>}
              {errorCount > 0 && <span className="text-xs" style={{ color: "var(--color-danger)" }}>{errorCount} 失败</span>}
              <span className="px-2 py-0.5 rounded-full text-xs font-medium"
                style={{ background: "var(--color-accent-muted)", color: "var(--color-accent)", border: "0.5px solid rgba(99,102,241,0.25)" }}>
                {tasks.length} 个文件
              </span>
            </div>
          </div>
          <div className="divide-y" style={{ borderColor: "var(--color-border-subtle)" }}>
            {tasks.map((t, i) => (
              <div key={t.id} className="px-4 py-3 flex items-center gap-3">
                <span className="text-xs shrink-0" style={{ color: "var(--color-text-tertiary)", fontFamily: "JetBrains Mono, monospace" }}>{i + 1}.</span>
                {t.status === "uploading" || t.status === "processing" ? (
                  <span className="w-4 h-4 rounded-full border-2 animate-spin shrink-0"
                    style={{ borderColor: "var(--color-accent) var(--color-accent-track) var(--color-accent-track) var(--color-accent-track)" }} />
                ) : t.status === "done" ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0" style={{ color: "oklch(65% 0.15 145)" }}>
                    <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M5 8l2.5 2.5L11 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : t.status === "error" ? (
                  <span className="shrink-0" style={{ color: "var(--color-danger)" }}>✗</span>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0"
                    style={{ color: "var(--color-text-tertiary)" }}>
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  </svg>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate" style={{ color: "var(--color-text-primary)", fontFamily: "JetBrains Mono, monospace", fontSize: "13px" }}>{t.file.name}</p>
                  {t.status === "uploading" && <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>{t.progress}</p>}
                  {t.status === "error" && <p className="text-xs" style={{ color: "var(--color-danger)" }}>{t.error}</p>}
                  {t.status === "done" && t.segments && (
                    <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>{t.segments.length} 条字幕</p>
                  )}
                </div>
                {t.status === "done" && t.segments && (
                  <button onClick={() => downloadSrt(t.file.name, t.segments!)}
                    className="px-2.5 py-1 text-xs rounded shrink-0"
                    style={{ background: "var(--color-accent)", color: "white" }}>
                    下载 SRT
                  </button>
                )}
                {t.status === "error" && !isRunning && (
                  <button onClick={() => setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: "pending", error: "" } : x)))}
                    className="px-2.5 py-1 text-xs rounded shrink-0"
                    style={{ color: "var(--color-accent)", background: "var(--color-accent-muted)" }}>
                    重试
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
