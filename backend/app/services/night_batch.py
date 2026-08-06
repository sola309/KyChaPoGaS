"""
🌙 夜間バッチ生成 — サーバ常駐のループでカットを加重ラウンドロビン生成し続ける。

ブラウザを閉じても走り続ける(以前のフロント側setIntervalはタブを閉じると止まった)。
- 対象カットと重み(★1〜3)を受け取り、「投入数 ÷ 重み」最小のカットを次に回す
- 生成条件は各カットの直近gen_params(prompt/参照画像/参照動画)を流用しseedのみランダム
- 🔒ロック済みカットは毎ループ再確認して除外(夜間にロックしても即反映)
- 生成物は place.auto=False でテイク蓄積(タイムラインは書き換えない)
- 設定はsettings_storeに保存し、サーバ再起動後も自動再開
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
from pathlib import Path

from sqlmodel import Session, select

from app.db.database import engine
from app.models import Asset
from app.models.clip import Clip
from app.models.job import Job
from app.models.track import Track

log = logging.getLogger("night_batch")

STATE_PATH = Path(__file__).resolve().parents[2] / "data" / "night_batch.json"
POLL_S = 20.0
_task: asyncio.Task | None = None


def get_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def set_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def _cut_pairs(session: Session, project_id: int) -> list[tuple[int, int]]:
    """Imageトラックのピンを2個ずつペアリングしたカット(開始, 終了)一覧。"""
    img = session.exec(
        select(Track).where(Track.project_id == project_id,
                            Track.track_type == "reference", Track.name == "Image")
    ).first()
    if not img:
        return []
    pins = sorted(
        (c.start_frame for c in session.exec(
            select(Clip).where(Clip.track_id == img.id, Clip.asset_id.is_not(None))).all()))
    return [(pins[i], pins[i + 1]) for i in range(0, len(pins) - 1, 2)]


def _locked_starts(session: Session, project_id: int) -> set[int]:
    shots = session.exec(
        select(Track).where(Track.project_id == project_id,
                            Track.track_type == "video", Track.name == "Shots")
    ).first()
    if not shots:
        return set()
    return {c.start_frame for c in session.exec(
        select(Clip).where(Clip.track_id == shots.id, Clip.locked == True)).all()}  # noqa: E712


def _template_params(session: Session, project_id: int, start_frame: int) -> dict | None:
    """そのカット位置で生成された最新アセットのgen_paramsを生成テンプレとして使う。"""
    rows = session.exec(
        select(Asset).where(Asset.project_id == project_id).order_by(Asset.id.desc())
    ).all()
    for a in rows:
        if not a.gen_params_json:
            continue
        try:
            p = json.loads(a.gen_params_json)
        except Exception:
            continue
        if (p.get("place") or {}).get("start_frame") == start_frame and p.get("prompt"):
            return p
    return None


async def _loop() -> None:
    while True:
        try:
            st = get_state()
            if not st.get("running"):
                await asyncio.sleep(POLL_S)
                continue
            project_id = int(st["project_id"])
            keep = int(st.get("keep_in_flight", 2))
            weights: dict[str, int] = st.get("weights", {})     # start_frame(str) → 重み
            counts: dict[str, int] = st.get("counts", {})       # start_frame(str) → 投入数

            with Session(engine) as session:
                active = session.exec(
                    select(Job).where(Job.project_id == project_id,
                                      Job.job_type == "generate_video_i2v",
                                      Job.status.in_(["pending", "running"]))
                ).all()
                if len(active) >= keep:
                    await asyncio.sleep(POLL_S)
                    continue

                locked = _locked_starts(session, project_id)
                valid = sorted(
                    (int(f) for f, w in weights.items() if int(w) > 0 and int(f) not in locked))
                if not valid:
                    log.info("night_batch: 対象カットなし(全ロック/未設定)→ 待機")
                    await asyncio.sleep(POLL_S)
                    continue

                # 加重ラウンドロビン: 投入数 ÷ 重み が最小のカット
                nxt = min(valid, key=lambda f: (counts.get(str(f), 0) / max(1, int(weights[str(f)])), f))
                tmpl = _template_params(session, project_id, nxt)
                if not tmpl:
                    log.warning(f"night_batch: f{nxt} の生成テンプレが見つからない → スキップ")
                    counts[str(nxt)] = counts.get(str(nxt), 0) + 1
                    st["counts"] = counts
                    set_state(st)
                    await asyncio.sleep(POLL_S)
                    continue

                params = dict(tmpl)
                params["seed"] = random.randint(0, 2**31 - 1)
                place = dict(params.get("place") or {})
                place["auto"] = False              # テイク蓄積(タイムラインは触らない)
                place.pop("replace_clip_id", None)
                params["place"] = place

                job = Job(project_id=project_id, job_type="generate_video_i2v",
                          params=json.dumps(params, ensure_ascii=False))
                session.add(job)
                session.commit()
                session.refresh(job)
                counts[str(nxt)] = counts.get(str(nxt), 0) + 1
                st["counts"] = counts
                st["last_job_id"] = job.id
                set_state(st)
                log.info(f"night_batch: f{nxt} を投入(job {job.id}, seed {params['seed']}, "
                         f"累計 {sum(counts.values())}本)")
        except Exception as e:
            log.warning(f"night_batch loop error: {e}")
        await asyncio.sleep(POLL_S)


def ensure_started() -> None:
    """アプリ起動時に呼ぶ。ループは常駐し、state.runningのON/OFFで動作する。"""
    global _task
    if _task and not _task.done():
        return
    _task = asyncio.create_task(_loop())
    log.info("night_batch loop started")
