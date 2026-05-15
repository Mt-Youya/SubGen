"use client";

import { useEffect, useState } from "react";
import { DesktopSubtitlePanel } from "@/components/DesktopSubtitlePanel";
import { ExtractPanel } from "@/components/ExtractPanel";

type Tab = "subtitle" | "extract";
type FfmpegState = "checking" | "ok" | "missing" | "downloading" | "error";

function hasTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function FfmpegBanner({ state, error, onDownload }: {
  state: FfmpegState;
  error: string;
  onDownload: () => void;
}) {
  if (state === "ok" || state === "checking") return null;

  if (state === "downloading") {
    return (
      <div className="mx-auto mt-4 max-w-xl rounded-xl px-5 py-4 text-sm flex items-center gap-3"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}>
        <svg className="animate-spin shrink-0" width="16" height="16" viewBox="0 0 16 16" fill="none"
          style={{ color: "var(--color-accent)" }}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="20 18" />
        </svg>
        <span style={{ color: "var(--color-text-secondary)" }}>正在下载 ffmpeg，请稍候...</span>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="mx-auto mt-4 max-w-xl rounded-xl px-5 py-4 text-sm"
        style={{ background: "oklch(65% 0.20 20 / 8%)", border: "1px solid oklch(65% 0.20 20 / 20%)", color: "var(--color-danger)" }}>
        ✗ {error}
      </div>
    );
  }

  // missing
  return (
    <div className="mx-auto mt-4 max-w-xl rounded-xl px-5 py-4 flex items-start gap-4"
      style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border-subtle)" }}>
      <div className="flex-1">
        <p className="text-sm font-medium mb-1" style={{ color: "var(--color-text-primary)" }}>
          缺少 ffmpeg
        </p>
        <p className="text-xs leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
          字幕生成和音频提取需要 ffmpeg。点击下载静态版本（约 40MB）到应用目录，无需系统安装。
        </p>
      </div>
      <button
        onClick={onDownload}
        className="shrink-0 rounded-lg px-4 py-2 text-sm font-medium"
        style={{ background: "var(--color-accent)", color: "white" }}
      >
        下载
      </button>
    </div>
  );
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("subtitle");
  const [ffmpegState, setFfmpegState] = useState<FfmpegState>("checking");
  const [ffmpegError, setFfmpegError] = useState("");

  useEffect(() => {
    if (!hasTauri()) {
      setFfmpegState("ok"); // 浏览器预览模式跳过检测
      return;
    }
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string | null>("check_ffmpeg").then(path => {
        setFfmpegState(path ? "ok" : "missing");
      }).catch(() => setFfmpegState("missing"));
    });
  }, []);

  const handleDownload = async () => {
    setFfmpegState("downloading");
    setFfmpegError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("download_ffmpeg");
      setFfmpegState("ok");
    } catch (e) {
      setFfmpegError(String(e));
      setFfmpegState("error");
    }
  };

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="px-6 pt-8 pb-0 text-center">
        <h1
          className="text-3xl font-semibold tracking-tight mb-6"
          style={{ color: "var(--color-text-primary)" }}
        >
          SubGen
        </h1>

        <div
          className="inline-flex rounded-xl p-1 gap-1"
          style={{ background: "var(--color-surface-2)" }}
        >
          {(
            [
              { key: "subtitle", label: "字幕生成" },
              { key: "extract", label: "音频提取" },
            ] as { key: Tab; label: string }[]
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="px-5 py-2 rounded-lg text-sm font-medium transition-all"
              style={
                tab === key
                  ? {
                      background: "var(--color-surface-0)",
                      color: "var(--color-text-primary)",
                      boxShadow: "0 1px 3px oklch(0% 0 0 / 30%)",
                    }
                  : { color: "var(--color-text-secondary)" }
              }
            >
              {label}
            </button>
          ))}
        </div>

        <FfmpegBanner state={ffmpegState} error={ffmpegError} onDownload={handleDownload} />
      </header>

      <main className="flex-1 px-4 pt-8 pb-16">
        {/* 两个 Tab 同时挂载，用 display:none 隐藏非活跃的，状态不丢失 */}
        <div className="flex items-start justify-center" style={{ display: tab === "subtitle" ? "flex" : "none" }}>
          <div className="w-full max-w-6xl">
            <DesktopSubtitlePanel />
          </div>
        </div>
        <div className="flex items-start justify-center" style={{ display: tab === "extract" ? "flex" : "none" }}>
          <div className="w-full max-w-2xl">
            <ExtractPanel />
          </div>
        </div>
      </main>
    </div>
  );
}
