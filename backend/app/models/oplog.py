from datetime import datetime
from typing import Optional

from sqlmodel import SQLModel, Field


class OperationLog(SQLModel, table=True):
    """
    A cross-process record of timeline edits, so an AI assistant (via MCP/LLM)
    can observe what the user has been doing. Written by the REST routers (user
    actions) and command_api (AI actions); both share the same SQLite DB.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(index=True)
    ts: datetime = Field(default_factory=datetime.utcnow)
    actor: str = "user"        # "user" | "ai"
    kind: str = ""             # add_clip | move_clip | trim_clip | delete_clip | split_clip | ...
    detail: str = ""           # short human-readable summary
