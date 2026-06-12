#!/usr/bin/env python3
"""
KyChaPoGaS MCP Server.

Exposes all KyChaPoGaS timeline / analysis operations as MCP tools so that
Claude Code (or any MCP client) can directly control the editor.

Usage:
  # Add to ~/.claude/claude_desktop_config.json or .claude/settings.json:
  {
    "mcpServers": {
      "kychapogas": {
        "command": "python",
        "args": ["p:/AniPAFE2026/backend/mcp_server.py", "--project-id", "1"],
        "env": { "PYTHONPATH": "p:/AniPAFE2026/backend" }
      }
    }
  }

  # Or run directly for testing:
  python mcp_server.py --project-id 1

The server connects to the same SQLite database as the FastAPI backend.
"""

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

# Ensure backend package is importable when run as script
sys.path.insert(0, str(Path(__file__).parent))

logging.basicConfig(level=logging.INFO, stream=sys.stderr)
log = logging.getLogger("mcp_server")


def _get_session_and_init():
    """Lazy import — avoids heavy startup if just checking syntax."""
    from app.db.database import create_db_and_tables, engine
    from sqlmodel import Session
    create_db_and_tables()
    return Session(engine)


# ── MCP bootstrap ─────────────────────────────────────────────────────────────

try:
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
    import mcp.types as mcp_types
    _MCP_AVAILABLE = True
except ImportError:
    _MCP_AVAILABLE = False
    log.warning("mcp package not installed — install with: pip install mcp")


# ── Tool registry ─────────────────────────────────────────────────────────────

# These mirror the TOOLS list in llm.py exactly so both interfaces are consistent.
MCP_TOOLS = [
    mcp_types.Tool(
        name="get_project_state",
        description="Get the current timeline: all tracks, clips, positions.",
        inputSchema={"type": "object", "properties": {}, "required": []},
    ),
    mcp_types.Tool(
        name="get_llm_state",
        description=(
            "Comprehensive state: timeline + assets + analysis (BPM, scenes) "
            "+ active jobs + GPU status."
        ),
        inputSchema={"type": "object", "properties": {}, "required": []},
    ),
    mcp_types.Tool(
        name="get_assets",
        description="List assets in the project. Optionally filter by type.",
        inputSchema={
            "type": "object",
            "properties": {
                "asset_type": {
                    "type": "string",
                    "enum": ["video", "audio", "image", "generated"],
                }
            },
        },
    ),
    mcp_types.Tool(
        name="get_analysis_summary",
        description="Get BPM, beat count, scene count, motion intensity for the project.",
        inputSchema={"type": "object", "properties": {}, "required": []},
    ),
    mcp_types.Tool(
        name="get_recent_operations",
        description=(
            "Recent timeline edits the USER (and AI) have made, newest first — "
            "use this to see what the user has been doing before proposing edits. "
            "Each entry has actor (user/ai), kind (add_clip/move_clip/trim_clip/...), detail, ts."
        ),
        inputSchema={"type": "object",
                     "properties": {"limit": {"type": "integer", "default": 50}},
                     "required": []},
    ),
    mcp_types.Tool(
        name="get_beat_grid",
        description=(
            "Beat positions in TIMELINE FRAME coordinates for beat-synced editing (音ハメ): "
            "each beat's frame + downbeat flag, beat interval in frames, downbeat frames. "
            "Use these frames as cut points / clip boundaries with move_clip/split_clip/add_clip."
        ),
        inputSchema={"type": "object", "properties": {}, "required": []},
    ),
    mcp_types.Tool(
        name="auto_cut_to_beats",
        description="Split a clip at every beat within its span (音ハメ自動カット). Requires audio beat analysis.",
        inputSchema={"type": "object", "properties": {"clip_id": {"type": "integer"}}, "required": ["clip_id"]},
    ),
    mcp_types.Tool(
        name="add_track",
        description="Add a new track.",
        inputSchema={
            "type": "object",
            "properties": {
                "track_type": {"type": "string", "enum": ["video", "audio", "reference"]},
                "name":       {"type": "string"},
            },
            "required": ["track_type", "name"],
        },
    ),
    mcp_types.Tool(
        name="delete_track",
        description="Delete a track and all its clips.",
        inputSchema={
            "type": "object",
            "properties": {"track_id": {"type": "integer"}},
            "required": ["track_id"],
        },
    ),
    mcp_types.Tool(
        name="add_clip",
        description="Add an asset as a clip on a track.",
        inputSchema={
            "type": "object",
            "properties": {
                "track_id":        {"type": "integer"},
                "asset_id":        {"type": "integer"},
                "start_frame":     {"type": "integer"},
                "duration_frames": {"type": "integer"},
            },
            "required": ["track_id", "start_frame", "duration_frames"],
        },
    ),
    mcp_types.Tool(
        name="move_clip",
        description="Move a clip to a new start frame.",
        inputSchema={
            "type": "object",
            "properties": {
                "clip_id":         {"type": "integer"},
                "new_start_frame": {"type": "integer"},
            },
            "required": ["clip_id", "new_start_frame"],
        },
    ),
    mcp_types.Tool(
        name="delete_clip",
        description="Delete a clip.",
        inputSchema={
            "type": "object",
            "properties": {"clip_id": {"type": "integer"}},
            "required": ["clip_id"],
        },
    ),
    mcp_types.Tool(
        name="split_clip",
        description="Split a clip at the given frame.",
        inputSchema={
            "type": "object",
            "properties": {
                "clip_id":     {"type": "integer"},
                "split_frame": {"type": "integer"},
            },
            "required": ["clip_id", "split_frame"],
        },
    ),
    mcp_types.Tool(
        name="set_transition",
        description=(
            "Set the transition INTO a clip from the previous clip on its track. "
            "transition: '' (cut) | 'cross' | 'white' (flash) | 'black' (dip). "
            "frames = duration in timeline frames. Duration-preserving (music sync kept)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "clip_id":    {"type": "integer"},
                "transition": {"type": "string", "enum": ["", "cross", "white", "black"]},
                "frames":     {"type": "integer"},
            },
            "required": ["clip_id", "transition"],
        },
    ),
    mcp_types.Tool(
        name="set_audio_fade",
        description="Set fade-in/fade-out on an audio clip (frames at project fps).",
        inputSchema={
            "type": "object",
            "properties": {
                "clip_id":         {"type": "integer"},
                "fade_in_frames":  {"type": "integer"},
                "fade_out_frames": {"type": "integer"},
            },
            "required": ["clip_id"],
        },
    ),
    mcp_types.Tool(
        name="create_generation_job",
        description=(
            "Queue an AI generation job. "
            "job_type: 'generate_image' | 'generate_audio' | 'generate_video_i2v'."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "job_type": {
                    "type": "string",
                    "enum": ["generate_image", "generate_audio", "generate_video_i2v"],
                },
                "params": {"type": "object"},
            },
            "required": ["job_type", "params"],
        },
    ),
    mcp_types.Tool(
        name="trigger_analysis",
        description="Start BPM/beat (audio) or scene/motion (video) analysis for an asset.",
        inputSchema={
            "type": "object",
            "properties": {
                "asset_id":      {"type": "integer"},
                "analysis_type": {"type": "string", "enum": ["audio", "video"]},
            },
            "required": ["asset_id", "analysis_type"],
        },
    ),
] if _MCP_AVAILABLE else []


def _dispatch(name: str, inp: dict, project_id: int) -> dict:
    """Execute a command and return a plain dict result."""
    from app.services import command_api
    session = _get_session_and_init()
    try:
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
            case "auto_cut_to_beats":
                return command_api.auto_cut_to_beats(project_id, inp["clip_id"], session)
            case "add_track":
                return command_api.add_track(
                    project_id, inp["track_type"], inp["name"], session
                )
            case "delete_track":
                return command_api.delete_track(inp["track_id"], session)
            case "add_clip":
                return command_api.add_clip(
                    project_id, inp["track_id"], inp.get("asset_id"),
                    inp["start_frame"], inp["duration_frames"], session,
                )
            case "move_clip":
                return command_api.move_clip(inp["clip_id"], inp["new_start_frame"], session)
            case "delete_clip":
                return command_api.delete_clip(inp["clip_id"], session)
            case "set_transition":
                return command_api.set_transition(
                    inp["clip_id"], inp["transition"], inp.get("frames", 8), session)
            case "set_audio_fade":
                return command_api.set_audio_fade(
                    inp["clip_id"], inp.get("fade_in_frames", 0),
                    inp.get("fade_out_frames", 0), session)
            case "split_clip":
                return command_api.split_clip(inp["clip_id"], inp["split_frame"], session)
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
    finally:
        session.close()


# ── MCP server ────────────────────────────────────────────────────────────────

async def run_mcp_server(project_id: int) -> None:
    if not _MCP_AVAILABLE:
        log.error("Cannot start MCP server: mcp package not installed")
        sys.exit(1)

    server = Server("kychapogas")

    @server.list_tools()
    async def list_tools():
        return MCP_TOOLS

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[mcp_types.TextContent]:
        log.info(f"Tool call: {name} {arguments}")
        result = await asyncio.get_event_loop().run_in_executor(
            None, _dispatch, name, arguments, project_id
        )
        return [mcp_types.TextContent(
            type="text",
            text=json.dumps(result, ensure_ascii=False, indent=2),
        )]

    log.info(f"KyChaPoGaS MCP server starting — project_id={project_id}")
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KyChaPoGaS MCP Server")
    parser.add_argument("--project-id", type=int, default=1,
                        help="Project ID to expose (default: 1)")
    args = parser.parse_args()
    asyncio.run(run_mcp_server(args.project_id))
