"use client";

import type { Step, TaskProgress } from "../SubtitleGenerator";
import { calcTotalProgress } from "../SubtitleGenerator";

const FLOW_STEPS = [
  { key: "compressing", label: "压缩" },
  { key: "uploading",   label: "上传" },
  { key: "processing",  label: "处理" },
  { key: "done",        label: "完成" },
] as const;

const STAGE_LABEL: Record<string, string> = {
  pending:      "等待处理",
  extracting:   "提取音频",
  transcribing: "语音识别",
  translating:  "翻译字幕",
  done:         "完成",
};

interface ProgressBarProps {
  step: Step;
  taskProgress?: TaskProgress | null;
}

export function ProgressBar({ step, taskProgress }: ProgressBarProps) {
  const currentIndex = FLOW_STEPS.findIndex((s) => s.key === step);
  const isProcessing = step === "processing" && taskProgress != null;

  const totalPct = isProcessing
    ? Math.round(calcTotalProgress(taskProgress.stage, taskProgress.stage_progress) * 100)
    : 0;
  const stagePct = isProcessing ? Math.round(taskProgress.stage_progress * 100) : 0;

  return (
    <div className="px-1 animate-fade-up space-y-3">
      {/* 步骤指示器 */}
      <div className="flex items-center gap-2">
        {FLOW_STEPS.map((s, i) => {
          const isDone = currentIndex > i || step === "done";
          const isActive = s.key === step;
          return (
            <div key={s.key} className="flex items-center gap-2 flex-1 last:flex-none">
              <div className="flex items-center gap-1.5">
                <div
                  className="w-1.5 h-1.5 rounded-full transition-all duration-300"
                  style={{
                    background: isDone || isActive ? "var(--color-accent)" : "var(--color-border)",
                    boxShadow: isActive ? "0 0 6px var(--color-accent)" : "none",
                    animation: isActive ? "pulse-ring 1.5s ease-in-out infinite" : "none",
                  }}
                />
                <span
                  className="text-xs transition-colors duration-200"
                  style={{
                    color: isDone || isActive
                      ? "var(--color-text-secondary)"
                      : "var(--color-text-tertiary)",
                  }}
                >
                  {s.label}
                </span>
              </div>
              {i < FLOW_STEPS.length - 1 && (
                <div
                  className="flex-1 h-px transition-all duration-500"
                  style={{ background: isDone ? "var(--color-accent)" : "var(--color-border-subtle)" }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* 任务进度（仅 processing 阶段显示） */}
      {isProcessing && (
        <div className="space-y-2">
          {/* 总进度条 */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>总进度</span>
              <span className="text-xs tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
                {totalPct}%
              </span>
            </div>
            <div
              className="w-full h-1.5 rounded-full overflow-hidden"
              style={{ background: "var(--color-surface-3)" }}
            >
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${totalPct}%`,
                  background: "var(--color-accent)",
                  boxShadow: "0 0 8px var(--color-accent-glow)",
                }}
              />
            </div>
          </div>

          {/* 当前阶段进度条 */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                {STAGE_LABEL[taskProgress.stage] ?? taskProgress.stage}
                {taskProgress.message ? ` — ${taskProgress.message}` : ""}
              </span>
              <span className="text-xs tabular-nums" style={{ color: "var(--color-text-secondary)" }}>
                {stagePct}%
              </span>
            </div>
            <div
              className="w-full h-1 rounded-full overflow-hidden"
              style={{ background: "var(--color-surface-3)" }}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${stagePct}%`,
                  background: "oklch(65% 0.15 200)",
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
