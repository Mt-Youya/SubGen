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

# 加载 .env.local（如果存在）
for _env_file in (Path(__file__).resolve().parent / ".env.local", Path.cwd() / ".env.local"):
    if _env_file.exists():
        with open(_env_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k, v)


# 代理设置（让 HuggingFace 模型下载走代理）
for _env in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    if _env not in os.environ:
        os.environ[_env] = "http://127.0.0.1:7897"

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

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


# ── 腾讯翻译 API ────────────────────────────────────────────────────────────────

from datetime import datetime, timezone
from urllib.request import Request, ProxyHandler, build_opener

import hmac

TENCENT_ENDPOINT = "tmt.tencentcloudapi.com"
TENCENT_SERVICE = "tmt"
TENCENT_VERSION = "2018-03-21"
TENCENT_REGION = "ap-guangzhou"
TENCENT_BATCH_SIZE = 50


def _tencent_sign(secret_id: str, secret_key: str, body: str, timestamp: int) -> dict:
    date = datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d")

    canonical_request = "\n".join([
        "POST",
        "/",
        "",
        f"content-type:application/json\nhost:{TENCENT_ENDPOINT}\n",
        "content-type;host",
        hashlib.sha256(body.encode("utf-8")).hexdigest(),
    ])

    credential_scope = f"{date}/{TENCENT_SERVICE}/tc3_request"
    string_to_sign = "\n".join([
        "TC3-HMAC-SHA256",
        str(timestamp),
        credential_scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])

    def _hmac(key: bytes, data: str) -> bytes:
        return hmac.new(key, data.encode("utf-8"), hashlib.sha256).digest()

    secret_date = _hmac(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = _hmac(secret_date, TENCENT_SERVICE)
    secret_signing = _hmac(secret_service, "tc3_request")
    signature = hmac.new(secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    return {
        "Content-Type": "application/json",
        "Host": TENCENT_ENDPOINT,
        "X-TC-Action": "TextTranslateBatch",
        "X-TC-Version": TENCENT_VERSION,
        "X-TC-Region": TENCENT_REGION,
        "X-TC-Timestamp": str(timestamp),
        "Authorization": f"TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, SignedHeaders=content-type;host, Signature={signature}",
    }


def translate_via_tencent(
    texts: list[str], source_lang: str, target_lang: str
) -> list[str] | None:
    """使用腾讯 TMT API 批量翻译。成功返回译文列表，失败返回 None。"""
    secret_id = os.environ.get("TENCENT_SECRET_ID")
    secret_key = os.environ.get("TENCENT_SECRET_KEY")
    if not secret_id or not secret_key:
        return None

    src = source_lang.lower()
    tgt = target_lang.lower().replace("zh-tw", "zh-TW").replace("en-us", "en").replace("zh-cn", "zh")

    # 绕过全局代理（代理用于模型下载，翻译 API 需直连）
    proxy_handler = ProxyHandler({})
    opener = build_opener(proxy_handler)

    translated: list[str] = []
    try:
        for i in range(0, len(texts), TENCENT_BATCH_SIZE):
            batch = texts[i : i + TENCENT_BATCH_SIZE]
            body = json.dumps({
                "SourceTextList": batch,
                "Source": src,
                "Target": tgt,
                "ProjectId": 0,
            })
            timestamp = int(datetime.now(timezone.utc).timestamp())
            headers = _tencent_sign(secret_id, secret_key, body, timestamp)
            req = Request(
                f"https://{TENCENT_ENDPOINT}",
                data=body.encode("utf-8"),
                headers=headers,
                method="POST",
            )
            resp = opener.open(req, timeout=15)
            data = json.loads(resp.read())
            if data.get("Response", {}).get("Error"):
                code = data["Response"]["Error"]["Code"]
                msg = data["Response"]["Error"]["Message"]
                print(f"[tencent] 翻译错误: {code} {msg}", flush=True)
                return None
            for t in data["Response"]["TargetTextList"]:
                translated.append(t)

        # 检测翻译是否生效
        if src != tgt and all(a == b for a, b in zip(texts, translated)):
            print("[tencent] 翻译结果与原文一致，翻译可能未生效", flush=True)
            return None

        return translated
    except Exception as e:
        print(f"[tencent] 请求失败: {e}", flush=True)
        return None


# ── 核心处理（在线程池中运行）────────────────────────────────────────────────

def run_task(task_id: str, src_path: str, source_lang: str, target_lang: str, bilingual: bool, skip_cache: bool = False):
    lang_map = {
        "ZH": "zh-CN", "ZH-TW": "zh-TW",
        "EN-US": "en", "JA": "ja",
        "KO": "ko", "FR": "fr", "DE": "de", "ES": "es",
    }
    target = lang_map.get(target_lang, "zh-CN")

    try:
        file_hash = file_md5(src_path)

        # 缓存命中（skip_cache 时跳过）
        if not skip_cache:
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

            # 步骤 3：翻译（targetLang=none 时跳过，仅返回原文 segments）
            if target_lang != "none":
                task_set_progress(task_id, "translating", 0.0, f"翻译中（{source_lang} → {target}）...")
                total = len(segments)
                texts = [s["text"] for s in segments]

                tencent_result = translate_via_tencent(texts, source_lang, target)
                if tencent_result is not None:
                    translated = [{**seg, "text": t} for seg, t in zip(segments, tencent_result)]
                    task_set_progress(task_id, "translating", 1.0, "翻译完成（腾讯）")
                else:
                    from deep_translator import GoogleTranslator

                    # 绕过全局代理（代理用于模型下载，翻译 API 需直连）
                    _saved_proxy = {}
                    for _k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
                        if _k in os.environ:
                            _saved_proxy[_k] = os.environ.pop(_k)

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

                    task_set_progress(task_id, "translating", 1.0, "翻译完成（Google）")

                    # 恢复代理环境变量
                    os.environ.update(_saved_proxy)
            else:
                # 跳过翻译，原文作为 translated 返回
                translated = segments

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

            if not skip_cache:
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


@app.post("/extract")
async def extract(file: UploadFile = File(...)):
    """从视频文件中提取音频"""
    suffix = Path(file.filename or "input").suffix or ".bin"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        shutil.copyfileobj(file.file, f)

    wav_fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(wav_fd)

    try:
        extract_audio(tmp_path, wav_path)
        out_name = Path(file.filename or "input").stem + ".wav"
        return FileResponse(wav_path, media_type="audio/wav", filename=out_name,
                            headers={"Content-Disposition": f'attachment; filename="{out_name}"'})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


_executor = ThreadPoolExecutor(max_workers=2)
MAX_ACTIVE_TASKS = 4  # 最多同时存在 4 个任务（2 执行中 + 2 等待）


# ── 路由 ──────────────────────────────────────────────────────────────────────

@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    sourceLang: str = Form("ja"),
    targetLang: str = Form("ZH"),
    bilingual: str = Form("true"),
    skipCache: str = Form("false"),
):
    # 并发限制
    with _tasks_lock:
        active = sum(1 for t in _tasks.values() if t["status"] in ("pending",))
        if active >= MAX_ACTIVE_TASKS:
            raise HTTPException(status_code=503, detail="服务繁忙，请稍后重试")

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
    _executor.submit(run_task, task_id, tmp_path, sourceLang, targetLang, bilingual == "true", skipCache == "true")

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
