#!/usr/bin/env python3
"""Build one overlay-heavy MAD end-to-end to exercise the improved render pipeline:
music (ACE-Step) → beat analysis → 3 bg images (SDXL) → lyric telop (MG) →
timeline with MANY overlay clips (telop + light FX + ~16 beat flashes) → render.
Pure stdlib. Writes progress to stdout; final mp4 → /tmp/madtest/output.mp4."""
import json, time, urllib.request, urllib.parse, mimetypes, os, sys

API = "http://127.0.0.1:8002"
FPS = 30; DUR = 24; TOTAL = DUR * FPS


def _req(path, data=None, method=None):
    url = API + path
    if data is not None:
        body = json.dumps(data).encode()
        r = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"},
                                   method=method or "POST")
    else:
        r = urllib.request.Request(url, method=method or "GET")
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.load(resp)


def upload(project_id, filepath):
    boundary = "----madboundary7531"
    fn = os.path.basename(filepath)
    ctype = mimetypes.guess_type(fn)[0] or "application/octet-stream"
    body = bytearray()
    def add(name, val):
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{val}\r\n'.encode())
    add("project_id", str(project_id))
    body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{fn}"\r\nContent-Type: {ctype}\r\n\r\n'.encode())
    body.extend(open(filepath, "rb").read()); body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode())
    r = urllib.request.Request(API + "/api/assets/upload", data=bytes(body),
                               headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.load(resp)["id"]


def poll(job_id, label, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(3)
        j = _req(f"/api/jobs/{job_id}")
        if j["status"] == "completed":
            aids = j.get("result_asset_ids") or []
            print(f"  [{label}] done in {time.time()-t0:.0f}s asset={aids}", flush=True)
            return aids[0] if aids else None
        if j["status"] in ("failed", "cancelled"):
            raise RuntimeError(f"{label} {j['status']}: {j.get('error')}")
        print(f"  [{label}] {j['status']} {int((j.get('progress') or 0)*100)}%", flush=True)
    raise TimeoutError(f"{label} timed out")


def clip(track_id, asset_id, start, dur, opacity=1.0, blend="normal", transform="", ain=0):
    return _req("/api/clips/", {
        "track_id": track_id, "asset_id": asset_id, "start_frame": int(start),
        "duration_frames": int(dur), "asset_in_frame": int(ain),
        "opacity": opacity, "blend": blend, "transform_json": transform})


LYRICS = """[verse]
Neon lights are calling out my name
[chorus]
Run with me tonight, we'll never be the same
Hold the light, dancing through the rain"""

IMG_PROMPTS = [
    "anime night cityscape, neon lights, cinematic, vibrant colors, wide shot, masterpiece",
    "anime girl silhouette running, dynamic pose, sunset sky, motion, masterpiece, best quality",
    "anime fireworks over a city at night, festival, colorful, wide angle, masterpiece",
]


def main():
    print("=== MAD build start ===", flush=True)
    proj = _req("/api/projects/", {"name": "音MADテスト（検証）", "width": 1920, "height": 1080, "fps": 30})
    pid = proj["id"]; print("project", pid, flush=True)

    flash_a = upload(pid, "/tmp/madtest/flash.png")
    streak_a = upload(pid, "/tmp/madtest/streak.png")
    sparkle_a = upload(pid, "/tmp/madtest/sparkle.png")
    print("uploaded fx assets", flash_a, streak_a, sparkle_a, flush=True)

    print("-- music --", flush=True)
    mj = _req("/api/generation/audio", {"project_id": pid,
              "prompt": "upbeat j-pop, energetic, female vocal, bright synths, 120 bpm",
              "lyrics": LYRICS, "duration_sec": DUR, "vocal_language": "en"})
    music_a = poll(mj["id"], "music", 600)

    print("-- analyze beats --", flush=True)
    aj = _req(f"/api/analysis/audio/{music_a}", {})
    poll(aj["job_id"], "analyze", 300)

    print("-- bg images --", flush=True)
    img_assets = []
    for i, pr in enumerate(IMG_PROMPTS):
        ij = _req("/api/generation/image", {"project_id": pid, "prompt": pr,
                  "model": "waiIllustrious", "width": 1344, "height": 768})
        img_assets.append(poll(ij["id"], f"img{i+1}", 300))

    print("-- lyric telop (MG) --", flush=True)
    tj = _req("/api/jobs/", {"project_id": pid, "job_type": "render_motion_graphics",
              "params": {"project_id": pid, "template": "lyric_motion", "transparent": True,
                         "duration_sec": DUR, "fps": FPS, "lyrics": LYRICS, "style": "pop", "offset_sec": 0}})
    telop_a = poll(tj["id"], "telop", 900)

    print("-- tracks --", flush=True)
    ta = _req("/api/tracks/", {"project_id": pid, "name": "音声", "track_type": "audio", "order": 0})["id"]
    tv = _req("/api/tracks/", {"project_id": pid, "name": "背景", "track_type": "video", "order": 0})["id"]
    tfx = _req("/api/tracks/", {"project_id": pid, "name": "FX", "track_type": "video", "order": 1})["id"]
    ttx = _req("/api/tracks/", {"project_id": pid, "name": "テロップ", "track_type": "video", "order": 2})["id"]

    print("-- clips --", flush=True)
    clip(ta, music_a, 0, TOTAL)
    transforms = ["kenburns_in", "pan_lr", "kenburns_out"]
    seg = TOTAL // 3
    for i, ia in enumerate(img_assets):
        if ia:
            clip(tv, ia, i * seg, seg if i < 2 else TOTAL - 2 * seg, transform=transforms[i])
    # FX overlays (order1)
    clip(tfx, streak_a, 0, TOTAL, opacity=0.30, blend="screen")
    clip(tfx, sparkle_a, 0, TOTAL, opacity=0.45, blend="normal")
    n_flash = 0
    f = 36
    while f < TOTAL - 8:
        clip(tfx, flash_a, f, 7, opacity=0.6, blend="screen")
        n_flash += 1; f += 42
    # telop on top (order2)
    clip(ttx, telop_a, 0, TOTAL, opacity=1.0, blend="normal")
    overlay_count = 2 + n_flash + 1
    print(f"  overlay clips: {overlay_count} (telop + streak + sparkle + {n_flash} flashes)", flush=True)

    print("-- render final --", flush=True)
    rj = _req("/api/jobs/", {"project_id": pid, "job_type": "render_final", "params": {}})
    poll(rj["id"], "render", 1200)
    # download
    out = "/tmp/madtest/output.mp4"
    with urllib.request.urlopen(API + f"/api/jobs/{rj['id']}/download", timeout=120) as resp:
        open(out, "wb").write(resp.read())
    print(f"=== DONE project={pid} overlays={overlay_count} → {out} ({os.path.getsize(out)//1024}KB) ===", flush=True)


if __name__ == "__main__":
    main()
