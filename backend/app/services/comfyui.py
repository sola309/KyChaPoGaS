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
import json
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

from app.config import COMFYUI_URL

COMFY_TIMEOUT_S = 9000.0  # max wait for a generation job。H3のフルユニット(328f/step25)は実測ペースで約82分かかるため150分に設定(2026-08-19、40分でU03がタイムアウトした対処)
POLL_INTERVAL_S = 2.0


class ComfyUIConnector:
    def __init__(self, base_url: str = COMFYUI_URL):
        self.base_url = base_url.rstrip("/")
        self._client_ids: dict[str, str] = {}    # prompt_id → 投稿時のclient_id
        self._live_progress: set[str] = set()    # 実測進捗が届いているprompt_id

    # ── Availability ──────────────────────────────────────────────────────────

    async def is_available(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3.0) as c:
                r = await c.get(f"{self.base_url}/system_stats")
                return r.status_code == 200
        except Exception:
            return False

    def drop_all_queued_sync(self) -> int:
        """ComfyUI のキューを空にする(実行中は中断・待機は削除)。

        バックエンドが再起動すると、そのとき走っていたジョブは失われるが、
        ComfyUI 側に投げたプロンプトはキューに残って計算され続ける。
        結果を回収する持ち主が居ないので GPU が丸ごと無駄になり、さらに
        再起動後の本物のジョブがその後ろで待たされる。起動時に一掃する。
        (起動直後は生きているジョブが存在しないため、消して安全)
        """
        import urllib.error
        import urllib.request
        n = 0
        try:
            with urllib.request.urlopen(f"{self.base_url}/queue", timeout=5) as r:
                q = json.loads(r.read())
            n = len(q.get("queue_running", [])) + len(q.get("queue_pending", []))
            if not n:
                return 0
            for path, body in (("/interrupt", b"{}"), ("/queue", b'{"clear": true}')):
                req = urllib.request.Request(f"{self.base_url}{path}", data=body,
                                             headers={"Content-Type": "application/json"},
                                             method="POST")
                try:
                    urllib.request.urlopen(req, timeout=5).read()
                except urllib.error.URLError:
                    pass
        except Exception:
            return 0
        return n

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
                # ComfyUI's /object_info/{node} wraps the node under its name,
                # i.e. {"CheckpointLoaderSimple": {"input": {...}}} — unwrap it.
                node = data.get(node_class, data)
                opts = (node.get("input", {})
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
        """Submit a workflow. Returns prompt_id.

        ComfyUI は client_id 付きで投げたプロンプトの進捗イベントを、その
        client_id の WebSocket にだけ送る。進捗を実測するには監視側が同じ
        client_id で繋ぐ必要があるので、prompt_id との対応を控えておく。
        """
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
            pid = data["prompt_id"]
            self._client_ids[pid] = client_id
            if len(self._client_ids) > 64:          # 取り置きは直近ぶんだけ
                for k in list(self._client_ids)[:-32]:
                    self._client_ids.pop(k, None)
            return pid

    # ── Polling ───────────────────────────────────────────────────────────────

    # ロード系ノード → フェーズ表示「モデル読み込み中」の判定に使う
    _LOADER_CLASSES = {
        "UNETLoader", "CheckpointLoaderSimple", "CLIPLoader", "VAELoader",
        "DualCLIPLoader", "LoraLoader", "LoraLoaderModelOnly", "AudioEncoderLoader",
    }

    async def _phase_watcher(self, prompt_id: str, workflow: dict | None,
                             phase_cb: Callable[[str], None],
                             progress_cb: Optional[Callable[[float], None]] = None) -> None:
        """
        ComfyUI の WebSocket からノード実行イベントを拾ってフェーズ文字列を流す。
        - executing ノードがローダー系 → 「モデル読み込み中…」
        - progress イベント → 「生成中 k/n」(+実測進捗をprogress_cbへ)
        失敗しても無害(ポーリング進捗にフォールバック)。
        """
        try:
            import websockets
            cid = self._client_ids.get(prompt_id) or "kychapogas_phase"
            ws_url = self.base_url.replace("http", "ws", 1) + f"/ws?clientId={cid}"
            async with websockets.connect(ws_url, open_timeout=5) as ws:
                while True:
                    raw = await ws.recv()
                    if not isinstance(raw, str):
                        continue
                    msg = json.loads(raw)
                    mtype, data = msg.get("type"), msg.get("data", {})
                    if data.get("prompt_id") not in (None, prompt_id):
                        continue
                    if mtype == "executing":
                        node = data.get("node")
                        if node is None:
                            return  # 実行完了
                        cls = (workflow or {}).get(str(node), {}).get("class_type", "")
                        if cls in self._LOADER_CLASSES:
                            phase_cb("モデル読み込み中…")
                        elif cls:
                            phase_cb(f"実行中: {cls}")
                    elif mtype == "progress":
                        v, m = data.get("value", 0), data.get("max", 1)
                        phase_cb(f"生成中 {v}/{m}")
                        if progress_cb and m:
                            self._live_progress.add(prompt_id)
                            progress_cb(0.05 + 0.88 * (v / m))
        except Exception:
            pass  # WS不可でもポーリングで続行

    async def wait_for_outputs(
        self,
        prompt_id: str,
        progress_cb: Optional[Callable[[float], None]] = None,
        phase_cb: Optional[Callable[[str], None]] = None,
        workflow: dict | None = None,
    ) -> list[dict]:
        """
        Poll /history until the prompt completes.
        Returns a list of output file descriptors:
          [{"filename": "...", "subfolder": "...", "type": "output"}, ...]
        """
        elapsed = 0.0
        watcher = None
        orphan_s = 0.0   # プロンプトがqueueにも完了履歴にも見えない経過時間
        if phase_cb:
            watcher = asyncio.create_task(
                self._phase_watcher(prompt_id, workflow, phase_cb, progress_cb))

        while elapsed < COMFY_TIMEOUT_S:
            in_queue = True   # 取得失敗時は誤検知しない側に倒す
            async with httpx.AsyncClient(timeout=10.0) as c:
                # Rough queue position for early progress
                try:
                    rq = await c.get(f"{self.base_url}/queue")
                    if rq.status_code == 200:
                        qdata = rq.json()
                        running = qdata.get("queue_running", [])
                        pending = qdata.get("queue_pending", [])
                        ids = {item[1] for item in running + pending if len(item) > 1}
                        in_queue = prompt_id in ids
                        if progress_cb and not running and pending:
                            progress_cb(0.01)  # still queued
                except Exception:
                    pass

                r = await c.get(f"{self.base_url}/history/{prompt_id}")
                if r.status_code == 200:
                    history = r.json()
                    entry = history.get(prompt_id)
                    if entry:
                        # Check for error / interruption
                        status = entry.get("status", {})
                        msgs = status.get("messages", [])
                        for mtype, mdata in msgs:
                            if mtype == "execution_error":
                                if watcher:
                                    watcher.cancel()
                                raise RuntimeError(
                                    mdata.get("exception_message", "ComfyUI execution error")
                                )
                            if mtype == "execution_interrupted":
                                if watcher:
                                    watcher.cancel()
                                raise RuntimeError("ComfyUI execution interrupted")
                        # 完了扱いだがoutputsが空(=中断・保存失敗)を孤児として検出
                        if status.get("completed") and not entry.get("outputs"):
                            orphan_s += POLL_INTERVAL_S
                            if orphan_s > 30:
                                if watcher:
                                    watcher.cancel()
                                raise RuntimeError("ComfyUI prompt finished without outputs (interrupted?)")

                        # Collect all image / video outputs
                        outputs: list[dict] = []
                        for _node_id, node_out in entry.get("outputs", {}).items():
                            for key in ("images", "gifs", "video", "3d"):
                                if key in node_out:
                                    outputs.extend(node_out[key])
                        if outputs:
                            if progress_cb:
                                progress_cb(0.95)
                            if watcher:
                                watcher.cancel()
                            if phase_cb:
                                phase_cb("")
                            return outputs

            # プロンプトがキューにも履歴にも存在しない=消失(ComfyUI再起動・強制クリア等)
            if not in_queue and (r.status_code != 200 or not history.get(prompt_id)):
                orphan_s += POLL_INTERVAL_S
                if orphan_s > 30:
                    if watcher:
                        watcher.cancel()
                    raise RuntimeError("ComfyUIからプロンプトが消失しました(再起動/クリアの可能性)")
            else:
                orphan_s = 0.0

            await asyncio.sleep(POLL_INTERVAL_S)
            elapsed += POLL_INTERVAL_S

            # Rough progress estimate (assumes ~2 min for a typical generation)
            # WSフェーズ監視が生きている場合は実測進捗が来るのでこちらは出さない
            if progress_cb and not (watcher and not watcher.done()):
                if prompt_id not in self._live_progress:
                    # 実測が取れないときだけの粗い推定。取れているなら上書きしない
                    # (推定は102秒で0.9に飽和するため、長い生成では85%で止まって見える)
                    progress_cb(min(0.9, 0.05 + elapsed / 120.0))

        if watcher:
            watcher.cancel()
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
