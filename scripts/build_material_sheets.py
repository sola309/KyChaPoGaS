#!/usr/bin/env python3
"""素材候補ジョブの結果を素材ごとの比較シート(候補×シード+主参照)に組む。

使い方: python3 scripts/build_material_sheets.py <jobs_json> <outdir>
jobs_json: {"M-1_halfmoon_s1": 3624, ...}
出力: outdir/sheet_<素材名>.png と outdir/index.json
"""
import json, sys, urllib.request
from pathlib import Path
from PIL import Image, ImageDraw

B = "http://localhost:8002/api"

def g(p):
    return json.load(urllib.request.urlopen(B + p))

def main():
    jobs = json.load(open(sys.argv[1]))
    outdir = Path(sys.argv[2]); outdir.mkdir(parents=True, exist_ok=True)
    # 素材名 -> [(seed, job_id, asset_id or None, error)]
    mats = {}
    for key, jid in jobs.items():
        name, seed = key.rsplit("_s", 1)
        j = g(f"/jobs/{jid}")
        aid = (j.get("result_asset_ids") or [None])[0]
        mats.setdefault(name, []).append((seed, jid, aid, j.get("error_msg")))
    index = {}
    H = 420
    for name, rows in sorted(mats.items()):
        cells = []
        for seed, jid, aid, err in sorted(rows):
            if aid is None:
                cells.append((f"s{seed} 失敗", None)); continue
            a = g(f"/assets/{aid}")
            im = Image.open(a["file_path"]).convert("RGB")
            cells.append((f"s{seed} #{aid}", im))
        imgs = [(l, im.resize((int(im.width * H / im.height), H), Image.LANCZOS))
                for l, im in cells if im]
        if not imgs:
            index[name] = {"status": "all_failed"}; continue
        W = sum(im.width for _, im in imgs) + 8 * (len(imgs) + 1)
        c = Image.new("RGB", (W, H + 30), (20, 20, 22))
        dr = ImageDraw.Draw(c)
        x = 8
        for l, im in imgs:
            c.paste(im, (x, 26)); dr.text((x + 4, 5), f"{name}  {l}", fill=(235, 235, 235))
            x += im.width + 8
        p = outdir / f"sheet_{name}.png"
        c.save(p)
        index[name] = {"sheet": str(p),
                       "assets": [a for _, _, a, _ in sorted(rows) if a]}
    json.dump(index, open(outdir / "index.json", "w"), ensure_ascii=False, indent=1)
    print(f"{len(index)}素材ぶんのシートを {outdir} へ出力")

if __name__ == "__main__":
    main()
