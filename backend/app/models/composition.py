from datetime import datetime
from typing import Optional
from sqlmodel import SQLModel, Field


class Composition(SQLModel, table=True):
    """コンポジション(入れ子のタイムライン)。設計は docs/composition-design.md。

    親のタイムラインからは「描き出した動画素材」として見える(clip.kind='comp')。
    中身(レイヤー)は data_json の文書で、tools/comp-kit のエンジンが描く。
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    name: str = "コンポジション"
    width: int = 1920
    height: int = 1080
    fps: float = 24.0
    duration_frames: int = 120
    data_json: str = '{"version": 1, "bg": null, "layers": []}'
    rev: int = 1                  # 保存のたびに +1
    rendered_rev: int = 0         # 最後に描き出したときの rev(0 = 未)
    rendered_asset_id: Optional[int] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
