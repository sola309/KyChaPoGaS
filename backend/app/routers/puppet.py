"""
Puppet router — serves rigged-character puppets (See-Through decomposition →
layered manifest) for the Companion app's PixiJS renderer.

A puppet is a directory under data/puppets/<id>/ containing manifest.json and
the per-layer PNGs. The companion frontend loads the manifest, stacks the
layers in z-order, and drives procedural motion (breath / blink / sway).
"""
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

router = APIRouter(prefix="/puppet", tags=["puppet"])

PUPPETS_DIR = Path(__file__).parent.parent.parent / "data" / "puppets"


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


@router.get("/{pid}/layer/{filename}")
def get_layer(pid: str, filename: str):
    # prevent path traversal
    if "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="bad filename")
    p = PUPPETS_DIR / pid / filename
    if not p.exists() or p.suffix.lower() != ".png":
        raise HTTPException(status_code=404, detail="layer not found")
    return FileResponse(p, media_type="image/png")
