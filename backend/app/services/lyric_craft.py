"""
lyric_craft — 作詞リンター。歌詞がメロディに乗るかを譜割りレベルで検査する。

背景: ACE-Step等のAI作曲は歌詞(詞先)からメロディを組むため、モーラ設計が
悪い歌詞はメロディごと崩れる。プロ作詞の規律を機械検査に落とす:
  * モーラ数(拗音=1/促音・撥音・長音=各1)と行間の平行性(1番2番で字数を揃える)
  * 行頭母音: サビ頭は「あ段」が立つ・「う段」は勢いが出ない
  * 行末: 伸ばせる母音(あ/お段・長音)が良い・「っ」止めは切れる
  * 定番テンプレ(5-7 / 7-5 / 8-8 / 4-4-4-4 / 10-10 等)への適合
"""
from __future__ import annotations

import re

import pykakasi

_kks = pykakasi.kakasi()

SMALL = set("ゃゅょぁぃぇぉゎ")  # 前のかなと合わせて1モーラ(ぅは外来語で単独例あり→簡易で結合)
SMALL_U = "ぅ"
VOWEL = {}
for v, kana in (("a", "あかがさざただなはばぱまやらわ"),
                ("i", "いきぎしじちぢにひびぴみり"),
                ("u", "うくぐすずつづぬふぶぷむゆる"),
                ("e", "えけげせぜてでねへべぺめれ"),
                ("o", "おこごそぞとどのほぼぽもよろを")):
    for k in kana:
        VOWEL[k] = v


def to_hira(text: str) -> str:
    return "".join(item["hira"] for item in _kks.convert(text))


def mora_split(line: str) -> list[str]:
    hira = to_hira(re.sub(r"[^ぁ-ゖァ-ヺー一-鿿a-zA-Z0-9]", "", line))
    out: list[str] = []
    for ch in hira:
        if ch in SMALL or ch == SMALL_U:
            if out:
                out[-1] += ch
                continue
        out.append(ch)
    return out


def line_info(line: str) -> dict:
    # スペース(半角/全角)は譜割りのフレーズ区切りとして扱う
    phrases = [ph for ph in re.split(r"[ 　]+", line.strip()) if ph]
    ph_moras = [len(mora_split(ph)) for ph in phrases]
    moras = mora_split(line)
    n = len(moras)
    head = moras[0] if moras else ""
    tail = moras[-1] if moras else ""
    head_v = VOWEL.get(head[0], "?") if head else "?"
    tail_v = "n" if tail == "ん" else ("long" if tail == "ー" else VOWEL.get(tail[0], "?"))
    return {"text": line, "mora": n, "phrases": ph_moras,
            "head_vowel": head_v, "tail": tail, "tail_vowel": tail_v}


TEMPLATES = {"5-7": [5, 7], "7-5": [7, 5], "8-8": [8, 8], "4-4-4-4": [4, 4, 4, 4],
             "6-6-6": [6, 6, 6], "10-10": [10, 10], "5-7-5": [5, 7, 5]}


def nearest_template(mora: int) -> str:
    best, bd = "", 99
    for name, parts in TEMPLATES.items():
        d = abs(sum(parts) - mora)
        if d < bd:
            bd, best = d, name
    return f"{best}(±{bd})" if bd <= 2 else "—"


def check(lyrics: str) -> dict:
    """歌詞全体を検査してレポートを返す。"""
    sections: list[dict] = []
    cur: dict | None = None
    for raw in lyrics.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or re.match(r"^[^\[]{0,6}[:：]", line):
            continue
        if cur is None and ("。" in line or "/" in line):
            continue   # 冒頭の説明文(セクション開始前)は歌詞でない
        # ACE-Step公式の拡張タグ([Chorus - anthemic]等)も行全体タグならセクション扱い
        m = re.match(r"^\[([A-Za-z][^\]]*)\]\s*$", line) or re.match(r"\[(\w[\w-]*)\]", line)
        if m:
            cur = {"tag": re.split(r"[\s\-]", m.group(1).lower())[0], "lines": []}
            sections.append(cur)
            rest = line[m.end():].strip()
            if rest:
                cur["lines"].append(line_info(rest))
            continue
        if cur is None:
            cur = {"tag": "verse", "lines": []}
            sections.append(cur)
        # 括弧の演出指示は除いて数える
        clean = re.sub(r"[(（][^)）]*[)）]", "", line).strip()
        if clean:
            cur["lines"].append(line_info(clean))

    warnings: list[str] = []
    for si, sec in enumerate(sections):
        tag, lines = sec["tag"], sec["lines"]
        if not lines:
            continue
        # 英語シャウト行(全大文字ラテン)は掛け声=対判定から除外
        pair_lines = [l for l in lines if not re.match(r"^[A-Z0-9 !?',.]+$", l["text"])]
        counts = [l["mora"] for l in pair_lines]
        # 平行性: 対の行(1&2, 3&4…)のモーラ数を比較 — メロディ反復の要
        for a in range(0, len(counts) - 1, 2):
            if abs(counts[a] - counts[a + 1]) > 2:
                warnings.append(f"[{tag}#{si}] 対の行{a+1},{a+2}が{counts[a]}vs{counts[a+1]}モーラ — ±1に揃える")
        if "chorus" in tag:
            if lines[0]["head_vowel"] == "u":
                warnings.append(f"[{tag}#{si}] サビ頭が『う段』({lines[0]['text'][:6]}…) — 勢いが出ない。あ段推奨")
            for l in lines:
                if l["tail"] == "っ":
                    warnings.append(f"[{tag}#{si}] 行末が促音『っ』({l['text'][:8]}…) — 伸ばせず切れる")
            if lines[0]["phrases"] and lines[0]["phrases"][0] > 10:
                warnings.append(f"[{tag}#{si}] サビ頭フレーズが{lines[0]['phrases'][0]}モーラ — 8前後が刺さる")
        for l in lines:
            for pm in l["phrases"]:
                if pm > 12:
                    warnings.append(f"[{tag}#{si}] {pm}モーラのフレーズ({l['text'][:10]}…) — スペースで分割推奨")
        sec["template"] = nearest_template(sum(counts) / max(1, len(counts)) * 0 + counts[0]) if counts else "—"

    n_all = [l["mora"] for s in sections for l in s["lines"]]
    score = 100
    score -= min(40, len(warnings) * 8)
    if n_all:
        import statistics
        if len(n_all) > 2 and statistics.pstdev(n_all) > 3.2:
            score -= 10
    return {"sections": sections, "warnings": warnings, "score": max(0, score)}
