"""
/api/inspect — UI inspect mode (「これを直して」の指差し共有).

The frontend's inspect mode (🎯) lets the user click ANY UI element; the
capture (React component chain, DOM path, text, rect) is appended here to
  backend/data/inspect_log.jsonl
so an AI agent (Claude Code / local LLM) can read exactly what the user was
pointing at when they say 「さっき選択したUIを◯◯して」.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/inspect", tags=["inspect"])

LOG = Path(__file__).resolve().parent.parent.parent / "data" / "inspect_log.jsonl"


class Capture(BaseModel):
    component_chain: list[str] = []
    dom_path: str = ""
    text: str = ""
    title: str = ""
    rect: dict = {}
    html: str = ""
    url: str = ""
    note: str = ""


@router.post("")
def record(cap: Capture):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    n = sum(1 for _ in LOG.open()) + 1 if LOG.exists() else 1
    entry = {"id": n, "ts": datetime.now().isoformat(timespec="seconds"), **cap.model_dump()}
    with LOG.open("a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return {"id": n}


@router.get("/latest")
def latest(n: int = 5):
    if not LOG.exists():
        return []
    lines = LOG.read_text().strip().splitlines()
    return [json.loads(x) for x in lines[-n:]][::-1]
