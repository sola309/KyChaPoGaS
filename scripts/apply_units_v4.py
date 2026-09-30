#!/usr/bin/env python3
"""v4(連番U01-U30)の生成単位情報を Image トラックのピン attrs.unit へ書き込む。
参照音声ステムは ref_audio.make_v4 で用意(既存区間は再利用)。

  python3 scripts/apply_units_v4.py [--dry]
"""
import argparse, importlib.util, json, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "http://localhost:8002/api"
STEM_LABEL = {"inst": "伴奏", "vocal": "歌唱"}
ROLE_STEMS = {"beat": ["inst"], "lipsync": ["vocal"], "full": ["vocal", "inst"]}


def api(method, path, body=None):
    r = urllib.request.Request(API + path, method=method,
        data=(json.dumps(body, ensure_ascii=False).encode() if body is not None else None),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=60) as f:
        raw = f.read()
    return json.loads(raw) if raw else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    sys.path.insert(0, str(ROOT / "scripts"))
    import ref_audio as RA
    units = json.load(open(ROOT / "docs/anipafe2026-prompts-v4/units.json"))
    pk = json.load(open(ROOT / "docs/anipafe2026-cut-packets.json"))
    cuts = {c["n"]: c for c in pk["cuts"]}
    pins = [c for c in api("GET", "/clips/?track_id=54") if c.get("asset_id")]
    pins.sort(key=lambda c: c["start_frame"])
    n_pins = 0
    for uid, u in units.items():
        ns = u["cuts"]
        f0 = cuts[ns[0]]["frame"][0]
        f1 = cuts[ns[-1]]["frame"][1]
        # 参照音声
        audio = []
        role = u.get("audio")
        if role and u["mode"] == "Ref2VA":
            for stem in ROLE_STEMS[role]:
                aid = None if a.dry else RA.make_v4(uid, stem, f0 / 24.0, u["frames"] / 24.0)
                audio.append({"asset_id": aid, "stem": STEM_LABEL[stem], "src": RA.STEMS[stem],
                              "start_sec": round(f0 / 24.0, 3), "dur_sec": round(u["frames"] / 24.0, 3),
                              "role": stem})
        # ショット=カット境界(スネア上のショットはプロンプト本文が持つ)
        shots, off = [], 0.0
        for i, n in enumerate(ns, 1):
            shots.append({"i": i, "sec": round(off, 3), "frame": cuts[n]["frame"][0],
                          "src": f"cut{n}", "dev": 0.0, "dur": cuts[n]["dur"]})
            off += cuts[n]["dur"]
        info = {"id": uid, "mode": u["mode"], "frames": u["frames"], "title": u["title"],
                "refs": u["refs"], "cuts": ns, "audio": audio, "shots": shots, "v3_id": u["v3_id"]}
        for pin in pins:
            if f0 <= pin["start_frame"] <= f1:
                attrs = json.loads(pin.get("attrs_json") or "{}")
                if "unit_v3" not in attrs and attrs.get("unit"):
                    attrs["unit_v3"] = attrs["unit"]
                attrs["unit"] = info
                if not a.dry:
                    api("PATCH", f"/clips/{pin['id']}", {"attrs_json": json.dumps(attrs, ensure_ascii=False)})
                n_pins += 1
        print(f"{uid}: cuts {ns} f{f0}-{f1} audio={[(x['role'], x['asset_id']) for x in audio]}")
    print(f"{'(dry) ' if a.dry else ''}pins updated: {n_pins}")


if __name__ == "__main__":
    main()
