"""🎬 撮影レイヤーの API(app/services/satsuei_fx.py を参照)。

  GET  /api/satsuei/meta                       設定の既定値・範囲・プリセット(プリセットの元はここだけ)
  POST /api/satsuei/detect                     下の絵(生成の 1 本)の中の切り替わりを探す(書き込まない)
  POST /api/satsuei/lay                        範囲に撮影クリップを敷く(下のクリップごと・切り替わりで分ける・自動で合わせる)
  POST /api/satsuei/clips/{clip_id}/autofit    まん中のコマで自動で合わせた設定の案(書き込まない)
  GET  /api/satsuei/clips/{clip_id}/still      書き出しと同じ計算(Python)の 1 コマ(JPEG)
  GET/PUT /api/satsuei/user-presets            自分で保存したプリセット(data/settings.json の SATSUEI_USER_PRESETS)

下の絵 = 撮影トラックより下(order が大きい)の、隠していない映像トラックを上から見て、コマごとに素材(動画・画像)の
ある最前面のクリップ(単色・ぼかし・撮影・雨は除く)。ふつうは Shots の生成そのもので、ほかの重ね(テロップ・雨・
下の撮影クリップ)は入れない。撮影トラックがいちばん下(ベース)なら、そのトラック自身の素材のクリップ。
撮影トラックに配置(⇔比較表示の矩形)があれば、その矩形に重なるトラックだけを見る(右に並べた参照は入れない)。
素材のコマは書き出しと同じ対応: asset_in + (f − start)·speed(加減速・コマ打ち・⏱時間リマップのキーとコマ打ちも)。
素材より長いクリップの、素材の終わりより後のコマは最後のコマ(書き出しの tpad clone と同じ)。
ズーム・パン(transform_json)は入れない(1 コマの絵も、ズーム前の絵に掛ける)。
重い計算(動画を読む・切り替わりを探す・自動で合わせる)の間は DB の接続を持たない
(10/16 job 7600: 接続の口が埋まって落ちた): 読む → 閉じる → 計算 → 短く開いて書く。
敷く(lay)のはトラックごとに 1 つずつ(二重に押した・二人で同時に押したときに、同じクリップが 2 組できないように)。
"""
from __future__ import annotations

import copy
import json
import math
import os
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db.database import engine
from app.models import Asset, Clip, ClipRead, Project, Track
from app.services import satsuei_fx

router = APIRouter(prefix="/satsuei", tags=["satsuei"])

CLIP_KIND = "satsuei"
USER_PRESETS_KEY = "SATSUEI_USER_PRESETS"
DETECT_W = 192          # 切り替わり探しの絵の幅(特徴は 48×27 に縮めるので、これで足りる)
MIN_SEG = 4             # これより短い区切りは作らない(区切りの近くの誤検出で 1〜2 コマのクリップができないように)
MAX_RANGE = 24 * 60 * 30   # 一度に扱うコマ数の上限(30 分 @24fps)
LAY_WORKERS = 6         # 敷くときに並べて計算する下の絵の区間の数(動画を読むのは ffmpeg、計算は numpy/cv2 で GIL を離す)
BLANK_WHITE = 90.0      # 自動で合わせるコマに使わない: 白い面がこれ(%)より広い(白く飛んだ・白への溶けの中)
BLANK_STD = 0.02        # 同じく、明るさのばらつきがこれより小さい(ほぼ 1 色の絵)
FIT_PROBES = 9          # まん中のコマが使えないとき、クリップの中で代わりに見るコマの数
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
_LAY_LOCKS: dict[int, threading.Lock] = {}
_LAY_LOCKS_GUARD = threading.Lock()


class DetectBody(BaseModel):
    track_id: int
    start_frame: int
    duration_frames: int
    k: int = 10


class LayBody(BaseModel):
    track_id: int
    start_frame: Optional[int] = None
    duration_frames: Optional[int] = None
    preset: str = "ba_sunny"
    auto_fit: bool = True
    split: bool = True
    replace: bool = False


class AutofitBody(BaseModel):
    preset: Optional[str] = None
    frame: Optional[int] = None                 # タイムラインのコマ(無ければ、このクリップだけが効く区間のまん中)
    target: Optional[list[float]] = None        # [y05, y50](無ければプリセットの目標)


class UserPresetsBody(BaseModel):
    presets: dict = {}


# ── 下の絵 ───────────────────────────────────────────────────────────────────

def _skip_kinds() -> tuple:
    from app.services.ffmpeg_render import FILTER_KINDS
    from app.services.rain_fx import CLIP_KIND as RAIN
    return (*FILTER_KINDS, RAIN)


def _is_image(a: Asset) -> bool:
    return (a.asset_type == "image" or (a.asset_type == "generated" and a.duration_sec is None)
            or Path(a.file_path).suffix.lower() in _IMAGE_EXTS)


def _ctx(session: Session, track_id: int) -> SimpleNamespace:
    track = session.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    if track.track_type != "video":
        raise HTTPException(status_code=422, detail="撮影クリップは映像トラックに置いてください")
    proj = session.get(Project, track.project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    from app.services.ffmpeg_render import parse_layout
    return SimpleNamespace(track_id=track.id, project_id=track.project_id, order=track.order,
                           layout=parse_layout(track.layout_json or ""),
                           W=int(proj.width), H=int(proj.height), fps=float(proj.fps or 24.0))


def _rect_overlap(a: Optional[dict], b: Optional[dict]) -> Optional[tuple[float, float, float, float]]:
    """2 つの配置(割合の x, y, w, h。None = 全画面)の重なり → (x0, y0, x1, y1) / None(重ならない)。"""
    ax0, ay0, ax1, ay1 = (0.0, 0.0, 1.0, 1.0) if not a else (a["x"], a["y"], a["x"] + a["w"], a["y"] + a["h"])
    bx0, by0, bx1, by1 = (0.0, 0.0, 1.0, 1.0) if not b else (b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"])
    x0, y0, x1, y1 = max(ax0, bx0, 0.0), max(ay0, by0, 0.0), min(ax1, bx1, 1.0), min(ay1, by1, 1.0)
    return (x0, y0, x1, y1) if x1 - x0 > 1e-3 and y1 - y0 > 1e-3 else None


def _lanes(session: Session, ctx: SimpleNamespace) -> list[list[dict]]:
    """撮影トラックより下の映像トラック(上から順)ごとの、素材のあるクリップ(頭の順)。DB の行は持ち出さない。
    撮影トラックに配置(矩形)があれば、それに重なるトラックだけ。下に映像トラックが無い(撮影トラックがベース)なら、
    そのトラック自身の素材のクリップ(書き出しはベースの絵の直上で掛ける = base_filter_clips)。"""
    from app.services.ffmpeg_render import parse_layout, parse_remap
    skip = _skip_kinds()
    vts = [t for t in session.exec(select(Track).where(Track.project_id == ctx.project_id,
                                                        Track.track_type == "video")).all() if not t.hidden]
    base_id = max(vts, key=lambda t: t.order).id if vts else None    # 書き出しのベース(いちばん下の映像トラック)
    tracks = sorted((t for t in vts if t.order > ctx.order), key=lambda t: t.order)
    own = getattr(ctx, "track_id", None)
    if not tracks and own is not None:
        tracks = [t for t in vts if t.id == own]
    rect = getattr(ctx, "layout", None)
    assets: dict[int, Optional[Asset]] = {}
    lanes: list[list[dict]] = []
    for t in tracks:
        lay = parse_layout(t.layout_json or "")
        if rect is not None and _rect_overlap(rect, lay) is None:
            continue                         # 撮影の矩形の外のトラック(比較表示の右の参照など)
        lane = []
        for c in session.exec(select(Clip).where(Clip.track_id == t.id, Clip.asset_id.is_not(None))).all():
            if (c.kind or "media") in skip:
                continue
            if c.asset_id not in assets:
                a = session.get(Asset, c.asset_id)
                assets[c.asset_id] = a if (a is not None and a.file_path and Path(a.file_path).exists()) else None
            a = assets[c.asset_id]
            if a is None:
                continue
            lane.append({"clip_id": c.id, "track_id": t.id, "start": int(c.start_frame),
                         "end": int(c.start_frame + c.duration_frames), "asset_id": a.id, "path": a.file_path,
                         "image": _is_image(a), "asset_in": int(c.asset_in_frame or 0), "speed": float(c.speed or 1.0),
                         "remap": parse_remap(c.remap_json or "", c.duration_frames, c.asset_in_frame),
                         "dur": int(c.duration_frames), "ease": c.speed_ease or "linear",
                         "hold": float(c.posterize_fps or 0), "base": t.id == base_id, "layout": lay,
                         "tin": c.transition_in or "", "tf": int(c.transition_frames or 0),
                         "tease": c.transition_ease or "linear"})
        lane.sort(key=lambda d: (d["start"], d["clip_id"]))
        lanes.append(lane)
    return lanes


def _extent(lanes: list[list[dict]]) -> Optional[tuple[int, int]]:
    cs = [c for lane in lanes for c in lane]
    if not cs:
        return None
    return min(c["start"] for c in cs), max(c["end"] for c in cs)


def _pieces(lanes: list[list[dict]], a: int, b: int) -> list[dict]:
    """[a, b) の下の絵を、同じクリップが続く区間に分ける → [{f0, f1(含まない), clip_id, path, ...}]。
    コマごとに上のトラックから見て、覆うクリップがあればそれ(同じトラックで重なるときは後に始まる方、同じ頭なら id の大きい方)。"""
    out: list[dict] = []
    cur = None
    for f in range(a, b):
        hit = None
        for lane in lanes:
            for c in lane:
                if c["start"] > f:
                    break
                if f < c["end"]:
                    hit = c
            if hit is not None:
                break
        if hit is None:
            cur = None
        elif cur is not None and cur["clip_id"] == hit["clip_id"] and cur["f1"] == f:
            cur["f1"] = f + 1
        else:
            cur = {**hit, "f0": f, "f1": f + 1}
            out.append(cur)
    return out


def _fps_ratio(path: str, image: bool, fps: float) -> float:
    """素材の fps ÷ プロジェクトの fps(書き出しは asset_in/fps 秒から切り出すので、fps が違う素材はコマの番号が伸び縮みする。
    23.976 と 24 のように近くても、長い素材の後ろの方では何コマもずれるので、そのまま掛ける)。"""
    if image:
        return 1.0
    from app.services.ffmpeg_render import _src_fps
    sf = _src_fps(path)
    return sf / fps if sf > 0 and fps > 0 else 1.0


@lru_cache(maxsize=512)
def _n_frames_of(path: str, mtime_ns: int, size: int) -> int:
    from app.services.ffmpeg_render import _probe_frames
    return _probe_frames(Path(path))


def _n_frames(path: str) -> int:
    """動画のコマ数(ファイルが変わらない間は覚えておく。読めなければ 0)。"""
    try:
        st = os.stat(path)
    except OSError:
        return 0
    return _n_frames_of(str(path), st.st_mtime_ns, st.st_size)


def _held(m: float, hold: float, fps: float) -> tuple[float, bool]:
    """コマ打ち(posterize_fps / リマップの hold)。書き出しは速さを掛けた後に fps={hold}(いちばん近い格子)→ fps={fps}
    なので、出力の m コマ目に見えるのは、hold の格子 n = ⌊m·hold/fps⌋ の「(n + ½) 格子より手前で最後の素材のコマ」
    → (出力の位置(コマ), 手前のコマを取るか)。コマ打ちなしは (m, False)。"""
    if hold and 0.5 < hold < fps:
        n = math.floor(m * hold / fps + 1e-6)
        return (n + 0.5) * fps / hold, True
    return float(m), False


def _ease_pieces(ease: str, n: int, speed: float, fps: float) -> Optional[list[tuple[int, float, float]]]:
    """ベースのトラックの加減速(speed_ease)を、書き出し(_extract_segment)と同じ区切りで → [(コマ数, 頭の素材位置, 速さ)]。
    素材位置はクリップの asset_in からの、プロジェクトの fps でのコマ。加減速なし・短い(16 コマ未満)なら None。"""
    from app.services.ffmpeg_render import _cubic_bezier_y_at_x, _ease_points
    if n < 16 or not ease or ease == "linear":
        return None
    dur, span = n / fps, n / fps * speed
    raw: list[tuple[float, float, float]] = []          # (出力の秒, 頭の素材の秒, 速さ)
    if ease.startswith("curve:"):
        try:
            rel = [max(0.05, float(x)) for x in ease[6:].split(";")[0].split(",") if x.strip()]
        except ValueError:
            rel = []
        if len(rel) < 2:
            return None
        m = sum(rel) / len(rel)
        cur = 0.0
        for r in rel:
            seg_out = dur / len(rel)
            seg_src = max(1e-3, seg_out * speed * r / m)
            raw.append((seg_out, cur, max(0.05, seg_src / seg_out)))
            cur += seg_src
    else:
        pts = _ease_points(ease)
        if pts is None:
            return None
        K = min(12, max(2, int(n / 4)))
        for k in range(K):
            u0, u1 = k / K, (k + 1) / K
            sp0, sp1 = (_cubic_bezier_y_at_x(u, *pts) for u in (u0, u1))
            seg_out = (u1 - u0) * dur
            raw.append((seg_out, sp0 * span, max(0.05, max(1e-3, (sp1 - sp0) * span) / seg_out)))
    # 区切りごとの出力は「その尺に入るコマ」(秒 < 尺)なので、端数は切り上げ。最後に全体を n コマで切る
    return [(max(1, math.ceil(so * fps - 1e-6)), s0 * fps, sp) for so, s0, sp in raw]


def _src_index(p: dict, f: int, ratio: float = 1.0, fps: float = 24.0) -> int:
    """タイムラインのコマ f → 素材のコマ。書き出し・プレビューと同じく「その時刻を含むコマ」(切り捨て)。
    ⏱リマップのキー(区間ごとのコマ打ちも)/ 速さ(ベースのトラックなら加減速も、書き出しと同じ区切りで)/ コマ打ち。
    素材の終わりより先の番号はそのまま返す(読むときに最後のコマにする)。
    加減速は書き出しの区切り(_ease_pieces)のとおりに計算する。書き出しは区切りごとの -t の丸めで 1 コマ増えることが
    あり、その分は合わない(加減速のクリップでは 1〜数コマずれることがある)。"""
    if p["image"]:
        return 0
    j = f - p["start"]
    keys = p.get("remap")
    if keys:
        k0, k1 = keys[-2], keys[-1]
        for a, b in zip(keys, keys[1:]):
            if j < b["t"]:
                k0, k1 = a, b
                break
        pos, strict = _held(j - k0["t"], float(k0.get("hold") or 0), fps)
        x = k0["src"] + (k1["src"] - k0["src"]) * pos / max(1, k1["t"] - k0["t"])
    else:
        hold = float(p.get("hold") or 0)
        pieces = _ease_pieces(p.get("ease") or "linear", int(p.get("dur") or 0), max(0.05, p["speed"]), fps) \
            if p.get("base") else None
        if pieces:
            m, x, strict = j, None, False
            for cnt, s0, sp in pieces:
                if m < cnt:
                    pos, strict = _held(m, hold, fps)
                    x = p["asset_in"] + s0 + pos * sp
                    break
                m -= cnt
            if x is None:                                       # 区切りの外(最後のコマを伸ばす)
                cnt, s0, sp = pieces[-1]
                pos, strict = _held(cnt - 1, hold, fps)
                x = p["asset_in"] + s0 + pos * sp
        else:
            pos, strict = _held(j, hold, fps)
            x = p["asset_in"] + pos * p["speed"]
    if strict:
        return max(0, int(math.ceil(x * ratio - 1e-6)) - 1)
    return max(0, int(math.floor(x * ratio + 1e-6)))


def _decode(path: str, vf: str, n: int, w: int, h: int, pre: Optional[list] = None) -> tuple[list[np.ndarray], str]:
    """ffmpeg で n コマまで読む → (BGR のコマの並び, エラー出力の末尾)。"""
    cmd = [satsuei_fx.ffmpeg_exe(), "-nostdin", "-v", "error", *(pre or []), "-i", str(path), "-vf", vf,
           "-fps_mode", "passthrough", "-frames:v", str(n), "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    size = w * h * 3
    out: list[np.ndarray] = []
    with tempfile.TemporaryFile() as err_fh:     # stderr はファイルへ(壊れた素材でエラーが多くても管が詰まらない)
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err_fh)
        try:
            for _ in range(n):
                buf = p.stdout.read(size)
                if not buf or len(buf) < size:
                    break
                out.append(np.frombuffer(buf, np.uint8).reshape(h, w, 3))
            p.stdout.close()
            p.wait()
        finally:
            if p.poll() is None:
                p.kill()
                p.wait()
        err_fh.seek(0)
        err = err_fh.read().decode(errors="replace").strip()
    return out, err[-300:]


def _grab(path: str, image: bool, idxs, w: int, h: int, small: bool) -> dict[int, np.ndarray]:
    """素材のコマ(番号。重複・順不同でよい)を BGR uint8 [h, w, 3] で読む(BT.709・tv)。
    small = 切り替わり探し用(縮めるだけ)。そうでなければ書き出しと同じく画面いっぱいに合わせ(cover)、はみ出しを切る。
    素材の終わりより先の番号は最後のコマ(書き出しが最後のコマを伸ばすのと同じ。コマ数は先に調べて番号を寄せておく)。
    1 コマも読めなければ RuntimeError。"""
    req = [int(i) for i in idxs]
    if not req:
        return {}
    if small:
        sc = f"scale={w}:{h}:in_color_matrix=bt709:in_range=tv:flags=area,format=bgr24"
    else:
        sc = (f"scale={w}:{h}:force_original_aspect_ratio=increase:in_color_matrix=bt709:in_range=tv:"
              f"flags=lanczos+accurate_rnd+full_chroma_int,crop={w}:{h},format=bgr24")
    name = Path(str(path)).name

    def fail(err: str):
        # ffmpeg の言い分は最後の 1 行だけ、フォルダの道筋はファイルの名前にして
        if not Path(str(path)).exists():
            return RuntimeError(f"素材の動画を読めませんでした({name}): ファイルがありません")
        last = next((ln.strip() for ln in reversed(err.splitlines()) if ln.strip()), "")
        last = last.replace(str(path), name)
        return RuntimeError(f"素材の動画を読めませんでした({name})" + (f": {last}" if last else ""))

    if image:
        fr, err = _decode(path, sc, 1, w, h)
        if not fr:
            raise fail(err)
        return {i: fr[0] for i in req}
    n = _n_frames(path)
    to = {i: (min(max(0, i), n - 1) if n > 0 else max(0, i)) for i in set(req)}
    want = sorted(set(to.values()))
    lo, hi = want[0], want[-1]
    if len(want) > 48 or hi - lo + 1 <= 2 * len(want):
        outs = list(range(lo, hi + 1))
        sel = f"between(n\\,{lo}\\,{hi})"
    else:
        outs = want
        sel = "+".join(f"eq(n\\,{i})" for i in want)
    fr, err = _decode(path, f"select={sel},{sc}", len(outs), w, h)
    if not fr:
        raise fail(err)
    got = dict(zip(outs, fr))
    if any(i not in got for i in want):
        # コマ数の見積もりより素材が短い: 本当の最後のコマで埋める(並びの最後まで読めていれば、それが最後のコマ)
        if len(fr) < len(outs) and outs == list(range(lo, hi + 1)):
            tail = fr[-1]
        else:
            tl, _e = _decode(path, sc, 4096, w, h, pre=["-sseof", "-1"])
            tail = tl[-1] if tl else fr[-1]
        for i in want:
            got.setdefault(i, tail)
    return {i: got[to[i]] for i in req}


def _small_size(W: int, H: int) -> tuple[int, int]:
    return DETECT_W, max(2, int(round(DETECT_W * H / W / 2)) * 2)


def _detect_piece(p: dict, ctx: SimpleNamespace, k: int) -> list[dict]:
    """1 つの下の絵の区間の中の切り替わり(タイムラインのコマ)。"""
    n = p["f1"] - p["f0"]
    if n < 3 or p["image"]:
        return []
    ratio = _fps_ratio(p["path"], False, ctx.fps)
    idx = [_src_index(p, f, ratio, ctx.fps) for f in range(p["f0"], p["f1"])]
    sw, sh = _small_size(ctx.W, ctx.H)
    got = _grab(p["path"], False, idx, sw, sh, small=True)
    F = np.stack([got[i] for i in idx])
    out = []
    for t in satsuei_fx.detect_transitions(F, K=max(2, int(k))):
        if t["kind"] == "hard":
            out.append({"kind": "hard", "at": p["f0"] + int(t["at"]), "clip_id": p["clip_id"]})
        else:
            out.append({"kind": t["kind"], "t0": p["f0"] + int(t["t0"]), "t1": p["f0"] + int(t["t1"]),
                        "fit": t.get("fit"), "clip_id": p["clip_id"]})
    return out


def _range(body_start: Optional[int], body_dur: Optional[int], lanes) -> tuple[int, int]:
    if body_start is None or body_dur is None:
        ext = _extent(lanes)
        if ext is None:
            raise HTTPException(status_code=422, detail="下に絵(Shots などの素材のクリップ)がありません")
        a, b = ext
        if body_start is not None:
            a = max(a, int(body_start))
        if body_dur is not None:
            b = a + int(body_dur)
    else:
        a, b = int(body_start), int(body_start) + int(body_dur)
    if a < 0 or b <= a:
        raise HTTPException(status_code=422, detail="位置と長さを確かめてください")
    if b - a > MAX_RANGE:
        raise HTTPException(status_code=422, detail=f"一度に扱えるのは {MAX_RANGE} コマまでです")
    return a, b


# ── 下の絵の配置(⇔比較表示) ────────────────────────────────────────────────

def _compose(img: np.ndarray, lay: Optional[dict], W: int, H: int) -> np.ndarray:
    """画面いっぱいに合わせた下の絵(W×H)を、そのトラックの配置の矩形へ入れた画面(外は黒)。書き出しの
    _layout_pass と同じ大きさ・位置(contain = 収める / cover = 埋めてはみ出しを切る)。配置が無ければそのまま。"""
    if not lay:
        return img
    iw = max(2, int(round(W * lay["w"])) // 2 * 2)
    ih = max(2, int(round(H * lay["h"])) // 2 * 2)
    ox, oy = int(round(W * lay["x"])), int(round(H * lay["y"]))
    k = max(iw / W, ih / H) if lay.get("fit") == "cover" else min(iw / W, ih / H)
    sw, sh = max(1, int(round(W * k))), max(1, int(round(H * k)))
    sm = cv2.resize(img, (sw, sh), interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_LANCZOS4)
    box = np.zeros((ih, iw, 3), np.uint8)
    # 矩形の中でまん中に置く(cover ははみ出しを切る、contain は余りを黒)
    sx, sy = max(0, (sw - iw) // 2), max(0, (sh - ih) // 2)
    dx, dy = max(0, (iw - sw) // 2), max(0, (ih - sh) // 2)
    cw, ch = min(iw - dx, sw - sx), min(ih - dy, sh - sy)
    box[dy:dy + ch, dx:dx + cw] = sm[sy:sy + ch, sx:sx + cw]
    out = np.zeros((H, W, 3), np.uint8)
    x0, y0, x1, y1 = max(0, ox), max(0, oy), min(W, ox + iw), min(H, oy + ih)
    if x1 > x0 and y1 > y0:
        out[y0:y1, x0:x1] = box[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
    return out


def _fit_view(img: np.ndarray, lay: Optional[dict], ctx: SimpleNamespace) -> np.ndarray:
    """自動で合わせるときに測る所: 撮影の効く矩形(撮影トラックの配置)と、下の絵の矩形の重なり(配置が無ければ全体)。"""
    rect = getattr(ctx, "layout", None)
    if not lay and not rect:
        return img
    full = _compose(img, lay, ctx.W, ctx.H)
    ov = _rect_overlap(rect, lay)
    if ov is None:
        return full
    x0, y0 = int(round(ov[0] * ctx.W)), int(round(ov[1] * ctx.H))
    x1, y1 = int(round(ov[2] * ctx.W)), int(round(ov[3] * ctx.H))
    return full[y0:y1, x0:x1] if x1 - x0 >= 8 and y1 - y0 >= 8 else full


def _blank(img: np.ndarray) -> bool:
    """自動で合わせるのに使えない絵か(白く飛んでいる・ほぼ 1 色)。"""
    hh, ww = img.shape[:2]
    sm = cv2.resize(img, (max(1, int(round(96 * ww / max(1, hh)))), 96), interpolation=cv2.INTER_AREA)
    Y = cv2.cvtColor(sm, cv2.COLOR_BGR2RGB).astype(np.float32) @ (satsuei_fx.LUMA / 255)
    return float((Y > 0.9).mean() * 100) > BLANK_WHITE or float(Y.std()) < BLANK_STD


# ── プリセット ───────────────────────────────────────────────────────────────

def _load_user_presets() -> dict:
    from app.services import settings_store
    v = settings_store._load().get(USER_PRESETS_KEY)
    return v if isinstance(v, dict) else {}


def _save_user_presets(presets: dict) -> None:
    # settings_store.set_many は設定画面の項目(KEYS)しか書かないので、同じファイルへ同じ鍵で直接書く
    # (KEYS に入れると設定画面に dict がそのまま並んでしまう)
    from app.services import settings_store
    with settings_store._LOCK:
        cur = settings_store._load()
        cur[USER_PRESETS_KEY] = presets
        settings_store._PATH.parent.mkdir(parents=True, exist_ok=True)
        settings_store._PATH.write_text(json.dumps(cur, ensure_ascii=False, indent=1), encoding="utf-8")


def _target_of(t) -> Optional[list[float]]:
    """[暗部, 中間] の 2 つの有限の数 → そのまま / それ以外は None。"""
    if not isinstance(t, (list, tuple)) or len(t) != 2:
        return None
    try:
        v = [float(t[0]), float(t[1])]
    except (TypeError, ValueError, OverflowError):
        return None
    return v if all(math.isfinite(x) for x in v) else None


def _preset(name: str) -> tuple[dict, Optional[list[float]]]:
    """プリセット名 → (設定(preset = 名前), 自動で合わせる目標)。最初からあるものが先、次に自分で保存したもの
    (目標は保存したときに決めたもの = 元にしたプリセットの目標。put_user_presets を見る)。"""
    if name in satsuei_fx.PRESETS:
        return satsuei_fx.preset_params(name), copy.deepcopy(satsuei_fx.PRESETS[name]["target"])
    user = _load_user_presets()
    if name in user and isinstance(user[name], dict):
        P = satsuei_fx.normalize({**user[name], "preset": name})
        P.pop("target", None)                 # 目標はプリセットの持ち物(クリップの設定には入れない。合わせた目標は fit に残る)
        return P, _target_of(user[name].get("target"))
    raise HTTPException(status_code=422, detail=f"プリセット「{name}」がありません")


def _fit_target(P: dict) -> Optional[list[float]]:
    """クリップの設定 → 自動で合わせる目標(最初からあるプリセット → 前に合わせた目標 → 自分のプリセットの目標)。"""
    name = P.get("preset") or ""
    if name in satsuei_fx.PRESETS:
        return copy.deepcopy(satsuei_fx.PRESETS[name]["target"])
    fit = P.get("fit") if isinstance(P.get("fit"), dict) else {}
    t = _target_of(fit.get("target"))
    if t is None and name:
        u = _load_user_presets().get(name)
        t = _target_of(u.get("target")) if isinstance(u, dict) else None
    return t if t is not None else _target_of(P.get("target"))


# ── 区切り方 ─────────────────────────────────────────────────────────────────

def _segments(f0: int, f1: int, trans: list[dict], split: bool, head: Optional[tuple[int, int]] = None) -> list[dict]:
    """1 つの下の絵の区間 [f0, f1) → 撮影クリップの区間 [{start, end(含まない), tf}](tf = 頭の遷移のコマ数)。
    ハードカット at → 新しいクリップは at から。溶け・一部から替わる t0..t1 → 前のクリップは t1 まで(t1+1 で終わる)、
    後のクリップは t0 から transition_in='cross'・tf = t1 − t0 + 1(重なりの間、2 つの撮影を混ぜる)。
    前のクリップだけが効く区間・最後のクリップが MIN_SEG コマより短くなる区切りは使わない。
    head = (頭, tf): 最初のクリップの頭と遷移(下の絵のクリップ同士の溶け・前に残すクリップとの溶けの続き)。"""
    h0, htf = head if head else (f0, 0)
    segs = [{"start": int(h0), "end": f1, "tf": int(htf)}]
    if not split:
        return segs
    for t in sorted(trans, key=lambda t: t.get("at", t.get("t0", 0))):
        if t["kind"] == "hard":
            s = e = int(t["at"])
        else:
            s, e = int(t["t0"]), int(t["t1"]) + 1
        cur = segs[-1]
        if s < f0 or s - (cur["start"] + cur["tf"]) < MIN_SEG or f1 - e < MIN_SEG or e < s:
            continue
        cur["end"] = e
        segs.append({"start": s, "end": f1, "tf": e - s})
    return segs


def _solo_mid(segs: list[dict], k: int) -> int:
    """k 番目のクリップだけが効く区間(前の遷移の後〜次のクリップの頭)のまん中のコマ。"""
    s = segs[k]
    a = s["start"] + s["tf"]
    b = segs[k + 1]["start"] if k + 1 < len(segs) else s["end"]
    return (a + b) // 2 if b > a else (s["start"] + s["end"] - 1) // 2


def _subtract(f0: int, f1: int, covered: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """[f0, f1) から、すでに撮影クリップのある区間を除いた残り。"""
    out = [(f0, f1)]
    for a, b in covered:
        nxt = []
        for x, y in out:
            if b <= x or a >= y:
                nxt.append((x, y))
                continue
            if x < a:
                nxt.append((x, a))
            if b < y:
                nxt.append((b, y))
        out = nxt
    return [(x, y) for x, y in out if y > x]


def _below_head(prev: Optional[dict], p: dict, lanes: list[list[dict]], fps: float) -> tuple[int, str]:
    """下の絵のクリップ同士の溶け(Shots の 2 本の間の transition_in)→ (撮影もそこで溶かすコマ数, カーブ)。
    書き出しと同じ窓: ベースのトラック = 前と続く 2 本の xfade(B の頭から min(tf, 尺の 0.9, 2 秒)、線形)、
    上のトラック = 同じトラックで前のクリップに重なる所(B の頭から min(tf, 重なり)、B のカーブ。プレビューもそのカーブ)。
    前の区間が同じトラックの別のクリップで、ちょうど B の頭で替わるときだけ。"""
    if prev is None or prev["f1"] != p["f0"] or p["f0"] != p["start"]:
        return 0, ""
    if prev["track_id"] != p["track_id"] or prev["clip_id"] == p["clip_id"] or not p.get("tin") or p.get("tf", 0) <= 0:
        return 0, ""
    if p.get("base"):
        if p["tf"] / fps < 0.02:
            return 0, ""
        tf = min(p["tf"], math.ceil(0.9 * p["dur"] - 1e-6), math.ceil(2.0 * fps - 1e-6))
        ease = "linear"
    else:
        lane = next((ln for ln in lanes if ln and ln[0]["track_id"] == p["track_id"]), [])
        prev_end = max([c["end"] for c in lane if c["start"] < p["start"] and c["clip_id"] != p["clip_id"]], default=0)
        tf = min(p["tf"], prev_end - p["start"])
        ease = p.get("tease") or "linear"
    tf = min(tf, p["f1"] - p["f0"])
    return (int(tf), ease) if tf >= 1 else (0, "")


def _sub_head(sub: dict, trans: list[dict], kept: list[dict]) -> Optional[tuple[int, int, str]]:
    """区間 sub の最初のクリップの頭 → (頭, tf, カーブ) / None(sub の頭からふつうに始める)。
    - 下の絵の区間の頭(下のクリップ同士の溶け)から始まる: その溶け。
    - 前に残す撮影クリップ K(ロック中・replace なし)が sub の頭で終わり、溶けの窓の途中で切れている: 溶けの頭から
      K に重ねて始め、K の終わりまでで混ぜ終える(K の溶けを切らない)。"""
    x = sub["f0"]
    htf, hease = sub.get("head", (0, ""))
    if x == sub["pf0"]:
        return (x, htf, hease) if htf > 0 else None
    k = next((e for e in kept if e["end"] == x and e["start"] < x), None)
    if k is None:
        return None
    wins = [(sub["pf0"], sub["pf0"] + htf, hease)] if htf > 0 else []
    wins += [(int(t["t0"]), int(t["t1"]) + 1, "ease") for t in trans if t["kind"] != "hard"]
    for t0, t1, ease in sorted(wins, reverse=True):
        if t0 < x <= t1 and k["start"] <= t0 and t0 >= sub["pf0"]:
            return t0, x - t0, ease
    return None


def _fit_frames(sub: dict, plan: list[dict], ctx: SimpleNamespace) -> None:
    """各クリップの自動で合わせるコマ(q["mid"])の絵を読む → q["img"]。まん中のコマが白く飛んでいる・ほぼ 1 色なら、
    そのクリップの中(溶けの間も含む)で、まん中に近い順に使える絵のコマを探す(見つからなければ q["img"] = None)。"""
    ratio = _fps_ratio(sub["path"], sub["image"], ctx.fps)
    src = lambda f: _src_index(sub, f, ratio, ctx.fps)  # noqa: E731
    got = _grab(sub["path"], sub["image"], [src(q["mid"]) for q in plan], ctx.W, ctx.H, small=False)
    for q in plan:
        img = _fit_view(got[src(q["mid"])], sub.get("layout"), ctx)
        q["img"] = img
        if sub["image"] or not _blank(img):
            continue
        lo, hi = max(q["start"], sub["pf0"]), min(q["end"], sub["pf1"])
        cand = sorted({lo + (hi - 1 - lo) * j // max(1, FIT_PROBES - 1) for j in range(FIT_PROBES)} - {q["mid"]},
                      key=lambda f: abs(f - q["mid"]))
        alt = _grab(sub["path"], False, [src(f) for f in cand], ctx.W, ctx.H, small=False) if cand else {}
        q["img"] = None
        for f in cand:
            im = _fit_view(alt[src(f)], sub.get("layout"), ctx)
            if not _blank(im):
                q["img"], q["mid"] = im, f
                break


def _plan_sub(sub: dict, trans: list[dict], kept: list[dict], ctx: SimpleNamespace, split: bool, auto_fit: bool,
              params0: dict, target: Optional[list[float]]) -> list[dict]:
    """下の絵の区間の、撮影クリップの無い所 sub → 撮影クリップの案 [{start, end, tf, ease, piece, mid, params?}]。
    trans = その下の絵の区間(全体)の切り替わり。auto_fit なら、各クリップだけが効く区間のまん中のコマで明るさを合わせる。
    MIN_SEG より短い残り(前後の撮影クリップの間の数コマ)は、隣の撮影クリップと同じ設定で埋める(1〜2 コマだけ別の色にしない)。"""
    if sub["f1"] - sub["f0"] < MIN_SEG and (sub["f0"], sub["f1"]) != (sub["pf0"], sub["pf1"]):
        nb = next((e for e in kept if e["end"] == sub["f0"] and sub["f0"] > sub["pf0"]), None) \
            or next((e for e in kept if e["start"] == sub["f1"] and sub["f1"] < sub["pf1"]), None)
        if nb is not None and nb.get("params") is not None:
            return [{"start": sub["f0"], "end": sub["f1"], "tf": 0, "ease": "linear", "piece": sub,
                     "mid": (sub["f0"] + sub["f1"] - 1) // 2, "params": copy.deepcopy(nb["params"])}]
    head = _sub_head(sub, trans, kept)
    segs = _segments(sub["f0"], sub["f1"], trans, split, head[:2] if head else None)
    plan = [{**s, "ease": (head[2] if head and k == 0 else "ease"), "piece": sub, "mid": _solo_mid(segs, k)}
            for k, s in enumerate(segs)]
    if auto_fit and plan:
        _fit_frames(sub, plan, ctx)
        for q in plan:
            img = q.pop("img", None)
            if img is None:
                continue                      # 使える絵が無い(全部白く飛んでいる): プリセットのまま
            P, _before, _after = satsuei_fx.auto_fit(params0, img, target)
            P["fit"]["frame"] = q["mid"]
            q["params"] = P
    return plan


def _link_transitions(plan: list[dict], kept: list[dict]) -> None:
    """遷移の窓を重なりにする: 撮影クリップ B の頭に遷移(tf > 0)があり、ちょうど B の頭で終わる新しいクリップ A が
    あれば、A を B の頭 + tf まで伸ばす(下の絵のクリップ同士の溶け・残す撮影クリップの溶けに、前の色を残す)。
    そのあと、頭に重なる撮影クリップの無い遷移は消す(混ぜる相手がいない)。"""
    starts = [(q["start"], q["tf"], q["end"]) for q in plan] + [(e["start"], e["tf"], e["end"]) for e in kept if e["tin"]]
    for q in plan:
        nxt = [(s, tf, e) for s, tf, e in starts if s == q["end"] and tf > 0]
        if nxt:
            s, tf, e = nxt[0]
            q["end"] = min(e, s + tf)
    spans = [(q["start"], q["end"], id(q)) for q in plan] + [(e["start"], e["end"], -1) for e in kept]
    for q in plan:
        if q["tf"] > 0 and not any(a <= q["start"] < b for a, b, ref in spans if ref != id(q)):
            q["tf"], q["ease"] = 0, "linear"


def _bgr_to_rgb_f(img: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) * np.float32(1 / 255)


def _track_lock(track_id: int) -> threading.Lock:
    with _LAY_LOCKS_GUARD:
        return _LAY_LOCKS.setdefault(int(track_id), threading.Lock())


# ── API ─────────────────────────────────────────────────────────────────────

@router.get("/meta")
def meta():
    return {"defaults": satsuei_fx.DEFAULT, "ranges": satsuei_fx.RANGES,
            "presets": {k: {"label": v["label"], "params": v["params"], "target": v["target"]}
                        for k, v in satsuei_fx.PRESETS.items()}}


@router.post("/detect")
def detect(body: DetectBody):
    """下の絵の中の切り替わり(ハードカット・溶け・一部から替わる)と、下のクリップが替わるコマ(タイムラインのコマ)。"""
    with Session(engine) as session:
        ctx = _ctx(session, body.track_id)
        lanes = _lanes(session, ctx)
    a, b = _range(body.start_frame, body.duration_frames, lanes)
    pieces = _pieces(lanes, a, b)
    trans: list[dict] = []
    try:
        with ThreadPoolExecutor(max_workers=max(1, min(LAY_WORKERS, len(pieces)))) as ex:
            for tr in ex.map(lambda p: _detect_piece(p, ctx, body.k), pieces):
                trans += tr
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e))
    bounds = sorted({x for p in pieces for x in (p["f0"], p["f1"]) if a < x < b})
    return {"transitions": trans, "clip_bounds": bounds, "range": [a, b],
            "pieces": [{"start_frame": p["f0"], "end_frame": p["f1"], "clip_id": p["clip_id"], "asset_id": p["asset_id"]}
                       for p in pieces]}


def _satsuei_rows(session: Session, track_id: int) -> list[dict]:
    out = []
    for c in session.exec(select(Clip).where(Clip.track_id == track_id)).all():
        if (c.kind or "") != CLIP_KIND:
            continue
        try:
            at = json.loads(c.attrs_json or "{}")
            P = satsuei_fx.normalize(at.get("satsuei")) if isinstance(at, dict) else None
        except (TypeError, ValueError):
            P = None
        tin = c.transition_in or ""
        out.append({"id": c.id, "start": int(c.start_frame), "end": int(c.start_frame + c.duration_frames),
                    "locked": bool(c.locked), "tin": tin, "tf": int(c.transition_frames or 0) if tin else 0, "params": P})
    return out


@router.post("/lay")
def lay(body: LayBody):
    """範囲(既定 = 下の絵のクリップ全体)に撮影クリップを敷く。下のクリップ 1 本ごとに 1 本、split なら
    その中の切り替わりでさらに分ける。auto_fit なら各クリップのまん中のコマで明るさを合わせる。
    下のクリップ同士が溶けて替わる所(transition_in)は、撮影も同じコマで溶かす(前を伸ばして重ね、後を cross)。
    すでに撮影クリップのある区間は飛ばす(replace なら先に消す。範囲からはみ出すクリップは、その端まで範囲を広げて
    敷き直す。🔒ロック中のものは消さずに飛ばす)。同じトラックへの敷き直しは 1 つずつ(後の方は前が終わってから)。"""
    params0, target = _preset(body.preset)
    with _track_lock(body.track_id):
        return _lay_locked(body, params0, target)


def _lay_locked(body: LayBody, params0: dict, target: Optional[list[float]]) -> dict:
    with Session(engine) as session:
        ctx = _ctx(session, body.track_id)
        lanes = _lanes(session, ctx)
        existing = _satsuei_rows(session, ctx.track_id)
    a, b = _range(body.start_frame, body.duration_frames, lanes)
    if body.replace:
        # 範囲からはみ出す撮影クリップを消すなら、その外の分も敷き直す(消したまま穴にしない)
        while True:
            hit = [e for e in existing if e["start"] < b and e["end"] > a and not e["locked"]]
            na, nb = min([a] + [e["start"] for e in hit]), max([b] + [e["end"] for e in hit])
            if (na, nb) == (a, b):
                break
            a, b = na, nb
        if b - a > MAX_RANGE:
            raise HTTPException(status_code=422, detail=f"一度に扱えるのは {MAX_RANGE} コマまでです")
    hits = [e for e in existing if e["start"] < b and e["end"] > a]
    to_delete = [e["id"] for e in hits if body.replace and not e["locked"]]
    kept = [e for e in existing if e["id"] not in set(to_delete)]
    covered = sorted((e["start"], e["end"]) for e in hits if e["id"] not in set(to_delete))

    # 区切りを決める(DB の接続は閉じたまま)。下の絵の区間ごとに別々なので、いくつか並べて計算する
    pieces = _pieces(lanes, a, b)
    for i, p in enumerate(pieces):
        p["head"] = _below_head(pieces[i - 1] if i else None, p, lanes, ctx.fps)
    subs_of = [[{**p, "f0": x, "f1": y, "pf0": p["f0"], "pf1": p["f1"]} for x, y in _subtract(p["f0"], p["f1"], covered)]
               for p in pieces]
    work = [(p, subs) for p, subs in zip(pieces, subs_of) if subs]

    def plan_piece(item):
        p, subs = item
        tr = _detect_piece(p, ctx, 10) if body.split else []
        qs = []
        for sp in subs:
            qs += _plan_sub(sp, tr, kept, ctx, body.split, body.auto_fit, params0, target)
        return qs, tr

    plan: list[dict] = []          # {start, end, tf, ease, piece, mid, params?}
    trans_all: list[dict] = []
    try:
        with ThreadPoolExecutor(max_workers=max(1, min(LAY_WORKERS, len(work)))) as ex:
            for qs, tr in ex.map(plan_piece, work):
                plan += qs
                trans_all += tr
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e))
    plan.sort(key=lambda q: (q["start"], q["end"]))
    _link_transitions(plan, kept)

    with Session(engine) as session:
        if session.get(Track, ctx.track_id) is None:
            raise HTTPException(status_code=409, detail="撮影トラックが消されました。もう一度敷いてください")
        # 計算の間に(手で)置かれた撮影クリップとは重ねない
        known = {e["id"] for e in existing}
        fresh = [(e["start"], e["end"]) for e in _satsuei_rows(session, ctx.track_id) if e["id"] not in known]
        plan = [q for q in plan if not any(s < q["end"] and q["start"] < t for s, t in fresh)]
        deleted = []
        for cid in to_delete:
            c = session.get(Clip, cid)
            if c is not None and (c.kind or "") == CLIP_KIND and c.track_id == ctx.track_id and not c.locked:
                session.delete(c)
                deleted.append(cid)
        created = []
        for q in plan:
            P = q.get("params") or params0
            tf = int(q["tf"])
            c = Clip(track_id=ctx.track_id, asset_id=None, start_frame=int(q["start"]),
                     duration_frames=int(q["end"] - q["start"]), kind=CLIP_KIND,
                     attrs_json=json.dumps({"satsuei": P}, ensure_ascii=False), opacity=1.0, blend="normal",
                     transition_in="cross" if tf > 0 else "", transition_frames=tf,
                     transition_ease=(q.get("ease") or "ease") if tf > 0 else "linear")
            session.add(c)
            created.append(c)
        session.commit()
        for c in created:
            session.refresh(c)
        from app.services import command_api
        if deleted:
            command_api.record_op(ctx.project_id, "delete_clip", session,
                                  detail=f"🎬 撮影 {len(deleted)} 本 track {ctx.track_id}", actor="user")
        if created:
            command_api.record_op(ctx.project_id, "add_clip", session,
                                  detail=f"🎬 撮影 {len(created)} 本 track {ctx.track_id} @ frame {a}〜{b} ({body.preset})",
                                  actor="user")
        return {"created": [ClipRead.model_validate(c).model_dump() for c in created], "deleted": deleted,
                "transitions": trans_all, "range": [a, b]}


def _load_clip(session: Session, clip_id: int) -> tuple[Clip, SimpleNamespace]:
    clip = session.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    if (clip.kind or "") != CLIP_KIND:
        raise HTTPException(status_code=422, detail="撮影クリップではありません")
    return clip, _ctx(session, clip.track_id)


def _clip_solo_mid(clip: Clip, others: list[tuple[int, int]]) -> int:
    """このクリップだけが効く区間(頭の遷移の後〜後から重なるクリップの頭)のまん中。"""
    s, e = int(clip.start_frame), int(clip.start_frame + clip.duration_frames)
    a = s + (int(clip.transition_frames or 0) if (clip.transition_in or "") else 0)
    b = min([o for o, _oe in others if s < o < e] or [e])
    return (a + b) // 2 if b > a else (s + e - 1) // 2


def _below_frame(lanes, ctx: SimpleNamespace, f: int, view: bool = False) -> Optional[np.ndarray]:
    """コマ f の下の絵(BGR、W×H。下のトラックに配置があれば、その矩形に入れた画面)。view = 自動で合わせるときに
    測る所だけ(_fit_view)。下に絵が無ければ None。"""
    ps = _pieces(lanes, f, f + 1)
    if not ps:
        return None
    p = ps[0]
    idx = _src_index(p, f, _fps_ratio(p["path"], p["image"], ctx.fps), ctx.fps)
    img = _grab(p["path"], p["image"], [idx], ctx.W, ctx.H, small=False)[idx]
    return _fit_view(img, p.get("layout"), ctx) if view else _compose(img, p.get("layout"), ctx.W, ctx.H)


@router.post("/clips/{clip_id}/autofit")
def autofit(clip_id: int, body: AutofitBody):
    """このクリップの設定を自動で合わせた案を返す(書き込まない。フロントが PATCH して元に戻せるようにする)。
    preset を渡せばそのプリセットから、無ければ今の設定から(前に合わせた記録があれば、合わせる前の値に戻してから
    = 何度押しても同じ案。satsuei_fx.refit_base)。"""
    with Session(engine) as session:
        clip, ctx = _load_clip(session, clip_id)
        try:
            attrs = json.loads(clip.attrs_json or "{}")
            attrs = attrs if isinstance(attrs, dict) else {}
        except (TypeError, ValueError):
            attrs = {}
        others = [(int(c.start_frame), int(c.start_frame + c.duration_frames))
                  for c in session.exec(select(Clip).where(Clip.track_id == clip.track_id)).all()
                  if (c.kind or "") == CLIP_KIND and c.id != clip.id]
        s, e = int(clip.start_frame), int(clip.start_frame + clip.duration_frames)
        mid = _clip_solo_mid(clip, others)
        lanes = _lanes(session, ctx)
    if body.preset:
        P, target = _preset(body.preset)
    else:
        P = satsuei_fx.refit_base(attrs.get("satsuei"))
        target = _fit_target(P)
    if body.target is not None:
        t = _target_of(body.target)
        if t is None:
            raise HTTPException(status_code=422, detail="target は [暗部, 中間] の 2 つの数です")
        target = t
    f = mid if body.frame is None else min(e - 1, max(s, int(body.frame)))
    try:
        img = _below_frame(lanes, ctx, f, view=True)
        if img is not None and _blank(img):
            # 白く飛んだ・ほぼ 1 色のコマでは合わせない(/lay の _fit_frames と同じ): クリップの中で近い順に使えるコマを探す
            cand = sorted({s + (e - 1 - s) * j // max(1, FIT_PROBES - 1) for j in range(FIT_PROBES)} - {f},
                          key=lambda g: abs(g - f))
            got = None
            for g in cand:
                im = _below_frame(lanes, ctx, g, view=True)
                if im is not None and not _blank(im):
                    got = (g, im)
                    break
            if got is None:
                raise HTTPException(status_code=422, detail="下の絵が白く飛んでいるか、ほぼ 1 色なので、明るさを合わせられません")
            f, img = got
    except RuntimeError as ex:
        raise HTTPException(status_code=422, detail=str(ex))
    if img is None:
        raise HTTPException(status_code=422, detail="このコマの下に絵がありません")
    P, before, after = satsuei_fx.auto_fit(P, img, target)
    P["fit"]["frame"] = f
    return {"params": P, "before": before, "after": after, "frame": f}


@router.get("/clips/{clip_id}/still")
def still(clip_id: int, frame: Optional[int] = None, w: int = 960):
    """下の絵の 1 コマに、このクリップの設定と効きを書き出しと同じ計算(Python)で掛けた JPEG。
    下の絵は Shots など素材のクリップだけ(ほかの重ね・ほかの撮影クリップ・最後の共通グレード・ズームとパンは入れない)。
    下のトラックに配置(⇔比較表示)があれば、書き出しと同じくその矩形に入れて(外は黒)、撮影トラックの配置があれば
    その矩形の中だけに掛ける。"""
    with Session(engine) as session:
        clip, ctx = _load_clip(session, clip_id)
        spec = satsuei_fx.spec_from_clip(clip)
        others = [(int(c.start_frame), int(c.start_frame + c.duration_frames))
                  for c in session.exec(select(Clip).where(Clip.track_id == clip.track_id)).all()
                  if (c.kind or "") == CLIP_KIND and c.id != clip.id]
        s, e = int(clip.start_frame), int(clip.start_frame + clip.duration_frames)
        mid = _clip_solo_mid(clip, others)
        lanes = _lanes(session, ctx)
    f = mid if frame is None else min(e - 1, max(s, int(frame)))
    try:
        img = _below_frame(lanes, ctx, f)
    except RuntimeError as ex:
        raise HTTPException(status_code=422, detail=str(ex))
    below = img is not None
    if img is None:
        img = np.zeros((ctx.H, ctx.W, 3), np.uint8)
    y = satsuei_fx.apply_layer(_bgr_to_rgb_f(img), [spec], f, {}, ctx.layout)
    out = cv2.cvtColor(np.clip(np.asarray(y, np.float32) * 255 + 0.5, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
    ow = max(64, min(int(w), ctx.W))
    if ow < ctx.W:
        oh = max(2, int(round(ow * ctx.H / ctx.W / 2)) * 2)
        out = cv2.resize(out, (ow, oh), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise HTTPException(status_code=500, detail="JPEG にできませんでした")
    return Response(content=buf.tobytes(), media_type="image/jpeg",
                    headers={"Cache-Control": "no-store", "X-Satsuei-Frame": str(f),
                             "X-Satsuei-Below": "1" if below else "0"})


@router.get("/user-presets")
def get_user_presets():
    return {"presets": {k: satsuei_fx.normalize(v) for k, v in _load_user_presets().items() if isinstance(v, dict)}}


@router.put("/user-presets")
def put_user_presets(body: UserPresetsBody):
    """自分のプリセットをまとめて置き換える(名前 → 設定)。最初からあるプリセットと同じ名前は使えない。
    「明るさを合わせる」の目標(target)も一緒に残す: 渡された target → 前に合わせた目標(fit.target) →
    元にしたプリセット(preset の名前)の目標 の順。どれも無ければ None(明るさは動かさない)。"""
    stored = _load_user_presets()
    incoming = body.presets or {}
    out: dict = {}
    for name, params in incoming.items():
        n = str(name).strip()
        if not n or len(n) > 64:
            raise HTTPException(status_code=422, detail="プリセットの名前は 1〜64 文字にしてください")
        if n in satsuei_fx.PRESETS:
            raise HTTPException(status_code=422, detail=f"「{n}」は最初からあるプリセットの名前です")
        if n in out:
            raise HTTPException(status_code=422, detail=f"「{n}」という名前が 2 つあります(前後の空白は数えません)")
        if not isinstance(params, dict):
            raise HTTPException(status_code=422, detail=f"「{n}」の設定が読めません")
        fit = params.get("fit") if isinstance(params.get("fit"), dict) else {}
        t = _target_of(params.get("target"))
        if t is None:
            t = _target_of(fit.get("target"))
        src = params.get("preset")
        if t is None and isinstance(src, str) and src in satsuei_fx.PRESETS:
            t = copy.deepcopy(satsuei_fx.PRESETS[src]["target"])
        if t is None and isinstance(src, str) and src != n:
            for pool in (incoming, stored):
                u = pool.get(src)
                if isinstance(u, dict) and _target_of(u.get("target")) is not None:
                    t = _target_of(u.get("target"))
                    break
        out[n] = {**satsuei_fx.normalize({**params, "preset": n}), "target": t}
    if len(out) > 100:
        raise HTTPException(status_code=422, detail="プリセットは 100 個までです")
    _save_user_presets(out)
    return {"presets": out}
