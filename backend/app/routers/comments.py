"""
/api/comments — timeline comments (非同期の演出指示キュー).

A comment pins an instruction to a moment in a project: time, optional shot,
optional object path (from the Shot Editor picker). The user drops comments
while reviewing; the AI agent works through open ones and replies. Storage is
one JSONL per project: backend/data/comments/<project_id>.jsonl (one line per
comment; later lines with the same id override earlier ones — append-only).
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/comments", tags=["comments"])
DIR = Path(__file__).resolve().parent.parent.parent / "data" / "comments"


def _path(pid: int) -> Path:
    DIR.mkdir(parents=True, exist_ok=True)
    return DIR / f"{pid}.jsonl"


def _load(pid: int) -> dict[int, dict]:
    out: dict[int, dict] = {}
    p = _path(pid)
    if p.exists():
        for line in p.read_text().splitlines():
            if line.strip():
                e = json.loads(line)
                out[e["id"]] = e
    return out


def _append(pid: int, entry: dict) -> None:
    with _path(pid).open("a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


class CommentCreate(BaseModel):
    t_sec: float
    text: str
    shot_id: str | None = None
    object_path: str | None = None
    author: str = "user"


class CommentUpdate(BaseModel):
    status: str | None = None      # open | resolved | wontfix
    reply: str | None = None       # agent's answer / what was done


@router.get("/{pid}")
def list_comments(pid: int, status: str | None = None):
    items = sorted(_load(pid).values(), key=lambda e: e["t_sec"])
    if status:
        items = [e for e in items if e.get("status") == status]
    return items


@router.post("/{pid}", status_code=201)
def add_comment(pid: int, c: CommentCreate):
    items = _load(pid)
    cid = max(items.keys(), default=0) + 1
    entry = {"id": cid, "ts": datetime.now().isoformat(timespec="seconds"),
             "status": "open", "reply": None, **c.model_dump()}
    _append(pid, entry)
    return entry


@router.patch("/{pid}/{cid}")
def update_comment(pid: int, cid: int, u: CommentUpdate):
    items = _load(pid)
    if cid not in items:
        raise HTTPException(404, f"comment {cid} not found")
    e = dict(items[cid])
    if u.status is not None:
        e["status"] = u.status
    if u.reply is not None:
        e["reply"] = u.reply
        e["replied_ts"] = datetime.now().isoformat(timespec="seconds")
    _append(pid, e)
    return e
