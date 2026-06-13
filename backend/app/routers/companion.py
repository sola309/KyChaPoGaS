"""
Companion chat — talk with the rigged character.

The character replies in-persona (Japanese, concise for speech) and picks a face
expression. The frontend then synthesizes the reply via TTS and drives the
puppet's mouth/expression — so the character literally speaks back.
"""
import json
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import llm_provider

router = APIRouter(prefix="/companion", tags=["companion"])

EXPRESSIONS = ["neutral", "smile", "angry", "surprised"]

PERSONA = """あなたはキャラクター「佐倉杏子」として、ユーザーと会話します。
- 一人称は「あたし」。気が強くてぶっきらぼうだが、根は面倒見がよく優しい。
- 話し言葉で、短く（1〜2文、長くても40字程度）。音声で読み上げられるので簡潔に。
- 絵文字や記号、ナレーション(*...*)、英語は使わない。日本語の話し言葉のみ。
- セリフの最後に半角の縦棒で感情を1語だけ付ける（neutral/smile/angry/surprised）。
例:
へえ、いい度胸じゃん|smile
うるさいな、あたしに構うなよ|angry"""

_EXPR_MAP = {
    "smile": "smile", "笑顔": "smile", "happy": "smile", "うれしい": "smile",
    "angry": "angry", "怒り": "angry", "怒": "angry",
    "surprised": "surprised", "驚き": "surprised", "びっくり": "surprised",
    "neutral": "neutral", "通常": "neutral",
}


def _parse(text: str) -> tuple[str, str]:
    """Extract (reply, expression) from a small model's loose output:
    JSON, 'text|expr', 'text [expr]', or a trailing keyword."""
    text = text.strip()
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            d = json.loads(m.group(0))
            return str(d.get("reply", "")).strip(), _EXPR_MAP.get(str(d.get("expression", "")).lower(), "neutral")
        except Exception:
            pass
    # trailing |expr or [expr]
    m = re.search(r"[|｜\[]\s*([A-Za-z぀-ヿ一-鿿]+)\s*\]?\s*$", text)
    expr = "neutral"
    if m:
        cand = _EXPR_MAP.get(m.group(1).lower())
        if cand:
            expr = cand
            text = text[:m.start()].strip()
    return text, expr


class Msg(BaseModel):
    role: str
    content: str


class ChatReq(BaseModel):
    message: str
    history: list[Msg] = []
    puppet_id: str | None = None
    provider: str = "auto"   # auto|anthropic|openai|gemini|local


class ChatResp(BaseModel):
    reply: str
    expression: str
    provider: str


@router.get("/providers")
def providers():
    """利用可能なLLMプロバイダ（設定UI/状態表示用）。"""
    return {"available": llm_provider.available_providers(),
            "selected": llm_provider.resolve("auto")}


@router.post("/chat", response_model=ChatResp)
def chat(req: ChatReq):
    prov = llm_provider.resolve(req.provider)
    if not llm_provider.available_providers():
        raise HTTPException(status_code=503,
                            detail="利用可能なLLMがありません（ローカルLLM未起動 or APIキー未設定）")
    messages = [{"role": m.role, "content": m.content} for m in req.history[-10:]]
    messages.append({"role": "user", "content": req.message})
    try:
        text = llm_provider.chat(messages, system=PERSONA, max_tokens=300, provider=req.provider).strip()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM呼び出し失敗: {e}")

    reply, expression = _parse(text)
    if expression not in EXPRESSIONS:
        expression = "neutral"
    return ChatResp(reply=reply or "……", expression=expression, provider=prov)
