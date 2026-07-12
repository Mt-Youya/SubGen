import { NextRequest, NextResponse } from "next/server"

export const maxDuration = 300

export async function POST(req: NextRequest) {
  const formData = await req.formData()

  // dev mode: forward to local Python server
  if (process.env.NODE_ENV === "development") {
    try {
      const res = await fetch("http://localhost:8000/extract", {
        method: "POST",
        body: formData,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: `Python server returned ${res.status}` }))
        return NextResponse.json({ error: err.detail || "Extraction failed" }, { status: res.status })
      }
      // Stream the audio file back
      const blob = await res.blob()
      const disposition = res.headers.get("content-disposition") ?? 'attachment; filename="audio.wav"'
      return new NextResponse(blob, {
        status: 200,
        headers: {
          "Content-Type": res.headers.get("content-type") ?? "audio/wav",
          "Content-Disposition": disposition,
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return NextResponse.json(
        { error: `本地 Python 服务未启动，请先运行：\ncd server && uvicorn api:app --reload\n\n原始错误：${msg}` },
        { status: 503 }
      )
    }
  }

  // Production: ffmpeg required on server
  return NextResponse.json({ error: "音频提取仅在开发模式下可用。生产环境需要部署 ffmpeg 服务。" }, { status: 501 })
}
