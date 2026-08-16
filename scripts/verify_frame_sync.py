#!/usr/bin/env python3
"""タイムラインと書き出しのフレーム一致を検証する(回帰テスト)。

素材24fps・タイムライン30fps のように fps が食い違うと、書き出しだけカット位置が
1フレームずれることがある。ズレは音合わせに直結するので、レンダラを触ったら必ずこれを通す。

やること:
  1. 各フレームに「フレーム番号」を白黒ブロックで焼き込んだ 24fps 素材を作る
  2. 30fps のテストプロジェクトへ、尺と in点 を変えた5クリップとして並べる
  3. 実際に書き出し、出力の各フレームがどの素材フレームを映しているかを読み取る
  4. プレビューの規則(その時刻を含む素材フレーム)と全フレームで突き合わせる

  python3 scripts/verify_frame_sync.py [--api http://localhost:8002/api]

全フレーム一致で exit 0、1つでもズレたら exit 1。
"""
import argparse, json, math, os, subprocess, sys, tempfile, time, urllib.request
from collections import Counter

W, H = 320, 180
SRC_FPS, FPS = 24, 30
# (開始フレーム, 尺, in点) — 24fpsで割り切れる尺/割り切れない尺/in点ありを混ぜる
PLAN = [(0, 130, 0), (130, 83, 0), (213, 84, 0), (297, 35, 13), (332, 46, 59)]


def api(base, method, path, body=None):
    r = urllib.request.Request(base + path, method=method,
                               data=json.dumps(body).encode() if body is not None else None,
                               headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(r).read() or "null")


def make_source(tmp):
    """各フレームが自分の番号を8bitの白黒ブロックで示す 24fps 素材"""
    d = os.path.join(tmp, "f")
    os.makedirs(d, exist_ok=True)
    for i in range(200):
        boxes = ",".join(
            f"drawbox=x={b*40}:y=60:w=40:h=60:color={'white' if (i >> b) & 1 else 'black'}:t=fill"
            for b in range(8))
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
                        "-i", f"color=c=gray:s={W}x{H}", "-vf", boxes,
                        "-frames:v", "1", f"{d}/{i:04d}.png"], check=True)
    out = os.path.join(tmp, "src24.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-framerate", str(SRC_FPS),
                    "-i", f"{d}/%04d.png", "-c:v", "libx264", "-qp", "0",
                    "-pix_fmt", "yuv420p", out], check=True)
    return out


def upload(base, pid, path):
    import uuid
    b = uuid.uuid4().hex
    body = f"--{b}\r\nContent-Disposition: form-data; name=\"project_id\"\r\n\r\n{pid}\r\n".encode()
    body += (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; "
             f"filename=\"{os.path.basename(path)}\"\r\nContent-Type: video/mp4\r\n\r\n").encode()
    body += open(path, "rb").read() + b"\r\n" + f"--{b}--\r\n".encode()
    r = urllib.request.Request(base + "/assets/upload", data=body, method="POST",
                               headers={"Content-Type": f"multipart/form-data; boundary={b}"})
    return json.loads(urllib.request.urlopen(r).read())


def decode(render):
    """出力の各フレームが映している素材フレーム番号"""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", render,
                          "-vf", f"crop={W}:2:0:90,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True).stdout
    stride = W * 2
    return [sum((1 << b) for b in range(8) if raw[i * stride + 20 + 40 * b] > 110)
            for i in range(len(raw) // stride)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8002/api")
    a = ap.parse_args()
    base = a.api.rstrip("/")

    with tempfile.TemporaryDirectory() as tmp:
        print("素材を作成中…")
        src = make_source(tmp)
        pj = api(base, "POST", "/projects/",
                 {"name": "__frame_sync_check", "width": W, "height": H, "fps": FPS})
        pid = pj["id"]
        try:
            asset = upload(base, pid, src)
            tr = api(base, "POST", "/tracks/",
                     {"project_id": pid, "name": "Shots", "track_type": "video", "order": 0})
            for s, n, inf in PLAN:
                c = api(base, "POST", "/clips/",
                        {"project_id": pid, "track_id": tr["id"], "asset_id": asset["id"],
                         "start_frame": s, "duration_frames": n})
                if inf:
                    api(base, "PATCH", f"/clips/{c['id']}", {"asset_in_frame": inf})
            job = api(base, "POST", "/jobs/",
                      {"project_id": pid, "job_type": "render_final",
                       "params": {"project_id": pid, "width": W, "height": H,
                                  "fps": FPS, "encoder": "x264"}})
            print(f"書き出し job {job['id']} …")
            for _ in range(240):
                st = api(base, "GET", f"/jobs/{job['id']}")["status"]
                if st in ("completed", "failed", "cancelled"):
                    break
                time.sleep(3)
            if st != "completed":
                print(f"NG: 書き出しが {st}"); return 1
            render = next(f for f in
                          [f"backend/data/exports/{pid}/{job['id']}.mp4",
                           os.path.join(os.path.dirname(__file__), "..",
                                        f"backend/data/exports/{pid}/{job['id']}.mp4")]
                          if os.path.exists(f))
            ren = decode(render)
        finally:
            try: api(base, "DELETE", f"/projects/{pid}")
            except Exception: pass

    total = sum(n for _, n, _ in PLAN)
    ok = len(ren) == total
    print(f"\n総フレーム: 期待 {total} / 実際 {len(ren)} {'○' if ok else '✗'}")
    for s, n, inf in PLAN:
        devs = [ren[s + r] - math.floor((inf + r) / FPS * SRC_FPS + 1e-9)
                for r in range(n) if s + r < len(ren)]
        good = set(devs) == {0}
        ok &= good
        print(f"  f{s:<5}({n:>3}f, in={inf:>2}): ずれ分布 {dict(sorted(Counter(devs).items()))}"
              f" {'○' if good else '✗'}")
    print("\n★ 全フレーム一致" if ok else "\n✗ ズレあり — レンダラの切り出し/合成を確認すること")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
