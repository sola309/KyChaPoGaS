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
    for d in sorted(PUPPETS_DIR.iterdir()):
        mf = d / "manifest.json"
        if mf.is_dir() or not mf.exists():
            continue
        try:
            m = json.loads(mf.read_text(encoding="utf-8"))
            out.append({"id": m.get("id", d.name), "name": m.get("name", d.name),
                        "layer_count": len(m.get("layers", []))})
        except Exception:
            continue
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


@router.get("/{pid}/layer/{filename}")
def get_layer(pid: str, filename: str):
    # prevent path traversal
    if "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="bad filename")
    p = PUPPETS_DIR / pid / filename
    if not p.exists() or p.suffix.lower() != ".png":
        raise HTTPException(status_code=404, detail="layer not found")
    return FileResponse(p, media_type="image/png")
