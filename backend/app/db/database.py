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

    tables = {r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'")).fetchall()}

    # ── Phase 5: job VRAM columns ─────────────────────────────────────────
    if "job" in tables:
        job_cols = columns("job")
        if "vram_estimated_mb" not in job_cols:
            conn.execute(text("ALTER TABLE job ADD COLUMN vram_estimated_mb INTEGER"))
            log.info("Migration: added job.vram_estimated_mb")
        if "vram_peak_mb" not in job_cols:
            conn.execute(text("ALTER TABLE job ADD COLUMN vram_peak_mb INTEGER"))
            log.info("Migration: added job.vram_peak_mb")

    # ── Phase D: clip speed / time-remap columns ──────────────────────────
    if "clip" in tables:
        clip_cols = columns("clip")
        if "speed" not in clip_cols:
            conn.execute(text("ALTER TABLE clip ADD COLUMN speed FLOAT DEFAULT 1.0"))
            log.info("Migration: added clip.speed")
        if "speed_ease" not in clip_cols:
            conn.execute(text("ALTER TABLE clip ADD COLUMN speed_ease VARCHAR DEFAULT 'linear'"))
            log.info("Migration: added clip.speed_ease")

    # ── Phase E: asset proxy path ─────────────────────────────────────────
    if "asset" in tables and "proxy_path" not in columns("asset"):
        conn.execute(text("ALTER TABLE asset ADD COLUMN proxy_path VARCHAR"))
        log.info("Migration: added asset.proxy_path")

    # ── Transitions + audio fades ─────────────────────────────────────────
    if "clip" in tables:
        clip_cols = columns("clip")
        for col, ddl in [
            ("transition_in",     "ALTER TABLE clip ADD COLUMN transition_in VARCHAR DEFAULT ''"),
            ("transition_frames", "ALTER TABLE clip ADD COLUMN transition_frames INTEGER DEFAULT 0"),
            ("fade_in_frames",    "ALTER TABLE clip ADD COLUMN fade_in_frames INTEGER DEFAULT 0"),
            ("fade_out_frames",   "ALTER TABLE clip ADD COLUMN fade_out_frames INTEGER DEFAULT 0"),
            ("opacity",           "ALTER TABLE clip ADD COLUMN opacity FLOAT DEFAULT 1.0"),
            ("blend",             "ALTER TABLE clip ADD COLUMN blend VARCHAR DEFAULT 'normal'"),
        ]:
            if col not in clip_cols:
                conn.execute(text(ddl))
                log.info(f"Migration: added clip.{col}")


def create_db_and_tables() -> None:
    # Import all models so SQLModel.metadata is populated
    from app.models import (  # noqa: F401 — side-effect imports
        Project, Asset, Track, Clip, Job,
    )
    from app.models.analysis import AnalysisResult  # noqa: F401
    from app.models.oplog import OperationLog  # noqa: F401
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        _migrate(conn)


def get_session():
    with Session(engine) as session:
        yield session
