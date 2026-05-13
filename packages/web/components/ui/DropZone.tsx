"use client";

import { useRef, useState, useCallback } from "react";

export const MAX_SIZE = 25 * 1024 * 1024; // 25 MB — Groq limit

interface DropZoneProps {
  file: File | null;
  onFile: (f: File) => void;
  disabled?: boolean;
}

const ACCEPTED = ["video/", "audio/", ".mkv", ".ts", ".m2ts"];

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="12" y1="12" x2="12" y2="18"/>
      <polyline points="9 15 12 18 15 15"/>
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="3"/>
      <path d="m10 9 5 3-5 3V9Z"/>
    </svg>
  );
}

export function DropZone({ file, onFile, disabled }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tooLarge = file ? file.size > MAX_SIZE : false;

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  }, [onFile, disabled]);

  const borderColor = dragging
    ? "var(--color-accent)"
    : tooLarge
    ? "oklch(78% 0.16 75 / 50%)"
    : file
    ? "oklch(72% 0.16 145 / 40%)"
    : "var(--color-border)";

  const bgColor = dragging
    ? "var(--color-accent-muted)"
    : tooLarge
    ? "oklch(78% 0.16 75 / 5%)"
    : file
    ? "oklch(72% 0.16 145 / 5%)"
    : "var(--color-surface-1)";

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragEnter={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className="rounded-[var(--radius-lg)] transition-all duration-200"
      style={{
        border: `1.5px dashed ${borderColor}`,
        background: bgColor,
        cursor: disabled ? "default" : "pointer",
        padding: file ? "20px 24px" : "36px 24px",
      }}
    >
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        accept="audio/*,video/*,.mkv,.ts,.m2ts"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
        disabled={disabled}
      />

      {file ? (
        <div className="flex items-center gap-4">
          <div
            className="w-10 h-10 rounded-[var(--radius-md)] flex items-center justify-center shrink-0"
            style={{
              background: tooLarge ? "oklch(78% 0.16 75 / 12%)" : "oklch(72% 0.16 145 / 12%)",
              color: tooLarge ? "var(--color-warning)" : "var(--color-success)",
            }}
          >
            <VideoIcon />
          </div>
          <div className="min-w-0 flex-1">
            <p
              className="text-sm font-medium truncate"
              style={{ color: "var(--color-text-primary)" }}
            >
              {file.name}
            </p>
            {tooLarge ? (
              <p className="text-xs mt-0.5" style={{ color: "var(--color-warning)" }}>
                {formatSize(file.size)} · 将自动压缩后上传
              </p>
            ) : (
              <p className="text-xs mt-0.5" style={{ color: "var(--color-text-tertiary)" }}>
                {formatSize(file.size)} · 点击更换
              </p>
            )}
          </div>
          {tooLarge ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-warning)", flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-success)", flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-center">
          <div
            className="w-12 h-12 rounded-[var(--radius-lg)] flex items-center justify-center"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-tertiary)",
            }}
          >
            <FileIcon />
          </div>
          <div>
            <p
              className="text-sm font-medium"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {dragging ? "松开以上传" : "拖放文件，或点击选择"}
            </p>
            <p className="text-xs mt-1" style={{ color: "var(--color-text-tertiary)" }}>
              MP4 · MKV · MP3 · WAV · M4A 等 · 上限 25 MB
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
