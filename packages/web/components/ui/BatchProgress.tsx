"use client";

import type { BatchFile } from "../SubtitleGenerator";
import { ProgressBar } from "./ProgressBar";
import { calcTotalProgress, type Step } from "../SubtitleGenerator";

interface BatchProgressProps {
  files: BatchFile[];
  currentIndex: number;
}

// 文件状态徽章颜色
const STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  pending:     { bg: "var(--color-surface-3)",             text: "var(--color-text-tertiary)", label: "等待" },
  compressing: { bg: "oklch(50% 0.15 250 / 20%)",          text: "oklch(70% 0.15 250)",        label: "压缩" },
  uploading:   { bg: "oklch(50% 0.15 200 / 20%)",          text: "oklch(70% 0.15 200)",        label: "上传" },
  processing:  { bg: "oklch(50% 0.20 280 / 20%)",          text: "oklch(70% 0.20 280)",        label: "识别" },
  done:        { bg: "oklch(50% 0.15 145 / 20%)",          text: "oklch(65% 0.15 145)",        label: "完成 ✓" },
  error:       { bg: "oklch(50% 0.20 20  / 20%)",          text: "var(--color-danger)",        label: "失败" },
};

export function BatchProgress({ files, currentIndex }: BatchProgressProps) {
  const total = files.length;
  const doneCount = files.filter((f) => f.status === "done").length;
  const errorCount = files.filter((f) => f.status === "error").length;

  // 整体进度：完成数 / 总数（各文件内部进度暂按 0/1 处理）
  const inProgressFiles = files.filter(
    (f) => f.status === "compressing" || f.status === "uploading" || f.status === "processing",
  );

  // 计算带内部进度的批量百分比
  let batchProgress = doneCount;
  for (const f of inProgressFiles) {
    if (f.status === "compressing") batchProgress += 0.05;
    else if (f.status === "uploading") batchProgress += 0.15;
    else if (f.status === "processing" && f.taskProgress) {
      batchProgress += calcTotalProgress(f.taskProgress.stage, f.taskProgress.stage_progress);
    } else {
      batchProgress += 0.01;
    }
  }
  const batchPct = Math.round((batchProgress / total) * 100);

  // 当前活跃文件（正在处理中的）
  const activeFiles = files.filter(
    (f) => f.status !== "pending" && f.status !== "done",
  );

  return (
    <div
      className="rounded-[var(--radius-md)] overflow-hidden animate-fade-up"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-subtle)",
      }}
    >
      {/* ── 顶部：整体进度 ── */}
      <div className="px-4 pt-4 pb-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold" style={{ color: "var(--color-text-primary)" }}>
              批量处理中
            </span>
            <span
              className="text-xs px-1.5 py-0.5 rounded-full tabular-nums"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)" }}
            >
              {doneCount + errorCount} / {total}
            </span>
          </div>
          <span className="text-sm tabular-nums font-bold" style={{ color: "var(--color-accent)" }}>
            {batchPct}%
          </span>
        </div>

        {/* 整体进度条 */}
        <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--color-surface-3)" }}>
          <div
            className="h-full rounded-full"
            style={{
              transform: `scaleX(${batchPct / 100})`,
              transformOrigin: "left",
              transition: "transform 0.5s ease-out",
              background: "var(--color-accent)",
              boxShadow: "0 0 10px var(--color-accent-glow)",
            }}
          />
        </div>

        {/* 统计小标签 */}
        <div className="flex gap-2 text-xs">
          {doneCount > 0 && (
            <span className="px-2 py-0.5 rounded-full" style={{ background: "oklch(50% 0.15 145 / 15%)", color: "oklch(65% 0.15 145)" }}>
              ✓ 已完成 {doneCount}
            </span>
          )}
          {errorCount > 0 && (
            <span className="px-2 py-0.5 rounded-full" style={{ background: "oklch(50% 0.20 20 / 15%)", color: "var(--color-danger)" }}>
              ✗ 失败 {errorCount}
            </span>
          )}
          {inProgressFiles.length > 0 && (
            <span className="px-2 py-0.5 rounded-full" style={{ background: "oklch(50% 0.20 280 / 15%)", color: "oklch(70% 0.20 280)" }}>
              ◎ 进行中 {inProgressFiles.length}
            </span>
          )}
          {files.filter((f) => f.status === "pending").length > 0 && (
            <span className="px-2 py-0.5 rounded-full" style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)" }}>
              ○ 等待 {files.filter((f) => f.status === "pending").length}
            </span>
          )}
        </div>
      </div>

      {/* ── 分隔线 ── */}
      <div style={{ height: "1px", background: "var(--color-border-subtle)" }} />

      {/* ── 各文件状态列表 ── */}
      <div className="divide-y" style={{ borderColor: "var(--color-border-subtle)" }}>
        {files.map((f) => {
          const badge = STATUS_BADGE[f.status] ?? STATUS_BADGE.pending;
          const step: Step = f.status === "pending" ? "idle" : f.status as Step;
          const isActive = f.status !== "pending" && f.status !== "done" && f.status !== "error";
          const shortName = f.file.name.length > 36
            ? f.file.name.slice(0, 16) + "…" + f.file.name.slice(-16)
            : f.file.name;

          return (
            <div
              key={f.id}
              className="px-4 py-3 space-y-2.5 transition-colors duration-200"
              style={{
                background: isActive ? "var(--color-surface-2)" : "transparent",
              }}
            >
              {/* 文件名 + 状态徽章 */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {/* 状态图标 */}
                  {isActive ? (
                    <span
                      className="shrink-0 w-3 h-3 rounded-full border-2 border-t-transparent animate-spin"
                      style={{ borderColor: `${badge.text} transparent ${badge.text} ${badge.text}` }}
                    />
                  ) : f.status === "done" ? (
                    <span className="shrink-0 text-xs" style={{ color: badge.text }}>✓</span>
                  ) : f.status === "error" ? (
                    <span className="shrink-0 text-xs" style={{ color: badge.text }}>✗</span>
                  ) : (
                    <span className="shrink-0 w-3 h-3 rounded-full" style={{ background: "var(--color-surface-3)" }} />
                  )}
                  <span
                    className="text-xs font-medium truncate"
                    style={{ color: isActive ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}
                    title={f.file.name}
                  >
                    {shortName}
                  </span>
                </div>
                <span
                  className="shrink-0 text-[11px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{ background: badge.bg, color: badge.text }}
                >
                  {badge.label}
                </span>
              </div>

              {/* 进度详情（仅活跃文件） */}
              {isActive && (
                <div className="pl-5">
                  <ProgressBar
                    step={step}
                    taskProgress={f.taskProgress ?? null}
                    uploadLabel={f.uploadLabel ?? f.compressLabel}
                  />
                </div>
              )}

              {/* 错误信息 */}
              {f.status === "error" && f.error && (
                <p className="pl-5 text-xs" style={{ color: "var(--color-danger)" }}>
                  {f.error}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
