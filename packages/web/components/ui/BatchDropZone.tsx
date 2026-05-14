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
        className="rounded-[var(--radius-lg)] transition-all duration-200 cursor-pointer select-none"
        style={{
          background: bgColor,
          border: `1.5px dashed ${borderColor}`,
          padding: hasFiles ? "20px 24px" : "36px 24px",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.7 : 1,
        }}
        onClick={() => {
          if (disabled) return;
          if (hasFiles) multiRef.current?.click();
          else multiRef.current?.click();
        }}
        onDragEnter={handleDragEnter}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {hasFiles ? (
          <div className="flex items-center gap-4">
            <div
              className="w-10 h-10 rounded-[var(--radius-md)] flex items-center justify-center shrink-0"
              style={{
                background: "oklch(72% 0.16 145 / 12%)",
                color: "var(--color-success)",
              }}
            >
              <FileIcon />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
                已选择 {entries.length} 个文件
              </p>
              <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
                点击添加更多 · 拖放覆盖
              </p>
            </div>
            <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => multiRef.current?.click()}
                className="px-3 py-1.5 text-xs rounded-[var(--radius-sm)] transition-colors"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-subtle)",
                }}
              >
                选择文件
              </button>
              <button
                onClick={() => folderRef.current?.click()}
                className="px-3 py-1.5 text-xs rounded-[var(--radius-sm)] transition-colors"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-subtle)",
                }}
              >
                选择文件夹
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div style={{ color: "var(--color-text-tertiary)" }}>
              <FileIcon />
            </div>
            <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
              拖放文件，或点击选择
            </p>
            <div className="flex gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  multiRef.current?.click();
                }}
                className="px-4 py-2 text-sm rounded-[var(--radius-md)] transition-colors"
                style={{
                  background: "var(--color-accent)",
                  color: "white",
                }}
              >
                选择文件
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  folderRef.current?.click();
                }}
                className="px-4 py-2 text-sm rounded-[var(--radius-md)] transition-colors"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-subtle)",
                }}
              >
                选择文件夹
              </button>
            </div>
            <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
              MP4 · MKV · MP3 · WAV · M4A 等 · 自动压缩后上传
            </p>
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
