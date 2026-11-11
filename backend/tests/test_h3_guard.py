"""h3_guard の単体テスト(参照の上限・系列長・T3 の明示設定)。"""
import pytest

from app.services import h3_guard as G


def ref_params(**kw):
    p = {"project_id": 1, "model": "minimax-h3-ref", "width": 1344, "height": 768,
         "duration_sec": 124 / 24, "prompt": "<Picture 1> walks. <Video 1> is the source.",
         "keyframes": [{"time_sec": 0, "asset_id": 101}], "ref_video_asset_ids": [202],
         "steps": 4, "turbo_lora": 0.75, "easycache": True, "scheduler": "beta", "ref_image_size": "match"}
    p.update(kw)
    return p


def problems(p, resolver):
    return G.check_job(p, resolver)


# ── (1) 参照の上限 ─────────────────────────────────────────────────────
def test_valid_ref_job_passes(resolver):
    assert problems(ref_params(), resolver) == []


def test_more_than_9_pictures_rejected(resolver):
    kf = [{"time_sec": 0, "asset_id": 101}] * 10
    errs = problems(ref_params(keyframes=kf), resolver)
    assert any("参照画像が 10 枚" in e for e in errs)


def test_9_pictures_ok(resolver):
    kf = [{"time_sec": 0, "asset_id": 102}] * 9
    assert problems(ref_params(keyframes=kf, prompt="<Picture 9> and <Video 1>"), resolver) == []


def test_more_than_3_videos_rejected(resolver):
    errs = problems(ref_params(ref_video_asset_ids=[202] * 4), resolver)
    assert any("参照動画が 4 本" in e for e in errs)


def test_more_than_3_audios_rejected(resolver):
    errs = problems(ref_params(ref_audio_asset_ids=[203] * 4), resolver)
    assert any("参照音声が 4 本" in e for e in errs)


def test_more_than_12_files_rejected(resolver):
    kf = [{"time_sec": 0, "asset_id": 102}] * 9
    errs = problems(ref_params(keyframes=kf, ref_video_asset_ids=[202, 202, 202],
                               ref_audio_asset_ids=[203]), resolver)
    assert any("合計 13 個" in e for e in errs)


def test_total_ref_video_over_15s_rejected(resolver):
    # 226f 生成に 200f×2 本 → 各 192f(17k+5 に切り下げ)→ 合計 384f > 362f
    errs = problems(ref_params(duration_sec=226 / 24, ref_video_asset_ids=[203, 203],
                               prompt="<Picture 1> <Video 2>"), resolver)
    assert any("参照動画の合計" in e and "384f" in e for e in errs)


def test_single_362f_ref_with_362f_generation_ok(resolver):
    # 15.08 秒(362f)は H3 の「15 秒」= 生成の最大長と同じ単位。960x544 なら成立している組
    p = ref_params(duration_sec=362 / 24, width=960, height=544, ref_video_asset_ids=[204])
    errs = problems(p, resolver)
    assert not any("参照動画" in e for e in errs), errs


def test_chain_receives_only_segment_length_of_ref_video(resolver):
    # 576f(24 秒)の参照で 576f の継続生成: 各セグメントは先頭からセグメント長しか受け取らない
    p = ref_params(duration_sec=576 / 24, width=960, height=544, ref_video_asset_ids=[205])
    calls, errs = G.plan_calls(p, resolver)
    assert errs == [] and len(calls) == 2
    assert all(c.frames <= 362 for c in calls)
    assert not any("参照動画" in e for e in G.reference_problems(p, calls))


def test_too_short_ref_video_rejected(resolver):
    errs = problems(ref_params(ref_video_asset_ids=[206]), resolver)
    assert any("3 フレームしかない" in e for e in errs)


@pytest.mark.parametrize("prompt,needle", [
    ("<Picture 2> is a face", "<Picture 2>"),
    ("<Picture 0> is wrong", "<Picture 0>"),
    ("<Picture 1> follows <Video 2>", "<Video 2>"),
    ("<Picture 1> sings <Audio 1>", "<Audio 1>"),
])
def test_prompt_tag_beyond_passed_count_rejected(resolver, prompt, needle):
    errs = problems(ref_params(prompt=prompt), resolver)
    assert any(needle in e for e in errs), errs


def test_audio_tag_counts_ref_video_soundtrack(resolver):
    p = ref_params(prompt="<Picture 1> <Video 1> <Audio 1>", use_ref_video_audio=True)
    # 黒画面の参照動画には音声トラックが無いが、ラベル番号は use_ref_video_audio で決まる
    assert not any("<Audio 1>" in e for e in problems(p, resolver))


def test_ref2va_needs_some_reference(resolver):
    errs = problems(ref_params(keyframes=[], ref_video_asset_ids=[], prompt="x"), resolver)
    assert any("最低 1 つ" in e for e in errs)


def test_missing_asset_rejected(resolver):
    errs = problems(ref_params(keyframes=[{"time_sec": 0, "asset_id": 999}]), resolver)
    assert any("999" in e for e in errs)


def test_guide_outside_video_rejected(resolver):
    p = ref_params(guide_keyframes=[{"asset_id": 103, "frame_idx": 124}])
    assert any("frame_idx=124" in e for e in problems(p, resolver))
    p = ref_params(guide_keyframes=[{"asset_id": 103, "frame_idx": 123}])
    assert problems(p, resolver) == []


def test_fl2v_has_no_tag_check_and_needs_keyframe(resolver):
    p = {"project_id": 1, "model": "minimax-h3", "width": 1344, "height": 768, "duration_sec": 5.2,
         "prompt": "<Picture 3> whatever", "keyframes": [{"time_sec": 0, "asset_id": 103}],
         "steps": 4, "turbo_lora": 0.75, "easycache": True}
    assert problems(p, resolver) == []
    p["keyframes"] = []
    assert any("キーフレーム" in e for e in problems(p, resolver))


def test_non_h3_models_untouched(resolver):
    assert G.check_job({"model": "wan2.2-flf2v", "keyframes": [{"asset_id": 999}] * 20}, resolver) == []
    assert G.check_job({"model": "minimax-h3-edit"}, resolver) == []


# ── (2) 系列長 ─────────────────────────────────────────────────────────
def test_geometry_helpers():
    assert G.adapt_canvas(1920, 1080) == (1344, 768)
    assert G.ref_video_canvas(960, 544) == (960, 544)          # 小さい参照は拡大しない
    assert G.ref_image_target(1024, 1536, 1344, 768, "max") == (1024, 1536)
    assert G.ref_image_target(1024, 1536, 1344, 768, "match") == (832, 1248)
    assert G.video_latent_t(345) == 102 and G.vae_latent_t(345) == 102
    assert G.vae_latent_t(22) == 7 and G.vae_latent_t(1) == 1


def test_target_tokens_1344_345f(resolver):
    p = ref_params(duration_sec=345 / 24, ref_video_asset_ids=[], prompt="<Picture 1>")
    calls, _ = G.plan_calls(p, resolver)
    e = G.estimate_call(p["prompt"], calls[0])
    assert e.target_video == 102 * 1008 and e.target_audio == 1150


def test_7311_like_config_is_over_and_message_has_breakdown(resolver):
    # 7311 の構成: 345f@1344, 参照動画 1344x768 345f, 設定画 9 枚(max)
    kf = [{"time_sec": 0, "asset_id": 101}] * 8 + [{"time_sec": 0, "asset_id": 102}]
    p = ref_params(duration_sec=345 / 24, keyframes=kf, ref_video_asset_ids=[201],
                   ref_image_size="max", prompt="<Picture 9> <Video 1> " + "word " * 3000)
    errs = problems(p, resolver)
    assert len(errs) == 1
    e = errs[0]
    for needle in ("系列長が上限を超える", "上限 198,000", "生成映像", "参照動画 102,816", "参照画像",
                   "テキスト", "shrink the ref video, shorten, or split"):
        assert needle in e, (needle, e)


def test_shrinking_ref_video_brings_it_under(resolver):
    kf = [{"time_sec": 0, "asset_id": 101}] * 5 + [{"time_sec": 0, "asset_id": 102}] * 2
    p = ref_params(duration_sec=345 / 24, keyframes=kf, ref_video_asset_ids=[202],
                   ref_image_size="max", prompt="<Picture 7> <Video 1> " + "word " * 3800)
    assert problems(p, resolver) == []       # 7497 相当(960x544 の参照) ≈ 187k


def test_limit_overrides(resolver, monkeypatch):
    kf = [{"time_sec": 0, "asset_id": 101}] * 9
    p = ref_params(duration_sec=345 / 24, keyframes=kf, ref_video_asset_ids=[201], ref_image_size="max",
                   prompt="<Picture 9> <Video 1>")
    assert any("系列長" in e for e in problems(p, resolver))
    # ジョブ単位(記録が残る)
    assert problems(dict(p, h3_max_seq_tokens=400000), resolver) == []
    assert any("h3_max_seq_tokens" in e for e in problems(dict(p, h3_max_seq_tokens="abc"), resolver))
    # 設定(PUT /api/settings → data/settings.json)
    from app.services import settings_store
    monkeypatch.setattr(settings_store, "_CACHE", {"H3_MAX_SEQ_TOKENS": "400000"})
    assert G.max_seq_tokens() == 400000
    assert problems(p, resolver) == []


def test_default_limit_is_198000():
    assert G.max_seq_tokens() == 198000


def test_chain_segments_counted_per_call_with_context(resolver):
    p = ref_params(duration_sec=576 / 24, width=960, height=544, ref_video_asset_ids=[205],
                   prompt="<Picture 1> <Video 1>")
    calls, _ = G.plan_calls(p, resolver)
    e1, e2 = G.token_estimates(p, calls)
    rows = (960 // 32) * (544 // 32)
    assert calls[1].chain_context == ("latent", 22)
    assert e2.guides == 7 * rows + 80                 # 末尾 22f=7 ラテント + 音声 24f=40×2
    pg = dict(p, chain={"mode": "guide"})
    calls_g, _ = G.plan_calls(pg, resolver)
    assert G.token_estimates(pg, calls_g)[1].guides == 7 * rows


def test_guides_and_fl2v_keyframes_counted(resolver):
    rows = (1344 // 32) * (768 // 32)
    p = ref_params(guide_keyframes=[{"asset_id": 103, "frame_idx": 0}, {"asset_id": 103, "frame_idx": 60}])
    calls, _ = G.plan_calls(p, resolver)
    assert G.estimate_call("", calls[0]).guides == 2 * rows
    fl = {"model": "minimax-h3", "width": 1344, "height": 768, "duration_sec": 5.2, "prompt": "",
          "keyframes": [{"asset_id": 103}, {"asset_id": 103}]}
    calls, _ = G.plan_calls(fl, resolver)
    e = G.estimate_call("", calls[0])
    assert e.guides == 2 * rows and e.text_images == 2 * rows


def test_t1_preset_applied_before_estimating(resolver):
    p = ref_params(quality="t1", width=960, height=544)
    calls, _ = G.plan_calls(G.apply_quality_preset(p)[0], resolver)
    assert (calls[0].width, calls[0].height, calls[0].ref_image_size) == (1344, 768, "match")


# ── (3) Tier / T3 ─────────────────────────────────────────────────────
def t3(**kw):
    p = ref_params(tier="t3", steps=20, scheduler="beta", sampler="res_multistep", easycache=False,
                   turbo_lora=None, shift_video=None, shift_audio=None, ref_image_size="max", seed=-1)
    p.update(kw)
    return p


def test_t3_complete_passes(resolver):
    assert problems(t3(), resolver) == []


@pytest.mark.parametrize("key", ["steps", "scheduler", "sampler", "easycache", "turbo_lora",
                                 "shift_video", "shift_audio", "ref_image_size", "width", "height",
                                 "duration_sec", "seed"])
def test_t3_missing_key_rejected(resolver, key):
    p = t3()
    p.pop(key)
    errs = problems(p, resolver)
    assert any("T3 なのに" in e and key in e for e in errs), errs


@pytest.mark.parametrize("kw,needle", [
    ({"quality": "t1"}, "quality"),
    ({"steps": 0}, "steps"),
    ({"steps": None}, "steps"),
    ({"easycache": None}, "easycache"),
    ({"sampler": ""}, "sampler"),
    ({"width": 1350}, "width"),
    ({"turbo_lora": 0.75}, "turbo_lora_name"),
    ({"turbo_lora": -1}, "turbo_lora"),
    ({"shift_video": 0}, "shift_video"),
    ({"ref_image_size": "huge"}, "ref_image_size"),
    ({"preview_steps": 20}, "preview_steps"),
    ({"vdn": True, "turbo_lora": 1.0, "turbo_lora_name": "x.safetensors"}, "vdn"),
    ({"vdn": {"sampler": "euler"}}, "vdn.sampler"),
    ({"tier": "t2", "quality": "t3"}, "矛盾"),
])
def test_t3_bad_values_rejected(resolver, kw, needle):
    errs = problems(t3(**kw), resolver)
    assert any(needle in e for e in errs), errs


def test_t3_marker_variants():
    assert G.is_t3({"tier": "T3 "}) and G.is_t3({"quality": "t3"})
    assert not G.is_t3({"tier": "t2"}) and not G.is_t3({})


def test_t3_preview_trailer_allowed(resolver):
    # T3 に進むときの予告編(シード選び)は同じ T3 設定+preview_steps で投げられる
    assert problems(t3(preview_steps=2), resolver) == []


def test_t3_turbo_with_name_and_shift_ok(resolver):
    p = t3(steps=8, turbo_lora=1.0, turbo_lora_name="minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
           shift_video=6.0, shift_audio=3.0, sampler="euler")
    assert problems(p, resolver) == []


def test_t3_fl2v_does_not_need_ref_image_size(resolver):
    p = {"project_id": 1, "model": "minimax-h3", "tier": "t3", "width": 1344, "height": 768,
         "duration_sec": 5.2, "seed": 1, "prompt": "", "keyframes": [{"asset_id": 103}],
         "steps": 20, "scheduler": "simple", "sampler": "res_multistep", "easycache": False,
         "turbo_lora": None, "shift_video": None, "shift_audio": None}
    assert problems(p, resolver) == []


def test_invalid_tier_value_rejected(resolver):
    assert any("tier の値が不正" in e for e in problems(ref_params(tier="final"), resolver))


def test_legacy_jobs_without_marker_keep_defaults(resolver):
    """マーカーの無いジョブ(既存の UI/スクリプト)は従来どおり既定値で動く=止めない。"""
    p = {"project_id": 1, "model": "minimax-h3-ref", "width": 1344, "height": 768, "duration_sec": 5.2,
         "prompt": "<Picture 1>", "keyframes": [{"asset_id": 101}], "steps": 25}
    assert problems(p, resolver) == []


def test_provided_keys_used_for_presence(resolver):
    p = t3()
    provided = set(p) - {"sampler"}
    assert any("sampler" in e for e in G.check_job(p, resolver, provided))


def test_check_submission_fails_open_on_internal_error_but_keeps_t3(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("bug")
    monkeypatch.setattr(G, "check_job", boom)
    assert G.check_submission(1, "generate_video_i2v", ref_params(), session=None) == []
    errs = G.check_submission(1, "generate_video_i2v", {"model": "minimax-h3-ref", "tier": "t3"}, session=None)
    assert any("T3 なのに" in e for e in errs)


def test_check_submission_ignores_other_job_types():
    assert G.check_submission(1, "generate_image", {"model": "minimax-h3-ref", "tier": "bad"}, session=None) == []


def test_unmeasurable_media_skips_token_check_but_keeps_limits(tmp_path):
    bad = tmp_path / "broken.png"
    bad.write_bytes(b"not an image")
    table = {1: {"file_path": str(bad), "width": None, "height": None, "duration_sec": None}}
    p = {"model": "minimax-h3-ref", "width": 1344, "height": 768, "duration_sec": 5.2,
         "prompt": "<Picture 1>", "keyframes": [{"asset_id": 1}]}
    assert G.check_job(p, table.get) == []                       # 測れない → 見積りは省略(止めない)
    p["keyframes"] = [{"asset_id": 1}] * 10
    assert any("10 枚" in e for e in G.check_job(p, table.get))  # 数の上限は効く
