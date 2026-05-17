"use client";

import type { Step, TaskProgress } from "../SubtitleGenerator";
import { calcTotalProgress } from "../SubtitleGenerator";

export const FLOW_STEPS: { key: string; label: string; icon: string }[] = [
  { key: "compressing", label: "压缩",   icon: "⚙" },
  { key: "uploading",   label: "上传",   icon: "↑" },
  { key: "processing",  label: "识别",   icon: "◎" },
  { key: "done",        label: "完成",   icon: "✓" },
];

const STAGE_LABEL: Record<string, string> = {
  pending:      "等待",
  extracting:   "提取音频",
  transcribing: "语音识别",
  translating:  "翻译字幕",
  done:         "完成",
};

const STAGE_COLOR: Record<string, string> = {
  extracting:   "oklch(65% 0.18 160)",
  transcribing: "oklch(65% 0.18 260)",
  translating:  "oklch(65% 0.18 300)",
  done:         "oklch(65% 0.15 145)",
};

interface ProgressBarProps {
  step: Step;
  taskProgress?: TaskProgress | null;
  uploadLabel?: string;
  /** 文件名，显示在进度条上方 */
  filename?: string;
}

export function ProgressBar({ step, taskProgress, uploadLabel, filename }: ProgressBarProps) {
  const currentStepIdx = FLOW_STEPS.findIndex((s) => s.key === step);
  const isProcessing = step === "processing" && taskProgress != null;
  const isUploading = step === "uploading";
  const isCompressing = step === "compressing";

  const totalPct = isProcessing
    ? Math.round(calcTotalProgress(taskProgress.stage, taskProgress.stage_progress) * 100)
    : 0;
  const stagePct = isProcessing ? Math.round(taskProgress.stage_progress * 100) : 0;
  const stageLabel = isProcessing
    ? (STAGE_LABEL[taskProgress.stage] ?? taskProgress.stage)
    : "";
  const stageColor = isProcessing
    ? (STAGE_COLOR[taskProgress.stage] ?? "var(--color-accent)")
    : "var(--color-accent)";

  // ── 步骤指示器 ──
  const stepIndicator = (
    <div className="flex items-center gap-0">
      {FLOW_STEPS.map((s, i) => {
        const isDone = step === "done" || currentStepIdx > i;
        const isActive = s.key === step;
        return (
          <div key={s.key} className="flex items-center flex-1 last:flex-none">
            {/* 节点 */}
            <div className="flex items-center gap-1 shrink-0">
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-300"
                style={{
                  background: isDone
                    ? "var(--color-accent)"
                    : isActive
                    ? "var(--color-accent)"
                    : "var(--color-surface-3)",
                  color: isDone || isActive ? "white" : "var(--color-text-tertiary)",
                  boxShadow: isActive ? "0 0 10px var(--color-accent-glow)" : "none",
                  animation: isActive && step !== "done" ? "pulse-ring 1.5s ease-in-out infinite" : "none",
                }}
              >
                {isDone && !isActive ? "✓" : s.icon}
              </div>
              <span
                className="text-[11px] font-medium transition-colors duration-200"
                style={{
                  color: isDone || isActive
                    ? "var(--color-text-primary)"
                    : "var(--color-text-tertiary)",
                }}
              >
                {s.label}
              </span>
            </div>
            {/* 连线 */}
            {i < FLOW_STEPS.length - 1 && (
              <div className="flex-1 h-px mx-1.5 rounded-full transition-all duration-500"
                style={{
                  background: isDone
                    ? "var(--color-accent)"
                    : "var(--color-border-subtle)",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );

  // ── 状态描述行 ──
  let statusLine: React.ReactNode = null;
  if (isCompressing) {
    statusLine = (
      <div className="flex items-center gap-2 text-xs" style={{ color: "var(--color-text-secondary)" }}>
        <span className="inline-block w-3 h-3 border-2 rounded-full border-t-transparent animate-spin"
          style={{ borderColor: "var(--color-accent) transparent var(--color-accent) var(--color-accent)" }} />
        {filename ? `${filename} — ` : ""}解码音频中...
      </div>
    );
  } else if (isUploading) {
    statusLine = (
      <div className="flex items-center gap-2 text-xs" style={{ color: "var(--color-text-secondary)" }}>
        <span className="inline-block w-3 h-3 border-2 rounded-full border-t-transparent animate-spin"
          style={{ borderColor: "var(--color-accent) transparent var(--color-accent) var(--color-accent)" }} />
        {filename ? `${filename} — ` : ""}{uploadLabel ?? "上传中..."}
      </div>
    );
  } else if (isProcessing) {
    statusLine = (
      <div className="space-y-2">
        {/* 总进度 */}
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <span className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
              {filename ? `${filename}` : "处理进度"}
              {taskProgress.message ? <span className="ml-1 font-normal" style={{ color: "var(--color-text-tertiary)" }}>— {taskProgress.message}</span> : null}
            </span>
            <span className="text-xs tabular-nums font-semibold" style={{ color: "var(--color-text-primary)" }}>
              {totalPct}%
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: "var(--color-surface-3)" }}>
            <div
              className="h-full rounded-full"
              style={{ transform: `scaleX(${totalPct / 100})`, transformOrigin: "left", transition: "transform 0.5s ease-out", background: "var(--color-accent)", boxShadow: "0 0 8px var(--color-accent-glow)" }}
            />
          </div>
        </div>
        {/* 当前子阶段 */}
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
                style={{ background: stageColor }}
              />
              <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                {stageLabel}
              </span>
            </div>
            <span className="text-xs tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
              {stagePct}%
            </span>
          </div>
          <div className="w-full h-0.5 rounded-full overflow-hidden" style={{ background: "var(--color-surface-3)" }}>
            <div
              className="h-full rounded-full"
              style={{ transform: `scaleX(${stagePct / 100})`, transformOrigin: "left", transition: "transform 0.3s ease-out", background: stageColor }}
            />
          </div>
        </div>
      </div>
    );
  } else if (step === "done") {
    statusLine = (
      <p className="text-xs" style={{ color: "oklch(65% 0.15 145)" }}>
        {filename ? `${filename} — ` : ""}处理完成 ✓
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      {stepIndicator}
      {statusLine}
    </div>
  );
}
