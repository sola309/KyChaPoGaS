#!/usr/bin/env python3
"""v3プロンプトの全数監査（監督=Claude の検査項目）。

関門(prompt_gate)は「投入できるか」を見る。ここはその先 —
蓄積した設計をCodexが実際に使ったかを見る。

  python3 scripts/v3_audit.py [--verbose]
"""
import argparse, importlib.util, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

MG_HEAVY = {7, 11, 16, 17, 21, 24, 30, 52, 56, 57, 61, 62, 63, 64}
SILENT_CUTS = {1, 2, 4, 5, 6, 43, 45, 65, 66, 67}


def load():
    pk = json.load(open(ROOT / "docs/anipafe2026-cut-packets.json"))
    cuts = {c["n"]: c for c in pk["cuts"]}
    spec = importlib.util.spec_from_file_location("su", ROOT / "scripts/submit_unit.py")
    m = importlib.util.module_from_spec(spec)
    sys.argv = ["x"]
    spec.loader.exec_module(m)
    return cuts, m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    cuts, m = load()
    units = m.parse_units_v3()
    D = m.build_dict()
    from app.services.prompt_gate import validate_video_prompt

    rows, ng = [], []
    for uid, u in sorted(units.items()):
        code = u["code"]
        try:
            expanded = m.expand(code, uid, D)
        except SystemExit as e:
            ng.append((uid, [f"展開失敗: {e}"])); continue
        ns = [int(x) for x in re.findall(r"C(\d+)", u["head"].split("(")[0])]
        problems = validate_video_prompt(31, {
            "model": "minimax-h3" if u["mode"] == "I2VA" else "minimax-h3-ref",
            "prompt": expanded, "duration_sec": u["frames"] / 24.0, "fps": 24,
            "keyframes": [{"asset_id": x} for x in u["refs"][:9]]})

        # ── 監督の検査項目（機械検査できるぶん） ──────────────
        # 1. 実測打点が生値で使われているか
        beats = []
        off = 0.0
        for n in ns:
            beats += [round(off + t, 3) for t in cuts[n]["hits"].get("snare", [])]
            beats += [round(off + t, 3) for t in cuts[n]["hits"].get("kick", [])]
            off += cuts[n]["dur"]
        used = sum(1 for b in beats if f"{b:.3f}" in code)
        # 2. MG重点なら窓/マスク/ワイプ/Z順があるか
        mg = len(re.findall(r"window|mask|wipe|panel|BEHIND|Z-ORDER|in front of", code, re.I))
        # 3. キャラ記述を手書きしていないか（プレースホルダを使ったか）
        ph = len(re.findall(r"\{\{[A-Z_]+_ID\}\}", code))
        # 4. LAWブロック（ルール形）
        law = len(re.findall(r"^[A-Z][A-Z \-]*LAW:", code, re.M))
        # 5. ショット数
        shots = len(re.findall(r"\[Shot \d+\]", code))
        # 6. anchor を肯定形で与えていないか
        bad_anchor = len(re.findall(r"storyboard anchor", code)) - len(re.findall(r"not\s+a\s+storyboard anchor", code, re.S))

        flag = []
        if problems: flag.append("関門")
        if beats and used == 0: flag.append("打点未使用")
        if set(ns) & MG_HEAVY and mg < 6: flag.append(f"MG薄({mg})")
        if not (set(ns) & SILENT_CUTS) and law == 0: flag.append("LAW無し")
        if bad_anchor: flag.append(f"anchor{bad_anchor}")
        if shots == 0: flag.append("Shot無し")
        rows.append((uid, "+".join(f"C{n}" for n in ns), len(expanded.split()),
                     shots, f"{used}/{len(beats)}", mg, ph, law, ",".join(flag)))
        if flag: ng.append((uid, flag + [str(problems)] if problems else flag))

    print(f"{'unit':6s}{'cuts':12s}{'語':>5s}{'shot':>5s}{'打点':>8s}{'MG':>4s}{'PH':>4s}{'LAW':>4s}  問題")
    for r in rows:
        print(f"{r[0]:6s}{r[1]:12s}{r[2]:5d}{r[3]:5d}{r[4]:>8s}{r[5]:4d}{r[6]:4d}{r[7]:4d}  {r[8]}")
    print(f"\n{len(rows)}単位 / 要確認 {len(ng)}件")
    for uid, f in ng:
        print(f"  ✗ {uid}: {f}")


if __name__ == "__main__":
    main()
