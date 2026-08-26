#!/usr/bin/env python3
"""生成単位に対応する音源セグメントを切り出し、H3の参照音声アセットとして登録する。

v3まで音声参照を一度も渡していなかった(43/43でゼロ)。H3 Ref2VAは参照音声を
最大3本受け取れるのに、打点は「テキストに秒数を書く」だけで伝えていた。
つまりH3は音を聴いていなかった。ここはその配線。

  python3 scripts/ref_audio.py U13 --stem vocal    # 歌唱ステム(リップシンク用)
  python3 scripts/ref_audio.py U18 --stem inst     # 伴奏ステム(打点駆動用)

切り出し区間は「カット先頭から生成尺ぶん」= 映像の時刻0と音声の時刻0が一致する。
同じ単位・同じステムなら台帳を引いて再利用する(切り直さない)。
"""
import argparse, importlib.util, json, re, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "http://localhost:8002/api"
LEDGER = ROOT / "docs/anipafe2026-ref-audio.json"

# プロジェクト31のタイムラインにあるステム(project 28由来の原盤を共有)
STEMS = {"vocal": 757, "inst": 758, "full": 357}


def _units():
    spec = importlib.util.spec_from_file_location("su", ROOT / "scripts/submit_unit.py")
    m = importlib.util.module_from_spec(spec)
    sys.argv = ["x"]
    spec.loader.exec_module(m)
    return m


def make(uid: str, stem: str, force: bool = False) -> int:
    led = json.loads(LEDGER.read_text()) if LEDGER.exists() else {}
    key = f"{uid}:{stem}"
    if not force and key in led:
        return led[key]["asset_id"]

    m = _units()
    u = m.parse_units_v3()[uid]
    ns = [int(x) for x in re.findall(r"C(\d+)", u["head"].split("(")[0])]
    start_sec = m.cut_ranges()[ns[0]][0] / 24.0
    dur_sec = u["frames"] / 24.0

    src = STEMS[stem]
    q = f"start_sec={start_sec:.3f}&dur_sec={dur_sec:.3f}"
    r = urllib.request.Request(f"{API}/assets/{src}/extract-clip?{q}", method="POST")
    a = json.load(urllib.request.urlopen(r, timeout=120))

    led[key] = {"asset_id": a["id"], "stem": stem, "src": src,
                "start_sec": round(start_sec, 3), "dur_sec": round(dur_sec, 3)}
    LEDGER.write_text(json.dumps(led, ensure_ascii=False, indent=1))
    return a["id"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("units", nargs="+")
    ap.add_argument("--stem", choices=list(STEMS), default="vocal")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    out = {}
    for uid in a.units:
        aid = make(uid, a.stem, a.force)
        out[uid] = aid
        print(f"{uid} [{a.stem}] → asset #{aid}")
    print(json.dumps(out))


if __name__ == "__main__":
    main()
