#!/usr/bin/env python3
"""
翻译 SRT 字幕文件（日文 → 中文）
用法: python3 scripts/translate_srt.py <file.srt> [file2.srt ...]
      python3 scripts/translate_srt.py /path/to/dir/  # 翻译目录下所有 .zh.srt

依赖环境变量（或直接填写）:
  TENCENT_SECRET_ID
  TENCENT_SECRET_KEY

代理（可选）:
  HTTP_PROXY / HTTPS_PROXY，或通过 --proxy 参数指定，如 http://127.0.0.1:7897
"""

import re, hmac, hashlib, json, time, datetime, urllib.request, sys, os, argparse
from pathlib import Path

# ── 配置 ────────────────────────────────────────────────────────────────────
SECRET_ID  = os.environ.get("TENCENT_SECRET_ID",  "id")
SECRET_KEY = os.environ.get("TENCENT_SECRET_KEY", "key")
ENDPOINT   = "tmt.tencentcloudapi.com"
# ────────────────────────────────────────────────────────────────────────────

def make_opener(proxy: str | None):
    if proxy:
        handler = urllib.request.ProxyHandler({"https": proxy, "http": proxy})
    else:
        handler = urllib.request.ProxyHandler({})
    return urllib.request.build_opener(handler)

def sign(body: str):
    ts   = int(time.time())
    date = datetime.datetime.fromtimestamp(ts, datetime.UTC).strftime('%Y-%m-%d')
    cr_scope = f"{date}/tmt/tc3_request"
    ph   = hashlib.sha256(body.encode()).hexdigest()
    cr   = f"POST\n/\n\ncontent-type:application/json\nhost:{ENDPOINT}\n\ncontent-type;host\n{ph}"
    s2s  = f"TC3-HMAC-SHA256\n{ts}\n{cr_scope}\n{hashlib.sha256(cr.encode()).hexdigest()}"
    def h(k, m): return hmac.new(k if isinstance(k,bytes) else k.encode(), m.encode(), hashlib.sha256).digest()
    sig  = h(h(h(h(f"TC3{SECRET_KEY}".encode(), date), "tmt"), "tc3_request"), s2s).hex()
    auth = (f"TC3-HMAC-SHA256 Credential={SECRET_ID}/{cr_scope}, "
            f"SignedHeaders=content-type;host, Signature={sig}")
    return {"Content-Type":"application/json","Host":ENDPOINT,
            "X-TC-Action":"TextTranslateBatch","X-TC-Version":"2018-03-21",
            "X-TC-Region":"ap-guangzhou","X-TC-Timestamp":str(ts),"Authorization":auth}

def translate(opener, texts: list[str], src="ja", tgt="zh") -> list[str]:
    for attempt in range(4):
        if attempt: time.sleep(1.5 * 2**attempt)
        body = json.dumps({"SourceTextList": texts, "Source": src, "Target": tgt, "ProjectId": 0})
        req  = urllib.request.Request(f"https://{ENDPOINT}", data=body.encode(),
                                       headers=sign(body), method="POST")
        try:
            data = json.loads(opener.open(req, timeout=30).read())
            err  = data.get("Response", {}).get("Error")
            if err:
                if "Internal" in err["Code"] or "Limit" in err["Code"]:
                    print(f"  [retry {attempt+1}] {err['Code']}", file=sys.stderr)
                    continue
                raise Exception(err)
            return data["Response"]["TargetTextList"]
        except Exception as e:
            if attempt == 3: raise
            print(f"  [retry {attempt+1}] {e}", file=sys.stderr)
    return texts  # 兜底返回原文

BLOCK_PAT  = re.compile(r"(\d+)\n(\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3})\n(.*?)(?=\n\n|\Z)", re.DOTALL)
SOUND_PAT  = re.compile(r"^[\(（\[【♪].*[\)）\]】♪]$|^[~～\s]*$")
JA_PAT     = re.compile(r"[぀-ヿ一-鿿]")  # 含日文/中文字符

def is_japanese(text: str) -> bool:
    """检查文本是否含有日文字符（平假名/片假名）"""
    return bool(re.search(r"[぀-ヿ]", text))

def needs_translation(text: str) -> bool:
    if SOUND_PAT.match(text.strip()): return False
    if not text.strip(): return False
    # 如果没有任何日文平假名/片假名，跳过（可能已翻译或是纯英文）
    return is_japanese(text)

def translate_file(path: Path, opener, dry_run=False) -> bool:
    with open(path, encoding="utf-8") as f:
        content = f.read()

    blocks = BLOCK_PAT.findall(content)
    if not blocks:
        print(f"  [skip] 无法解析 SRT 格式: {path.name}", file=sys.stderr)
        return False

    texts = [b[2].strip() for b in blocks]

    # 检查是否需要翻译（有日文才翻译）
    ja_count = sum(1 for t in texts if needs_translation(t))
    if ja_count == 0:
        print(f"  [skip] 无日文内容（已翻译或非日文）: {path.name}", file=sys.stderr)
        return False

    print(f"  {path.name}: {len(blocks)} 条，其中 {ja_count} 条需要翻译", file=sys.stderr)
    if dry_run:
        return True

    translated = list(texts)
    batch, bidx, chars = [], [], 0

    def flush():
        nonlocal batch, bidx, chars
        if not batch: return
        result = translate(opener, batch)
        for i, t in zip(bidx, result):
            translated[i] = t
        batch, bidx, chars = [], [], 0

    for i, t in enumerate(texts):
        if not needs_translation(t): continue
        if batch and (chars + len(t) > 5000 or len(batch) >= 50):
            flush(); time.sleep(0.1)
        batch.append(t); bidx.append(i); chars += len(t)
    flush()

    zh_out = bi_out = ""
    for i, (num, ts, orig) in enumerate(blocks):
        t = translated[i]
        zh_out += f"{num}\n{ts}\n{t}\n\n"
        bi_out += f"{num}\n{ts}\n{orig.strip()}\n{t}\n\n"

    with open(path, "w", encoding="utf-8") as f: f.write(zh_out)
    bi_path = Path(str(path).replace(".zh.", ".bilingual."))
    with open(bi_path, "w", encoding="utf-8") as f: f.write(bi_out)
    print(f"  ✓ -> {path.name}", file=sys.stderr)
    return True

def main():
    parser = argparse.ArgumentParser(description="翻译 SRT 字幕（日→中）")
    parser.add_argument("paths", nargs="+", help="SRT 文件或目录")
    parser.add_argument("--proxy", default=None, help="代理地址，如 http://127.0.0.1:7897")
    parser.add_argument("--dry-run", action="store_true", help="仅检查，不翻译")
    args = parser.parse_args()

    opener = make_opener(args.proxy)
    files  = []

    for p in args.paths:
        path = Path(p)
        if path.is_dir():
            files.extend(sorted(path.rglob("*.zh.srt")))
        elif path.suffix == ".srt":
            files.append(path)
        else:
            print(f"[skip] 非 srt 文件: {p}", file=sys.stderr)

    if not files:
        print("未找到 SRT 文件", file=sys.stderr)
        sys.exit(1)

    print(f"共 {len(files)} 个文件", file=sys.stderr)
    ok = fail = skip = 0
    for f in files:
        try:
            result = translate_file(f, opener, dry_run=args.dry_run)
            if result: ok += 1
            else: skip += 1
        except Exception as e:
            print(f"  ✗ {f.name}: {e}", file=sys.stderr)
            fail += 1

    print(f"\n完成: {ok} 翻译，{skip} 跳过，{fail} 失败", file=sys.stderr)

if __name__ == "__main__":
    main()
