"""
vlm_review — ローカルVLM(ollama/gemma4)でレンダー動画を意味レベルQAし、
問題をコメントキュー(open)に自動起票する。

analyze.py系のピクセル統計(STATIC/LONELY等)の一段上:
文字の可読性 / 画面の寂しさ / 切れ目・破綻(継ぎ目, 見切れ, 崩れ) を見る。
"""
from __future__ import annotations

import base64
import json
import logging
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

log = logging.getLogger("vlm_review")

OLLAMA = "http://localhost:11434/api/generate"
MODEL = "gemma4-26b"

PROMPT = """あなたはMAD映像のQA担当です。このフレームを審査し、JSONだけを返してください。
{"ok": true/false, "issues": ["問題があれば日本語で簡潔に(最大2件)"], "score": 0-10}
審査観点: 1) 文字があれば読めるか 2) 画面が寂しくないか(要素が少なすぎ/静止感)
3) 破綻(素材の切れ目・見切れ・輪郭の背景残り・崩れた絵)。
問題なしなら {"ok": true, "issues": [], "score": 8以上}。thinkは不要、JSONのみ。"""


def _ask(image_path: Path, timeout: int = 180) -> dict:
    b64 = base64.b64encode(image_path.read_bytes()).decode()
    req = urllib.request.Request(OLLAMA, json.dumps({
        "model": MODEL, "prompt": PROMPT, "images": [b64], "stream": False,
        "options": {"temperature": 0}, "think": False,
    }).encode(), {"Content-Type": "application/json"})
    raw = json.load(urllib.request.urlopen(req, timeout=timeout)).get("response", "")
    # gemma系のchannelマーカーや```を除去してJSON部分を拾う
    raw = raw.replace("```json", "").replace("```", "")
    s, e = raw.find("{"), raw.rfind("}")
    if s < 0 or e < 0:
        return {"ok": True, "issues": [], "score": -1}
    try:
        return json.loads(raw[s:e + 1])
    except Exception:
        return {"ok": True, "issues": [], "score": -1}


def review_video(video: Path, ffmpeg: str, n_frames: int = 12,
                 duration: float | None = None) -> list[dict]:
    """動画をn_framesサンプリングしてVLM審査。issue付きフレームのリストを返す。"""
    if duration is None:
        probe = subprocess.run([ffmpeg, "-i", str(video)], capture_output=True, text=True)
        import re
        m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", probe.stderr)
        duration = (int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])) if m else 60.0
    findings = []
    with tempfile.TemporaryDirectory(prefix="vlmqa_") as td:
        for i in range(n_frames):
            t = duration * (i + 0.5) / n_frames
            fp = Path(td) / f"f{i}.jpg"
            subprocess.run([ffmpeg, "-y", "-ss", f"{t:.2f}", "-i", str(video),
                            "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "4", str(fp)],
                           capture_output=True)
            if not fp.exists():
                continue
            t0 = time.time()
            v = _ask(fp)
            log.info(f"vlm_review t={t:.1f}s score={v.get('score')} "
                     f"issues={v.get('issues')} ({time.time()-t0:.0f}s)")
            if v.get("issues"):
                findings.append({"t_sec": round(t, 2), "issues": v["issues"][:2],
                                 "score": v.get("score", -1)})
    return findings


def file_comments(project_id: int, findings: list[dict], source: str) -> int:
    """findings をコメントキューに起票(author=vlm-qa, status=open)。"""
    from app.routers.comments import _load, _append
    existing = _load(project_id)
    next_id = (max(existing) + 1) if existing else 1
    n = 0
    for f in findings:
        for issue in f["issues"]:
            _append(project_id, {
                "id": next_id, "t_sec": f["t_sec"],
                "text": f"[自動QA/{source}] {issue} (score {f.get('score')})",
                "shot_id": None, "object_path": None,
                "author": "vlm-qa", "status": "open",
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            })
            next_id += 1
            n += 1
    return n
