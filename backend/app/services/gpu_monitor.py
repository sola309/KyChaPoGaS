"""
GPU / VRAM monitor.

Uses pynvml (nvidia-ml-py3) when an NVIDIA GPU is present.
Falls back to a zeroed-out response on systems without CUDA or pynvml.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

log = logging.getLogger("gpu_monitor")

# ── pynvml bootstrap ──────────────────────────────────────────────────────────

_nvml_ok = False

try:
    import pynvml
    pynvml.nvmlInit()
    _nvml_ok = True
    log.info("pynvml initialised — NVIDIA GPU monitoring enabled")
except Exception as _e:
    log.info(f"pynvml not available ({_e}) — GPU monitoring disabled")


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class GpuInfo:
    index: int
    name: str
    vram_total_mb: int
    vram_used_mb: int
    vram_free_mb: int
    utilization_pct: int          # GPU core utilisation 0-100
    temperature_c: int
    power_draw_w: float
    power_limit_w: float


@dataclass
class GpuStatus:
    available: bool
    gpus: list[GpuInfo] = field(default_factory=list)
    error: str = ""

    # Convenience: aggregated free VRAM across all GPUs (first GPU is primary)
    @property
    def primary_free_mb(self) -> int:
        return self.gpus[0].vram_free_mb if self.gpus else 0

    @property
    def primary_used_mb(self) -> int:
        return self.gpus[0].vram_used_mb if self.gpus else 0

    @property
    def primary_total_mb(self) -> int:
        return self.gpus[0].vram_total_mb if self.gpus else 0


# ── Query ─────────────────────────────────────────────────────────────────────

def get_gpu_status() -> GpuStatus:
    """Query current GPU state. Always returns a valid GpuStatus (no exceptions)."""
    if not _nvml_ok:
        return GpuStatus(available=False, error="pynvml not available or no NVIDIA GPU")

    try:
        count = pynvml.nvmlDeviceGetCount()
        gpus: list[GpuInfo] = []
        for i in range(count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            try:
                temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
            except Exception:
                temp = 0
            try:
                power_draw  = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0
                power_limit = pynvml.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000.0
            except Exception:
                power_draw = power_limit = 0.0

            gpus.append(GpuInfo(
                index=i,
                name=pynvml.nvmlDeviceGetName(handle),
                vram_total_mb=mem.total // (1024 * 1024),
                vram_used_mb=mem.used   // (1024 * 1024),
                vram_free_mb=mem.free   // (1024 * 1024),
                utilization_pct=util.gpu,
                temperature_c=temp,
                power_draw_w=round(power_draw, 1),
                power_limit_w=round(power_limit, 1),
            ))
        return GpuStatus(available=True, gpus=gpus)
    except Exception as e:
        return GpuStatus(available=False, error=str(e))


# ── VRAM estimation per job type ──────────────────────────────────────────────

_VRAM_ESTIMATES: dict[str, int] = {
    # job_type → MB
    "render_final":       256,
    "generate_audio":     2048,
}

_MODEL_VRAM_HINTS: list[tuple[str, int]] = [
    # substring (lower) → MB
    ("flux",    14336),   # FLUX.1 dev/schnell
    ("cogvideo", 16384),  # CogVideoX-I2V
    ("svd",     10240),   # SVD-XT
    ("xl",       8192),   # SDXL
]
_DEFAULT_VRAM_MB = 4096   # SD 1.5 fallback


def estimate_vram_mb(job_type: str, params: dict) -> int:
    """Return a rough VRAM estimate in MB for the given job."""
    if job_type in _VRAM_ESTIMATES:
        return _VRAM_ESTIMATES[job_type]

    model_id = str(params.get("model", "")).lower()
    for substr, mb in _MODEL_VRAM_HINTS:
        if substr in model_id:
            return mb
    return _DEFAULT_VRAM_MB


def is_vram_sufficient(required_mb: int, headroom_mb: int = 512) -> bool:
    """True if the primary GPU has at least required_mb + headroom_mb free."""
    status = get_gpu_status()
    if not status.available:
        return True   # can't check → allow
    return status.primary_free_mb >= required_mb + headroom_mb
