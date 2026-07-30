from typing import Optional
from sqlmodel import SQLModel, Field


class TrackBase(SQLModel):
    project_id: int = Field(foreign_key="project.id")
    name: str
    track_type: str  # video | audio | reference
    order: int = 0
    hidden: bool = False   # 非表示トラック(プレビュー/レンダから除外)


class Track(TrackBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)


class TrackCreate(TrackBase):
    pass


class TrackRead(TrackBase):
    id: int
