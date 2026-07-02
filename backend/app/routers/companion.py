"""
Companion chat — talk with the rigged character.

The character replies in-persona (Japanese, concise for speech) and picks a face
expression. The frontend then synthesizes the reply via TTS and drives the
puppet's mouth/expression — so the character literally speaks back.
"""
import json
import re

import httpx
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from app import config
from app.services import llm_provider

router = APIRouter(prefix="/companion", tags=["companion"])

EXPRESSIONS = ["neutral", "smile", "angry", "surprised", "sad", "smug", "shy"]

PERSONA = """あなたはキャラクター「佐倉杏子」として、ユーザーと会話します。
- 一人称は「あたし」。気が強くてぶっきらぼうだが、根は面倒見がよく優しい。
- 話し言葉で、短く（1〜2文、長くても40字程度）。音声で読み上げられるので簡潔に。
- 絵文字や記号、ナレーション(*...*)、英語は使わない。日本語の話し言葉のみ。
- 「杏子：」のような話者名やラベルは付けず、セリフ本体だけを書く。
- セリフの最後に半角の縦棒で感情を1語だけ付ける。
  感情は neutral/smile/angry/surprised/sad/smug/shy のいずれか
  （sad=しんみり・残念, smug=得意げ・からかい, shy=照れ・気恥ずかしい）。
例:
へえ、いい度胸じゃん|smile
うるさいな、あたしに構うなよ|angry
ふん、あたしにかかればこんなもんよ|smug
べ、別にあんたのためじゃないからな|shy"""

ENGLISH_TUTOR_PERSONA = """あなたはキャラクター「佐倉杏子」として、ユーザーに英会話を教える先生です。
- 一人称は「あたし」。気が強くぶっきらぼうだが面倒見がよく、生徒をやる気にさせる。
- 説明・励まし・添削は【日本語】の話し言葉で短く。教える英語フレーズや例文だけ【英語】で書く。
  （日本語はキャラ声・英語はネイティブ音声で自動で読み分けられる。）
- 1回の返答は「日本語の短い説明 ＋ 覚える英語フレーズ1つ」を基本に。長くしない（音声で読まれる）。
- 英語フレーズは簡単で実用的に。ときどき「リピートして」と促す。
- 生徒が英語を話したら、まず良い点を褒め、間違いは日本語でやさしく指摘し、正しい英語をもう一度短く示す。
- 絵文字・記号・ナレーション(*...*)・話者名ラベルは使わない。
- セリフの最後に半角の縦棒で感情を1語: neutral/smile/angry/surprised/sad/smug/shy。
例:
よし、まずは挨拶からだ。How's it going? って言ってみな|smile
おう、いい発音だ。次はこれ。Nice to meet you.|smug
惜しい、惜しい。もう一回ゆっくり。Thank you very much.|neutral"""

_EXPR_MAP = {
    "smile": "smile", "笑顔": "smile", "happy": "smile", "うれしい": "smile",
    "angry": "angry", "怒り": "angry", "怒": "angry",
    "surprised": "surprised", "驚き": "surprised", "びっくり": "surprised",
    "sad": "sad", "悲しい": "sad", "しんみり": "sad", "残念": "sad",
    "smug": "smug", "ドヤ": "smug", "得意": "smug", "からかい": "smug",
    "shy": "shy", "照れ": "shy", "照": "shy", "恥": "shy",
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
    mode: str = "companion"  # companion|english_tutor


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
        system = ENGLISH_TUTOR_PERSONA if req.mode == "english_tutor" else PERSONA
        text = llm_provider.chat(messages, system=system, max_tokens=300, provider=req.provider).strip()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM呼び出し失敗: {e}")

    reply, expression = _parse(text)
    if expression not in EXPRESSIONS:
        expression = "neutral"
    return ChatResp(reply=reply or "……", expression=expression, provider=prov)


@router.get("/asr/status")
async def asr_status():
    """音声入力(ASR)サーバの稼働状態。"""
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(f"{config.ASR_API_URL}/health")
            return {"available": r.status_code == 200, **(r.json() if r.status_code == 200 else {})}
    except Exception:
        return {"available": False}


@router.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str = Form("ja")):
    """マイク録音(音声) → テキスト。ASRサーバ(Whisper)へ中継。"""
    raw = await file.read()
    try:
        async with httpx.AsyncClient(timeout=60.0) as c:
            r = await c.post(
                f"{config.ASR_API_URL}/transcribe",
                files={"file": (file.filename or "audio.webm", raw, file.content_type or "application/octet-stream")},
                data={"language": language},
            )
            r.raise_for_status()
            return r.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"ASR失敗: {e.response.text[:200]}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ASRサーバ未起動の可能性: {e}")
