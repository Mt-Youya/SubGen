import { NextRequest, NextResponse } from "next/server"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params

  if (process.env.NODE_ENV === "development") {
    try {
      const res = await fetch(`http://localhost:8000/transcribe/${taskId}`)
      const data = await res.json()
      if (!res.ok) return NextResponse.json(data, { status: res.status })
      return NextResponse.json(data)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return NextResponse.json({ error: msg }, { status: 503 })
    }
  }

  // 生产模式：任务由 Next.js route.ts 内存管理（暂不支持多实例）
  return NextResponse.json({ error: "Not implemented in production" }, { status: 501 })
}
