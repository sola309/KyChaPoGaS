"""
/api/music — 音楽スタジオ(MAD選曲のための対話式ワークベンチ).

曲候補は専用プロジェクト「🎵 Music Studio」の generated アセットとして管理する。
提供するもの:
  POST /music/generate           ACE-Stepでバリエーション生成(既存 generate_audio job)
  GET  /music/songs              曲一覧 + 解析結果 + 生成条件
  POST /music/songs/{aid}/analyze  BPM/拍の取りやすさ/エネルギー/セクション解析
  POST /music/songs/{aid}/plan     曲構成→MAD構成案(小節割り+テンプレ提案)
  POST /music/chat               音楽ディレクターAIとの相談(caption/歌詞の提案付き)
"""
from __future__ import annotations

import json
from pathlib import Path

import logging
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db.database import get_session, engine
from app.models import Project, Asset
from app.models.job import JobRead
from app.routers.generation import _create_job

log = logging.getLogger("music")

router = APIRouter(prefix="/music", tags=["music"])

STUDIO_NAME = "🎵 Music Studio"
BACKEND = Path(__file__).resolve().parent.parent.parent
ANALYSIS_DIR = BACKEND / "data" / "music_analysis"


def studio_id(session: Session) -> int:
    p = session.exec(select(Project).where(Project.name == STUDIO_NAME)).first()
    if not p:
        p = Project(name=STUDIO_NAME, fps=60)
        session.add(p); session.commit(); session.refresh(p)
    return p.id


# ── generate ──────────────────────────────────────────────────────────────────

class GenerateRequest(BaseModel):
    caption: str
    lyrics: str = ""
    duration_sec: float = 104.0
    vocal_language: str = "ja"
    instrumental: bool | None = None
    seed: int = -1
    bpm: int | None = None            # ACE-Step 1.5: メタデータでピン留め可
    key: str | None = None            # 例 "C major" / "A minor"
    variants: int = 1                 # シード違いを複数投げる


@router.post("/generate", response_model=list[JobRead], status_code=201)
def generate(req: GenerateRequest, session: Session = Depends(get_session)):
    pid = studio_id(session)
    jobs = []
    base_seed = req.seed if req.seed >= 0 else 10007
    for i in range(max(1, min(req.variants, 4))):
        params = {"project_id": pid,
                  "prompt": req.caption, "lyrics": req.lyrics,
                  "duration_sec": req.duration_sec, "vocal_language": req.vocal_language,
                  "instrumental": req.instrumental, "seed": base_seed + i * 111}
        if req.bpm:
            params["bpm"] = req.bpm
        if req.key:
            params["key"] = req.key
        jobs.append(_create_job(session, pid, "generate_audio", params))
    return jobs


# ── songs list ────────────────────────────────────────────────────────────────

@router.get("/songs")
def songs(session: Session = Depends(get_session)):
    pid = studio_id(session)
    assets = session.exec(select(Asset).where(Asset.project_id == pid)
                          .order_by(Asset.id.desc())).all()
    out = []
    for a in assets:
        if not (a.file_path or "").endswith((".wav", ".mp3", ".flac")):
            continue
        d = {"id": a.id, "name": a.name, "duration_sec": a.duration_sec,
             "created_at": a.created_at.isoformat(timespec="seconds") if a.created_at else None}
        # 歌詞・生成条件(議論用にUIへ)
        try:
            gp = json.loads(a.gen_params_json or "{}")
            d["lyrics"] = gp.get("lyrics") or ""
            d["caption"] = gp.get("prompt") or ""
            d["bpm"] = gp.get("bpm"); d["key"] = gp.get("key"); d["seed"] = gp.get("seed")
        except Exception:
            d["lyrics"] = ""; d["caption"] = "" 
        ap = ANALYSIS_DIR / f"{a.id}.json"
        d["analysis"] = json.loads(ap.read_text()) if ap.exists() else None
        out.append(d)
    return {"project_id": pid, "songs": out}


# ── analyze: 音の取りやすさ(音ハメ適性)を数値化 ─────────────────────────────

@router.post("/songs/{aid}/analyze")
def analyze(aid: int, session: Session = Depends(get_session)):
    a = session.get(Asset, aid)
    if not a or not Path(a.file_path).exists():
        raise HTTPException(404, "asset not found")
    import numpy as np
    import librosa
    y, sr = librosa.load(a.file_path, sr=22050, mono=True)
    dur = len(y) / sr
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, trim=False, units="time")
    tempo = float(np.atleast_1d(tempo)[0])
    ibi = np.diff(beats)
    cv = float(np.std(ibi) / np.mean(ibi)) if len(ibi) > 2 else 1.0
    onset = librosa.onset.onset_strength(y=y, sr=sr)
    ot = librosa.frames_to_time(np.arange(len(onset)), sr=sr)
    punch = float(np.interp(beats, ot, onset).mean() / (onset.mean() + 1e-9)) if len(beats) else 0.0
    rms = librosa.feature.rms(y=y)[0]
    contrast = float(np.percentile(rms, 90) / (np.median(rms) + 1e-9))
    # sections
    S = np.abs(librosa.stft(y)) ** 2
    chroma = librosa.feature.chroma_stft(S=S, sr=sr)
    n_seg = max(4, min(10, int(dur // 12)))
    bounds = librosa.frames_to_time(librosa.segment.agglomerative(chroma, n_seg), sr=sr)
    # energy per section (盛り上がりマップ)
    rt = librosa.frames_to_time(np.arange(len(rms)), sr=sr)
    secs = []
    bl = list(bounds) + [dur]
    rmax = rms.max() + 1e-9
    for i in range(len(bl) - 1):
        sel = (rt >= bl[i]) & (rt < bl[i + 1])
        secs.append({"t0": round(float(bl[i]), 1), "t1": round(float(bl[i + 1]), 1),
                     "energy": round(float(rms[sel].mean() / rmax), 2) if sel.any() else 0})
    # 音の取りやすさ: ビートの明瞭さ(punch)と安定性(cv)の合成 0-100
    toriyasusa = round(100 * (min(punch / 4.5, 1.0) * 0.6 + max(0.0, 1 - cv * 8) * 0.4))
    result = {"bpm": round(tempo, 1), "duration_sec": round(dur, 1),
              "beat_stability_cv": round(cv, 3), "punch": round(punch, 2),
              "energy_contrast": round(contrast, 2), "toriyasusa": toriyasusa,
              "sections": secs}
    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
    (ANALYSIS_DIR / f"{aid}.json").write_text(json.dumps(result, ensure_ascii=False))
    return result


# ── plan: 曲 → MAD構成案 ─────────────────────────────────────────────────────

@router.post("/songs/{aid}/plan")
def plan(aid: int, session: Session = Depends(get_session)):
    ap = ANALYSIS_DIR / f"{aid}.json"
    if not ap.exists():
        analyze(aid, session)
    an = json.loads(ap.read_text())
    bar = 60.0 / an["bpm"] * 4
    lines = [f"曲: BPM {an['bpm']} / {an['duration_sec']}s / 1小節≈{bar:.2f}s / 音の取りやすさ {an['toriyasusa']}/100", ""]
    for s in an["sections"]:
        bars = round((s["t1"] - s["t0"]) / bar)
        lines.append(f"- {s['t0']:.0f}–{s['t1']:.0f}s ({bars}小節) energy={s['energy']}")
    stats = "\n".join(lines)
    from app.services.llm_provider import chat, available_providers
    provider = "anthropic" if "anthropic" in available_providers() else "local"
    sys_p = ("あなたはMAD動画の演出プランナーです。曲の構造情報から、MADの大まかな構成案を日本語のMarkdownで提案します。"
             "各区間に: 時間範囲/小節数/内容(例: MGイントロ、キャラ紹介ショーケース、サビのピークMG、ブレイクの静パート、ラストのラインナップ)/"
             "使えるテンプレ名(mg_intro, title_card, showcase_pattern, showcase_card, showcase_fullbleed, panels_strip, bands_repeat, "
             "cv_card, rapid_cuts, riser, mg_peak, profile_card, breakdown_pan, finale_cuts, lineup, outro_credits)と"
             "モーションの見せ場を1行ずつ。energyが高い区間を盛り上げに割り当てること。簡潔に。")
    try:
        md = chat([{"role": "user", "content": stats + "\n\n構成案:"}], system=sys_p,
                  max_tokens=1500, provider=provider, temperature=0.4)
    except Exception:
        md = "(LLM不応答のため統計のみ)\n\n" + stats
    return {"stats": stats, "plan_md": md}


# ── chat: 音楽ディレクター ───────────────────────────────────────────────────

class MusicChatRequest(BaseModel):
    messages: list[dict]


MUSIC_DIRECTOR = """
【絵コンテ】各sectionは cuts: [{who,action,emotion,framing,status}] を持てる。映像の議論では「章の意味→キャラの瞬間(cuts)」の順で具体化し、framingはアップ/バストアップ/全身/引き/後ろ姿/手元から選ぶ。

【作詞規範(必須)】歌詞はメロディの設計図。以下を守る:
- フレーズは半角スペースで区切り、Aメロ5-7/プレ7-5/サビ8-8を基本形に
- 対になる行はモーラ数を±1で揃える(1番2番も同じ)
- サビ頭はあ段で立ち上げ、行末は伸ばせる母音(あ/お/え段・長音)
- う段・促音「っ」を強拍やロングトーン位置に置かない
- 読みが揺れる漢字はひらがなに開く(運命→さだめ 等)
- 完成後は POST /music/lyrics/check で必ず検査(score 85+を出荷基準に)
あなたはMAD動画のための音楽ディレクター兼構成作家です。ユーザーと相談しながら
**まず構成(セクション割り・各部の役割・盛り上がり曲線)を固め**、その上で歌詞やスタイルを詰めます。
観点: 音ハメしやすさ(はっきりしたキック、明確なサビ頭、ブレイクの有無)、MADの映像構成との対応。
構成が動いたら、毎回**構成シート全体**を次の形式で返答の最後に付けること:
```comp
{"title":"...","concept":"英語のスタイル記述","bpm_target":120,
 "sections":[{"tag":"[verse]","name":"Aメロ","bars":8,"energy":0.4,"mood":"...","visual":"映像の意図","lyrics":"歌詞(あれば)"}]}
```
生成に進める段階では ```song ブロック({"caption","lyrics","bpm","duration_sec"})も付ける。
日本語で簡潔に話すこと。"""


@router.post("/chat")
def music_chat(req: MusicChatRequest):
    from app.services.llm_provider import chat, available_providers
    provider = "anthropic" if "anthropic" in available_providers() else "local"
    reply = chat(req.messages, system=MUSIC_DIRECTOR, max_tokens=2000,
                 provider=provider, temperature=0.6)
    def _block(kind):
        if f"```{kind}" not in reply:
            return None
        try:
            frag = reply.split(f"```{kind}")[1].split("```")[0]
            return json.loads(frag[frag.find("{"): frag.rfind("}") + 1])
        except Exception:
            return None
    return {"reply": reply, "proposal": _block("song"), "sheet": _block("comp"),
            "engine": provider}


# ── 構成シート(composition sheet): 曲と映像の上流にある共有文書 ──────────────
#
# sheet = {"format_version":1, "title", "concept", "bpm_target",
#          "sections":[{"tag":"[verse]","name":"Aメロ","bars":8,"energy":0.4,
#                       "mood":"...","visual":"...","lyrics":"..."}]}
# 構成→歌詞/captionの導出、生成曲とのズレ検証、shotlist雛形化を提供する。

COMP_DIR = BACKEND / "data" / "music_compositions"


class Sheet(BaseModel):
    format_version: int = 1
    title: str = ""
    concept: str = ""
    bpm_target: int | None = None
    sections: list[dict] = []


@router.get("/compositions")
def list_compositions():
    COMP_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(COMP_DIR.glob("*.json")):
        d = json.loads(f.read_text())
        out.append({"id": f.stem, "title": d.get("title", f.stem),
                    "sections": len(d.get("sections", []))})
    return out


@router.get("/compositions/{cid}")
def get_composition(cid: str):
    f = COMP_DIR / f"{cid}.json"
    if not f.exists():
        raise HTTPException(404, "composition not found")
    return json.loads(f.read_text())


@router.put("/compositions/{cid}")
def put_composition(cid: str, sheet: Sheet):
    from app.routers.mad import _snapshot
    COMP_DIR.mkdir(parents=True, exist_ok=True)
    path = COMP_DIR / f"{cid}.json"
    _snapshot(path)
    path.write_text(json.dumps(sheet.model_dump(), ensure_ascii=False, indent=1))
    return {"ok": True}


@router.post("/compositions/{cid}/undo")
def undo_composition(cid: str):
    from app.routers.mad import _undo_file
    path = COMP_DIR / f"{cid}.json"
    if not _undo_file(path):
        raise HTTPException(404, "履歴がありません")
    return json.loads(path.read_text())


def _sheet_duration(sheet: dict) -> tuple[float, float]:
    bpm = sheet.get("bpm_target") or 120
    bar = 60.0 / bpm * 4
    total = sum(int(s.get("bars", 8)) for s in sheet.get("sections", [])) * bar
    return bar, total


@router.post("/compositions/{cid}/derive")
def derive(cid: str):
    """構成シート → 生成フォーム(caption / 構造タグ付き歌詞 / BPM / 長さ)。"""
    sheet = get_composition(cid)
    bar, total = _sheet_duration(sheet)
    parts = []
    for sec in sheet.get("sections", []):
        tag = sec.get("tag") or "[verse]"
        body = (sec.get("lyrics") or "").strip()
        parts.append(f"{tag}\n{body}" if body else tag)
    lyrics = "\n\n".join(parts)
    moods = ", ".join(dict.fromkeys(
        m for s in sheet.get("sections", []) if (m := s.get("mood", "").strip())))
    caption = sheet.get("concept", "")
    if moods:
        caption = f"{caption}, {moods}" if caption else moods
    return {"caption": caption, "lyrics": lyrics,
            "bpm": sheet.get("bpm_target"),
            "duration_sec": round(min(max(total, 30), 240), 1),
            "bar_sec": round(bar, 3)}


@router.post("/compositions/{cid}/verify/{aid}")
def verify(cid: str, aid: int, session: Session = Depends(get_session)):
    """生成曲が構成シートの意図(盛り上がり位置)に合っているかを検証。"""
    sheet = get_composition(cid)
    ap = ANALYSIS_DIR / f"{aid}.json"
    if not ap.exists():
        analyze(aid, session)
    an = json.loads(ap.read_text())
    bar = 60.0 / an["bpm"] * 4
    # シート上の各セクションの想定時間範囲(実測BPMで換算)と実測energyを突き合わせ
    t = 0.0
    rows, gaps = [], 0
    import numpy as np
    for sec in sheet.get("sections", []):
        dur = int(sec.get("bars", 8)) * bar
        t0, t1 = t, t + dur
        # 実測: この範囲に重なるsectionsのenergy加重平均
        es, ws = [], []
        for m in an["sections"]:
            ov = max(0.0, min(t1, m["t1"]) - max(t0, m["t0"]))
            if ov > 0:
                es.append(m["energy"]); ws.append(ov)
        measured = round(float(np.average(es, weights=ws)), 2) if es else None
        want = sec.get("energy")
        ok = (measured is None or want is None or abs(measured - float(want)) <= 0.25)
        if not ok:
            gaps += 1
        rows.append({"name": sec.get("name"), "t0": round(t0, 1), "t1": round(t1, 1),
                     "want_energy": want, "measured_energy": measured, "ok": ok})
        t = t1
    return {"bpm_measured": an["bpm"], "duration_measured": an["duration_sec"],
            "duration_planned": round(t, 1), "mismatches": gaps, "sections": rows,
            "hint": "ズレが大きい区間は Repaint(部分再生成)か構成シート側の調整を検討"}


@router.post("/compositions/{cid}/to_shotlist/{aid}")
def to_shotlist(cid: str, aid: int, session: Session = Depends(get_session)):
    """構成シート+実測ビートから mad-kit shotlist の雛形を生成して返す(保存はしない)。"""
    sheet = get_composition(cid)
    a = session.get(Asset, aid)
    if not a:
        raise HTTPException(404, "asset not found")
    ap = ANALYSIS_DIR / f"{aid}.json"
    if not ap.exists():
        analyze(aid, session)
    an = json.loads(ap.read_text())
    bar = 60.0 / an["bpm"] * 4
    # energy→テンプレ候補の対応(構成力の既定値)
    def tpl_for(sec, i, n):
        e = float(sec.get("energy") or 0.5)
        tag = (sec.get("tag") or "").lower()
        if i == 0:
            return "mg_intro"
        if i == n - 1:
            return "outro_credits"
        if "chorus" in tag and e >= 0.7:
            return "mg_peak"
        if e >= 0.75:
            return "finale_cuts"
        if e <= 0.35:
            return "breakdown_pan"
        return "showcase_pattern"
    shots, b = [], 0
    secs = sheet.get("sections", [])
    for i, sec in enumerate(secs):
        bars = int(sec.get("bars", 8))
        shots.append({"id": f"s{i:02d}_{(sec.get('name') or 'sec').replace(' ', '')[:8]}",
                      "template": tpl_for(sec, i, len(secs)),
                      "from": f"db:{b}", "to": f"db:{b + bars}",
                      "params": {"_note": f"{sec.get('name')} / {sec.get('mood', '')} / 映像意図: {sec.get('visual', '')}"}})
        b += bars
    return {"meta": {"title": sheet.get("title", cid), "music": f"asset:{aid}",
                     "end_sec": an["duration_sec"]},
            "shots": shots,
            "note": "雛形です。paramsは各テンプレのREADME仕様に沿って肉付けしてください(AI/手動)。"}


class RepaintRequest(BaseModel):
    start_sec: float
    end_sec: float
    caption: str
    lyrics: str = ""
    seed: int = -1
    variants: int = 1


class CoverRequest(BaseModel):
    lyrics: str
    caption: str = ""
    vocal_language: str = "ja"
    seed: int = -1
    variants: int = 1


@router.post("/songs/{aid}/cover", response_model=list[JobRead], status_code=201)
def cover(aid: int, req: CoverRequest, session: Session = Depends(get_session)):
    """Cover: 原盤の旋律・アレンジを保ったまま歌詞を差し替えて歌い直す。
    「先に旋律を確定→歌詞を当て書き」ワークフローの実行部。"""
    pid = studio_id(session)
    jobs = []
    base_seed = req.seed if req.seed >= 0 else 50021
    for i in range(max(1, min(req.variants, 4))):
        jobs.append(_create_job(session, pid, "generate_audio", {
            "project_id": pid,
            "cover_src_asset": aid,
            "lyrics": req.lyrics,
            "prompt": req.caption,
            "vocal_language": req.vocal_language,
            "seed": base_seed + i * 111,
        }))
    return jobs


@router.post("/songs/{aid}/repaint", response_model=list[JobRead], status_code=201)
def repaint(aid: int, req: RepaintRequest, session: Session = Depends(get_session)):
    """区間Repaint: 声・音色の文脈を保ったまま[start,end]だけ描き直す(ACE-Step 1.5)。
    転調・ジャンル豹変を「一体の楽曲のまま」作る、AI音楽ならではの編集。"""
    pid = studio_id(session)
    jobs = []
    base_seed = req.seed if req.seed >= 0 else 30011
    for i in range(max(1, min(req.variants, 4))):
        jobs.append(_create_job(session, pid, "generate_audio", {
            "project_id": pid, "prompt": req.caption, "lyrics": req.lyrics,
            "vocal_language": "ja", "seed": base_seed + i * 111,
            "repaint_src_asset": aid, "repaint_start": req.start_sec, "repaint_end": req.end_sec,
        }))
    return jobs


class LyricsCheckRequest(BaseModel):
    lyrics: str


@router.post("/lyrics/check")
def lyrics_check(req: LyricsCheckRequest):
    """作詞リンター: モーラ設計(譜割り)の検査。メロディに乗らない歌詞を事前に潰す。"""
    from app.services.lyric_craft import check as _check
    return _check(req.lyrics)


@router.post("/songs/{aid}/adherence")
async def adherence(aid: int, session: Session = Depends(get_session)):
    """歌唱一致チェック: Whisperで書き起こし→歌詞と照合。
    勝手な反復・行の脱落(ACE-Stepの癖)を機械検出する。"""
    import httpx
    import re as _re
    from app import config
    asset = session.get(Asset, aid)
    if not asset:
        raise HTTPException(status_code=404, detail="song not found")
    lyrics = ""
    try:
        lyrics = json.loads(asset.gen_params_json or "{}").get("lyrics") or ""
    except Exception:
        pass
    if not lyrics:
        raise HTTPException(status_code=400, detail="この曲には歌詞がありません")

    # 1) ボーカルステム分離(伴奏を除去 — 轟音区間でもASRが読める)
    import subprocess, tempfile
    from app.services.ffmpeg_render import FFMPEG
    import shutil as _sh
    stem_py = Path(__file__).resolve().parents[3] / "tools" / "stem-kit" / ".venv" / "bin" / "python"
    vocal_path = asset.file_path
    tmpdir = tempfile.mkdtemp(prefix="adh_")
    try:
        if stem_py.exists():
            # 注意: `python -m demucs` はtorchaudio保存がtorchcodec必須で死ぬ。
            # soundfileで保存する separate.py 経由でボーカルステムを得る。
            sep = stem_py.parent.parent.parent / "separate.py"
            r0 = subprocess.run([str(stem_py), str(sep), asset.file_path,
                                 "--stems-out", tmpdir],
                                capture_output=True, text=True, timeout=900)
            cand = Path(tmpdir) / "vocals.wav"
            if cand.exists():
                vocal_path = str(cand)
            else:
                log.warning(f"vocal stem separation failed: {r0.stdout[-300:]} {r0.stderr[-300:]}")
    except Exception as e:
        log.warning(f"vocal stem separation error: {e}")
    # 2) whisperは~30秒窓しか見ないため、25秒チャンクで全曲を書き起こす
    dur = float(asset.duration_sec or 180)
    parts = []
    async with httpx.AsyncClient(timeout=600) as c:
        t0 = 0.0
        while t0 < dur:
            with tempfile.NamedTemporaryFile(suffix=".wav") as tf:
                subprocess.run([str(FFMPEG), "-y", "-ss", str(t0), "-t", "25",
                                "-i", vocal_path, "-ar", "16000", "-ac", "1", tf.name],
                               capture_output=True)
                chunk = Path(tf.name).read_bytes()
            if len(chunk) > 8000:
                r = await c.post(f"{config.ASR_API_URL}/transcribe",
                                 files={"file": ("c.wav", chunk, "audio/wav")},
                                 data={"language": "ja"})
                if r.status_code == 200:
                    parts.append(r.json().get("text", ""))
            t0 += 23.0
    transcript = " ".join(parts)
    _sh.rmtree(tmpdir, ignore_errors=True)

    def norm(t: str) -> str:
        t = _re.sub(r"\[[^\]]*\]|\([^)]*\)", "", t)      # タグ/括弧BGV除去
        return _re.sub(r"[^ぁ-ゖァ-ヺー一-鿿a-zA-Z0-9]", "", t)

    from difflib import SequenceMatcher
    tr_n = norm(transcript)
    lines = [l.strip() for l in lyrics.splitlines()
             if l.strip() and not l.strip().startswith("[")]
    # 歌詞に同じ行が複数回書かれている場合(意図した反復)は期待回数と比較する
    from collections import Counter
    expected = Counter(norm(l) for l in lines if len(norm(l)) >= 4)
    report = []
    seen: set = set()
    for line in lines:
        ln = norm(line)
        if len(ln) < 4 or ln in seen:
            continue
        seen.add(ln)
        w = len(ln)
        hits = 0
        i = 0
        while i <= max(0, len(tr_n) - w // 2):
            seg = tr_n[i:i + w + 2]
            if SequenceMatcher(None, ln, seg).ratio() >= 0.62:
                hits += 1
                i += w
            else:
                i += max(2, w // 4)
        exp = expected[ln]
        if hits == 0:
            status = "missing"
        elif hits <= exp:
            status = "ok" if hits == exp else f"ok({hits}/{exp})"
        else:
            status = f"repeated x{hits}(期待{exp})"
        report.append({"line": line, "status": status, "expected": exp, "hits": hits})
    n_ok = sum(1 for r0 in report if r0["status"].startswith("ok"))
    n_rep = sum(1 for r0 in report if r0["status"].startswith("repeated"))
    n_miss = sum(1 for r0 in report if r0["status"] == "missing")
    score = int(100 * n_ok / max(1, len(report))) - n_rep * 5
    return {"score": max(0, score), "ok": n_ok, "repeated": n_rep, "missing": n_miss,
            "lines": report, "transcript": transcript}


def _mora_count(text: str) -> int:
    from app.services.lyric_craft import mora_split, to_hira
    try:
        return len(mora_split(to_hira(text)))
    except Exception:
        return len([c for c in text if c.strip()])


@router.post("/songs/{aid}/phrase-map")
def phrase_map(aid: int, session: Session = Depends(get_session)):
    """譜割り抽出: ボーカルステム→ASR(タイムスタンプ付き)でフレーズ境界と
    実際に歌われた音数(モーラ)を取得する。当て書きワークフローの計測部。
    出力: [{t0, t1, dur, text, mora}] — 歌詞の各行をmoraに合わせて調整→cover。"""
    import subprocess
    import tempfile
    import httpx as _hx

    asset = session.get(Asset, aid)
    if not asset:
        raise HTTPException(404, "asset not found")
    stem_py = Path(__file__).resolve().parents[3] / "tools" / "stem-kit" / ".venv" / "bin" / "python"
    sep = stem_py.parent.parent.parent / "separate.py"
    phrases = []
    with tempfile.TemporaryDirectory(prefix="phrasemap_") as td:
        r = subprocess.run([str(stem_py), str(sep), asset.file_path, "--stems-out", td],
                           capture_output=True, text=True, timeout=900)
        vocal = Path(td) / "vocals.wav"
        if not vocal.exists():
            raise HTTPException(500, f"vocal separation failed: {r.stderr[-200:]}")
        # 25秒チャンクでASR(whisperの窓制限) — セグメントにチャンクオフセットを加算
        dur = float(asset.duration_sec or 180)
        import math
        n_chunks = math.ceil(dur / 25)
        for ci in range(n_chunks):
            t_off = ci * 25
            chunk = Path(td) / f"chunk{ci}.wav"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(t_off), "-t", "25",
                            "-i", str(vocal), str(chunk)], check=True, timeout=60)
            with open(chunk, "rb") as f:
                resp = _hx.post("http://localhost:8089/transcribe",
                                files={"file": ("c.wav", f, "audio/wav")},
                                data={"language": "ja", "timestamps": "1"},
                                timeout=300)
            for seg in resp.json().get("segments", []):
                if not seg.get("text"):
                    continue
                t0 = seg["t0"] + t_off
                t1 = (seg["t1"] if seg["t1"] is not None else seg["t0"] + 2) + t_off
                phrases.append({"t0": round(t0, 2), "t1": round(t1, 2),
                                "dur": round(t1 - t0, 2), "text": seg["text"],
                                "mora": _mora_count(seg["text"])})
    return {"phrases": phrases, "count": len(phrases),
            "hint": "歌詞の各行を対応フレーズのmoraに合わせて調整→ POST /songs/{aid}/cover"}
