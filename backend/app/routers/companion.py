"""
Companion chat — talk with the rigged character.

The character replies in-persona (Japanese, concise for speech) and picks a face
expression. The frontend then synthesizes the reply via TTS and drives the
puppet's mouth/expression — so the character literally speaks back.
"""
import json
import re

import anthropic
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import ANTHROPIC_API_KEY, LLM_MODEL

router = APIRouter(prefix="/companion", tags=["companion"])

EXPRESSIONS = ["neutral", "smile", "angry", "surprised"]

PERSONA = """あなたはキャラクター「佐倉杏子」として、ユーザーと会話します。
- 一人称は「あたし」。気が強くてぶっきらぼうだが、根は面倒見がよく優しい。
- 話し言葉で、短く（1〜2文、長くても40字程度）。音声で読み上げられるので簡潔に。
- 絵文字や記号、ナレーション(*...*)、英語は使わない。日本語の話し言葉のみ。
出力は必ず次のJSONのみ:
{"reply": "セリフ", "expression": "neutral|smile|angry|surprised"}
expression はセリフの感情に合うものを選ぶ。"""


class Msg(BaseModel):
    role: str
    content: str


class ChatReq(BaseModel):
    message: str
    history: list[Msg] = []
    puppet_id: str | None = None


class ChatResp(BaseModel):
    reply: str
    expression: str


@router.post("/chat", response_model=ChatResp)
def chat(req: ChatReq):
    if not ANTHROPIC_API_KEY or len(ANTHROPIC_API_KEY) < 20:
        raise HTTPException(status_code=503,
                            detail="ANTHROPIC_API_KEY が未設定です（backend/.env）")
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    messages = [{"role": m.role, "content": m.content} for m in req.history[-10:]]
    messages.append({"role": "user", "content": req.message})
    try:
        resp = client.messages.create(
            model=LLM_MODEL, max_tokens=300,
            system=PERSONA, messages=messages,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM呼び出し失敗: {e}")

    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
    reply, expression = text, "neutral"
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            d = json.loads(m.group(0))
            reply = str(d.get("reply", text)).strip()
            expression = d.get("expression", "neutral")
        except Exception:
            pass
    if expression not in EXPRESSIONS:
        expression = "neutral"
    return ChatResp(reply=reply or "……", expression=expression)
