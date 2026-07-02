from datetime import datetime
from typing import Optional
from sqlmodel import SQLModel, Field


class ProjectBase(SQLModel):
    name: str
    description: Optional[str] = None
    fps: float = 30.0
    # Default canvas: 1920x1080 — full HD 16:9 so exports are sharp on modern
    # displays (720p looked soft). Generation still uses each model's nearest 16:9
    # bucket and is scaled up with lanczos; the timeline composites at 1080p.
    width: int = 1920
    height: int = 1080


class Project(ProjectBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class ProjectCreate(ProjectBase):
    pass


class ProjectRead(ProjectBase):
    id: int
    created_at: datetime
    updated_at: datetime
