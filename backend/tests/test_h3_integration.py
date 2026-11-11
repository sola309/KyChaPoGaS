"""投入窓口(POST /jobs/ ・ /generation/video/i2v)・実行開始時の検査・ワークフロー組み立ての結合テスト。
ComfyUI と本物の DB には触れない(conftest 参照)。"""
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import Session

HERE = Path(__file__).resolve().parent


@pytest.fixture()
def db_assets(_temp_engine, media):
    from app.models import Asset
    ids = {101: "card", 102: "face", 103: "wide", 201: "v1344_345", 202: "v960_345", 205: "v1344_576"}
    with Session(_temp_engine) as s:
        for aid, key in ids.items():
            row = media[key]
            if s.get(Asset, aid) is None:
                s.add(Asset(id=aid, project_id=1, name=key, asset_type="video" if aid >= 200 else "image",
                            file_path=row["file_path"], width=row["width"], height=row["height"],
                            duration_sec=row["duration_sec"]))
        s.commit()
    return ids


@pytest.fixture()
def client(_temp_engine, db_assets):
    from app.db.database import get_session
    from app.routers import generation, jobs
    app = FastAPI()
    app.include_router(jobs.router, prefix="/api")
    app.include_router(generation.router, prefix="/api")

    def _s():
        with Session(_temp_engine) as s:
            yield s
    app.dependency_overrides[get_session] = _s
    return TestClient(app)


def ref(**kw):
    p = {"project_id": 1, "model": "minimax-h3-ref", "width": 1344, "height": 768,
         "duration_sec": 124 / 24, "prompt": "<Picture 1> and <Video 1>",
         "keyframes": [{"time_sec": 0, "asset_id": 101}], "ref_video_asset_ids": [202],
         "steps": 4, "turbo_lora": 0.75, "easycache": True, "scheduler": "beta", "ref_image_size": "match"}
    p.update(kw)
    return p


# ── POST /api/jobs/ ───────────────────────────────────────────────────
def test_jobs_accepts_valid_t1(client):
    r = client.post("/api/jobs/", json={"project_id": 1, "job_type": "generate_video_i2v", "params": ref()})
    assert r.status_code == 201, r.text


def test_jobs_rejects_10_pictures(client):
    p = ref(keyframes=[{"time_sec": 0, "asset_id": 101}] * 10)
    r = client.post("/api/jobs/", json={"project_id": 1, "job_type": "generate_video_i2v", "params": p})
    assert r.status_code == 422
    assert any("10 枚" in x for x in r.json()["detail"]["problems"])


def test_jobs_rejects_over_token_limit_with_breakdown(client):
    p = ref(duration_sec=345 / 24, keyframes=[{"time_sec": 0, "asset_id": 101}] * 9,
            ref_video_asset_ids=[201], ref_image_size="max", prompt="<Picture 9> <Video 1>")
    r = client.post("/api/jobs/", json={"project_id": 1, "job_type": "generate_video_i2v", "params": p})
    assert r.status_code == 422
    msg = r.json()["detail"]["problems"][0]
    assert "系列長" in msg and "参照動画" in msg and "shrink the ref video" in msg


def test_jobs_skip_validation_does_not_bypass_h3_limits(client):
    p = ref(keyframes=[{"time_sec": 0, "asset_id": 101}] * 10, skip_validation=True)
    r = client.post("/api/jobs/", json={"project_id": 1, "job_type": "generate_video_i2v", "params": p})
    assert r.status_code == 422


def test_jobs_t3_missing_keys_rejected_and_complete_accepted(client):
    p = ref(tier="t3", steps=20, easycache=False, turbo_lora=None, ref_image_size="max")
    r = client.post("/api/jobs/", json={"project_id": 1, "job_type": "generate_video_i2v", "params": p})
    assert r.status_code == 422
    msg = " ".join(r.json()["detail"]["problems"])
    for k in ("sampler", "shift_video", "shift_audio", "seed"):
        assert k in msg
    p.update(sampler="res_multistep", shift_video=None, shift_audio=None, seed=-1)
    r = client.post("/api/jobs/", json={"project_id": 1, "job_type": "generate_video_i2v", "params": p})
    assert r.status_code == 201, r.text
    assert r.json()["params"]["tier"] == "t3"


# ── POST /api/generation/video/i2v(UI の経路) ────────────────────────
UI_BODY = {"project_id": 1, "keyframes": [{"time_sec": 0, "asset_id": 101}], "duration_sec": 124 / 24,
           "model": "minimax-h3-ref", "prompt": "<Picture 1> <Video 1>", "width": 1344, "height": 768,
           "seed": -1, "use_lightning": True, "steps": 15, "easycache": True,
           "ref_video_asset_ids": [202], "scheduler": "beta",
           "place": {"track_id": 1, "start_frame": 0, "duration_frames": 124}}


def test_ui_path_drops_unknown_keys_like_before(client):
    from app.routers.generation import VideoI2VRequest
    body = dict(UI_BODY, quality="t0", chain={"mode": "guide"}, guide_keyframes=[{"asset_id": 103, "frame_idx": 0}])
    r = client.post("/api/generation/video/i2v", json=body)
    assert r.status_code == 201, r.text
    params = r.json()["params"]
    assert set(params) == set(VideoI2VRequest.model_fields), set(params) ^ set(VideoI2VRequest.model_fields)


def test_ui_path_t3_keeps_everything_and_requires_explicit_keys(client):
    body = dict(UI_BODY, tier="t3", steps=20, easycache=False, ref_image_size="max",
                guide_keyframes=[{"asset_id": 103, "frame_idx": 0}])
    r = client.post("/api/generation/video/i2v", json=body)
    assert r.status_code == 422          # sampler / turbo_lora / shift_* が無い
    body.update(sampler="res_multistep", turbo_lora=None, shift_video=None, shift_audio=None)
    r = client.post("/api/generation/video/i2v", json=body)
    assert r.status_code == 201, r.text
    p = r.json()["params"]
    assert p["tier"] == "t3" and p["sampler"] == "res_multistep" and p["guide_keyframes"][0]["asset_id"] == 103


def test_ui_path_t3_presence_uses_sent_keys_not_pydantic_defaults(client):
    body = {k: v for k, v in UI_BODY.items() if k != "width"}   # width は既定 640 で埋まるが「送っていない」
    body.update(tier="t3", steps=20, easycache=False, ref_image_size="max", sampler="res_multistep",
                turbo_lora=None, shift_video=None, shift_audio=None)
    r = client.post("/api/generation/video/i2v", json=body)
    assert r.status_code == 422
    assert "width" in " ".join(r.json()["detail"]["problems"])


def test_ui_path_rejects_h3_limits(client):
    body = dict(UI_BODY, prompt="<Picture 2> <Video 1>")
    r = client.post("/api/generation/video/i2v", json=body)
    assert r.status_code == 422


# ── 実行開始時(job_runner) ───────────────────────────────────────────
def _run_wan22(params, monkeypatch):
    from app.services import job_runner as jr
    from app.services.comfyui import comfyui

    async def no_upload(p):
        raise AssertionError("UPLOAD_CALLED")
    monkeypatch.setattr(comfyui, "upload_image", no_upload)

    class J:
        id = 424242
    return asyncio.run(jr._generate_video_wan22(J(), dict(params)))


def test_runtime_guard_stops_before_any_upload(db_assets, monkeypatch):
    with pytest.raises(ValueError, match="H3 事前検査で停止"):
        _run_wan22(ref(keyframes=[{"time_sec": 0, "asset_id": 101}] * 10), monkeypatch)


def test_runtime_guard_passes_valid_job(db_assets, monkeypatch):
    with pytest.raises(AssertionError, match="UPLOAD_CALLED"):
        _run_wan22(ref(), monkeypatch)


# ── ワークフローの組み立て ───────────────────────────────────────────
def test_builder_legacy_shift_without_turbo_unchanged():
    from app.services.workflow_builder import build_minimax_h3_ref_video
    wf = build_minimax_h3_ref_video("p", ["a.png"], seed=1, shift_video=6.0, shift_audio=3.0)
    assert "shift" not in wf                                  # 従来どおり(Turbo なしでは効かない)


def test_builder_shift_always_inserts_sigma_shift():
    from app.services.workflow_builder import build_minimax_h3_ref_video, build_minimax_h3_video
    for wf in (build_minimax_h3_ref_video("p", ["a.png"], seed=1, shift_video=6.0, shift_audio=3.0,
                                          easycache=True, shift_always=True),
               build_minimax_h3_video("p", first_image_name="a.png", seed=1, shift_video=6.0,
                                      shift_audio=3.0, easycache=True, shift_always=True)):
        assert wf["shift"]["class_type"] == "MiniMaxH3SigmaShift"
        assert wf["shift"]["inputs"]["shift_video"] == 6.0 and wf["shift"]["inputs"]["model"] == ["unet", 0]
        assert wf["ecache"]["inputs"]["model"] == ["shift", 0]
        assert wf["guider"]["inputs"]["model"] == ["ecache", 0] and wf["sched"]["inputs"]["model"] == ["ecache", 0]
    wf = build_minimax_h3_ref_video("p", ["a.png"], seed=1, shift_video=None, shift_audio=None, shift_always=True)
    assert "shift" not in wf                                  # null = モデル既定(12/3)


def test_builder_fl2v_scheduler_default_and_explicit():
    from app.services.workflow_builder import build_minimax_h3_video
    assert build_minimax_h3_video("p", seed=1)["sched"]["inputs"]["scheduler"] == "simple"
    assert build_minimax_h3_video("p", seed=1, scheduler="beta")["sched"]["inputs"]["scheduler"] == "beta"


def test_quality_preset_identical_to_previous_inline_code():
    from app.services.h3_guard import apply_quality_preset

    def old(params):        # 改修前の job_runner._generate_video_i2v の展開(そのまま写し)
        if str(params.get("quality", "")).lower() == "t1":
            params = dict(params)
            portrait = int(params.get("height", 768) or 768) > int(params.get("width", 1344) or 1344)
            params.update({"width": 768 if portrait else 1344, "height": 1344 if portrait else 768, "steps": 4,
                           "turbo_lora": 0.75, "easycache": True, "ref_image_size": "match"})
        if str(params.get("quality", "")).lower() == "t0":
            params = dict(params)
            params.update({"width": 960, "height": 544, "steps": 4, "turbo_lora": 0.75, "easycache": True,
                           "ref_image_size": "match", "preview_steps": 1})
        return params
    cases = [{}, {"quality": "t1"}, {"quality": "T1", "width": 544, "height": 960}, {"quality": "t0", "steps": 20},
             {"quality": "t1", "width": None, "height": None}, {"quality": "t2"}, {"quality": "t3", "steps": 9},
             {"quality": "t1", "width": 768, "height": 1344, "turbo_lora": None}]
    for c in cases:
        src = dict(c)
        assert apply_quality_preset(src)[0] == old(dict(c)), c
        assert src == c                                           # 元の dict は書き換えない


# ── 改修前のバックエンドと、組み立てたワークフローを比べる(従来ジョブの挙動が変わらないこと) ──
ORIG = os.environ.get("H3_GUARD_ORIG_BACKEND")


@pytest.mark.skipif(not ORIG, reason="H3_GUARD_ORIG_BACKEND(改修前のバックエンドのコピー)未指定")
def test_first_workflow_identical_to_orig_for_legacy_jobs(media, tmp_path):
    assets = {101: media["card"], 102: media["face"], 103: media["wide"], 201: media["v1344_345"],
              202: media["v960_345"], 205: media["v1344_576"]}
    T2 = dict(steps=8, turbo_lora=1.0, turbo_lora_name="minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
              shift_video=6.0, shift_audio=3.0, sampler="euler", easycache=False)
    cases = {
        "t1_script": ref(seed=11),
        "t2_script": ref(seed=12, **T2),
        "quality_t1": {k: v for k, v in ref(seed=13, quality="t1", width=960, height=544).items()
                       if k not in ("steps", "turbo_lora", "easycache")},
        "quality_t0": ref(seed=14, quality="t0"),
        "t3_legacy_unit": ref(seed=15, steps=25, scheduler="simple", easycache=False, ref_image_size="max",
                              turbo_lora=None),
        "t3_legacy_shift_ignored": ref(seed=16, steps=20, easycache=False, turbo_lora=None, sampler="euler",
                                       shift_video=6.0, shift_audio=3.0),
        "ui_shotpanel": {"project_id": 1, "model": "minimax-h3-ref", "keyframes": [{"time_sec": 0, "asset_id": 101}],
                         "duration_sec": 5.2, "prompt": "<Picture 1> <Video 1>", "width": 1344, "height": 768,
                         "seed": 17, "steps": 15, "easycache": True, "ref_video_asset_ids": [202], "scheduler": "beta",
                         "fps": 16, "motion_strength": 0.6, "use_lightning": True, "negative_prompt": "",
                         "ref_audio_asset_ids": None, "ref_image_size": None, "place": None},
        "guides": ref(seed=18, guide_keyframes=[{"asset_id": 103, "frame_idx": 0}, {"asset_id": 103, "frame_idx": 60}]),
        "vdn": ref(seed=19, vdn={"branch_weights": "stream"}, steps=8, easycache=False, turbo_lora=None),
        "vdn_empty_dict_is_off": ref(seed=22, vdn={}, steps=8, easycache=False, turbo_lora=None),
        "fl2v": {"project_id": 1, "model": "minimax-h3", "keyframes": [{"asset_id": 103}, {"asset_id": 103}],
                 "duration_sec": 5.2, "prompt": "x", "width": 1344, "height": 768, "seed": 20, "steps": 4,
                 "turbo_lora": 0.75, "easycache": True, "scheduler": "beta"},
        "chain_seg1": ref(seed=21, duration_sec=576 / 24, width=960, height=544, ref_video_asset_ids=[205]),
    }
    spec = tmp_path / "cases.json"
    spec.write_text(json.dumps({"assets": {str(k): v for k, v in assets.items()}, "cases": cases}))
    outs = {}
    for tag, root in (("orig", ORIG), ("new", str(HERE.parent))):
        out = tmp_path / f"{tag}.json"
        subprocess.run([sys.executable, "-B", str(HERE / "_capture_wf.py"), root, str(spec), str(out)],
                       check=True, timeout=300, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        outs[tag] = json.loads(out.read_text())
    for name in cases:
        assert "wf" in outs["orig"][name], (name, outs["orig"][name])
        assert outs["new"][name] == outs["orig"][name], name


def test_strict_t3_workflow_uses_explicit_settings(media, tmp_path):
    """T3 は明示した shift / sampler / scheduler をそのまま使う(Turbo なしでも shift が効く・FL2V も scheduler を使う)。"""
    assets = {101: media["card"], 103: media["wide"], 202: media["v960_345"]}
    base = dict(tier="t3", seed=5, steps=20, scheduler="beta", sampler="res_multistep", easycache=False,
                turbo_lora=None, shift_video=None, shift_audio=None, ref_image_size="max")
    cases = {
        "ref_shift6": ref(**dict(base, shift_video=6.0, shift_audio=3.0)),
        "ref_default_shift": ref(**base),
        "ref_vdn": ref(**dict(base, steps=8, vdn={"branch_weights": "stream"})),
        "fl2v_beta": {"project_id": 1, "model": "minimax-h3", "keyframes": [{"asset_id": 103}], "prompt": "x",
                      "width": 1344, "height": 768, "duration_sec": 5.2, **{k: v for k, v in base.items()
                                                                            if k != "ref_image_size"}},
        "ref_turbo8": ref(**dict(base, steps=8, turbo_lora=1.0, sampler="euler", shift_video=6.0, shift_audio=3.0,
                                 turbo_lora_name="minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors")),
    }
    spec = tmp_path / "cases.json"
    spec.write_text(json.dumps({"assets": {str(k): v for k, v in assets.items()}, "cases": cases}))
    out = tmp_path / "new.json"
    subprocess.run([sys.executable, "-B", str(HERE / "_capture_wf.py"), str(HERE.parent), str(spec), str(out)],
                   check=True, timeout=300, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    o = json.loads(out.read_text())
    wf = o["ref_shift6"]["wf"]
    assert wf["shift"]["inputs"]["shift_video"] == 6.0 and wf["guider"]["inputs"]["model"] == ["shift", 0]
    assert wf["smp"]["inputs"]["sampler_name"] == "res_multistep" and wf["sched"]["inputs"]["scheduler"] == "beta"
    assert wf["sched"]["inputs"]["steps"] == 20 and "ecache" not in wf and "turbolora" not in wf
    assert wf["cond"]["inputs"]["ref_image_size"] == "max"
    assert "shift" not in o["ref_default_shift"]["wf"]
    vw = o["ref_vdn"]["wf"]
    assert vw["smp"]["inputs"]["sampler_name"] == "res_multistep"   # VDN の既定 euler で上書きしない
    assert vw["sched"]["inputs"]["scheduler"] == "beta"
    assert o["fl2v_beta"]["wf"]["sched"]["inputs"]["scheduler"] == "beta"
    tw = o["ref_turbo8"]["wf"]
    assert tw["turbolora"]["inputs"]["lora_name"].startswith("minimax_h3_ref2v_turbo_8step")
    assert tw["shift"]["inputs"]["shift_video"] == 6.0 and tw["smp"]["inputs"]["sampler_name"] == "euler"
