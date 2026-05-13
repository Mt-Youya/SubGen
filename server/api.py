"""
本地开发用 FastAPI 服务
在 server/ 目录下运行：uvicorn api:app --reload --port 8000
"""

import os
import subprocess
import sys
import tempfile
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
    import whisper
    from deep_translator import GoogleTranslator

    # 语言代码映射：前端用 ISO，deep-translator 用自己的
    lang_map = {
        "ZH": "zh-CN", "ZH-TW": "zh-TW",
        "EN-US": "en", "JA": "ja",
        "KO": "ko", "FR": "fr", "DE": "de", "ES": "es",
    }
    target = lang_map.get(targetLang, "zh-CN")

    with tempfile.TemporaryDirectory() as tmpdir:
        # 保存上传文件
        src_path = os.path.join(tmpdir, file.filename or "input")
        content = await file.read()
        with open(src_path, "wb") as f:
            f.write(content)

        # 提取音频
        wav_path = os.path.join(tmpdir, "audio.wav")
        try:
            extract_audio(src_path, wav_path)
        except RuntimeError as e:
            raise HTTPException(status_code=422, detail=str(e))

        # Whisper 识别
        model = whisper.load_model("medium")
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

        if not segments:
            raise HTTPException(status_code=422, detail="No speech detected")

        # 翻译
        translator = GoogleTranslator(source=sourceLang, target=target)
        translated = []
        for seg in segments:
            try:
                text = translator.translate(seg["text"]) or seg["text"]
            except Exception:
                text = seg["text"]
            translated.append({**seg, "text": text})

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

        return {
            "segments": segments,
            "translated": translated,
            "srt": {
                "original": to_srt(segments),
                "translated": to_srt(translated),
                "bilingual": to_bilingual(segments, translated) if bilingual == "true" else None,
            },
        }
