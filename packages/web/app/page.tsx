import { SubtitleGenerator } from "@/components/SubtitleGenerator";

export default function Home() {
  return (
    <div className="relative min-h-dvh flex flex-col">
      {/* Ambient background gradient */}
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

      <header className="relative z-10 px-6 pt-10 pb-0 text-center">
        <div className="inline-flex items-center gap-2 mb-6">
          <span
            className="text-xs font-medium px-2.5 py-1 rounded-full"
            style={{
              background: "var(--color-accent-muted)",
              color: "var(--color-accent)",
              border: "1px solid oklch(65% 0.22 265 / 20%)",
            }}
          >
            Whisper · DeepL
          </span>
        </div>

        <h1
          className="text-4xl font-semibold tracking-tight mb-3"
          style={{ color: "var(--color-text-primary)" }}
        >
          SubGen
        </h1>
        <p
          className="text-base max-w-xs mx-auto leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          上传视频或音频，自动识别语音并翻译字幕
        </p>
      </header>

      <main className="relative z-10 flex-1 flex items-start justify-center px-4 pt-10 pb-16">
        <div className="w-full max-w-2xl">
          <SubtitleGenerator />
        </div>
      </main>

      <footer className="relative z-10 pb-6 text-center">
        <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
          powered by{" "}
          <a
            href="https://www.xfyun.cn"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 transition-colors hover:text-[oklch(65%_0.22_265)]"
          >
            讯飞
          </a>
          {" & "}
          <a
            href="https://cloud.tencent.com/product/tmt"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 transition-colors hover:text-[oklch(65%_0.22_265)]"
          >
            腾讯翻译
          </a>
        </p>
      </footer>
    </div>
  );
}
