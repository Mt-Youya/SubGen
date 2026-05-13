"use client";

import type { Step } from "../SubtitleGenerator";

const STEPS = [
  { key: "compressing", label: "压缩音频" },
  { key: "uploading", label: "上传文件" },
  { key: "processing", label: "识别 & 翻译" },
  { key: "done", label: "完成" },
] as const;

interface ProgressBarProps {
  step: Step;
}

export function ProgressBar({ step }: ProgressBarProps) {
  const currentIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="px-1 animate-fade-up">
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => {
          const isDone = currentIndex > i || step === "done";
          const isActive = s.key === step;

          return (
            <div key={s.key} className="flex items-center gap-2 flex-1 last:flex-none">
              <div className="flex items-center gap-1.5">
                <div
                  className="w-1.5 h-1.5 rounded-full transition-all duration-300"
                  style={{
                    background: isDone || isActive
                      ? "var(--color-accent)"
                      : "var(--color-border)",
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
              {i < STEPS.length - 1 && (
                <div
                  className="flex-1 h-px transition-all duration-500"
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
    </div>
  );
}
