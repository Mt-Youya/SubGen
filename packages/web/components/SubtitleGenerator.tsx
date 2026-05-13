"use client";

import { useState, useCallback } from "react";
import type { Segment } from "@subgen/shared";
import { DropZone, MAX_SIZE } from "./ui/DropZone";
import { LanguageSelect } from "./ui/LanguageSelect";
import { ProgressBar } from "./ui/ProgressBar";
import { ResultPanel } from "./ui/ResultPanel";
import { compressAudio } from "@/lib/compress";

export type Step = "idle" | "compressing" | "uploading" | "processing" | "done" | "error";

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

export function SubtitleGenerator() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceLang, setSourceLang] = useState("ja");
  const [targetLang, setTargetLang] = useState("ZH");
  const [bilingual, setBilingual] = useState(true);
  const [step, setStep] = useState<Step>("idle");
  const [compressLabel, setCompressLabel] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<TranscribeResult | null>(null);

  const handleFile = useCallback((f: File) => {
    setFile(f);
    setResult(null);
    setError("");
    setStep("idle");
  }, []);

  const handleSubmit = async () => {
    if (!file) return;

    setError("");
    setResult(null);

    try {
      let uploadFile = file;

      // 超过 25 MB 时先在浏览器内压缩
      if (file.size > MAX_SIZE) {
        setStep("compressing");
        setCompressLabel("解码音频...");
        uploadFile = await compressAudio(file, ({ phase, ratio }) => {
          if (phase === "decoding") {
            setCompressLabel(`解码音频 ${Math.round(ratio * 100)}%`);
          } else {
            setCompressLabel(`生成 WAV ${Math.round(ratio * 100)}%`);
          }
        });

        // 压缩后仍然超过限制（极少见）则报错
        if (uploadFile.size > MAX_SIZE) {
          throw new Error(
            `压缩后仍有 ${(uploadFile.size / 1024 / 1024).toFixed(1)} MB，超过 25 MB 限制。请截取较短片段后重试。`
          );
        }
      }

      setStep("uploading");
      const fd = new FormData();
      fd.append("file", uploadFile);
      fd.append("sourceLang", sourceLang);
      fd.append("targetLang", targetLang);
      fd.append("bilingual", String(bilingual));

      setStep("processing");
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setStep("done");
      setResult(data);
    } catch (err) {
      setStep("error");
      setError(err instanceof Error ? err.message : "未知错误");
    }
  };

  const isProcessing = step === "compressing" || step === "uploading" || step === "processing";
  const needsCompress = file ? file.size > MAX_SIZE : false;

  const buttonLabel = () => {
    if (step === "compressing") return compressLabel || "压缩中...";
    if (step === "uploading") return "上传中...";
    if (step === "processing") return "识别与翻译中...";
    if (needsCompress) return "自动压缩并生成字幕";
    return "生成字幕";
  };

  return (
    <div className="space-y-3">
      {/* Upload */}
      <DropZone file={file} onFile={handleFile} disabled={isProcessing} />

      {/* Options */}
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

      {/* Submit button */}
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

      {/* Progress */}
      {isProcessing && <ProgressBar step={step} />}

      {/* Error */}
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

      {/* Results */}
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
