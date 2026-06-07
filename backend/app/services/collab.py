"""
Realtime collaboration — presence (and later, edit sync).

In-memory, single-process registry of who is connected to each project, plus
each user's live presence (playhead frame, selected clip, cursor). The backend
runs one uvicorn worker, so an in-memory manager is sufficient; if it is ever
scaled to multiple workers this would need a shared pub/sub (e.g. Redis).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("collab")

# The main event loop (captured at startup) so synchronous code (REST handlers,
# command_api) can schedule a broadcast onto it.
_loop: asyncio.AbstractEventLoop | None = None


def set_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def notify_edit(project_id: int, by: str | None = None) -> None:
    """Schedule an 'edit' broadcast from synchronous code (no-op if no loop)."""
    if _loop is None:
        return
    try:
        asyncio.run_coroutine_threadsafe(
            collab.broadcast(project_id, {"type": "edit", "by": by}), _loop
        )
    except Exception:
        pass


@dataclass
class Member:
    client_id: str
    ws: WebSocket
    user: dict          # {id, name, color}
    presence: dict = field(default_factory=dict)   # {frame, selected_clip_id, cursor}


class CollabManager:
    def __init__(self) -> None:
        # project_id -> { client_id -> Member }
        self.rooms: dict[int, dict[str, Member]] = {}

    def _room(self, project_id: int) -> dict[str, Member]:
        return self.rooms.setdefault(project_id, {})

    async def connect(self, project_id: int, member: Member) -> list[dict]:
        """Register a member; return the current roster (others) for the joiner."""
        room = self._room(project_id)
        others = [{"user": m.user, "presence": m.presence} for m in room.values()]
        room[member.client_id] = member
        log.info(f"collab join project={project_id} user={member.user.get('name')} ({len(room)} online)")
        return others

    async def disconnect(self, project_id: int, client_id: str) -> None:
        room = self.rooms.get(project_id)
        if room and client_id in room:
            del room[client_id]
            if not room:
                self.rooms.pop(project_id, None)

    def update_presence(self, project_id: int, client_id: str, presence: dict) -> None:
        room = self.rooms.get(project_id)
        if room and client_id in room:
            room[client_id].presence = presence

    async def broadcast(self, project_id: int, message: dict[str, Any], exclude: str | None = None) -> None:
        room = self.rooms.get(project_id, {})
        dead: list[str] = []
        for cid, m in list(room.items()):
            if cid == exclude:
                continue
            try:
                await m.ws.send_json(message)
            except Exception:
                dead.append(cid)
        for cid in dead:
            room.pop(cid, None)


# Module-level singleton
collab = CollabManager()
