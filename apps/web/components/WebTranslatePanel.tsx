"use client"

import { useState, useCallback, useRef } from "react"
import type { Segment } from "@subgen/shared"
import { segmentsToSrt, mergeBilingual } from "@subgen/shared"
import { LanguageSelect } from "@/components/ui/LanguageSelect"

const SOURCE_LANGUAGES = [
  { code: "ja", label: "日语", flag: "🇯🇵" },
  { code: "zh", label: "中文", flag: "🇨🇳" },
  { code: "en", label: "英语", flag: "🇺🇸" },
  { code: "ko", label: "韩语", flag: "🇰🇷" },
  { code: "fr", label: "法语", flag: "🇫🇷" },
  { code: "de", label: "德语", flag: "🇩🇪" },
  { code: "es", label: "西班牙语", flag: "🇪🇸" },
]

const TARGET_LANGUAGES = [
  { code: "ZH", label: "中文（简体）", flag: "🇨🇳" },
  { code: "ZH-TW", label: "中文（繁体）", flag: "🇹🇼" },
  { code: "EN-US", label: "英语", flag: "🇺🇸" },
  { code: "JA", label: "日语", flag: "🇯🇵" },
  { code: "KO", label: "韩语", flag: "🇰🇷" },
  { code: "FR", label: "法语", flag: "🇫🇷" },
  { code: "DE", label: "德语", flag: "🇩🇪" },
]

function parseSrt(content: string): Segment[] {
  const segments: Segment[] = []
  const blocks = content.trim().split(/\n\s*\n/)
  for (const block of blocks) {
    const lines = block.trim().split("\n")
    if (lines.length < 3) continue
    const timeMatch = lines[1].match(/(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/)
    if (!timeMatch) continue
    const start =
      parseInt(timeMatch[1]) * 3600 +
      parseInt(timeMatch[2]) * 60 +
      parseInt(timeMatch[3]) +
      parseInt(timeMatch[4]) / 1000
    const end =
      parseInt(timeMatch[5]) * 3600 +
      parseInt(timeMatch[6]) * 60 +
      parseInt(timeMatch[7]) +
      parseInt(timeMatch[8]) / 1000
    const text = lines.slice(2).join("\n").trim()
    if (text) segments.push({ start, end, text })
  }
  return segments
}

type Status = "idle" | "processing" | "done" | "error"

export function WebTranslatePanel() {
  const [files, setFiles] = useState<{ name: string; segments: Segment[] }[]>([])
  const [sourceLang, setSourceLang] = useState("ja")
  const [targetLang, setTargetLang] = useState("ZH")
  const [bilingual, setBilingual] = useState(false)
  const [status, setStatus] = useState<Status>("idle")
  const [error, setError] = useState("")
  const [results, setResults] = useState<
    { name: string; originalSrt: string; translatedSrt: string; bilingualSrt: string | null }[]
  >([])
  const [progress, setProgress] = useState(0)
  const [total, setTotal] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback((fileList: FileList) => {
    const newFiles: { name: string; segments: Segment[] }[] = []
    let loaded = 0
    const total = fileList.length

    Array.from(fileList).forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => {
        const segments = parseSrt(reader.result as string)
        newFiles.push({ name: file.name, segments })
        loaded++
        if (loaded === total) {
          setFiles((prev) => {
            const existing = new Set(prev.map((f) => f.name))
            const toAdd = newFiles.filter((f) => !existing.has(f.name))
            return [...prev, ...toAdd]
          })
        }
      }
      reader.readAsText(file)
    })
  }, [])

  const handleSubmit = async () => {
    const pending = files.filter((f) => f.segments.length > 0)
    if (pending.length === 0) return

    setStatus("processing")
    setError("")
    setResults([])
    setTotal(pending.length)
    setProgress(0)

    const newResults: typeof results = []

    for (let i = 0; i < pending.length; i++) {
      const f = pending[i]
      try {
        const fd = new FormData()
        fd.append("segments", JSON.stringify(f.segments))
        fd.append("sourceLang", sourceLang)
        fd.append("targetLang", targetLang)
        fd.append("bilingual", String(bilingual))

        const res = await fetch("/api/translate", { method: "POST", body: fd })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)

        newResults.push({
          name: f.name,
          originalSrt: data.srt?.original ?? segmentsToSrt(f.segments),
          translatedSrt: data.srt?.translated ?? "",
          bilingualSrt: data.srt?.bilingual ?? null,
        })
      } catch (err) {
        setError((prev) => prev + `${f.name}: ${err instanceof Error ? err.message : "未知错误"}\n`)
      }
      setProgress(i + 1)
    }

    setResults(newResults)
    setStatus("done")
  }

  const downloadBlob = (content: string, filename: string) => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className="rounded-md p-5 flex flex-col gap-4"
        style={{ background: "var(--color-surface-1)", border: "0.5px solid var(--color-border-subtle)" }}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".srt"
          className="sr-only"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files)
            e.target.value = ""
          }}
        />

        {/* Upload area */}
        <div
          className="rounded-md transition-all duration-200 cursor-pointer"
          style={{
            border: "1.5px dashed var(--color-border)",
            background: "var(--color-surface-2)",
            padding: "28px 20px",
          }}
          onClick={() => fileRef.current?.click()}
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14,2 14,8 20,8" />
            </svg>
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
                {files.length > 0 ? `已选 ${files.length} 个 SRT 文件` : "点击选择 SRT 字幕文件"}
              </p>
              <p className="text-xs mt-1" style={{ color: "var(--color-text-tertiary)" }}>
                {files.length > 0 ? "点击更换或继续添加" : "支持多选，每文件独立翻译"}
              </p>
            </div>
          </div>
        </div>

        {files.length > 0 && (
          <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
            {files.map((f, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-xs px-2 py-1 rounded"
                style={{ background: "var(--color-surface-2)" }}
              >
                <span className="truncate flex-1" style={{ color: "var(--color-text-secondary)" }}>
                  {f.name}
                </span>
                <span style={{ color: "var(--color-text-tertiary)" }}>{f.segments.length} 条</span>
                <button
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  className="ml-2 px-1.5 py-0.5 rounded"
                  style={{ color: "var(--color-text-tertiary)" }}
                  disabled={status === "processing"}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <LanguageSelect
            label="源语言"
            value={sourceLang}
            onChange={setSourceLang}
            options={SOURCE_LANGUAGES}
            disabled={status === "processing"}
          />
          <LanguageSelect
            label="目标语言"
            value={targetLang}
            onChange={setTargetLang}
            options={TARGET_LANGUAGES}
            disabled={status === "processing"}
          />
        </div>

        <label className="flex items-center gap-3 cursor-pointer group">
          <div className="relative">
            <input
              type="checkbox"
              className="sr-only"
              checked={bilingual}
              onChange={(e) => setBilingual(e.target.checked)}
              disabled={status === "processing"}
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

        <button
          onClick={handleSubmit}
          disabled={files.length === 0 || status === "processing"}
          className="w-full py-3.5 rounded-[var(--radius-lg)] text-sm font-medium transition-all duration-200"
          style={{
            background: files.length === 0 ? "var(--color-surface-2)" : "var(--color-accent)",
            color: files.length === 0 ? "var(--color-text-tertiary)" : "white",
            cursor: files.length === 0 ? "not-allowed" : "pointer",
          }}
        >
          {status === "processing"
            ? `翻译中 (${progress}/${total})...`
            : files.length === 0
              ? "请先选择 SRT 文件"
              : `开始翻译（${files.length} 个文件）`}
        </button>

        {status === "error" && error && (
          <div
            className="rounded-md px-4 py-3 text-sm"
            style={{ background: "oklch(65% 0.20 20 / 8%)", color: "var(--color-danger)" }}
          >
            <pre className="text-xs whitespace-pre-wrap" style={{ fontFamily: "JetBrains Mono, monospace" }}>
              {error}
            </pre>
          </div>
        )}
      </div>

      {status === "done" && results.length > 0 && (
        <div
          className="rounded-md overflow-hidden"
          style={{ background: "var(--color-surface-1)", border: "0.5px solid var(--color-border-subtle)" }}
        >
          <div
            className="px-4 py-2.5 flex items-center justify-between"
            style={{ borderBottom: "0.5px solid var(--color-border-subtle)" }}
          >
            <span className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
              翻译结果
            </span>
            <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
              {results.length} 个文件
            </span>
          </div>
          <div className="divide-y" style={{ borderColor: "var(--color-border-subtle)" }}>
            {results.map((r, i) => (
              <div key={i} className="px-4 py-3 flex items-center gap-3">
                <span
                  className="text-xs shrink-0"
                  style={{ color: "var(--color-text-tertiary)", fontFamily: "JetBrains Mono, monospace" }}
                >
                  {i + 1}.
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: "var(--color-text-primary)" }}>
                    {r.name}
                  </p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    onClick={() => downloadBlob(r.translatedSrt, r.name.replace(/\.srt$/i, ".translated.srt"))}
                    className="px-2.5 py-1 text-xs rounded"
                    style={{ background: "var(--color-accent)", color: "white" }}
                  >
                    下载译文
                  </button>
                  {r.bilingualSrt && (
                    <button
                      onClick={() => downloadBlob(r.bilingualSrt!, r.name.replace(/\.srt$/i, ".bilingual.srt"))}
                      className="px-2.5 py-1 text-xs rounded"
                      style={{
                        background: "var(--color-surface-2)",
                        color: "var(--color-text-secondary)",
                        border: "1px solid var(--color-border)",
                      }}
                    >
                      双语
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
