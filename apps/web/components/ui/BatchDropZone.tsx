"use client";

import { useRef, useState, useCallback } from "react";
import { FileIcon } from "./Icons";

export interface BatchFileEntry {
  file: File;
  relativePath: string;
}

interface BatchDropZoneProps {
  entries: BatchFileEntry[];
  onFilesAdded: (entries: BatchFileEntry[]) => void;
  disabled?: boolean;
}

const ACCEPTED = ["video/", "audio/", ".mp4", ".mkv", ".ts", ".m2ts", ".webm", ".avi", ".mov", ".wmv"];

function acceptFile(f: File): boolean {
  // Windows 下 MP4 等 MIME 可能为空，优先用扩展名判断
  const ext = f.name.toLowerCase().split(".").pop();
  const videoExts = ["mp4", "mkv", "ts", "m2ts", "webm", "avi", "mov", "wmv"];
  const audioExts = ["mp3", "wav", "m4a", "wma", "flac", "ogg", "aac", "opus"];
  if (ext && (videoExts.includes(ext) || audioExts.includes(ext))) return true;
  return ACCEPTED.some((a) =>
    a.endsWith("/") ? f.type.startsWith(a) : f.name.toLowerCase().endsWith(a)
  );
}

export function BatchDropZone({ entries, onFilesAdded, disabled }: BatchDropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const multiRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const handleFiles = useCallback(
    (files: FileList | File[], prefix: string) => {
      const added = Array.from(files)
        .filter(acceptFile)
        .map((f) => ({
          file: f,
          relativePath: prefix ? `${prefix}/${f.name}` : (f as any).webkitRelativePath || f.name,
        }));
      onFilesAdded(added);
    },
    [onFilesAdded],
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current++;
      if (!disabled) setDragging(true);
    },
    [disabled],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current--;
      if (dragCounter.current === 0) setDragging(false);
    },
    [],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      dragCounter.current = 0;
      if (disabled) return;

      const items = Array.from(e.dataTransfer.items ?? []);
      const files: File[] = [];
      let hasFolder = false;

      for (const item of items) {
        if (item.kind === "file") {
          const entry = (item as any).webkitGetAsEntry?.();
          if (entry?.isDirectory) {
            hasFolder = true;
            readEntry(entry, "").then((f) => files.push(...f));
          } else {
            files.push(item.getAsFile()!);
          }
        }
      }

      if (hasFolder) {
        // Wait for folder entries to be fully read
        const checkDone = setInterval(() => {
          // All entries resolved synchronously via readEntry
          clearInterval(checkDone);
          handleFiles(files, "");
        }, 10);
      } else {
        handleFiles(files, "");
      }
    },
    [disabled, handleFiles],
  );

  const hasFiles = entries.length > 0;

  // Visual states
  let borderColor = "var(--color-border)";
  let bgColor = hasFiles ? "oklch(72% 0.16 145 / 5%)" : "var(--color-surface-1)";
  if (dragging) {
    borderColor = "var(--color-accent)";
    bgColor = "var(--color-accent-muted)";
  } else if (hasFiles) {
    borderColor = "var(--color-success)";
  }

  return (
    <>
      <input
        ref={multiRef}
        type="file"
        multiple
        accept={ACCEPTED.join(",")}
        className="sr-only"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleFiles(e.target.files, "");
          }
          e.target.value = "";
        }}
      />
      <input
        ref={folderRef}
        type="file"
        /* @ts-expect-error webkitdirectory exists on Chrome */
        webkitdirectory=""
        accept={ACCEPTED.join(",")}
        className="sr-only"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleFiles(e.target.files, "");
          }
          e.target.value = "";
        }}
      />

      <div
        className="rounded-[var(--radius-lg)] transition-all duration-200 select-none"
        style={{
          background: bgColor,
          border: `1.5px dashed ${borderColor}`,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.7 : 1,
        }}
        onClick={() => { if (!disabled) multiRef.current?.click(); }}
        onDragEnter={handleDragEnter}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {hasFiles ? (
          /* ── 已有文件：紧凑横排 ── */
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="w-8 h-8 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0"
              style={{ background: "oklch(72% 0.16 145 / 15%)", color: "var(--color-success)" }}>
              <FileIcon />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
                已添加 {entries.length} 个文件
              </p>
              <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
                拖放或点击继续添加
              </p>
            </div>
            <div className="flex gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => multiRef.current?.click()}
                className="px-2.5 py-1 text-xs rounded-[var(--radius-sm)] transition-colors"
                style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border-subtle)" }}>
                + 文件
              </button>
              <button onClick={() => folderRef.current?.click()}
                className="px-2.5 py-1 text-xs rounded-[var(--radius-sm)] transition-colors"
                style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border-subtle)" }}>
                + 文件夹
              </button>
            </div>
          </div>
        ) : (
          /* ── 空状态：大号引导区 ── */
          <div className="flex flex-col items-center gap-4 py-10 px-6 text-center">
            {/* 拖拽图标 */}
            <div className="w-16 h-16 rounded-[var(--radius-lg)] flex items-center justify-center"
              style={{ background: dragging ? "var(--color-accent-muted)" : "var(--color-surface-2)", border: "1px solid var(--color-border-subtle)" }}>
              {dragging ? (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  style={{ color: "var(--color-accent)" }}>
                  <path d="M12 15V3m0 12-4-4m4 4 4-4" />
                  <path d="M2 17v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2" />
                </svg>
              ) : (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  style={{ color: "var(--color-text-tertiary)" }}>
                  <rect x="2" y="4" width="20" height="16" rx="3" />
                  <path d="m10 9 5 3-5 3V9Z" />
                </svg>
              )}
            </div>

            {/* 主提示 */}
            <div className="space-y-1">
              <p className="text-base font-medium" style={{ color: dragging ? "var(--color-accent)" : "var(--color-text-primary)" }}>
                {dragging ? "松开即可添加" : "拖放视频或音频文件"}
              </p>
              <p className="text-sm" style={{ color: "var(--color-text-tertiary)" }}>
                支持文件夹，自动递归扫描；单文件自动压缩后上传
              </p>
            </div>

            {/* 按钮组 */}
            {!dragging && (
              <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => multiRef.current?.click()}
                  className="px-5 py-2 text-sm font-medium rounded-[var(--radius-md)] transition-all"
                  style={{ background: "var(--color-accent)", color: "white", boxShadow: "0 0 16px var(--color-accent-glow)" }}>
                  选择文件
                </button>
                <button
                  onClick={() => folderRef.current?.click()}
                  className="px-5 py-2 text-sm font-medium rounded-[var(--radius-md)] transition-all"
                  style={{ background: "var(--color-surface-2)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)" }}>
                  选择文件夹
                </button>
              </div>
            )}

            {/* 格式提示 */}
            <div className="flex items-center gap-1.5 flex-wrap justify-center">
              {["MP4", "MKV", "MOV", "MP3", "WAV", "M4A"].map((fmt) => (
                <span key={fmt} className="px-2 py-0.5 rounded text-[11px] font-mono"
                  style={{ background: "var(--color-surface-2)", color: "var(--color-text-tertiary)", border: "1px solid var(--color-border-subtle)" }}>
                  {fmt}
                </span>
              ))}
              <span className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>等</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** 递归读取目录下的所有文件 */
async function readEntry(entry: any, basePath: string): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file((f: File) => {
        const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
        Object.defineProperty(f, "webkitRelativePath", { value: relativePath, writable: false });
        resolve([f]);
      });
    });
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    return new Promise((resolve) => {
      reader.readEntries(async (subEntries: any[]) => {
        const files: File[] = [];
        for (const sub of subEntries) {
          const subFiles = await readEntry(sub, basePath ? `${basePath}/${entry.name}` : entry.name);
          files.push(...subFiles);
        }
        resolve(files);
      });
    });
  }
  return [];
}
