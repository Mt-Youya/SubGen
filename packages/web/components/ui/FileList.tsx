"use client";

import type { BatchFile } from "../SubtitleGenerator";
import { VideoIcon, AudioIcon } from "./Icons";

const VIDEO_EXT = new Set([".mp4", ".mkv", ".webm", ".mov", ".ts", ".m2ts", ".avi", ".wmv", ".flv"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".wma", ".opus"]);

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx === -1) return "";
  return filename.toLowerCase().slice(idx);
}

function groupFiles(files: BatchFile[]): { dir: string; files: BatchFile[] }[] {
  const groups: { dir: string; files: BatchFile[] }[] = [];
  for (const f of files) {
    const path = f.relativePath || f.file.name;
    const lastSlash = path.lastIndexOf("/");
    const dir = lastSlash === -1 ? "" : path.slice(0, lastSlash);
    let group = groups.find((g) => g.dir === dir);
    if (!group) {
      group = { dir, files: [] };
      groups.push(group);
    }
    group.files.push(f);
  }
  return groups;
}

interface FileListProps {
  files: BatchFile[];
  onRemove: (id: string) => void;
  disabled?: boolean;
  expandedId?: string | null;
  onToggleExpand?: (id: string) => void;
  renderResult?: (f: BatchFile) => React.ReactNode;
}

export function FileList({ files, onRemove, disabled, expandedId, onToggleExpand, renderResult }: FileListProps) {
  if (files.length === 0) return null;

  const groups = groupFiles(files);

  return (
    <div
      className="rounded-[var(--radius-md)] overflow-hidden"
      style={{ border: "1px solid var(--color-border-subtle)" }}
    >
      <div
        className="px-4 py-2.5 flex items-center justify-between"
        style={{
          background: "var(--color-surface-2)",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <span className="text-xs font-medium" style={{ color: "var(--color-text-tertiary)" }}>
          {files.length} 个文件
        </span>
      </div>

      <div
        className="overflow-y-auto divide-y"
        style={{
          maxHeight: "320px",
          background: "var(--color-surface-1)",
          borderColor: "var(--color-border-subtle)",
        } as React.CSSProperties}
      >
        {groups.map((group) => (
          <div key={group.dir}>
            {group.dir && (
              <div
                className="px-4 py-1.5 text-xs"
                style={{
                  background: "var(--color-surface-0)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                {group.dir}
              </div>
            )}
            {group.files.map((f) => {
              const ext = getExtension(f.file.name);
              const isVideo = VIDEO_EXT.has(ext);
              const isAudio = AUDIO_EXT.has(ext);

              return (
                <div key={f.id}>
                  <div
                    className="px-4 py-3 flex items-center gap-3 transition-colors"
                    style={{
                      background: expandedId === f.id ? "var(--color-surface-2)" : "transparent",
                      cursor: onToggleExpand ? "pointer" : "default",
                    }}
                    onClick={() => {
                      if (onToggleExpand && (f.status === "done" || f.status === "error")) {
                        onToggleExpand(f.id);
                      }
                    }}
                  >
                    {/* Status icon */}
                    <div className="w-5 h-5 shrink-0 flex items-center justify-center">
                      {f.status === "done" ? (
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <circle cx="8" cy="8" r="6" stroke="var(--color-success)" strokeWidth="1.5" />
                          <path d="M5 8l2 2 4-4" stroke="var(--color-success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : f.status === "error" ? (
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <circle cx="8" cy="8" r="6" stroke="var(--color-danger)" strokeWidth="1.5" />
                          <path d="M8 5v3M8 11h.01" stroke="var(--color-danger)" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      ) : f.status !== "pending" ? (
                        <svg className="animate-spin" width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <circle cx="8" cy="8" r="6" stroke="var(--color-text-tertiary)" strokeOpacity="0.25" strokeWidth="1.5" />
                          <path d="M14 8a6 6 0 0 0-6-6" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      ) : (
                        <div
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: "var(--color-text-tertiary)" }}
                        />
                      )}
                    </div>

                    {/* File type icon */}
                    <div style={{ color: "var(--color-text-tertiary)", width: 20, height: 20 }}>
                      {isVideo ? <VideoIcon /> : isAudio ? <AudioIcon /> : <VideoIcon />}
                    </div>

                    {/* File info */}
                    <div className="flex-1 min-w-0">
                      <p
                        className="text-sm truncate"
                        style={{ color: "var(--color-text-primary)" }}
                      >
                        {f.file.name}
                      </p>
                      {(f.relativePath || f.error) && (
                        <p
                          className="text-xs truncate"
                          style={{ color: f.error ? "var(--color-danger)" : "var(--color-text-tertiary)" }}
                        >
                          {f.error || f.relativePath}
                        </p>
                      )}
                    </div>

                    {/* File size */}
                    <span className="text-xs shrink-0" style={{ color: "var(--color-text-tertiary)" }}>
                      {formatSize(f.file.size)}
                    </span>

                    {/* Remove button or expand arrow */}
                    {f.status === "pending" && !disabled ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); onRemove(f.id); }}
                        className="w-6 h-6 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 transition-colors"
                        style={{ color: "var(--color-text-tertiary)" }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.color = "var(--color-danger)";
                          (e.currentTarget as HTMLElement).style.background = "oklch(65% 0.20 20 / 10%)";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.color = "var(--color-text-tertiary)";
                          (e.currentTarget as HTMLElement).style.background = "transparent";
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    ) : onToggleExpand ? (
                      <div className="shrink-0" style={{ color: "var(--color-text-tertiary)" }}>
                        <svg
                          width="14" height="14" viewBox="0 0 14 14" fill="none"
                          style={{
                            transform: expandedId === f.id ? "rotate(180deg)" : "none",
                            transition: "transform 0.2s ease",
                          }}
                        >
                          <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                    ) : null}
                  </div>

                  {/* Expanded result */}
                  {expandedId === f.id && renderResult?.(f) && (
                    <div
                      className="px-4 pb-4 animate-fade-up"
                      style={{ background: "var(--color-surface-2)" }}
                    >
                      {renderResult(f)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
