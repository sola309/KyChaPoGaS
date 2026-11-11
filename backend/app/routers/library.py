"""📚 共有素材ライブラリの API(長尺素材のカット一覧)。

  GET    /api/library/items                      ライブラリの素材(+ まだ入っていない長い動画 candidates)
  POST   /api/library/items                      登録(move=true なら素材ファイルをライブラリのプロジェクトへ移す)
  PATCH  /api/library/items/{asset_id}           シリーズ・作品・種別・年・タグ・メモ・評価・★
  DELETE /api/library/items/{asset_id}           登録だけ外す(素材とファイルは残す。カットと data/library/<id>/ は消す)
  POST   /api/library/items/{asset_id}/analyze   カット解析を始める(別プロセス。同時に 1 本、ほかは順番待ち)
  GET    /api/library/items/{asset_id}/cuts      カット一覧
  GET    /api/library/items/{asset_id}/sprites/{n}.jpg   サムネイル(カット 50 本 × 頭・中・尻)
  PATCH  /api/library/cuts/{id}                  タグ・評価・★・メモ
  POST   /api/library/cuts/bulk                  まとめてタグ・評価・★
  POST   /api/library/cuts/merge                 隣り合うカットをつなぐ
  POST   /api/library/cuts/{id}/split            カットを分ける
  GET    /api/library/tags                       タグと件数(候補用)
  POST   /api/library/place                      カットをタイムラインに置く(ふつうの media クリップ)

カットのフレームは素材の fps。タイムラインに置くときにプロジェクトの fps へ直す
(asset_in_frame / プロジェクト fps = 素材の秒。書き出しもプレビューも「その時刻を含む素材のコマ」を出す)。
DB のセッションは短く持ち、ffmpeg・別プロセスの間は持たない。
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db.database import engine
from app.models import Asset, Clip, Project, Track
from app.models.library import LIBRARY_PARTS, LibraryCut, LibraryItem
from app.services import library_cuts as lc

router = APIRouter(prefix="/library", tags=["library"])

LIBRARY_PROJECT_NAME = "📚 共有素材ライブラリ"
LIBRARY_FOLDER = "📚 ライブラリ"
LIBRARY_DESC = ("プロジェクトをまたいで使う元素材(劇場版の本編・予告など)。"
                "ここの素材は ★ 付きで、どのプロジェクトのアセット欄にも出ます。")
BACKEND_DIR = Path(__file__).resolve().parent.parent.parent      # backend/
DATA = BACKEND_DIR / "data"
ADOPT_LOG = BACKEND_DIR.parent / "outputs" / "library" / "adopt_log.jsonl"
CANDIDATE_MIN_SEC = 600.0
ANALYZE_EXTRA_ARGS: list[str] = []      # テスト用(例: ["--db", 一時 DB])
PART_ASCII = {"本編": "main", "予告": "trailer", "特典": "extra", "OP・ED": "oped", "その他": "other"}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _iso(d: Optional[datetime]) -> Optional[str]:
    return d.isoformat() + "Z" if d else None


def _tags(raw: str) -> list[str]:
    try:
        v = json.loads(raw or "[]")
    except ValueError:
        return []
    return [str(x) for x in v if isinstance(x, (str, int, float))] if isinstance(v, list) else []


def _clean_tags(tags: Optional[list]) -> list[str]:
    out: list[str] = []
    for t in tags or []:
        s = str(t).strip()[:40]
        if s and s not in out:
            out.append(s)
    return out[:50]


def _check_rating(r: Optional[int]) -> None:
    if r is not None and not (0 <= int(r) <= 5):
        raise HTTPException(status_code=422, detail="評価は 0〜5 で指定してください")


def _check_part(p: Optional[str]) -> None:
    if p is not None and p not in LIBRARY_PARTS:
        raise HTTPException(status_code=422, detail=f"種別は {' / '.join(LIBRARY_PARTS)} のどれかです")


TEXT_MAX = 200          # シリーズ・作品・表示名の長さの上限
NOTE_MAX = 2000         # メモ(カットのメモと同じ)
_NOT_NULL = {"series": "シリーズ", "work": "作品", "part": "種別", "sort_order": "並び順", "rating": "評価",
             "starred": "★"}


# ── 解析プロセスの管理(同時に 1 本、ほかは順番待ち) ─────────────────────────────

_lock = threading.RLock()
_procs: dict[int, subprocess.Popen] = {}      # asset_id → 解析中のプロセス(このバックエンドが起こしたもの)
_queue: list[int] = []                         # 順番待ちの asset_id
_watcher: Optional[threading.Thread] = None
_edit_locks: dict[int, threading.Lock] = {}


def _edit_lock(asset_id: int) -> threading.Lock:
    with _lock:
        if asset_id not in _edit_locks:
            _edit_locks[asset_id] = threading.Lock()
        return _edit_locks[asset_id]


def _pid_alive(pid: Optional[int], asset_id: Optional[int] = None) -> bool:
    """pid がこの素材の解析の CLI として生きているか。番号だけでは決めない(再起動の後に同じ番号の
    別のプロセスがいると、いつまでも解析中のままになり順番待ちも止まっていた): /proc の cmdline を見る。"""
    return lc.analysis_pid_alive(pid, asset_id)


def _set_item(asset_id: int, **kw) -> None:
    with Session(engine) as s:
        it = s.get(LibraryItem, asset_id)
        if not it:
            return
        for k, v in kw.items():
            setattr(it, k, v)
        it.updated_at = _now()
        s.add(it)
        s.commit()


def _running_elsewhere(exclude: Optional[int] = None) -> Optional[int]:
    """DB 上で running かつ pid が生きている素材(別のバックエンド・手で起こした CLI を含む)。"""
    with Session(engine) as s:
        rows = s.exec(select(LibraryItem).where(LibraryItem.analysis_status == "running")).all()
        for r in rows:
            if r.asset_id != exclude and _pid_alive(r.analysis_pid, r.asset_id):
                return r.asset_id
    return None


def _spawn(asset_id: int) -> subprocess.Popen:
    out_dir = lc.item_dir(asset_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    logf = open(out_dir / "analyze.log", "ab")
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    cmd = ["nice", "-n", "10", sys.executable, "-B", "-m", "app.services.library_cuts", "analyze", str(asset_id),
           *ANALYZE_EXTRA_ARGS]
    p = subprocess.Popen(cmd, cwd=str(BACKEND_DIR), env=env, stdout=logf, stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    logf.close()
    return p


def _start_next_locked() -> None:
    """走っている解析がなければ、順番待ちの先頭を起こす(_lock を持って呼ぶ)。"""
    global _watcher
    for aid, p in list(_procs.items()):
        if p.poll() is not None:
            _reap(aid, p)
    if any(p.poll() is None for p in _procs.values()):
        return
    if _running_elsewhere() is not None:
        _ensure_watcher_locked()
        return
    while _queue:
        aid = _queue.pop(0)
        try:
            p = _spawn(aid)
        except Exception as e:  # noqa: BLE001
            _set_item(aid, analysis_status="error", analysis_error=f"解析を始められませんでした: {e}",
                      analysis_pid=None)
            continue
        _procs[aid] = p
        _set_item(aid, analysis_status="running", analysis_progress=0.0, analysis_error="", analysis_pid=p.pid)
        break
    _ensure_watcher_locked()


def _ensure_watcher_locked() -> None:
    global _watcher
    if _watcher is not None and _watcher.is_alive():
        return
    if not _procs and not _queue:
        return
    _watcher = threading.Thread(target=_watch_loop, name="library-analyze-watch", daemon=True)
    _watcher.start()


def _reap(aid: int, p: subprocess.Popen) -> None:
    """終わったプロセスの後片付け。CLI が状態を書かずに落ちたら error にする。"""
    _procs.pop(aid, None)
    with Session(engine) as s:
        it = s.get(LibraryItem, aid)
        if it and it.analysis_status in ("running", "queued") and it.analysis_pid in (None, p.pid):
            it.analysis_status = "error"
            it.analysis_error = f"解析が途中で止まりました(終了コード {p.returncode})"
            it.analysis_pid = None
            it.updated_at = _now()
            s.add(it)
            s.commit()


def _watch_loop() -> None:
    while True:
        time.sleep(1.0)
        with _lock:
            for aid, p in list(_procs.items()):
                if p.poll() is not None:
                    _reap(aid, p)
            if not _procs and not _queue:
                return
            if not any(p.poll() is None for p in _procs.values()):
                _start_next_locked()
                if not _procs and not _queue:
                    return


def _fix_stale_status() -> None:
    """起動し直した後などで running / queued のまま止まっている素材を interrupted にする(GET /items で遅延実行)。"""
    with _lock:
        live = {aid for aid, p in _procs.items() if p.poll() is None}
        queued = set(_queue)
    with Session(engine) as s:
        rows = s.exec(select(LibraryItem).where(LibraryItem.analysis_status.in_(("running", "queued")))).all()
        changed = False
        for r in rows:
            if r.asset_id in live or r.asset_id in queued:
                continue
            if r.analysis_status == "running" and _pid_alive(r.analysis_pid, r.asset_id):
                continue
            r.analysis_status = "interrupted"
            r.analysis_error = "解析が途中で止まりました(もう一度「解析しなおす」を押してください)"
            r.analysis_pid = None
            r.updated_at = _now()
            s.add(r)
            changed = True
        if changed:
            s.commit()


# ── 共通 ───────────────────────────────────────────────────────────────────────

def _library_project(s: Session, create: bool = True) -> Optional[Project]:
    p = s.exec(select(Project).where(Project.name == LIBRARY_PROJECT_NAME).order_by(Project.id)).first()
    if p or not create:
        return p
    p = Project(name=LIBRARY_PROJECT_NAME, description=LIBRARY_DESC, folder=LIBRARY_FOLDER,
                fps=24.0, width=1920, height=1080)
    s.add(p)
    s.commit()
    s.refresh(p)
    return p


def _asset_info(a: Optional[Asset]) -> dict:
    if not a:
        return {}
    fp = Path(a.file_path or "")
    return {"name": a.name, "duration_sec": a.duration_sec, "width": a.width, "height": a.height,
            "project_id": a.project_id, "asset_type": a.asset_type, "starred": a.starred,
            "has_proxy": bool(a.proxy_path and Path(a.proxy_path).exists()),
            "file_exists": fp.exists(), "file_name": fp.name}


def _item_dict(it: LibraryItem, a: Optional[Asset]) -> dict:
    try:
        chapters = json.loads(it.chapters_json or "[]")
    except ValueError:
        chapters = []
    return {"asset_id": it.asset_id, "series": it.series, "work": it.work, "part": it.part,
            "sort_order": it.sort_order, "year": it.year, "tags": _tags(it.tags_json), "note": it.note,
            "rating": it.rating, "starred": it.starred, "chapters": chapters,
            "analysis_status": it.analysis_status, "analysis_progress": round(it.analysis_progress or 0.0, 4),
            "analysis_error": it.analysis_error, "analysis_version": it.analysis_version,
            "analyzed_at": _iso(it.analyzed_at), "cut_count": it.cut_count, "fps": it.fps, "frames": it.frames,
            "queue_position": (_queue.index(it.asset_id) + 1) if it.asset_id in _queue else None,
            "created_at": _iso(it.created_at), "updated_at": _iso(it.updated_at),
            # 素材(アセット)が消された・ファイルが無い: 解析もプレビューもできない(UI は「外す」を出す)
            "missing": a is None or not Path(a.file_path or "").exists(),
            "asset": _asset_info(a)}


def _cut_dict(c: LibraryCut) -> dict:
    return {"id": c.id, "idx": c.idx, "start": c.start_frame, "end": c.end_frame, "trans_in": c.trans_in,
            "trans_frames": c.trans_frames, "luma": round(c.luma, 4), "motion": round(c.motion, 5),
            "sat": round(c.sat, 4), "hue": c.hue, "dark": c.dark, "bright": c.bright,
            "tags": _tags(c.tags_json), "rating": c.rating, "starred": c.starred, "note": c.note,
            "edited": c.edited, "thumb_ver": c.thumb_ver}


def _get_item_or_404(s: Session, asset_id: int) -> LibraryItem:
    it = s.get(LibraryItem, asset_id)
    if not it:
        raise HTTPException(status_code=404, detail="ライブラリに入っていない素材です")
    return it


def _busy(asset_id: int) -> bool:
    with _lock:
        p = _procs.get(asset_id)
        if p is not None and p.poll() is None:
            # CLI は DB に done/error を書いてから終わる。書き終えたプロセスは少し待てば終わるので、
            # その間に「解析しなおす」が押されても解析中扱いにしない
            with Session(engine) as s:
                it = s.get(LibraryItem, asset_id)
                finished = bool(it and it.analysis_status in ("done", "error"))
            if not finished:
                return True
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                return True
            _reap(asset_id, p)
        if asset_id in _queue:
            return True
    with Session(engine) as s:
        it = s.get(LibraryItem, asset_id)
        return bool(it and it.analysis_status == "running" and _pid_alive(it.analysis_pid, asset_id))


# ── 素材 ───────────────────────────────────────────────────────────────────────

@router.get("/items")
def list_items():
    _fix_stale_status()
    with Session(engine) as s:
        lib = _library_project(s, create=False)
        items = s.exec(select(LibraryItem).order_by(LibraryItem.series, LibraryItem.sort_order,
                                                    LibraryItem.asset_id)).all()
        ids = [it.asset_id for it in items]
        assets = {a.id: a for a in s.exec(select(Asset).where(Asset.id.in_(ids))).all()} if ids else {}
        out = [_item_dict(it, assets.get(it.asset_id)) for it in items]
        cands = s.exec(select(Asset).where(Asset.asset_type == "video",
                                           Asset.duration_sec >= CANDIDATE_MIN_SEC)
                       .order_by(Asset.id.desc())).all()
        projects = {p.id: p.name for p in s.exec(select(Project)).all()}
        cand = []
        for a in cands:
            if a.id in assets:
                continue
            d = {"asset_id": a.id, **_asset_info(a), "project_name": projects.get(a.project_id, "")}
            d["suggest"] = _suggest_meta(a.name or Path(a.file_path).name)
            cand.append(d)
    return {"library_project_id": lib.id if lib else None, "items": out, "candidates": cand}


def _suggest_meta(name: str) -> dict:
    """ファイル名から series / work / part の下書き(UI の初期値)。"""
    stem = Path(name).stem
    low = stem.lower()
    part = "本編"
    if re.search(r"予告|trailer|_t0?1\b|pv|cm", low):
        part = "予告"
    elif re.search(r"特典|extra|bonus|making", low):
        part = "特典"
    elif re.search(r"\bop\b|\bed\b|opening|ending|ノンクレ", low):
        part = "OP・ED"
    work = re.sub(r"[_\-]+", " ", stem).strip()
    work = re.sub(r"\s+(本編|予告)$", "", work)
    return {"series": "", "work": work[:80], "part": part}


class ItemCreate(BaseModel):
    asset_id: int
    series: str = ""
    work: str = ""
    part: str = "本編"
    sort_order: Optional[int] = None
    year: Optional[int] = None
    tags: Optional[list[str]] = None
    note: str = ""
    name: Optional[str] = None       # アセットの表示名も変えるとき
    move: bool = True


class ItemPatch(BaseModel):
    series: Optional[str] = None
    work: Optional[str] = None
    part: Optional[str] = None
    sort_order: Optional[int] = None
    year: Optional[int] = None
    tags: Optional[list[str]] = None
    note: Optional[str] = None
    rating: Optional[int] = None
    starred: Optional[bool] = None


def _ascii_slug(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", s or "").strip("_").lower()
    return s[:40]


def _target_name(a: Asset, series: str, work: str, part: str) -> str:
    src = Path(a.file_path)
    ext = src.suffix.lower() if re.fullmatch(r"\.[A-Za-z0-9]{1,5}", src.suffix or "") else ".mp4"
    if src.name.isascii() and re.fullmatch(r"[A-Za-z0-9._\-]+", src.name):
        return src.name
    bits = [b for b in (_ascii_slug(series), _ascii_slug(work)) if b]
    base = "_".join(bits + [PART_ASCII.get(part, "other")]) if bits else f"asset{a.id}_{PART_ASCII.get(part, 'other')}"
    return base + ext


def _unique(dst: Path) -> Path:
    if not dst.exists():
        return dst
    for k in range(2, 1000):
        cand = dst.with_name(f"{dst.stem}_{k}{dst.suffix}")
        if not cand.exists():
            return cand
    raise HTTPException(status_code=409, detail="移動先のファイル名が決められません")


def _move(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.rename(src, dst)
    except OSError:
        shutil.move(str(src), str(dst))


def _proxy_job_running(s: Session, asset_id: int) -> bool:
    """この素材のプロキシを作るジョブ(create_proxy)が動いているか。動いている間に移すと、ffmpeg が
    +faststart の 2 回目で元の場所を開き直せず、壊れたプロキシが残り proxy_path も入らない。"""
    from app.models.job import Job
    for j in s.exec(select(Job).where(Job.job_type == "create_proxy", Job.status == "running")).all():
        try:
            if int(json.loads(j.params or "{}").get("asset_id") or -1) == int(asset_id):
                return True
        except (ValueError, TypeError, AttributeError):
            continue
    return False


def _adopt(asset_id: int, lib_pid: int, series: str, work: str, part: str, name: Optional[str]) -> tuple[dict, object]:
    """素材をライブラリのプロジェクトへ移す(adopt.py の移植)。ファイル → data/assets/<lib>/、
    プロキシと素材ごとのキャッシュ → data/proxies/<lib>/ と <新しい場所>/.preview /.peaks。失敗したら戻す。
    戻り値: (記録, undo)。undo() は移したファイルと素材の記録を元に戻す(登録の続きが失敗したとき用)。"""
    with Session(engine) as s:
        a = s.get(Asset, asset_id)
        if not a:
            raise HTTPException(status_code=404, detail="素材が見つかりません")
        if _proxy_job_running(s, asset_id):
            raise HTTPException(status_code=409, detail="プロキシを作っています。終わってからライブラリに入れてください")
        old_pid, fp, pp = a.project_id, a.file_path, a.proxy_path
        old_starred, old_name = a.starred, a.name
        new_name = _target_name(a, series, work, part)
    src = Path(fp)
    if not src.exists():
        raise HTTPException(status_code=422, detail="素材のファイルが見つかりません(移せません)")
    lib_dir = DATA / "assets" / str(lib_pid)
    moved: list[tuple[Path, Path]] = []
    newpp = pp
    if src.parent.resolve() == lib_dir.resolve() and old_pid == lib_pid:
        dst = src                                     # もうライブラリにある
    else:
        dst = _unique(lib_dir / new_name)
        try:
            _move(src, dst)
            moved.append((dst, src))
            # プロキシ・フィルムストリップ(data/proxies/<元のプロジェクト>/<id>.* と <id>_*)
            pdir_old = DATA / "proxies" / str(old_pid)
            pdir_new = DATA / "proxies" / str(lib_pid)
            if pdir_old.exists() and pdir_old.resolve() != pdir_new.resolve():
                for f in sorted(list(pdir_old.glob(f"{asset_id}.*")) + list(pdir_old.glob(f"{asset_id}_*"))):
                    t = _unique(pdir_new / f.name)
                    _move(f, t)
                    moved.append((t, f))
                    if pp and os.path.abspath(str(f)) == os.path.abspath(pp):
                        newpp = str(t)
            # 素材の隣のキャッシュ(.preview / .peaks)
            for sub in (".preview", ".peaks"):
                d_old, d_new = src.parent / sub, dst.parent / sub
                if d_old.exists() and d_old.resolve() != d_new.resolve():
                    for f in sorted(d_old.glob(f"{asset_id}_*")):
                        t = d_new / f.name
                        if t.exists():
                            continue
                        _move(f, t)
                        moved.append((t, f))
        except HTTPException:
            for x, y in reversed(moved):
                _move(x, y)
            raise
        except Exception as e:  # noqa: BLE001
            for x, y in reversed(moved):
                try:
                    _move(x, y)
                except Exception:
                    pass
            raise HTTPException(status_code=500, detail=f"ファイルを移せませんでした: {e}")
    try:
        with Session(engine) as s:
            a = s.get(Asset, asset_id)
            a.project_id = lib_pid
            a.file_path = str(dst)
            a.proxy_path = newpp
            a.starred = True
            if name:
                a.name = name
            s.add(a)
            s.commit()
    except Exception as e:  # noqa: BLE001
        for x, y in reversed(moved):
            try:
                _move(x, y)
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=f"素材の記録を直せませんでした(ファイルは元に戻しました): {e}")
    rec = {"t": time.strftime("%F %T"), "asset": asset_id, "from_project": old_pid, "src": fp, "dst": str(dst),
           "proxy_from": pp, "proxy_to": newpp, "name": name, "moved_files": len(moved), "via": "api"}
    _adopt_log(rec)

    def undo() -> None:
        with Session(engine) as s:
            a = s.get(Asset, asset_id)
            if a:
                a.project_id, a.file_path, a.proxy_path = old_pid, fp, pp
                a.starred, a.name = old_starred, old_name
                s.add(a)
                s.commit()
        for x, y in reversed(moved):
            _move(x, y)
        _adopt_log({"t": time.strftime("%F %T"), "asset": asset_id, "undo": True, "back_to": fp, "via": "api"})
    return rec, undo


def _adopt_log(rec: dict) -> None:
    try:
        ADOPT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(ADOPT_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


@router.post("/items", status_code=201)
def create_item(body: ItemCreate):
    _check_part(body.part)
    with Session(engine) as s:
        a = s.get(Asset, body.asset_id)
        if not a:
            raise HTTPException(status_code=404, detail="素材が見つかりません")
        if a.asset_type not in ("video", "generated") or not a.duration_sec:
            raise HTTPException(status_code=422, detail="動画の素材だけライブラリに入れられます")
        if s.get(LibraryItem, body.asset_id):
            raise HTTPException(status_code=409, detail="もうライブラリに入っています")
        lib = _library_project(s)
        lib_pid = lib.id
        fp = a.file_path
    name = (body.name or "").strip()[:TEXT_MAX] or None
    adopt, undo = None, None
    if body.move:
        adopt, undo = _adopt(body.asset_id, lib_pid, body.series, body.work, body.part, name)
        fp = adopt["dst"]
    else:
        with Session(engine) as s:
            a = s.get(Asset, body.asset_id)
            old_starred, old_name = a.starred, a.name
            a.starred = True
            if name:
                a.name = name
            s.add(a)
            s.commit()

        def undo() -> None:
            with Session(engine) as s:
                a = s.get(Asset, body.asset_id)
                if a:
                    a.starred, a.name = old_starred, old_name
                    s.add(a)
                    s.commit()
    info = {"fps": 0.0, "frames": 0, "chapters": []}
    try:
        info = lc.probe(fp)
    except Exception:
        pass
    try:
        with Session(engine) as s:
            so = body.sort_order
            if so is None:
                mx = s.exec(select(LibraryItem.sort_order).order_by(LibraryItem.sort_order.desc())).first()
                so = (mx or 0) + 1
            it = LibraryItem(asset_id=body.asset_id, series=body.series.strip()[:TEXT_MAX],
                             work=body.work.strip()[:TEXT_MAX], part=body.part, sort_order=so, year=body.year,
                             tags_json=json.dumps(_clean_tags(body.tags), ensure_ascii=False),
                             note=(body.note or "")[:NOTE_MAX],
                             chapters_json=json.dumps(info["chapters"], ensure_ascii=False),
                             fps=float(info["fps"] or 0.0), frames=int(info["frames"] or 0))
            s.add(it)
            s.commit()
            s.refresh(it)
            out = _item_dict(it, s.get(Asset, body.asset_id))
    except Exception as e:  # noqa: BLE001
        # 登録の行を書けなかった: 移したファイルと素材の記録を元に戻す(戻せなければ、押し直せば続きから終わる)
        try:
            undo()
        except Exception as e2:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=(
                f"ライブラリへの登録を書けませんでした({e})。ファイルはライブラリへ移したままです"
                f"(元に戻すのにも失敗: {e2})。もう一度「ライブラリに入れる」を押すと登録が終わります"))
        raise HTTPException(status_code=500, detail=f"ライブラリへの登録を書けませんでした(ファイルと素材は元に戻しました): {e}")
    out["moved"] = adopt
    return out


@router.patch("/items/{asset_id}")
def patch_item(asset_id: int, body: ItemPatch):
    _check_part(body.part)
    _check_rating(body.rating)
    data = body.model_dump(exclude_unset=True)
    for k, label in _NOT_NULL.items():
        if k in data and data[k] is None:
            raise HTTPException(status_code=422, detail=f"{label}は空(null)にできません")
    with Session(engine) as s:
        it = _get_item_or_404(s, asset_id)
        if "tags" in data:
            it.tags_json = json.dumps(_clean_tags(data.pop("tags")), ensure_ascii=False)
        for k, v in data.items():
            if k in ("series", "work"):
                v = v.strip()[:TEXT_MAX]
            if k == "note":
                v = (v or "")[:NOTE_MAX]
            setattr(it, k, v)
        it.updated_at = _now()
        s.add(it)
        s.commit()
        s.refresh(it)
        return _item_dict(it, s.get(Asset, asset_id))


@router.delete("/items/{asset_id}")
def delete_item(asset_id: int):
    with Session(engine) as s:
        _get_item_or_404(s, asset_id)
    if _busy(asset_id):
        raise HTTPException(status_code=409, detail="解析中です。終わってから外してください")
    with _edit_lock(asset_id):
        with Session(engine) as s:
            for c in s.exec(select(LibraryCut).where(LibraryCut.asset_id == asset_id)).all():
                s.delete(c)
            it = s.get(LibraryItem, asset_id)
            if it:
                s.delete(it)
            s.commit()
        d = lc.item_dir(asset_id)
        if d.exists() and d.resolve().parent == lc.DATA_DIR.resolve():
            shutil.rmtree(d, ignore_errors=True)
    return {"ok": True, "asset_id": asset_id}


@router.post("/items/{asset_id}/analyze", status_code=202)
def analyze_item(asset_id: int):
    with Session(engine) as s:
        it = _get_item_or_404(s, asset_id)
        a = s.get(Asset, asset_id)
        if not a or not Path(a.file_path).exists():
            raise HTTPException(status_code=422, detail="素材のファイルが見つかりません")
    # つなぐ・分けるの最中なら終わるのを待つ(その結果を解析が古い値で上書きしないように)。
    # つなぐ・分けるはこのロックの中で「解析中・順番待ち」を確かめるので、ここから先とは重ならない
    with _edit_lock(asset_id):
        with _lock:
            if _busy(asset_id):
                raise HTTPException(status_code=409, detail="この素材は解析中か順番待ちです")
            _queue.append(asset_id)
            _set_item(asset_id, analysis_status="queued", analysis_progress=0.0, analysis_error="",
                      analysis_pid=None)
            _start_next_locked()
            status = "running" if asset_id in _procs else "queued"
            pos = (_queue.index(asset_id) + 1) if asset_id in _queue else None
    return {"asset_id": asset_id, "status": status, "queue_position": pos}


# ── カット ─────────────────────────────────────────────────────────────────────

def _sprite_versions(asset_id: int, n_cuts: int) -> list[int]:
    d = lc.sprites_dir(asset_id)
    out = []
    for n in range((n_cuts + lc.SPRITE_CUTS - 1) // lc.SPRITE_CUTS):
        p = d / f"s{n}.jpg"
        out.append(int(p.stat().st_mtime * 1000) % 2_000_000_000 if p.exists() else 0)
    return out


@router.get("/items/{asset_id}/cuts")
def list_cuts(asset_id: int):
    with Session(engine) as s:
        _get_item_or_404(s, asset_id)
    try:
        lc.recover_item(engine, asset_id)      # 途中で止まった書き換え(落ちた・再起動)を仕上げる/取り消す
    except Exception:  # noqa: BLE001
        pass
    with Session(engine) as s:
        it = _get_item_or_404(s, asset_id)
        rows = s.exec(select(LibraryCut).where(LibraryCut.asset_id == asset_id)
                      .order_by(LibraryCut.start_frame)).all()
        try:
            chapters = json.loads(it.chapters_json or "[]")
        except ValueError:
            chapters = []
        cuts = [_cut_dict(c) for c in rows]
        fps, frames, ver, status = it.fps, it.frames, it.analysis_version, it.analysis_status
    return {"asset_id": asset_id, "fps": fps, "frames": frames, "chapters": chapters, "version": ver,
            "analysis_status": status,
            "sprites": {"per_sheet": lc.SPRITE_CUTS, "cols": 3, "cell_w": lc.TW, "cell_h": lc.TH,
                        "versions": _sprite_versions(asset_id, len(cuts))},
            "cuts": cuts}


@router.get("/items/{asset_id}/sprites/{n}.jpg")
def get_sprite(asset_id: int, n: int, v: Optional[str] = None):
    if n < 0:
        raise HTTPException(status_code=404, detail="サムネイルがありません")
    p = lc.sprites_dir(asset_id) / f"s{n}.jpg"
    if not p.exists():
        raise HTTPException(status_code=404, detail="サムネイルがありません(解析が済んでいません)")
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


class CutPatch(BaseModel):
    tags: Optional[list[str]] = None
    rating: Optional[int] = None
    starred: Optional[bool] = None
    note: Optional[str] = None


class CutBulk(BaseModel):
    ids: list[int]
    add_tags: Optional[list[str]] = None
    remove_tags: Optional[list[str]] = None
    rating: Optional[int] = None
    starred: Optional[bool] = None


class CutMerge(BaseModel):
    ids: list[int]


class CutSplit(BaseModel):
    at: int


@router.patch("/cuts/{cut_id}")
def patch_cut(cut_id: int, body: CutPatch):
    _check_rating(body.rating)
    with Session(engine) as s:
        c = s.get(LibraryCut, cut_id)
        if not c:
            raise HTTPException(status_code=404, detail="カットが見つかりません")
        if body.tags is not None:
            c.tags_json = json.dumps(_clean_tags(body.tags), ensure_ascii=False)
        if body.rating is not None:
            c.rating = int(body.rating)
        if body.starred is not None:
            c.starred = bool(body.starred)
        if body.note is not None:
            c.note = body.note[:2000]
        s.add(c)
        s.commit()
        s.refresh(c)
        return _cut_dict(c)


@router.post("/cuts/bulk")
def bulk_cuts(body: CutBulk):
    _check_rating(body.rating)
    if not body.ids:
        raise HTTPException(status_code=422, detail="カットを選んでください")
    add, rem = _clean_tags(body.add_tags), set(_clean_tags(body.remove_tags))
    with Session(engine) as s:
        rows = s.exec(select(LibraryCut).where(LibraryCut.id.in_(body.ids))).all()
        if len(rows) != len(set(body.ids)):
            raise HTTPException(status_code=404, detail="見つからないカットがあります")
        for c in rows:
            tags = [t for t in _tags(c.tags_json) if t not in rem]
            for t in add:
                if t not in tags:
                    tags.append(t)
            c.tags_json = json.dumps(tags, ensure_ascii=False)
            if body.rating is not None:
                c.rating = int(body.rating)
            if body.starred is not None:
                c.starred = bool(body.starred)
            s.add(c)
        s.commit()
        out = [_cut_dict(c) for c in sorted(rows, key=lambda r: (r.asset_id, r.start_frame))]
    return {"updated": len(out), "cuts": out}


def _features(asset_id: int):
    p = lc.item_dir(asset_id) / "features.npz"
    if not p.exists():
        return None
    try:
        f, _fps = lc.load_features(p)
        return f
    except Exception:
        return None


def _apply_features(c: LibraryCut, f) -> None:
    if f is None or c.end_frame > len(f["luma"]):
        return
    d = lc.cut_features(f, c.start_frame, c.end_frame, lc.DEFAULTS)
    c.luma, c.motion, c.sat, c.hue, c.dark, c.bright = d["luma"], d["motion"], d["sat"], d["hue"], d["dark"], d["bright"]


def _renumber(s: Session, asset_id: int) -> list[tuple[LibraryCut, int]]:
    """idx を時間順に振り直す。戻り値: (行, 前の idx)(前の idx が無い新しい行は -1)。"""
    rows = s.exec(select(LibraryCut).where(LibraryCut.asset_id == asset_id).order_by(LibraryCut.start_frame)).all()
    out = []
    for i, r in enumerate(rows):
        out.append((r, r.idx if r.id is not None else -1))
        r.idx = i
        s.add(r)
    return out


def _stage_sheets(asset_id: int, path: str, fps: float, old_layout: list[tuple[int, int]],
                  new_layout: list[tuple[int, int]], from_idx: int, fresh: set[int]) -> list:
    """つなぐ・分けるの後の並び(new_layout)のスプライトを、from_idx を含むシートから後ろだけ
    sprites/s{n}.new.jpg に作る(まだ置き換えない)。同じ境目の行はいまのシート(並びは old_layout)から動かし、
    fresh の行と見つからない行はシークで作る。戻り値: lc.commit_staged に渡す [(src, dst)]。"""
    import cv2
    import numpy as np
    sp = lc.sprites_dir(asset_id)
    sheets: dict[int, Optional[np.ndarray]] = {}

    def sheet(n: int):
        if n not in sheets:
            p = sp / f"s{n}.jpg"
            im = cv2.imread(str(p)) if p.exists() else None
            sheets[n] = cv2.cvtColor(im, cv2.COLOR_BGR2RGB) if im is not None and im.shape[1] == 3 * lc.TW else None
        return sheets[n]

    def old_row(i: int):
        sh = sheet(i // lc.SPRITE_CUTS)
        r = i % lc.SPRITE_CUTS
        if sh is None or (r + 1) * lc.TH > sh.shape[0]:
            return None
        return [sh[r * lc.TH:(r + 1) * lc.TH, k * lc.TW:(k + 1) * lc.TW].copy() for k in range(3)]

    by_se = {(int(a), int(b)): i for i, (a, b) in enumerate(old_layout)}
    rows: dict[int, list] = {}
    need: dict[int, tuple[int, int]] = {}
    for i in range(from_idx, len(new_layout)):
        se = (int(new_layout[i][0]), int(new_layout[i][1]))
        got = None if i in fresh else (old_row(by_se[se]) if se in by_se else None)
        if got is None:
            need[i] = se
        else:
            rows[i] = got
    blank = np.zeros((lc.TH, lc.TW, 3), np.uint8)
    if need:
        frs = []
        for st, en in need.values():
            frs += list(lc.thumb_frames(st, en))
        got = lc.grab_frames(path, fps, frs)
        for i, (st, en) in need.items():
            rows[i] = [got.get(fr, blank) for fr in lc.thumb_frames(st, en)]
    total = len(new_layout)
    first_sheet = from_idx // lc.SPRITE_CUTS
    last_sheet = (total - 1) // lc.SPRITE_CUTS if total > 0 else -1
    files: list = []
    sp.mkdir(parents=True, exist_ok=True)
    for n in range(first_sheet, last_sheet + 1):
        base = sheet(n)
        out = np.zeros((lc.SPRITE_CUTS * lc.TH, 3 * lc.TW, 3), np.uint8)
        if base is not None:
            h = min(base.shape[0], out.shape[0])
            out[:h] = base[:h, :3 * lc.TW]
        for r in range(lc.SPRITE_CUTS):
            i = n * lc.SPRITE_CUTS + r
            if i < from_idx:
                continue
            for k, cell in enumerate(rows.get(i) or [blank] * 3):
                out[r * lc.TH:(r + 1) * lc.TH, k * lc.TW:(k + 1) * lc.TW] = cell
        dst = sp / f"s{n}.new.jpg"
        cv2.imwrite(str(dst), cv2.cvtColor(out, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 90])
        files.append((f"sprites/s{n}.new.jpg", f"sprites/s{n}.jpg"))
    n = last_sheet + 1
    while (sp / f"s{n}.jpg").exists():                 # カットが減って余ったシート
        files.append((None, f"sprites/s{n}.jpg"))
        n += 1
    return files


def _asset_path_fps(asset_id: int) -> tuple[str, float]:
    with Session(engine) as s:
        a = s.get(Asset, asset_id)
        it = s.get(LibraryItem, asset_id)
        if not a or not Path(a.file_path).exists():
            raise HTTPException(status_code=422, detail="素材のファイルが見つかりません")
        return a.file_path, float(it.fps or 24.0) if it else 24.0


def _layout(s: Session, asset_id: int) -> list[LibraryCut]:
    """いまの行(idx の並び = いまのスプライトの並び)。"""
    return list(s.exec(select(LibraryCut).where(LibraryCut.asset_id == asset_id)
                       .order_by(LibraryCut.idx, LibraryCut.start_frame)).all())


def _commit_edit(asset_id: int, files: list, after: list[tuple[int, int]], db_write):
    """スプライトの .new を作った後で DB を書き、置き換える(lc.commit_staged)。ぶつかったら 409。"""
    try:
        return lc.commit_staged(engine, asset_id, files, lc.cuts_signature(after), db_write)
    except lc.EditConflict as e:
        raise HTTPException(status_code=409, detail=str(e))


_CONFLICT = "ほかの操作(解析・つなぐ・分ける)とぶつかりました。一覧を読み直してから、もう一度してください"


@router.post("/cuts/merge")
def merge_cuts(body: CutMerge):
    ids = sorted(set(body.ids))
    if len(ids) < 2:
        raise HTTPException(status_code=422, detail="つなぐカットを 2 つ以上選んでください")
    with Session(engine) as s:
        rows = s.exec(select(LibraryCut).where(LibraryCut.id.in_(ids))).all()
        if len(rows) != len(ids):
            raise HTTPException(status_code=404, detail="見つからないカットがあります")
        aids = {r.asset_id for r in rows}
        if len(aids) != 1:
            raise HTTPException(status_code=422, detail="同じ素材のカットだけつなげます")
        asset_id = aids.pop()
    path, fps = _asset_path_fps(asset_id)
    f = _features(asset_id)
    with _edit_lock(asset_id):
        if _busy(asset_id):
            raise HTTPException(status_code=409, detail="解析中はつなげません")
        lc.recover_item(engine, asset_id, blocking=True)
        with Session(engine) as s:
            cur = [(r.id, r.start_frame, r.end_frame) for r in _layout(s, asset_id)]
        sel = sorted([x for x in cur if x[0] in set(ids)], key=lambda x: x[1])
        if len(sel) != len(ids):
            raise HTTPException(status_code=404, detail="見つからないカットがあります")
        for x, y in zip(sel, sel[1:]):
            if x[2] != y[1]:
                raise HTTPException(status_code=422, detail="隣り合うカットだけつなげます")
        keep_id, removed = sel[0][0], {x[0] for x in sel[1:]}
        before = [(a, b) for _i, a, b in cur]
        after: list[tuple[int, int]] = []
        for rid, a, b in sorted(cur, key=lambda x: x[1]):
            if rid in removed:
                continue
            after.append((a, sel[-1][2]) if rid == keep_id else (a, b))
        from_idx = next(i for i, (a, _b) in enumerate(after) if a == sel[0][1])
        files = _stage_sheets(asset_id, path, fps, before, after, from_idx, {from_idx})

        def db_write():
            with Session(engine) as s:
                lc._lock_db_for_write(s, asset_id)
                now = _layout(s, asset_id)
                if lc.cuts_signature((r.start_frame, r.end_frame) for r in now) != lc.cuts_signature(before):
                    raise lc.EditConflict(_CONFLICT)
                rows = sorted([r for r in now if r.id in set(ids)], key=lambda r: r.start_frame)
                keep, rest = rows[0], rows[1:]
                keep.end_frame = rows[-1].end_frame
                # ユーザーの値はこのトランザクションで読んだ行から(タグは和、評価は最大、★ はどれか、メモはつなぐ)
                tags: list[str] = []
                for r in rows:
                    for t in _tags(r.tags_json):
                        if t not in tags:
                            tags.append(t)
                keep.tags_json = json.dumps(tags, ensure_ascii=False)
                keep.rating = max(r.rating for r in rows)
                keep.starred = any(r.starred for r in rows)
                keep.note = "\n".join(r.note for r in rows if r.note)[:NOTE_MAX]
                keep.edited = True
                keep.thumb_ver += 1
                _apply_features(keep, f)
                for r in rest:
                    s.delete(r)
                s.flush()
                order = _renumber(s, asset_id)
                it = s.get(LibraryItem, asset_id)
                if it:
                    it.cut_count = len(order)
                    it.updated_at = _now()
                    s.add(it)
                s.commit()
                s.refresh(keep)
                return _cut_dict(keep), len(order)

        out, n_after = _commit_edit(asset_id, files, after, db_write)
    return {"cut": out, "removed_ids": [r for r in ids if r != keep_id], "cut_count": n_after,
            "changed": [out]}


@router.post("/cuts/{cut_id}/split")
def split_cut(cut_id: int, body: CutSplit):
    with Session(engine) as s:
        c = s.get(LibraryCut, cut_id)
        if not c:
            raise HTTPException(status_code=404, detail="カットが見つかりません")
        asset_id = c.asset_id
        if not (c.start_frame < body.at < c.end_frame):
            raise HTTPException(status_code=422, detail="分ける位置はカットの中(最初と最後のコマの間)にしてください")
    path, fps = _asset_path_fps(asset_id)
    f = _features(asset_id)
    with _edit_lock(asset_id):
        if _busy(asset_id):
            raise HTTPException(status_code=409, detail="解析中は分けられません")
        lc.recover_item(engine, asset_id, blocking=True)
        with Session(engine) as s:
            cur = [(r.id, r.start_frame, r.end_frame) for r in _layout(s, asset_id)]
        me = next((x for x in cur if x[0] == cut_id), None)
        if me is None:
            raise HTTPException(status_code=404, detail="カットが見つかりません")
        if not (me[1] < body.at < me[2]):
            raise HTTPException(status_code=422, detail="分ける位置はカットの中にしてください")
        before = [(a, b) for _i, a, b in cur]
        after: list[tuple[int, int]] = []
        for rid, a, b in sorted(cur, key=lambda x: x[1]):
            if rid == cut_id:
                after += [(a, body.at), (body.at, b)]
            else:
                after.append((a, b))
        from_idx = next(i for i, (a, _b) in enumerate(after) if a == me[1])
        files = _stage_sheets(asset_id, path, fps, before, after, from_idx, {from_idx, from_idx + 1})

        def db_write():
            with Session(engine) as s:
                lc._lock_db_for_write(s, asset_id)
                now = _layout(s, asset_id)
                if lc.cuts_signature((r.start_frame, r.end_frame) for r in now) != lc.cuts_signature(before):
                    raise lc.EditConflict(_CONFLICT)
                c = next(r for r in now if r.id == cut_id)
                b = LibraryCut(asset_id=asset_id, idx=c.idx + 1, start_frame=body.at, end_frame=c.end_frame,
                               trans_in="hard", trans_frames=0, tags_json=c.tags_json, rating=c.rating,
                               starred=c.starred, note=c.note, edited=True, thumb_ver=c.thumb_ver + 1)
                c.end_frame = body.at
                c.trans_frames = min(c.trans_frames, c.end_frame - c.start_frame)
                c.edited = True
                c.thumb_ver += 1
                _apply_features(c, f)
                _apply_features(b, f)
                s.add(c)
                s.add(b)
                s.flush()
                order = _renumber(s, asset_id)
                it = s.get(LibraryItem, asset_id)
                if it:
                    it.cut_count = len(order)
                    it.updated_at = _now()
                    s.add(it)
                s.commit()
                s.refresh(c)
                s.refresh(b)
                return [_cut_dict(c), _cut_dict(b)], len(order)

        out, n_after = _commit_edit(asset_id, files, after, db_write)
    return {"cuts": out, "cut_count": n_after, "changed": out}


@router.get("/tags")
def list_tags():
    count: dict[str, int] = {}
    with Session(engine) as s:
        for raw in s.exec(select(LibraryItem.tags_json)).all():
            for t in _tags(raw):
                count[t] = count.get(t, 0) + 1
        for raw in s.exec(select(LibraryCut.tags_json).where(LibraryCut.tags_json != "[]")).all():
            for t in _tags(raw):
                count[t] = count.get(t, 0) + 1
    return [{"tag": t, "count": n} for t, n in sorted(count.items(), key=lambda x: (-x[1], x[0]))]


# ── タイムラインに置く ─────────────────────────────────────────────────────────

class PlaceBody(BaseModel):
    project_id: int
    track_id: int
    start_frame: int
    cut_ids: list[int]
    gap_frames: int = 0
    keep_order: bool = False      # false: 時間順(素材ごと)に並べ替える / true: cut_ids の順


def to_project_frames(src_start: int, src_end: int, src_fps: float, proj_fps: float) -> tuple[int, int]:
    """素材のコマ [src_start, src_end) → (asset_in_frame, duration_frames)(プロジェクトの fps)。

    プレビュー・書き出しは時刻 t に「t を含む素材のコマ」= floor(t × 素材fps) を出す。
    asset_in_frame は「最初に出るコマが src_start」になる最小の値(切り上げ)、
    尺は長さを fps で直して丸め、最後のコマが次のカットへはみ出さないよう詰める(1 以上)。
    """
    r = proj_fps / src_fps
    a_in = int(math.ceil(src_start * r - 1e-9))
    dur = max(1, int(round((src_end - src_start) * r)))
    while dur > 1 and int(math.floor((a_in + dur - 1) / r + 1e-6)) >= src_end:
        dur -= 1
    return a_in, dur


@router.post("/place", status_code=201)
def place_cuts(body: PlaceBody):
    if not body.cut_ids:
        raise HTTPException(status_code=422, detail="置くカットを選んでください")
    if body.start_frame < 0 or body.gap_frames < 0:
        raise HTTPException(status_code=422, detail="位置と間隔は 0 以上にしてください")
    with Session(engine) as s:
        proj = s.get(Project, body.project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")
        tr = s.get(Track, body.track_id)
        if not tr or tr.project_id != body.project_id:
            raise HTTPException(status_code=422, detail="このプロジェクトのトラックを選んでください")
        if tr.track_type != "video":
            raise HTTPException(status_code=422, detail="映像トラックに置いてください")
        rows = s.exec(select(LibraryCut).where(LibraryCut.id.in_(body.cut_ids))).all()
        by_id = {r.id: r for r in rows}
        missing = [i for i in body.cut_ids if i not in by_id]
        if missing:
            raise HTTPException(status_code=404, detail=f"見つからないカットがあります: {missing[:5]}")
        seen: set = set()
        cuts = [by_id[i] for i in body.cut_ids if not (i in seen or seen.add(i))]
        items = {it.asset_id: it for it in s.exec(select(LibraryItem).where(
            LibraryItem.asset_id.in_({c.asset_id for c in cuts}))).all()}
        if not body.keep_order:
            order = {aid: (it.series, it.sort_order, aid) for aid, it in items.items()}
            cuts.sort(key=lambda c: (order.get(c.asset_id, ("", 0, c.asset_id)), c.start_frame))
        pfps = float(proj.fps or 24.0)
        plan = []
        pos = body.start_frame
        for c in cuts:
            it = items.get(c.asset_id)
            sfps = float(it.fps) if it and it.fps else 24.0
            a_in, dur = to_project_frames(c.start_frame, c.end_frame, sfps, pfps)
            plan.append((c, pos, dur, a_in))
            pos += dur + body.gap_frames
        lo, hi = body.start_frame, plan[-1][1] + plan[-1][2]
        existing = s.exec(select(Clip).where(Clip.track_id == body.track_id)).all()
        hits = []
        for e in existing:
            e0, e1 = e.start_frame, e.start_frame + e.duration_frames
            if e1 <= lo or e0 >= hi:
                continue
            for _c, p0, d, _a in plan:
                if e0 < p0 + d and e1 > p0:
                    hits.append(e.id)
                    break
        if hits:
            raise HTTPException(status_code=422, detail={
                "error": f"置く場所に別のクリップがあります(フレーム {lo}〜{hi})。空いている場所かトラックを選んでください",
                "overlap_clip_ids": hits[:20], "range": [lo, hi]})
        created = []
        for c, p0, d, a_in in plan:
            attrs = {"library_cut": {"asset_id": c.asset_id, "cut_id": c.id, "idx": c.idx,
                                     "start": c.start_frame, "end": c.end_frame}}
            clip = Clip(track_id=body.track_id, asset_id=c.asset_id, start_frame=p0, duration_frames=d,
                        asset_in_frame=a_in, kind="media", attrs_json=json.dumps(attrs, ensure_ascii=False))
            s.add(clip)
            created.append(clip)
        s.commit()
        for clip in created:
            s.refresh(clip)
        out = [clip.model_dump() for clip in created]
        from app.services import command_api
        command_api.record_op(body.project_id, "library_place", s,
                              detail=f"track {body.track_id} @ frame {lo}: {len(created)} cuts", actor="user")
    try:
        from app.services.collab import notify_edit
        notify_edit(body.project_id, by="library")
    except Exception:
        pass
    return {"clips": out, "start_frame": lo, "end_frame": hi}
