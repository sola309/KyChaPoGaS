from datetime import datetime
from typing import Optional
from sqlmodel import SQLModel, Field


class ProjectBase(SQLModel):
    name: str
    description: Optional[str] = None
    fps: float = 30.0
    # Default canvas: 1280x720 — exact 16:9, matches Wan2.2's 720p bucket and is
    # SDXL-compatible. Generation uses each model's nearest 16:9 bucket and fits.
    width: int = 1280
    height: int = 720


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
