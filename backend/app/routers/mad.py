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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
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


EVAL_LOG = BACKEND_DIR / "data" / "llm_eval" / "instruct.jsonl"


def _llm_edit(shot: dict, object_path: str | None, instruction: str, provider: str):
    """1回のLLM編集。(new_shot, provider名, 秒) を返す。失敗は例外。"""
    import time
    from app.services.llm_provider import chat, resolve
    focus = f"\n選択中のオブジェクト: {object_path}(この要素を優先的に編集)" if object_path else ""
    user = (f"shot JSON:\n{json.dumps(shot, ensure_ascii=False)}\n"
            f"{focus}\n指示: {instruction}\n変更後のshot JSON:")
    t0 = time.time()

    def _ask(messages):
        return chat(messages, system=SYSTEM, max_tokens=4000, provider=provider, temperature=0.0)

    def _parse(raw_text):
        t = raw_text.strip()
        if t.startswith("```"):
            t = t.split("```")[1]
            t = t[t.find("{"):]
        frag = t[t.find("{"): t.rfind("}") + 1]
        try:
            return json.loads(frag)
        except json.JSONDecodeError:
            # 小型モデルは末尾の閉じ括弧を落としがち — 不足分を機械補完して再試行
            opens = frag.count("{") - frag.count("}")
            brackets = frag.count("[") - frag.count("]")
            if 0 <= opens <= 3 and 0 <= brackets <= 3:
                return json.loads(frag + "]" * brackets + "}" * opens)
            raise

    messages = [{"role": "user", "content": user}]
    raw = _ask(messages)
    try:
        new_shot = _parse(raw)
    except Exception as e:
        # エラーを教師にして1回だけ再試行(小型モデルはこれで大半が収束する)
        messages += [{"role": "assistant", "content": raw},
                     {"role": "user", "content": f"そのJSONは不正です({e})。正しいJSONだけをもう一度出力してください。"}]
        raw = _ask(messages)
        new_shot = _parse(raw)
    dt = time.time() - t0
    if new_shot.get("id") != shot["id"] or new_shot.get("template") != shot["template"]:
        raise ValueError("id/templateが変更された")
    new_shot["from"], new_shot["to"] = shot["from"], shot["to"]   # timing is clip-owned
    # LLMがshotトップレベルに置いた迷子キーは params に畳み込む(サイレント無効の防止)
    for k in [k for k in list(new_shot.keys()) if k not in ("id", "template", "from", "to", "transition", "params")]:
        new_shot.setdefault("params", {})[k] = new_shot.pop(k)
    return new_shot, resolve(provider), dt


def _eval_log(entry: dict) -> None:
    EVAL_LOG.parent.mkdir(parents=True, exist_ok=True)
    from datetime import datetime
    entry["ts"] = datetime.now().isoformat(timespec="seconds")
    with EVAL_LOG.open("a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _shadow_eval(shot: dict, object_path: str | None, instruction: str, main_shot: dict) -> None:
    """本線と同じ指示をローカルLLMに影運転させて成績を記録(将来の移行判断用)。"""
    try:
        sh, prov, dt = _llm_edit(shot, object_path, instruction, "local")
        _eval_log({"lane": "shadow", "engine": prov, "instruction": instruction,
                   "shot_id": shot["id"], "ok": True, "latency_s": round(dt, 1),
                   "matches_main": sh.get("params") == main_shot.get("params")})
    except Exception as e:
        _eval_log({"lane": "shadow", "engine": "local", "instruction": instruction,
                   "shot_id": shot["id"], "ok": False, "error": str(e)[:200]})


@router.get("/eval/summary")
def eval_summary():
    """影運転ログの集計 — ローカルLLM移行の判断材料。"""
    if not EVAL_LOG.exists():
        return {"entries": 0}
    rows = [json.loads(x) for x in EVAL_LOG.read_text().splitlines() if x.strip()]
    out: dict[str, dict] = {}
    for r in rows:
        k = f"{r.get('lane')}:{r.get('engine')}"
        d = out.setdefault(k, {"n": 0, "ok": 0, "match": 0, "lat": []})
        d["n"] += 1; d["ok"] += bool(r.get("ok"))
        d["match"] += bool(r.get("matches_main"))
        if r.get("latency_s"): d["lat"].append(r["latency_s"])
    return {"entries": len(rows),
            "by_engine": {k: {"n": v["n"], "ok_rate": round(v["ok"]/v["n"], 2),
                              "match_rate": round(v["match"]/max(1, v["ok"]), 2),
                              "avg_latency_s": round(sum(v["lat"])/len(v["lat"]), 1) if v["lat"] else None}
                          for k, v in out.items()}}


@router.post("/{pid}/instruct")
def instruct(pid: int, req: InstructRequest, background: BackgroundTasks):
    from app.services.llm_provider import available_providers
    m = _map(pid)
    shotlist_path = Path(m["shotlist_path"])
    shotlist = json.loads(shotlist_path.read_text())
    shot = next((s for s in shotlist["shots"] if s["id"] == req.shot_id), None)
    if not shot:
        raise HTTPException(404, f"unknown shot '{req.shot_id}'")

    # 本線: ANTHROPIC_API_KEY があれば Claude、無ければローカル(全指示を評価ログへ)
    avail = available_providers()
    provider = req.provider if req.provider != "auto" else ("anthropic" if "anthropic" in avail else "local")
    try:
        new_shot, engine, dt = _llm_edit(shot, req.object_path, req.instruction, provider)
    except HTTPException:
        raise
    except Exception as e:
        _eval_log({"lane": "main", "engine": provider, "instruction": req.instruction,
                   "shot_id": req.shot_id, "ok": False, "error": str(e)[:300]})
        raise HTTPException(422, {"error": f"LLM編集に失敗しました: {e}"})

    idx = shotlist["shots"].index(shot)
    candidate = json.loads(json.dumps(shotlist))
    candidate["shots"][idx] = new_shot
    errs = _kit().check(candidate)
    if errs:
        _eval_log({"lane": "main", "engine": engine, "instruction": req.instruction,
                   "shot_id": req.shot_id, "ok": False, "errors": errs[:3]})
        raise HTTPException(422, {"error": "検証エラー", "errors": errs})
    shotlist_path.write_text(json.dumps(candidate, ensure_ascii=False, indent=2))
    _eval_log({"lane": "main", "engine": engine, "instruction": req.instruction,
               "shot_id": req.shot_id, "ok": True, "latency_s": round(dt, 1)})
    # 本線がクラウドのときはローカルを影運転(移行判断のデータ収集)
    if engine != "local" and "local" in avail:
        background.add_task(_shadow_eval, shot, req.object_path, req.instruction, new_shot)
    return {"ok": True, "shot": new_shot, "engine": engine}
