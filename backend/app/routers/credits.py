"""🔤 Live credit clips API (app/services/credit_fx.py; contract credits_live/contract/credit_contract_v1.json §4).

  GET  /api/credits/meta                     contract copy: defaults, ranges, fonts (ok?), map/uniform keys, textures …
  POST /api/credits/maps                     {credit, box:[w,h], content:[Wc,Hc]} -> KCM1 maps (gzip), X-Credit-Key.
                                             Stateless: works for unsaved edits, never touches the DB.
  GET  /api/credits/clips/{clip_id}/maps     ?w=&h= (box; default = project size) -> the same bytes from the stored attrs
  POST /api/credits/still                    (P2) {credit, start_frame, duration_frames, opacity, frame, fps, box, content,
                                             picture_png_b64} -> PNG of the box computed by numpy (= the export formula)
  POST /api/credits/clips                    convenience (additive, not required by the contract): create a credit clip
                                             (track 字幕 created at the top if missing). The UI may keep using /api/clips.

Master builds: at most 2 at once (credit_fx._BUILD_SEM), cached (memory LRU 6 + disk data/credit_cache/master).
Maps bytes: memory LRU (48 entries, 192 MB cap). Bodies are validated (422); a box side outside 16..8192 is 413;
a scale design -> box above MAX_K (1.5) or a map canvas above MAX_CANVAS_PX (4 M px) is 413;
a missing font is 500 「フォントが見つかりません: <file>」; a card too large to build is 422 「字幕が大きすぎます(…)」.
"""
from __future__ import annotations

import base64
import json
import threading
from collections import OrderedDict
from typing import Any, Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.db.database import engine
from app.models import Clip, Project, Track
from app.services import credit_fx as CF

router = APIRouter(prefix="/credits", tags=["credits"])

BOX_MIN, BOX_MAX = 16, 8192
# The maps API runs inside the production backend process: cap the scale design -> box (K = 1 is the 2560 export of a
# 1344x768 project, 1.5 = 3840 wide) and the map canvas size, so a script/curl cannot make map_fields allocate many GB
# (review 2026-11-01). The export subprocess (credit_fx.render) is not limited by these.
MAX_K = 1.5
MAX_CANVAS_PX = 4_000_000
_BYTES: "OrderedDict[str, bytes]" = OrderedDict()
_BYTES_MAX_N = 48
_BYTES_MAX_TOTAL = 192 << 20
_BYTES_LOCK = threading.Lock()
TRACK_NAME = "字幕"


class MapsBody(BaseModel):
    credit: Any = None
    box: list = Field(...)
    content: list = Field(...)


class StillBody(BaseModel):
    credit: Any = None
    start_frame: int
    duration_frames: int
    opacity: Optional[float] = 1.0
    frame: int
    fps: float = 24.0
    box: list
    content: list
    picture_png_b64: str


class NewClipBody(BaseModel):
    project_id: int
    start_frame: int = 0
    duration_frames: Optional[int] = None
    track_id: Optional[int] = None
    credit: Any = None


def _pair(v: Any, what: str, lo: int, hi: int, status: int) -> tuple[int, int]:
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        raise HTTPException(status_code=422, detail=f"{what} は [幅, 高さ] で指定してください")
    out = []
    for x in v:
        if isinstance(x, bool) or not isinstance(x, (int, float)) or x != x or int(x) != x:
            raise HTTPException(status_code=422, detail=f"{what} は整数で指定してください")
        out.append(int(x))
    if not all(lo <= x <= hi for x in out):
        raise HTTPException(status_code=status, detail=f"{what} の大きさは {lo}〜{hi} px にしてください: {out}")
    return out[0], out[1]


def meta() -> dict:
    return {
        "contract_version": CF.CONTRACT_VERSION,
        "maps_version": CF.MAPS_VERSION,
        "clip_kind": CF.CLIP_KIND,
        "design_screen": list(CF.DESIGN),
        "defaults": {"credit": CF.normalize(None)},
        "ranges": CF.RANGES,
        "fonts": CF.fonts_meta(),
        "map_keys": CF.MAP_KEYS_DOC,
        "uniform_keys": CF.UNIFORM_KEYS,
        "textures": CF.TEXTURES,
        "header_fields": CF.HEADER_FIELDS,
        "max_labels": CF.MAX_LABELS,
        "max_glints": CF.MAX_GLINTS,
        "max_text": CF.MAX_TEXT,
        "new_clip_duration_s": CF.NEW_CLIP_DURATION_S,
        "default_pos": list(CF.DEFAULT_POS),
        "box_limits": [BOX_MIN, BOX_MAX],
    }


@router.get("/meta")
def get_meta():
    return meta()


def maps_bytes(credit: Any, box: tuple[int, int], content: tuple[int, int]) -> tuple[bytes, str]:
    """-> (gzip(KCM1), key). Memory LRU by key (the key covers every map key, the box, the content and maps_version)."""
    cn = CF.normalize(credit)
    K = CF.geometry(box, content)["K"]
    if not (K <= MAX_K + 1e-9):
        raise HTTPException(status_code=413, detail=f"枠が画面に対して大きすぎます(倍率 {K:.3f} > {MAX_K}): box {list(box)}, "
                                                    f"content {list(content)}")
    key = CF.maps_key(cn, box, content)
    with _BYTES_LOCK:
        b = _BYTES.get(key)
        if b is not None:
            _BYTES.move_to_end(key)
            return b, key
    try:
        _cn, maps, hdr = CF.card_maps(cn, box, content, max_canvas_px=MAX_CANVAS_PX)
    except CF.CreditError as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    hdr["key"] = key
    gz = CF.gzip_bytes(CF.pack_kcm1(maps, hdr))
    with _BYTES_LOCK:
        _BYTES[key] = gz
        _BYTES.move_to_end(key)
        while len(_BYTES) > _BYTES_MAX_N or (len(_BYTES) > 1 and sum(len(v) for v in _BYTES.values()) > _BYTES_MAX_TOTAL):
            _BYTES.popitem(last=False)
    return gz, key


def _maps_response(gz: bytes, key: str) -> Response:
    return Response(content=gz, media_type="application/octet-stream",
                    headers={"Content-Encoding": "gzip", "X-Credit-Key": key, "Cache-Control": "no-store",
                             "Access-Control-Expose-Headers": "X-Credit-Key"})


@router.post("/maps")
def post_maps(body: MapsBody):
    box = _pair(body.box, "box", BOX_MIN, BOX_MAX, 413)
    content = _pair(body.content, "content", 1, 16384, 422)
    gz, key = maps_bytes(body.credit, box, content)
    return _maps_response(gz, key)


def _credit_clip(session: Session, clip_id: int) -> tuple[Clip, Project]:
    clip = session.get(Clip, clip_id)
    if not clip or (clip.kind or "") != CF.CLIP_KIND:
        raise HTTPException(status_code=404, detail="字幕クリップが見つかりません")
    track = session.get(Track, clip.track_id)
    proj = session.get(Project, track.project_id) if track else None
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    return clip, proj


def clip_credit(clip: Clip) -> Any:
    try:
        a = json.loads(clip.attrs_json or "{}")
    except (ValueError, TypeError):
        a = {}
    return a.get("credit") if isinstance(a, dict) else None


@router.get("/clips/{clip_id}/maps")
def get_clip_maps(clip_id: int, w: Optional[int] = Query(None), h: Optional[int] = Query(None)):
    with Session(engine) as s:                     # read, close, then compute (no DB connection held while building)
        clip, proj = _credit_clip(s, clip_id)
        credit = clip_credit(clip)
        content = (int(proj.width), int(proj.height))
    box = _pair([w if w is not None else content[0], h if h is not None else content[1]], "box", BOX_MIN, BOX_MAX, 413)
    gz, key = maps_bytes(credit, box, content)
    return _maps_response(gz, key)


@router.post("/still")
def post_still(body: StillBody):
    """the numpy result of §6 over the given picture (box-sized PNG) -> PNG (RGB) of the box."""
    import cv2
    box = _pair(body.box, "box", BOX_MIN, BOX_MAX, 413)
    content = _pair(body.content, "content", 1, 16384, 422)
    if body.duration_frames < 1 or not (body.fps > 0):
        raise HTTPException(status_code=422, detail="duration_frames と fps は正の値にしてください")
    raw = body.picture_png_b64.split(",", 1)[-1] if body.picture_png_b64.startswith("data:") else body.picture_png_b64
    try:
        buf = np.frombuffer(base64.b64decode(raw, validate=False), np.uint8)
        img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    except Exception:
        img = None
    if img is None:
        raise HTTPException(status_code=422, detail="picture_png_b64 を画像として読めませんでした")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.dtype != np.uint8:
        raise HTTPException(status_code=422, detail="8 bit の画像にしてください")
    rgb = cv2.cvtColor(img[..., :3], cv2.COLOR_BGR2RGB)
    if (rgb.shape[1], rgb.shape[0]) != box:
        raise HTTPException(status_code=422, detail=f"画像の大きさ {rgb.shape[1]}x{rgb.shape[0]} が box {box} と違います")
    if not (CF.geometry(box, content)["K"] <= MAX_K + 1e-9):
        raise HTTPException(status_code=413, detail="枠が画面に対して大きすぎます")
    try:
        cn, maps, hdr = CF.card_maps(body.credit, box, content, max_canvas_px=MAX_CANVAS_PX)
    except CF.CreditError as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    sc = CF.frame_scalars(cn, hdr, int(body.start_frame), int(body.duration_frames), body.opacity, int(body.frame),
                          float(body.fps))
    out = CF.apply_rgb(rgb.astype(np.float64), maps, hdr, sc)
    out8 = np.clip(np.floor(out + 0.5), 0, 255).astype(np.uint8)
    ok, png = cv2.imencode(".png", cv2.cvtColor(out8, cv2.COLOR_RGB2BGR))
    if not ok:
        raise HTTPException(status_code=500, detail="PNG にできませんでした")
    return Response(content=png.tobytes(), media_type="image/png",
                    headers={"X-Credit-Active": "1" if sc["active"] else "0", "X-Credit-E": f"{sc['e']:.6f}",
                             "X-Credit-G": f"{sc['g']:.6f}", "Cache-Control": "no-store",
                             "Access-Control-Expose-Headers": "X-Credit-Active, X-Credit-E, X-Credit-G"})


@router.post("/clips", status_code=201)
def create_credit_clip(body: NewClipBody):
    """convenience: one credit clip with the contract's new-clip defaults (role 役職, name 名前, pos default) on the
    track 字幕 (made at the top, order = min - 1, when missing) or on track_id. Undo stays client-side."""
    from app.models import ClipRead
    from app.services import command_api
    with Session(engine) as s:
        proj = s.get(Project, body.project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="Project not found")
        created_track = False
        if body.track_id is not None:
            tr = s.get(Track, body.track_id)
            if not tr or tr.project_id != proj.id or tr.track_type != "video":
                raise HTTPException(status_code=422, detail="字幕は同じプロジェクトの映像トラックに置いてください")
        else:
            tracks = s.exec(select(Track).where(Track.project_id == proj.id)).all()
            tr = next((t for t in tracks if t.track_type == "video" and t.name == TRACK_NAME), None)
            if tr is None:
                tr = Track(project_id=proj.id, name=TRACK_NAME, track_type="video",
                           order=min([t.order for t in tracks], default=0) - 1)
                s.add(tr); s.commit(); s.refresh(tr)
                created_track = True
        credit = body.credit if isinstance(body.credit, dict) else {"role": "役職", "name": "名前", "pos": list(CF.DEFAULT_POS)}
        cn = CF.normalize(credit)
        dur = body.duration_frames or max(1, int(round(CF.NEW_CLIP_DURATION_S * float(proj.fps or 24.0))))
        clip = Clip(track_id=tr.id, asset_id=None, start_frame=max(0, int(body.start_frame)), duration_frames=max(1, dur),
                    asset_in_frame=0, kind=CF.CLIP_KIND, attrs_json=json.dumps({"credit": cn}, ensure_ascii=False))
        s.add(clip); s.commit(); s.refresh(clip)
        command_api.record_op(proj.id, "add_clip", s, detail=f"credit on track {tr.id} @ frame {clip.start_frame}", actor="user")
        out = {"clip": json.loads(ClipRead.model_validate(clip).model_dump_json()),
               "track": {"id": tr.id, "name": tr.name, "order": tr.order, "hidden": bool(tr.hidden)},
               "created_track": created_track}
    return JSONResponse(out, status_code=201)
