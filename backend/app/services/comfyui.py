"""
ComfyUI Connector — Phase 4b implementation.

Uses ComfyUI's REST API (HTTP polling) — no WebSocket required.
  POST  /prompt              → submit workflow, returns prompt_id
  GET   /history/{id}        → poll for outputs
  GET   /view?...            → download an output file
  POST  /upload/image        → upload an input image
  GET   /object_info/{node}  → list available models for a node
"""

import asyncio
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

from app.config import COMFYUI_URL

COMFY_TIMEOUT_S = 600.0   # max wait for a generation job
POLL_INTERVAL_S = 2.0


class ComfyUIConnector:
    def __init__(self, base_url: str = COMFYUI_URL):
        self.base_url = base_url.rstrip("/")

    # ── Availability ──────────────────────────────────────────────────────────

    async def is_available(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3.0) as c:
                r = await c.get(f"{self.base_url}/system_stats")
                return r.status_code == 200
        except Exception:
            return False

    # ── Model discovery ───────────────────────────────────────────────────────

    async def list_checkpoints(self) -> list[str]:
        """Return available checkpoint filenames from ComfyUI."""
        return await self._object_info_options("CheckpointLoaderSimple", "ckpt_name")

    async def list_unet_models(self) -> list[str]:
        """Return UNET model filenames (used by FLUX)."""
        return await self._object_info_options("UNETLoader", "unet_name")

    async def list_clip_models(self) -> list[str]:
        return await self._object_info_options("DualCLIPLoader", "clip_name1")

    async def _object_info_options(self, node_class: str, param: str) -> list[str]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                r = await c.get(f"{self.base_url}/object_info/{node_class}")
                if r.status_code != 200:
                    return []
                data = r.json()
                opts = (data.get("input", {})
                           .get("required", {})
                           .get(param, [[]])[0])
                return [o for o in opts if isinstance(o, str)]
        except Exception:
            return []

    # ── Image upload (for I2V input) ──────────────────────────────────────────

    async def upload_image(self, image_path: Path) -> dict:
        """Upload an image to ComfyUI's input folder. Returns {name, subfolder, type}."""
        async with httpx.AsyncClient(timeout=30.0) as c:
            with open(image_path, "rb") as f:
                r = await c.post(
                    f"{self.base_url}/upload/image",
                    files={"image": (image_path.name, f, "image/png")},
                )
                r.raise_for_status()
                return r.json()

    # ── Workflow submission ───────────────────────────────────────────────────

    async def submit(self, workflow: dict[str, Any]) -> str:
        """Submit a workflow. Returns prompt_id."""
        client_id = str(uuid.uuid4())
        async with httpx.AsyncClient(timeout=30.0) as c:
            r = await c.post(
                f"{self.base_url}/prompt",
                json={"prompt": workflow, "client_id": client_id},
            )
            r.raise_for_status()
            data = r.json()
            if "error" in data:
                details = data.get("node_errors", {})
                raise RuntimeError(f"ComfyUI workflow error: {data['error']}  details={details}")
            return data["prompt_id"]

    # ── Polling ───────────────────────────────────────────────────────────────

    async def wait_for_outputs(
        self,
        prompt_id: str,
        progress_cb: Optional[Callable[[float], None]] = None,
    ) -> list[dict]:
        """
        Poll /history until the prompt completes.
        Returns a list of output file descriptors:
          [{"filename": "...", "subfolder": "...", "type": "output"}, ...]
        """
        elapsed = 0.0

        while elapsed < COMFY_TIMEOUT_S:
            async with httpx.AsyncClient(timeout=10.0) as c:
                # Rough queue position for early progress
                try:
                    rq = await c.get(f"{self.base_url}/queue")
                    if rq.status_code == 200:
                        qdata = rq.json()
                        running = qdata.get("queue_running", [])
                        pending = qdata.get("queue_pending", [])
                        if progress_cb and not running and pending:
                            progress_cb(0.01)  # still queued
                except Exception:
                    pass

                r = await c.get(f"{self.base_url}/history/{prompt_id}")
                if r.status_code == 200:
                    history = r.json()
                    entry = history.get(prompt_id)
                    if entry:
                        # Check for error
                        status = entry.get("status", {})
                        msgs = status.get("messages", [])
                        for mtype, mdata in msgs:
                            if mtype == "execution_error":
                                raise RuntimeError(
                                    mdata.get("exception_message", "ComfyUI execution error")
                                )

                        # Collect all image / video outputs
                        outputs: list[dict] = []
                        for _node_id, node_out in entry.get("outputs", {}).items():
                            for key in ("images", "gifs", "video"):
                                if key in node_out:
                                    outputs.extend(node_out[key])
                        if outputs:
                            if progress_cb:
                                progress_cb(0.95)
                            return outputs

            await asyncio.sleep(POLL_INTERVAL_S)
            elapsed += POLL_INTERVAL_S

            # Rough progress estimate (assumes ~2 min for a typical generation)
            if progress_cb:
                progress_cb(min(0.9, 0.05 + elapsed / 120.0))

        raise TimeoutError(f"ComfyUI job timed out after {COMFY_TIMEOUT_S}s")

    # ── Download ──────────────────────────────────────────────────────────────

    async def download_output(
        self,
        filename: str,
        subfolder: str,
        file_type: str,
        dest_dir: Path,
    ) -> Path:
        """Download an output file from ComfyUI to dest_dir."""
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / filename
        params = {"filename": filename, "subfolder": subfolder, "type": file_type}
        async with httpx.AsyncClient(timeout=120.0) as c:
            r = await c.get(f"{self.base_url}/view", params=params)
            r.raise_for_status()
            dest.write_bytes(r.content)
        return dest


# Module-level singleton
comfyui = ComfyUIConnector()
