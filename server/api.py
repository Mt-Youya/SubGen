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
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

# 代理设置（让 HuggingFace 模型下载走代理）
for _env in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    if _env not in os.environ:
        os.environ[_env] = "http://127.0.0.1:7897"

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="SubGen Local API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ── 模型懒加载 ────────────────────────────────────────────────────────────────

model = None
model_type = None
_model_lock = threading.Lock()


def get_model():
    global model, model_type
    if model is not None:
        return model, model_type
    with _model_lock:
        if model is not None:
            return model, model_type
        try:
            from faster_whisper import WhisperModel
            import logging
            # 加载期间暂时静默 uvicorn access log，避免与下载进度条混行
            uv_logger = logging.getLogger("uvicorn.access")
            prev_level = uv_logger.level
            uv_logger.setLevel(logging.WARNING)

            print("[模型] 下载/加载 faster-whisper medium...", flush=True)
            model = WhisperModel("medium", device="cpu", compute_type="int8")
            model_type = "faster"

            uv_logger.setLevel(prev_level)
            print("\n[模型] faster-whisper medium 就绪 (CPU/int8)", flush=True)
        except Exception as e:
            print(f"\n[模型] faster-whisper 加载失败: {e}", flush=True)
            print("[模型] 回退到原版 openai-whisper medium...", flush=True)
            import whisper
            model = whisper.load_model("medium")
            model_type = "original"
            print("[模型] openai-whisper medium 就绪 (CPU)", flush=True)
        return model, model_type


# ── 任务存储 ──────────────────────────────────────────────────────────────────

# task_id -> { status, stage, progress, message, result, error }
_tasks: dict[str, dict[str, Any]] = {}
_tasks_lock = threading.Lock()


def task_update(task_id: str, **kwargs):
    with _tasks_lock:
        _tasks[task_id].update(kwargs)


_STAGE_LABEL = {
    "pending":      "等待",
    "extracting":   "[1/3] 提取音频",
    "transcribing": "[2/3] 语音识别",
    "translating":  "[3/3] 翻译字幕",
    "done":         "完成",
}
# 每个 task 上一次打印的 stage，用于检测换行时机
_last_stage: dict[str, str] = {}

def _progress_bar(pct: int, width: int = 30) -> str:
    filled = int(width * pct / 100)
    bar = "█" * filled + "░" * (width - filled)
    return f"[{bar}] {pct:3d}%"

def task_set_progress(task_id: str, stage: str, stage_progress: float, message: str = ""):
    """stage_progress: 当前阶段内 0.0 ~ 1.0"""
    task_update(task_id, stage=stage, stage_progress=stage_progress, message=message)
    pct = int(stage_progress * 100)
    label = _STAGE_LABEL.get(stage, stage)
    bar = _progress_bar(pct)
    suffix = f"  {message}" if message else ""

    prev = _last_stage.get(task_id)
    # 阶段切换时先换行，使上一行保留在终端
    if prev and prev != stage:
        print(flush=True)
    _last_stage[task_id] = stage

    print(f"\r  {label}  {bar}{suffix}          ", end="", flush=True)
    # 完成时收尾换行
    if stage == "done":
        print(flush=True)
        _last_stage.pop(task_id, None)


# ── 缓存 ──────────────────────────────────────────────────────────────────────

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


def cache_put(hash_: str, data: dict) -> None:
    d = CACHE_DIR / hash_
    d.mkdir(parents=True, exist_ok=True)
    with open(d / "response.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


# ── 工具函数 ──────────────────────────────────────────────────────────────────

def get_duration(input_path: str) -> float | None:
    """用 ffprobe 获取媒体文件总时长（秒），失败返回 None。"""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", input_path],
            capture_output=True, text=True, timeout=10,
        )
        return float(r.stdout.strip())
    except Exception:
        return None


def extract_audio(input_path: str, output_path: str, progress_cb=None) -> None:
    """
    用 ffmpeg 提取音频。
    progress_cb(pct: float) 会在处理过程中被实时调用（0.0~1.0）。
    """
    duration = get_duration(input_path) if progress_cb else None

    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-vn", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1",
    ]
    if duration and progress_cb:
        # -progress pipe:1 把进度写到 stdout，每行一个 key=value
        cmd += ["-progress", "pipe:1", "-nostats", output_path]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        for line in proc.stdout:
            line = line.strip()
            if line.startswith("out_time_ms="):
                try:
                    ms = int(line.split("=", 1)[1])
                    pct = min(ms / 1_000_000 / duration, 1.0)
                    progress_cb(pct)
                except ValueError:
                    pass
        proc.wait()
        if proc.returncode not in (0, 255):  # ffmpeg 正常退出可能是 0 或 255
            raise RuntimeError("ffmpeg 提取音频失败")
    else:
        cmd.append(output_path)
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg 失败: {result.stderr[-300:]}")


def to_srt_time(s: float) -> str:
    ms = int((s % 1) * 1000)
    sec = int(s) % 60
    m = int(s) // 60 % 60
    h = int(s) // 3600
    return f"{h:02d}:{m:02d}:{sec:02d},{ms:03d}"


def to_srt(segs: list[dict]) -> str:
    lines = []
    for i, seg in enumerate(segs, 1):
        lines.append(f"{i}")
        lines.append(f"{to_srt_time(seg['start'])} --> {to_srt_time(seg['end'])}")
        lines.append(seg["text"])
        lines.append("")
    return "\n".join(lines)


def to_bilingual(orig: list[dict], trans: list[dict]) -> str:
    lines = []
    for i, (o, t) in enumerate(zip(orig, trans), 1):
        lines.append(f"{i}")
        lines.append(f"{to_srt_time(o['start'])} --> {to_srt_time(o['end'])}")
        lines.append(o["text"])
        lines.append(t["text"])
        lines.append("")
    return "\n".join(lines)


# ── 核心处理（在线程池中运行）────────────────────────────────────────────────

def run_task(task_id: str, src_path: str, source_lang: str, target_lang: str, bilingual: bool):
    from deep_translator import GoogleTranslator

    lang_map = {
        "ZH": "zh-CN", "ZH-TW": "zh-TW",
        "EN-US": "en", "JA": "ja",
        "KO": "ko", "FR": "fr", "DE": "de", "ES": "es",
    }
    target = lang_map.get(target_lang, "zh-CN")

    try:
        file_hash = file_md5(src_path)

        # 缓存命中
        cached = cache_get(file_hash)
        if cached:
            task_set_progress(task_id, "done", 1.0, "缓存命中")
            task_update(task_id, status="done", result=cached)
            return

        with tempfile.TemporaryDirectory() as tmpdir:
            # 步骤 1：提取音频（实时进度来自 ffmpeg -progress）
            task_set_progress(task_id, "extracting", 0.0, "提取音频...")
            wav_path = os.path.join(tmpdir, "audio.wav")

            def on_extract(pct: float):
                task_set_progress(task_id, "extracting", pct, f"提取音频 {int(pct*100)}%")

            extract_audio(src_path, wav_path, progress_cb=on_extract)
            task_set_progress(task_id, "extracting", 1.0, "音频提取完成")

            # 步骤 2：语音识别（faster-whisper 用 info.duration 算真实进度）
            task_set_progress(task_id, "transcribing", 0.0, "加载模型...")
            _model, _model_type = get_model()
            task_set_progress(task_id, "transcribing", 0.02, f"识别语音（{_model_type}）...")

            gc.collect()
            if _model_type == "faster":
                segments_iter, info = _model.transcribe(
                    wav_path,
                    language=source_lang,
                    vad_filter=True,
                    condition_on_previous_text=False,
                )
                total_duration = info.duration or 0
                raw_segments = []
                for seg in segments_iter:
                    raw_segments.append(seg)
                    if total_duration > 0:
                        # seg.end / total_duration = 真实进度，留 2% 给完成消息
                        pct = min(seg.end / total_duration * 0.98, 0.98)
                    else:
                        pct = min(0.02 + len(raw_segments) * 0.003, 0.98)
                    task_set_progress(task_id, "transcribing", pct, f"已识别 {len(raw_segments)} 条...")
                segments = [
                    {"start": s.start, "end": s.end, "text": s.text.strip()}
                    for s in raw_segments if s.text.strip()
                ]
            else:
                result = _model.transcribe(
                    wav_path, language=source_lang, verbose=False, fp16=False,
                )
                segments = [
                    {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
                    for s in result.get("segments", []) if s["text"].strip()
                ]
            gc.collect()
            task_set_progress(task_id, "transcribing", 1.0, f"识别完成，共 {len(segments)} 条")

            if not segments:
                raise RuntimeError("No speech detected")

            # 步骤 3：翻译（阶段内 0→1）
            task_set_progress(task_id, "translating", 0.0, f"翻译中（{source_lang} → {target}）...")
            total = len(segments)
            done_count = [0]
            lock = threading.Lock()

            def translate_seg(seg):
                translator = GoogleTranslator(source=source_lang, target=target)
                try:
                    text = translator.translate(seg["text"]) or seg["text"]
                except Exception:
                    text = seg["text"]
                with lock:
                    done_count[0] += 1
                    task_set_progress(task_id, "translating", done_count[0] / total, f"翻译 {done_count[0]}/{total}")
                return {**seg, "text": text}

            translated = [None] * total
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = {pool.submit(translate_seg, seg): i for i, seg in enumerate(segments)}
                for future in as_completed(futures):
                    idx = futures[future]
                    translated[idx] = future.result()

            task_set_progress(task_id, "translating", 1.0, "翻译完成，生成 SRT...")

            # 生成 SRT
            data = {
                "segments": segments,
                "translated": translated,
                "srt": {
                    "original": to_srt(segments),
                    "translated": to_srt(translated),
                    "bilingual": to_bilingual(segments, translated) if bilingual else None,
                },
            }

            cache_put(file_hash, data)
            task_set_progress(task_id, "done", 1.0, "完成")
            task_update(task_id, status="done", result=data)

    except Exception as e:
        msg = str(e)
        print(f"  [{task_id[:8]}] 错误: {msg}", flush=True)
        task_update(task_id, status="error", message=msg)
    finally:
        # 清理上传的临时文件
        try:
            os.unlink(src_path)
        except Exception:
            pass


_executor = ThreadPoolExecutor(max_workers=2)


# ── 路由 ──────────────────────────────────────────────────────────────────────

@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    sourceLang: str = Form("ja"),
    targetLang: str = Form("ZH"),
    bilingual: str = Form("true"),
):
    # 把上传文件写到临时文件（线程里处理，不阻塞事件循环）
    suffix = Path(file.filename or "input").suffix or ".bin"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        shutil.copyfileobj(file.file, f)

    fsize_mb = os.path.getsize(tmp_path) / 1024 / 1024
    task_id = uuid.uuid4().hex

    with _tasks_lock:
        _tasks[task_id] = {
            "status": "pending",
            "stage": "pending",
            "stage_progress": 0.0,
            "message": "等待处理...",
            "result": None,
            "error": None,
        }

    print(f"[任务] {task_id[:8]} 创建 | {file.filename} ({fsize_mb:.1f}MB)", flush=True)
    _executor.submit(run_task, task_id, tmp_path, sourceLang, targetLang, bilingual == "true")

    return {"task_id": task_id}


@app.get("/transcribe/{task_id}")
async def get_task(task_id: str):
    with _tasks_lock:
        task = _tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@app.get("/health")
async def health():
    return {"ok": True}
