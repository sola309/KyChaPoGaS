import json
from datetime import datetime
from typing import Any, Optional

from sqlmodel import SQLModel, Field


class AnalysisResult(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    asset_id: int = Field(index=True)
    analysis_type: str    # "audio_beats" | "scene_changes" | "motion"
    result_json: str = "{}"
    created_at: datetime = Field(default_factory=datetime.utcnow)


class AnalysisResultRead(SQLModel):
    id: int
    asset_id: int
    analysis_type: str
    result: dict[str, Any]
    created_at: datetime

    @classmethod
    def from_orm(cls, obj: AnalysisResult) -> "AnalysisResultRead":
        return cls(
            id=obj.id,
            asset_id=obj.asset_id,
            analysis_type=obj.analysis_type,
            result=json.loads(obj.result_json),
            created_at=obj.created_at,
        )
