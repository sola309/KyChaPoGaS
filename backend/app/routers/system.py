"""
System-level API: GPU status, VRAM monitoring.
"""

import asyncio
import json

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.services.gpu_monitor import get_gpu_status, GpuStatus, GpuInfo

router = APIRouter(prefix="/system", tags=["system"])


def _gpu_info_dict(g: GpuInfo) -> dict:
    return {
        "index": g.index,
        "name": g.name,
        "vram_total_mb": g.vram_total_mb,
        "vram_used_mb": g.vram_used_mb,
        "vram_free_mb": g.vram_free_mb,
        "utilization_pct": g.utilization_pct,
        "temperature_c": g.temperature_c,
        "power_draw_w": g.power_draw_w,
        "power_limit_w": g.power_limit_w,
        "unified_memory": g.unified_memory,
    }


def _status_dict(status: GpuStatus) -> dict:
    return {
        "available": status.available,
        "error": status.error,
        "gpus": [_gpu_info_dict(g) for g in status.gpus],
    }


@router.get("/gpu")
def get_gpu():
    """Snapshot of current GPU/VRAM state."""
    return _status_dict(get_gpu_status())


@router.get("/gpu/stream")
async def stream_gpu(request: Request):
    """
    Server-Sent Events: pushes GPU status every 2 seconds.
    Clients subscribe once and get live updates.
    """
    async def generator():
        while not await request.is_disconnected():
            payload = json.dumps(_status_dict(get_gpu_status()), default=str)
            yield f"data: {payload}\n\n"
            await asyncio.sleep(2)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
