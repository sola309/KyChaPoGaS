import json
from datetime import datetime
from typing import Optional
from sqlmodel import SQLModel, Field


class JobBase(SQLModel):
    project_id: int = Field(foreign_key="project.id")
    job_type: str   # generate_image | generate_audio | generate_video_i2v
    status: str = "pending"   # pending | running | completed | failed | cancelled
    params: str = "{}"        # JSON string
    result_asset_ids: str = "[]"  # JSON array
    progress: float = 0.0
    error_msg: Optional[str] = None
    vram_estimated_mb: Optional[int] = None   # pre-run VRAM estimate
    vram_peak_mb: Optional[int] = None        # actual peak VRAM observed during run
    created_at: datetime = Field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class Job(JobBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)


class JobCreate(SQLModel):
    project_id: int
    job_type: str
    params: dict = {}


class JobRead(SQLModel):
    id: int
    project_id: int
    job_type: str
    status: str
    params: dict
    result_asset_ids: list[int]
    progress: float
    error_msg: Optional[str]
    vram_estimated_mb: Optional[int]
    vram_peak_mb: Optional[int]
    created_at: datetime
    started_at: Optional[datetime]
    completed_at: Optional[datetime]

    @classmethod
    def from_orm(cls, job: Job) -> "JobRead":
        return cls(
            id=job.id,
            project_id=job.project_id,
            job_type=job.job_type,
            status=job.status,
            params=json.loads(job.params),
            result_asset_ids=json.loads(job.result_asset_ids),
            progress=job.progress,
            error_msg=job.error_msg,
            vram_estimated_mb=job.vram_estimated_mb,
            vram_peak_mb=job.vram_peak_mb,
            created_at=job.created_at,
            started_at=job.started_at,
            completed_at=job.completed_at,
        )
