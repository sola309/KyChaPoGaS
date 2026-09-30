#!/usr/bin/env python3
"""帰巡ef: 参照動画から Fun ControlNet 用の制御動画(depth / pose)を ComfyUI で作り、アセット登録する。
usage: ef_make_control.py <src_asset_id> depth|pose  → 出力を project 32 のアセットとして登録し id を出力"""
import asyncio, json, sys, sqlite3, urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from app.services.comfyui import ComfyUIConnector as ComfyUIClient  # type: ignore

async def main():
    src_id, kind = int(sys.argv[1]), sys.argv[2]
    db = sqlite3.connect(ROOT / "backend/data/kychapogas.db")
    src = Path(db.execute("select file_path from asset where id=?", (src_id,)).fetchone()[0])
    c = ComfyUIClient()
    name = (await c.upload_image(src)).get("name", src.name)
    wf = {
        "vid": {"class_type": "LoadVideo", "inputs": {"file": name}},
        "vc": {"class_type": "GetVideoComponents", "inputs": {"video": ["vid", 0]}},
    }
    if kind == "depth":
        wf["da3"] = {"class_type": "LoadDA3Model", "inputs": {"model_name": "depth_anything_3_mono_large.safetensors", "weight_dtype": "default"}}
        wf["inf"] = {"class_type": "DA3Inference", "inputs": {"da3_model": ["da3", 0], "image": ["vc", 0], "resolution": 504,
                                                              "resize_method": "upper_bound_resize", "mode": "mono"}}
        wf["ren"] = {"class_type": "DA3Render", "inputs": {"da3_geometry": ["inf", 0], "output": "depth",
                                                           "output.normalization": "v2_style", "output.apply_sky_clip": False}}
        last = "ren"
    elif kind == "pose":
        wf["ckpt"] = {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sdpose_wholebody_fp16.safetensors"}}
        # 人物が小さく背面の場合 SDPose 単体では骨格が出ない(実測: 209f中197fが空)。RT-DETR の人物 bbox を渡す
        wf["det"] = {"class_type": "UNETLoader", "inputs": {"unet_name": "rt_detr_v4-x-hgnet_fp16.safetensors", "weight_dtype": "default"}}
        wf["bbox"] = {"class_type": "RTDETR_detect", "inputs": {"model": ["det", 0], "image": ["vc", 0], "threshold": 0.3, "class_name": "person", "max_detections": 1}}
        wf["kp"] = {"class_type": "SDPoseKeypointExtractor", "inputs": {"model": ["ckpt", 0], "vae": ["ckpt", 2], "image": ["vc", 0], "batch_size": 16, "bboxes": ["bbox", 0]}}
        wf["ren"] = {"class_type": "SDPoseDrawKeypoints", "inputs": {"keypoints": ["kp", 0], "draw_body": True, "draw_hands": True,
                                                                     "draw_face": False, "draw_feet": True, "stick_width": 4,
                                                                     "face_point_size": 3, "score_threshold": 0.3, "draw_head": True}}
        last = "ren"
    elif kind == "canny":
        wf["ren"] = {"class_type": "Canny", "inputs": {"image": ["vc", 0], "low_threshold": 0.15, "high_threshold": 0.4}}
        last = "ren"
    elif kind == "depth_hi":
        wf["da3"] = {"class_type": "LoadDA3Model", "inputs": {"model_name": "depth_anything_3_mono_large.safetensors", "weight_dtype": "default"}}
        wf["inf"] = {"class_type": "DA3Inference", "inputs": {"da3_model": ["da3", 0], "image": ["vc", 0], "resolution": 1008,
                                                              "resize_method": "upper_bound_resize", "mode": "mono"}}
        wf["ren"] = {"class_type": "DA3Render", "inputs": {"da3_geometry": ["inf", 0], "output": "depth",
                                                           "output.normalization": "min_max", "output.apply_sky_clip": False}}
        last = "ren"
    else:
        raise SystemExit("kind must be depth|depth_hi|pose|canny")
    wf["out"] = {"class_type": "CreateVideo", "inputs": {"images": [last, 0], "fps": 24}}
    wf["save"] = {"class_type": "SaveVideo", "inputs": {"video": ["out", 0], "filename_prefix": f"video/kychapogas_ctl_{kind}",
                                                        "format": "auto", "codec": "auto"}}
    pid = await c.submit(wf)
    outs = await c.wait_for_outputs(pid, lambda p: None)
    dest = ROOT / "outputs/kijun-ef/C34"
    path = None
    for o in outs:
        fn = o.get("filename", "")
        if o.get("type") == "output" and fn.endswith((".mp4", ".webm", ".mov")):
            path = await c.download_output(fn, o.get("subfolder", ""), o.get("type", "output"), dest)
            break
    if not path:
        raise SystemExit(f"no video output: {outs}")
    newp = dest / f"ctl_{kind}_{src_id}.mp4"
    path.replace(newp)
    import subprocess
    r = subprocess.run(["curl", "-s", "-X", "POST", "http://localhost:8002/api/assets/upload", "-F", "project_id=32",
                        "-F", f"file=@{newp};filename=ctl_{kind}_C34.mp4"], capture_output=True, text=True)
    a = json.loads(r.stdout)
    print(json.dumps({"kind": kind, "file": str(newp), "asset_id": a["id"]}))

asyncio.run(main())
