"""
LLM chat router — Claude-powered timeline assistant.

POST /api/llm/chat
  - Receives conversation history + project_id
  - Injects project state as context
  - Runs agentic loop with tool use
  - Executes timeline operations via command_api
  - Returns assistant reply + executed actions log
"""

import json
from typing import Any

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from app.config import ANTHROPIC_API_KEY, LLM_MODEL
from app.db.database import get_session
from app.models import Project
from app.services import command_api

router = APIRouter(prefix="/llm", tags=["llm"])

# ── Anthropic tool definitions ────────────────────────────────────────────────

TOOLS: list[dict] = [
    # ── Read ──────────────────────────────────────────────────────────────────
    {
        "name": "get_project_state",
        "description": (
            "Get the current timeline state: all tracks, clips, and their positions. "
            "Call this first to understand what's on the timeline."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_llm_state",
        "description": (
            "Comprehensive one-call state: timeline + assets + analysis results (BPM, scenes) "
            "+ active jobs + GPU status. Use instead of multiple separate calls when you need full context."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_assets",
        "description": "List assets available in the project.",
        "input_schema": {
            "type": "object",
            "properties": {
                "asset_type": {
                    "type": "string",
                    "description": "Filter by type",
                    "enum": ["video", "audio", "image", "generated"],
                }
            },
        },
    },
    {
        "name": "get_analysis_summary",
        "description": (
            "Get audio/video analysis results: BPM, beat count, scene count, motion intensity. "
            "Use when the user asks about tempo, rhythm, beat-sync, or scene structure."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_recent_operations",
        "description": (
            "Recent timeline edits the USER (and AI) have made, newest first. Use this to "
            "understand what the user has been working on before suggesting or making edits. "
            "Each entry has actor (user/ai), kind (add_clip/move_clip/trim_clip/split_clip/...), detail, ts."
        ),
        "input_schema": {"type": "object",
                         "properties": {"limit": {"type": "integer", "default": 50}},
                         "required": []},
    },
    {
        "name": "get_beat_grid",
        "description": (
            "Get beat positions in TIMELINE FRAME coordinates for beat-synced editing (音ハメ). "
            "Returns each beat's frame + whether it is a downbeat (小節頭), the beat interval in "
            "frames, and downbeat frames. Use these frames directly as cut points / clip "
            "boundaries with move_clip, split_clip, or add_clip to align edits to the music. "
            "Requires audio beat analysis (trigger_analysis audio) on a timeline audio clip."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    # ── Track ─────────────────────────────────────────────────────────────────
    {
        "name": "add_track",
        "description": "Add a new track to the timeline.",
        "input_schema": {
            "type": "object",
            "properties": {
                "track_type": {"type": "string", "enum": ["video", "audio", "reference"]},
                "name":       {"type": "string", "description": "Track label"},
            },
            "required": ["track_type", "name"],
        },
    },
    {
        "name": "delete_track",
        "description": "Delete a track and all its clips.",
        "input_schema": {
            "type": "object",
            "properties": {"track_id": {"type": "integer"}},
            "required": ["track_id"],
        },
    },
    # ── Clip ──────────────────────────────────────────────────────────────────
    {
        "name": "add_clip",
        "description": "Add an asset as a clip to a track at a given start frame.",
        "input_schema": {
            "type": "object",
            "properties": {
                "track_id":        {"type": "integer", "description": "Target track ID"},
                "asset_id":        {"type": "integer", "description": "Asset ID (or null for empty clip)"},
                "start_frame":     {"type": "integer", "description": "Start frame on the timeline"},
                "duration_frames": {"type": "integer", "description": "Clip length in frames"},
            },
            "required": ["track_id", "start_frame", "duration_frames"],
        },
    },
    {
        "name": "move_clip",
        "description": "Move a clip to a new start frame.",
        "input_schema": {
            "type": "object",
            "properties": {
                "clip_id":         {"type": "integer"},
                "new_start_frame": {"type": "integer"},
            },
            "required": ["clip_id", "new_start_frame"],
        },
    },
    {
        "name": "delete_clip",
        "description": "Delete a clip from the timeline.",
        "input_schema": {
            "type": "object",
            "properties": {"clip_id": {"type": "integer"}},
            "required": ["clip_id"],
        },
    },
    {
        "name": "split_clip",
        "description": "Split a clip into two at the given frame.",
        "input_schema": {
            "type": "object",
            "properties": {
                "clip_id":     {"type": "integer"},
                "split_frame": {"type": "integer", "description": "Frame at which to cut"},
            },
            "required": ["clip_id", "split_frame"],
        },
    },
    {
        "name": "auto_cut_to_beats",
        "description": (
            "Split a clip at every beat within its span (音ハメ自動カット). Uses the project's "
            "beat grid. Great for cutting a clip to the rhythm. Requires audio beat analysis."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"clip_id": {"type": "integer"}},
            "required": ["clip_id"],
        },
    },
    {
        "name": "get_beat_match_score",
        "description": (
            "音ハメスコア: how well visual changes (cuts + per-frame motion) line up with "
            "the music's beats. Returns score (0-100), cuts_on_beat, and weak_beats — "
            "beat positions lacking a visual change. Use weak_beats to decide where to "
            "add cuts, flashes, or high-motion clips. Requires audio beat analysis and "
            "video motion_curve analysis (trigger_analysis)."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "set_transform",
        "description": (
            "Set animated zoom/pan/shake on a clip (静止画MADの核 — makes stills move). "
            "transform: 'kenburns_in' | 'kenburns_out' | 'punch_in' (beat hit) | 'punch_out' "
            "| 'pan_lr' | 'pan_rl' | 'shake' (impact) | '' (clear) | custom JSON "
            "{\"keyframes\":[{\"t\":0,\"scale\":1.3,\"x\":0,\"y\":0},{\"t\":1,\"scale\":1.0}]} "
            "(t=0..1 over clip, x/y=-0.5..0.5 pan fraction)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "clip_id":   {"type": "integer"},
                "transform": {"type": "string"},
            },
            "required": ["clip_id", "transform"],
        },
    },
    {
        "name": "scatter_beat_effects",
        "description": (
            "ビート同期エフェクトの一括散布: apply an effect at every (down)beat in a range "
            "on the primary video track in ONE call. effect: 'flash' (white flash on the "
            "beat, no jump) | 'punch' (zoom punch-in on the beat — 静止画MAD idiom). "
            "every: 'downbeat' | 'beat'. Optional start_frame/end_frame range, max_count."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "effect":      {"type": "string", "enum": ["flash", "punch"]},
                "every":       {"type": "string", "enum": ["downbeat", "beat"]},
                "start_frame": {"type": "integer"},
                "end_frame":   {"type": "integer"},
                "max_count":   {"type": "integer"},
            },
            "required": ["effect"],
        },
    },
    {
        "name": "set_clip_speed",
        "description": (
            "Set a clip's playback speed and acceleration curve. ease: 'linear' | 'in' "
            "(accelerate) | 'out' (decelerate) | 'inout' | custom bezier 'cubic:x1,y1,x2,y2' "
            "(P0=(0,0), P3=(1,1)). Source span stays fixed — timeline duration auto-adjusts. "
            "Speed ramps make generated (constant-speed) footage feel much more dynamic."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "clip_id": {"type": "integer"},
                "speed":   {"type": "number", "description": "0.1-8.0"},
                "ease":    {"type": "string"},
            },
            "required": ["clip_id", "speed"],
        },
    },
    {
        "name": "set_transition",
        "description": (
            "Set the transition INTO a clip (joins it to the previous clip on its track). "
            "transition: '' (hard cut) | 'cross' (crossfade) | 'white' (white flash, MAD定番) "
            "| 'black' (dip to black). frames = duration in timeline frames (e.g. 8 ≈ 0.27s "
            "at 30fps). Duration-preserving — the timeline and music sync never shift."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "clip_id":    {"type": "integer"},
                "transition": {"type": "string", "enum": ["", "cross", "white", "black"]},
                "frames":     {"type": "integer", "description": "transition duration in frames"},
            },
            "required": ["clip_id", "transition"],
        },
    },
    {
        "name": "set_audio_fade",
        "description": "Set fade-in/fade-out on an audio clip (frames at project fps). "
                       "Use fade_out to avoid an abrupt end of the music.",
        "input_schema": {
            "type": "object",
            "properties": {
                "clip_id":         {"type": "integer"},
                "fade_in_frames":  {"type": "integer"},
                "fade_out_frames": {"type": "integer"},
            },
            "required": ["clip_id"],
        },
    },
    # ── Generation / Analysis ─────────────────────────────────────────────────
    {
        "name": "create_generation_job",
        "description": (
            "Queue an AI generation job. "
            "job_type: 'generate_image' | 'generate_audio' | 'generate_video_i2v'. "
            "params vary by type — include prompt, model, keyframes (for I2V), etc."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "job_type": {
                    "type": "string",
                    "enum": ["generate_image", "generate_audio", "generate_video_i2v", "render_motion_graphics"],
                },
                "params": {
                    "type": "object",
                    "description": "Job parameters (prompt, model, keyframes for I2V, etc.)",
                },
            },
            "required": ["job_type", "params"],
        },
    },
    {
        "name": "trigger_analysis",
        "description": (
            "Start audio or video analysis for an asset. "
            "analysis_type: 'audio' → BPM/beat detection. 'video' → scene detection + motion."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "asset_id":      {"type": "integer"},
                "analysis_type": {"type": "string", "enum": ["audio", "video"]},
            },
            "required": ["asset_id", "analysis_type"],
        },
    },
]

SYSTEM_PROMPT = """\
あなたはMAD動画制作スタジオ「KyChaPoGaS」のAIアシスタントです。
ユーザーの自然言語指示を受けて、タイムライン操作・素材管理・AI生成ジョブ作成を支援します。

## 基本方針
- 操作を実行する前に、何を行うか簡潔に説明してください。
- 複数クリップの一括削除など大きな変更は、実行前にユーザーの確認を求めてください。
- フレーム計算にはプロジェクトのFPSを使用してください（get_project_stateで確認可能）。
- 素材名・トラック名など曖昧な指示は、get_project_state / get_assetsで現状を確認してから判断してください。
- 操作後は何を実行したか簡潔に報告してください。

## MCP対応について
このAPIはMCPサーバーとしても将来的に公開予定です。同じtoolsをMCP経由でClaude Codeから呼ぶことができます。
"""


# ── Request / Response models ─────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str   # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    project_id: int
    history: list[ChatMessage] = []
    message: str


class ActionLog(BaseModel):
    tool: str
    input: dict
    result: dict


class ChatResponse(BaseModel):
    reply: str
    actions: list[ActionLog]
    error: str | None = None


# ── Tool executor ─────────────────────────────────────────────────────────────

def _exec_tool(
    name: str,
    inp: dict,
    project_id: int,
    session: Session,
) -> dict:
    match name:
        case "get_project_state":
            return command_api.get_project_state(project_id, session)
        case "get_llm_state":
            return command_api.get_llm_state(project_id, session)
        case "get_assets":
            return command_api.get_assets(project_id, session, inp.get("asset_type"))
        case "get_analysis_summary":
            return command_api.get_analysis_summary(project_id, session)
        case "get_recent_operations":
            return command_api.get_recent_operations(project_id, session, inp.get("limit", 50))
        case "get_beat_grid":
            return command_api.get_beat_grid(project_id, session)
        case "add_track":
            return command_api.add_track(
                project_id, inp["track_type"], inp["name"], session
            )
        case "delete_track":
            return command_api.delete_track(inp["track_id"], session)
        case "add_clip":
            return command_api.add_clip(
                project_id, inp["track_id"],
                inp.get("asset_id"), inp["start_frame"], inp["duration_frames"],
                session,
            )
        case "move_clip":
            return command_api.move_clip(inp["clip_id"], inp["new_start_frame"], session)
        case "delete_clip":
            return command_api.delete_clip(inp["clip_id"], session)
        case "split_clip":
            return command_api.split_clip(inp["clip_id"], inp["split_frame"], session)
        case "auto_cut_to_beats":
            return command_api.auto_cut_to_beats(project_id, inp["clip_id"], session)
        case "get_beat_match_score":
            return command_api.get_beat_match_score(project_id, session)
        case "set_transform":
            return command_api.set_transform(inp["clip_id"], inp["transform"], session)
        case "scatter_beat_effects":
            return command_api.scatter_beat_effects(
                project_id, inp["effect"], session,
                every=inp.get("every", "downbeat"),
                start_frame=inp.get("start_frame", 0),
                end_frame=inp.get("end_frame"),
                max_count=inp.get("max_count", 32))
        case "set_clip_speed":
            return command_api.set_clip_speed(
                inp["clip_id"], inp["speed"], inp.get("ease", "linear"), session)
        case "set_transition":
            return command_api.set_transition(
                inp["clip_id"], inp["transition"], inp.get("frames", 8), session)
        case "set_audio_fade":
            return command_api.set_audio_fade(
                inp["clip_id"], inp.get("fade_in_frames", 0), inp.get("fade_out_frames", 0), session)
        case "create_generation_job":
            return command_api.create_job(
                project_id, inp["job_type"], inp.get("params", {}), session
            )
        case "trigger_analysis":
            return command_api.trigger_analysis(
                project_id, inp["asset_id"], inp["analysis_type"], session
            )
        case _:
            return {"error": f"Unknown tool: {name}"}


# ── Main endpoint ─────────────────────────────────────────────────────────────

@router.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest, session: Session = Depends(get_session)):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="ANTHROPIC_API_KEY not configured. Add it to backend/.env",
        )

    project = session.get(Project, req.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    # Build message history
    messages: list[dict[str, Any]] = [
        {"role": m.role, "content": m.content} for m in req.history
    ]
    messages.append({"role": "user", "content": req.message})

    actions: list[ActionLog] = []

    # System prompt with project context (cached)
    system = [
        {
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        },
        {
            "type": "text",
            "text": (
                f"## 現在のプロジェクト\n"
                f"名前: {project.name}\n"
                f"FPS: {project.fps}\n"
                f"解像度: {project.width}×{project.height}\n"
            ),
        },
    ]

    # Agentic loop
    for _ in range(10):   # max 10 tool-call rounds
        response = client.messages.create(
            model=LLM_MODEL,
            max_tokens=4096,
            system=system,
            tools=TOOLS,
            messages=messages,
        )

        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "end_turn":
            break

        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    result = _exec_tool(block.name, block.input, req.project_id, session)
                    actions.append(ActionLog(tool=block.name, input=block.input, result=result))
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result, ensure_ascii=False),
                    })
            messages.append({"role": "user", "content": tool_results})

    # Extract final text reply
    reply = ""
    for block in response.content:
        if hasattr(block, "text"):
            reply += block.text

    return ChatResponse(reply=reply, actions=actions)


@router.get("/state/{project_id}")
def get_state(project_id: int, session: Session = Depends(get_session)):
    """
    Comprehensive project state for external LLM clients (MCP, Claude Code, etc.).
    Returns timeline, assets, analysis summary, active jobs, GPU status in one call.
    """
    from app.models import Project
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return command_api.get_llm_state(project_id, session)


@router.get("/tools")
def list_tools_schema():
    """
    Returns the full tool schema used by the LLM chat endpoint.
    Useful for external clients that want to know what operations are available.
    """
    return {"tools": TOOLS, "tool_count": len(TOOLS)}


@router.get("/status")
def llm_status():
    return {
        "configured": bool(ANTHROPIC_API_KEY),
        "model": LLM_MODEL,
    }
