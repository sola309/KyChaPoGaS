"""レビューで直した点の回帰テスト(2026-10-15)。
- ガイド動画の負の batch_index を ComfyUI ImageFromBatch と同じに切り出す(誤って止めない)
- アセット検索の例外(DB の一時的なロック等)は「アセットが無い」にせず、検査の不具合として通す
- 上限の設定値が壊れていても全 H3 ジョブを止めない / 起動を止めない
"""
import asyncio
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from app.services import h3_guard as G

BACKEND = Path(__file__).resolve().parents[1]


def ref_params(**kw):
    p = {"project_id": 1, "model": "minimax-h3-ref", "width": 1344, "height": 768,
         "duration_sec": 124 / 24, "prompt": "<Picture 1> walks. <Video 1> is the source.",
         "keyframes": [{"time_sec": 0, "asset_id": 101}], "ref_video_asset_ids": [202],
         "steps": 4, "turbo_lora": 0.75, "easycache": True, "scheduler": "beta", "ref_image_size": "match"}
    p.update(kw)
    return p


# ── ガイド動画の切り出し ───────────────────────────────────────────
def test_guide_video_negative_batch_index_clamped_like_comfyui(resolver):
    # 203 = 200 フレームの動画。batch_index=-5, length=22 → ComfyUI は末尾 5 枚だけを渡す
    g = {"asset_id": 203, "batch_index": -5, "length": 22, "frame_idx": 119}
    p = ref_params(guide_videos=[g])
    assert G.check_job(p, resolver) == []                      # 5 枚は 119..123 に収まる
    calls, _ = G.plan_calls(p, resolver)
    assert calls[0].guides == [(119, 5)]
    # 22 枚を本当に渡すなら外にはみ出す(従来どおり止める)
    p2 = ref_params(guide_videos=[{"asset_id": 203, "batch_index": -22, "length": 22, "frame_idx": 119}])
    assert any("frame_idx=119" in e for e in G.check_job(p2, resolver))


def test_guide_video_tail_and_head_like_chain_scripts(resolver):
    rows = (1344 // 32) * (768 // 32)
    for g in ({"asset_id": 203, "batch_index": -22, "length": 22, "frame_idx": 0},
              {"asset_id": 203, "batch_index": 0, "length": 22, "frame_idx": 102}):
        p = ref_params(guide_videos=[g])
        assert G.check_job(p, resolver) == []
        calls, _ = G.plan_calls(p, resolver)
        assert G.token_estimates(p, calls)[0].guides == 7 * rows    # 22f → 7 ラテント


def test_guide_video_beyond_end_batch_index_clamped(resolver):
    # batch_index が枚数以上 → ComfyUI は最後の 1 枚に丸める
    p = ref_params(guide_videos=[{"asset_id": 203, "batch_index": 500, "length": 22, "frame_idx": 123}])
    assert G.check_job(p, resolver) == []
    assert G.plan_calls(p, resolver)[0][0].guides == [(123, 1)]


# ── アセット検索の例外 ─────────────────────────────────────────────
class _LockedSession:
    def get(self, model, aid):
        raise sqlite3.OperationalError("database is locked")


def test_resolver_exception_is_not_reported_as_missing_asset():
    with pytest.raises(sqlite3.OperationalError):
        G.check_job(ref_params(), lambda aid: (_ for _ in ()).throw(sqlite3.OperationalError("locked")))


def test_check_submission_fails_open_when_db_lookup_raises():
    assert G.check_submission(1, "generate_video_i2v", ref_params(), _LockedSession()) == []
    # T3 の明示チェックだけは残る
    errs = G.check_submission(1, "generate_video_i2v", ref_params(tier="t3"), _LockedSession())
    assert any("T3 なのに" in e for e in errs)


def test_bad_asset_id_still_rejected(resolver):
    errs = G.check_job(ref_params(keyframes=[{"time_sec": 0, "asset_id": "abc"}]), resolver)
    assert any("asset_id が不正" in e for e in errs)


def test_runtime_guard_fails_open_when_asset_lookup_raises(monkeypatch, media):
    """job_runner の実行開始時: 検索が例外 → 止めずに次へ進む(upload が呼ばれる)。"""
    from app.services import job_runner as jr
    from app.services.comfyui import comfyui
    import sqlmodel

    async def no_upload(p):
        raise AssertionError("UPLOAD_CALLED")
    monkeypatch.setattr(comfyui, "upload_image", no_upload)
    real_get = sqlmodel.Session.get
    calls = {"n": 0}

    def flaky_get(self, model, ident, *a, **k):
        calls["n"] += 1
        if calls["n"] == 1:          # 最初の 1 回(=検査の中)だけ失敗させる
            raise sqlite3.OperationalError("database is locked")
        return real_get(self, model, ident, *a, **k)
    monkeypatch.setattr(sqlmodel.Session, "get", flaky_get)

    class J:
        id = 434343
    from app.models import Asset
    from app.db.database import engine
    with sqlmodel.Session(engine) as s:
        for aid, key in ((101, "card"), (202, "v960_345")):
            if real_get(s, Asset, aid) is None:
                row = media[key]
                s.add(Asset(id=aid, project_id=1, name=key, asset_type="video" if aid >= 200 else "image",
                            file_path=row["file_path"], width=row["width"], height=row["height"],
                            duration_sec=row["duration_sec"]))
        s.commit()
    calls["n"] = 0
    with pytest.raises(AssertionError, match="UPLOAD_CALLED"):
        asyncio.run(jr._generate_video_wan22(J(), ref_params()))


# ── 上限の設定値 ───────────────────────────────────────────────────
@pytest.mark.parametrize("bad", ["abc", "0", "-5"])
def test_broken_settings_value_falls_back_to_config(monkeypatch, bad):
    from app.services import settings_store
    monkeypatch.setattr(settings_store, "_CACHE", {"H3_MAX_SEQ_TOKENS": bad})
    assert G.max_seq_tokens() == 198000


@pytest.mark.parametrize("env, expect", [("abc", "198000"), ("", "198000"), ("250000", "250000")])
def test_config_import_never_crashes_on_bad_env(env, expect):
    r = subprocess.run([sys.executable, "-B", "-c", "import app.config as c; print(c.H3_MAX_SEQ_TOKENS)"],
                       cwd=str(BACKEND), env={**os.environ, "H3_MAX_SEQ_TOKENS": env},
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == expect
