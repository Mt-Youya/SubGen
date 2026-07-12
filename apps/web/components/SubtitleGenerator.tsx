"use client"

import { useState, useCallback, useRef } from "react"
import type { Segment } from "@subgen/shared"
import { BatchDropZone, type BatchFileEntry } from "./ui/BatchDropZone"
import { LanguageSelect } from "./ui/LanguageSelect"
import { FileList } from "./ui/FileList"
import { BatchProgress } from "./ui/BatchProgress"
import { BatchResultPanel, FileResultPreview } from "./ui/BatchResultPanel"
import { processSingleFile } from "@/lib/process"

export type Step = "idle" | "compressing" | "uploading" | "processing" | "done" | "error"

export interface TaskProgress {
  status: "pending" | "done" | "error"
  stage: string
  stage_progress: number
  message: string
}

const STAGE_WEIGHTS: Record<string, [number, number]> = {
  pending: [0.0, 0.0],
  extracting: [0.0, 0.1],
  transcribing: [0.1, 0.6],
  translating: [0.7, 0.28],
  done: [0.98, 0.02],
}

export function calcTotalProgress(stage: string, stage_progress: number): number {
  const w = STAGE_WEIGHTS[stage]
  if (!w) return 0
  return Math.min(1, w[0] + w[1] * stage_progress)
}

export interface TranscribeResult {
  segments: Segment[]
  translated: Segment[]
  srt: {
    original: string
    translated: string
    bilingual: string | null
  }
}

export const SOURCE_LANGUAGES = [
  { code: "ja", label: "日语", flag: "🇯🇵" },
  { code: "zh", label: "中文", flag: "🇨🇳" },
  { code: "en", label: "英语", flag: "🇺🇸" },
  { code: "ko", label: "韩语", flag: "🇰🇷" },
  { code: "fr", label: "法语", flag: "🇫🇷" },
  { code: "de", label: "德语", flag: "🇩🇪" },
  { code: "es", label: "西班牙语", flag: "🇪🇸" },
]

export const TARGET_LANGUAGES = [
  { code: "ZH", label: "中文（简体）", flag: "🇨🇳" },
  { code: "ZH-TW", label: "中文（繁体）", flag: "🇹🇼" },
  { code: "EN-US", label: "英语", flag: "🇺🇸" },
  { code: "JA", label: "日语", flag: "🇯🇵" },
  { code: "KO", label: "韩语", flag: "🇰🇷" },
  { code: "FR", label: "法语", flag: "🇫🇷" },
  { code: "DE", label: "德语", flag: "🇩🇪" },
]

// ── Batch types ──

type BatchFileStatus = "pending" | "compressing" | "uploading" | "processing" | "done" | "error"

export interface BatchFile {
  id: string
  file: File
  relativePath: string
  status: BatchFileStatus
  error?: string
  result?: TranscribeResult | null
  compressLabel?: string
  uploadLabel?: string
  taskProgress?: TaskProgress | null
}

type BatchPhase = "selecting" | "processing" | "done"

let _batchId = 0

// ── Component ──

export function SubtitleGenerator() {
  const [files, setFiles] = useState<BatchFile[]>([])
  const [phase, setPhase] = useState<BatchPhase>("selecting")
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [sourceLang, setSourceLang] = useState("ja")
  const [targetLang, setTargetLang] = useState("ZH")
  const [bilingual, setBilingual] = useState(false)
  const [useCache, setUseCache] = useState(true)

  const [currentIndex, setCurrentIndex] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const filesRef = useRef<BatchFile[]>([])
  // Keep ref in sync
  filesRef.current = files

  const updateFile = useCallback((id: string, patch: Partial<BatchFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }, [])

  const handleFilesAdded = useCallback(
    (entries: BatchFileEntry[]) => {
      // Deduplicate by name + size
      const existing = new Set(files.map((f) => `${f.file.name}:${f.file.size}`))
      const newEntries = entries.filter((e) => !existing.has(`${e.file.name}:${e.file.size}`))
      if (newEntries.length === 0) return

      const newFiles: BatchFile[] = newEntries.map((e) => ({
        id: `${Date.now()}-${++_batchId}`,
        file: e.file,
        relativePath: e.relativePath,
        status: "pending" as BatchFileStatus,
      }))

      // If there are results, adding new files resets everything
      if (phase === "done") {
        setFiles(newFiles)
        setPhase("selecting")
        setExpandedId(null)
      } else {
        setFiles((prev) => [...prev, ...newFiles])
      }
    },
    [files, phase]
  )

  const handleRemoveFile = useCallback(
    (id: string) => {
      setFiles((prev) => prev.filter((f) => f.id !== id))
      if (expandedId === id) setExpandedId(null)
    },
    [expandedId]
  )

  const handleSubmit = async () => {
    const pending = files.filter((f) => f.status === "pending" || f.status === "error")
    if (pending.length === 0) return

    setFiles((prev) =>
      prev.map((f) =>
        f.status === "pending" || f.status === "error"
          ? { ...f, status: "pending", error: undefined, result: undefined }
          : f
      )
    )

    setPhase("processing")
    const controller = new AbortController()
    abortRef.current = controller

    const CONCURRENCY = 2 // 同时处理 2 个文件

    const processNext = async () => {
      // Find next pending file (use ref for latest state in async context)
      const idx = filesRef.current.findIndex((f) => f.status === "pending")
      if (idx === -1) return

      const f = files[idx]
      if (controller.signal.aborted) return

      setCurrentIndex((prev) => Math.max(prev, idx))

      updateFile(f.id, { status: "compressing", compressLabel: "解码音频..." })

      try {
        const result = await processSingleFile(
          f.file,
          sourceLang,
          targetLang,
          bilingual,
          useCache,
          (update) => {
            updateFile(f.id, {
              status: update.status ?? "processing",
              compressLabel: update.compressLabel,
              uploadLabel: update.uploadLabel,
              taskProgress: update.taskProgress ?? undefined,
            } as Partial<BatchFile>)
          },
          controller.signal
        )

        updateFile(f.id, { status: "done", result })
        await processNext() // Process next in queue
      } catch (err) {
        if (controller.signal.aborted) return
        const msg = err instanceof Error ? err.message : "未知错误"
        let displayMsg = msg
        if (msg.includes("fetch") || msg.includes("Failed to fetch")) {
          displayMsg = "网络连接失败，请检查网络后重试。"
        }
        console.error(`[${f.file.name}] 处理失败:`, err)
        updateFile(f.id, { status: "error", error: displayMsg })
        await processNext()
      }
    }

    // Start CONCURRENCY workers
    const workers = Array.from({ length: CONCURRENCY }, () => processNext())
    await Promise.all(workers)

    abortRef.current = null
    setPhase("done")
  }

  const handleCancel = () => {
    abortRef.current?.abort()
  }

  const pendingCount = files.filter((f) => f.status === "pending" || f.status === "error").length
  const isProcessing = phase === "processing"

  // ── Render ──
  return (
    <div className="space-y-3">
      <BatchDropZone
        entries={files.map((f) => ({ file: f.file, relativePath: f.relativePath }))}
        onFilesAdded={handleFilesAdded}
        disabled={isProcessing}
      />

      <div
        className="rounded-[var(--radius-lg)] p-4 space-y-4"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-subtle)",
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <LanguageSelect
            label="识别语言"
            value={sourceLang}
            onChange={setSourceLang}
            options={SOURCE_LANGUAGES}
            disabled={isProcessing}
          />
          <LanguageSelect
            label="翻译语言"
            value={targetLang}
            onChange={setTargetLang}
            options={TARGET_LANGUAGES}
            disabled={isProcessing}
          />
        </div>

        <label className="flex items-center gap-3 cursor-pointer group">
          <div className="relative">
            <input
              type="checkbox"
              className="sr-only"
              checked={bilingual}
              onChange={(e) => setBilingual(e.target.checked)}
              disabled={isProcessing}
            />
            <div
              className="w-9 h-5 rounded-full transition-all duration-200"
              style={{ background: bilingual ? "var(--color-accent)" : "var(--color-surface-3)" }}
            />
            <div
              className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200 shadow-sm"
              style={{ transform: bilingual ? "translateX(16px)" : "translateX(0)" }}
            />
          </div>
          <span className="text-sm select-none" style={{ color: "var(--color-text-secondary)" }}>
            生成双语字幕
          </span>
        </label>

        <label className="flex items-center gap-3 cursor-pointer group">
          <div className="relative">
            <input
              type="checkbox"
              className="sr-only"
              checked={useCache}
              onChange={(e) => setUseCache(e.target.checked)}
              disabled={isProcessing}
            />
            <div
              className="w-9 h-5 rounded-full transition-all duration-200"
              style={{ background: useCache ? "var(--color-accent)" : "var(--color-surface-3)" }}
            />
            <div
              className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200 shadow-sm"
              style={{ transform: useCache ? "translateX(16px)" : "translateX(0)" }}
            />
          </div>
          <span className="text-sm select-none" style={{ color: "var(--color-text-secondary)" }}>
            使用缓存（同一文件不重复处理）
          </span>
        </label>
      </div>

      {isProcessing ? (
        <button
          onClick={handleCancel}
          className="w-full py-3.5 rounded-[var(--radius-lg)] text-sm font-medium transition-all duration-200"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-danger)",
            border: "1px solid oklch(65% 0.20 20 / 25%)",
            cursor: "pointer",
          }}
        >
          取消处理
        </button>
      ) : (
        <button
          onClick={handleSubmit}
          disabled={pendingCount === 0}
          className="w-full py-3.5 rounded-[var(--radius-lg)] text-sm font-medium transition-all duration-200"
          style={{
            background: pendingCount === 0 ? "var(--color-surface-2)" : "var(--color-accent)",
            color: pendingCount === 0 ? "var(--color-text-tertiary)" : "white",
            cursor: pendingCount === 0 ? "not-allowed" : "pointer",
            boxShadow: pendingCount === 0 ? "none" : "0 0 24px var(--color-accent-glow)",
          }}
        >
          {pendingCount === 0 ? "暂无待处理文件" : `开始批量生成（${pendingCount} 个文件）`}
        </button>
      )}

      {isProcessing && <BatchProgress files={files} currentIndex={currentIndex} />}

      {phase === "done" && (
        <BatchResultPanel
          files={files}
          expandedId={expandedId}
          onToggleExpand={setExpandedId}
          sourceLang={sourceLang}
          targetLang={targetLang}
        />
      )}

      {/* File list with inline results */}
      {files.length > 0 && (
        <FileList
          files={files}
          onRemove={handleRemoveFile}
          disabled={isProcessing}
          expandedId={expandedId}
          onToggleExpand={(id) => setExpandedId(expandedId === id ? null : id)}
          renderResult={(f) => {
            if (!f.result) return null
            const baseName = f.file.name.replace(/\.[^.]+$/, "")
            return (
              <FileResultPreview
                result={f.result}
                baseName={baseName}
                sourceLang={sourceLang}
                targetLang={targetLang}
              />
            )
          }}
        />
      )}
    </div>
  )
}
