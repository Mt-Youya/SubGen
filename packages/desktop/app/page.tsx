"use client";

import { useEffect, useState } from "react";
import { DesktopSubtitlePanel } from "@/components/DesktopSubtitlePanel";
import { ExtractPanel } from "@/components/ExtractPanel";

type Tab = "subtitle" | "extract";

interface Deps {
  ffmpeg: boolean;
  whisper: boolean;
  model: boolean;
  model_path: string;
}

type DepState = "checking" | "ok" | "missing" | "downloading" | "error";

function hasTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function DepsBanner({
  deps,
  state,
  error,
  downloadingWhat,
  onDownload,
}: {
  deps: Deps | null;
  state: DepState;
  error: string;
  downloadingWhat: string;
  onDownload: (what: "ffmpeg" | "model") => void;
}) {
  if (state === "checking") return null;
  if (state === "ok") return null;

  if (state === "downloading") {
    const label = downloadingWhat === "ffmpeg" ? "ffmpeg" : "Whisper 中文模型";
    return (
      <div
        className="mx-auto mt-4 max-w-xl rounded-xl px-5 py-4 text-sm flex items-center gap-3"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
      >
        <svg className="animate-spin shrink-0" width="16" height="16" viewBox="0 0 16 16" fill="none"
          style={{ color: "var(--color-accent)" }}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="20 18" />
        </svg>
        <span style={{ color: "var(--color-text-secondary)" }}>正在下载 {label}，请稍候...</span>
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

  // missing — 列出所有缺失项
  const missing: { what: "ffmpeg" | "model"; label: string; desc: string }[] = [];
  if (deps && !deps.ffmpeg) {
    missing.push({ what: "ffmpeg", label: "ffmpeg", desc: "音频提取和转码需要 ffmpeg" });
  }
  if (deps && (!deps.whisper || !deps.model)) {
    const label = !deps.whisper ? "whisper-cli" : "Whisper 中文模型";
    const desc = !deps.whisper
      ? "本地语音转文字需要 whisper-cli"
      : "本地 Whisper 需要中文模型（~466MB）";
    missing.push({ what: "model", label, desc });
  }

  if (missing.length === 0) return null;

  return (
    <div className="mx-auto mt-4 max-w-xl flex flex-col gap-2">
      {missing.map(m => (
        <div
          key={m.what}
          className="rounded-xl px-5 py-4 flex items-start gap-4"
          style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border-subtle)" }}
        >
          <div className="flex-1">
            <p className="text-sm font-medium mb-1" style={{ color: "var(--color-text-primary)" }}>
              缺少 {m.label}
            </p>
            <p className="text-xs leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
              {m.desc}
            </p>
          </div>
          <button
            onClick={() => onDownload(m.what)}
            className="shrink-0 rounded-lg px-4 py-2 text-sm font-medium"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            授权安装
          </button>
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("subtitle");
  const [deps, setDeps] = useState<Deps | null>(null);
  const [depState, setDepState] = useState<DepState>("checking");
  const [depError, setDepError] = useState("");
  const [downloadingWhat, setDownloadingWhat] = useState("");

  // 启动时统一检查依赖
  useEffect(() => {
    if (!hasTauri()) {
      setDepState("ok");
      setDeps({ ffmpeg: true, whisper: true, model: true, model_path: "" });
      return;
    }
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<Deps>("check_dependencies").then(d => {
        setDeps(d);
        setDepState(d.ffmpeg && d.whisper && d.model ? "ok" : "missing");
      }).catch(() => setDepState("missing"));
    });
  }, []);

  const handleDownload = async (what: "ffmpeg" | "model") => {
    setDepState("downloading");
    setDownloadingWhat(what);
    setDepError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (what === "ffmpeg") {
        await invoke("download_ffmpeg");
        setDeps(prev => prev ? { ...prev, ffmpeg: true } : null);
      } else {
        await invoke("download_whisper_model");
        setDeps(prev => prev ? { ...prev, whisper: true, model: true } : null);
      }
      // 重新检查确保状态正确
      const d = await invoke<Deps>("check_dependencies");
      setDeps(d);
      setDepState(d.ffmpeg && d.whisper && d.model ? "ok" : "missing");
    } catch (e) {
      setDepError(String(e));
      setDepState("error");
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

        <DepsBanner deps={deps} state={depState} error={depError} downloadingWhat={downloadingWhat} onDownload={handleDownload} />
      </header>

      <main className="flex-1 px-4 pt-8 pb-16">
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
