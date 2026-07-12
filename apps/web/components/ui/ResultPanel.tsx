"use client"

import { useState } from "react"
import type { TranscribeResult } from "../SubtitleGenerator"

interface ResultPanelProps {
  result: TranscribeResult
  baseName: string
  sourceLang: string
  targetLang: string
}

function download(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function DownloadRow({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  onClick: () => void
}) {
  const [clicked, setClicked] = useState(false)

  const handleClick = () => {
    onClick()
    setClicked(true)
    setTimeout(() => setClicked(false), 2000)
  }

  return (
    <button
      onClick={handleClick}
      className="w-full flex items-center gap-3 px-4 py-3 rounded-[var(--radius-md)] transition-all duration-150 group"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border-subtle)",
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLElement).style.borderColor = "var(--color-border)"
        ;(e.currentTarget as HTMLElement).style.background = "var(--color-surface-3)"
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLElement).style.borderColor = "var(--color-border-subtle)"
        ;(e.currentTarget as HTMLElement).style.background = "var(--color-surface-2)"
      }}
    >
      <div
        className="w-8 h-8 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0"
        style={{
          background: "var(--color-surface-3)",
          color: "var(--color-text-secondary)",
        }}
      >
        {icon}
      </div>
      <div className="flex-1 text-left min-w-0">
        <p className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
          {title}
        </p>
        <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
          {subtitle}
        </p>
      </div>
      <div
        className="transition-all duration-200"
        style={{
          color: clicked ? "var(--color-success)" : "var(--color-text-tertiary)",
        }}
      >
        {clicked ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M3 8l4 4 6-6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 3v7M5 7l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        )}
      </div>
    </button>
  )
}

function SrtIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="3" y1="5.5" x2="11" y2="5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="3" y1="8.5" x2="8" y2="8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

export function ResultPanel({ result, baseName, sourceLang, targetLang }: ResultPanelProps) {
  const [showPreview, setShowPreview] = useState(false)
  const [previewTab, setPreviewTab] = useState<"original" | "translated" | "bilingual">("original")

  const previewItems = (() => {
    switch (previewTab) {
      case "translated":
        return result.segments.map((seg, i) => ({
          primary: result.translated[i]?.text ?? seg.text,
          secondary: null,
        }))
      case "bilingual":
        return result.segments.map((seg, i) => ({
          primary: seg.text,
          secondary: result.translated[i]?.text ?? null,
        }))
      default:
        return result.segments.map((seg) => ({
          primary: seg.text,
          secondary: null,
        }))
    }
  })()

  return (
    <div className="space-y-2 animate-fade-up">
      {/* Stats */}
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
            识别完成
          </span>
        </div>
        <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
          {result.segments.length} 条字幕
        </span>
      </div>

      {/* Downloads */}
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
      <button
        onClick={() => setShowPreview(!showPreview)}
        className="w-full flex items-center justify-between px-4 py-2.5 rounded-[var(--radius-md)] text-xs transition-colors"
        style={{
          color: "var(--color-text-tertiary)",
          background: "transparent",
          border: "1px solid transparent",
        }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLElement).style.borderColor = "var(--color-border-subtle)"
          ;(e.currentTarget as HTMLElement).style.background = "var(--color-surface-1)"
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLElement).style.borderColor = "transparent"
          ;(e.currentTarget as HTMLElement).style.background = "transparent"
        }}
      >
        <span>预览字幕内容</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          style={{
            transform: showPreview ? "rotate(180deg)" : "none",
            transition: "transform 0.2s ease",
          }}
        >
          <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {showPreview && (
        <div
          className="rounded-[var(--radius-md)] overflow-hidden animate-fade-up"
          style={{
            border: "1px solid var(--color-border-subtle)",
          }}
        >
          <div
            className="px-4 py-2.5 flex items-center justify-between"
            style={{
              background: "var(--color-surface-2)",
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
            <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
              前 {Math.min(result.segments.length, 10)} 条
            </span>
          </div>
          <div
            className="overflow-y-auto divide-y"
            style={
              {
                maxHeight: "280px",
                background: "var(--color-surface-1)",
                "--tw-divide-opacity": 1,
                borderColor: "var(--color-border-subtle)",
              } as React.CSSProperties
            }
          >
            {previewItems.slice(0, 10).map((item, i) => (
              <div key={i} className="px-4 py-3 flex gap-4" style={{ borderColor: "var(--color-border-subtle)" }}>
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
              <div className="px-4 py-3 text-xs text-center" style={{ color: "var(--color-text-tertiary)" }}>
                ··· 剩余 {result.segments.length - 10} 条
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
