"""📚 共有素材ライブラリ(app/services/library_cuts.py・app/routers/library.py)のテスト。CPU のみ・一時 SQLite。

  cd backend && COMFYUI_URL=http://127.0.0.1:9 python -B -m pytest -p no:cacheprovider tests/test_library.py

- 判定: 作った絵の列(ハードカット・作画の止め/3 コマ打ち・フラッシュ・黒/白へのフェード・長い黒・ディゾルブ)。
- 解析の流れ: 作った絵を mp4 にして analyze_file(デコードしながら確定した結果 = 一括判定、スプライトの大きさ)。
- API: 全エンドポイント。move=true は一時の動画(このテスト用の data 下の作業場所)で確かめる。
  解析は本物の CLI を別プロセスで起こす(--db で一時 DB、LIBRARY_DATA_DIR で一時の保存先)。
- 再解析でユーザーの値(タグ・評価・★・メモ)と、直した境目(edited)が残ること。
- タイムラインに置く: 24 fps と 30 fps のプロジェクトでのコマの換算。
"""
import json
import math
import os
import shutil
import subprocess
import time
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, select

from app.services import library_cuts as lc

FF = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FF is None, reason="ffmpeg がない")
BACKEND = Path(__file__).resolve().parents[1]
W, H = lc.FW, lc.FH


# ── 作った絵 ─────────────────────────────────────────────────────────────────

def _texture(seed: int, h: int = H + 40, w: int = W + 80) -> np.ndarray:
    rng = np.random.default_rng(seed)
    low = rng.integers(0, 256, (6, 10, 3)).astype(np.uint8)
    base = cv2.resize(low, (w, h), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    mid = cv2.resize(rng.integers(0, 256, (18, 32, 1)).astype(np.uint8), (w, h),
                     interpolation=cv2.INTER_LINEAR).astype(np.float32)[..., None]
    img = 0.7 * base + 0.3 * mid
    return np.clip(img, 0, 255).astype(np.uint8)


def shot(seed: int, n: int, pan: int = 1, blob: bool = True) -> list[np.ndarray]:
    """1 カット分: ゆっくりパンする背景 + 3 コマ打ちで動く丸(キャラの代わり)。"""
    tex = _texture(seed, w=W + n * pan + 8)                # 端で巻き戻らない幅(巻き戻りは本物の飛びになる)
    rng = np.random.default_rng(seed + 1000)
    col = tuple(int(x) for x in rng.integers(0, 256, 3))
    out = []
    for k in range(n):
        x0 = k * pan
        fr = tex[20:20 + H, x0:x0 + W].copy()
        if blob:
            step = k // 3
            cx, cy = 60 + (step * 7) % 140, 70 + (step * 5) % 30
            cv2.ellipse(fr, (cx, cy), (22, 30), 0, 0, 360, col, -1)
        out.append(fr)
    return out


def solid(v: int, n: int) -> list[np.ndarray]:
    return [np.full((H, W, 3), v, np.uint8) for _ in range(n)]


def features_of(frames: list[np.ndarray]) -> dict:
    ex, gf = lc.FeatureExtractor(), lc.GrowingFeatures()
    arr = np.stack(frames)
    for i in range(0, len(arr), 37):          # 塊の境目が途中に来るように半端な大きさで
        gf.extend(ex.add(arr[i:i + 37]))
    return {k: v.copy() for k, v in gf.view().items()}


def bounds(frames, th=None):
    f = features_of(frames)
    return [b for b in lc.detect(f, th) if 0 < b.frame < len(frames)], f


# ── 判定 ─────────────────────────────────────────────────────────────────────

def test_hard_cuts_exact_and_min_length():
    fr = shot(1, 40) + shot(2, 7) + shot(3, 60) + shot(4, 25)
    b, _ = bounds(fr)
    assert [x.frame for x in b] == [40, 47, 107]
    assert all(x.kind == "hard" and x.trans == 0 for x in b)


def test_two_frame_insert_is_not_a_cut():
    """最短 4 コマ: 2 コマだけの差し込みの後で元のカットに戻るなら切らない。"""
    a = shot(5, 80)
    fr = a[:40] + shot(6, 2) + a[42:]
    b, _ = bounds(fr)
    assert b == []


def test_limited_animation_holds_are_not_cuts():
    """止め絵の上で大きな丸が 4 コマごとに跳ぶ(4 コマ打ちの大きな動き)→ カットにしない。"""
    tex = _texture(7)[20:20 + H, 40:40 + W]
    fr = []
    for k in range(240):
        f = tex.copy()
        step = k // 4
        cv2.ellipse(f, (40 + (step * 37) % 180, 50 + (step * 23) % 50), (34, 44), 0, 0, 360, (240, 230, 220), -1)
        fr.append(f)
    b, _ = bounds(fr)
    assert b == []


def test_flash_inside_shot_is_not_a_cut():
    a = shot(8, 90)
    fr = a[:30] + solid(250, 2) + a[32:60] + [np.clip(x.astype(int) + 170, 0, 255).astype(np.uint8) for x in a[60:65]] + a[65:]
    b, _ = bounds(fr)
    assert b == [], [(x.frame, x.kind) for x in b]


def test_flash_between_shots_is_flash_cut():
    fr = shot(9, 50) + solid(252, 2) + shot(10, 50)
    b, _ = bounds(fr)
    assert len(b) == 1, [(x.frame, x.kind) for x in b]
    assert b[0].frame == 50 and b[0].kind in ("flash_cut", "fade_white") and b[0].trans == 2


def _fade(frames, to: int, n: int, out: bool) -> list[np.ndarray]:
    res = []
    for k, x in enumerate(frames[:n]):
        a = (k + 1) / (n + 1) if out else 1 - (k + 1) / (n + 1)
        res.append(np.clip(x.astype(np.float32) * (1 - a) + to * a, 0, 255).astype(np.uint8))
    return res


def test_fade_to_black_and_in():
    A, B = shot(11, 58), shot(12, 58)
    fr = A[:50] + _fade(A[50:], 0, 8, out=True) + solid(0, 6) + _fade(B, 0, 8, out=False) + B[8:]
    b, f = bounds(fr)
    assert len(b) == 1, [(x.frame, x.kind, x.trans) for x in b]
    assert b[0].kind == "fade_black"
    assert abs(b[0].frame - 58) <= 2                      # 黒の頭(次のカットの頭)
    assert abs(b[0].trans - (6 + 8)) <= 3                 # 黒 + 明けの坂
    cuts = lc.make_cuts(f, b, len(fr), lc._th(None))
    assert [c["trans_in"] for c in cuts] == ["start", "fade_black"]


def test_long_black_is_its_own_cut():
    fr = shot(13, 40) + solid(0, 20) + shot(14, 40)
    b, f = bounds(fr)
    assert [x.frame for x in b] == [40, 60]
    cuts = lc.make_cuts(f, b, len(fr), lc._th(None))
    assert cuts[1]["start"] == 40 and cuts[1]["end"] == 60 and "黒" in cuts[1]["auto_tags"]
    assert cuts[1]["dark"] is True


def test_fade_white():
    A, B = shot(15, 46), shot(16, 46)
    fr = A[:40] + _fade(A[40:], 255, 6, out=True) + solid(255, 4) + _fade(B, 255, 6, out=False) + B[6:]
    b, _ = bounds(fr)
    assert len(b) == 1, [(x.frame, x.kind, x.trans) for x in b]
    assert b[0].kind == "fade_white" and abs(b[0].frame - 46) <= 2


def test_dissolve_boundary_and_length():
    A, B = shot(17, 70, pan=0), shot(18, 70, pan=0)
    n = 12
    mix = [np.clip(A[50 + k].astype(np.float32) * (1 - (k + 1) / (n + 1)) + B[k].astype(np.float32) * (k + 1) / (n + 1),
                   0, 255).astype(np.uint8) for k in range(n)]
    fr = A[:50] + mix + B[n:]
    b, _ = bounds(fr)
    assert len(b) == 1, [(x.frame, x.kind, x.trans) for x in b]
    assert b[0].kind == "dissolve"
    assert abs(b[0].frame - 50) <= 2 and abs(b[0].trans - n) <= 3


def test_dark_scene_is_not_black():
    """暗い場面(明るさ 0.04・模様あり)を黒のフェードにしない。"""
    a = [(x.astype(np.float32) * 0.08).astype(np.uint8) for x in shot(19, 120)]
    b, _ = bounds(a)
    assert b == []


def test_thumb_frames_and_cut_features():
    assert lc.thumb_frames(0, 100) == (2, 50, 97)
    assert lc.thumb_frames(10, 13) == (10, 11, 12)
    fr = solid(0, 30) + shot(20, 30)
    f = features_of(fr)
    d = lc.cut_features(f, 0, 30, lc._th(None))
    assert d["dark"] and d["luma"] < 0.01 and d["hue"] is None


# ── 解析の流れ(mp4 → デコード → 確定 → スプライト) ──────────────────────────

def _encode(frames: list[np.ndarray], path: Path, fps: int = 24) -> Path:
    h, w = frames[0].shape[:2]
    p = subprocess.Popen([FF, "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                          "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                          "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
                          "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-g", "24",
                          "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                          "-color_range", "tv", str(path)], stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(np.ascontiguousarray(f).tobytes())
    p.stdin.close()
    assert p.wait() == 0
    return path


LENGTHS = [97, 40, 66, 300, 12, 55, 80, 520, 33, 61, 140, 45]     # 1449 コマ(デコード中の確定を何度も通る)


def _movie_frames() -> tuple[list[np.ndarray], list[int]]:
    fr, starts, pos = [], [], 0
    for i, n in enumerate(LENGTHS):
        fr += shot(100 + i, n)
        starts.append(pos)
        pos += n
    return fr, starts


@pytest.fixture(scope="session")
def movie(tmp_path_factory):
    if FF is None:
        pytest.skip("ffmpeg がない")
    fr, starts = _movie_frames()
    p = _encode(fr, tmp_path_factory.mktemp("libmovie") / "movie.mp4")
    return {"path": p, "starts": starts, "frames": len(fr)}


@needs_ffmpeg
def test_analyze_file_stream_equals_batch(movie, tmp_path):
    res = lc.analyze_file(str(movie["path"]), tmp_path / "out", fps=24.0, expect_frames=movie["frames"])
    assert res.frames == movie["frames"]
    assert [c["start"] for c in res.cuts] == movie["starts"]
    assert res.stream_mismatch == 0
    assert res.cuts[-1]["end"] == movie["frames"]
    im = cv2.imread(str(tmp_path / "out" / "sprites" / "s0.jpg"))
    assert im.shape == (lc.SPRITE_CUTS * lc.TH, 3 * lc.TW, 3)
    # 頭・中・尻のセルが、そのカットのコマ(色)になっている: 3 番目のカットの中のセルと元の絵を比べる
    c = res.cuts[3]
    mid = cv2.resize(_movie_frames()[0][lc.thumb_frames(c["start"], c["end"])[1]], (lc.TW, lc.TH),
                     interpolation=cv2.INTER_AREA)[..., ::-1].astype(np.float32)
    cell = im[3 * lc.TH:4 * lc.TH, lc.TW:2 * lc.TW].astype(np.float32)
    assert np.abs(cell - mid).mean() < 12


# ── API ──────────────────────────────────────────────────────────────────────

@pytest.fixture()
def api(_temp_engine, tmp_path, monkeypatch):
    """一時 DB + 一時の保存先。move のテストはこのバックエンドの data 下の作業場所(終わったら消す)。"""
    from app.models.oplog import OperationLog  # noqa: F401
    from app.models.library import LibraryItem, LibraryCut  # noqa: F401
    SQLModel.metadata.create_all(_temp_engine)
    from app.routers import library
    from app.db import database as dbm
    monkeypatch.setattr(library, "engine", dbm.engine)
    libdata = tmp_path / "library"
    monkeypatch.setattr(lc, "DATA_DIR", libdata)
    monkeypatch.setenv("LIBRARY_DATA_DIR", str(libdata))
    proxies = tmp_path / "proxies"                 # 解析が作るフィルムストリップの置き場(本物の data/proxies に書かない)
    monkeypatch.setattr(lc, "PROXIES_DIR", proxies)
    monkeypatch.setenv("LIBRARY_PROXIES_DIR", str(proxies))
    work = BACKEND / "data" / f"_libtest_{os.getpid()}"
    work.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(library, "DATA", work)
    monkeypatch.setattr(library, "ADOPT_LOG", work / "adopt_log.jsonl")
    monkeypatch.setattr(library, "ANALYZE_EXTRA_ARGS", ["--db", str(_temp_engine.url.database)])
    with Session(dbm.engine) as s:          # テストごとにライブラリの表を空にする
        for m in (LibraryCut, LibraryItem):
            for r in s.exec(select(m)).all():
                s.delete(r)
        s.commit()
    app = FastAPI()
    app.include_router(library.router, prefix="/api")
    yield {"client": TestClient(app), "engine": dbm.engine, "work": work, "libdata": libdata, "mod": library,
           "proxies": proxies}
    library._queue.clear()
    shutil.rmtree(work, ignore_errors=True)


def _mk(engine, movie, fps=24.0, name="movie.mp4", dur=None, path=None):
    from app.models import Project, Asset, Track
    with Session(engine) as s:
        p = Project(name=f"p{time.time_ns()}", fps=fps)
        s.add(p)
        s.commit()
        s.refresh(p)
        t = Track(project_id=p.id, name="V1", track_type="video", order=0)
        a = Asset(project_id=p.id, name=name, asset_type="video", file_path=str(path or movie["path"]),
                  duration_sec=dur if dur is not None else movie["frames"] / 24, width=W, height=H)
        s.add(t)
        s.add(a)
        s.commit()
        return p.id, t.id, a.id


def _wait_done(c, aid, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        it = next(i for i in c.get("/api/library/items").json()["items"] if i["asset_id"] == aid)
        if it["analysis_status"] in ("done", "error", "interrupted"):
            return it
        time.sleep(0.5)
    raise AssertionError("解析が終わらない")


@needs_ffmpeg
def test_api_full_flow(api, movie):
    c, eng = api["client"], api["engine"]
    pid, tid, aid = _mk(eng, movie, dur=700.0)                 # 600 秒以上 → 候補に出る
    j = c.get("/api/library/items").json()
    assert aid in [x["asset_id"] for x in j["candidates"]]
    assert j["library_project_id"] is None

    r = c.post("/api/library/items", json={"asset_id": aid, "series": "テスト", "work": "作品 A", "part": "本編",
                                           "year": 2012, "tags": ["劇場版", " 劇場版 "], "move": False})
    assert r.status_code == 201, r.text
    it = r.json()
    assert it["tags"] == ["劇場版"] and it["fps"] == 24.0 and it["frames"] == movie["frames"]
    assert it["asset"]["starred"] is True and it["moved"] is None
    assert c.post("/api/library/items", json={"asset_id": aid, "move": False}).status_code == 409
    assert c.post("/api/library/items", json={"asset_id": 999999, "move": False}).status_code == 404
    j = c.get("/api/library/items").json()
    assert aid not in [x["asset_id"] for x in j["candidates"]] and j["library_project_id"] is not None

    assert c.patch(f"/api/library/items/{aid}", json={"rating": 6}).status_code == 422
    assert c.patch(f"/api/library/items/{aid}", json={"part": "何か"}).status_code == 422
    r = c.patch(f"/api/library/items/{aid}", json={"rating": 4, "starred": True, "note": "メモ", "tags": ["a", "b"]})
    assert r.status_code == 200 and r.json()["rating"] == 4 and r.json()["tags"] == ["a", "b"]

    r = c.post(f"/api/library/items/{aid}/analyze")
    assert r.status_code == 202 and r.json()["status"] in ("running", "queued")
    assert c.post(f"/api/library/items/{aid}/analyze").status_code == 409
    it = _wait_done(c, aid)
    assert it["analysis_status"] == "done", it
    assert it["cut_count"] == len(LENGTHS) and it["analysis_version"] == lc.DETECTOR_VERSION

    j = c.get(f"/api/library/items/{aid}/cuts").json()
    assert [x["start"] for x in j["cuts"]] == movie["starts"]
    assert j["fps"] == 24.0 and j["frames"] == movie["frames"] and j["sprites"]["per_sheet"] == 50
    assert len(j["sprites"]["versions"]) == 1
    keys = {"id", "idx", "start", "end", "trans_in", "trans_frames", "luma", "motion", "sat", "hue", "dark", "bright",
            "tags", "rating", "starred", "note", "edited"}
    assert keys <= set(j["cuts"][0])
    r = c.get(f"/api/library/items/{aid}/sprites/0.jpg?v=1")
    assert r.status_code == 200 and "max-age=86400" in r.headers["cache-control"] and r.content[:2] == b"\xff\xd8"
    assert c.get(f"/api/library/items/{aid}/sprites/5.jpg").status_code == 404
    assert (api["libdata"] / str(aid) / "cuts.json").exists() and (api["libdata"] / str(aid) / "features.npz").exists()

    cuts = j["cuts"]
    # タグ・評価・★・メモ
    r = c.patch(f"/api/library/cuts/{cuts[1]['id']}", json={"tags": ["戦闘"], "rating": 5, "starred": True, "note": "良い"})
    assert r.json()["tags"] == ["戦闘"] and r.json()["rating"] == 5 and r.json()["starred"]
    assert c.patch(f"/api/library/cuts/{cuts[1]['id']}", json={"rating": 9}).status_code == 422
    assert c.patch("/api/library/cuts/999999", json={"rating": 1}).status_code == 404
    r = c.post("/api/library/cuts/bulk", json={"ids": [cuts[2]["id"], cuts[3]["id"]], "add_tags": ["夜", "戦闘"], "rating": 2})
    assert r.json()["updated"] == 2 and all("夜" in x["tags"] and x["rating"] == 2 for x in r.json()["cuts"])
    r = c.post("/api/library/cuts/bulk", json={"ids": [cuts[3]["id"]], "remove_tags": ["夜"], "starred": True})
    assert r.json()["cuts"][0]["tags"] == ["戦闘"] and r.json()["cuts"][0]["starred"]
    tags = {x["tag"]: x["count"] for x in c.get("/api/library/tags").json()}
    assert tags["戦闘"] == 3 and tags["夜"] == 1 and tags["a"] == 1

    # 分ける → つなぐ(idx の振り直し・サムネイルの作り直し・edited)
    v0 = c.get(f"/api/library/items/{aid}/cuts").json()["sprites"]["versions"]
    big = cuts[7]                                              # 520 コマのカット
    assert c.post(f"/api/library/cuts/{big['id']}/split", json={"at": big["start"]}).status_code == 422
    time.sleep(0.01)
    r = c.post(f"/api/library/cuts/{big['id']}/split", json={"at": big["start"] + 200})
    assert r.status_code == 200, r.text
    a1, a2 = r.json()["cuts"]
    assert (a1["start"], a1["end"], a2["start"], a2["end"]) == (big["start"], big["start"] + 200, big["start"] + 200, big["end"])
    assert a1["edited"] and a2["edited"] and r.json()["cut_count"] == len(LENGTHS) + 1
    j2 = c.get(f"/api/library/items/{aid}/cuts").json()
    assert [x["idx"] for x in j2["cuts"]] == list(range(len(LENGTHS) + 1))
    assert j2["cuts"][-1]["start"] == cuts[-1]["start"]       # 後ろのカットは idx が 1 つずれただけ
    assert j2["sprites"]["versions"] != v0
    # 分けた後ろのカットの中のセルは、その位置のコマ(シークで作り直した)
    sheet = cv2.imread(str(api["libdata"] / str(aid) / "sprites" / "s0.jpg"))
    want = lc.grab_frames(str(movie["path"]), 24.0, [lc.thumb_frames(a2["start"], a2["end"])[1]])
    cell = sheet[a2["idx"] * lc.TH:(a2["idx"] + 1) * lc.TH, lc.TW:2 * lc.TW, ::-1].astype(np.float32)
    assert np.abs(cell - list(want.values())[0].astype(np.float32)).mean() < 12
    # 移動した行(最後のカット)は元の行の絵のまま
    last_old = cv2.imread(str(api["libdata"] / str(aid) / "sprites" / "s0.jpg"))
    assert last_old is not None
    assert c.post("/api/library/cuts/merge", json={"ids": [cuts[0]["id"], cuts[2]["id"]]}).status_code == 422
    r = c.post("/api/library/cuts/merge", json={"ids": [a1["id"], a2["id"]]})
    assert r.status_code == 200 and r.json()["cut"]["start"] == big["start"] and r.json()["cut"]["end"] == big["end"]
    assert r.json()["cut_count"] == len(LENGTHS) and r.json()["cut"]["edited"]

    # 置く(24 fps): 3 本、時間順
    sel = [cuts[5]["id"], cuts[1]["id"], cuts[3]["id"]]
    r = c.post("/api/library/place", json={"project_id": pid, "track_id": tid, "start_frame": 100, "cut_ids": sel})
    assert r.status_code == 201, r.text
    cl = r.json()["clips"]
    exp, pos = [], 100
    for k in (1, 3, 5):
        exp.append((pos, cuts[k]["end"] - cuts[k]["start"], cuts[k]["start"]))
        pos += cuts[k]["end"] - cuts[k]["start"]
    assert [(x["start_frame"], x["duration_frames"], x["asset_in_frame"]) for x in cl] == exp
    assert all(x["kind"] == "media" and x["asset_id"] == aid for x in cl)
    assert json.loads(cl[0]["attrs_json"])["library_cut"]["cut_id"] == cuts[1]["id"]
    r = c.post("/api/library/place", json={"project_id": pid, "track_id": tid, "start_frame": 150, "cut_ids": sel})
    assert r.status_code == 422 and r.json()["detail"]["overlap_clip_ids"]
    from app.models.oplog import OperationLog
    with Session(eng) as s:
        ops = s.exec(select(OperationLog).where(OperationLog.project_id == pid)).all()
        assert [o.kind for o in ops] == ["library_place"]

    # 外す(素材とファイルは残る)
    assert c.delete(f"/api/library/items/{aid}").status_code == 200
    assert not (api["libdata"] / str(aid)).exists()
    assert c.get(f"/api/library/items/{aid}/cuts").status_code == 404
    from app.models import Asset
    with Session(eng) as s:
        assert s.get(Asset, aid) is not None and Path(s.get(Asset, aid).file_path).exists()


def test_place_math_30fps_never_shows_neighbor_frames():
    from app.routers.library import to_project_frames
    for (s, e) in [(0, 24), (101, 125), (1000, 1003), (7, 8), (12345, 12399)]:
        a, d = to_project_frames(s, e, 24.0, 30.0)
        shown = [int(math.floor((a + k) / 1.25 + 1e-6)) for k in range(d)]
        assert shown[0] == s and all(s <= x < e for x in shown) and d >= 1
        assert abs(d - (e - s) * 1.25) <= 1.25
    assert to_project_frames(100, 148, 24.0, 24.0) == (100, 48)


@needs_ffmpeg
def test_place_30fps_project(api, movie):
    c, eng = api["client"], api["engine"]
    _p0, _t0, aid = _mk(eng, movie)
    c.post("/api/library/items", json={"asset_id": aid, "series": "s", "work": "w", "part": "本編", "move": False})
    pid30, tid30, _a = _mk(eng, movie, fps=30.0)
    from app.models.library import LibraryCut
    with Session(eng) as s:
        s.add(LibraryCut(asset_id=aid, idx=0, start_frame=0, end_frame=101))
        s.add(LibraryCut(asset_id=aid, idx=1, start_frame=101, end_frame=125))
        s.commit()
        ids = [x.id for x in s.exec(select(LibraryCut).where(LibraryCut.asset_id == aid).order_by(LibraryCut.idx))]
    r = c.post("/api/library/place", json={"project_id": pid30, "track_id": tid30, "start_frame": 0, "cut_ids": ids,
                                           "gap_frames": 5})
    assert r.status_code == 201, r.text
    cl = r.json()["clips"]
    assert (cl[0]["asset_in_frame"], cl[0]["duration_frames"]) == (0, 126)
    assert (cl[1]["start_frame"], cl[1]["asset_in_frame"], cl[1]["duration_frames"]) == (131, 127, 30)
    assert c.post("/api/library/place", json={"project_id": pid30, "track_id": 999999, "start_frame": 0,
                                              "cut_ids": ids}).status_code == 422


@needs_ffmpeg
def test_reanalysis_keeps_user_fields_and_edited(api, movie):
    c, eng = api["client"], api["engine"]
    _pid, _tid, aid = _mk(eng, movie)
    c.post("/api/library/items", json={"asset_id": aid, "series": "s", "work": "w", "part": "本編", "move": False})
    c.post(f"/api/library/items/{aid}/analyze")
    assert _wait_done(c, aid)["analysis_status"] == "done"
    cuts = c.get(f"/api/library/items/{aid}/cuts").json()["cuts"]
    c.patch(f"/api/library/cuts/{cuts[2]['id']}", json={"tags": ["好き"], "rating": 5, "starred": True, "note": "n"})
    sp = c.post(f"/api/library/cuts/{cuts[3]['id']}/split", json={"at": cuts[3]["start"] + 100}).json()["cuts"]
    # もう一度解析(別プロセス)
    c.post(f"/api/library/items/{aid}/analyze")
    assert _wait_done(c, aid)["analysis_status"] == "done"
    after = c.get(f"/api/library/items/{aid}/cuts").json()["cuts"]
    k = next(x for x in after if x["start"] == cuts[2]["start"])
    assert k["id"] == cuts[2]["id"] and k["tags"] == ["好き"] and k["rating"] == 5 and k["starred"] and k["note"] == "n"
    ed = [x for x in after if x["edited"]]
    assert [(x["start"], x["end"]) for x in ed] == [(sp[0]["start"], sp[0]["end"]), (sp[1]["start"], sp[1]["end"])]
    assert [x["idx"] for x in after] == list(range(len(after)))
    assert all(a["end"] == b["start"] for a, b in zip(after, after[1:])) and after[-1]["end"] == movie["frames"]
    # CLI の再判定(features.npz から、デコードなし)も同じく保つ
    r = subprocess.run([os.sys.executable, "-B", "-m", "app.services.library_cuts", "reanalyze-thresholds", str(aid),
                        "--db", str(eng.url.database)], cwd=str(BACKEND), capture_output=True, text=True,
                       env=dict(os.environ, LIBRARY_DATA_DIR=str(api["libdata"]), LIBRARY_PROXIES_DIR=str(api["proxies"]),
                                PYTHONDONTWRITEBYTECODE="1"))
    assert r.returncode == 0, r.stderr
    again = c.get(f"/api/library/items/{aid}/cuts").json()["cuts"]
    assert [(x["start"], x["end"], x["edited"]) for x in again] == [(x["start"], x["end"], x["edited"]) for x in after]


@needs_ffmpeg
def test_analyze_queue_one_at_a_time_and_stale_status(api, movie):
    c, eng = api["client"], api["engine"]
    ids = []
    for _ in range(2):
        _p, _t, aid = _mk(eng, movie)
        c.post("/api/library/items", json={"asset_id": aid, "series": "s", "work": "w", "part": "予告", "move": False})
        ids.append(aid)
    r1 = c.post(f"/api/library/items/{ids[0]}/analyze").json()
    r2 = c.post(f"/api/library/items/{ids[1]}/analyze").json()
    assert r1["status"] == "running" and r2["status"] == "queued" and r2["queue_position"] == 1
    assert _wait_done(c, ids[0])["analysis_status"] == "done"
    assert _wait_done(c, ids[1])["analysis_status"] == "done"
    # 止まったまま running の素材(pid が無い)は GET で interrupted になる
    from app.models.library import LibraryItem
    with Session(eng) as s:
        it = s.get(LibraryItem, ids[0])
        it.analysis_status, it.analysis_pid = "running", 999999
        s.add(it)
        s.commit()
    it = next(i for i in c.get("/api/library/items").json()["items"] if i["asset_id"] == ids[0])
    assert it["analysis_status"] == "interrupted"


@needs_ffmpeg
def test_register_with_move(api, movie):
    """move=true: ASCII でない名前の一時動画 → data/assets/<ライブラリ>/<ASCII>.mp4、プロキシ・キャッシュも移る。"""
    c, eng, work = api["client"], api["engine"], api["work"]
    from app.models import Asset, Project
    with Session(eng) as s:
        p = Project(name=f"元{time.time_ns()}")
        s.add(p)
        s.commit()
        s.refresh(p)
        old_pid = p.id
    src_dir = work / "assets" / str(old_pid)
    src_dir.mkdir(parents=True)
    src = src_dir / "テスト 動画.mp4"
    shutil.copy(movie["path"], src)
    _pp, _tt, aid = _mk(eng, movie, path=src, name="テスト 動画.mp4")
    with Session(eng) as s:
        a = s.get(Asset, aid)
        a.project_id = old_pid
        prox = work / "proxies" / str(old_pid)
        prox.mkdir(parents=True)
        (prox / f"{aid}.mp4").write_bytes(b"proxy")
        (prox / f"{aid}_strip96_10.jpg").write_bytes(b"strip")
        (prox / f"{aid + 1}.mp4").write_bytes(b"other")          # 別の素材のものは動かさない
        (src_dir / ".preview").mkdir()
        (src_dir / ".preview" / f"{aid}_640.jpg").write_bytes(b"prev")
        a.proxy_path = str(prox / f"{aid}.mp4")
        s.add(a)
        s.commit()
    r = c.post("/api/library/items", json={"asset_id": aid, "series": "Madoka", "work": "Movie 1", "part": "本編",
                                           "move": True})
    assert r.status_code == 201, r.text
    lib_pid = r.json()["asset"]["project_id"]
    assert lib_pid != old_pid
    with Session(eng) as s:
        a = s.get(Asset, aid)
        lp = s.get(Project, lib_pid)
        assert lp.name == "📚 共有素材ライブラリ" and lp.folder == "📚 ライブラリ"
        assert a.project_id == lib_pid and a.starred
        assert a.file_path == str(work / "assets" / str(lib_pid) / "madoka_movie_1_main.mp4")
        assert Path(a.file_path).exists() and not src.exists()
        assert a.proxy_path == str(work / "proxies" / str(lib_pid) / f"{aid}.mp4") and Path(a.proxy_path).exists()
    assert (work / "proxies" / str(lib_pid) / f"{aid}_strip96_10.jpg").exists()
    assert (work / "proxies" / str(old_pid) / f"{aid + 1}.mp4").exists()
    assert (work / "assets" / str(lib_pid) / ".preview" / f"{aid}_640.jpg").exists()
    log = [json.loads(x) for x in (work / "adopt_log.jsonl").read_text().splitlines()]
    assert log[-1]["asset"] == aid and log[-1]["from_project"] == old_pid and log[-1]["via"] == "api"
    assert r.json()["chapters"] == [] and r.json()["frames"] == movie["frames"]
    # 2 本目は同じ名前にならない(ASCII の名前はそのまま、ぶつかれば _2)
    _p2, _t2, aid2 = _mk(eng, movie, path=shutil.copy(movie["path"], src_dir / "madoka_movie_1_main.mp4"))
    r = c.post("/api/library/items", json={"asset_id": aid2, "series": "x", "work": "y", "part": "予告", "move": True})
    assert r.status_code == 201
    with Session(eng) as s:
        assert s.get(Asset, aid2).file_path.endswith("madoka_movie_1_main_2.mp4")


def test_frame_buffer_decimates_long_shots():
    """2000 コマを超えるカット: 頭と最近のコマは全部、間は間引いて持つ(メモリを増やさない)。"""
    buf = lc.FrameBuffer()
    fr = np.zeros((96, 4, 4, 3), np.uint8)
    n = 0
    for _ in range(80):                                   # 7680 コマ
        for j in range(len(fr)):
            fr[j] = (n + j) % 251
        buf.add(n, fr[:, :, :, :].reshape(96, 4, 4, 3))
        n += 96
    assert len(buf.frames) <= lc.LONG_SHOT + lc.RECENT + 96
    assert all(k in buf.frames for k in range(8))
    assert all(k in buf.frames for k in range(n - lc.RECENT, n))
    mid = buf.get(n // 2)
    assert mid is not None
    buf.drop_before(n - 10)
    assert min(buf.frames) == n - 10 and buf.stride == 1


@needs_ffmpeg
def test_cli_failures_report_in_japanese(api, movie, tmp_path):
    eng = api["engine"]
    _p, _t, aid = _mk(eng, movie)
    env = dict(os.environ, LIBRARY_DATA_DIR=str(api["libdata"]), LIBRARY_PROXIES_DIR=str(api["proxies"]),
               PYTHONDONTWRITEBYTECODE="1")
    cmd = [os.sys.executable, "-B", "-m", "app.services.library_cuts", "analyze", str(aid), "--db", str(eng.url.database)]
    r = subprocess.run(cmd, cwd=str(BACKEND), capture_output=True, text=True, env=env)
    assert r.returncode != 0 and "ライブラリに入っていません" in r.stderr
    api["client"].post("/api/library/items", json={"asset_id": aid, "series": "s", "work": "w", "part": "本編", "move": False})
    from app.models import Asset
    with Session(eng) as s:
        a = s.get(Asset, aid)
        a.file_path = str(tmp_path / "ない.mp4")
        s.add(a)
        s.commit()
    r = subprocess.run(cmd, cwd=str(BACKEND), capture_output=True, text=True, env=env)
    assert r.returncode != 0 and "見つかりません" in r.stderr
    it = next(i for i in api["client"].get("/api/library/items").json()["items"] if i["asset_id"] == aid)
    assert it["analysis_status"] == "error" and it["analysis_error"]
    assert api["client"].post(f"/api/library/items/{aid}/analyze").status_code == 422


# ── 2026-10-17 レビューの直し(判定) ──────────────────────────────────────────

def _line_art(seed: int, n: int, dens: list[float]) -> list[np.ndarray]:
    """白地に細い灰色の線(鉛筆の線画)。dens[k] = k コマ目の線の量(多いほど 32×18 の標準偏差が大きい)。"""
    rng = np.random.default_rng(seed)
    ys = rng.integers(0, H, 400)
    xs = rng.integers(0, W, 400)
    out = []
    for k in range(n):
        fr = np.full((H, W, 3), 250, np.uint8)
        m = int(len(ys) * dens[min(k, len(dens) - 1)])
        for y, x in zip(ys[:m], xs[:m]):
            cv2.line(fr, (int(x), int(y)), (int(x) + 14, int(y) + 3), (120, 120, 120), 1)
        out.append(fr)
    return out


def test_cut_into_line_art_on_white_is_at_the_jump():
    """白地の線画へのカット: 線画の最初の 2 コマが「白」に入らなくても、境目は飛んだコマ(2 コマ遅れない)。"""
    A = shot(40, 40)
    art = _line_art(41, 30, [0.3, 0.3] + [0.12] * 28)       # 前の判定は 42 (fade_white) にしていた
    fr = A + art + shot(42, 40)
    b, f = bounds(fr)
    std = lc.frame_std(f)
    assert std[40] > std[43]                                   # 頭の 2 コマは白の一様さの判定に入らない
    assert b and b[0].frame == 40, [(x.frame, x.kind, x.trans) for x in b]
    assert [x.frame for x in b][-1] == 70


def test_cut_just_before_a_flash_is_kept():
    """カットの直後に 2 コマの光(元の絵へ戻る): 光のコマの方がスコアが大きくても、カットは残り、光は切らない。"""
    A, B = shot(43, 40), shot(44, 60)
    flash = [np.clip(x.astype(int) + 200, 0, 255).astype(np.uint8) for x in B[1:3]]
    fr = A + B[:1] + flash + B[3:]
    b, _ = bounds(fr)
    assert [x.frame for x in b] == [40], [(x.frame, x.kind, x.trans) for x in b]


def test_one_frame_black_blink_is_not_a_cut():
    """1 コマの黒(アイリスのまばたき)の後に同じ絵へ戻るなら切らない。"""
    A = shot(45, 80, pan=0)
    fr = A[:40] + solid(0, 1) + A[41:]
    b, _ = bounds(fr)
    assert b == [], [(x.frame, x.kind, x.trans) for x in b]


def test_ramp_walk_stops_at_a_jump_and_bridges_short_plateaus():
    t = lc._th(None)
    # 白へ明るくなる坂の途中に 3 コマの平ら → 越える。形の飛び(mz)では止まる
    luma = np.array([0.5, 0.5, 0.80, 0.84, 0.88, 0.88, 0.88, 0.88, 0.92, 0.96, 0.99, 0.99], np.float32)
    mz = np.zeros_like(luma)
    end, jumped = lc._ramp_walk(luma, mz, 10, -1, -1.0, t)
    assert end == 2 and jumped                  # 0.5 → 0.8 はいきなりの切り替わり(坂の外)
    mz[5] = 0.5
    end, jumped = lc._ramp_walk(luma, mz, 10, -1, -1.0, t)
    assert end == 5 and jumped                  # 形の飛びで止まる
    flat = np.array([0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.84, 0.88, 0.92, 0.96, 0.99, 0.99], np.float32)
    end, jumped = lc._ramp_walk(flat, np.zeros_like(flat), 10, -1, -1.0, t)
    assert end == 5 and not jumped              # 平らが plateau より長い → 坂はそこまで


def test_merge_with_existing_carries_values_to_split_and_absorbed_cuts():
    """再解析で境目が変わったカット(2 つに分かれた・隣に吸収された)のユーザーの値も残る。"""
    old = [{"id": 1, "start": 0, "end": 100, "tags": [], "rating": 0, "starred": False, "note": "", "edited": False},
           {"id": 2, "start": 100, "end": 130, "tags": ["好き", "黒"], "rating": 4, "starred": True, "note": "a",
            "edited": False},
           {"id": 3, "start": 130, "end": 136, "tags": ["短い"], "rating": 2, "starred": False, "note": "b",
            "edited": False},
           {"id": 4, "start": 136, "end": 300, "tags": ["長い"], "rating": 1, "starred": False, "note": "",
            "edited": False}]
    new = [{"start": 0, "end": 100}, {"start": 100, "end": 115}, {"start": 115, "end": 130},
           {"start": 130, "end": 300}]                          # 2 は半分に、3 は 4 に吸収
    st: dict = {}
    out = lc.merge_with_existing(new, old, stats=st)
    by = {(c["start"], c["end"]): c for c in out}
    for k in ((100, 115), (115, 130)):
        assert "好き" in by[k]["tags"] and "黒" not in by[k]["tags"] and by[k]["rating"] == 4 and by[k]["starred"]
    last = by[(130, 300)]
    assert last.get("keep_id") == 4 and set(last["tags"]) == {"長い", "短い"} and last["rating"] == 2
    assert "b" in last["note"]
    assert st["carried_partial"] == 2 and st["not_carried"] == 0


# ── 2026-10-17 レビューの直し(解析の流れ・API) ─────────────────────────────

def test_iter_chunks_raises_when_decoder_is_killed(monkeypatch):
    """ffmpeg がシグナルで殺されたら(負の終了コード)ファイルの終わりと取り違えない。"""
    fsz = W * H * 3
    monkeypatch.setattr(lc, "decode_cmd", lambda *a, **k: ["sh", "-c", f"head -c {fsz * 10} /dev/zero; kill -9 $$"])
    with pytest.raises(RuntimeError, match="シグナル 9"):
        list(lc.iter_chunks("x"))
    # 呼び出し側が途中でやめたときは例外にしない
    monkeypatch.setattr(lc, "decode_cmd", lambda *a, **k: ["sh", "-c", f"head -c {fsz * 400} /dev/zero"])
    g = lc.iter_chunks("x", chunk=4)
    next(g)
    g.close()


@needs_ffmpeg
def test_grab_frames_exact_at_ntsc_rates(tmp_path):
    """23.976 / 29.97 fps でもシークで取ったコマが解析のデコードと同じ(1 コマ先にならない)。まとめて取っても同じ。"""
    rng = np.random.default_rng(0)
    N = 120
    big = np.repeat(np.repeat(rng.integers(0, 256, (N, 9, 16, 3)).astype(np.uint8), 16, axis=1), 16, axis=2)
    for rate in ("24000/1001", "30000/1001"):
        out = tmp_path / f"r{rate.replace('/', '_')}.mp4"
        p = subprocess.Popen([FF, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "256x144", "-r", rate,
                              "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-g", "24",
                              "-pix_fmt", "yuv420p", str(out)], stdin=subprocess.PIPE)
        p.stdin.write(big.tobytes())
        p.stdin.close()
        assert p.wait() == 0
        fps = lc.probe(str(out))["fps"]
        seq = np.concatenate(list(lc.iter_chunks(str(out))))
        frs = [1, 7, 30, 31, 32, 33, 59, 100, 101, 118]
        got = lc.grab_frames(str(out), fps, frs, w=W, h=H)
        for fr in frs:
            d = [np.abs(got[fr].astype(int) - seq[k].astype(int)).mean() for k in range(fr - 1, min(N, fr + 2))]
            assert int(np.argmin(d)) == 1, (rate, fr, d)


def _digest(d: Path) -> dict:
    import hashlib
    return {str(p.relative_to(d)): hashlib.sha1(p.read_bytes()).hexdigest() for p in sorted(d.rglob("*"))
            if p.is_file() and p.name not in ("analyze.log", ".lock")}


def _analyzed(api, movie):
    c, eng = api["client"], api["engine"]
    _pid, _tid, aid = _mk(eng, movie)
    c.post("/api/library/items", json={"asset_id": aid, "series": "s", "work": "w", "part": "本編", "move": False})
    assert lc.run_analyze(aid, str(eng.url.database)) == 0
    return aid


@needs_ffmpeg
def test_truncated_or_failed_analysis_keeps_previous_result(api, movie, monkeypatch):
    """デコードが途中で止まった・DB が書けない → 何も置き換えない(前のスプライト・cuts.json・特徴・DB のまま)。"""
    c, eng = api["client"], api["engine"]
    aid = _analyzed(api, movie)
    d = api["libdata"] / str(aid)
    before, cuts0 = _digest(d), c.get(f"/api/library/items/{aid}/cuts").json()["cuts"]
    real_probe = lc.probe
    monkeypatch.setattr(lc, "probe", lambda p: dict(real_probe(p), frames=movie["frames"] * 2))
    assert lc.run_analyze(aid, str(eng.url.database)) == 1
    it = next(i for i in c.get("/api/library/items").json()["items"] if i["asset_id"] == aid)
    assert it["analysis_status"] == "error" and "デコードが途中で止まりました" in it["analysis_error"]
    assert _digest(d) == before and c.get(f"/api/library/items/{aid}/cuts").json()["cuts"] == cuts0
    monkeypatch.setattr(lc, "probe", real_probe)

    def locked(*a, **k):
        raise RuntimeError("database is locked")
    monkeypatch.setattr(lc, "write_analysis_db", locked)
    assert lc.run_analyze(aid, str(eng.url.database), {"min_len": 48}) == 1
    assert _digest(d) == before and c.get(f"/api/library/items/{aid}/cuts").json()["cuts"] == cuts0
    assert not list(d.glob("*.new*")) and not (d / "pending.json").exists()


@needs_ffmpeg
def test_edits_made_during_analysis_are_kept(api, movie, monkeypatch):
    """解析しなおしている間に付けた評価・★・タグ・メモは、解析の終わりに古い値で上書きされない。"""
    c, eng = api["client"], api["engine"]
    aid = _analyzed(api, movie)
    cuts = c.get(f"/api/library/items/{aid}/cuts").json()["cuts"]
    real = lc.analyze_file

    def during(*a, **k):
        res = real(*a, **k)                                # デコードの最後(DB を書く前)に、ユーザーが編集する
        assert c.patch(f"/api/library/cuts/{cuts[4]['id']}", json={"rating": 5, "starred": True, "tags": ["解析中"],
                                                                    "note": "途中で付けた"}).status_code == 200
        assert c.post("/api/library/cuts/bulk", json={"ids": [cuts[5]["id"]], "add_tags": ["夜"]}).status_code == 200
        return res
    monkeypatch.setattr(lc, "analyze_file", during)
    assert lc.run_analyze(aid, str(eng.url.database)) == 0
    after = {x["id"]: x for x in c.get(f"/api/library/items/{aid}/cuts").json()["cuts"]}
    a4, a5 = after[cuts[4]["id"]], after[cuts[5]["id"]]
    assert (a4["rating"], a4["starred"], a4["tags"], a4["note"]) == (5, True, ["解析中"], "途中で付けた")
    assert a5["tags"] == ["夜"]


@needs_ffmpeg
def test_analysis_conflicts_with_a_split_made_meanwhile(api, movie, monkeypatch):
    """スプライトを作った後で境目が変わっていたら(別の操作の分ける)、解析は何も書かずに失敗する。"""
    c, eng = api["client"], api["engine"]
    aid = _analyzed(api, movie)
    d = api["libdata"] / str(aid)
    before = _digest(d)
    real = lc.build_sprites

    def split_meanwhile(*a, **k):
        n = real(*a, **k)
        from app.models.library import LibraryCut
        with Session(eng) as s:
            r = s.exec(select(LibraryCut).where(LibraryCut.asset_id == aid, LibraryCut.idx == 7)).first()
            r.end_frame -= 50
            r.edited = True
            s.add(LibraryCut(asset_id=aid, idx=99, start_frame=r.end_frame, end_frame=r.end_frame + 50, edited=True))
            s.add(r)
            s.commit()
        return n
    monkeypatch.setattr(lc, "build_sprites", split_meanwhile)
    assert lc.run_analyze(aid, str(eng.url.database)) == 1
    it = next(i for i in c.get("/api/library/items").json()["items"] if i["asset_id"] == aid)
    assert it["analysis_status"] == "error" and "つなぐ・分ける" in it["analysis_error"]
    assert _digest(d) == before


@needs_ffmpeg
def test_split_survives_a_crash_between_db_and_sprites(api, movie, monkeypatch):
    """分けるの途中(DB を書いた後、スプライトを入れ替える前)で落ちても、次に一覧を開いたときに仕上がる。
    DB を書く前に落ちたら取り消される。どちらでもスプライトの行は DB のカットの絵。"""
    c, eng = api["client"], api["engine"]
    aid = _analyzed(api, movie)
    sp = api["libdata"] / str(aid) / "sprites"

    def check():
        j = c.get(f"/api/library/items/{aid}/cuts").json()
        sheet = cv2.imread(str(sp / "s0.jpg"))
        mids = lc.grab_frames(str(movie["path"]), 24.0, [lc.thumb_frames(x["start"], x["end"])[1] for x in j["cuts"]])
        for x in j["cuts"]:
            cell = sheet[x["idx"] * lc.TH:(x["idx"] + 1) * lc.TH, lc.TW:2 * lc.TW, ::-1].astype(np.float32)
            assert np.abs(cell - mids[lc.thumb_frames(x["start"], x["end"])[1]].astype(np.float32)).mean() < 14, x
        assert not list(sp.glob("*.new.jpg")) and not (sp.parent / "pending.json").exists()
        return j["cuts"]
    cuts = check()
    big = cuts[3]

    class Crash(BaseException):
        pass

    def boom(*a, **k):
        raise Crash()
    monkeypatch.setattr(lc, "_apply_staged", boom)                       # DB の後で落ちる
    with pytest.raises(Crash):
        c.post(f"/api/library/cuts/{big['id']}/split", json={"at": big["start"] + 100})
    assert (sp.parent / "pending.json").exists()
    monkeypatch.undo()
    monkeypatch.setattr(lc, "DATA_DIR", api["libdata"])
    after = check()
    assert len(after) == len(cuts) + 1
    real_lock = lc._lock_db_for_write
    monkeypatch.setattr(lc, "_lock_db_for_write", boom)                  # DB の前で落ちる
    with pytest.raises(Crash):
        c.post(f"/api/library/cuts/{after[0]['id']}/split", json={"at": after[0]["start"] + 30})
    monkeypatch.setattr(lc, "_lock_db_for_write", real_lock)
    assert len(check()) == len(after)


@needs_ffmpeg
def test_analysis_prewarms_filmstrips(api, movie):
    """解析のついでにタイムラインのフィルムストリップ(assets.py の get_filmstrip と同じ名前・同じコマ)を作る。"""
    c, eng = api["client"], api["engine"]
    pid, _tid, aid = _mk(eng, movie)
    c.post("/api/library/items", json={"asset_id": aid, "series": "s", "work": "w", "part": "本編", "move": False})
    c.post(f"/api/library/items/{aid}/analyze")
    assert _wait_done(c, aid)["analysis_status"] == "done"
    d = api["proxies"] / str(pid)
    plan = lc.filmstrip_plan(movie["frames"] / 24, 24.0, movie["frames"])
    frames = _movie_frames()[0]
    for n in (2, 3, 4, 6, 8, 12, 16, 24, 32, 40):
        im = cv2.imread(str(d / f"{aid}_strip96_{n}.jpg"))
        assert im is not None and im.shape == (54, 96 * n, 3), n
        for k in (0, n - 1):
            want = cv2.resize(frames[plan[n][k]], (96, 54), interpolation=cv2.INTER_AREA)[..., ::-1].astype(np.float32)
            assert np.abs(im[:, k * 96:(k + 1) * 96].astype(np.float32) - want).mean() < 14, (n, k)


def test_filmstrip_plan_matches_ffmpeg_fps_filter():
    """ffmpeg の fps フィルタ(丸め near)は k 枚目に時刻 (k + 0.5) / r の直前のコマを出す。"""
    plan = lc.filmstrip_plan(97.0, 24.0, 2328)
    r = float(f"{4 / 97.0:.4f}")
    assert plan[4] == [int(math.ceil((k + 0.5) / r * 24 - 1e-9)) - 1 for k in range(4)]
    assert all(len(v) == n for n, v in plan.items()) and set(plan) == set(range(2, 41))


@needs_ffmpeg
def test_register_move_refused_while_proxy_is_encoding(api, movie):
    """プロキシを作るジョブが動いている間は移さない(+faststart の 2 回目で壊れたプロキシが残っていた)。"""
    c, eng, work = api["client"], api["engine"], api["work"]
    from app.models import Asset
    from app.models.job import Job
    src_dir = work / "assets" / "77"
    src_dir.mkdir(parents=True)
    src = src_dir / "upload.mp4"
    shutil.copy(movie["path"], src)
    pid, _t, aid = _mk(eng, movie, path=src)
    with Session(eng) as s:
        j = Job(project_id=pid, job_type="create_proxy", status="running", params=json.dumps({"asset_id": aid}))
        s.add(j)
        s.commit()
        s.refresh(j)
        jid = j.id
    r = c.post("/api/library/items", json={"asset_id": aid, "series": "a", "work": "b", "part": "本編", "move": True})
    assert r.status_code == 409 and "プロキシ" in r.json()["detail"] and src.exists()
    with Session(eng) as s:
        j = s.get(Job, jid)
        j.status = "completed"
        s.add(j)
        s.commit()
    r = c.post("/api/library/items", json={"asset_id": aid, "series": "a", "work": "b", "part": "本編", "move": True})
    assert r.status_code == 201 and not src.exists()
    with Session(eng) as s:
        assert Path(s.get(Asset, aid).file_path).exists()


@needs_ffmpeg
def test_register_rolls_back_the_move_when_the_item_cannot_be_written(api, movie, monkeypatch):
    c, eng, work = api["client"], api["engine"], api["work"]
    from sqlalchemy import event
    from app.models import Asset
    from app.models.library import LibraryItem
    src_dir = work / "assets" / "78"
    src_dir.mkdir(parents=True)
    src = src_dir / "テスト.mp4"
    shutil.copy(movie["path"], src)
    pid, _t, aid = _mk(eng, movie, path=src)

    def fail(*a, **k):
        raise RuntimeError("database is locked")
    event.listen(LibraryItem, "before_insert", fail)
    try:
        r = c.post("/api/library/items", json={"asset_id": aid, "series": "a", "work": "b", "part": "本編", "move": True})
    finally:
        event.remove(LibraryItem, "before_insert", fail)
    assert r.status_code == 500 and "元に戻しました" in r.json()["detail"]
    with Session(eng) as s:
        a = s.get(Asset, aid)
        assert a.file_path == str(src) and src.exists() and a.project_id == pid and not a.starred
        assert s.get(LibraryItem, aid) is None


@needs_ffmpeg
def test_item_validation_missing_asset_and_reused_pid(api, movie):
    c, eng = api["client"], api["engine"]
    _p, _t, aid = _mk(eng, movie)
    c.post("/api/library/items", json={"asset_id": aid, "series": "s", "work": "w", "part": "本編", "move": False})
    for k in ("series", "work", "part", "sort_order", "rating", "starred"):
        r = c.patch(f"/api/library/items/{aid}", json={k: None})
        assert r.status_code == 422 and "null" in r.json()["detail"], k
    r = c.patch(f"/api/library/items/{aid}", json={"year": None, "note": "x" * 5000, "series": "s" * 500})
    assert r.status_code == 200 and r.json()["year"] is None and len(r.json()["note"]) == 2000
    assert len(r.json()["series"]) == 200
    # 番号の使い回し: 解析ではない別のプロセスの pid が残っていても、解析中のままにならない
    other = subprocess.Popen(["sleep", "30"])
    try:
        from app.models.library import LibraryItem
        with Session(eng) as s:
            it = s.get(LibraryItem, aid)
            it.analysis_status, it.analysis_pid = "running", other.pid
            s.add(it)
            s.commit()
        it = next(i for i in c.get("/api/library/items").json()["items"] if i["asset_id"] == aid)
        assert it["analysis_status"] == "interrupted"
    finally:
        other.kill()
        other.wait()
    # 素材(アセット)が消された: missing で知らせる(外すことはできる)
    from app.models import Asset
    with Session(eng) as s:
        s.delete(s.get(Asset, aid))
        s.commit()
    it = next(i for i in c.get("/api/library/items").json()["items"] if i["asset_id"] == aid)
    assert it["missing"] is True and it["asset"] == {}
    assert c.post(f"/api/library/items/{aid}/analyze").status_code == 422
    assert c.delete(f"/api/library/items/{aid}").status_code == 200
