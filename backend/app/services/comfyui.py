"""
ComfyUI Connector — Phase 4 stub.

Real implementation will:
  1. POST workflow JSON to ComfyUI /prompt endpoint
  2. Subscribe to ComfyUI WebSocket for progress events
  3. Collect output files on completion
  4. Register results as Assets

For now this raises NotImplementedError so callers know it's not wired yet.
"""

from pathlib import Path
from typing import Any


COMFYUI_URL = "http://localhost:8188"


class ComfyUIConnector:
    def __init__(self, base_url: str = COMFYUI_URL):
        self.base_url = base_url

    async def is_available(self) -> bool:
        """Check if ComfyUI is running."""
        try:
            import httpx
            async with httpx.AsyncClient(timeout=2) as client:
                r = await client.get(f"{self.base_url}/system_stats")
                return r.status_code == 200
        except Exception:
            return False

    async def submit_workflow(self, workflow: dict[str, Any]) -> str:
        """Submit a workflow JSON and return the prompt_id."""
        raise NotImplementedError("ComfyUI connector not yet configured")

    async def get_progress(self, prompt_id: str) -> dict[str, Any]:
        """Return progress dict for a running prompt."""
        raise NotImplementedError("ComfyUI connector not yet configured")

    async def get_outputs(self, prompt_id: str) -> list[Path]:
        """Return local paths of completed output files."""
        raise NotImplementedError("ComfyUI connector not yet configured")


# Singleton — shared across the app
comfyui = ComfyUIConnector()
