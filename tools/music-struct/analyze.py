#!/usr/bin/env python
"""楽曲構造の解析(All-In-One Music Structure Analyzer)。

本体(backend/.venv)とは別のvenvで動かすためのCLI。
allin1 は NATTEN / madmom / demucs を要求し、本体と依存が衝突しうるので隔離してある。
呼び出し側は subprocess でこれを実行し、stdout の JSON を受け取る。

  usage: analyze.py <audio> [--device cuda]
  出力: 既存の audio_structure と同じ形
        {"sections":[{label,start_sec,end_sec,bars,...}], "buildups":[...], ...}

自作検出器(クロマ自己類似+エネルギー)との違い:
  - 学習済みモデルなので機能ラベルが最初から分かれている
  - 自作版の残余カテゴリ「つなぎ」が break(抜き) と inst(間奏) に分解される
  - bridge = プレサビ が独立して取れる
"""
import argparse, json, os, sys
from pathlib import Path

# allin1 のラベル → 本作の呼び名。
# 未知ラベルはそのまま通す(モデル側の語彙が増えたときに落とさないため)。
LABEL_JA = {
    "chorus": "サビ",
    "verse": "メロ",
    "bridge": "プレサビ",
    "inst": "間奏",
    "solo": "間奏",
    "break": "抜き",
    "intro": "イントロ",
    "outro": "アウトロ",
    "start": "イントロ",
    "end": "アウトロ",
}
# サビ/間奏の直前は「助走」。ここが映像設計で最も効く。
BUILDUP_TARGETS = {"サビ", "間奏"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--device", default="cuda")
    a = ap.parse_args()

    # allin1 は進捗を stdout に出す。stdout は JSON 専用なので stderr へ逃がす。
    #
    # ⚠ contextlib.redirect_stdout だけでは足りない。allin1 は demucs を
    #    **子プロセス** で起動し、その出力は親の fd 1 へ直接書かれるので
    #    Python レベルの差し替えを素通りする(実測: JSONの先頭がdemucsのログで汚れた)。
    #    ここでは fd 1 そのものを stderr(fd 2)へ複製して、子プロセスまで巻き込む。
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    try:
        # allin1 は旧NATTEN APIを要求する。橋渡しは natten_compat 参照。
        sys.path.insert(0, str(Path(__file__).parent))
        import natten_compat
        natten_compat.install()
        import allin1
        res = allin1.analyze(a.audio, device=a.device, keep_byproducts=True)
    finally:
        os.dup2(saved_fd, 1)     # JSON を書く前に stdout を戻す
        os.close(saved_fd)

    beats = [round(float(t), 3) for t in (res.beats or [])]
    downbeats = [round(float(t), 3) for t in (res.downbeats or [])]

    sections = []
    for seg in (res.segments or []):
        lab = LABEL_JA.get(seg.label, seg.label)
        s, e = float(seg.start), float(seg.end)
        # 小節数は小節線から数える(allin1は返さない)
        bars = sum(1 for d in downbeats if s - 1e-6 <= d < e - 1e-6)
        sections.append({
            "label": lab, "raw_label": seg.label,
            "start_sec": round(s, 2), "end_sec": round(e, 2),
            "bars": bars,
        })

    # 助走の検出: サビ/間奏の直前区間を見る。
    # 直前が break(抜き) なら「抜き」、それ以外で短ければ「上昇」とみなす。
    buildups = []
    for i, sc in enumerate(sections):
        if sc["label"] not in BUILDUP_TARGETS or i == 0:
            continue
        prev = sections[i - 1]
        kind = "抜き" if prev["label"] == "抜き" else (
            "上昇" if (prev["end_sec"] - prev["start_sec"]) <= 12 else "平坦")
        buildups.append({
            "start_sec": prev["start_sec"], "end_sec": sc["start_sec"],
            "target": sc["label"], "kind": kind,
            "slope": 0.0, "break": 0.0,   # 既存スキーマ互換(allin1は数値を返さない)
        })

    json.dump({
        "engine": "allin1",
        "bpm": float(res.bpm) if res.bpm else None,
        "bar_count": len(downbeats),
        "beats": beats,
        "downbeats": downbeats,
        "sections": sections,
        "buildups": buildups,
        "has_vocal_stem": True,   # allin1は内部でdemucs分離する
        "has_inst_stem": True,
    }, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
