#!/usr/bin/env python3
"""帰巡ef: 生成テイクと元カットを同時刻で並べた比較シート。
usage: ef_cmp_sheet.py <job_id> [<job_id>...]  → outputs/kijun-ef/C34/cmp_<job>.jpg
上段=元ネタ(#3893 参照クリップ), 下段=生成物。8時刻(0..最終)。"""
import json, sqlite3, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "backend/data/kychapogas.db"
REF = ROOT / "outputs/sm25396663_24p.mp4"   # 元動画(24fps)。C34 = 1928..2134
OUT = ROOT / "outputs/kijun-ef/C34"
S, E = 1928, 2134


def _cut_index(start_frame):
    """ピン列からカット番号を引く(見つからなければ None)"""
    try:
        import urllib.request
        pins = sorted(json.load(urllib.request.urlopen("http://localhost:8002/api/clips/?track_id=72")), key=lambda c: (c["start_frame"], c["id"]))
        for i in range(0, len(pins) - 1, 2):
            if pins[i]["start_frame"] == start_frame:
                return i // 2 + 1
    except Exception:
        return None
    return None

def sheet(job):
    db = sqlite3.connect(DB)
    row = db.execute("select params, result_asset_ids from job where id=?", (job,)).fetchone()
    params = json.loads(row[0]); rid = json.loads(row[1] or "[]")
    # カット範囲はジョブの place(=カット開始/尺)から取る(C34 以外のカットでも使えるように)
    global S, E, OUT
    pl = params.get("place") or {}
    if pl.get("start_frame") is not None:
        S = int(pl["start_frame"]); E = S + int(pl.get("duration_frames", E - S + 1)) - 1
    cut_dir = ROOT / "outputs/kijun-ef" / (f"C{_cut_index(S)}" if _cut_index(S) else "C34")
    cut_dir.mkdir(parents=True, exist_ok=True); OUT = cut_dir
    if not rid: print(f"job {job}: no result"); return None
    path, = db.execute("select file_path from asset where id=?", (rid[0],)).fetchone()
    n = int(subprocess.check_output(["ffprobe","-v","error","-count_frames","-select_streams","v:0",
                                     "-show_entries","stream=nb_read_frames","-of","csv=p=0",path]).decode().strip())
    k = 8
    ts = [round(i*(E-S)/(k-1)) for i in range(k)]            # 元カット内オフセット(フレーム)
    ins, fc = [], []
    for i,t in enumerate(ts):
        ins += ["-ss", f"{(S+t)/24:.4f}", "-i", str(REF)]
        fc.append(f"[{i}:v]trim=start_frame=0:end_frame=1,setpts=PTS-STARTPTS,scale=336:192,drawtext=text='{t}f':x=4:y=4:fontsize=18:fontcolor=yellow[o{i}]")
    for i,t in enumerate(ts):
        g = min(n-1, t)
        ins += ["-ss", f"{g/24:.4f}", "-i", path]
        fc.append(f"[{k+i}:v]trim=start_frame=0:end_frame=1,setpts=PTS-STARTPTS,scale=336:192,drawtext=text='{g}f':x=4:y=4:fontsize=18:fontcolor=cyan[g{i}]")
    fc.append("".join(f"[o{i}]" for i in range(k)) + f"hstack={k}[top]")
    fc.append("".join(f"[g{i}]" for i in range(k)) + f"hstack={k}[bot]")
    note = params.get("note","").replace("'","").replace(":","")
    fc.append(f"[top][bot]vstack=2,drawtext=text='job {job} {note}':x=6:y=h-24:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6[out]")
    out = OUT / f"cmp_{job}.jpg"
    r = subprocess.run(["ffmpeg","-y","-v","error",*ins,"-filter_complex",";".join(fc),"-map","[out]","-frames:v","1","-q:v","3",str(out)],capture_output=True,text=True)
    if r.returncode: print(r.stderr[-400:]); return None
    print(out); return out

if __name__ == "__main__":
    for j in sys.argv[1:]: sheet(int(j))
