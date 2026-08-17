#!/usr/bin/env python3
"""採用済み素材をアニメ用GANモデルで拡大し、書き出し用の高解像度版として登録する。

なぜ必要か: H3 は面積上限 1,032,192px(=1344x768) までしか生成できない。2160p 納品では
素材を約5倍(面積)に拡大することになり、従来の lanczos では線がなまり平坦部が濁る。
アニメ専用に学習された GAN 系モデルは決定論的な関数なので、同じ入力には常に同じ出力を返す
= フレーム間のちらつきが原理的に起きない。拡散系(SeedVR2/SUPIR)は実写学習でアニメの
絵柄が崩れるうえ毎フレーム別ノイズを引くため、この用途では使わない。

方針:
  ・素材段階で **一度だけ** 拡大する(合成の各段で拡大を繰り返さない)
  ・元素材は残し、拡大版を別アセットとして登録する。プレビュー/テイク履歴は軽い元のまま
  ・レンダラは書き出し時にだけ拡大版を自動採用する(ffmpeg_render の _upscaled_map)

  python3 scripts/upscale_assets.py --project 29            # 採用済みの映像素材すべて
  python3 scripts/upscale_assets.py --project 29 --dry-run  # 対象と見積りだけ
"""
import argparse, json, os, subprocess, sys, time, urllib.request, uuid
from pathlib import Path

API = "http://localhost:8002/api"
REPO = Path(__file__).resolve().parent.parent
MODEL = REPO / "tools/comfyui/models/upscale_models/realesr-animevideov3.pth"
OUT_DIR = REPO / "backend/data/generated"
TAG = "upscale_of"          # 拡大版アセットの gen_params_json に入れる目印


def get(path):
    return json.load(urllib.request.urlopen(API + path))


def probe(path):
    o = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,r_frame_rate,nb_frames", "-of", "csv=p=0", path],
                       capture_output=True, text=True).stdout.strip().split(",")
    from fractions import Fraction
    n = int(o[3]) if len(o) > 3 and o[3].isdigit() else 0
    return int(o[0]), int(o[1]), float(Fraction(o[2])), n


def targets(project_id):
    """タイムラインの映像トラックで実際に使われている素材(=採用分)"""
    tracks = {t["id"]: t for t in get(f"/tracks/?project_id={project_id}")}
    clips = get(f"/clips/?project_id={project_id}")
    assets = {a["id"]: a for a in get(f"/assets/?project_id={project_id}")}
    done = {json.loads(a["gen_params_json"]).get(TAG)
            for a in assets.values() if a.get("gen_params_json") and TAG in a["gen_params_json"]}
    out = {}
    for c in clips:
        t = tracks.get(c["track_id"])
        if not t or t["track_type"] != "video" or not c["asset_id"]:
            continue
        a = assets.get(c["asset_id"])
        if not a or a["id"] in done:
            continue
        if a.get("duration_sec") is None:            # 静止画は対象外
            continue
        if not Path(a["file_path"]).exists():
            continue
        # 参照用トラック(比較表示のための元ネタ)は納品に出ないので拡大しない
        if t["name"] in ("Video", "Video 1"):
            continue
        out[a["id"]] = a
    return out


def upscale(src, dst, model, scale, out_w, out_h, fps):
    """1フレームずつGANに通し、最後に目標解像度へ整える(縮小はlanczos)"""
    import numpy as np, torch
    W, H, _, _ = probe(src)
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", src,
                            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    # GAN後のサイズ(W*scale x H*scale)から目標へ。拡大でも縮小でも lanczos で一度だけ。
    enc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{W*scale}x{H*scale}", "-r", f"{fps:.6f}", "-i", "-",
         "-vf", (f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase:flags=lanczos,"
                 f"crop={out_w}:{out_h}"),      # レンダラと同じ cover。画角を変えない
         "-c:v", "libx264", "-crf", "12", "-preset", "medium", "-pix_fmt", "yuv420p",
         str(dst)], stdin=subprocess.PIPE)
    n = 0
    with torch.no_grad():
        while True:
            raw = dec.stdout.read(W * H * 3)
            if len(raw) < W * H * 3:
                break
            x = torch.from_numpy(np.frombuffer(raw, np.uint8).copy()).view(H, W, 3)
            x = x.permute(2, 0, 1).unsqueeze(0).float().div(255).cuda()
            y = model(x).clamp(0, 1).squeeze(0).permute(1, 2, 0).mul(255).byte().cpu().numpy()
            enc.stdin.write(y.tobytes())
            n += 1
    enc.stdin.close(); enc.wait(); dec.stdout.close(); dec.wait()
    return n


def register(project_id, path, origin, w, h, dur):
    """拡大版をアセット登録し、元素材との対応を gen_params_json に残す"""
    b = uuid.uuid4().hex
    body = f"--{b}\r\nContent-Disposition: form-data; name=\"project_id\"\r\n\r\n{project_id}\r\n".encode()
    body += (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; "
             f"filename=\"{path.name}\"\r\nContent-Type: video/mp4\r\n\r\n").encode()
    body += path.read_bytes() + b"\r\n" + f"--{b}--\r\n".encode()
    r = urllib.request.Request(API + "/assets/upload", data=body, method="POST",
                               headers={"Content-Type": f"multipart/form-data; boundary={b}"})
    a = json.loads(urllib.request.urlopen(r).read())
    # アセット更新APIが無いので、対応は **ファイル名の規約** で表す。
    # レンダラ側(ffmpeg_render の upscaled マップ)は up_<元ID>_ を読んで元素材に結び付ける。
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", type=int, required=True)
    ap.add_argument("--height", type=int, default=2160, help="目標の縦解像度(既定2160)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    tg = targets(a.project)
    print(f"対象 {len(tg)}件 (採用済み・未処理の映像素材)")
    tot_f = 0
    for x in tg.values():
        W, H, fps, n = probe(x["file_path"])
        n = n or int((x.get("duration_sec") or 0) * fps)
        tot_f += n
        if a.dry_run:
            print(f"  {x['name']:<22} {W}x{H} {n}f")
    if a.dry_run:
        print(f"\n合計 {tot_f} フレーム / 実測4.5fps → 約{tot_f/4.5/60:.0f}分")
        return 0
    if not MODEL.exists():
        print(f"モデルが無い: {MODEL}"); return 1

    from spandrel import ModelLoader
    model = ModelLoader().load_from_file(str(MODEL)).cuda().eval()
    scale = model.scale
    print(f"モデル {MODEL.name} (x{scale})  目標 {a.height}p")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    for i, x in enumerate(tg.values(), 1):
        W, H, fps, _ = probe(x["file_path"])
        out_h = a.height
        out_w = int(round(out_h * 16 / 9 / 2) * 2)          # 2160p → 3840x2160
        # ファイル名が対応表を兼ねる: up_<元アセットID>_<元の名前>.mp4
        dst = OUT_DIR / str(a.project) / f"up_{x['id']}_{Path(x['name']).stem}.mp4"
        dst.parent.mkdir(parents=True, exist_ok=True)
        print(f"[{i}/{len(tg)}] {x['name']} {W}x{H} → {out_w}x{out_h}", flush=True)
        n = upscale(x["file_path"], dst, model, scale, out_w, out_h, fps)
        na = register(a.project, dst, x, out_w, out_h, x.get("duration_sec"))
        print(f"    {n}f → asset {na['id']}  {dst.stat().st_size/1e6:.1f}MB", flush=True)
    print(f"\n完了 {len(tg)}件 / {time.time()-t0:.0f}秒")
    return 0


if __name__ == "__main__":
    sys.exit(main())
