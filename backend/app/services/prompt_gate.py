"""H3プロンプトの構造検証（最終関門）。

ジョブ作成のたびに走る。**どのコードパスからでもここを通る**ため、
スクリプトを迂回してAPIへ直接POSTしても検査される。

背景: 憲法(docs/anipafe2026-prompt-constitution.md)と方針書に規則を書き、
lintも作ったのに、投入スクリプトを迂回して手書きJSONをPOSTしたため
検査が一度も走らず、6セクション欠落・BEAT LAW無し・実測打点未使用の
プロンプトが本番同然に流れた(2026-08-24)。指示は迂回できるが、
チョークポイントは迂回できない。

抜け道: params に "skip_validation": true を明示したときだけ通す。
明示はジョブのparamsに残るので、無意識の迂回とは区別できる。
"""
from __future__ import annotations
import re

# 検査対象のプロジェクト。ここを空にすれば全プロジェクトが対象になる。
GATED_PROJECTS = {31}

REF_SECTIONS = ("subject_definitions:", "summary:", "retention_analysis:",
                "detailed_description:", "overall_soundscape:", "non_diegetic_music:")

# 固定語彙(公式)。振幅と速度を伴っているかを見る。
CAMERA_VOCAB = re.compile(
    r"\b(Zoom In|Zoom Out|Push In|Pull Out|Pan|Truck|Tilt|Pedestal Up|Pedestal Down|"
    r"Arc Shot|Tracking Shot|Static Shot|Shake Slightly|Shake Strongly|POV|"
    r"Roll Clockwise|Roll Counterclockwise)\b")
AMPLITUDE = re.compile(r"\b(small|large|very small|very large) amplitude\b")
SPEED = re.compile(r"\b(slow|fast|very slow|very fast) speed\b")

# 品質語(H3は記述された振る舞いに条件付けされる。SDXL系のタグ習慣を持ち込まない)
QUALITY_WORDS = re.compile(
    r"\b(cinematic|masterpiece|best quality|stunning|breathtaking|4k|8k|ultra[- ]?detailed|"
    r"photoreal(istic)?\s+quality)\b", re.I)

# 音の禁止を散文で書かない(公式: 正しいフィールドに肯定形で)
PROSE_AUDIO_BAN = re.compile(r"\bno (background music|music plays|soundtrack)\b", re.I)

# 打点との関係(いずれか1つあれば可)
BEAT_LINK = re.compile(r"BEAT LAW|[Ee]ach (snare|kick|cymbal|drum)|"
                       r"\b(snare|kick|cymbal)s? (trigger|lands?|is|are|bursts?)", re.I)


def _is_ref2va(params: dict) -> bool:
    return str(params.get("model", "")) == "minimax-h3-ref"


def validate_video_prompt(project_id: int, params: dict) -> list[str]:
    """問題があればメッセージのリストを返す。空なら合格。"""
    if GATED_PROJECTS and project_id not in GATED_PROJECTS:
        return []
    if params.get("skip_validation"):
        return []
    model = str(params.get("model", ""))
    if not model.startswith("minimax-h3"):
        return []

    prompt = str(params.get("prompt") or "")
    errs: list[str] = []
    if not prompt.strip():
        return ["prompt が空"]

    # ── 構造 ────────────────────────────────────────────────
    if _is_ref2va(params):
        missing = [s for s in REF_SECTIONS if s not in prompt]
        if missing:
            errs.append(f"Ref2VAの必須セクション欠落: {' '.join(missing)}")
    if "non_diegetic_music:" in prompt and "non_diegetic_music: N/A" not in prompt:
        # N/A以外を書くこと自体は禁じないが、本作は全単位N/Aで運用している
        pass

    # ── 音合わせ ────────────────────────────────────────────
    # 打点ゼロのカット(C1/C4/C65/C66/C67 等)に打点記述を求めるのは誤り。
    # 「この単位に打点が無い」ことを明示していれば免除する。
    silent = re.search(r"打点ゼロ|no drums|drum-?less|SILENT UNIT|"
                       r"there are no drums", prompt, re.I) is not None
    if not silent and not BEAT_LINK.search(prompt):
        errs.append("打点との関係が書かれていない(BEAT LAW / each snare|kick|cymbal のいずれか)。"
                    "打点ゼロの単位なら 'SILENT UNIT: there are no drums in this cut' と明記する")

    # ── カメラ ──────────────────────────────────────────────
    for mm in CAMERA_VOCAB.finditer(prompt):
        seg = prompt[mm.start(): mm.start() + 140]
        if mm.group(1) in ("Static Shot", "POV"):
            continue                      # 静止/視点指定に振幅・速度は不要
        if not AMPLITUDE.search(seg):
            errs.append(f"カメラ '{mm.group(1)}' に振幅(small/large amplitude)が無い")
        if not SPEED.search(seg):
            errs.append(f"カメラ '{mm.group(1)}' に速度(slow/fast speed)が無い")

    # ── 語彙 ────────────────────────────────────────────────
    q = QUALITY_WORDS.search(prompt)
    if q:
        errs.append(f"品質語は使わない: '{q.group(0)}'")
    a = PROSE_AUDIO_BAN.search(prompt)
    if a:
        errs.append(f"音の禁止は散文でなくフィールドで: '{a.group(0)}' → non_diegetic_music: N/A")

    # ── 尺と参照 ────────────────────────────────────────────
    dur = params.get("duration_sec")
    if dur is not None:
        n = int(round(float(dur) * int(params.get("fps") or 24)))
        # h3_snap_length が丸めるので、丸めた先が域内かを見る
        snapped = max(124, min(362, n + (5 - (n % 17)) % 17))
        if not (124 <= snapped <= 362):
            errs.append(f"尺が学習域外: {n}f → {snapped}f (124-362)")
    kf = params.get("keyframes") or []
    if _is_ref2va(params) and len(kf) > 9:
        errs.append(f"Ref2VAの参照が9枚を超えている: {len(kf)}枚")

    return errs
