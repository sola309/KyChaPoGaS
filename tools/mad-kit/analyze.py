#!/usr/bin/env python3
"""
mad-kit analyze — quality analysis for a finished MAD, reported PER SHOT
so findings map 1:1 onto Shot Editor / LLM instructions.

Usage:
  analyze.py --video <mp4> --project <dir> --shotlist <json> [--out <dir>]
  analyze.py --list                    # catalogue of available analyses

Analyses (see also README.md「解析メニュー」):
  beat_align   cut timing vs the beat grid (±50/±100ms hit rate)
  motion       frame-difference energy; flags STATIC stretches (>1.2s still)
  density      edge density + colorfulness per shot; flags LONELY (sparse) shots
  palette      brightness / saturation stats; flags dull or blown-out shots
  av_energy    audio RMS vs visual motion per shot; flags mismatches
               (music hot / picture flat, and vice versa)
Output: analysis.json (machine) + analysis.md (human/LLM summary)
"""
import argparse
import json
import sys
from pathlib import Path

CATALOG = {
    "beat_align": "カットとビートの一致率(±50/±100ms)。音ハメ精度の機械検証",
    "motion":     "フレーム差分エネルギー。1.2秒以上の静止区間を検出(『止まってる』検出)",
    "density":    "エッジ密度+カラフルネス。要素が少なく寂しいショットを検出",
    "palette":    "明度・彩度の統計。暗すぎ/白飛び/くすみショットを検出",
    "av_energy":  "音楽RMSと映像モーションの相関。音が熱いのに画が平坦な区間を検出",
}


def T_of(v, db):
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and v.startswith("db:"):
        f = float(v[3:]); i = int(f); fr = f - i
        base = db[min(i, len(db) - 1)]
        if fr and i + 1 < len(db):
            base += (db[i + 1] - db[i]) * fr
        return base
    return float(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--video")
    ap.add_argument("--project")
    ap.add_argument("--shotlist")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    if a.list:
        for k, v in CATALOG.items():
            print(f"{k:12s} {v}")
        return

    import cv2
    import numpy as np
    import librosa

    video = Path(a.video); project = Path(a.project)
    shotlist = json.loads((project / a.shotlist).read_text()
                          if not Path(a.shotlist).is_absolute() else Path(a.shotlist).read_text())
    grid = json.loads((project / "beatgrid.json").read_text())
    dbs = grid["downbeats"]
    out_dir = Path(a.out) if a.out else project / "analysis"
    out_dir.mkdir(parents=True, exist_ok=True)

    end_sec = float(shotlist["meta"].get("end_sec") or grid["duration"])
    shots = [{"id": s["id"], "template": s["template"],
              "t0": T_of(s["from"], dbs), "t1": min(T_of(s["to"], dbs), end_sec)}
             for s in shotlist["shots"]]

    # ---- video sweep: motion / edges / color @ 6 fps, 480px wide ----
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 60
    step = max(1, round(fps / 6))
    samples = []          # {t, motion, edges, sat, val, colorfulness}
    prev = None
    fi = 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if fi % step == 0:
            ok, fr = cap.retrieve()
            if not ok:
                break
            fr = cv2.resize(fr, (480, 270))
            gray = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
            hsv = cv2.cvtColor(fr, cv2.COLOR_BGR2HSV)
            edges = cv2.Canny(gray, 60, 160).mean() / 255.0
            b, g, r = fr[:, :, 0].astype(float), fr[:, :, 1].astype(float), fr[:, :, 2].astype(float)
            rg, yb = np.abs(r - g), np.abs(.5 * (r + g) - b)
            colorf = float(np.sqrt(rg.std() ** 2 + yb.std() ** 2) + .3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2)) / 255.0
            motion = float(np.mean(cv2.absdiff(gray, prev))) / 255.0 if prev is not None else 0.0
            samples.append({"t": fi / fps, "motion": motion, "edges": float(edges),
                            "sat": float(hsv[:, :, 1].mean()) / 255.0, "val": float(hsv[:, :, 2].mean()) / 255.0,
                            "colorfulness": colorf})
            prev = gray
        fi += 1
    cap.release()
    S = {k: np.array([s[k] for s in samples]) for k in samples[0]}

    # ---- audio RMS ----
    music = project / shotlist["meta"]["music"]
    y, sr = librosa.load(str(music), sr=22050, mono=True)
    rms = librosa.feature.rms(y=y)[0]
    rt = librosa.frames_to_time(np.arange(len(rms)), sr=sr)
    rms_n = (rms - rms.min()) / (rms.max() - rms.min() + 1e-9)

    # ---- beat alignment (scene cuts vs beats) ----
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector
    v = open_video(str(video)); m = SceneManager(); m.add_detector(ContentDetector(threshold=27.0))
    m.detect_scenes(v, show_progress=False)
    cuts = np.array([sc.get_seconds() for sc, _ in m.get_scene_list()][1:])
    beats = np.array(grid["beats"])
    dcut = np.abs(cuts[:, None] - beats[None, :]).min(axis=1) if len(cuts) else np.array([])
    beat_align = {"cuts": len(cuts),
                  "hit50": round(float((dcut <= .05).mean()), 3) if len(cuts) else None,
                  "hit100": round(float((dcut <= .1).mean()), 3) if len(cuts) else None,
                  "worst": [round(float(c), 2) for c in cuts[dcut > .1]] if len(cuts) else []}

    # ---- per-shot aggregation + flags ----
    mo_med = float(np.median(S["motion"][S["motion"] > 0]))
    ed_med = float(np.median(S["edges"]))
    results = []
    for sh in shots:
        sel = (S["t"] >= sh["t0"] + .15) & (S["t"] < sh["t1"] - .05)
        if not sel.any():
            continue
        mo, ed = S["motion"][sel], S["edges"][sel]
        sat, val, cf = S["sat"][sel], S["val"][sel], S["colorfulness"][sel]
        # static stretches: consecutive samples (6fps) below 25% of median motion
        still = mo < mo_med * .25
        longest = cur = 0
        for x in still:
            cur = cur + 1 if x else 0
            longest = max(longest, cur)
        static_sec = round(longest / 6.0, 2)
        # audio energy inside shot
        rsel = (rt >= sh["t0"]) & (rt < sh["t1"])
        aud = float(rms_n[rsel].mean()) if rsel.any() else 0.0
        flags = []
        if static_sec >= 1.2: flags.append(f"STATIC {static_sec}s")
        if float(ed.mean()) < ed_med * .55 and float(cf.mean()) < .12: flags.append("LONELY")
        if float(val.mean()) < .28: flags.append("DARK")
        if float(sat.mean()) < .13: flags.append("DULL")
        if aud > .55 and float(mo.mean()) < mo_med * .6: flags.append("AV_MISMATCH(音>画)")
        results.append({"shot": sh["id"], "template": sh["template"],
                        "t0": round(sh["t0"], 2), "t1": round(sh["t1"], 2),
                        "motion_mean": round(float(mo.mean()), 4), "static_sec": static_sec,
                        "edges": round(float(ed.mean()), 3), "colorfulness": round(float(cf.mean()), 3),
                        "sat": round(float(sat.mean()), 3), "val": round(float(val.mean()), 3),
                        "audio_energy": round(aud, 3), "flags": flags})

    data = {"video": video.name, "beat_align": beat_align, "shots": results,
            "medians": {"motion": round(mo_med, 4), "edges": round(ed_med, 3)}}
    (out_dir / "analysis.json").write_text(json.dumps(data, ensure_ascii=False, indent=1))

    lines = [f"# 解析レポート — {video.name}", "",
             f"ビート一致: ±50ms {beat_align['hit50']*100:.0f}% / ±100ms {beat_align['hit100']*100:.0f}% ({beat_align['cuts']}カット)",
             f"ズレの大きいカット: {beat_align['worst'] or 'なし'}", "",
             "| shot | 区間 | motion | 静止 | edges | 彩度 | 音 | フラグ |", "|---|---|---|---|---|---|---|---|"]
    for r in results:
        lines.append(f"| {r['shot']} | {r['t0']}–{r['t1']} | {r['motion_mean']} | {r['static_sec']}s "
                     f"| {r['edges']} | {r['sat']} | {r['audio_energy']} | {'⚠ ' + ', '.join(r['flags']) if r['flags'] else '—'} |")
    (out_dir / "analysis.md").write_text("\n".join(lines))
    print(f"cuts beat-align: 50ms={beat_align['hit50']} 100ms={beat_align['hit100']}")
    flagged = [r for r in results if r["flags"]]
    print(f"flagged shots: {len(flagged)}/{len(results)}")
    for r in flagged:
        print(f"  {r['shot']:16s} {', '.join(r['flags'])}")
    print("→", out_dir / "analysis.md")


if __name__ == "__main__":
    main()
