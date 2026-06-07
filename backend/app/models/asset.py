from datetime import datetime
from typing import Optional
from sqlmodel import SQLModel, Field


class AssetBase(SQLModel):
    project_id: int = Field(foreign_key="project.id")
    name: str
    asset_type: str  # video | audio | image | generated
    file_path: str
    duration_sec: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    file_size_bytes: Optional[int] = None
    # Low-res proxy for lightweight preview/scrubbing (final render uses the original).
    proxy_path: Optional[str] = None


class Asset(AssetBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class AssetCreate(AssetBase):
    pass


class AssetRead(AssetBase):
    id: int
    created_at: datetime
