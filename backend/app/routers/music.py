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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db.database import get_session, engine
from app.models import Project, Asset
from app.models.job import JobRead
from app.routers.generation import _create_job

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


MUSIC_DIRECTOR = """あなたはMAD動画のための音楽ディレクター兼構成作家です。ユーザーと相談しながら
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
