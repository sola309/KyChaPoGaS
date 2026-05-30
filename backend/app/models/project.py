from datetime import datetime
from typing import Optional
from sqlmodel import SQLModel, Field


class ProjectBase(SQLModel):
    name: str
    description: Optional[str] = None
    fps: float = 30.0
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
