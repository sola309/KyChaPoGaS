from pathlib import Path
import json
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from datetime import datetime

from app.db.database import get_session
from app.models import Project, ProjectCreate, ProjectRead

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("/", response_model=list[ProjectRead])
def list_projects(session: Session = Depends(get_session)):
    return session.exec(select(Project)).all()


@router.post("/", response_model=ProjectRead, status_code=201)
def create_project(data: ProjectCreate, session: Session = Depends(get_session)):
    project = Project.model_validate(data)
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


@router.get("/{project_id}", response_model=ProjectRead)
def get_project(project_id: int, session: Session = Depends(get_session)):
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.patch("/{project_id}", response_model=ProjectRead)
def update_project(project_id: int, data: dict, session: Session = Depends(get_session)):
    """name/description/folder等の部分更新。folder=nullでフォルダから出す。"""
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    allowed = {"name", "description", "folder", "fps", "width", "height"}
    for k, v in data.items():
        if k in allowed:
            setattr(project, k, v)
    project.updated_at = datetime.utcnow()
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, session: Session = Depends(get_session)):
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    session.delete(project)
    session.commit()


# ── export / import (.kycha.zip) ─────────────────────────────────────────────

from fastapi import UploadFile, File
from fastapi.responses import FileResponse


@router.post("/{project_id}/export")
def export_project_ep(project_id: int):
    """プロジェクト一式を .kycha.zip に書き出す(assets/コメント/mad-kit同梱)。"""
    from app.services.project_archive import export_project
    out = export_project(project_id)
    return {"file": out.name, "size_bytes": out.stat().st_size,
            "download": f"/api/projects/export/download/{out.name}"}


@router.get("/export/download/{name}")
def download_export(name: str):
    from app.services.project_archive import EXPORTS
    p = (EXPORTS / name).resolve()
    if not str(p).startswith(str(EXPORTS.resolve())) or not p.exists():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(p, filename=name, media_type="application/zip")


@router.post("/import", status_code=201)
async def import_project_ep(file: UploadFile = File(...)):
    """アーカイブ(.kycha.zip)から新規プロジェクトとして復元する。IDは振り直される。"""
    from app.services.project_archive import import_project, EXPORTS
    EXPORTS.mkdir(parents=True, exist_ok=True)
    tmp = EXPORTS / f"_upload_{file.filename}"
    with tmp.open("wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    try:
        pid = import_project(tmp)
    finally:
        tmp.unlink(missing_ok=True)
    return {"project_id": pid}

# ── 📖 制作バイブル ───────────────────────────────────────────────────────────
# プロジェクト単位の制作知識(キャスト名簿・画作りルール等)を1つのJSONで保持する。
# シーン/カット意図はタイムラインのピン(attrs_json)側に住み、ここには置かない。
# ユーザーが意図を書き、Claudeがプロンプト設計時に読む・議論の結果を書き戻す、の双方向を想定。
_BIBLE_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "bible"


def _bible_path(project_id: int) -> Path:
    _BIBLE_DIR.mkdir(parents=True, exist_ok=True)
    return _BIBLE_DIR / f"{project_id}.json"


@router.get("/{project_id}/bible")
def get_bible(project_id: int):
    p = _bible_path(project_id)
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


@router.put("/{project_id}/bible")
def put_bible(project_id: int, body: dict):
    _bible_path(project_id).write_text(
        json.dumps(body, ensure_ascii=False, indent=1), encoding="utf-8")
    return body
