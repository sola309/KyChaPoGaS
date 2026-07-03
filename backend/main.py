import asyncio
import logging
import os
from pathlib import Path

import httpx
from fastapi import FastAPI, WebSocket, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

from app.db.database import create_db_and_tables
from app.routers import (projects, assets, tracks, clips, jobs, generation, llm, system,
                         analysis, puppet, companion, settings as settings_router, engines as engines_router,
                         mad as mad_router, inspect as inspect_router, comments as comments_router)
from app.services import job_runner

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("main")

TERMINAL_HOST = os.getenv("TERMINAL_HOST", "127.0.0.1")
TERMINAL_PORT = os.getenv("TERMINAL_PORT", "8765")
FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"

# The embedded terminal gives a real shell on the host, so it is gated by the
# request's SOURCE IP (which Tailscale enforces — peers cannot spoof it). The
# app's display names are user-chosen and must NOT be used for this.
#
#   KYCHAPOGAS_DISABLE_TERMINAL=1   → terminal OFF for everyone (hard kill).
#   ADMIN_TERMINAL_IPS=100.x,...    → terminal ONLY from these IPs (+ loopback).
#                                     The admin's own Tailscale IP(s); invited
#                                     collaborators get a different IP → no terminal.
#   (neither set)                   → terminal allowed for all (solo mode).
#
# See docs/collaborator-invite-tailscale.md.
TERMINAL_DISABLED = os.getenv("KYCHAPOGAS_DISABLE_TERMINAL", "").lower() in ("1", "true", "yes", "on")
ADMIN_TERMINAL_IPS = {ip.strip() for ip in os.getenv("ADMIN_TERMINAL_IPS", "").split(",") if ip.strip()}
_LOOPBACK = {"127.0.0.1", "::1", "localhost", None, ""}


def terminal_allowed(ip: str | None) -> bool:
    if TERMINAL_DISABLED:
        return False
    if not ADMIN_TERMINAL_IPS:
        return True                      # solo mode — no collaborators configured
    return ip in ADMIN_TERMINAL_IPS or ip in _LOOPBACK


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    from app.services.collab import set_loop
    set_loop(asyncio.get_running_loop())   # enable sync→async edit broadcasts
    runner_task = asyncio.create_task(job_runner.run_forever())
    yield
    runner_task.cancel()
    try:
        await runner_task
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title="KyChaPoGaS API",
    description="A MAD Video Creation Studio — backend API",
    version="0.1.0",
    lifespan=lifespan,
    redirect_slashes=False,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router, prefix="/api")
app.include_router(assets.router, prefix="/api")
app.include_router(tracks.router, prefix="/api")
app.include_router(clips.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")
app.include_router(generation.router, prefix="/api")
app.include_router(llm.router, prefix="/api")
app.include_router(system.router, prefix="/api")
app.include_router(analysis.router, prefix="/api")
app.include_router(puppet.router, prefix="/api")
app.include_router(companion.router, prefix="/api")
app.include_router(settings_router.router, prefix="/api")
app.include_router(engines_router.router, prefix="/api")
app.include_router(mad_router.router, prefix="/api")
app.include_router(inspect_router.router, prefix="/api")
app.include_router(comments_router.router, prefix="/api")


@app.get("/api/build-id")
def build_id():
    """Current frontend build id (the hashed JS filename) — changes on every rebuild.
    The client polls this and auto-reloads when it changes, so UI updates apply
    without a manual hard reload."""
    import re
    try:
        html = (FRONTEND_DIST / "index.html").read_text(encoding="utf-8")
        m = re.search(r"/assets/(index-[^\"']+\.js)", html)
        return {"build": m.group(1) if m else "dev"}
    except Exception:
        return {"build": "dev"}


@app.get("/api/ops/recent")
def ops_recent(project_id: int, limit: int = 50):
    """Recent timeline edits (user + AI), newest first — lets an assistant see
    what the user has been doing on the timeline."""
    from sqlmodel import Session
    from app.db.database import engine
    from app.services import command_api
    with Session(engine) as session:
        return command_api.get_recent_operations(project_id, session, limit)


@app.get("/api/health")
def health(request: Request):
    return {
        "status": "ok", "app": "KyChaPoGaS",
        "terminal_enabled": terminal_allowed(request.client.host if request.client else None),
    }


# ── Terminal proxy (so the app works on a single port in production) ──────────
# The embedded terminal connects to /terminal-health and /ws/terminal on the same
# origin. In dev these are proxied by Vite; in production FastAPI forwards them to
# the node-pty terminal server.

@app.get("/terminal-health")
async def terminal_health(request: Request):
    if not terminal_allowed(request.client.host if request.client else None):
        return JSONResponse({"status": "disabled"}, status_code=503)
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"http://{TERMINAL_HOST}:{TERMINAL_PORT}/health")
            return Response(content=r.content, status_code=r.status_code,
                            media_type=r.headers.get("content-type", "application/json"))
    except Exception:
        return JSONResponse({"status": "down"}, status_code=503)


@app.websocket("/ws/terminal")
async def ws_terminal(client: WebSocket):
    import websockets

    await client.accept()
    if not terminal_allowed(client.client.host if client.client else None):
        await client.close(code=1008)   # policy violation — terminal not allowed for this IP
        return
    qs = client.scope.get("query_string", b"").decode()
    upstream_url = f"ws://{TERMINAL_HOST}:{TERMINAL_PORT}/ws/terminal" + (f"?{qs}" if qs else "")
    try:
        async with websockets.connect(upstream_url, max_size=None) as upstream:
            async def client_to_upstream():
                try:
                    while True:
                        msg = await client.receive()
                        if msg.get("type") == "websocket.disconnect":
                            break
                        if msg.get("text") is not None:
                            await upstream.send(msg["text"])
                        elif msg.get("bytes") is not None:
                            await upstream.send(msg["bytes"])
                except Exception:
                    pass

            async def upstream_to_client():
                try:
                    async for data in upstream:
                        if isinstance(data, (bytes, bytearray)):
                            await client.send_bytes(data)
                        else:
                            await client.send_text(data)
                except Exception:
                    pass

            await asyncio.gather(client_to_upstream(), upstream_to_client())
    except Exception as e:
        log.info(f"terminal proxy ended: {e}")
    finally:
        try:
            await client.close()
        except Exception:
            pass


# ── Realtime collaboration (presence) ────────────────────────────────────────

@app.websocket("/ws/collab")
async def ws_collab(ws: WebSocket):
    from urllib.parse import parse_qs
    from app.services.collab import collab, Member

    await ws.accept()
    qs = parse_qs(ws.scope.get("query_string", b"").decode())
    try:
        project_id = int(qs.get("project_id", ["0"])[0])
    except ValueError:
        await ws.close()
        return
    client_id = qs.get("id", [""])[0] or f"c{id(ws)}"
    user = {
        "id": client_id,
        "name": (qs.get("name", ["Guest"])[0] or "Guest")[:40],
        "color": qs.get("color", ["#888"])[0][:9],
    }
    member = Member(client_id=client_id, ws=ws, user=user)

    others = await collab.connect(project_id, member)
    await ws.send_json({"type": "roster", "you": user, "users": others})
    await collab.broadcast(project_id, {"type": "join", "user": user}, exclude=client_id)

    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "presence":
                presence = {
                    "frame": msg.get("frame"),
                    "selected_clip_id": msg.get("selected_clip_id"),
                    "editing_clip_id": msg.get("editing_clip_id"),
                    "cursor": msg.get("cursor"),
                }
                collab.update_presence(project_id, client_id, presence)
                await collab.broadcast(
                    project_id,
                    {"type": "presence", "id": client_id, "user": user, "presence": presence},
                    exclude=client_id,
                )
            elif msg.get("type") == "edit":
                # A timeline mutation was committed by this client. Tell others to
                # re-sync from the server (SQLite is the source of truth).
                await collab.broadcast(
                    project_id,
                    {"type": "edit", "by": user.get("name")},
                    exclude=client_id,
                )
    except Exception:
        pass
    finally:
        await collab.disconnect(project_id, client_id)
        await collab.broadcast(project_id, {"type": "leave", "id": client_id})


# ── Serve the built frontend (production single-port deployment) ─────────────
# Registered LAST so /api/* and the terminal routes take precedence. When the
# frontend hasn't been built (dev), this is skipped and Vite serves the UI.
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
    log.info(f"Serving built frontend from {FRONTEND_DIST}")
else:
    log.info("frontend/dist not found — run `npm run build` for single-port serving")
