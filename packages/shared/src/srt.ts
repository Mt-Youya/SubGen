export interface Segment {
  start: number
  end: number
  text: string
}

function toSrtTime(seconds: number): string {
  const ms = Math.floor((seconds % 1) * 1000)
  const s = Math.floor(seconds) % 60
  const m = Math.floor(seconds / 60) % 60
  const h = Math.floor(seconds / 3600)
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`
}

export function segmentsToSrt(segments: Segment[]): string {
  return segments
    .map((seg, i) => {
      const start = toSrtTime(seg.start)
      const end = toSrtTime(seg.end)
      return `${i + 1}\n${start} --> ${end}\n${seg.text}\n`
    })
    .join("\n")
}

export function mergeBilingual(original: Segment[], translated: Segment[]): string {
  return original
    .map((seg, i) => {
      const start = toSrtTime(seg.start)
      const end = toSrtTime(seg.end)
      const transText = translated[i]?.text ?? ""
      return `${i + 1}\n${start} --> ${end}\n${seg.text}\n${transText}\n`
    })
    .join("\n")
}
