/**
 * 在浏览器中把任意音视频文件压缩为 16kHz 单声道 WAV，并按需分片。
 * Whisper 只需要 16kHz mono，WAV PCM 16-bit = 44 + samples×2 字节。
 *
 * Vercel Function 请求体上限 4.5 MB，每片保证不超 MAX_UPLOAD_BYTES。
 * 内存优化：将解码/降采样/编码拆分到独立作用域，
 * 避免原始 ArrayBuffer 与解码后的 AudioBuffer 同时驻留内存。
 */

export interface CompressProgress {
  phase: "decoding" | "encoding";
  ratio: number; // 0–1
}

export interface AudioChunk {
  file: File;
  startTime: number; // 该分片在原始音频中的起始秒数，用于修正 segment 时间戳
}

const TARGET_SAMPLE_RATE = 16000;
// Vercel 上限 4.5 MB，留 0.5 MB 余量给 multipart 开销
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4 MB
// WAV header = 44 bytes，剩余字节数 / 2（16-bit）= 每片最大样本数
const MAX_SAMPLES = Math.floor((MAX_UPLOAD_BYTES - 44) / 2);

/**
 * 解码 + 压缩 + 分片。
 * 返回 AudioChunk[]，每片 ≤ 4 MB，携带时间偏移用于合并时修正时间戳。
 * 若音频较短（单片即可），返回长度为 1 的数组。
 */
export async function splitAudio(
  file: File,
  onProgress?: (p: CompressProgress) => void
): Promise<AudioChunk[]> {
  onProgress?.({ phase: "decoding", ratio: 0 });

  const rendered = await decodeAndResample(file, onProgress);
  const pcm = rendered.getChannelData(0);

  onProgress?.({ phase: "encoding", ratio: 0 });

  const chunks: AudioChunk[] = [];
  let offset = 0;
  const total = pcm.length;
  let chunkIdx = 0;

  while (offset < total) {
    const slice = pcm.subarray(offset, offset + MAX_SAMPLES);
    const wav = pcmToWav(slice, TARGET_SAMPLE_RATE);
    const startTime = offset / TARGET_SAMPLE_RATE;
    const baseName = file.name.replace(/\.[^.]+$/, "");
    const chunkFile = new File(
      [wav],
      chunks.length === 0 && total <= MAX_SAMPLES
        ? `${baseName}_compressed.wav`
        : `${baseName}_part${chunkIdx + 1}.wav`,
      { type: "audio/wav" }
    );
    chunks.push({ file: chunkFile, startTime });
    offset += MAX_SAMPLES;
    chunkIdx++;
    onProgress?.({ phase: "encoding", ratio: Math.min(1, offset / total) });
  }

  return chunks;
}

/** @deprecated 用 splitAudio 替代，保留兼容 */
export async function compressAudio(
  file: File,
  onProgress?: (p: CompressProgress) => void
): Promise<File> {
  const chunks = await splitAudio(file, onProgress);
  return chunks[0].file;
}

/**
 * 读取文件 → AudioContext 解码 → OfflineAudioContext 降采样到 16kHz 单声道。
 * 原始 ArrayBuffer 和解码后的 AudioBuffer 在此函数返回后即可被 GC。
 */
async function decodeAndResample(
  file: File,
  onProgress?: (p: CompressProgress) => void
): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();

  const audioCtx = new AudioContext();
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    // arrayBuffer 至此不再需要

    onProgress?.({ phase: "decoding", ratio: 1 });
    onProgress?.({ phase: "encoding", ratio: 0 });

    const outLength = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
    const offlineCtx = new OfflineAudioContext(1, outLength, TARGET_SAMPLE_RATE);

    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineCtx.destination);
    source.start(0);

    const rendered = await offlineCtx.startRendering();
    // decoded 至此不再需要

    return rendered;
  } finally {
    audioCtx.close();
  }
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
