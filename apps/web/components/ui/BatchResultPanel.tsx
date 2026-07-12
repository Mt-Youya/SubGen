"use client"

import { useState } from "react"
import type { BatchFile, TranscribeResult } from "../SubtitleGenerator"
import { DownloadRow, download } from "./DownloadRow"
import { SrtIcon } from "./Icons"

interface BatchResultPanelProps {
  files: BatchFile[]
  expandedId: string | null
  onToggleExpand: (id: string) => void
  sourceLang: string
  targetLang: string
}

function FileResultPreview({
  result,
  baseName,
  sourceLang,
  targetLang,
}: {
  result: TranscribeResult
  baseName: string
  sourceLang: string
  targetLang: string
}) {
  const [previewTab, setPreviewTab] = useState<"original" | "translated" | "bilingual">("original")

  const items = (() => {
    switch (previewTab) {
      case "translated":
        return result.segments.map((seg, i) => ({
          primary: result.translated[i]?.text ?? seg.text,
          secondary: null as string | null,
        }))
      case "bilingual":
        return result.segments.map((seg, i) => ({
          primary: seg.text,
          secondary: result.translated[i]?.text ?? null,
        }))
      default:
        return result.segments.map((seg) => ({
          primary: seg.text,
          secondary: null as string | null,
        }))
    }
  })()

  return (
    <div className="space-y-2">
      {/* Per-file downloads */}
      <div className="space-y-1.5">
        <DownloadRow
          icon={<SrtIcon />}
          title="原文字幕"
          subtitle={`${sourceLang.toUpperCase()} · SRT`}
          onClick={() => download(result.srt.original, `${baseName}.${sourceLang}.srt`)}
        />
        <DownloadRow
          icon={<SrtIcon />}
          title="译文字幕"
          subtitle={`${targetLang} · SRT`}
          onClick={() => download(result.srt.translated, `${baseName}.${targetLang.toLowerCase()}.srt`)}
        />
        {result.srt.bilingual && (
          <DownloadRow
            icon={<SrtIcon />}
            title="双语字幕"
            subtitle="原文 + 译文 · SRT"
            onClick={() => download(result.srt.bilingual!, `${baseName}.bilingual.srt`)}
          />
        )}
      </div>

      {/* Preview toggle */}
      <div
        className="rounded-[var(--radius-md)] overflow-hidden"
        style={{ border: "1px solid var(--color-border-subtle)" }}
      >
        <div
          className="px-4 py-2.5 flex items-center"
          style={{
            background: "var(--color-surface-1)",
            borderBottom: "1px solid var(--color-border-subtle)",
          }}
        >
          <div className="flex items-center gap-1">
            {(["original", "translated", "bilingual"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setPreviewTab(tab)}
                className="px-2.5 py-1 rounded-[var(--radius-sm)] text-xs transition-all duration-150"
                style={{
                  background: previewTab === tab ? "var(--color-surface-3)" : "transparent",
                  color: previewTab === tab ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
                  fontWeight: previewTab === tab ? 500 : 400,
                }}
              >
                {{ original: "原文", translated: "译文", bilingual: "双语" }[tab]}
              </button>
            ))}
          </div>
          <span className="text-xs ml-auto" style={{ color: "var(--color-text-tertiary)" }}>
            共 {result.segments.length} 条
          </span>
        </div>
        <div
          className="overflow-y-auto divide-y"
          style={
            {
              maxHeight: "200px",
              background: "var(--color-surface-1)",
              borderColor: "var(--color-border-subtle)",
            } as React.CSSProperties
          }
        >
          {items.slice(0, 10).map((item, i) => (
            <div key={i} className="px-4 py-2.5 flex gap-3" style={{ borderColor: "var(--color-border-subtle)" }}>
              <span className="text-xs tabular-nums shrink-0 pt-0.5" style={{ color: "var(--color-text-tertiary)" }}>
                {i + 1}
              </span>
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm" style={{ color: "var(--color-text-primary)" }}>
                  {item.primary}
                </p>
                {item.secondary && (
                  <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                    {item.secondary}
                  </p>
                )}
              </div>
            </div>
          ))}
          {result.segments.length > 10 && (
            <div className="px-4 py-2.5 text-xs text-center" style={{ color: "var(--color-text-tertiary)" }}>
              ··· 剩余 {result.segments.length - 10} 条
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function BatchResultPanel({ files, expandedId, onToggleExpand, sourceLang, targetLang }: BatchResultPanelProps) {
  const doneFiles = files.filter((f) => f.status === "done" && f.result)
  const errorFiles = files.filter((f) => f.status === "error")
  const totalSegments = doneFiles.reduce((sum, f) => sum + (f.result?.segments.length ?? 0), 0)

  if (doneFiles.length === 0 && errorFiles.length === 0) return null

  return (
    <div className="space-y-2 animate-fade-up">
      {/* Summary */}
      <div
        className="flex items-center justify-between px-4 py-3 rounded-[var(--radius-md)]"
        style={{
          background: "var(--color-accent-muted)",
          border: "1px solid oklch(65% 0.22 265 / 20%)",
        }}
      >
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--color-accent)" }} />
          <span className="text-sm" style={{ color: "var(--color-accent)" }}>
            批量完成
          </span>
        </div>
        <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
          {doneFiles.length} 个文件 · {totalSegments} 条字幕
          {errorFiles.length > 0 && ` · ${errorFiles.length} 个失败`}
        </span>
      </div>

      {/* Batch download all */}
      {doneFiles.length > 1 && (
        <div className="space-y-1.5">
          <DownloadRow
            icon={<SrtIcon />}
            title="下载全部原文字幕"
            subtitle={`${doneFiles.length} 个文件 · SRT`}
            onClick={async () => {
              for (const f of doneFiles) {
                if (!f.result) continue
                const baseName = f.file.name.replace(/\.[^.]+$/, "")
                download(f.result.srt.original, `${baseName}.${sourceLang}.srt`)
                await new Promise((r) => setTimeout(r, 300))
              }
            }}
          />
          <DownloadRow
            icon={<SrtIcon />}
            title="下载全部译文字幕"
            subtitle={`${doneFiles.length} 个文件 · SRT`}
            onClick={async () => {
              for (const f of doneFiles) {
                if (!f.result) continue
                const baseName = f.file.name.replace(/\.[^.]+$/, "")
                download(f.result.srt.translated, `${baseName}.${targetLang.toLowerCase()}.srt`)
                await new Promise((r) => setTimeout(r, 300))
              }
            }}
          />
        </div>
      )}
    </div>
  )
}

export { FileResultPreview }
