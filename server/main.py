"""
视频字幕生成工具（带缓存功能）
功能：
  1. 从视频中提取音频
  2. 使用 Whisper 进行语音识别（支持日文）
  3. 生成日文 .srt 字幕文件
  4. 翻译为中文，生成中文 .srt 字幕文件

依赖安装：
  pip install openai-whisper deep-translator ffmpeg-python tqdm
  # 另需系统安装 ffmpeg：
  #   Windows: winget install ffmpeg
  #   macOS:   brew install ffmpeg
  #   Linux:   sudo apt install ffmpeg
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

    def __init__(self, video_path: str):
        """
        初始化缓存管理器
        :param video_path: 视频文件路径，缓存将放在同目录下的 .subgen_cache 文件夹
        """
        video_path = Path(video_path).resolve()
        self.video_dir = video_path.parent
        self.cache_dir = self.video_dir / ".subgen_cache"
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
            print(f"  📦 使用缓存的音频文件（位于: {self.cache_dir}）")
            return str(cache_path)
        return None

    def save_audio_cache(self, video_path: str, audio_path: str) -> str:
        """保存音频到缓存"""
        import shutil
        video_hash = self.get_video_hash(video_path)
        cache_path = self.get_cache_path(video_hash, "audio", ".wav")
        shutil.copy2(audio_path, cache_path)
        print(f"  💾 音频已缓存到: {cache_path}")
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
                print(f"  📦 使用缓存的识别结果（位于: {self.cache_dir}）")
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
        print(f"  💾 识别结果已缓存到: {cache_path}")

    def get_translation_cache(self, video_path: str, source_lang: str, target_lang: str) -> list[dict] | None:
        """获取缓存的翻译结果"""
        video_hash = self.get_video_hash(video_path)
        if not video_hash:
            return None

        cache_key = f"{video_hash}_translation_{source_lang}_{target_lang}"
        if cache_key in self.metadata:
            cache_path = Path(self.metadata[cache_key]["path"])
            if cache_path.exists():
                print(f"  📦 使用缓存的翻译结果（位于: {self.cache_dir}）")
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
        print(f"  💾 翻译结果已缓存到: {cache_path}")

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
                    print(f"  - {f.name}")
        else:
            print(f"  暂无缓存")

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

    print(f"[1/3] 正在提取音频：{video_path}")
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


# ── Whisper 语音识别 ──────────────────────────────────────────────────────────

def transcribe_audio(audio_path: str, model_name: str = "medium", language: str = "ja",
                     cache_manager: CacheManager = None, video_path: str = None) -> list[dict]:
    """
    使用 Whisper 识别音频，返回分段列表（支持缓存）
    """
    import whisper
    from tqdm import tqdm

    # 检查缓存
    if cache_manager and video_path:
        cached_segments = cache_manager.get_segments_cache(video_path, model_name, language)
        if cached_segments:
            return cached_segments

    print(f"[2/3] 正在加载 Whisper 模型（{model_name}）...")
    model = whisper.load_model(model_name)

    print(f"  正在识别语音（语言：{language}）...")
    # verbose=False 避免 Whisper 自己打印，我们用 tqdm 显示
    result = model.transcribe(
        audio_path,
        language=language,
        verbose=False,
        fp16=False,
        task="transcribe",
        condition_on_previous_text=True,
        word_timestamps=False,
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

    # 保存到缓存
    if cache_manager and video_path:
        cache_manager.save_segments_cache(video_path, model_name, language, segments)

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
    print(f"  ✓ 已保存：{path}")


# ── 翻译 ──────────────────────────────────────────────────────────────────────

def translate_segments(
        segments: list[dict],
        source_lang: str = "ja",
        target_lang: str = "zh-CN",
        batch_size: int = 10,
        max_retries: int = 5,  # 最大重试次数
        cache_manager: CacheManager = None,
        video_path: str = None,
) -> list[dict]:
    """
    批量翻译字幕分段（支持多引擎备选 + 自动重试）
    """
    from tqdm import tqdm
    import time

    # 检查缓存
    if cache_manager and video_path:
        cached_translation = cache_manager.get_translation_cache(video_path, source_lang, target_lang)
        if cached_translation:
            return cached_translation

    # 定义翻译器列表（按优先级排序）
    translator = None
    translator_name = None

    # 尝试各种翻译器（正确的导入路径）
    try:
        from deep_translator import GoogleTranslator
        test_translator = GoogleTranslator(source=source_lang, target=target_lang)
        test_result = test_translator.translate("こんにちは")
        if test_result:
            translator = GoogleTranslator(source=source_lang, target=target_lang)
            translator_name = "Google"
            print(f"[3/3] ✅ 使用 Google 翻译引擎")
    except Exception as e:
        print(f"[3/3] ⚠️ Google 翻译不可用: {str(e)[:50]}")

    # 如果 Google 不可用，尝试 MyMemory（免费，无需 API）
    if translator is None:
        try:
            from deep_translator import MyMemoryTranslator
            test_translator = MyMemoryTranslator(source=source_lang, target=target_lang)
            test_result = test_translator.translate("こんにちは")
            if test_result:
                translator = MyMemoryTranslator(source=source_lang, target=target_lang)
                translator_name = "MyMemory"
                print(f"[3/3] ✅ 使用 MyMemory 翻译引擎")
        except Exception as e:
            print(f"[3/3] ⚠️ MyMemory 翻译不可用: {str(e)[:50]}")

    # 如果还不可用，尝试 Pons
    if translator is None:
        try:
            from deep_translator import PonsTranslator
            test_translator = PonsTranslator(source=source_lang, target=target_lang)
            test_result = test_translator.translate("こんにちは")
            if test_result:
                translator = PonsTranslator(source=source_lang, target=target_lang)
                translator_name = "Pons"
                print(f"[3/3] ✅ 使用 Pons 翻译引擎")
        except Exception as e:
            print(f"[3/3] ⚠️ Pons 翻译不可用: {str(e)[:50]}")

    # 如果所有翻译器都不可用，保留原文
    if translator is None:
        print(f"[3/3] ❌ 所有翻译器均不可用，将保留原文")
        for seg in segments:
            seg["text"] = seg["text"]
        return segments

    print(f"[3/3] 正在翻译字幕（{source_lang} → {target_lang}），最多重试 {max_retries} 次...")

    translated = []
    total = len(segments)

    with tqdm(total=total, unit="条") as pbar:
        for i in range(0, total, batch_size):
            batch = segments[i: i + batch_size]
            separator = "\n||||\n"
            combined = separator.join(seg["text"] for seg in batch)

            # 带重试的翻译
            success = False
            translated_texts = None

            for retry in range(max_retries):
                try:
                    result = translator.translate(combined)
                    parts = result.split("||||")

                    # 如果分割数量不匹配，回退到逐条翻译
                    if len(parts) != len(batch):
                        parts = []
                        for seg in batch:
                            # 逐条翻译也带重试
                            for sub_retry in range(max_retries):
                                try:
                                    part_result = translator.translate(seg["text"])
                                    parts.append(part_result)
                                    break
                                except Exception as e:
                                    if sub_retry == max_retries - 1:
                                        parts.append(seg["text"])
                                    else:
                                        time.sleep(1)
                    else:
                        # 清理结果
                        parts = [p.strip() if p else seg["text"] for p, seg in zip(parts, batch)]

                    translated_texts = parts
                    success = True
                    break

                except Exception as e:
                    error_msg = str(e)[:100]
                    if retry < max_retries - 1:
                        wait_time = (retry + 1) * 2
                        print(
                            f"\n  ⚠️ 批次 {i // batch_size + 1} 翻译失败，{wait_time}秒后重试 ({retry + 1}/{max_retries}): {error_msg}")
                        time.sleep(wait_time)
                    else:
                        print(
                            f"\n  ❌ 批次 {i // batch_size + 1} 翻译失败，已重试 {max_retries} 次，保留原文: {error_msg}")
                        translated_texts = [seg["text"] for seg in batch]

            # 组装结果
            for seg, translated_text in zip(batch, translated_texts):
                translated.append({
                    "start": seg["start"],
                    "end": seg["end"],
                    "text": translated_text if translated_text else seg["text"],
                })
            pbar.update(len(batch))

    print(f"  ✓ 翻译完成（使用 {translator_name}）")

    # 保存到缓存
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
    print(f"  模型：Whisper {model}")
    print(f"  缓存：{'启用' if use_cache else '禁用'}")
    print("=" * 55)

    # 步骤 1：提取音频（支持缓存）
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        audio_path = tmp.name

    try:
        audio_path = extract_audio(str(video_path), audio_path, cache_manager if use_cache else None)

        # 步骤 2：语音识别（支持缓存）
        ja_segments = transcribe_audio(
            audio_path,
            model_name=model,
            language=source_lang,
            cache_manager=cache_manager if use_cache else None,
            video_path=str(video_path) if use_cache else None,
        )

        # 保存原文字幕
        ja_srt = segments_to_srt(ja_segments)
        save_srt(ja_srt, str(ja_srt_path))
        print(f"  → 日文字幕：{ja_srt_path.name}")

        # 步骤 3：翻译（支持缓存）
        zh_segments = translate_segments(
            ja_segments,
            source_lang=source_lang,
            target_lang=target_lang,
            cache_manager=cache_manager if use_cache else None,
            video_path=str(video_path) if use_cache else None,
        )

        # 保存中文字幕
        zh_srt = segments_to_srt(zh_segments)
        save_srt(zh_srt, str(zh_srt_path))
        print(f"  → 中文字幕：{zh_srt_path.name}")

        # 双语字幕
        if bilingual:
            bi_srt = merge_bilingual(ja_segments, zh_segments)
            save_srt(bi_srt, str(bilingual_srt_path))
            print(f"  → 双语字幕：{bilingual_srt_path.name}")

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


# ── 缓存管理命令 ──────────────────────────────────────────────────────────────

def cache_command(args):
    """缓存管理子命令"""
    cache_manager = CacheManager()

    if args.cache_action == "list":
        cache_manager.list_caches()
    elif args.cache_action == "clean":
        days = args.days or 30
        cache_manager.clean_old_caches(days)
    elif args.cache_action == "clear":
        import shutil
        shutil.rmtree(cache_manager.cache_dir)
        cache_manager.cache_dir.mkdir(parents=True)
        print(f"✅ 已清空所有缓存")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="视频字幕生成工具：语音识别 + 翻译（支持缓存）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例：
  # 处理单个视频（默认启用缓存）
  python subtitle_generator.py video.mp4

  # 指定输出目录
  python subtitle_generator.py video.mp4 -o ./subtitles

  # 使用更大模型
  python subtitle_generator.py video.mp4 --model large

  # 批量处理整个目录
  python subtitle_generator.py /path/to/videos/ --batch

  # 禁用缓存
  python subtitle_generator.py video.mp4 --no-cache

  # 清理30天前的缓存
  python subtitle_generator.py video.mp4 --clean-cache 30

  # 缓存管理
  python subtitle_generator.py --cache list        # 列出所有缓存
  python subtitle_generator.py --cache clean       # 清理30天前的缓存
  python subtitle_generator.py --cache clear       # 清空所有缓存

  # 不生成双语字幕
  python subtitle_generator.py video.mp4 --no-bilingual

  # 其他语言（如韩文→中文）
  python subtitle_generator.py video.mp4 --source ko --target zh-CN
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
            import shutil
            shutil.rmtree(cache_manager.cache_dir)
            print(f"✅ 已清空所有缓存")
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
    )
    input_path = Path(args.input)

    if args.batch or input_path.is_dir():
        process_directory(str(input_path), **kwargs)
    else:
        process_video(str(input_path), **kwargs)


if __name__ == "__main__":
    main()