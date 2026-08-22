#!/usr/bin/env python3
"""全67カットの設計データを1つのJSONに機械集約する。

プロンプト執筆の唯一の入力。手書き転記を排除する(2026-08-23の29本未反映事故の再発防止)。
出典: ピンのattrs_json(設計の唯一の正) + 音源解析(打点/構造/移動量/手動盛り上げ)。

使い方: backend起動中に  python3 scripts/build_cut_packets.py
出力:   docs/anipafe2026-cut-packets.json
"""
import json, urllib.request, ast, re, sys

B = "http://localhost:8002/api"
AUDIO_ASSET = 357
FPS = 24.0

def g(p):
    return json.load(urllib.request.urlopen(B + p))

def analysis(kind):
    for r in g(f"/analysis/{AUDIO_ASSET}"):
        if r["analysis_type"] == kind:
            v = r["result"]
            return ast.literal_eval(v) if isinstance(v, str) else v
    return None

# ── 生成単位(2026-08-23 ユーザー承認のグルーピング) ─────────────────
UNITS = [
    [1],[2],[3],[4],[5,6],[7],[8],[9],[10],[11],[12],[13],[14],[15,16],[17],
    [18,19],[20,21,22],[23,24],[25,26],[27,28,29],[30],[31,32],[33,34],[35],
    [36,37,38],[39,40,41],[42],[43,44],[45],[46],[47],[48],[49,50,51],[52,53],
    [54,55],[56,57],[58,59],[60],[61,62,63],[64],[65,66],[67],
]

def snap(n):
    n = max(124, min(362, n))
    return min(362, n + (5 - (n % 17)) % 17)

def main():
    pins = [c for c in g("/clips/?track_id=54") if c.get("asset_id")]
    pins.sort(key=lambda c: c["start_frame"])
    drums = analysis("audio_drums")["classes"]
    structure = analysis("audio_structure")
    motion = analysis("audio_motion")
    override = analysis("audio_structure_override") or {}
    mfps = motion["fps"] / motion.get("decim", 1)

    cuts = []
    for i in range(0, len(pins) - 1, 2):
        n = i // 2 + 1
        s, e = pins[i]["start_frame"], pins[i + 1]["start_frame"]
        t0, t1 = s / FPS, (e + 1) / FPS
        d = json.loads(pins[i]["attrs_json"]) if pins[i].get("attrs_json") else {}
        bd = (d.get("scene") or {}).get("board") or {}
        intent = str(d.get("intent", ""))
        hits = {k: [round(x["t"] - t0, 3) for x in v if t0 <= x["t"] < t1]
                for k, v in drums.items()}
        secs = [sec.get("label") for sec in structure.get("sections", [])
                if sec.get("start_sec", 0) < t1 and sec.get("end_sec", 0) > t0]
        bups = [b for b in (override.get("buildups") or [])
                if b.get("start_sec", 0) < t1 and b.get("end_sec", 0) > t0]
        def seg(key):
            arr = motion.get(key)
            if not isinstance(arr, list): return None
            a, b = int(t0 * mfps), max(int(t0 * mfps) + 1, int(t1 * mfps))
            v = arr[a:b]
            return {"avg": round(sum(v) / len(v), 2), "max": round(max(v), 2)} if v else None
        cuts.append({
            "n": n, "frame": [s, e], "frames": e - s + 1, "sec": [round(t0, 2), round(t1, 2)],
            "dur": round(t1 - t0, 2),
            "lyrics": bd.get("lyrics", "") or "",
            "intent": intent,
            "warns": [m.strip() for m in re.findall(r"⚠([^。\n]{4,80})", intent)],
            "links": sorted({int(m) for m in re.findall(r"C(\d+)", intent)
                             if int(m) != n and 1 <= int(m) <= 67}),
            "no_person": "人物なし" in intent,
            "assets": sorted({int(m) for m in re.findall(r"#(\d{3,4})", intent)}),
            "hits": {k: v for k, v in hits.items() if v},
            "hit_density": round(sum(len(v) for k, v in hits.items()
                                     if k in ("snare", "kick", "cymbal")) / (t1 - t0), 1),
            "sections": sorted(set(secs)),
            "manual_buildups": bups,
            "motion": {k: seg(k) for k in ("move_pct", "sustain", "punch", "voice", "grain")},
        })

    units = []
    for uid, ns in enumerate(UNITS, 1):
        f = sum(next(c["frames"] for c in cuts if c["n"] == x) for x in ns)
        units.append({"unit": uid, "cuts": ns, "cut_frames": f,
                      "gen_frames": snap(f), "use_pct": round(f / snap(f) * 100),
                      "inner_hard_cuts": len(ns) - 1})

    out = {"generated_from": "pins attrs_json (唯一の正) + analysis(357)",
           "fps": FPS, "cuts": cuts, "units": units}
    path = "docs/anipafe2026-cut-packets.json"
    json.dump(out, open(path, "w"), ensure_ascii=False, indent=1)
    total_use = sum(u["cut_frames"] for u in units) / sum(u["gen_frames"] for u in units)
    print(f"{path}: {len(cuts)}カット / {len(units)}生成単位 / 全体使用率{total_use*100:.0f}%")

if __name__ == "__main__":
    sys.exit(main())
