"""
Agent tool surface — ローカルLLMエージェント向けの共有ツール層。

llm.py(チャット) と mcp_server.py(MCP) の両方から import される。
方針: 弱いモデルでも操作できるよう
  1) get_agent_guide  — パイプライン全体の簡潔な操作マニュアル
  2) get_job_catalog  — 全ジョブ型のパラメータスキーマ(機械可読)
  3) create_generation_job(汎用) + get_job_status で全生成機能に到達できる
"""

from pathlib import Path

from sqlmodel import Session

REPO_ROOT = Path(__file__).parent.parent.parent.parent
AGENT_GUIDE = REPO_ROOT / "docs" / "agent-guide.md"


# ── ジョブカタログ: job_type → {description, params} ─────────────────────────
# params は JSON Schema 風 (type/enum/default/説明)。create_generation_job の
# params に渡す内容の唯一の参照元。

JOB_CATALOG: dict[str, dict] = {
    "generate_image": {
        "description": "ComfyUIで画像生成(SDXL系アニメ/Krea2)。結果はgeneratedアセット。",
        "params": {
            "prompt": {"type": "string", "required": True},
            "negative_prompt": {"type": "string"},
            "model": {"type": "string",
                      "enum": ["waiNSFWIllustrious_v170", "animagine-xl-4.0",
                               "noobaiXL_vPred10", "krea2_turbo", "krea2_raw", "sdxl-base"],
                      "default": "waiNSFWIllustrious_v170",
                      "note": "krea2系は自然文プロンプト。SDXL系はdanbooruタグ。"},
            "width": {"type": "integer", "default": 1344},
            "height": {"type": "integer", "default": 768},
            "seed": {"type": "integer", "default": -1},
            "loras": {"type": "array", "items": "[lora_filename, strength]"},
        },
    },
    "cutout": {
        "description": "画像アセットを高品質切り抜き→透過PNG。3Dオブジェクト生成の前処理に必須級。",
        "params": {
            "asset_id": {"type": "integer", "required": True},
            "model": {"type": "string", "default": "isnet-anime"},
            "crop": {"type": "boolean", "default": True},
        },
    },
    "generate_3d": {
        "description": "画像→3Dモデル(GLB)。object=Hunyuan3D-2(キャラ/小物, 透過画像推奨), "
                       "relief=MoGe-2(一枚絵→テクスチャ付き起伏, 3Dフォト用)。",
        "params": {
            "mode": {"type": "string", "enum": ["object", "object_mv", "relief"],
                     "default": "object"},
            "image_asset_id": {"type": "integer", "required": True},
            "views": {"type": "object", "note": "object_mv時: {front,left,back,right: asset_id}"},
            "seed": {"type": "integer", "default": -1},
            "octree_resolution": {"type": "integer", "default": 256},
            "orbit": {"type": "object",
                      "note": "省略可。指定すると続けて透過webmも生成 "
                              "{preset: orbit|dolly_in|dolly_out|sway|arc_l|arc_r|parallax, "
                              "seconds, fps, width, height, style: standard|toon|wire, turns}"},
        },
    },
    "render_orbit3d": {
        "description": "既存model3d(GLB)アセットからカメラワーク付き透過webmを焼く。",
        "params": {
            "asset_id": {"type": "integer", "required": True},
            "orbit": {"type": "object", "required": True,
                      "note": "generate_3dのorbitと同形式"},
        },
    },
    "generate_video_3dcam": {
        "description": "本命: 3Dカメラワーク×Wan2.2 Fun ControlのAIレンダ動画。"
                       "GLBシーンの深度レンダをコントロールに、参照画像の画風で描く(81f=約5秒)。",
        "params": {
            "model_asset_id": {"type": "integer", "note": "単体GLB(sceneと排他)"},
            "scene": {"type": "object",
                      "note": "複数配置: {objects: [{model_asset_id, pos:[x,y,z], "
                              "rot:[度,度,度], scale}], camera: [キーフレーム]}。"
                              "オブジェクトは高さ1に正規化・足元y=0。"},
            "camera": {"type": "object|array",
                       "note": "{preset: arc_r等, turns} または キーフレーム配列 "
                               "[{at:0..1, az:ラジアン, el:ラジアン, dist:半径倍率, fov, "
                               "roll:度, target:[x,y,z], ease: linear|inOut|outCubic|inCubic}]"},
            "control_style": {"type": "string", "enum": ["depth", "edge"], "default": "depth"},
            "ref_image_asset_id": {"type": "integer", "required": True,
                                   "note": "キャラ・画風を与える原画"},
            "prompt": {"type": "string", "required": True},
            "length": {"type": "integer", "default": 81, "note": "4n+1。81=5.06秒@16fps"},
            "width": {"type": "integer", "default": 832},
            "height": {"type": "integer", "default": 480},
            "seed": {"type": "integer", "default": -1},
            "keep_control_video": {"type": "boolean", "default": False},
        },
    },
    "generate_video_i2v": {
        "description": "キーフレーム画像から動画(Wan2.2)。flf2v=最初/最後フレーム指定。"
                       "vace=任意フレーム位置のキーフレームを1パス固定(time_secの相対位置を尊重、3枚以上推奨)。"
                       "minimax-h3=映像+ネイティブ音声を同時生成(24fps/最初・最後フレーム対応/高品質だが1本数分)。",
        "params": {
            "model": {"type": "string",
                      "enum": ["wan2.2-flf2v", "wan2.2-vace", "wan2.2-fun-inp", "minimax-h3", "svd-xt"],
                      "default": "wan2.2-flf2v"},
            "keyframes": {"type": "array", "required": True,
                          "items": "{time_sec, asset_id}"},
            "prompt": {"type": "string"},
            "duration_sec": {"type": "number", "default": 3.0},
            "width": {"type": "integer", "default": 640},
            "height": {"type": "integer", "default": 640},
            "use_lightning": {"type": "boolean", "default": True},
            "steps": {"type": "integer", "note": "minimax-h3用(既定20)。Wan系はuse_lightningが優先"},
        },
    },
    "generate_video_s2v": {
        "description": "音声+参照画像→歌唱/口パク動画(Wan2.2 S2V)。",
        "params": {
            "ref_asset_id": {"type": "integer", "required": True},
            "audio_asset_id": {"type": "integer", "required": True},
            "prompt": {"type": "string"},
        },
    },
    "generate_audio": {
        "description": "ACE-Step 1.5で楽曲生成(ボーカル可)。captionは英語・BPM/キー語は入れない。",
        "params": {
            "prompt": {"type": "string", "required": True, "note": "caption(スタイル記述)"},
            "lyrics": {"type": "string", "note": "[Verse][Chorus]等の構造タグ付き歌詞"},
            "duration_sec": {"type": "number", "default": 60},
            "bpm": {"type": "integer"},
            "key": {"type": "string"},
            "vocal_language": {"type": "string", "default": "ja"},
            "seed": {"type": "integer"},
            "variants": {"type": "integer", "default": 1},
        },
    },
    "analyze_audio": {
        "description": "BPM/ビート検出(タイムラインの音ハメに必須)。",
        "params": {"asset_id": {"type": "integer", "required": True}},
    },
    "analyze_video": {
        "description": "シーン検出+モーション強度解析。",
        "params": {"asset_id": {"type": "integer", "required": True}},
    },
    "interpolate": {
        "description": "フレーム補間で動画をなめらかに(RIFE系)。",
        "params": {"asset_id": {"type": "integer", "required": True},
                   "factor": {"type": "integer", "default": 2}},
    },
    "vlm_review": {
        "description": "生成動画をVLMで自動レビュー(破綻検出)。",
        "params": {"asset_id": {"type": "integer", "required": True}},
    },
    "render_final": {
        "description": "タイムライン全体を最終レンダ(MP4書き出し)。",
        "params": {},
    },
}


# ── 追加ツール定義 (anthropic tool format) ────────────────────────────────────

AGENT_TOOLS: list[dict] = [
    {
        "name": "get_agent_guide",
        "description": (
            "KyChaPoGaS操作マニュアル(全パイプラインの手順書)を取得する。"
            "最初に一度読むこと。"
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_job_catalog",
        "description": (
            "create_generation_job で使える全 job_type のパラメータスキーマを取得する。"
            "job_type を指定すればその型だけ返す。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {"job_type": {"type": "string"}},
            "required": [],
        },
    },
    {
        "name": "get_vocab",
        "description": (
            "映像用語カタログを取得(テンプレート/FX/enter/idle/ambient/カメラ等の正式キーと説明)。"
            "ユーザーの言葉を効果に変換する前に必ず正式キーを確認する。categoryで絞り込み可。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {"category": {"type": "string"}},
            "required": [],
        },
    },
    {
        "name": "make_beat_camera",
        "description": (
            "ビート同期の3Dカメラキーフレームを生成する(音ハメカメラ)。"
            "結果のcamera配列は generate_video_3dcam の scene.camera / camera や "
            "mad-kit scene3d の params.camera にそのまま渡せる。"
            "style: punch_in(小節頭で寄る) | orbit_beat(小節ごと回り込み) | "
            "sway_beat(ビートで揺れる) | riser(ビルドアップ)"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "audio_asset_id": {"type": "integer", "description": "audio_beats解析済み音源"},
                "start_sec": {"type": "number"},
                "end_sec": {"type": "number"},
                "style": {"type": "string",
                          "enum": ["punch_in", "orbit_beat", "sway_beat", "riser"]},
                "intensity": {"type": "number", "description": "0.5控えめ〜1.5強め"},
            },
            "required": ["audio_asset_id", "start_sec", "end_sec"],
        },
    },
    {
        "name": "get_job_status",
        "description": (
            "ジョブの状態を確認する(status/progress/error/result_asset_ids)。"
            "生成ジョブ投入後はこれでポーリングする。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {"job_id": {"type": "integer"}},
            "required": ["job_id"],
        },
    },
]


def dispatch_extra(name: str, inp: dict, project_id: int, session: Session) -> dict | None:
    """追加ツールの実行。該当しなければ None(呼び出し側でフォールバック)。"""
    if name == "get_agent_guide":
        if AGENT_GUIDE.exists():
            return {"guide": AGENT_GUIDE.read_text(encoding="utf-8")}
        return {"error": "agent-guide.md not found"}

    if name == "get_job_catalog":
        jt = inp.get("job_type")
        if jt:
            entry = JOB_CATALOG.get(jt)
            return {"job_type": jt, **entry} if entry else {"error": f"unknown job_type: {jt}"}
        return {"job_types": {k: v["description"] for k, v in JOB_CATALOG.items()},
                "hint": "job_type を指定すると params スキーマを返す"}

    if name == "get_vocab":
        import json as _json
        vf = REPO_ROOT / "tools" / "mad-kit" / "vocab.json"
        if not vf.exists():
            return {"error": "vocab.json not found"}
        data = _json.loads(vf.read_text())
        cat = inp.get("category")
        if cat:
            hit = [c for c in data["categories"] if c["id"] == cat or c["name"] == cat]
            return hit[0] if hit else {"error": f"unknown category: {cat}",
                                       "categories": [c["id"] for c in data["categories"]]}
        return data

    if name == "make_beat_camera":
        import json as _json
        from sqlmodel import select
        from app.models.analysis import AnalysisResult
        from app.services.camera_gen import beat_camera
        res = session.exec(
            select(AnalysisResult)
            .where(AnalysisResult.asset_id == int(inp["audio_asset_id"]),
                   AnalysisResult.analysis_type == "audio_beats")
            .order_by(AnalysisResult.id.desc())).first()
        if not res:
            return {"error": "音源のビート解析がありません(trigger_analysisでaudioを先に)"}
        data = _json.loads(res.result_json)
        beats = data.get("beats") or data.get("beat_times") or []
        camera = beat_camera(float(data.get("bpm") or 120), beats,
                             data.get("downbeats") or beats[::4],
                             float(inp["start_sec"]), float(inp["end_sec"]),
                             inp.get("style", "punch_in"), float(inp.get("intensity", 1.0)))
        return {"camera": camera}

    if name == "get_job_status":
        from app.models.job import Job
        import json as _json
        job = session.get(Job, int(inp["job_id"]))
        if not job:
            return {"error": f"job {inp['job_id']} not found"}
        return {
            "job_id": job.id, "job_type": job.job_type, "status": job.status,
            "progress": job.progress, "error": job.error_msg,
            "result_asset_ids": _json.loads(job.result_asset_ids or "[]"),
        }

    return None
