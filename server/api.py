"""
本地开发用 FastAPI 服务
在 server/ 目录下运行：uvicorn api:app --reload --port 8000
"""

import gc
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="SubGen Local API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["POST"],
    allow_headers=["*"],
)

# 全局加载模型，优先使用 faster-whisper，失败则回退到原版 whisper
model = None
model_type = None  # "faster" or "original"

try:
    from faster_whisper import WhisperModel
    model = WhisperModel("medium", device="cpu", compute_type="int8")
    model_type = "faster"
    print(f"[模型] 使用 faster-whisper medium (CPU/int8)")
except Exception as e:
    print(f"[模型] faster-whisper 加载失败: {e}")
    print("[模型] 回退到原版 openai-whisper medium...")
    import whisper
    model = whisper.load_model("medium")
    model_type = "original"
    print(f"[模型] 使用 openai-whisper medium (CPU)")


CACHE_DIR = Path.home() / ".subgen_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def file_md5(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def cache_get(hash_: str) -> dict | None:
    f = CACHE_DIR / hash_ / "response.json"
    if f.exists():
        with open(f, "r", encoding="utf-8") as fp:
            return json.load(fp)
    return None


def cache_put(hash_: str, data: dict, original_srt: str, translated_srt: str, bilingual_srt: str | None) -> None:
    d = CACHE_DIR / hash_
    d.mkdir(parents=True, exist_ok=True)
    with open(d / "response.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    (d / "original.srt").write_text(original_srt, encoding="utf-8")
    (d / "translated.srt").write_text(translated_srt, encoding="utf-8")
    if bilingual_srt:
        (d / "bilingual.srt").write_text(bilingual_srt, encoding="utf-8")
    print(f"  [缓存] 已保存至 {d}", flush=True)


def extract_audio(input_path: str, output_path: str) -> None:
    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-vn", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 失败: {result.stderr[-300:]}")


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    sourceLang: str = Form("ja"),
    targetLang: str = Form("ZH"),
    bilingual: str = Form("true"),
):
    from deep_translator import GoogleTranslator

    # 语言代码映射：前端用 ISO，deep-translator 用自己的
    lang_map = {
        "ZH": "zh-CN", "ZH-TW": "zh-TW",
        "EN-US": "en", "JA": "ja",
        "KO": "ko", "FR": "fr", "DE": "de", "ES": "es",
    }
    target = lang_map.get(targetLang, "zh-CN")

    with tempfile.TemporaryDirectory() as tmpdir:
        t0 = time.time()
        fname = file.filename or "input"

        # 流式写入上传文件
        src_path = os.path.join(tmpdir, fname)
        with open(src_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        fsize_mb = os.path.getsize(src_path) / 1024 / 1024
        file_hash = file_md5(src_path)
        print(f"[请求] {fname} ({fsize_mb:.1f}MB) | hash: {file_hash[:12]} | 源语言: {sourceLang} → {target}", flush=True)

        # 检查缓存
        cached = cache_get(file_hash)
        if cached:
            print(f"  [缓存] 命中! 直接返回缓存结果 ({time.time() - t0:.1f}s)", flush=True)
            return cached

        # 提取音频
        print(f"[1/3] 提取音频...", flush=True)
        t1 = time.time()
        wav_path = os.path.join(tmpdir, "audio.wav")
        try:
            extract_audio(src_path, wav_path)
        except RuntimeError as e:
            raise HTTPException(status_code=422, detail=str(e))
        print(f"  [OK] 音频提取完成 ({time.time() - t1:.1f}s)", flush=True)

        # 语音识别
        print(f"[2/3] 语音识别 ({model_type})...", flush=True)
        t2 = time.time()
        gc.collect()
        if model_type == "faster":
            segments_raw, _ = model.transcribe(
                wav_path,
                language=sourceLang,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            segments = [
                {"start": s.start, "end": s.end, "text": s.text.strip()}
                for s in segments_raw
                if s.text.strip()
            ]
        else:
            result = model.transcribe(
                wav_path,
                language=sourceLang,
                verbose=False,
                fp16=False,
            )
            segments = [
                {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
                for s in result.get("segments", [])
                if s["text"].strip()
            ]
        gc.collect()
        print(f"  [OK] 识别完成 — {len(segments)} 条字幕 ({time.time() - t2:.1f}s)", flush=True)

        if not segments:
            raise HTTPException(status_code=422, detail="No speech detected")

        # 多线程并发翻译
        print(f"[3/3] 翻译字幕 ({sourceLang} → {target})...", flush=True)
        t3 = time.time()
        def translate_seg(seg):
            translator = GoogleTranslator(source=sourceLang, target=target)
            try:
                text = translator.translate(seg["text"]) or seg["text"]
            except Exception:
                text = seg["text"]
            return {**seg, "text": text}

        translated = [None] * len(segments)
        done_count = [0]
        lock = threading.Lock()
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(translate_seg, seg): i for i, seg in enumerate(segments)}
            for future in as_completed(futures):
                idx = futures[future]
                translated[idx] = future.result()
                with lock:
                    done_count[0] += 1
                    if done_count[0] % 50 == 0 or done_count[0] == len(segments):
                        print(f"  翻译进度: {done_count[0]}/{len(segments)}", flush=True)
        print(f"  [OK] 翻译完成 ({time.time() - t3:.1f}s)", flush=True)

        # 生成 SRT
        def to_srt_time(s: float) -> str:
            ms = int((s % 1) * 1000)
            sec = int(s) % 60
            m = int(s) // 60 % 60
            h = int(s) // 3600
            return f"{h:02d}:{m:02d}:{sec:02d},{ms:03d}"

        def to_srt(segs):
            lines = []
            for i, seg in enumerate(segs, 1):
                lines.append(f"{i}")
                lines.append(f"{to_srt_time(seg['start'])} --> {to_srt_time(seg['end'])}")
                lines.append(seg["text"])
                lines.append("")
            return "\n".join(lines)

        def to_bilingual(orig, trans):
            lines = []
            for i, (o, t) in enumerate(zip(orig, trans), 1):
                lines.append(f"{i}")
                lines.append(f"{to_srt_time(o['start'])} --> {to_srt_time(o['end'])}")
                lines.append(o["text"])
                lines.append(t["text"])
                lines.append("")
            return "\n".join(lines)

        original_srt = to_srt(segments)
        translated_srt = to_srt(translated)
        bilingual_srt = to_bilingual(segments, translated) if bilingual == "true" else None

        data = {
            "segments": segments,
            "translated": translated,
            "srt": {
                "original": original_srt,
                "translated": translated_srt,
                "bilingual": bilingual_srt,
            },
        }

        cache_put(file_hash, data, original_srt, translated_srt, bilingual_srt)

        print(f"  [OK] 全部完成 — 总耗时 {time.time() - t0:.1f}s", flush=True)

        return data
