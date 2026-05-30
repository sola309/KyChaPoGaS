from typing import Optional
from sqlmodel import SQLModel, Field


class ClipBase(SQLModel):
    track_id: int = Field(foreign_key="track.id")
    asset_id: Optional[int] = Field(default=None, foreign_key="asset.id")
    start_frame: int = 0       # position on the timeline (in frames)
    duration_frames: int = 30  # length of the clip (in frames)
    asset_in_frame: int = 0    # which frame of the source asset to start from


class Clip(ClipBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)


class ClipCreate(ClipBase):
    pass


class ClipUpdate(SQLModel):
    start_frame: Optional[int] = None
    duration_frames: Optional[int] = None
    asset_in_frame: Optional[int] = None
    track_id: Optional[int] = None


class ClipRead(ClipBase):
    id: int
