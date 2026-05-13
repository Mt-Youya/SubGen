/**
 * 在浏览器中把任意音视频文件压缩为 16kHz 单声道 WAV。
 * Whisper 只需要 16kHz mono，WAV PCM 16-bit 约 1.9 MB/min。
 * 典型 1h 视频 ~300 MB → 压缩后 ~110 MB；再用 resampleRate 调低可更小。
 *
 * 流程：File → ArrayBuffer → AudioContext.decodeAudioData
 *       → 降采样混音 → 手写 WAV header → Blob
 */

export interface CompressProgress {
  phase: "decoding" | "encoding";
  ratio: number; // 0–1
}

const TARGET_SAMPLE_RATE = 16000;

export async function compressAudio(
  file: File,
  onProgress?: (p: CompressProgress) => void
): Promise<File> {
  onProgress?.({ phase: "decoding", ratio: 0 });

  const arrayBuffer = await file.arrayBuffer();

  // OfflineAudioContext 仅做解码，不需要实际播放
  const audioCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    audioCtx.close();
  }

  onProgress?.({ phase: "decoding", ratio: 1 });
  onProgress?.({ phase: "encoding", ratio: 0 });

  // 用 OfflineAudioContext 做降采样 + 混音到单声道
  const duration = decoded.duration;
  const outLength = Math.ceil(duration * TARGET_SAMPLE_RATE);
  const offlineCtx = new OfflineAudioContext(1, outLength, TARGET_SAMPLE_RATE);

  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);

  const rendered = await offlineCtx.startRendering();

  onProgress?.({ phase: "encoding", ratio: 0.5 });

  const pcm = rendered.getChannelData(0);
  const wavBlob = pcmToWav(pcm, TARGET_SAMPLE_RATE);

  onProgress?.({ phase: "encoding", ratio: 1 });

  const baseName = file.name.replace(/\.[^.]+$/, "");
  return new File([wavBlob], `${baseName}_compressed.wav`, { type: "audio/wav" });
}

/** 把 Float32 PCM 数据打包为标准 WAV（16-bit PCM） */
function pcmToWav(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = bytesPerSample; // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");
  // fmt chunk
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);       // chunk size
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);       // bits per sample
  // data chunk
  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples: Float32 → Int16
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeStr(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
