#!/usr/bin/env python3
"""
subextract — 跨平台音频提取工具
调用 ffmpeg 从视频提取 16kHz 单声道 WAV，供 SubGen 使用。

用法: python extract.py <输入...> [选项]
      python extract.py video.mp4
      python extract.py video1.mp4 video2.mkv -o output -d 120
      python extract.py ./videos/ -r -j 4
"""

import argparse
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# 修复 Windows GBK 终端编码问题
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_EXT = {"mp4", "mkv", "ts", "m2ts", "webm", "avi", "mov", "wmv", "flv", "mpg", "mpeg", "vob"}


def collect_files(inputs: list[str], ext_filter: set[str], recursive: bool) -> list[Path]:
    files: list[Path] = []
    for inp in inputs:
        p = Path(inp)
        if not p.exists():
            print(f"[跳过] 路径不存在: {inp}", file=sys.stderr)
            continue
        if p.is_file():
            if p.suffix.lower().lstrip(".") in ext_filter:
                files.append(p.resolve())
            else:
                print(f"[跳过] 格式不支持: {p}", file=sys.stderr)
        elif p.is_dir():
            _scan_dir(p, ext_filter, recursive, files)
    files = sorted(set(files))
    return files


def _scan_dir(d: Path, ext_filter: set[str], recursive: bool, files: list[Path]) -> None:
    try:
        for entry in d.iterdir():
            if entry.is_file() and entry.suffix.lower().lstrip(".") in ext_filter:
                files.append(entry.resolve())
            elif recursive and entry.is_dir():
                _scan_dir(entry, ext_filter, recursive, files)
    except PermissionError:
        pass


def extract_audio(input_path: Path, output_dir: Path, duration: float) -> tuple[Path, str | None]:
    """返回 (output_path, error_or_none)"""
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / f"{input_path.stem}.wav"

    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(input_path),
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
    ]
    if duration > 0:
        cmd += ["-t", str(duration)]
    cmd.append(str(output))

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode == 0:
            return output, None
        else:
            err = result.stderr.strip() or f"ffmpeg 返回错误码 {result.returncode}"
            return output, err
    except FileNotFoundError:
        return output, "ffmpeg 未找到。请确保 ffmpeg 已安装并在 PATH 中"
    except subprocess.TimeoutExpired:
        return output, "ffmpeg 超时（超过 10 分钟）"
    except Exception as e:
        return output, str(e)


def main():
    parser = argparse.ArgumentParser(
        description="subextract — 从视频提取 16kHz 单声道 WAV 音频",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例:\n  python extract.py video.mp4\n  python extract.py ./videos/ -r\n  python extract.py a.mp4 b.mkv -d 300 -o audio",
    )
    parser.add_argument("inputs", nargs="+", help="视频文件或文件夹路径")
    parser.add_argument("-o", "--output", default="output", help="输出目录 (默认: output)")
    parser.add_argument("-d", "--duration", type=float, default=120, help="提取时长（秒），0=完整 (默认: 120)")
    parser.add_argument("-r", "--recursive", action="store_true", help="递归搜索子文件夹")
    parser.add_argument("-j", "--jobs", type=int, default=2, help="并行数 (默认: 2)")
    parser.add_argument("--ext", default="mp4,mkv,ts,m2ts,webm,avi,mov,wmv,flv", help="扩展名过滤 (逗号分隔)")

    args = parser.parse_args()

    ext_filter = {e.strip().lower().lstrip(".") for e in args.ext.split(",")}

    files = collect_files(args.inputs, ext_filter, args.recursive)

    if not files:
        print("未找到匹配的视频文件。", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output)
    total = len(files)
    jobs = max(1, args.jobs)

    print(f"找到 {total} 个视频文件")
    if args.duration > 0:
        print(f"提取时长: {args.duration:.0f} 秒（前 {args.duration / 60:.1f} 分钟）")
    else:
        print("提取时长: 完整音频")
    print(f"输出目录: {output_dir.resolve()}")
    print(f"并行任务: {jobs}")
    print("---")

    done = 0
    errors: list[tuple[Path, str]] = []

    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(extract_audio, f, output_dir, args.duration): f for f in files}
        for future in as_completed(futures):
            f = futures[future]
            out, err = future.result()
            done += 1
            name = f.name
            if len(name) > 55:
                name = name[:55]
            if err:
                print(f"\r[{done}/{total}] FAIL {name} — {err}")
                errors.append((f, err))
            else:
                print(f"\r[{done}/{total}] OK  {out.name}")

    print(f"\n---")
    print(f"完成: {total - len(errors)}/{total} 成功")
    if errors:
        print(f"{len(errors)} 个失败:", file=sys.stderr)
        for path, msg in errors:
            print(f"  - {path.name}: {msg}", file=sys.stderr)


if __name__ == "__main__":
    main()
