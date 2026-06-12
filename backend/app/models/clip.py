from typing import Optional
from sqlmodel import SQLModel, Field


class ClipBase(SQLModel):
    track_id: int = Field(foreign_key="track.id")
    asset_id: Optional[int] = Field(default=None, foreign_key="asset.id")
    start_frame: int = 0       # position on the timeline (in frames)
    duration_frames: int = 30  # length of the clip (in frames)
    asset_in_frame: int = 0    # which frame of the source asset to start from
    speed: float = 1.0         # playback speed multiplier (>1 faster, <1 slower)
    # Optional speed easing for accel/decel within the clip.
    # 'linear' (constant) | 'in' | 'out' | 'inout' — shapes the speed ramp.
    speed_ease: str = "linear"
    # Transition INTO this clip from the previous segment on the same track.
    # '' (hard cut) | 'cross' (crossfade) | 'white' (white flash) | 'black' (dip to black)
    # Duration-preserving: the previous segment is freeze-extended before the
    # xfade, so the timeline length (and music sync) never changes.
    transition_in: str = ""
    transition_frames: int = 0   # transition duration (timeline frames)
    # Audio fades (audio clips; timeline frames at project fps)
    fade_in_frames: int = 0
    fade_out_frames: int = 0


class Clip(ClipBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)


class ClipCreate(ClipBase):
    pass


class ClipUpdate(SQLModel):
    start_frame: Optional[int] = None
    duration_frames: Optional[int] = None
    asset_in_frame: Optional[int] = None
    track_id: Optional[int] = None
    speed: Optional[float] = None
    speed_ease: Optional[str] = None
    transition_in: Optional[str] = None
    transition_frames: Optional[int] = None
    fade_in_frames: Optional[int] = None
    fade_out_frames: Optional[int] = None


class ClipRead(ClipBase):
    id: int
