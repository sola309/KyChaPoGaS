"""
/api/mad — mad-kit shotlist projects (Shot Editor backend).

A "mad project" is a normal KyChaPoGaS project whose video clips are
kind='mg_shot'. data/mad/<project_id>.json links it to its shotlist:
  {project_id, shotlist_path, project_dir, shot_map:{shot_id:{clip_id,asset_id,t0,t1}}}

Endpoints:
  GET  /mad/{pid}/map                     link info
  GET  /mad/{pid}/shotlist                shotlist JSON
  PUT  /mad/{pid}/shotlist                save (validated; 400 with fix hints)
  GET  /mad/{pid}/scene.html              live scene for the Shot Editor iframe
  GET  /mad/{pid}/asset/{name}            image asset (http mode)
  GET  /mad/{pid}/font/{name}             font file
  POST /mad/{pid}/shots/{shot_id}/reproxy re-render this shot's proxy (job)
  POST /mad/{pid}/instruct                natural-language edit via local LLM
  GET  /mad/templates                     template/param reference (for LLMs & UI)
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel
from sqlmodel import Session

from app.db.database import get_session
from app.models.job import JobRead
from app.routers.generation import _create_job

router = APIRouter(prefix="/mad", tags=["mad"])

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
MAD_DIR = BACKEND_DIR / "data" / "mad"
KIT_DIR = BACKEND_DIR.parent / "tools" / "mad-kit"


def _kit():
    """Import tools/mad-kit/build.py as a module (not on sys.path)."""
    spec = importlib.util.spec_from_file_location("madkit_build", KIT_DIR / "build.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("madkit_build", mod)
    spec.loader.exec_module(mod)
    return mod


def _map(pid: int) -> dict:
    f = MAD_DIR / f"{pid}.json"
    if not f.exists():
        raise HTTPException(404, f"project {pid} has no mad shotlist link")
    return json.loads(f.read_text())


@router.get("/templates")
def templates_reference():
    readme = (KIT_DIR / "README.md")
    return {"readme": readme.read_text() if readme.exists() else ""}


@router.get("/{pid}/map")
def get_map(pid: int):
    return _map(pid)


@router.get("/{pid}/shotlist")
def get_shotlist(pid: int):
    m = _map(pid)
    return json.loads(Path(m["shotlist_path"]).read_text())


@router.put("/{pid}/shotlist")
def put_shotlist(pid: int, shotlist: dict):
    m = _map(pid)
    errs = _kit().check(shotlist)
    if errs:
        raise HTTPException(400, {"errors": errs})
    Path(m["shotlist_path"]).write_text(json.dumps(shotlist, ensure_ascii=False, indent=2))
    return {"ok": True}


@router.get("/{pid}/scene.html")
def scene_html(pid: int):
    m = _map(pid)
    html, *_ = _kit().build_html(Path(m["project_dir"]), Path(m["shotlist_path"]),
                                 asset_url_prefix=f"/api/mad/{pid}/", live=True)
    return HTMLResponse(html)


@router.get("/{pid}/asset/{name}")
def asset_file(pid: int, name: str):
    m = _map(pid)
    p = (Path(m["project_dir"]) / "assets" / name).resolve()
    if not str(p).startswith(str(Path(m["project_dir"]).resolve())) or not p.exists():
        raise HTTPException(404, "no such asset")
    return FileResponse(p)


@router.get("/{pid}/music")
def music_file(pid: int):
    m = _map(pid)
    shotlist = json.loads(Path(m["shotlist_path"]).read_text())
    p = (Path(m["project_dir"]) / shotlist["meta"]["music"]).resolve()
    if not str(p).startswith(str(Path(m["project_dir"]).resolve())) or not p.exists():
        raise HTTPException(404, "no music")
    return FileResponse(p, media_type="audio/wav")


@router.get("/{pid}/font/{name}")
def font_file(pid: int, name: str):
    p = (KIT_DIR / "fonts" / name).resolve()
    if not str(p).startswith(str(KIT_DIR.resolve())) or not p.exists():
        raise HTTPException(404, "no such font")
    return FileResponse(p, media_type="font/ttf")


@router.post("/{pid}/shots/{shot_id}/reproxy", response_model=JobRead, status_code=201)
def reproxy_shot(pid: int, shot_id: str, session: Session = Depends(get_session)):
    m = _map(pid)
    if shot_id not in m["shot_map"]:
        raise HTTPException(404, f"unknown shot '{shot_id}'")
    return _create_job(session, pid, "mad_reproxy_shot", {"shot_id": shot_id})


# ── natural-language instruction (P2, local-LLM tier) ────────────────────────

class InstructRequest(BaseModel):
    shot_id: str
    instruction: str
    object_path: str | None = None   # e.g. "params.ornaments[1]" (from the picker)
    provider: str = "auto"           # llm_provider.resolve()


SYSTEM = """あなたはMAD動画のショット編集アシスタントです。
ユーザーの指示に従って、与えられた shot JSON の params を編集して返します。
出力は**変更後の shot JSON 全体だけ**をコードブロック無しで返すこと。説明文は不要。
利用できる語彙:
- enter: rise_pop, pop, slide_l, slide_r, slide_u, slide_d, drop_bounce, spin_in, fade_zoom, tilt_in
- ambient.kind: floaters, confetti, petals, sparkles, snow / set: apple, pocky, heart, star, note
- bg (showcase_pattern): argyle, stripes, dots, checks, plaid, beige, soft, winter, solid
座標系は 1920x1080。数値は控えめに変える(指示がなければ±10〜20%)。
テンプレート名や from/to は変更しない。
"""


@router.post("/{pid}/instruct")
def instruct(pid: int, req: InstructRequest):
    from app.services.llm_provider import chat
    m = _map(pid)
    shotlist_path = Path(m["shotlist_path"])
    shotlist = json.loads(shotlist_path.read_text())
    shot = next((s for s in shotlist["shots"] if s["id"] == req.shot_id), None)
    if not shot:
        raise HTTPException(404, f"unknown shot '{req.shot_id}'")

    focus = f"\n選択中のオブジェクト: {req.object_path}(この要素を優先的に編集)" if req.object_path else ""
    user = (f"shot JSON:\n{json.dumps(shot, ensure_ascii=False)}\n"
            f"{focus}\n指示: {req.instruction}\n変更後のshot JSON:")
    raw = chat([{"role": "user", "content": user}], system=SYSTEM,
               max_tokens=4000, provider=req.provider)
    # parse: accept raw JSON or fenced
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        text = text[text.find("{"):]
    try:
        new_shot = json.loads(text[text.find("{"): text.rfind("}") + 1])
    except Exception:
        raise HTTPException(422, {"error": "LLM出力をJSONとして解釈できませんでした", "raw": raw[:800]})
    if new_shot.get("id") != shot["id"] or new_shot.get("template") != shot["template"]:
        raise HTTPException(422, {"error": "id/templateが変更されていたため破棄しました", "raw": raw[:400]})
    new_shot["from"], new_shot["to"] = shot["from"], shot["to"]   # timing is clip-owned

    idx = shotlist["shots"].index(shot)
    candidate = json.loads(json.dumps(shotlist))
    candidate["shots"][idx] = new_shot
    errs = _kit().check(candidate)
    if errs:
        raise HTTPException(422, {"error": "検証エラー", "errors": errs, "raw": raw[:400]})
    shotlist_path.write_text(json.dumps(candidate, ensure_ascii=False, indent=2))
    return {"ok": True, "shot": new_shot}
