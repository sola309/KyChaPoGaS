"""job_runner が ComfyUI に投げる最初のワークフローを、ComfyUI に触れずに取り出す補助スクリプト。

usage: python _capture_wf.py <backend_dir> <cases.json> <out.json>
cases.json = {"assets": {id: {file_path,width,height,duration_sec}}, "cases": {name: params}}
backend_dir の app を読み込む(=改修前/改修後のどちらでも同じ手順で比べられる)。
一時 SQLite を使い、本物の DB にはつながない。upload は名前を返すだけ、submit で捕まえて止める。
"""
import asyncio
import json
import os
import sys
import tempfile


class _Stop(Exception):
    pass


def main(backend_dir: str, cases_path: str, out_path: str) -> None:
    os.environ["COMFYUI_URL"] = "http://127.0.0.1:9"
    sys.path.insert(0, backend_dir)
    from sqlmodel import SQLModel, Session, create_engine
    import app.db.database as dbm
    tmp = tempfile.mkdtemp(prefix="h3cap_")
    eng = create_engine(f"sqlite:///{tmp}/cap.db", connect_args={"check_same_thread": False})
    dbm.engine = eng
    from app.models import Asset, Project, Job  # noqa: F401
    SQLModel.metadata.create_all(eng)
    import app.services.job_runner as jr
    jr.engine = eng
    from app.services import settings_store
    settings_store._CACHE = {}
    data = json.load(open(cases_path))
    with Session(eng) as s:
        for aid, row in data["assets"].items():
            s.add(Asset(id=int(aid), project_id=1, name=os.path.basename(row["file_path"]),
                        asset_type="video" if row["file_path"].endswith(".mp4") else "image",
                        file_path=row["file_path"], width=row.get("width"), height=row.get("height"),
                        duration_sec=row.get("duration_sec")))
        s.commit()
    from app.services.comfyui import comfyui
    captured = {}

    async def is_available():
        return True

    async def upload_image(p):
        return {"name": os.path.basename(str(p))}

    async def submit(wf):
        captured["wf"] = wf
        raise _Stop()

    comfyui.is_available = is_available
    comfyui.upload_image = upload_image
    comfyui.submit = submit

    class J:
        id = 999999

    out = {}
    for name, params in data["cases"].items():
        captured.clear()
        try:
            asyncio.run(jr._generate_video_i2v(J(), dict(params)))
            out[name] = {"error": "no submit"}
        except _Stop:
            out[name] = {"wf": captured["wf"]}
        except Exception as e:
            out[name] = {"error": f"{type(e).__name__}: {e}"}
    json.dump(out, open(out_path, "w"), ensure_ascii=False, indent=1, sort_keys=True)


if __name__ == "__main__":
    main(*sys.argv[1:4])
