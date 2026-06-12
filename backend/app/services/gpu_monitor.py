"""
GPU / VRAM monitor.

Uses pynvml (nvidia-ml-py3) when an NVIDIA GPU is present.
Falls back to a zeroed-out response on systems without CUDA or pynvml.

Unified-memory GPUs (e.g. DGX Spark / NVIDIA GB10):
  These share a single LPDDR5X pool between the Grace CPU and the Blackwell
  GPU, so NVML's nvmlDeviceGetMemoryInfo() returns NVML_ERROR_NotSupported —
  there is no dedicated VRAM to report. For these devices we treat system RAM
  (read from /proc/meminfo) as the "VRAM" pool, while still reading
  utilisation / temperature / power from NVML (those calls do work on GB10).
  VRAM gating then reserves a slice of the pool for the OS so heavy jobs can't
  drive the whole machine into OOM.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

log = logging.getLogger("gpu_monitor")

# On unified-memory systems, keep this much of the shared pool free for the OS
# and CPU-side work when deciding whether a GPU job may start. Override with the
# UNIFIED_MEMORY_RESERVE_MB environment variable.
UNIFIED_MEMORY_RESERVE_MB = int(os.getenv("UNIFIED_MEMORY_RESERVE_MB", "4096"))

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
    unified_memory: bool = False  # True when "VRAM" is the shared system RAM pool (e.g. GB10)


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


# ── System (unified) memory helper ────────────────────────────────────────────

def _system_memory_mb() -> tuple[int, int, int]:
    """
    Read the shared system RAM pool from /proc/meminfo.

    Returns (total_mb, used_mb, free_mb) where free is MemAvailable — the
    kernel's estimate of memory allocatable without swapping, which is the
    realistic ceiling for a new GPU allocation on a unified-memory device.
    Returns (0, 0, 0) if /proc/meminfo is unreadable (e.g. non-Linux).
    """
    try:
        info: dict[str, int] = {}
        with open("/proc/meminfo", encoding="ascii") as f:
            for line in f:
                key, _, rest = line.partition(":")
                info[key] = int(rest.split()[0])   # value is in kB
        total_kb = info.get("MemTotal", 0)
        # Prefer MemAvailable; fall back to MemFree + reclaimable cache.
        avail_kb = info.get("MemAvailable")
        if avail_kb is None:
            avail_kb = info.get("MemFree", 0) + info.get("Cached", 0) + info.get("Buffers", 0)
        total_mb = total_kb // 1024
        free_mb  = min(avail_kb // 1024, total_mb)
        return total_mb, total_mb - free_mb, free_mb
    except Exception as e:
        log.warning(f"Failed to read /proc/meminfo: {e}")
        return 0, 0, 0


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

            # Memory — dedicated VRAM via NVML, or fall back to the shared system
            # pool for unified-memory devices (GB10) where NVML reports NotSupported.
            unified = False
            try:
                mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
                total_mb = mem.total // (1024 * 1024)
                used_mb  = mem.used  // (1024 * 1024)
                free_mb  = mem.free  // (1024 * 1024)
            except pynvml.NVMLError:
                unified = True
                total_mb, used_mb, free_mb = _system_memory_mb()

            try:
                util = pynvml.nvmlDeviceGetUtilizationRates(handle).gpu
            except Exception:
                util = 0
            try:
                temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
            except Exception:
                temp = 0
            # Power draw and limit are independent — GB10 reports live draw but
            # not the enforced limit, so query them separately.
            try:
                power_draw = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0
            except Exception:
                power_draw = 0.0
            try:
                power_limit = pynvml.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000.0
            except Exception:
                power_limit = 0.0

            gpus.append(GpuInfo(
                index=i,
                name=pynvml.nvmlDeviceGetName(handle),
                vram_total_mb=total_mb,
                vram_used_mb=used_mb,
                vram_free_mb=free_mb,
                utilization_pct=util,
                temperature_c=temp,
                power_draw_w=round(power_draw, 1),
                power_limit_w=round(power_limit, 1),
                unified_memory=unified,
            ))
        return GpuStatus(available=True, gpus=gpus)
    except Exception as e:
        return GpuStatus(available=False, error=str(e))


# ── VRAM estimation per job type ──────────────────────────────────────────────

_VRAM_ESTIMATES: dict[str, int] = {
    # job_type → MB
    "render_final":       256,
    "generate_audio":     2048,
    "create_proxy":       128,   # CPU FFmpeg transcode
    "precompose":         256,   # CPU FFmpeg render
    "analyze_audio":      256,
    "analyze_video":      512,
    "render_motion_graphics": 512,   # headless Chromium + FFmpeg (CPU)
}

_MODEL_VRAM_HINTS: list[tuple[str, int]] = [
    # substring (lower) → MB
    ("wan2.2",  24576),   # Wan2.2 14B A14B (two fp8 experts loaded)
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
    """
    True if the primary GPU can host a job needing ``required_mb``.

    Dedicated VRAM:   free >= required + headroom.
    Unified memory:   free >= required + headroom + UNIFIED_MEMORY_RESERVE_MB,
                      so a GPU job never plans to consume the slice of the shared
                      pool we keep for the OS / CPU-side work.
    """
    status = get_gpu_status()
    if not status.available or not status.gpus:
        return True   # can't check → allow

    primary = status.gpus[0]
    reserve = UNIFIED_MEMORY_RESERVE_MB if primary.unified_memory else 0
    return primary.vram_free_mb >= required_mb + headroom_mb + reserve
