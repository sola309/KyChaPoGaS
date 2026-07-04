"""
Puppet router — serves rigged-character puppets (See-Through decomposition →
layered manifest) for the Companion app's PixiJS renderer.

A puppet is a directory under data/puppets/<id>/ containing manifest.json and
the per-layer PNGs. The companion frontend loads the manifest, stacks the
layers in z-order, and drives procedural motion (breath / blink / sway).
"""
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlmodel import Session

from app.db.database import get_session

router = APIRouter(prefix="/puppet", tags=["puppet"])

PUPPETS_DIR = Path(__file__).parent.parent.parent / "data" / "puppets"


class DecomposeRequest(BaseModel):
    project_id: int
    asset_id: int
    puppet_id: str | None = None
    name: str | None = None
    base_tags: str | None = None   # 差分生成(face_variants)用のキャラ固有タグ


@router.post("/decompose", status_code=201)
def decompose(req: DecomposeRequest, session: Session = Depends(get_session)):
    """キャラ画像アセット → See-Through分解 → リグ可能パペットを生成（ジョブ）。"""
    from app.models.job import Job
    import json as _json
    job = Job(project_id=req.project_id, job_type="decompose_character",
              params=_json.dumps(req.model_dump()))
    session.add(job)
    session.commit()
    session.refresh(job)
    return {"job_id": job.id, "status": job.status}


@router.get("/")
def list_puppets():
    if not PUPPETS_DIR.exists():
        return {"puppets": []}
    out = []
    # Stable default ordering: recommended models (name without "旧") come first,
    # then newest-built. mtime alone is fragile because every recompile rewrites
    # manifests and would silently flip the default puppet.
    dirs = [d for d in PUPPETS_DIR.iterdir() if (d / "manifest.json").is_file()]
    rows = []
    for d in dirs:
        try:
            m = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
        except Exception:
            continue
        rows.append((m, m.get("name", d.name), d))
    demoted = ("旧", "検証", "test")
    rows.sort(key=lambda r: (any(s in r[1] for s in demoted),
                             -(r[2] / "manifest.json").stat().st_mtime))
    for m, name, d in rows:
        out.append({"id": m.get("id", d.name), "name": name,
                    "layer_count": len(m.get("layers", []))})
    return {"puppets": out}


@router.get("/{pid}/manifest")
def get_manifest(pid: str):
    mf = PUPPETS_DIR / pid / "manifest.json"
    if not mf.exists():
        raise HTTPException(status_code=404, detail="puppet not found")
    return JSONResponse(json.loads(mf.read_text(encoding="utf-8")))


class SpeakRequest(BaseModel):
    text: str
    voice: str = ""
    emoji_style: str = ""
    multilang: bool = True   # JA→Irodori, EN→English TTS, mixed split+concat


@router.get("/tts/status")
async def tts_status():
    from app.services import tts
    return {"available": await tts.available(), "url": __import__("app.config", fromlist=["TTS_API_URL"]).TTS_API_URL}


@router.post("/tts/speak")
async def tts_speak(req: SpeakRequest):
    """テキスト → 音声(wav)。コンパニオンが再生＋音量でリップシンク駆動。"""
    from fastapi.responses import Response
    from app.services import tts
    try:
        audio = await tts.synthesize(req.text, voice=req.voice, emoji_style=req.emoji_style,
                                     multilang=req.multilang)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"TTS失敗（サーバ未起動か未対応）: {e}")
    return Response(content=audio, media_type="audio/wav")


@router.get("/{pid}/layer/{filename:path}")
def get_layer(pid: str, filename: str):
    # prevent path traversal ("variants/xxx.png" の1段サブディレクトリのみ許可)
    if ".." in filename or filename.count("/") > 1:
        raise HTTPException(status_code=400, detail="bad filename")
    p = (PUPPETS_DIR / pid / filename).resolve()
    if not str(p).startswith(str((PUPPETS_DIR / pid).resolve())):
        raise HTTPException(status_code=400, detail="bad filename")
    if not p.exists() or p.suffix.lower() != ".png":
        raise HTTPException(status_code=404, detail="layer not found")
    return FileResponse(p, media_type="image/png")


class ClipRequest(BaseModel):
    project_id: int
    motion: str = "idle"       # idle | talk | nod
    duration: float = 4.0
    fps: int = 30


@router.post("/{pid}/clip", status_code=201)
def make_clip(pid: str, req: ClipRequest, session: Session = Depends(get_session)):
    """コンパニオンを透過webm素材として書き出す(MADの前景レイヤ等に)。"""
    from app.routers.generation import _create_job
    if not (PUPPETS_DIR / pid / "manifest.json").exists():
        raise HTTPException(status_code=404, detail="puppet not found")
    return _create_job(session, req.project_id, "puppet_clip", {
        "project_id": req.project_id, "puppet_id": pid,
        "motion": req.motion, "duration": req.duration, "fps": req.fps,
    })
