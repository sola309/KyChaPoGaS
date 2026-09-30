#!/usr/bin/env python3
"""T1出力を設計意図と照合する軽量診断(ローカルVLM gemma4-26b)。Claudeのトークンを使わない。

  python3 scripts/v4_diag.py [--units U01 U02] [--out outputs/anipafe2026-v4/diag]

各単位: カット中点+ショット境界から最大6フレーム抽出 → VLMに(1)客観描写 (2)意図との照合 を問う。
出力: <out>/<uid>.json と <out>/summary.md
"""
import argparse, base64, json, re, sqlite3, subprocess, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLLAMA = "http://127.0.0.1:11434/api/generate"
MODEL = "gemma4-26b:latest"


def vlm(prompt, images, num_predict=700):
    body = {"model": MODEL, "prompt": prompt, "images": images, "stream": False,
            "options": {"temperature": 0.2, "num_predict": num_predict}}
    r = urllib.request.Request(OLLAMA, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=900)).get("response", "")


def frames_for(uid, u, cuts, prompt_text, path, outdir):
    """カット中点 + [Shot N] At MM:SS.mmm の境界(先頭6つ)"""
    times, off = [], 0.0
    for n in u["cuts"]:
        d = cuts[n]["dur"]; times.append(off + d / 2); off += d
    for m in re.finditer(r"\[Shot \d+\] At (\d\d):(\d\d)\.(\d{3})", prompt_text):
        times.append(int(m.group(1)) * 60 + int(m.group(2)) + int(m.group(3)) / 1000 + 0.15)
    total = u["frames"] / 24.0
    times = sorted({round(min(max(t, 0.05), total - 0.1), 2) for t in times})
    if len(times) > 6:   # 均等に間引く
        idx = [round(i * (len(times) - 1) / 5) for i in range(6)]
        times = [times[i] for i in idx]
    outs = []
    for i, t in enumerate(times):
        f = outdir / f"{uid}_{i}_{t:.2f}.jpg"
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", str(path),
                        "-frames:v", "1", "-vf", "scale=560:314", "-q:v", "5", str(f)])
        if f.exists():
            outs.append((t, f))
    return outs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--units", nargs="*")
    ap.add_argument("--out", default="outputs/anipafe2026-v4/diag")
    ap.add_argument("--pdir", default="docs/anipafe2026-prompts-v4")
    ap.add_argument("--ledger", default="outputs/anipafe2026-v4/stream_ledger.json")
    a = ap.parse_args()
    out = ROOT / a.out; out.mkdir(parents=True, exist_ok=True)
    units = json.load(open(ROOT / a.pdir / "units.json"))
    pk = json.load(open(ROOT / "docs/anipafe2026-cut-packets.json")); cuts = {c["n"]: c for c in pk["cuts"]}
    led = json.load(open(ROOT / a.ledger))
    db = sqlite3.connect(ROOT / "backend/data/kychapogas.db")
    summary = []
    for uid in (a.units or list(units)):
        u = units[uid]; v = led.get(uid, {})
        if v.get("status") != "completed":
            continue
        path = db.execute("SELECT file_path FROM asset WHERE id=?", (v["asset"],)).fetchone()[0]
        prompt_text = (ROOT / a.pdir / f"{uid}.txt").read_text()
        fr = frames_for(uid, u, cuts, prompt_text, path, out)
        if (out / f"{uid}.json").exists():
            print(f"{uid} skip (done)", flush=True); continue
        grid = out / f"{uid}_grid.jpg"
        n = len(fr); cols = 3 if n > 2 else n; rows = (n + cols - 1) // cols
        inputs = sum([["-i", str(f)] for _, f in fr], [])
        if n == 1:
            subprocess.run(["cp", str(fr[0][1]), str(grid)])
        fc = "".join(f"[{i}:v]drawtext=text='{i+1} {t:.1f}s':x=8:y=8:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.7[v{i}];" for i, (t, _) in enumerate(fr))
        fc += "".join(f"[v{i}]" for i in range(n)) + f"xstack=inputs={n}:layout=" + "|".join(f"{(i%cols)*560}_{(i//cols)*314}" for i in range(n)) + ":fill=black"
        if n > 1:
            subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs, "-filter_complex", fc, "-q:v", "4", str(grid)])
        if not grid.exists():
            print(f"{uid} grid failed (frames={n}) → skip", flush=True); continue
        imgs = [base64.b64encode(grid.read_bytes()).decode()]
        tlist = ", ".join(f"tile{i+1}={t:.1f}s" for i, (t, _) in enumerate(fr))
        intents = "\n".join(f"C{n} ({cuts[n]['dur']}s): {cuts[n]['intent']}" for n in u["cuts"])
        q = (f"The single image is a contact sheet of {len(fr)} frames from one generated 2D-anime video, numbered in time order left-to-right, top-to-bottom ({tlist}).\n"
             f"Design intent (Japanese; ⚠ = fixed requirement; '示唆で消すもの' = deliberately NOT shown):\n{intents}\n\n"
             "First, for EACH tile write ONE literal line: people count; hair colour/costume; framing; any hard-edged window/mask/panel/split and its contents; any text, letters, © marks, logos or watermarks; dominant colours/light; what changed vs the previous tile.\n"
             "Then judge strictly from what is visible, in Japanese, with headings:\n"
             "【実現】 visible intent elements\n【未実現】 missing or wrong intent elements (say which frame)\n"
             "【禁則違反】 things that should NOT appear (text/logos, forbidden elements, wrong character)\n"
             "【動き】 static / moderate / chaotic; do shot changes look like hard cuts?\n【総合】 1-5 (5 = intent fully realized)")
        judge = vlm(q, imgs, 1100)
        desc = ""
        score = re.findall(r"【総合】[^0-9]{0,40}(\d)\s*/?\s*5?", judge)
        rec = {"unit": uid, "cuts": u["cuts"], "asset": v["asset"], "frames": [t for t, _ in fr],
               "description": desc, "judgement": judge, "score": int(score[0]) if score else None}
        (out / f"{uid}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1))
        summary.append(rec)
        print(f"{uid} score={rec['score']} frames={len(fr)}", flush=True)
    md = ["# v4 T1 診断(gemma4-26b)\n"]
    for r in summary:
        md.append(f"## {r['unit']} C{'+C'.join(map(str, r['cuts']))} score={r['score']}\n\n{r['judgement']}\n")
    (out / "summary.md").write_text("\n".join(md))
    print("done:", out / "summary.md")


if __name__ == "__main__":
    main()
