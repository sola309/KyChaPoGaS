import logging

from sqlmodel import SQLModel, create_engine, Session, text
from pathlib import Path

log = logging.getLogger("db")

DB_PATH = Path(__file__).parent.parent.parent / "data" / "kychapogas.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)


def _migrate(conn) -> None:
    """
    Idempotent schema migrations for SQLite.
    Called after create_all — adds new columns to existing tables.
    """
    # Fetch existing columns once
    def columns(table: str) -> set[str]:
        rows = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
        return {r[1] for r in rows}

    # ── Phase 5: job VRAM columns ─────────────────────────────────────────
    if "job" in {r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'")).fetchall()}:
        job_cols = columns("job")
        if "vram_estimated_mb" not in job_cols:
            conn.execute(text("ALTER TABLE job ADD COLUMN vram_estimated_mb INTEGER"))
            log.info("Migration: added job.vram_estimated_mb")
        if "vram_peak_mb" not in job_cols:
            conn.execute(text("ALTER TABLE job ADD COLUMN vram_peak_mb INTEGER"))
            log.info("Migration: added job.vram_peak_mb")


def create_db_and_tables() -> None:
    # Import all models so SQLModel.metadata is populated
    from app.models import (  # noqa: F401 — side-effect imports
        Project, Asset, Track, Clip, Job,
    )
    from app.models.analysis import AnalysisResult  # noqa: F401
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        _migrate(conn)


def get_session():
    with Session(engine) as session:
        yield session
