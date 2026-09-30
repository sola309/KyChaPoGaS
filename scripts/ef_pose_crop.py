#!/usr/bin/env python3
"""帰巡ef C34: 少女が小さく背面のため SDPose が骨格を取れない → 暗部(黒衣・黒髪)の bbox で切り出し・拡大してから
SDPose にかけ、骨格を元座標へ貼り戻した制御動画を作る。usage: ef_pose_crop.py <src_asset_id>"""
import asyncio, json, sys, sqlite3, subprocess, numpy as np
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from app.services.comfyui import ComfyUIConnector
D = ROOT / "outputs/kijun-ef/C34"
W, H = 1890, 1080
CW, CH = 768, 1024   # SDPose のモデル入力比(3:4)

def read_frames(path, w, h, pix="rgb24"):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"scale={w}:{h}", "-pix_fmt", pix, "-f", "rawvideo", "-"], capture_output=True).stdout
    c = 3 if pix == "rgb24" else 1
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, c)

def write_video(frames, path, fps=24):
    h, w = frames.shape[1:3]
    p = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                          "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(path)], stdin=subprocess.PIPE)
    p.stdin.write(frames.tobytes()); p.stdin.close(); p.wait()

async def main():
    src_id = int(sys.argv[1])
    db = sqlite3.connect(ROOT / "backend/data/kychapogas.db")
    src = Path(db.execute("select file_path from asset where id=?", (src_id,)).fetchone()[0])
    fr = read_frames(src, W, H)
    gray = fr.mean(axis=3)
    rects = []
    for g in gray:
        m = g < 80
        m[:, :20] = m[:, -20:] = m[:20, :] = m[-20:, :] = False
        ys, xs = np.where(m)
        if len(xs) < 200:
            rects.append(None); continue
        x0, x1 = np.percentile(xs, [2, 98]); y0, y1 = np.percentile(ys, [2, 98])
        rects.append([x0, y0, x1, y1])
    # 欠損補間+時間平滑
    idx = [i for i, r in enumerate(rects) if r]
    arr = np.array([rects[i] for i in idx], dtype=np.float32)
    full = np.stack([np.interp(np.arange(len(rects)), idx, arr[:, k]) for k in range(4)], axis=1)
    k = 7
    sm = np.stack([np.convolve(np.pad(full[:, c], (k // 2, k // 2), mode="edge"), np.ones(k) / k, mode="valid") for c in range(4)], axis=1)
    crops = np.zeros((len(fr), CH, CW, 3), np.uint8); boxes = []
    for i, (x0, y0, x1, y1) in enumerate(sm):
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        bh = max((y1 - y0) * 1.35, 240); bw = bh * CW / CH
        bw = max(bw, (x1 - x0) * 1.3); bh = bw * CH / CW
        X0, Y0 = int(max(0, cx - bw / 2)), int(max(0, cy - bh / 2)); X1, Y1 = int(min(W, cx + bw / 2)), int(min(H, cy + bh / 2))
        boxes.append((X0, Y0, X1, Y1))
        crop = fr[i, Y0:Y1, X0:X1]
        r = subprocess.run(["ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{X1-X0}x{Y1-Y0}", "-i", "-", "-vf", f"scale={CW}:{CH}", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], input=crop.tobytes(), capture_output=True).stdout
        crops[i] = np.frombuffer(r, np.uint8).reshape(CH, CW, 3)
    write_video(crops, D / "pose_crops.mp4")
    if True:
      c = ComfyUIConnector()
      name = (await c.upload_image(D / "pose_crops.mp4")).get("name")
      wf = {"vid": {"class_type": "LoadVideo", "inputs": {"file": name}},
            "vc": {"class_type": "GetVideoComponents", "inputs": {"video": ["vid", 0]}},
            "ckpt": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sdpose_wholebody_fp16.safetensors"}},
            "kp": {"class_type": "SDPoseKeypointExtractor", "inputs": {"model": ["ckpt", 0], "vae": ["ckpt", 2], "image": ["vc", 0], "batch_size": 16}},
            "ren": {"class_type": "SDPoseDrawKeypoints", "inputs": {"keypoints": ["kp", 0], "draw_body": True, "draw_hands": False, "draw_face": False,
                                                                    "draw_feet": True, "stick_width": 6, "face_point_size": 3, "score_threshold": 0.25, "draw_head": True}},
            "out": {"class_type": "CreateVideo", "inputs": {"images": ["ren", 0], "fps": 24}},
            "save": {"class_type": "SaveVideo", "inputs": {"video": ["out", 0], "filename_prefix": "video/kychapogas_ctl_posecrop", "format": "auto", "codec": "auto"}}}
      pid = await c.submit(wf); outs = await c.wait_for_outputs(pid, lambda p: None)
      path = None
      for o in outs:
          if o.get("type") == "output" and o.get("filename", "").endswith((".mp4", ".webm", ".mov")):
              path = await c.download_output(o["filename"], o.get("subfolder", ""), o.get("type", "output"), D); break
    import shutil
    shutil.copy(path, D / "pose_crops_skeleton_raw.mp4")   # 生の骨格出力を保存(検証用)
    sk = read_frames(path, CW, CH)
    lit = (sk.max(axis=3) > 40).mean(axis=(1, 2)) * 100
    print("crop skeleton lit%% mean %.2f, empty frames %d/%d" % (lit.mean(), int((lit < 0.05).sum()), len(sk)))
    if lit.mean() > 25:
        raise SystemExit(f"skeleton output looks like a picture, not a pose map (lit {lit.mean():.1f}%): {path}")
    canvas = np.zeros((len(sk), H, W, 3), np.uint8)
    for i, (X0, Y0, X1, Y1) in enumerate(boxes):
        r = subprocess.run(["ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{CW}x{CH}", "-i", "-", "-vf", f"scale={X1-X0}:{Y1-Y0}", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], input=sk[i].tobytes(), capture_output=True).stdout
        canvas[i, Y0:Y1, X0:X1] = np.frombuffer(r, np.uint8).reshape(Y1 - Y0, X1 - X0, 3)
    out = D / f"ctl_pose_crop_{src_id}.mp4"
    write_video(canvas, out)
    r = subprocess.run(["curl", "-s", "-X", "POST", "http://localhost:8002/api/assets/upload", "-F", "project_id=32", "-F", f"file=@{out};filename=ctl_pose_crop_C34.mp4"], capture_output=True, text=True)
    print(json.dumps({"asset_id": json.loads(r.stdout)["id"], "file": str(out)}))

asyncio.run(main())
