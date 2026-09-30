#!/usr/bin/env python3
"""帰巡ef C34 夜間バッチ(note に 'v6' を含む本番)の朝レポート: 比較シート + 全フレームカメラ指標 + VLM髪チェック。
usage: ef_c34_morning.py [note_substring]  → outputs/kijun-ef/C34/report_v6.md, cmp_v6_all.jpg"""
import json, sqlite3, subprocess, sys, base64, urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from ef_cmp_sheet import sheet
from ef_camera_diff import analyze, plot
D = ROOT / "outputs/kijun-ef/C34"
key = sys.argv[1] if len(sys.argv) > 1 else "v6"
db = sqlite3.connect(ROOT / "backend/data/kychapogas.db")
rows = db.execute("select j.id, j.status, json_extract(j.params,'$.note'), json_extract(j.params,'$.seed'), a.file_path, a.id "
                  "from job j left join asset a on a.id=json_extract(j.result_asset_ids,'$[0]') "
                  "where json_extract(j.params,'$.note') like ? order by j.id", (f"%{key}%",)).fetchall()
def vlm(path):
    img = base64.b64encode(open(path, "rb").read()).decode()
    p = ("Top row = original anime shot (camera orbits a spiral staircase, a girl walks down). Bottom row = AI regeneration with Ultimate Madoka whose endless pink hair should already be fully extended from the first frame and spread in ALL directions (fan-like, leaving several frame edges). "
         "Answer in Japanese, one line each with 1-5: 髪の広がり(四方に・最初から伸び切っているか) / 髪が途中で伸びて見えないか / 人物置換(白ドレス・翼) / 階段を降りる姿勢 / 破綻. 総評1文.")
    body = {"model": "gemma4-26b:latest", "prompt": p, "images": [img], "stream": False, "think": False, "options": {"temperature": 0.1, "num_predict": 400}}
    r = urllib.request.Request("http://127.0.0.1:11434/api/generate", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=900))["response"].replace("<|channel>thought\n<channel|>", "").strip()
lines = [f"# C34 夜間バッチ({key}) レポート", "", "| job | seed | status | cam mean | cam last1/3 | traj x/y |", "|---|---|---|---|---|---|"]
details = []; sheets = []
for jid, st, note, seed, path, aid in rows:
    if st != "completed" or not path:
        lines.append(f"| {jid} | {seed} | {st} | | | |"); continue
    res, per, rc, gc = analyze(path, label=(note or "")[:40]); plot(jid, res, per, rc, gc)
    out = D / f"cmp_{jid}.jpg"
    if not out.exists(): sheet(jid)
    sheets.append(out)
    lines.append(f"| {jid} | {seed} | #{aid} | {res['lowfreq_ncc_mean']:.2f} | {res['lowfreq_ncc_last_third']:.2f} | {res['traj_corr_x']:.2f}/{res['traj_corr_y']:.2f} |")
    try: v = vlm(out)
    except Exception as e: v = f"(VLM失敗 {e})"
    details.append(f"## job {jid} seed {seed} (#{aid})\n{v}\n")
lines += ["", "参考: #3909(採用中) cam mean 0.50 / last1/3 0.79", ""] + details
(D / "report_v6.md").write_text("\n".join(lines))
if sheets:
    ins = []; [ins.extend(["-i", str(s)]) for s in sheets]
    subprocess.run(["ffmpeg", "-y", "-v", "error", *ins, "-filter_complex", "".join(f"[{i}]" for i in range(len(sheets))) + f"vstack={len(sheets)}", "-q:v", "3", str(D / "cmp_v6_all.jpg")] if len(sheets) > 1 else ["cp", str(sheets[0]), str(D / "cmp_v6_all.jpg")])
print("\n".join(lines))
