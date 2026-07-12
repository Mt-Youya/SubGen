"use client"

import { useState } from "react"
import { SubtitleGenerator } from "@/components/SubtitleGenerator"
import { WebExtractPanel } from "@/components/WebExtractPanel"
import { WebTranscriptPanel } from "@/components/WebTranscriptPanel"
import { WebTranslatePanel } from "@/components/WebTranslatePanel"
import { ThemeToggle } from "@/components/ui/ThemeToggle"

type Tab = "extract" | "transcript" | "translate" | "subtitle"

export default function Home() {
  const [tab, setTab] = useState<Tab>("subtitle")

  return (
    <div className="relative min-h-dvh flex flex-col">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 overflow-hidden"
        style={{
          background: `
            radial-gradient(ellipse 80% 50% at 20% -10%, oklch(65% 0.22 265 / 8%) 0%, transparent 60%),
            radial-gradient(ellipse 60% 40% at 80% 110%, oklch(72% 0.16 145 / 5%) 0%, transparent 60%)
          `,
        }}
      />

      <header className="relative z-10 px-6 pt-6 pb-0 text-center">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight mb-6" style={{ color: "var(--color-text-primary)" }}>
          SubGen
        </h1>

        <div
          className="inline-flex rounded-md p-1 gap-1"
          style={{ background: "var(--color-surface-1)", border: "0.5px solid var(--color-border-subtle)" }}
        >
          {(
            [
              { key: "extract", label: "音频提取" },
              { key: "transcript", label: "转录" },
              { key: "translate", label: "翻译" },
              { key: "subtitle", label: "字幕生成" },
            ] as { key: Tab; label: string }[]
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="px-5 py-2 rounded-md text-sm font-medium transition-all"
              style={
                tab === key
                  ? {
                      background: "var(--color-accent)",
                      color: "#fff",
                      boxShadow: "0 2px 8px var(--color-accent-glow)",
                    }
                  : { color: "var(--color-text-secondary)" }
              }
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="relative z-10 flex-1 px-4 pt-8 pb-16">
        <div className="flex items-start justify-center" style={{ display: tab === "extract" ? "flex" : "none" }}>
          <div className="w-full max-w-3xl">
            <WebExtractPanel />
          </div>
        </div>
        <div className="flex items-start justify-center" style={{ display: tab === "transcript" ? "flex" : "none" }}>
          <div className="w-full max-w-3xl">
            <WebTranscriptPanel />
          </div>
        </div>
        <div className="flex items-start justify-center" style={{ display: tab === "translate" ? "flex" : "none" }}>
          <div className="w-full max-w-3xl">
            <WebTranslatePanel />
          </div>
        </div>
        <div className="flex items-start justify-center" style={{ display: tab === "subtitle" ? "flex" : "none" }}>
          <div className="w-full max-w-2xl">
            <SubtitleGenerator />
          </div>
        </div>
      </main>
    </div>
  )
}
