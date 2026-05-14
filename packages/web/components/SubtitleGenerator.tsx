"use client";

import { useState, useCallback, useRef } from "react";
import type { Segment } from "@subgen/shared";
import { DropZone, MAX_SIZE } from "./ui/DropZone";
import { LanguageSelect } from "./ui/LanguageSelect";
import { ProgressBar } from "./ui/ProgressBar";
import { ResultPanel } from "./ui/ResultPanel";
import { compressAudio } from "@/lib/compress";

export type Step = "idle" | "compressing" | "uploading" | "processing" | "done" | "error";

export interface TaskProgress {
  status: "pending" | "done" | "error";
  stage: string;
  stage_progress: number;  // 当前阶段内 0.0 ~ 1.0
  message: string;
}

// 各阶段权重（总和 1.0），用于合并为总进度
const STAGE_WEIGHTS: Record<string, [number, number]> = {
  // [起点, 权重]
  pending:      [0.00, 0.00],
  extracting:   [0.00, 0.10],
  transcribing: [0.10, 0.60],
  translating:  [0.70, 0.28],
  done:         [0.98, 0.02],
};

export function calcTotalProgress(stage: string, stage_progress: number): number {
  const w = STAGE_WEIGHTS[stage];
  if (!w) return 0;
  return Math.min(1, w[0] + w[1] * stage_progress);
}

export interface TranscribeResult {
  segments: Segment[];
  translated: Segment[];
  srt: {
    original: string;
    translated: string;
    bilingual: string | null;
  };
}

export const SOURCE_LANGUAGES = [
  { code: "ja", label: "日语", flag: "🇯🇵" },
  { code: "zh", label: "中文", flag: "🇨🇳" },
  { code: "en", label: "英语", flag: "🇺🇸" },
  { code: "ko", label: "韩语", flag: "🇰🇷" },
  { code: "fr", label: "法语", flag: "🇫🇷" },
  { code: "de", label: "德语", flag: "🇩🇪" },
  { code: "es", label: "西班牙语", flag: "🇪🇸" },
];

export const TARGET_LANGUAGES = [
  { code: "ZH", label: "中文（简体）", flag: "🇨🇳" },
  { code: "ZH-TW", label: "中文（繁体）", flag: "🇹🇼" },
  { code: "EN-US", label: "英语", flag: "🇺🇸" },
  { code: "JA", label: "日语", flag: "🇯🇵" },
  { code: "KO", label: "韩语", flag: "🇰🇷" },
  { code: "FR", label: "法语", flag: "🇫🇷" },
  { code: "DE", label: "德语", flag: "🇩🇪" },
];

const POLL_INTERVAL = 1500;

export function SubtitleGenerator() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceLang, setSourceLang] = useState("ja");
  const [targetLang, setTargetLang] = useState("ZH");
  const [bilingual, setBilingual] = useState(true);
  const [step, setStep] = useState<Step>("idle");
  const [compressLabel, setCompressLabel] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<TranscribeResult | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const handleFile = useCallback((f: File) => {
    setFile(f);
    setResult(null);
    setError("");
    setStep("idle");
    setTaskProgress(null);
    stopPolling();
  }, []);

  const pollTask = (taskId: string) => {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/transcribe/${taskId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        setTaskProgress({
          status: data.status,
          stage: data.stage,
          stage_progress: data.stage_progress ?? 0,
          message: data.message,
        });

        if (data.status === "done") {
          stopPolling();
          setStep("done");
          setResult(data.result);
        } else if (data.status === "error") {
          stopPolling();
          setStep("error");
          setError(data.message || "处理失败");
        }
      } catch (err) {
        stopPolling();
        setStep("error");
        setError("轮询任务状态失败，请刷新重试");
      }
    }, POLL_INTERVAL);
  };

  const handleSubmit = async () => {
    if (!file) return;

    setError("");
    setResult(null);
    setTaskProgress(null);
    stopPolling();

    try {
      let uploadFile = file;

      if (file.size > MAX_SIZE) {
        setStep("compressing");
        setCompressLabel("解码音频...");
        try {
          uploadFile = await compressAudio(file, ({ phase, ratio }) => {
            if (phase === "decoding") {
              setCompressLabel(`解码音频 ${Math.round(ratio * 100)}%`);
            } else {
              setCompressLabel(`生成 WAV ${Math.round(ratio * 100)}%`);
            }
          });
        } catch (compressErr) {
          if (
            compressErr instanceof Error &&
            (compressErr.name === "RangeError" ||
              compressErr.message.includes("memory") ||
              compressErr.message.includes("allocation"))
          ) {
            throw new Error("浏览器内存不足，无法压缩此文件。请截取较短片段后重试。");
          }
          throw compressErr;
        }
      }

      setStep("uploading");
      const fd = new FormData();
      fd.append("file", uploadFile);
      fd.append("sourceLang", sourceLang);
      fd.append("targetLang", targetLang);
      fd.append("bilingual", String(bilingual));

      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      // dev 模式：后端返回 task_id，开始轮询
      if (data.task_id) {
        setStep("processing");
        setTaskProgress({ status: "pending", stage: "pending", stage_progress: 0, message: "等待处理..." });
        pollTask(data.task_id);
        return;
      }

      // 生产模式：同步返回结果（兼容旧行为）
      setStep("done");
      setResult(data);
    } catch (err) {
      setStep("error");
      const msg = err instanceof Error ? err.message : "未知错误";
      if (msg.includes("fetch") || msg.includes("Failed to fetch")) {
        setError("后端服务连接失败，可能因内存不足导致崩溃。请尝试更短的音频文件。");
      } else {
        setError(msg);
      }
    }
  };

  const isProcessing = step === "compressing" || step === "uploading" || step === "processing";
  const needsCompress = file ? file.size > MAX_SIZE : false;

  const buttonLabel = () => {
    if (step === "compressing") return compressLabel || "压缩中...";
    if (step === "uploading") return "上传中...";
    if (step === "processing") return "处理中...";
    if (needsCompress) return "自动压缩并生成字幕";
    return "生成字幕";
  };

  return (
    <div className="space-y-3">
      <DropZone file={file} onFile={handleFile} disabled={isProcessing} />

      <div
        className="rounded-[var(--radius-lg)] p-4 space-y-4"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-subtle)",
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <LanguageSelect
            label="识别语言"
            value={sourceLang}
            onChange={setSourceLang}
            options={SOURCE_LANGUAGES}
          />
          <LanguageSelect
            label="翻译语言"
            value={targetLang}
            onChange={setTargetLang}
            options={TARGET_LANGUAGES}
          />
        </div>

        <label className="flex items-center gap-3 cursor-pointer group">
          <div className="relative">
            <input
              type="checkbox"
              className="sr-only"
              checked={bilingual}
              onChange={(e) => setBilingual(e.target.checked)}
            />
            <div
              className="w-9 h-5 rounded-full transition-all duration-200"
              style={{ background: bilingual ? "var(--color-accent)" : "var(--color-surface-3)" }}
            />
            <div
              className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200 shadow-sm"
              style={{ transform: bilingual ? "translateX(16px)" : "translateX(0)" }}
            />
          </div>
          <span className="text-sm select-none" style={{ color: "var(--color-text-secondary)" }}>
            生成双语字幕
          </span>
        </label>
      </div>

      <button
        onClick={handleSubmit}
        disabled={!file || isProcessing}
        className="w-full py-3.5 rounded-[var(--radius-lg)] text-sm font-medium transition-all duration-200"
        style={{
          background: !file || isProcessing ? "var(--color-surface-2)" : "var(--color-accent)",
          color: !file || isProcessing ? "var(--color-text-tertiary)" : "white",
          cursor: !file || isProcessing ? "not-allowed" : "pointer",
          boxShadow: !file || isProcessing ? "none" : "0 0 24px var(--color-accent-glow)",
        }}
      >
        {isProcessing ? (
          <span className="flex items-center justify-center gap-2">
            <Spinner />
            {buttonLabel()}
          </span>
        ) : (
          buttonLabel()
        )}
      </button>

      {isProcessing && <ProgressBar step={step} taskProgress={taskProgress} />}

      {step === "error" && (
        <div
          className="rounded-[var(--radius-md)] px-4 py-3 text-sm animate-fade-up"
          style={{
            background: "oklch(65% 0.20 20 / 8%)",
            border: "1px solid oklch(65% 0.20 20 / 25%)",
            color: "var(--color-danger)",
          }}
        >
          <span className="font-medium">出错了：</span>{error}
        </div>
      )}

      {step === "done" && result && (
        <ResultPanel
          result={result}
          baseName={file?.name.replace(/\.[^.]+$/, "") ?? "subtitle"}
          sourceLang={sourceLang}
          targetLang={targetLang}
        />
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
