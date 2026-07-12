import type { Segment } from "@subgen/shared"
import type { TranscribeResult, TaskProgress } from "@/components/SubtitleGenerator"
import { splitAudio } from "@/lib/compress"

const POLL_INTERVAL = 1500

export interface ProcessUpdate {
  status?: "compressing" | "uploading" | "processing"
  compressLabel?: string
  uploadLabel?: string
  taskProgress?: TaskProgress | null
}

function pollTask(taskId: string, signal?: AbortSignal): Promise<TranscribeResult> {
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      if (signal?.aborted) {
        clearInterval(interval)
        reject(new Error("已取消"))
        return
      }
      try {
        const res = await fetch(`/api/transcribe/${taskId}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (data.status === "done") {
          clearInterval(interval)
          resolve(data.result)
        } else if (data.status === "error") {
          clearInterval(interval)
          reject(new Error(data.message || "处理失败"))
        }
      } catch (err) {
        clearInterval(interval)
        reject(err)
      }
    }, POLL_INTERVAL)
  })
}

export async function processSingleFile(
  file: File,
  sourceLang: string,
  targetLang: string,
  bilingual: boolean,
  useCache: boolean,
  onProgress: (update: ProcessUpdate) => void,
  signal?: AbortSignal
): Promise<TranscribeResult> {
  // ── 压缩 + 分片 ──
  onProgress({ status: "compressing", compressLabel: "解码音频..." })
  let chunks: Awaited<ReturnType<typeof splitAudio>>
  try {
    chunks = await splitAudio(file, ({ phase, ratio }) => {
      if (signal?.aborted) throw new Error("已取消")
      if (phase === "decoding") {
        onProgress({ status: "compressing", compressLabel: `解码音频 ${Math.round(ratio * 100)}%` })
      } else {
        onProgress({ status: "compressing", compressLabel: `生成分片 ${Math.round(ratio * 100)}%` })
      }
    })
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === "RangeError" || err.message.includes("memory") || err.message.includes("allocation")) {
        throw new Error("浏览器内存不足，无法处理此文件。请截取较短片段后重试。")
      }
      if (err.message.includes("could not be read")) {
        throw new Error(
          "无法读取文件。文件可能在移动硬盘或网络盘上，请先复制到本地桌面再试。" +
            "（浏览器对大文件引用有时效限制，拖放比点击选择更稳定）"
        )
      }
      if (
        err.message.includes("Unable to decode") ||
        err.message.includes("decode") ||
        err.message.includes("不兼容")
      ) {
        throw err // Already wrapped by compress.ts
      }
    }
    throw err
  }

  // ── 并行上传每片 ──
  let doneChunks = 0
  const totalChunks = chunks.length
  const uploadStatus = () => (totalChunks > 1 ? `上传中 ${doneChunks}/${totalChunks} 片...` : "上传中...")

  onProgress({ status: "uploading", uploadLabel: uploadStatus() })

  const uploadChunk = async (i: number) => {
    if (signal?.aborted) throw new Error("已取消")
    const { file: chunkFile, startTime } = chunks[i]

    const fd = new FormData()
    fd.append("file", chunkFile)
    fd.append("sourceLang", sourceLang)
    fd.append("targetLang", "none")
    fd.append("bilingual", "false")
    fd.append("skipCache", String(!useCache))

    const res = await fetch("/api/transcribe", { method: "POST", body: fd })
    let data: { segments?: Segment[]; error?: string; task_id?: string }
    try {
      data = await res.json()
    } catch {
      throw new Error(`第 ${i + 1} 片响应解析失败（HTTP ${res.status}）`)
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)

    if (data.task_id) {
      const taskResult = await pollTask(data.task_id, signal)
      doneChunks++
      onProgress({ status: "uploading", uploadLabel: uploadStatus() })
      return (taskResult.segments ?? []).map((s) => ({
        ...s,
        start: s.start + startTime,
        end: s.end + startTime,
      }))
    }
    doneChunks++
    onProgress({ status: "uploading", uploadLabel: uploadStatus() })
    return (data.segments ?? []).map((s) => ({
      ...s,
      start: s.start + startTime,
      end: s.end + startTime,
    }))
  }

  const results = await Promise.all(chunks.map((_, i) => uploadChunk(i)))
  const allSegments: Segment[] = results.flat()

  if (allSegments.length === 0) {
    throw new Error("未检测到语音内容")
  }

  // ── 翻译（所有分片合并后统一翻译）──
  onProgress({ status: "processing" })

  const translateFd = new FormData()
  translateFd.append("segments", JSON.stringify(allSegments))
  translateFd.append("sourceLang", sourceLang)
  translateFd.append("targetLang", targetLang)
  translateFd.append("bilingual", String(bilingual))
  translateFd.append("skipCache", String(!useCache))

  const translateRes = await fetch("/api/translate", { method: "POST", body: translateFd })
  let translateData: { translated?: Segment[]; srt?: TranscribeResult["srt"]; error?: string }
  try {
    translateData = await translateRes.json()
  } catch {
    throw new Error("翻译响应解析失败")
  }
  if (!translateRes.ok) throw new Error(translateData.error || `HTTP ${translateRes.status}`)

  return {
    segments: allSegments,
    translated: translateData.translated ?? [],
    srt: translateData.srt ?? { original: "", translated: "", bilingual: null },
  }
}
