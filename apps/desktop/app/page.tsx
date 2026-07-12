"use client";

import { useEffect, useState } from "react";
import { DesktopSubtitlePanel } from "@/components/DesktopSubtitlePanel";
import { ExtractPanel } from "@/components/ExtractPanel";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { TranslatePanel } from "@/components/TranslatePanel";
import { ThemeToggle } from "../../web/components/ui/ThemeToggle";

type Tab = "extract" | "transcript" | "translate" | "subtitle";

interface Deps {
  ffmpeg: boolean;
  whisper: boolean;
  model: boolean;
  model_path: string;
  gpu_type?: string;
  gpu_available?: boolean;
  using_gpu?: boolean;
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
  downloadUrl,
  gpuProgress,
  gpuProgressMsg,
  onDownload,
}: {
  deps: Deps | null;
  state: DepState;
  error: string;
  downloadingWhat: string;
  downloadUrl: string;
  gpuProgress: number;
  gpuProgressMsg: string;
  onDownload: (what: "ffmpeg" | "model" | "gpu-whisper") => void;
}) {
  if (state === "checking") return null;

  // GPU 推荐横幅（在 deps 全部 ok 但未使用 GPU 加速时显示）
  const showGpuBanner =
    state === "ok" &&
    deps?.gpu_available &&
    !deps?.using_gpu &&
    deps?.gpu_type &&
    deps.gpu_type !== "metal" &&
    deps.gpu_type !== "cpu";
  const gpuLabel =
    deps?.gpu_type === "cuda" ? "NVIDIA CUDA" : "Vulkan";

  if (state === "downloading") {
    const label =
      downloadingWhat === "ffmpeg" ? "ffmpeg" :
      downloadingWhat === "gpu-whisper" ? `${gpuLabel} 加速版 Whisper` :
      "Whisper 中文模型";
    const showProgress = downloadingWhat === "gpu-whisper" && gpuProgress > 0;
    return (
      <div
        className="mx-auto mt-4 max-w-xl rounded-md px-5 py-4 text-sm flex flex-col gap-2"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
      >
        <div className="flex items-center gap-3">
          <svg className="animate-spin shrink-0" width="16" height="16" viewBox="0 0 16 16" fill="none"
            style={{ color: "var(--color-accent)" }}>
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="20 18" />
          </svg>
          <span style={{ color: "var(--color-text-secondary)" }}>
            {showProgress ? gpuProgressMsg : `正在下载 ${label}，请稍候...`}
          </span>
        </div>
        {showProgress && (
          <div className="w-full rounded-full h-1.5" style={{ background: "var(--color-border)" }}>
            <div
              className="h-1.5 rounded-full transition-all duration-300"
              style={{
                width: `${Math.round(gpuProgress * 100)}%`,
                background: "var(--color-accent)",
              }}
            />
          </div>
        )}
        {downloadingWhat === "gpu-whisper" && downloadUrl && (
          <div className="text-xs break-all" style={{ color: "var(--color-text-tertiary)" }}>
            {downloadUrl}
          </div>
        )}
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="mx-auto mt-4 max-w-xl rounded-md px-5 py-4 text-sm"
        style={{ background: "oklch(65% 0.20 20 / 8%)", border: "1px solid oklch(65% 0.20 20 / 20%)", color: "var(--color-danger)" }}>
        ✗ {error}
      </div>
    );
  }

  // GPU 推荐横幅
  if (showGpuBanner) {
    return (
      <div className="mx-auto mt-4 max-w-xl rounded-md px-5 py-4"
        style={{ background: "oklch(65% 0.15 260 / 6%)", border: "1px solid oklch(65% 0.15 260 / 20%)" }}>
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <p className="text-sm font-medium mb-1" style={{ color: "var(--color-accent)" }}>
              检测到 {gpuLabel} GPU
            </p>
            <p className="text-xs leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
              下载 {gpuLabel} 加速版 Whisper 可获得 5-10 倍转录速度提升
            </p>
          </div>
          <button
            onClick={() => onDownload("gpu-whisper")}
            className="shrink-0 rounded-md px-4 py-2 text-sm font-medium"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            下载
          </button>
        </div>
      </div>
    );
  }

  if (state === "ok") return null;

  // missing — 列出所有缺失项
  const missing: { what: "ffmpeg" | "model" | "gpu-whisper"; label: string; desc: string }[] = [];
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
          className="rounded-md px-5 py-4 flex items-start gap-4"
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
            className="shrink-0 rounded-md px-4 py-2 text-sm font-medium"
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
  const [tab, setTab] = useState<Tab>("extract");
  const [deps, setDeps] = useState<Deps | null>(null);
  const [depState, setDepState] = useState<DepState>("checking");
  const [depError, setDepError] = useState("");
  const [downloadingWhat, setDownloadingWhat] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [gpuProgress, setGpuProgress] = useState(0);
  const [gpuProgressMsg, setGpuProgressMsg] = useState("");

  // 启动时统一检查依赖
  useEffect(() => {
    if (!hasTauri()) {
      setDepState("ok");
      setDeps({ ffmpeg: true, whisper: true, model: true, model_path: "", gpu_type: "cpu", gpu_available: false, using_gpu: false });
      return;
    }
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<Deps>("check_dependencies").then(d => {
        setDeps(d);
        setDepState(d.ffmpeg && d.whisper && d.model ? "ok" : "missing");
      }).catch(() => setDepState("missing"));
    });
    // 监听 GPU 下载进度
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ variant: string; ratio: number; message: string }>("gpu-download-progress", e => {
        setGpuProgress(e.payload.ratio);
        setGpuProgressMsg(e.payload.message);
        // 完成后重新检查依赖，刷新 GPU 状态，消除 banner
        if (e.payload.ratio >= 1.0) {
          import("@tauri-apps/api/core").then(({ invoke }) =>
            invoke<Deps>("check_dependencies").then(d => {
              setDeps(d);
              setDepState(d.ffmpeg && d.whisper && d.model ? "ok" : "missing");
            }).catch(() => {})
          );
        }
      })
    );
  }, []);

  const handleDownload = async (what: "ffmpeg" | "model" | "gpu-whisper") => {
    setDepState("downloading");
    setDownloadingWhat(what);
    setDepError("");
    setDownloadUrl("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (what === "ffmpeg") {
        await invoke("download_ffmpeg");
        setDeps(prev => prev ? { ...prev, ffmpeg: true } : null);
      } else if (what === "gpu-whisper") {
        const gpuType = deps?.gpu_type || "cuda";
        const isWin = typeof navigator !== "undefined" && navigator.platform?.includes("Win");
        if (gpuType === "cuda") {
          setDownloadUrl(`https://ghproxy.net/https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-cublas-12.4.0-bin-x64.zip`);
        } else {
          setDownloadUrl(`https://ghproxy.net/https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-blas-bin-x64.zip`);
        }
        await invoke("download_gpu_whisper");
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
      <header className="relative px-6 pt-6 pb-0 text-center">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <h1
          className="text-3xl font-semibold tracking-tight mb-6"
          style={{ color: "var(--color-text-primary)" }}
        >
          SubGen
        </h1>

        <div
          className="inline-flex rounded-md p-1 gap-1"
          style={{ background: "var(--color-surface-1)", border: "0.5px solid var(--color-border-subtle)" }}
        >
          {(
            [
              { key: "extract", label: "音频提取" },
              { key: "transcript", label: "转录" },
              { key: "translate", label: "翻译" },
              { key: "subtitle", label: "字幕生成" },
            ] as { key: Tab; label: string }[]
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="px-5 py-2 rounded-md text-sm font-medium transition-all"
              style={
                tab === key
                  ? {
                      background: "var(--color-accent)",
                      color: "#fff",
                      boxShadow: "0 2px 8px var(--color-accent-glow)",
                    }
                  : { color: "var(--color-text-secondary)" }
              }
            >
              {label}
            </button>
          ))}
        </div>

        <DepsBanner deps={deps} state={depState} error={depError} downloadingWhat={downloadingWhat} downloadUrl={downloadUrl} gpuProgress={gpuProgress} gpuProgressMsg={gpuProgressMsg} onDownload={handleDownload} />
      </header>

      <main className="flex-1 px-4 pt-8 pb-16">
        <div className="flex items-start justify-center" style={{ display: tab === "extract" ? "flex" : "none" }}>
          <div className="w-full max-w-4xl">
            <ExtractPanel />
          </div>
        </div>
        <div className="flex items-start justify-center" style={{ display: tab === "transcript" ? "flex" : "none" }}>
          <div className="w-full max-w-7xl">
            <TranscriptPanel />
          </div>
        </div>
        <div className="flex items-start justify-center" style={{ display: tab === "translate" ? "flex" : "none" }}>
          <div className="w-full max-w-7xl">
            <TranslatePanel />
          </div>
        </div>
        <div className="flex items-start justify-center" style={{ display: tab === "subtitle" ? "flex" : "none" }}>
          <div className="w-full max-w-7xl">
            <DesktopSubtitlePanel />
          </div>
        </div>
      </main>
    </div>
  );
}
