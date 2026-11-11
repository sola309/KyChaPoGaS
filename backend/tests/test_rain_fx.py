"""🌧 雨フィルター(app/services/rain_fx.py・app/routers/rain.py)のテスト。CPU のみ・一時 SQLite。

  python -m pytest -p no:cacheprovider backend/tests/test_rain_fx.py

- 数式: rain_layer.py(outputs/pocky2026/v13/fix1013/night/rain_layer.py 10/14 版)の計算部分を下に
  そのまま書き写した reference_composite と、rain_fx.RainLayer の重ねた結果がビット単位で一致すること。
- ジョブと API: 雨クリップを作る → 作り直す → テイク一覧 → 戻す。ロック・重複・動いたクリップ・取消。
- 書き出し: ffmpeg_render.render_timeline の結果が、プレビューの式 screen(下の絵, 層 × 不透明度) と一致すること。
"""
import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.services import rain_fx

FF = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FF is None, reason="ffmpeg がない")


# ── rain_layer.py の計算部分(書き写し。変えない) ────────────────────────────────

def reference_composite(src_bgr, tgt, opt):
    """rain_layer.py の本体と同じ計算(decode と書き出しを除く)。src_bgr は N+10 コマ、tgt は N コマ。"""
    BLUR = float(opt.get('blur', 0.6)); LIT = float(opt.get('lit', 0)); GLOW = float(opt.get('glow', 0)); TW = float(opt.get('twinkle', 0))
    GLINT = float(opt.get('glint', 0)); CUT = int(opt.get('cut', 0)); BLUR2 = float(opt.get('blur2', BLUR))
    K = float(opt.get('k', 0.8)); L = int(opt.get('L', 9)); T0 = float(opt.get('t0', 3)); T1 = float(opt.get('t1', 14))
    N = len(tgt)
    src = src_bgr
    gray = np.stack([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in src]).astype(np.float32)
    vline = cv2.getStructuringElement(cv2.MORPH_RECT, (1, L))
    blob = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    HMAX = int(opt.get('hmax', 90)); WMAX = int(opt.get('wmax', 5))
    hdil = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 3))

    def thin_at(i):
        bg = np.median(gray[max(0, i - 3):i + 4], axis=0)
        r = np.clip(gray[i] - bg, 0, 255)
        return np.clip(cv2.morphologyEx(r, cv2.MORPH_OPEN, vline) - cv2.morphologyEx(r, cv2.MORPH_OPEN, blob), 0, 255)

    def layer(k):
        i = k + 5
        t = thin_at(i)
        D_ = int(opt.get('gap', 1))
        nb = np.maximum(cv2.dilate(thin_at(i - D_), hdil), cv2.dilate(thin_at(i + D_), hdil))
        t = np.clip(t - nb, 0, 255)
        al = np.clip((t - T0) / (T1 - T0), 0, 1)
        n, lab_, st, _ = cv2.connectedComponentsWithStats((al > 0.25).astype(np.uint8), 8)
        bad = np.zeros(n, bool); bad[1:] = (st[1:, cv2.CC_STAT_HEIGHT] > HMAX) | (st[1:, cv2.CC_STAT_WIDTH] > WMAX) | (st[1:, cv2.CC_STAT_HEIGHT] < 6)
        m = cv2.dilate((~bad[lab_]).astype(np.uint8) * (lab_ > 0), np.ones((3, 3), np.uint8)).astype(np.float32)
        if TW:
            rng = np.random.default_rng(1000 + k); f = 1 + TW * (2 * rng.random(n) - 1); f[0] = 0
            m = m * cv2.dilate(f[lab_].astype(np.float32), np.ones((3, 3), np.uint8))
        out = al * m
        if GLINT:
            rng = np.random.default_rng(2000 + k); gl = np.zeros_like(out)
            for c in np.where(~bad)[0][1:]:
                if rng.random() < 0.5:
                    x = st[c, cv2.CC_STAT_LEFT] + st[c, cv2.CC_STAT_WIDTH] // 2; y = st[c, cv2.CC_STAT_TOP] + st[c, cv2.CC_STAT_HEIGHT] - 1
                    gl[y, x] = 1.0
            gl = cv2.GaussianBlur(gl, (0, 0), 1.3); gl = gl / max(gl.max(), 1e-6) * GLINT if gl.max() > 0 else gl
            out = np.maximum(out, gl)
        return out

    out = []
    for k in range(N):
        al = layer(k)
        al = cv2.GaussianBlur(al, (0, 0), BLUR2 if CUT and k >= CUT else BLUR)
        g = tgt[k].astype(np.float32) / 255
        if LIT:
            lm = cv2.GaussianBlur(cv2.cvtColor(tgt[k], cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 30)
            lm = np.clip((lm - np.percentile(lm, 5)) / max(np.percentile(lm, 99.5) - np.percentile(lm, 5), 1), 0, 1)
            al = al * ((1 - LIT) + LIT * 1.6 * lm)
        if GLOW:
            al = al + GLOW * cv2.GaussianBlur(al, (0, 0), 3.5)
        al = np.clip(al, 0, 1.0 / max(K, 1e-3))
        rain = np.clip(g * 0.35 + 0.72, 0, 1)
        a3 = (al * K)[..., None]
        o = 1 - (1 - g) * (1 - rain * a3)
        out.append(np.clip(o * 255, 0, 255).astype(np.uint8))
    return out


# ── 合成データ(元動画風: 動く細い縦の雨筋 + 動く太いかたまり + ゆっくり動く柱 + 粒子) ──

def synth_source(n, w=320, h=192, seed=0):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    base = (40 + 60 * xx / w + 30 * yy / h).astype(np.float32)
    frames = []
    for f in range(n):
        im = base.copy()
        im += rng.normal(0, 1.2, im.shape)
        for _ in range(28):                         # 雨筋: 1 コマごとに別の場所、細く縦長、明るさ・長さふぞろい
            x = int(rng.integers(2, w - 3)); y = int(rng.integers(0, h - 40)); ln = int(rng.integers(8, 70))
            wd = int(rng.integers(1, 3)); v = float(rng.uniform(8, 45))
            im[y:y + ln, x:x + wd] += v
        cx = 40 + 3 * f                             # 太いかたまり(髪・傘のような動き)
        im[60:110, cx:cx + 30] += 50
        px = 200 + f // 3                           # ゆっくり動く柱の縁
        im[:, px:px + 2] += 30
        frames.append(np.clip(im, 0, 255).astype(np.uint8))
    return [cv2.cvtColor(f, cv2.COLOR_GRAY2BGR) for f in frames]


def synth_target(n, w=320, h=192, seed=1):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    out = []
    for f in range(n):
        b = (20 + 80 * xx / w + f).astype(np.float32); g = (30 + 50 * yy / h).astype(np.float32)
        r = (60 + 40 * np.sin(xx / 17.0 + f / 5.0)).astype(np.float32)
        im = np.stack([b, g, r], -1)
        im[50:90, 100:180] += 140                   # 明かり(lit で筋が明るくなる場所)
        im += rng.normal(0, 2, im.shape)
        out.append(np.clip(im, 0, 255).astype(np.uint8))
    return out


OPTION_SETS = [
    {},                                                                        # 既定(k 0.8)
    {"t0": 2, "t1": 9, "k": 0.55, "blur": 1.5},                                # C23_24
    {"gap": 2, "blur": 1.0},                                                   # C25_26
    {"blur": 1.4, "lit": 0.7, "glow": 0.9, "twinkle": 0.5, "k": 1.15, "glint": 0.9, "cut": 7, "blur2": 2.2},   # C27_28(cut を手前に)
    {"t0": 3, "t1": 11, "k": 0.35, "blur": 1.7, "wmax": 3, "hmax": 40, "L": 7, "gap": 3},                       # 控えめ案
]


@pytest.mark.parametrize("opt", OPTION_SETS)
def test_math_matches_rain_layer_py(opt):
    N = 14
    src = synth_source(N + 10); tgt = synth_target(N)
    ref = reference_composite(src, tgt, opt)
    s = rain_fx.normalize({**opt, "k": opt.get("k", 0.8)})
    ex = rain_fx.RainLayer([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in src], s)
    for k in range(N):
        al = ex.alpha(k, tgt[k])
        g = tgt[k].astype(np.float32) / 255
        rain = np.clip(g * 0.35 + 0.72, 0, 1)
        o = np.clip((1 - (1 - g) * (1 - rain * (al * ex.K)[..., None])) * 255, 0, 255).astype(np.uint8)
        assert np.array_equal(o, ref[k]), f"frame {k} differs"
        # 8bit の層を screen で重ねても 1 段以内
        lay, _ = ex_frame(ex, k, tgt[k])
        assert np.abs(rain_fx.screen_u8(tgt[k], lay).astype(int) - ref[k].astype(int)).max() <= 1


def ex_frame(ex, k, tgt):
    al = ex.alpha(k, tgt)   # alpha と frame は同じ計算(キャッシュ済みの thin を使う)
    g = tgt.astype(np.float32) / 255
    rain = np.clip(g * 0.35 + 0.72, 0, 1)
    return np.clip(rain * (al * ex.K)[..., None] * 255 + 0.5, 0, 255).astype(np.uint8), 0.0


def test_rain_is_from_source_and_varies_per_frame():
    """雨はそのカットの元動画から取る: 元の雨筋の場所にだけ出て、コマごとに違う(使い回し・一様ではない)。"""
    N = 10
    src = synth_source(N + 10); tgt = synth_target(N)
    s = rain_fx.normalize({})
    ex = rain_fx.RainLayer([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in src], s)
    lays = [ex.frame(k, tgt[k])[0].max(axis=2) for k in range(N)]
    assert all(l_.max() > 100 for l_ in lays)
    for a, b in zip(lays, lays[1:]):
        inter = ((a > 30) & (b > 30)).sum(); union = ((a > 30) | (b > 30)).sum()
        assert inter / max(union, 1) < 0.3            # 次のコマとは別の筋
    # 太いかたまり(60:110, cx:cx+30)は出ない
    assert lays[3][62:108, 40 + 9 + 3:40 + 9 + 27].max() < 30


def test_scale_by_opacity_equals_lower_k_when_unsaturated():
    """不透明度 a は「層を a 倍する」のと同じ(雨が頭打ちにならない設定なら k=a で作った層と同じ)。"""
    N = 6
    src = synth_source(N + 10); tgt = synth_target(N)
    g = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in src]
    e1 = rain_fx.RainLayer(g, rain_fx.normalize({"k": 1.0, "t0": 2, "t1": 9, "blur": 1.5}))
    e2 = rain_fx.RainLayer(g, rain_fx.normalize({"k": 0.55, "t0": 2, "t1": 9, "blur": 1.5}))
    for k in range(N):
        a = rain_fx.screen_u8(tgt[k], e1.frame(k, tgt[k])[0], 0.55).astype(int)
        b = rain_fx.screen_u8(tgt[k], e2.frame(k, tgt[k])[0], 1.0).astype(int)
        assert np.abs(a - b).max() <= 1


def test_median7_matches_numpy():
    rng = np.random.default_rng(3)
    for _ in range(50):
        fr = [rng.integers(0, 256, (9, 13), dtype=np.uint8) for _ in range(7)]
        assert np.array_equal(rain_fx.median7_u8(fr).astype(np.float32), np.median(np.stack(fr).astype(np.float32), axis=0))


def test_normalize():
    d = rain_fx.normalize({})
    assert d["k"] == 1.0 and d["L"] == 9 and d["t0"] == 3.0 and d["t1"] == 14.0 and d["blur2"] is None
    d = rain_fx.normalize({"wmax": "3", "hmax": 99999, "gap": 0, "t0": 10, "t1": 4, "evil": 1, "blur": float("nan"),
                           "src_asset_id": "12", "src_offset": -3})
    assert d["wmax"] == 3 and d["hmax"] == 3000 and d["gap"] == 1 and d["t1"] == 10.5 and "evil" not in d
    assert d["blur"] == 0.6 and d["src_asset_id"] == 12 and d["src_offset"] == -3
    assert rain_fx.normalize({"blur": 2}, base={"blur": 1, "lit": 0.4}) == rain_fx.normalize({"blur": 2, "lit": 0.4})


def test_clamp_opacity():
    """強さ(不透明度)0 は使わない: 書き出しは不透明度 0 を 1.0 として扱う(`opacity or 1.0`)ので、
    プレビューは雨なし・書き出しは雨 100% と食い違う。下限 1%。"""
    assert rain_fx.clamp_opacity(0) == 0.01 and rain_fx.clamp_opacity(-1) == 0.01
    assert rain_fx.clamp_opacity(None) == 1.0 and rain_fx.clamp_opacity("x") == 1.0
    assert rain_fx.clamp_opacity(float("nan")) == 1.0 and rain_fx.clamp_opacity(3) == 1.0
    assert rain_fx.clamp_opacity(0.55) == 0.55 and rain_fx.clamp_opacity("0.8") == 0.8


def test_zero_blur_does_not_crash():
    N = 3
    src = synth_source(N + 10); tgt = synth_target(N)
    ex = rain_fx.RainLayer([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in src], rain_fx.normalize({"blur": 0, "glow": 0.5}))
    lay, cov = ex.frame(0, tgt[0])
    assert lay.shape == tgt[0].shape and cov >= 0


# ── 読み書き ─────────────────────────────────────────────────────────────────

def write_video(path, frames, fps=24):
    h, w = frames[0].shape[:2]
    p = subprocess.Popen([FF, "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                          "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-crf", "1",
                          "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", str(path)],
                         stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(np.ascontiguousarray(f).tobytes())
    p.stdin.close(); assert p.wait() == 0


def mark_frames(n, w=64, h=32):
    """コマ番号を明るさで持つ動画(読み出し位置の確認用)。"""
    return [np.full((h, w, 3), 10 + 12 * i, np.uint8) for i in range(n)]


@needs_ffmpeg
def test_iter_frames_offsets(tmp_path):
    p = tmp_path / "m.mp4"; write_video(p, mark_frames(20))
    lv = lambda fr: [int(round((f.mean() - 10) / 12)) for f in fr]
    assert lv(rain_fx.iter_frames(str(p), 5, 4, 64, 32)) == [5, 6, 7, 8]
    assert lv(rain_fx.iter_frames(str(p), -3, 5, 64, 32)) == [0, 0, 0, 0, 1]       # 頭より前は先頭のコマ
    assert lv(rain_fx.iter_frames(str(p), 17, 6, 64, 32)) == [17, 18, 19, 19, 19, 19]   # 終わりより先は最後のコマ
    assert lv(rain_fx.iter_frames(str(p), 2, 4, 64, 32, step=2.0)) == [2, 4, 6, 8]
    assert lv(rain_fx.iter_frames(str(p), 2, 4, 64, 32, step=0.5)) == [2, 2, 3, 3]
    with pytest.raises(RuntimeError):                  # 読めないときは黒で埋めずに止める
        list(rain_fx.iter_frames(str(p), 40, 3, 64, 32))
    with pytest.raises(RuntimeError):
        list(rain_fx.iter_frames(str(tmp_path / "none.mp4"), 0, 3, 64, 32))


# ── ジョブと API(一時 DB) ──────────────────────────────────────────────────────

W, H, FPS = 320, 192, 24.0


@pytest.fixture()
def env(tmp_path, monkeypatch):
    if FF is None:
        pytest.skip("ffmpeg がない")
    from sqlmodel import SQLModel, Session, create_engine
    from app.db import database
    from app.services import job_runner, thumbnail, ffmpeg_render
    eng = create_engine(f"sqlite:///{tmp_path/'t.db'}", connect_args={"check_same_thread": False})
    from app.models import Project, Asset, Track, Clip, Job  # noqa: F401
    from app.models.oplog import OperationLog  # noqa: F401
    from app.models.analysis import AnalysisResult  # noqa: F401
    SQLModel.metadata.create_all(eng)
    monkeypatch.setattr(database, "engine", eng)
    monkeypatch.setattr(job_runner, "engine", eng)
    monkeypatch.setattr(job_runner, "GENERATED_DIR", tmp_path / "generated")
    monkeypatch.setattr(thumbnail, "THUMB_DIR", tmp_path / "thumbs")
    monkeypatch.setattr(ffmpeg_render, "EXPORTS_DIR", tmp_path / "exports")
    N_SRC = 60
    src = synth_source(N_SRC, W, H, seed=5); shot = synth_target(N_SRC, W, H, seed=6)
    write_video(tmp_path / "src.mp4", src); write_video(tmp_path / "shot.mp4", shot)
    with Session(eng) as s:
        pr = Project(name="t", fps=FPS, width=W, height=H); s.add(pr); s.commit(); s.refresh(pr)
        tr = {n: Track(project_id=pr.id, name=n, track_type=t, order=o) for n, t, o in
              (("Filter", "video", -3), ("Shots", "video", 1), ("Video", "video", 4), ("Image", "reference", 5))}
        for t in tr.values():
            s.add(t)
        s.commit()
        for t in tr.values():
            s.refresh(t)
        a_src = Asset(project_id=pr.id, name="src.mp4", asset_type="video", file_path=str(tmp_path / "src.mp4"), duration_sec=N_SRC / FPS, width=W, height=H)
        a_shot = Asset(project_id=pr.id, name="shot.mp4", asset_type="generated", file_path=str(tmp_path / "shot.mp4"), duration_sec=N_SRC / FPS, width=W, height=H)
        s.add(a_src); s.add(a_shot); s.commit(); s.refresh(a_src); s.refresh(a_shot)
        s.add(Clip(track_id=tr["Video"].id, asset_id=a_src.id, start_frame=0, duration_frames=N_SRC))
        # Shots のクリップ: タイムライン 10〜49 に、生成の 3 コマ目から
        c_shot = Clip(track_id=tr["Shots"].id, asset_id=a_shot.id, start_frame=10, duration_frames=40, asset_in_frame=3)
        s.add(c_shot); s.commit(); s.refresh(c_shot)
        ids = dict(project=pr.id, filter=tr["Filter"].id, shots=tr["Shots"].id, video=tr["Video"].id,
                   a_src=a_src.id, a_shot=a_shot.id, c_shot=c_shot.id)
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import rain, clips
    app = FastAPI(); app.include_router(rain.router, prefix="/api"); app.include_router(clips.router, prefix="/api")
    return {"eng": eng, "client": TestClient(app), "ids": ids, "src": src, "shot": shot, "tmp": tmp_path}


def run_job(env, job_id):
    from sqlmodel import Session
    from app.models import Job
    from app.services import job_runner
    with Session(env["eng"]) as s:
        job = s.get(Job, job_id)
        job.status = "running"; s.add(job); s.commit(); s.refresh(job)
    asyncio.run(job_runner._dispatch(job))      # _run_job と同じく、終わったら completed にする(GPU 監視は使わない)
    with Session(env["eng"]) as s:
        j = s.get(Job, job_id)
        if j.status == "running":
            j.status = "completed"; s.add(j); s.commit(); s.refresh(j)
        return j


def get(env, model, id_):
    from sqlmodel import Session
    with Session(env["eng"]) as s:
        return s.get(model, id_)


def test_job_create_rerender_takes_and_switch_back(env):
    from app.models import Asset, Clip
    c, ids = env["client"], env["ids"]
    r = c.post("/api/rain/clips", json={"track_id": ids["filter"], "start_frame": 12, "duration_frames": 30,
                                        "opacity": 0.55, "rain": {"t0": 2, "t1": 9, "blur": 1.5}})
    assert r.status_code == 201, r.text
    job = r.json()
    assert job["job_type"] == "render_rain_layer"
    assert c.post("/api/rain/clips", json={"track_id": ids["filter"], "start_frame": 12, "duration_frames": 30}).status_code == 409
    j = run_job(env, job["id"])
    res = json.loads(j.result_json)
    assert res["swapped"] and res.get("created")
    clip = get(env, Clip, res["clip_id"])
    assert clip.kind == "rain" and clip.blend == "screen" and abs(clip.opacity - 0.55) < 1e-6
    assert (clip.start_frame, clip.duration_frames, clip.asset_in_frame, clip.track_id) == (12, 30, 0, ids["filter"])
    attrs = json.loads(clip.attrs_json)["rain"]
    assert attrs["t0"] == 2 and attrs["src_asset_id"] == ids["a_src"] and attrs["src_offset"] == 0
    a1 = get(env, Asset, clip.asset_id)
    assert a1.proxy_path is None and a1.width == W and a1.height == H and abs(a1.duration_sec - 30 / FPS) < 0.05
    g = json.loads(a1.gen_params_json)["rain_fx"]
    assert g["clip_id"] == clip.id and g["base"][0]["asset_id"] == ids["a_shot"]

    # 層の中身 = 元動画 12〜41 コマ目の雨 × 下の絵(Shots: 生成の 5 コマ目〜)
    gray = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in rain_fx.iter_frames(str(env["tmp"] / "src.mp4"), 7, 40, W, H)]
    shot = list(rain_fx.iter_frames(str(env["tmp"] / "shot.mp4"), 5, 30, W, H))
    ex = rain_fx.RainLayer(gray, rain_fx.normalize(attrs))
    lay = list(rain_fx.iter_frames(a1.file_path, 0, 30, W, H))
    for k in (0, 13, 29):
        want, _ = ex_frame(ex, k, shot[k])
        assert np.abs(lay[k].astype(int) - want.astype(int)).mean() < 1.0      # crf12 の誤差だけ

    # 作り直す(設定の一部だけ送れば残りは今の設定)
    assert c.post(f"/api/rain/clips/{ids['c_shot']}/render", json={"rain": {}}).status_code == 422   # 雨クリップではない
    r = c.post(f"/api/rain/clips/{clip.id}/render", json={"rain": {"wmax": 2, "hmax": 30}})
    assert r.status_code == 201, r.text
    assert c.post(f"/api/rain/clips/{clip.id}/render", json={"rain": {}}).status_code == 409          # 作り直し中
    j2 = run_job(env, r.json()["id"])
    res2 = json.loads(j2.result_json)
    assert res2["swapped"] and res2["asset_id"] != a1.id
    clip2 = get(env, Clip, clip.id)
    at2 = json.loads(clip2.attrs_json)["rain"]
    assert clip2.asset_id == res2["asset_id"] and at2["wmax"] == 2 and at2["t0"] == 2 and abs(clip2.opacity - 0.55) < 1e-6
    takes = c.get(f"/api/rain/clips/{clip.id}/takes").json()
    assert [t["asset_id"] for t in takes] == [res2["asset_id"], a1.id]
    assert takes[0]["current"] and not takes[1]["current"] and takes[1]["rain"]["wmax"] == 5

    # 前の層に戻す(フロントと同じく PATCH で素材と設定を戻す)
    old = takes[1]
    attrs3 = {**json.loads(clip2.attrs_json), "rain": {**old["rain"], "asset_id": old["asset_id"]}}
    r = c.patch(f"/api/clips/{clip.id}", json={"asset_id": old["asset_id"], "asset_in_frame": 0, "attrs_json": json.dumps(attrs3)})
    assert r.status_code == 200, r.text
    takes = c.get(f"/api/rain/clips/{clip.id}/takes").json()
    assert [t["current"] for t in takes] == [False, True]


def test_locked_moved_cancelled(env, monkeypatch):
    from sqlmodel import Session
    from app.models import Clip, Job
    c, ids = env["client"], env["ids"]
    j = run_job(env, c.post("/api/rain/clips", json={"track_id": ids["filter"], "start_frame": 20, "duration_frames": 12}).json()["id"])
    cid = json.loads(j.result_json)["clip_id"]
    # ロック中は作り直しを受け付けない
    with Session(env["eng"]) as s:
        cl = s.get(Clip, cid); cl.locked = True; s.add(cl); s.commit()
    assert c.post(f"/api/rain/clips/{cid}/render", json={"rain": {}}).status_code == 409
    with Session(env["eng"]) as s:
        cl = s.get(Clip, cid); cl.locked = False; s.add(cl); s.commit()
    # 作り直しの間にクリップが動いた → 差し替えず、層はテイクとして残る
    jr = c.post(f"/api/rain/clips/{cid}/render", json={"rain": {"blur": 2.0}}).json()
    real_finish = rain_fx._finish

    def moved_finish(plan, stats):
        with Session(env["eng"]) as s:
            cl = s.get(Clip, cid); cl.start_frame = 22; s.add(cl); s.commit()
        return real_finish(plan, stats)
    monkeypatch.setattr(rain_fx, "_finish", moved_finish)
    jj = run_job(env, jr["id"])
    res = json.loads(jj.result_json)
    assert res["swapped"] is False and "動いた" in res["note"]
    assert get(env, Clip, cid).asset_id != res["asset_id"]
    monkeypatch.setattr(rain_fx, "_finish", real_finish)
    # 取り消し(始める前 / 計算の途中 / 計算が終わる直前): 層もアセットも残さず、クリップも変えない
    from app.services import job_runner
    import time as _time
    before = get(env, Clip, cid).asset_id
    for when in ("start", "during", "end"):
        jr = c.post(f"/api/rain/clips/{cid}/render", json={"rain": {"blur": 1.0}}).json()
        with Session(env["eng"]) as s:
            job = s.get(Job, jr["id"]); job.status = "running"; s.add(job); s.commit(); s.refresh(job)
        calls = {"n": 0}
        # 見回りの何回目で「取り消し」を返すか: start=始める前(1 回目)、during/end=2 回目
        # (during は見回りを毎回させるため時計を 5 秒ずつ進める。end は計算が終わってからの見回りで気づく)
        def status(_id, when=when, calls=calls):
            calls["n"] += 1
            return "cancelled" if (when == "start" or calls["n"] >= 2) else "running"
        monkeypatch.setattr(rain_fx, "_job_status", status)
        clock = {"t": _time.monotonic()}
        if when == "during":
            monkeypatch.setattr(rain_fx.time, "monotonic", lambda: clock.__setitem__("t", clock["t"] + 5.0) or clock["t"])
        asyncio.run(job_runner._dispatch(job))
        monkeypatch.setattr(rain_fx.time, "monotonic", _time.monotonic)
        jc = get(env, Job, jr["id"])
        assert json.loads(jc.result_asset_ids) == [], when
        assert not list((env["tmp"] / "generated").rglob(f"*_j{jr['id']}.mp4*")), when
        assert get(env, Clip, cid).asset_id == before, when
        with Session(env["eng"]) as s:
            j = s.get(Job, jr["id"]); j.status = "cancelled"; s.add(j); s.commit()


def test_zero_strength_is_clamped_and_job_never_touches_comfyui(env, monkeypatch):
    """強さ 0% で作っても 1% になる。雨のジョブ(作成・作り直し)は ComfyUI にも外のサーバーにもつながない。"""
    import httpx
    import urllib.request
    from app.models import Clip
    from app.services import comfyui as comfy_mod
    hits = []
    monkeypatch.setattr(httpx, "post", lambda *a, **k: hits.append(("httpx.post", a)))
    monkeypatch.setattr(httpx, "get", lambda *a, **k: hits.append(("httpx.get", a)))
    real_send = httpx.AsyncClient.send

    async def no_send(self, request, *a, **k):
        hits.append(("AsyncClient", str(request.url)))
        return await real_send(self, request, *a, **k)
    monkeypatch.setattr(httpx.AsyncClient, "send", no_send)
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: hits.append(("urlopen", a)))
    for name in ("drop_all_queued_sync", "is_available"):
        monkeypatch.setattr(comfy_mod.comfyui, name, lambda *a, **k: hits.append(("comfyui", name)))
    c, ids = env["client"], env["ids"]
    j = run_job(env, c.post("/api/rain/clips", json={"track_id": ids["filter"], "start_frame": 14, "duration_frames": 6,
                                                     "opacity": 0}).json()["id"])
    assert j.status == "completed", j.error_msg
    cid = json.loads(j.result_json)["clip_id"]
    assert abs(get(env, Clip, cid).opacity - 0.01) < 1e-9
    j2 = run_job(env, c.post(f"/api/rain/clips/{cid}/render", json={"rain": {"blur": 1.2}}).json()["id"])
    assert j2.status == "completed", j2.error_msg
    assert hits == []


def test_source_missing_is_422(env):
    from sqlmodel import Session, select
    from app.models import Clip
    c, ids = env["client"], env["ids"]
    with Session(env["eng"]) as s:
        for cl in s.exec(select(Clip).where(Clip.track_id == ids["video"])).all():
            s.delete(cl)
        s.commit()
    r = c.post("/api/rain/clips", json={"track_id": ids["filter"], "start_frame": 12, "duration_frames": 10})
    assert r.status_code == 422 and "元動画" in r.text


def test_final_render_matches_preview_formula(env):
    """書き出し(render_timeline)の雨の区間 = screen(下の絵, 層 × 不透明度)。プレビュー(canvas screen + globalAlpha)と同じ式。"""
    from sqlmodel import Session, select
    from app.models import Asset, Clip, Track
    from app.services import ffmpeg_render
    c, ids = env["client"], env["ids"]
    j = run_job(env, c.post("/api/rain/clips", json={"track_id": ids["filter"], "start_frame": 12, "duration_frames": 30,
                                                     "opacity": 0.6, "rain": {"blur": 1.0, "glow": 0.5, "lit": 0.5}}).json()["id"])
    cid = json.loads(j.result_json)["clip_id"]
    with Session(env["eng"]) as s:
        tracks = s.exec(select(Track).where(Track.project_id == ids["project"])).all()
        clips = s.exec(select(Clip)).all(); assets = s.exec(select(Asset)).all()
        lay_path = s.get(Asset, s.get(Clip, cid).asset_id).file_path
        # 比べる下の絵: 雨を隠した書き出し
    out = asyncio.run(ffmpeg_render.render_timeline(9001, ids["project"], tracks, clips, assets, FPS, W, H, encoder="x264", grade="off"))
    no_rain = [cl for cl in clips if cl.id != cid]
    out0 = asyncio.run(ffmpeg_render.render_timeline(9002, ids["project"], tracks, no_rain, assets, FPS, W, H, encoder="x264", grade="off"))
    rend = list(rain_fx.iter_frames(str(out), 12, 30, W, H))
    base = list(rain_fx.iter_frames(str(out0), 12, 30, W, H))
    lay = list(rain_fx.iter_frames(lay_path, 0, 30, W, H))
    diffs, bias, got_up, want_up = [], [], [], []
    for k in range(30):
        want = rain_fx.screen_u8(base[k], lay[k], 0.6)
        d = rend[k].astype(int) - want.astype(int)
        diffs.append(np.abs(d).mean()); bias.append(d.mean())
        m = lay[k].max(axis=2) > 60                     # 雨筋の画素: 書き出しで明るくなった量 ≈ 式どおりの量
        if m.any():
            got_up.append((rend[k].astype(int) - base[k].astype(int))[m].mean())
            want_up.append((want.astype(int) - base[k].astype(int))[m].mean())
    # 差は書き出しの再エンコードの揺れだけ(下の絵の雑音が 2 回の書き出しで別々に丸まる)
    assert float(np.mean(diffs)) < 2.0 and abs(float(np.mean(bias))) < 0.3
    assert got_up and abs(np.mean(got_up) - np.mean(want_up)) < 0.12 * np.mean(want_up) and np.mean(want_up) > 10
    # 雨の区間の外は雨が足されない(書き出しの blend は全区間を RGB に通すので、丸めの揺れだけはある:
    # 合成データは雑音が強く平均 1.4 段ほど。実データ C23 では +0.02 段)
    a = list(rain_fx.iter_frames(str(out), 0, 12, W, H)); b = list(rain_fx.iter_frames(str(out0), 0, 12, W, H))
    d = np.stack([x.astype(int) - y.astype(int) for x, y in zip(a, b)])
    assert abs(float(d.mean())) < 0.3 and float(np.abs(d).mean()) < 2.0
