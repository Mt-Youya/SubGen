"use client";

import type { BatchFile } from "../SubtitleGenerator";
import { ProgressBar } from "./ProgressBar";
import { calcTotalProgress, type Step } from "../SubtitleGenerator";

interface BatchProgressProps {
  files: BatchFile[];
  currentIndex: number;
}

export function BatchProgress({ files, currentIndex }: BatchProgressProps) {
  const total = files.length;
  const currentFile = files[currentIndex];

  if (!currentFile) return null;

  const pending = total - currentIndex - 1;
  const step: Step = currentFile.status === "pending" ? "idle" : currentFile.status as Step;

  // Batch-level: completed files + current file fraction
  const perFileFraction = calcTotalProgress(
    currentFile.taskProgress?.stage ?? step,
    currentFile.taskProgress?.stage_progress ?? 0,
  );
  const batchPct = Math.round(((currentIndex + perFileFraction) / total) * 100);

  return (
    <div
      className="rounded-[var(--radius-md)] p-4 space-y-3 animate-fade-up"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-subtle)",
      }}
    >
      {/* Batch progress header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
          正在处理 {currentIndex + 1} / {total}
        </span>
        <span className="text-xs tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
          {batchPct}%
        </span>
      </div>

      {/* Batch progress bar */}
      <div
        className="h-1.5 rounded-full overflow-hidden"
        style={{ background: "var(--color-surface-3)" }}
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${batchPct}%`,
            background: "var(--color-accent)",
            boxShadow: "0 0 8px var(--color-accent-glow)",
          }}
        />
      </div>

      {/* Per-file progress */}
      <ProgressBar
        step={step}
        taskProgress={currentFile.taskProgress ?? null}
        uploadLabel={currentFile.uploadLabel ?? "上传中..."}
      />

      {/* Remaining */}
      {pending > 0 && (
        <p className="text-xs text-center" style={{ color: "var(--color-text-tertiary)" }}>
          剩余 {pending} 个文件
        </p>
      )}
    </div>
  );
}
