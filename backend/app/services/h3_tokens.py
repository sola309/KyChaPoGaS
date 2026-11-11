"""MiniMax H3 のテキストエンコーダ(Qwen3-VL)が数えるトークン数を、外部ライブラリなしで出す。

バックエンドの venv には transformers / tokenizers / regex が無い。ComfyUI 側の
`Qwen2Tokenizer`(comfy/text_encoders/qwen25_tokenizer の merges.txt)と同じ手順
(NFC 正規化 → 事前分割の正規表現 → バイトレベル BPE)を純 Python で再現して数える。
用途は H3 の詰め込み系列長の見積り(h3_guard)だけ。トークン ID は作らない(数だけ)。

- 事前分割は transformers の PRETOKENIZE_REGEX と同じ規則。\\p{L} / \\p{N} は標準 re に
  無いので、unicodedata の一般カテゴリから文字クラスを組み立てる(初回のみ、約0.3秒)。
- merges.txt が見つからない・読めないときは文字数からの保守的な見積り(多めに数える)に
  切り替える。count_tokens() の戻り値の2つ目で、どちらで数えたかが分かる。
"""
from __future__ import annotations

import logging
import os
import re
import sys
import threading
import unicodedata
from pathlib import Path

log = logging.getLogger("h3_tokens")

# ComfyUI が実際に使うトークナイザのファイル(読むだけ)。環境変数で差し替え可。
_DEFAULT_TOKENIZER_DIR = (Path(__file__).resolve().parents[3]
                          / "tools" / "comfyui" / "comfy" / "text_encoders" / "qwen25_tokenizer")

# Qwen2 の追加トークン(プロンプトにそのまま書かれていれば 1 トークン)+ MiniMax 追加分
_SPECIAL = [
    "<|endoftext|>", "<|im_start|>", "<|im_end|>", "<|object_ref_start|>", "<|object_ref_end|>",
    "<|box_start|>", "<|box_end|>", "<|quad_start|>", "<|quad_end|>", "<|vision_start|>",
    "<|vision_end|>", "<|vision_pad|>", "<|image_pad|>", "<|video_pad|>",
    "<tool_call>", "</tool_call>", "<|fim_prefix|>", "<|fim_middle|>", "<|fim_suffix|>",
    "<|fim_pad|>", "<|repo_name|>", "<|file_sep|>", "<tool_response>", "</tool_response>",
    "<think>", "</think>",
    "<d>", "</d>", "<|cutoff|>", "<|lyrics_start|>", "<|lyrics_end|>",
    "<|caption_start|>", "<|caption_end|>",
]

# 文字数からの見積り(merges.txt が読めないとき): 事前分割の 1 片ごとに ceil(UTF-8 バイト数 / 3)、
# 最低 1。DB の H3 プロンプト(重複除き 1,700 本超)+ラベル類で、正確な数を下回った例は 0、
# 長いプロンプトでは正確な数の約 1.8 倍(最大 2.1 倍)= 3,000 トークンのプロンプトで +2,500 程度
# (系列長全体の約 1.3%)多めに出る。境界ぎりぎりのジョブはこのとき止まりうる。
_FALLBACK_BYTES_PER_TOKEN = 3

_lock = threading.Lock()
_state: dict = {}


def _char_class(prefix: str) -> str:
    """一般カテゴリが prefix で始まる文字の、正規表現用クラス本体(角括弧なし)。"""
    ranges = []
    start = prev = None
    for cp in range(sys.maxunicode + 1):
        if unicodedata.category(chr(cp)).startswith(prefix):
            if start is None:
                start = prev = cp
            elif cp == prev + 1:
                prev = cp
            else:
                ranges.append((start, prev))
                start = prev = cp
    if start is not None:
        ranges.append((start, prev))

    def esc(c: int) -> str:
        return "\\U%08x" % c

    return "".join(esc(a) if a == b else f"{esc(a)}-{esc(b)}" for a, b in ranges)


def _bytes_to_unicode() -> dict[int, str]:
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, (chr(c) for c in cs)))


def _tokenizer_dir() -> Path:
    env = os.environ.get("H3_QWEN_TOKENIZER_DIR")
    return Path(env) if env else _DEFAULT_TOKENIZER_DIR


def _load() -> dict:
    with _lock:
        if _state:
            return _state
        L = _char_class("L")
        N = _char_class("N")
        pat = (r"(?i:'s|'t|'re|'ve|'m|'ll|'d)"
               rf"|[^\r\n{L}{N}]?[{L}]+"
               rf"|[{N}]"
               rf"| ?[^\s{L}{N}]+[\r\n]*"
               r"|\s*[\r\n]+|\s+(?!\S)|\s+")
        _state["pat"] = re.compile(pat)
        special = set(_SPECIAL)
        try:   # tokenizer_config.json の追加トークンも拾う(ComfyUI 側の更新に追従)
            import json
            cfg = json.loads((_tokenizer_dir() / "tokenizer_config.json").read_text(encoding="utf-8"))
            special |= {v["content"] for v in (cfg.get("added_tokens_decoder") or {}).values() if v.get("content")}
        except Exception:
            pass
        _state["special"] = re.compile("|".join(re.escape(s) for s in sorted(special, key=len, reverse=True)))
        _state["byte_enc"] = _bytes_to_unicode()
        _state["cache"] = {}
        ranks: dict[tuple[str, str], int] | None = None
        path = _tokenizer_dir() / "merges.txt"
        try:
            ranks = {}
            with open(path, encoding="utf-8") as f:
                for line in f:
                    if line.startswith("#version") or not line.strip():
                        continue
                    a, _, b = line.rstrip("\n").partition(" ")
                    if b:
                        ranks[(a, b)] = len(ranks)
            if len(ranks) < 1000:
                raise ValueError(f"merges.txt が短すぎる({len(ranks)}行)")
        except Exception as e:  # ファイルが無い/壊れている → 文字数見積りへ
            log.warning("Qwen トークナイザを読めないため文字数で見積もる(多めに数える): %s (%s)", path, e)
            ranks = None
        _state["ranks"] = ranks
        return _state


def _bpe_len(word: str, ranks: dict, cache: dict) -> int:
    hit = cache.get(word)
    if hit is not None:
        return hit
    parts = list(word)
    while len(parts) > 1:
        best = None
        best_rank = None
        for i in range(len(parts) - 1):
            r = ranks.get((parts[i], parts[i + 1]))
            if r is not None and (best_rank is None or r < best_rank):
                best, best_rank = i, r
        if best is None:
            break
        a, b = parts[best], parts[best + 1]
        merged = []
        i = 0
        while i < len(parts):
            if i < len(parts) - 1 and parts[i] == a and parts[i + 1] == b:
                merged.append(a + b)
                i += 2
            else:
                merged.append(parts[i])
                i += 1
        parts = merged
    if len(cache) < 200_000:
        cache[word] = len(parts)
    return len(parts)


def _fallback_count(text: str, st: dict) -> int:
    n = 0
    pos = 0
    pieces = []
    for m in st["special"].finditer(text):
        pieces.append(text[pos:m.start()])
        n += 1
        pos = m.end()
    pieces.append(text[pos:])
    for piece in pieces:
        for w in st["pat"].findall(piece):
            n += max(1, -(-len(w.encode("utf-8")) // _FALLBACK_BYTES_PER_TOKEN))
    return n


def count_tokens(text: str) -> tuple[int, bool]:
    """(トークン数, 正確か)。正確=False は文字数からの保守的な見積り。"""
    if not text:
        return 0, True
    st = _load()
    ranks = st["ranks"]
    text = unicodedata.normalize("NFC", text)
    if ranks is None:
        return _fallback_count(text, st), False
    enc = st["byte_enc"]
    cache = st["cache"]
    pat = st["pat"]
    total = 0
    pos = 0
    pieces = []
    for m in st["special"].finditer(text):
        pieces.append(text[pos:m.start()])
        total += 1
        pos = m.end()
    pieces.append(text[pos:])
    for piece in pieces:
        for w in pat.findall(piece):
            total += _bpe_len("".join(enc[b] for b in w.encode("utf-8")), ranks, cache)
    return total, True


def is_exact() -> bool:
    """トークナイザ(merges.txt)を読めているか。"""
    return _load()["ranks"] is not None
