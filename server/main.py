"""
视频字幕生成工具（带缓存功能 + 多线程加速）
功能：
  1. 从视频中提取音频
  2. 使用 faster-whisper 进行语音识别（比原版快4-5倍）
  3. 生成日文 .srt 字幕文件
  4. 多线程翻译为中文，生成中文 .srt 字幕文件

依赖安装：
  pip install openai-whisper faster-whisper deep-translator ffmpeg-python tqdm
  # 另需系统安装 ffmpeg
"""

import os
import argparse
import hashlib
import json
import pickle
import subprocess
import sys
import tempfile
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading


# ── 依赖检查 ─────────────────────────────────────────────────────────────────

def check_dependencies():
    missing = []
    try:
        import whisper  # noqa: F401
    except ImportError:
        missing.append("openai-whisper")
    try:
        from deep_translator import GoogleTranslator  # noqa: F401
    except ImportError:
        missing.append("deep-translator")
    try:
        import tqdm  # noqa: F401
    except ImportError:
        missing.append("tqdm")

    # faster-whisper 可选
    try:
        from faster_whisper import WhisperModel  # noqa: F401
    except ImportError:
        print("[提示] faster-whisper 未安装，将使用原版 Whisper（较慢）")
        print("       安装命令：pip install faster-whisper")

    if missing:
        print(f"[错误] 缺少依赖包，请运行：\n  pip install {' '.join(missing)}")
        sys.exit(1)

    # 检查 ffmpeg
    result = subprocess.run(
        ["ffmpeg", "-version"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("[错误] 未找到 ffmpeg，请先安装：\n  Windows: winget install ffmpeg\n  macOS: brew install ffmpeg")
        sys.exit(1)


# ── 缓存管理 ─────────────────────────────────────────────────────────────────

class CacheManager:
    """管理各步骤的缓存（缓存文件放在视频所在目录）"""

    def __init__(self, video_path: str = None):
        """
        初始化缓存管理器
        :param video_path: 视频文件路径，缓存将放在同目录下的 .subgen_cache 文件夹
        """
        if video_path:
            video_path = Path(video_path).resolve()
            self.video_dir = video_path.parent
            self.cache_dir = self.video_dir / ".subgen_cache"
        else:
            # 用于全局缓存管理
            self.cache_dir = Path.cwd() / ".subgen_cache"
            self.video_dir = self.cache_dir

        self.cache_dir.mkdir(parents=True, exist_ok=True)

        # 缓存元数据文件
        self.metadata_file = self.cache_dir / "metadata.json"
        self.metadata = self._load_metadata()

    def _load_metadata(self) -> dict:
        """加载缓存元数据"""
        if self.metadata_file.exists():
            try:
                with open(self.metadata_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except:
                return {}
        return {}

    def _save_metadata(self):
        """保存缓存元数据"""
        with open(self.metadata_file, "w", encoding="utf-8") as f:
            json.dump(self.metadata, f, indent=2, ensure_ascii=False)

    def get_video_hash(self, video_path: str) -> str:
        """计算视频文件的唯一标识（基于文件名+修改时间+大小）"""
        path = Path(video_path)
        if not path.exists():
            return None

        # 组合文件名、修改时间、文件大小作为唯一标识
        stat = path.stat()
        identifier = f"{path.name}_{stat.st_mtime}_{stat.st_size}"
        return hashlib.md5(identifier.encode()).hexdigest()

    def get_cache_path(self, video_hash: str, step: str, extension: str) -> Path:
        """获取缓存文件路径"""
        return self.cache_dir / f"{video_hash}_{step}{extension}"

    def get_audio_cache(self, video_path: str) -> str | None:
        """获取缓存的音频文件路径"""
        video_hash = self.get_video_hash(video_path)
        if not video_hash:
            return None

        cache_path = self.get_cache_path(video_hash, "audio", ".wav")
        if cache_path.exists():
            print(f"  📦 使用缓存的音频文件")
            return str(cache_path)
        return None

    def save_audio_cache(self, video_path: str, audio_path: str) -> str:
        """保存音频到缓存"""
        import shutil
        video_hash = self.get_video_hash(video_path)
        cache_path = self.get_cache_path(video_hash, "audio", ".wav")
        shutil.copy2(audio_path, cache_path)
        print(f"  💾 音频已缓存")
        return str(cache_path)

    def get_segments_cache(self, video_path: str, model_name: str, language: str) -> list[dict] | None:
        """获取缓存的识别结果"""
        video_hash = self.get_video_hash(video_path)
        if not video_hash:
            return None

        cache_key = f"{video_hash}_segments_{model_name}_{language}"
        if cache_key in self.metadata:
            cache_path = Path(self.metadata[cache_key]["path"])
            if cache_path.exists():
                print(f"  📦 使用缓存的识别结果")
                with open(cache_path, "rb") as f:
                    return pickle.load(f)
        return None

    def save_segments_cache(self, video_path: str, model_name: str, language: str, segments: list[dict]):
        """保存识别结果到缓存"""
        video_hash = self.get_video_hash(video_path)
        if not video_hash:
            return

        cache_key = f"{video_hash}_segments_{model_name}_{language}"
        cache_path = self.get_cache_path(video_hash, f"segments_{model_name}_{language}", ".pkl")

        with open(cache_path, "wb") as f:
            pickle.dump(segments, f)

        self.metadata[cache_key] = {
            "path": str(cache_path),
            "created_at": datetime.now().isoformat(),
            "video": video_path,
            "model": model_name,
            "language": language,
        }
        self._save_metadata()
        print(f"  💾 识别结果已缓存")

    def get_translation_cache(self, video_path: str, source_lang: str, target_lang: str) -> list[dict] | None:
        """获取缓存的翻译结果"""
        video_hash = self.get_video_hash(video_path)
        if not video_hash:
            return None

        cache_key = f"{video_hash}_translation_{source_lang}_{target_lang}"
        if cache_key in self.metadata:
            cache_path = Path(self.metadata[cache_key]["path"])
            if cache_path.exists():
                print(f"  📦 使用缓存的翻译结果")
                with open(cache_path, "rb") as f:
                    return pickle.load(f)
        return None

    def save_translation_cache(self, video_path: str, source_lang: str, target_lang: str, segments: list[dict]):
        """保存翻译结果到缓存"""
        video_hash = self.get_video_hash(video_path)
        if not video_hash:
            return

        cache_key = f"{video_hash}_translation_{source_lang}_{target_lang}"
        cache_path = self.get_cache_path(video_hash, f"translation_{source_lang}_{target_lang}", ".pkl")

        with open(cache_path, "wb") as f:
            pickle.dump(segments, f)

        self.metadata[cache_key] = {
            "path": str(cache_path),
            "created_at": datetime.now().isoformat(),
            "video": video_path,
            "source": source_lang,
            "target": target_lang,
        }
        self._save_metadata()
        print(f"  💾 翻译结果已缓存")

    def clean_old_caches(self, days: int = 30):
        """清理超过指定天数的缓存"""
        import time
        now = time.time()
        cutoff = days * 86400

        cleaned = 0
        for cache_key, info in list(self.metadata.items()):
            cache_path = Path(info["path"])
            if cache_path.exists():
                age = now - cache_path.stat().st_mtime
                if age > cutoff:
                    cache_path.unlink()
                    del self.metadata[cache_key]
                    cleaned += 1

        self._save_metadata()
        if cleaned > 0:
            print(f"  🧹 清理了 {cleaned} 个过期缓存（>{days}天）")

    def list_caches(self):
        """列出所有缓存"""
        print(f"\n缓存目录: {self.cache_dir}")
        if self.cache_dir.exists():
            cache_files = list(self.cache_dir.glob("*"))
            print(f"缓存文件数: {len(cache_files)}")
            for f in cache_files:
                if f.name != "metadata.json":
                    size = f.stat().st_size / 1024 / 1024
                    print(f"  - {f.name} ({size:.2f} MB)")
        else:
            print(f"  暂无缓存")

    def clear_all_caches(self):
        """清空所有缓存"""
        import shutil
        shutil.rmtree(self.cache_dir)
        self.cache_dir.mkdir(parents=True)
        print(f"✅ 已清空所有缓存")


# ── 时间格式工具 ──────────────────────────────────────────────────────────────

def seconds_to_srt_time(seconds: float) -> str:
    """将秒数转换为 SRT 时间格式 HH:MM:SS,mmm"""
    ms = int((seconds % 1) * 1000)
    s = int(seconds) % 60
    m = int(seconds) // 60 % 60
    h = int(seconds) // 3600
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# ── 音频提取 ──────────────────────────────────────────────────────────────────

def extract_audio(video_path: str, audio_path: str, cache_manager: CacheManager = None) -> str:
    """使用 ffmpeg 从视频中提取音频（支持缓存）"""

    # 检查缓存
    if cache_manager:
        cached_audio = cache_manager.get_audio_cache(video_path)
        if cached_audio:
            return cached_audio

    print(f"[1/3] 正在提取音频：{Path(video_path).name}")
    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        audio_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[错误] 音频提取失败：\n{result.stderr}")
        sys.exit(1)
    print(f"  ✓ 音频已提取")

    # 保存到缓存
    if cache_manager:
        audio_path = cache_manager.save_audio_cache(video_path, audio_path)

    return audio_path


# ── 优化版语音识别（使用 faster-whisper）────────────────────────────────────

# 检查 faster-whisper 是否可用
try:
    from faster_whisper import WhisperModel
    FASTER_WHISPER_AVAILABLE = True
except ImportError:
    FASTER_WHISPER_AVAILABLE = False


def transcribe_audio_optimized(
        audio_path: str,
        model_name: str = "medium",
        language: str = "ja",
        cache_manager: CacheManager = None,
        video_path: str = None,
        use_faster: bool = True,
) -> list[dict]:
    """
    优化的语音识别（优先使用 faster-whisper，自动缓存）
    """
    # ========== 1. 检查缓存 ==========
    if cache_manager and video_path:
        cached_segments = cache_manager.get_segments_cache(video_path, model_name, language)
        if cached_segments:
            return cached_segments

    # ========== 2. 执行识别 ==========
    # 尝试使用 faster-whisper
    if use_faster and FASTER_WHISPER_AVAILABLE:
        result = transcribe_audio_faster(audio_path, model_name, language)
    else:
        # 回退到原版 Whisper
        result = transcribe_audio_original(audio_path, model_name, language)

    # ========== 3. 保存缓存 ==========
    if cache_manager and video_path:
        cache_manager.save_segments_cache(video_path, model_name, language, result)

    return result


def transcribe_audio_faster(audio_path: str, model_name: str, language: str) -> list[dict]:
    """使用 faster-whisper 加速（比原版快 4-5 倍）"""
    import torch

    print(f"[2/3] 正在加载 faster-whisper 模型（{model_name}）...")

    # 自动选择设备
    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"

    # 获取 CPU 核心数用于并行
    cpu_count = os.cpu_count() or 4
    cpu_threads = min(cpu_count, 8)  # 限制最大 8 线程

    print(f"  设备: {device} | 精度: {compute_type} | CPU线程: {cpu_threads}")

    # 设置 CPU 线程数（仅 CPU 模式有效）
    if device == "cpu":
        torch.set_num_threads(cpu_threads)

    model = WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        cpu_threads=cpu_threads,
        num_workers=2,  # 并行 worker
    )

    print(f"  正在识别语音（语言：{language}）...")

    # 使用优化的参数
    segments, info = model.transcribe(
        audio_path,
        language=language,
        beam_size=3,           # 降低 beam size 加速
        best_of=3,             # 降低候选数
        temperature=0.0,       # 固定温度
        vad_filter=True,       # 使用 VAD 过滤静音
        vad_parameters=dict(
            min_silence_duration_ms=500,
            threshold=0.5
        ),
    )

    result = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            result.append({
                "start": seg.start,
                "end": seg.end,
                "text": text,
            })

    print(f"  ✓ 识别完成，共 {len(result)} 条字幕")
    return result


def transcribe_audio_original(audio_path: str, model_name: str, language: str) -> list[dict]:
    """原版 Whisper（作为回退方案）"""
    import whisper
    from tqdm import tqdm

    print(f"[2/3] 正在加载 Whisper 模型（{model_name}）...")
    model = whisper.load_model(model_name)

    print(f"  正在识别语音（语言：{language}）...")
    result = model.transcribe(
        audio_path,
        language=language,
        verbose=False,
        fp16=False,
        task="transcribe",
    )

    segments = []
    for seg in result.get("segments", []):
        text = seg["text"].strip()
        if text:
            segments.append({
                "start": seg["start"],
                "end": seg["end"],
                "text": text,
            })

    print(f"  ✓ 识别完成，共 {len(segments)} 条字幕")
    return segments


# ── SRT 生成 ──────────────────────────────────────────────────────────────────

def segments_to_srt(segments: list[dict]) -> str:
    """将分段列表转换为 SRT 格式字符串"""
    lines = []
    for i, seg in enumerate(segments, 1):
        start = seconds_to_srt_time(seg["start"])
        end = seconds_to_srt_time(seg["end"])
        lines.append(f"{i}")
        lines.append(f"{start} --> {end}")
        lines.append(seg["text"])
        lines.append("")
    return "\n".join(lines)


def save_srt(content: str, path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"  ✓ 已保存：{Path(path).name}")


# ── 优化版翻译（多线程并行）────────────────────────────────────────────────

class ParallelTranslator:
    """并行翻译器（线程安全）"""

    def __init__(self, source_lang: str, target_lang: str, max_workers: int = 8):
        self.source_lang = source_lang
        self.target_lang = target_lang
        self.max_workers = max_workers
        self._translator_cache = {}
        self._lock = threading.Lock()

    def _get_translator(self):
        """获取线程安全的翻译器"""
        thread_id = threading.get_ident()
        if thread_id not in self._translator_cache:
            from deep_translator import GoogleTranslator
            try:
                self._translator_cache[thread_id] = GoogleTranslator(
                    source=self.source_lang,
                    target=self.target_lang
                )
            except Exception as e:
                # 如果 Google 翻译失败，使用备用翻译器
                from deep_translator import MyMemoryTranslator
                self._translator_cache[thread_id] = MyMemoryTranslator(
                    source=self.source_lang,
                    target=self.target_lang
                )
        return self._translator_cache[thread_id]

    def translate_single(self, seg: dict) -> dict:
        """翻译单条"""
        text = seg["text"]
        if not text or not text.strip():
            return {
                "start": seg["start"],
                "end": seg["end"],
                "text": "",
            }

        try:
            translator = self._get_translator()
            translated = translator.translate(text)
        except Exception as e:
            # 翻译失败时保留原文
            print(f"  ⚠️ 翻译失败: {text[:30]}... -> {str(e)[:50]}")
            translated = text

        return {
            "start": seg["start"],
            "end": seg["end"],
            "text": translated,
        }

    def translate_batch(self, segments: list[dict]) -> list[dict]:
        """并行翻译所有条目"""
        from tqdm import tqdm

        if not segments:
            return []

        print(f"  使用 {self.max_workers} 个线程并行翻译...")

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {executor.submit(self.translate_single, seg): i for i, seg in enumerate(segments)}

            results = [None] * len(segments)
            with tqdm(total=len(segments), desc="  翻译进度", unit="条") as pbar:
                for future in as_completed(futures):
                    idx = futures[future]
                    results[idx] = future.result()
                    pbar.update(1)

        return results


def translate_segments_optimized(
        segments: list[dict],
        source_lang: str = "ja",
        target_lang: str = "zh-CN",
        max_workers: int = 8,
        cache_manager: CacheManager = None,
        video_path: str = None,
) -> list[dict]:
    """
    优化的并行翻译（自动缓存）
    """
    # ========== 1. 检查缓存 ==========
    if cache_manager and video_path:
        cached_translation = cache_manager.get_translation_cache(video_path, source_lang, target_lang)
        if cached_translation:
            return cached_translation

    # ========== 2. 执行翻译 ==========
    print(f"[3/3] 正在翻译字幕（{source_lang} → {target_lang}）...")

    translator = ParallelTranslator(source_lang, target_lang, max_workers)
    translated = translator.translate_batch(segments)

    print(f"  ✓ 翻译完成，共 {len(translated)} 条")

    # ========== 3. 保存缓存 ==========
    if cache_manager and video_path:
        cache_manager.save_translation_cache(video_path, source_lang, target_lang, translated)

    return translated


# ── 双语字幕（可选） ──────────────────────────────────────────────────────────

def merge_bilingual(
        ja_segments: list[dict],
        zh_segments: list[dict],
) -> str:
    """生成双语字幕（日文 + 中文，上下叠放）"""
    lines = []
    for i, (ja, zh) in enumerate(zip(ja_segments, zh_segments), 1):
        start = seconds_to_srt_time(ja["start"])
        end = seconds_to_srt_time(ja["end"])
        lines.append(f"{i}")
        lines.append(f"{start} --> {end}")
        lines.append(ja["text"])
        lines.append(zh["text"])
        lines.append("")
    return "\n".join(lines)


# ── 主流程 ────────────────────────────────────────────────────────────────────

def process_video(
        video_path: str,
        output_dir: str | None = None,
        model: str = "medium",
        source_lang: str = "ja",
        target_lang: str = "zh-CN",
        bilingual: bool = True,
        keep_audio: bool = False,
        use_cache: bool = True,
        clean_cache_days: int = None,
        translation_workers: int = 8,
        use_faster_whisper: bool = True,
) -> None:
    video_path = Path(video_path).resolve()
    if not video_path.exists():
        print(f"[错误] 视频文件不存在：{video_path}")
        sys.exit(1)

    # 初始化缓存管理器
    cache_manager = CacheManager(str(video_path)) if use_cache else None

    # 清理过期缓存
    if clean_cache_days and cache_manager:
        cache_manager.clean_old_caches(clean_cache_days)

    # 输出目录
    out_dir = Path(output_dir) if output_dir else video_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = video_path.stem

    # 输出路径
    ja_srt_path = out_dir / f"{stem}.ja.srt"
    zh_srt_path = out_dir / f"{stem}.zh.srt"
    bilingual_srt_path = out_dir / f"{stem}.bilingual.srt"

    print("=" * 55)
    print(f"  视频字幕生成工具")
    print(f"  输入：{video_path.name}")
    print(f"  输出：{out_dir}")
    print(f"  模型：{model}")
    print(f"  加速：{'faster-whisper' if use_faster_whisper else '原版Whisper'}")
    print(f"  翻译线程：{translation_workers}")
    print(f"  缓存：{'启用' if use_cache else '禁用'}")
    print("=" * 55)

    # 步骤 1：提取音频（支持缓存）
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        audio_path = tmp.name

    try:
        audio_path = extract_audio(str(video_path), audio_path, cache_manager if use_cache else None)

        # 步骤 2：语音识别（支持缓存 + faster-whisper）
        ja_segments = transcribe_audio_optimized(
            audio_path,
            model_name=model,
            language=source_lang,
            cache_manager=cache_manager if use_cache else None,
            video_path=str(video_path) if use_cache else None,
            use_faster=use_faster_whisper,
        )

        # 保存原文字幕
        ja_srt = segments_to_srt(ja_segments)
        save_srt(ja_srt, str(ja_srt_path))

        # 步骤 3：翻译（多线程并行 + 缓存）
        zh_segments = translate_segments_optimized(
            ja_segments,
            source_lang=source_lang,
            target_lang=target_lang,
            max_workers=translation_workers,
            cache_manager=cache_manager if use_cache else None,
            video_path=str(video_path) if use_cache else None,
        )

        # 保存中文字幕
        zh_srt = segments_to_srt(zh_segments)
        save_srt(zh_srt, str(zh_srt_path))

        # 双语字幕
        if bilingual:
            bi_srt = merge_bilingual(ja_segments, zh_segments)
            save_srt(bi_srt, str(bilingual_srt_path))

        # 保留音频（用于调试）
        if keep_audio:
            kept_audio = out_dir / f"{stem}_audio.wav"
            import shutil
            shutil.copy(audio_path, kept_audio)
            print(f"  → 提取音频：{kept_audio.name}")

    finally:
        if os.path.exists(audio_path) and not keep_audio:
            os.unlink(audio_path)

    print("\n✅ 完成！")


# ── 批量处理 ──────────────────────────────────────────────────────────────────

def process_directory(
        dir_path: str,
        extensions: list[str] | None = None,
        **kwargs,
) -> None:
    """批量处理目录下所有视频文件"""
    if extensions is None:
        extensions = [".mp4", ".mkv", ".avi", ".mov", ".flv", ".webm", ".ts", ".m2ts"]

    dir_path = Path(dir_path)
    videos = [p for p in dir_path.iterdir() if p.suffix.lower() in extensions]

    if not videos:
        print(f"[提示] 在 {dir_path} 中未找到视频文件")
        return

    print(f"找到 {len(videos)} 个视频文件，开始批量处理...\n")
    for i, video in enumerate(videos, 1):
        print(f"\n[{i}/{len(videos)}] {video.name}")
        process_video(str(video), **kwargs)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="视频字幕生成工具：语音识别 + 翻译（支持缓存和多线程加速）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例：
  # 处理单个视频（默认启用缓存和加速）
  python main.py video.mp4

  # 指定输出目录
  python main.py video.mp4 -o ./subtitles

  # 使用更大模型
  python main.py video.mp4 --model large

  # 调整翻译线程数（CPU核心数 * 2）
  python main.py video.mp4 --workers 16

  # 批量处理整个目录
  python main.py /path/to/videos/ --batch

  # 禁用缓存重新生成
  python main.py video.mp4 --no-cache

  # 清理30天前的缓存
  python main.py video.mp4 --clean-cache 30

  # 缓存管理
  python main.py --cache list        # 列出所有缓存
  python main.py --cache clean       # 清理30天前的缓存
  python main.py --cache clear       # 清空所有缓存

  # 不生成双语字幕
  python main.py video.mp4 --no-bilingual

  # 禁用 faster-whisper（使用原版）
  python main.py video.mp4 --no-faster
        """,
    )
    parser.add_argument("input", nargs="?", help="视频文件路径 或 目录路径（批量模式）")
    parser.add_argument("-o", "--output", default=None, help="输出目录（默认：与视频同目录）")
    parser.add_argument(
        "--model",
        default="medium",
        choices=["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"],
        help="Whisper 模型（默认：medium）",
    )
    parser.add_argument("--source", default="ja", help="源语言代码（默认：ja 日文）")
    parser.add_argument("--target", default="zh-CN", help="目标语言代码（默认：zh-CN 中文）")
    parser.add_argument("--no-bilingual", action="store_true", help="不生成双语字幕")
    parser.add_argument("--keep-audio", action="store_true", help="保留提取的音频文件（调试用）")
    parser.add_argument("--batch", action="store_true", help="批量处理目录中所有视频")
    parser.add_argument("--no-cache", action="store_true", help="禁用缓存")
    parser.add_argument("--clean-cache", type=int, metavar="DAYS", help="清理超过指定天数的缓存")
    parser.add_argument("--workers", type=int, default=8, help="翻译并行线程数（默认：8）")
    parser.add_argument("--no-faster", action="store_true", help="禁用 faster-whisper（使用原版）")

    # 缓存管理子命令
    parser.add_argument("--cache", choices=["list", "clean", "clear"], help="缓存管理命令")

    args = parser.parse_args()

    # 缓存管理命令（不需要输入文件）
    if args.cache:
        cache_manager = CacheManager()
        if args.cache == "list":
            cache_manager.list_caches()
        elif args.cache == "clean":
            cache_manager.clean_old_caches(30)
        elif args.cache == "clear":
            cache_manager.clear_all_caches()
        return

    if not args.input:
        parser.print_help()
        return

    check_dependencies()

    kwargs = dict(
        output_dir=args.output,
        model=args.model,
        source_lang=args.source,
        target_lang=args.target,
        bilingual=not args.no_bilingual,
        keep_audio=args.keep_audio,
        use_cache=not args.no_cache,
        clean_cache_days=args.clean_cache,
        translation_workers=args.workers,
        use_faster_whisper=not args.no_faster,
    )
    input_path = Path(args.input)

    if args.batch or input_path.is_dir():
        process_directory(str(input_path), **kwargs)
    else:
        process_video(str(input_path), **kwargs)


if __name__ == "__main__":
    main()