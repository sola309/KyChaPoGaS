import logging

from sqlalchemy import event
from sqlmodel import SQLModel, create_engine, Session, text
from pathlib import Path

log = logging.getLogger("db")

DB_PATH = Path(__file__).parent.parent.parent / "data" / "kychapogas.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# timeout: 書き込みロック待ち(ジョブランナーの進捗更新と一覧取得が競合する)
engine = create_engine(f"sqlite:///{DB_PATH}", echo=False, connect_args={"timeout": 30})


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record) -> None:
    # WAL: 書き込み中も読み取りをブロックしない(既定のdeleteモードは進捗更新のたびに
    # 全リーダーが待たされる)。synchronous=NORMAL はWALでは安全かつ高速。
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.close()


# 絞り込み列の索引。SQLModelのforeign_keyは索引を作らないため明示する。
# 既存DBには create_all が索引を足さないので _migrate でも IF NOT EXISTS で作る。
INDEXES = [
    ("ix_asset_project_id",  "asset", "project_id"),
    ("ix_asset_starred",     "asset", "starred"),
    ("ix_job_project_id",    "job",   "project_id"),
    ("ix_job_status",        "job",   "status"),
    ("ix_job_created_at",    "job",   "created_at"),
    ("ix_job_project_created", "job", "project_id, created_at"),
    ("ix_clip_track_id",     "clip",  "track_id"),
    ("ix_clip_asset_id",     "clip",  "asset_id"),
    ("ix_track_project_id",  "track", "project_id"),
]


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
        if "result_json" not in job_cols:
            conn.execute(text("ALTER TABLE job ADD COLUMN result_json VARCHAR DEFAULT ''"))
            log.info("Migration: added job.result_json")
        if "phase" not in job_cols:
            conn.execute(text("ALTER TABLE job ADD COLUMN phase VARCHAR DEFAULT ''"))
            log.info("Migration: added job.phase")

    # ── Phase D: clip speed / time-remap columns ──────────────────────────
    if "clip" in tables:
        clip_cols = columns("clip")
        if "speed" not in clip_cols:
            conn.execute(text("ALTER TABLE clip ADD COLUMN speed FLOAT DEFAULT 1.0"))
            log.info("Migration: added clip.speed")
        if "speed_ease" not in clip_cols:
            conn.execute(text("ALTER TABLE clip ADD COLUMN speed_ease VARCHAR DEFAULT 'linear'"))
            log.info("Migration: added clip.speed_ease")
        if "transition_ease" not in clip_cols:
            conn.execute(text("ALTER TABLE clip ADD COLUMN transition_ease VARCHAR DEFAULT 'linear'"))
            conn.execute(text("ALTER TABLE clip ADD COLUMN transition_hold FLOAT DEFAULT 0.5"))
            log.info("Migration: added clip.transition_ease/transition_hold")

    # ── Track hidden (表示/非表示) ─────────────────────────────────────────
    if "track" in tables and "hidden" not in columns("track"):
        conn.execute(text("ALTER TABLE track ADD COLUMN hidden BOOLEAN DEFAULT 0"))
        log.info("Migration: added track.hidden")

    # ── Clip time-remap (Scenes: シーンチェンジ位置の手動補正) ────────────
    if "clip" in tables and "remap_json" not in columns("clip"):
        conn.execute(text("ALTER TABLE clip ADD COLUMN remap_json VARCHAR DEFAULT ''"))
        log.info("Migration: added clip.remap_json")

    # ── Track layout (レイヤーをコンポジションとして配置する) ──────────────
    if "track" in tables and "layout_json" not in columns("track"):
        conn.execute(text("ALTER TABLE track ADD COLUMN layout_json VARCHAR DEFAULT ''"))
        log.info("Migration: added track.layout_json")

    # ── Project folder (UIグループ折りたたみ) ─────────────────────────────
    if "project" in tables and "folder" not in columns("project"):
        conn.execute(text("ALTER TABLE project ADD COLUMN folder VARCHAR"))
        log.info("Migration: added project.folder")

    # ── Phase E: asset proxy path ─────────────────────────────────────────
    if "asset" in tables and "proxy_path" not in columns("asset"):
        conn.execute(text("ALTER TABLE asset ADD COLUMN proxy_path VARCHAR"))
        log.info("Migration: added asset.proxy_path")
    if "asset" in tables and "starred" not in columns("asset"):
        conn.execute(text("ALTER TABLE asset ADD COLUMN starred BOOLEAN DEFAULT 0"))
        log.info("Migration: added asset.starred")
    if "clip" in tables and "locked" not in columns("clip"):
        conn.execute(text("ALTER TABLE clip ADD COLUMN locked BOOLEAN DEFAULT 0"))
        log.info("Migration: added clip.locked")
    if "asset" in tables and "gen_params_json" not in columns("asset"):
        conn.execute(text("ALTER TABLE asset ADD COLUMN gen_params_json VARCHAR DEFAULT ''"))
        log.info("Migration: added asset.gen_params_json")

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
            ("transform_json",    "ALTER TABLE clip ADD COLUMN transform_json VARCHAR DEFAULT ''"),
            ("kind",              "ALTER TABLE clip ADD COLUMN kind VARCHAR DEFAULT 'media'"),
            ("attrs_json",        "ALTER TABLE clip ADD COLUMN attrs_json VARCHAR DEFAULT ''"),
            ("posterize_fps",     "ALTER TABLE clip ADD COLUMN posterize_fps INTEGER DEFAULT 0"),
        ]:
            if col not in clip_cols:
                conn.execute(text(ddl))
                log.info(f"Migration: added clip.{col}")

    # ── 索引(冪等) ────────────────────────────────────────────────────────
    for name, table, cols in INDEXES:
        if table in tables:
            conn.execute(text(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({cols})"))


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
