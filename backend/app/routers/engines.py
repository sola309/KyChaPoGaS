"""Engine Supervisor router — list / start / stop local engines + GPU memory."""
from fastapi import APIRouter

from app.services import engines as eng

router = APIRouter(prefix="/engines", tags=["engines"])


@router.get("/")
def list_engines():
    out = {"engines": eng.list_engines()}
    try:
        from app.services.gpu_monitor import get_gpu_status
        g = get_gpu_status()
        if g.gpus:
            d = g.gpus[0]
            out["gpu"] = {"used_mb": d.vram_used_mb, "total_mb": d.vram_total_mb,
                          "util": d.utilization_pct, "unified": d.unified_memory}
    except Exception:
        pass
    return out


@router.get("/llm-models")
def llm_models():
    """Installed local (Ollama) models — for the settings model switcher."""
    from app.services import llm_provider
    return {"models": llm_provider.local_models()}


@router.post("/{name}/start")
def start(name: str):
    return eng.start(name)


@router.post("/{name}/stop")
def stop(name: str):
    return eng.stop(name)
