"""
Audio analysis — BPM, beat detection, downbeat detection.

Primary engine: beat_this (CPJKU transformer, ISMIR 2024) — learned beat+downbeat
tracking, GPU-accelerated. Fallback: librosa beat_track (torch-free環境用).

Returns plain dicts so results can be stored as JSON.
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Any

log = logging.getLogger("audio_analyzer")

_f2b = None  # File2Beats singleton (model load is seconds — keep resident)

_SF_DECODABLE = {".wav", ".flac", ".ogg", ".aiff", ".aif"}


def _to_decodable_wav(file_path: Path) -> tuple[Path, tempfile.TemporaryDirectory | None]:
    """soundfileで読めない形式(mp3/m4a/mp4等)はffmpegでwavへ変換して返す。"""
    if file_path.suffix.lower() in _SF_DECODABLE:
        return file_path, None
    tmp = tempfile.TemporaryDirectory(prefix="beatana_")
    wav = Path(tmp.name) / "audio.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(file_path),
         "-vn", "-acodec", "pcm_s16le", "-ar", "44100", str(wav)],
        check=True, capture_output=True,
    )
    return wav, tmp


def _tempo_label(bpm: float) -> str:
    if bpm < 60:
        return f"遅い ({bpm:.0f} BPM)"
    if bpm < 100:
        return f"普通 ({bpm:.0f} BPM)"
    if bpm < 140:
        return f"速い ({bpm:.0f} BPM)"
    return f"非常に速い ({bpm:.0f} BPM)"


def _analyze_beat_this(file_path: Path) -> dict[str, Any]:
    import numpy as np
    import soundfile as sf
    import torch  # noqa: PLC0415 — lazy import (heavy)
    from beat_this.inference import File2Beats  # noqa: PLC0415

    global _f2b
    if _f2b is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _f2b = File2Beats(checkpoint_path="final0", device=device, dbn=False)

    wav, tmp = _to_decodable_wav(file_path)
    try:
        beats, downbeats = _f2b(str(wav))
        total_sec = float(sf.info(str(wav)).duration)
    finally:
        if tmp is not None:
            tmp.cleanup()

    beats = np.asarray(beats, dtype=float)
    downbeats = np.asarray(downbeats, dtype=float)
    if len(beats) < 4:
        raise RuntimeError(f"beat_this found only {len(beats)} beats")

    ibi = np.diff(beats)
    bpm = float(60.0 / np.median(ibi))
    # グリッドの安定度(中央値IBIからの平均相対ずれ)。AI生成曲などテンポが
    # 揺れる曲の検知用 — 大きい場合はdbn=True再解析やビート単位運用を検討。
    regularity = float(np.mean(np.abs(ibi - np.median(ibi))) / np.median(ibi))

    return {
        "bpm": round(bpm, 2),
        "beats": [round(float(t), 4) for t in beats],
        "downbeats": [round(float(t), 4) for t in downbeats],
        "duration_sec": round(total_sec, 3),
        "tempo_label": _tempo_label(bpm),
        "engine": "beat_this",
        "ibi_irregularity": round(regularity, 4),
    }


def _analyze_librosa(file_path: Path) -> dict[str, Any]:
    import librosa  # noqa: PLC0415 — lazy import (heavy)
    import numpy as np

    size_mb = file_path.stat().st_size / (1024 * 1024)
    duration = None if size_mb < 10 else 300.0

    y, sr = librosa.load(str(file_path), mono=True, duration=duration)
    total_sec = float(librosa.get_duration(y=y, sr=sr))

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    bpm = float(np.atleast_1d(tempo)[0])

    return {
        "bpm": round(bpm, 2),
        "beats": [round(t, 4) for t in beat_times],
        "downbeats": [round(t, 4) for t in beat_times[::4]],  # heuristic
        "duration_sec": round(total_sec, 3),
        "tempo_label": _tempo_label(bpm),
        "engine": "librosa",
    }


def analyze_beats(file_path: Path) -> dict[str, Any]:
    """
    Analyse an audio/video file for tempo and beat positions.

    Returns:
        {
            "bpm": float,
            "beats": [float, ...],        # beat times in seconds
            "downbeats": [float, ...],    # downbeat (bar-start) times
            "duration_sec": float,
            "tempo_label": str,           # e.g. "速い (140 BPM)"
            "engine": "beat_this" | "librosa",
            "ibi_irregularity": float,    # beat_thisのみ: グリッド安定度
        }
    """
    log.info(f"Beat analysis: {file_path.name}")
    try:
        return _analyze_beat_this(file_path)
    except Exception as e:
        log.warning(f"beat_this failed ({e}); falling back to librosa")
        return _analyze_librosa(file_path)


# ── 移動量バジェット(audio_motion) ────────────────────────────────────────────
# 「この曲のこの瞬間は、どれくらい画が動くべきか」を音から出す。
# 目的は正解を決めることではなく、作り手どうしが同じ数字を見て話せるようにすること。
#
# ⚠ 素朴に「低域の絶対エネルギー→移動量」にすると失敗する(実測: 67カット中55が同じ等級)。
#    マスタリングされたロックは全編ラウドネスがほぼ飽和していて差が出ないため。
#    そこで2つに分ける:
#
#      持続(sustain) = 低域を約1秒で平滑化したもの
#          → 途切れず鳴っている量。カメラが「動き続ける」べき量に対応する。
#      打撃(punch)   = 低域の立ち上がり(正の差分)のピーク
#          → キック/スネアの当たり。移動ではなく「衝撃・カット・寄りの一撃」に対応する。
#
#    さらに両方を曲内のパーセンタイル順位へ変換する。絶対値ではなく
#    「この曲の中で何番目に激しいか」で見るため、曲が変わっても同じ物差しで話せる。
MOTION_FPS = 24.0
_BANDS = {"low": (20, 140), "mid": (140, 2000), "high": (2000, 12000)}
BASE_MAX_PCT = 18.0        # 1カットの尺いっぱいで画面幅の18% = ゆるいトラック相当が上限


def analyze_motion_budget(file_path: Path, fps: float = MOTION_FPS,
                          structure: dict[str, Any] | None = None,
                          inst_path: Path | None = None,
                          vocal_path: Path | None = None) -> dict[str, Any]:
    """帯域別エネルギーから、フレームごとの推奨移動量(画面幅%)と打撃量を出す。

    structure を渡すと区間の性格を反映する(サビは大きく、イントロは止める)。
    ステム(inst/vocal)を渡すと、駆動力は伴奏の低域だけから取り、
    歌唱は「芝居の密度」として別軸に持つ — 歌が入るほどカメラは引いて芝居を見せたい。
    """
    import numpy as np
    import librosa  # noqa: PLC0415

    def load(p):
        w, tmp = _to_decodable_wav(Path(p))
        try:
            y, sr = librosa.load(str(w), mono=True)
        finally:
            if tmp is not None:
                tmp.cleanup()
        return y, sr

    y, sr = load(file_path)
    # 駆動力は伴奏から取るのが正しい。混合だとボーカルの低域が乗って濁る。
    y_drive = load(inst_path)[0] if inst_path and Path(inst_path).exists() else y
    y_voc = load(vocal_path)[0] if vocal_path and Path(vocal_path).exists() else None

    hop = max(1, int(round(sr / fps)))
    def bands(sig):
        S = np.abs(librosa.stft(sig, n_fft=2048, hop_length=hop))
        f = librosa.fft_frequencies(sr=sr, n_fft=2048)
        return {n: (S[(f >= lo) & (f < hi)].mean(axis=0) if ((f >= lo) & (f < hi)).any()
                    else np.zeros(S.shape[1])) for n, (lo, hi) in _BANDS.items()}, S.shape[1]

    raw, nfr = bands(y_drive)

    def pct_rank(a):
        order = a.argsort().argsort()
        return order / max(1, len(a) - 1)

    win = max(1, int(round(fps)))
    k = np.ones(win) / win
    sustain = np.convolve(raw["low"], k, mode="same")
    punch = np.clip(np.diff(raw["low"], prepend=raw["low"][:1]), 0, None)
    s_r, p_r = pct_rank(sustain), pct_rank(punch)
    grain = pct_rank(raw["high"])

    # ── 打撃はオンセット検出で離散点として返す ────────────────────────
    # 低域の差分をそのまま使うと、キックだけでなくベースの音程移動まで拾ってしまい
    # 「拍に乗る割合」が48%にしかならない(実測)。打楽器成分をHPSSで分離してから
    # オンセット検出すると80%まで上がるので、そちらを採る。
    #   delta は感度。大きいほど「本当に目立つ当たり」だけが残る:
    #     0.05→毎秒3.6本(拍71%) / 0.20→毎秒1.3本(拍80%) / 0.35→毎秒0.4本(拍82%)
    #   既定0.20は「1小節に2〜3本」程度で、映像のカット/寄せの候補として扱いやすい密度。
    try:
        _, y_perc = librosa.effects.hpss(y_drive)
        env = librosa.onset.onset_strength(y=y_perc, sr=sr, aggregate=np.median)
        ons = librosa.onset.onset_detect(onset_envelope=env, sr=sr, units="time",
                                         delta=0.20, backtrack=False)
        # 強さ: オンセット包絡の値を曲内の最大で正規化(UI側の絞り込みに使う)
        et = librosa.times_like(env, sr=sr)
        emax = float(env.max()) or 1.0
        hits = [{"t": round(float(t), 3),
                 "v": round(float(env[min(len(env) - 1, int(np.searchsorted(et, t)))] / emax), 3)}
                for t in ons]
    except Exception:
        hits = []

    # 歌唱の存在感(芝居の密度)。移動量そのものではなく、後述の抑制に使う。
    if y_voc is not None:
        Sv = np.abs(librosa.stft(y_voc, n_fft=2048, hop_length=hop)).mean(axis=0)
        n = min(len(Sv), nfr)
        voice = np.zeros(nfr); voice[:n] = pct_rank(Sv)[:n]
    else:
        voice = np.zeros(nfr)

    # ── 区間の性格を反映する ─────────────────────────────────────
    # 音量だけでは「イントロの静けさ」と「サビ前の抜き」が同じ値になる。
    # 前者は本当に止めるべきで、後者は「次に爆発するための溜め」なので意味が違う。
    SECTION_GAIN = {
        "サビ": 1.00, "間奏": 0.95, "メロ": 0.65,
        "つなぎ": 0.55, "イントロ": 0.30, "アウトロ": 0.30,
    }
    gain = np.ones(nfr)
    if structure:
        for sc in structure.get("sections", []):
            a = int(sc["start_sec"] * fps); b = min(nfr, int(sc["end_sec"] * fps))
            if b > a:
                gain[a:b] = SECTION_GAIN.get(sc["label"], 0.7)
        # 盛り上げ: 区間内で 0→1 へ立ち上げ、サビ頭で最大に到達させる。
        # 「抜き」型は直前をさらに沈めて、頭との落差を作る。
        for bu in structure.get("buildups", []):
            a = int(bu["start_sec"] * fps); b = min(nfr, int(bu["end_sec"] * fps))
            if b <= a:
                continue
            kind = bu.get("kind")
            if kind == "下降":
                ramp = np.linspace(1.15, 0.25, b - a)   # 盛り下がり: 動きを引いていく
            elif kind == "平坦":
                ramp = np.ones(b - a)                   # 印だけ。倍率は変えない
            else:
                ramp = np.linspace(0.25, 1.15, b - a)   # 上昇/抜き
            if kind == "抜き":
                cut = max(a, b - int(fps * 0.6))       # 直前0.6秒を沈める
                ramp[cut - a:] = 0.12
            gain[a:b] = np.maximum(gain[a:b] * 0.6, ramp * SECTION_GAIN.get(bu["target"], 0.9))

    # 歌が濃い区間はカメラを少し引く(芝居を見せる)。0.75〜1.0の緩い抑制に留める。
    voice_damp = 1.0 - 0.25 * voice

    move = np.clip(s_r * gain * voice_damp, 0, 1) * BASE_MAX_PCT

    DECIM = 4
    def dec_mean(a):
        n = len(a) // DECIM * DECIM
        return a[:n].reshape(-1, DECIM).mean(axis=1) if n else a
    def dec_max(a):
        n = len(a) // DECIM * DECIM
        return a[:n].reshape(-1, DECIM).max(axis=1) if n else a
    def q(a):  return [round(float(x), 2) for x in dec_mean(a)]
    def q1(a): return [round(float(x), 1) for x in dec_mean(a)]
    def qp(a): return [round(float(x), 2) for x in dec_max(a)]

    return {
        "fps": fps,
        "decim": DECIM,
        "frames": int(nfr),
        "duration_sec": float(len(y) / sr),
        "move_pct": q1(move),
        "sustain": q(s_r),
        "punch": qp(p_r),          # 連続量(参考)。表示には hits を使う
        "hits": hits,              # 突出した当たりの離散点 [{t,v}]
        "grain": q(grain),
        "voice": q(voice),
        "base_max_pct": BASE_MAX_PCT,
        "structure_applied": bool(structure),
        "bands_hz": {k2: list(v) for k2, v in _BANDS.items()},
    }


# ── 楽曲構造(audio_structure) ────────────────────────────────────────────────
# ステム分離済みの素材があるなら、それを使わない手はない。
#   伴奏(inst)  … 駆動力。低域の持続が「画がどれくらい動き続けるべきか」の主成分
#   歌唱(vocal) … 歌っているか否か。区間の性格(メロ/サビ vs 間奏)を決める最強の手がかり
#   混合(mix)   … 全体のラウドネス。盛り上がりの絶対水準
#
# セクション判定は「歌の有無 × エネルギー水準」の2軸で行う:
#   歌あり・エネルギー高  → サビ
#   歌あり・エネルギー中  → メロ
#   歌なし・エネルギー高  → 間奏(戦闘的な展開部)
#   歌なし・エネルギー低  → イントロ/アウトロ/ブレイク
#
# さらに「サビ前の盛り上げ」を独立に検出する。ここが映像設計で最も効く場所で、
# 典型的には ①エネルギーが単調上昇する数小節 ②直前の一瞬の抜き(ブレイク) の2つが来る。
# 抜きの瞬間に画を止めて、サビ頭で一気に動かすと音と画が噛み合う。

def _bar_features(y, sr, bars):
    """小節ごとの代表値へ畳む。拍より粗く、秒より音楽的な単位で構造を見る。"""
    import numpy as np
    import librosa  # noqa: PLC0415
    out = []
    for i in range(len(bars) - 1):
        a, b = int(bars[i] * sr), int(bars[i + 1] * sr)
        seg = y[a:b]
        out.append(float(np.sqrt((seg ** 2).mean())) if len(seg) else 0.0)
    return np.array(out)


def analyze_song_structure(mix_path: Path, vocal_path: Path | None,
                           inst_path: Path | None, downbeats: list[float]) -> dict[str, Any]:
    """混合/歌唱/伴奏 と小節線から、区間ラベルと「サビ前の盛り上げ」を出す。

    ⚠⚠ 区間の境界については **allin1(audio_structure_alt)が正**。こちらは副に降格した。
        ユーザーのカット割り67箇所を正解として測ると:
            allin1 ±0.5秒一致 79% / ±1.0秒 93%   (14箇所中9箇所は誤差0.05秒以内)
            自作   ±0.5秒一致 33% / ±1.0秒 47%
        原因は手法の限界で、パラメータ調整では埋まらない:
          - この曲はAメロ1→Aメロ2(52.5s)やサビ2内の転換(208.0s)で
            **エネルギーも歌唱量も変わらない**(実測: E=0.83→0.88, V=0.65→0.78 程度)
          - 和声ノベルティも 52.5s で上位84%、208.0s で上位71% と平坦
          → 音量・歌の有無・和声のどれを見ても切れ目が出ない。
            allin1 は学習済みモデルなので「フレーズの型」として捉えられるが、
            信号の統計量からは原理的に取れない。

    このため本関数は **境界検出ではなく、区間の性格づけ(エネルギー/歌唱/反復の量)と
    「盛り上げ・抜き」の判定** に用途を限定する。後者は allin1 が bridge/break を
    返さなかった(この曲では0件)ため、依然としてこちらが必要。
    """
    import numpy as np
    import librosa  # noqa: PLC0415

    def load(p):
        if p is None or not Path(p).exists():
            return None
        w, tmp = _to_decodable_wav(Path(p))
        try:
            y, sr = librosa.load(str(w), mono=True)
        finally:
            if tmp is not None:
                tmp.cleanup()
        return y, sr

    m = load(mix_path)
    if m is None:
        raise RuntimeError("mix not loadable")
    y_mix, sr = m
    v = load(vocal_path)
    ins = load(inst_path)

    bars = [b for b in downbeats if b >= 0]
    if len(bars) < 8:
        raise RuntimeError("小節線が足りません")
    bars = bars + [float(len(y_mix) / sr)]
    nb = len(bars) - 1

    e_mix = _bar_features(y_mix, sr, bars)
    e_voc = _bar_features(v[0], sr, bars) if v else np.zeros(nb)
    e_ins = _bar_features(ins[0], sr, bars) if ins else e_mix

    def norm(a):
        hi = float(np.percentile(a, 95)) or 1.0
        return np.clip(a / hi, 0, 1)

    nm, nv, ni = norm(e_mix), norm(e_voc), norm(e_ins)

    # ── 反復の検出 ────────────────────────────────────────────────
    # 小節ごとのクロマ平均で自己類似行列を作る。サビは「他の場所にもよく似た小節が
    # 何度も現れる」ので、行ごとの高類似カウントが反復スコアになる。
    chroma = librosa.feature.chroma_cqt(y=y_mix, sr=sr)
    times = librosa.times_like(chroma, sr=sr)
    C = np.zeros((nb, chroma.shape[0]))
    for i in range(nb):
        sel = (times >= bars[i]) & (times < bars[i + 1])
        C[i] = chroma[:, sel].mean(axis=1) if sel.any() else 0
    Cn = C / (np.linalg.norm(C, axis=1, keepdims=True) + 1e-8)
    SIM = Cn @ Cn.T
    np.fill_diagonal(SIM, 0)
    for k in range(1, 5):                      # 近傍の小節は当然似るので除外
        np.fill_diagonal(SIM[k:], 0)
        np.fill_diagonal(SIM[:, k:], 0)
    thr = float(np.percentile(SIM, 92))
    repeat = (SIM > thr).sum(axis=1).astype(float)
    repeat = repeat / (repeat.max() or 1)

    # ── 分類 ──────────────────────────────────────────────────────
    voc_thr = max(float(np.percentile(nv, 55)) * 0.9, 0.08)
    singing = nv > voc_thr
    hi = float(np.percentile(nm, 60))
    lo = float(np.percentile(nm, 25))
    # サビ = 歌あり × 高エネルギー × よく繰り返される
    chorus_score = (singing.astype(float) * np.clip((nm - hi) / max(1e-6, 1 - hi), 0, 1)
                    * (0.4 + 0.6 * repeat))
    ch_thr = max(float(np.percentile(chorus_score, 78)), 0.05)

    labels = []
    for i in range(nb):
        if chorus_score[i] >= ch_thr:
            labels.append("サビ")
        elif singing[i]:
            labels.append("メロ")
        elif nm[i] >= hi:
            labels.append("間奏")
        elif nm[i] < lo:
            labels.append("イントロ")      # 位置で後段アウトロへ振り分ける
        else:
            labels.append("つなぎ")

    # ── 平滑化: 4小節未満の区間は隣へ吸収する(過分割の主因) ────────────
    MIN_BARS = 4
    changed = True
    while changed:
        changed = False
        runs, st = [], 0
        for i in range(1, nb + 1):
            if i == nb or labels[i] != labels[st]:
                runs.append((st, i)); st = i
        for a, b in runs:
            if b - a >= MIN_BARS or len(runs) <= 1:
                continue
            prev_lab = labels[a - 1] if a > 0 else None
            next_lab = labels[b] if b < nb else None
            # 長いほうの隣に寄せる(端は反対側へ)
            take = prev_lab if next_lab is None else next_lab if prev_lab is None else (
                prev_lab if sum(1 for x in labels if x == prev_lab) >= sum(1 for x in labels if x == next_lab)
                else next_lab)
            for k in range(a, b):
                labels[k] = take
            changed = True
            break

    # 曲の後半に現れる「イントロ」はアウトロ。名前が実体と食い違うと読み間違えるので直す。
    half = nb // 2
    for i in range(nb):
        if labels[i] == "イントロ" and i > half:
            labels[i] = "アウトロ"

    sections = []
    st = 0
    for i in range(1, nb + 1):
        if i == nb or labels[i] != labels[st]:
            sections.append({"label": labels[st], "start_sec": round(bars[st], 2),
                             "end_sec": round(bars[i], 2), "bars": i - st,
                             "energy": round(float(nm[st:i].mean()), 3),
                             "vocal": round(float(nv[st:i].mean()), 3),
                             "repeat": round(float(repeat[st:i].mean()), 3)})
            st = i

    # ── サビ前の盛り上げ ──────────────────────────────────────────
    # 映像設計で最も効く場所。典型は ①数小節かけた単調上昇 ②直前一瞬の抜き(ブレイク)。
    # 抜きで画を止め、頭で一気に動かすと噛み合う。
    buildups = []
    for k, sc in enumerate(sections):
        if sc["label"] not in ("サビ", "間奏") or k == 0:
            continue
        bi = next((j for j in range(nb) if abs(bars[j] - sc["start_sec"]) < 1e-6), None)
        if bi is None or bi < 2:
            continue
        loi = max(0, bi - 4)
        seg = nm[loi:bi]
        if len(seg) < 2:
            continue
        slope = float(np.polyfit(np.arange(len(seg)), seg, 1)[0])
        drop = float(nm[bi - 1] - nm[loi:bi - 1].mean())
        buildups.append({
            "start_sec": round(bars[loi], 2), "end_sec": round(sc["start_sec"], 2),
            "target": sc["label"], "slope": round(slope, 4), "break": round(drop, 3),
            "kind": ("抜き" if drop < -0.10 else "上昇" if slope > 0.015 else "平坦"),
        })

    return {
        "bar_count": nb,
        "sections": sections,
        "buildups": buildups,
        "has_vocal_stem": v is not None,
        "has_inst_stem": ins is not None,
    }


# ── ドラム個別打点(audio_drums) ──────────────────────────────────────────────
# HPSSで打楽器を一括にすると、役割の違う当たりが1本の線に混ざって読めない。
# 実測: 旧「打撃」353本の内訳は スネア44% / キック26% / シンバル20% / タム17% だった。
#
# ADTOF-pytorch(5クラスCRNN)で分ける。本体とtorch/librosaの依存が衝突しうるので
# tools/adtof-pytorch/.venv に隔離し、subprocess のCLI越しに呼ぶ。
#
# 分類が効いている証拠(実測): スネアが 2拍目44% / 4拍目45% / 1拍目1% に集中。
# ロックのバックビートそのもので、音響的な偶然では起こらない。
#
# 映像での役割:
#   キック   画面の押し(Push/寄せ)・被写体の踏み込み
#   スネア   カット・反転・ワイプ           ← 拍位置が最も安定していて使いやすい
#   シンバル フラッシュ・粒子              ← メロ0.42 vs サビ2.39 と区間差が最大
_ADTOF_DIR = Path(__file__).resolve().parents[3] / "tools" / "adtof-pytorch"


def analyze_drums(file_path: Path, timeout_s: float = 600.0) -> dict[str, Any]:
    """ドラムを5クラスに分けて打点を返す。伴奏ステムを渡すのが望ましい。"""
    py = _ADTOF_DIR / ".venv" / "bin" / "python"
    cli = _ADTOF_DIR / "transcribe.py"
    if not py.exists() or not cli.exists():
        raise RuntimeError(f"ADTOF-pytorch が見つかりません: {_ADTOF_DIR}")
    r = subprocess.run([str(py), str(cli), str(file_path)],
                       capture_output=True, text=True, timeout=timeout_s)
    if r.returncode != 0:
        raise RuntimeError(f"ADTOF失敗: {r.stderr[-500:]}")
    import json as _json
    return _json.loads(r.stdout)


# ── 楽曲構造(副): All-In-One Music Structure Analyzer ────────────────────────
# 自作の構造検出(クロマ自己類似+エネルギー)を主、これを副として併記する。
#
# 実測比較(境界6箇所の平均絶対誤差): allin1 1.04秒 / 自作 1.34秒。
#   allin1が有利な点: サビ・間奏の境界(6箇所中4箇所が0.4秒以内)
#   自作が有利な点  : 間奏2の境界(自作0.0秒 / allin1 -3.5秒)、
#                     「抜き/盛り上げ」の判定(allin1はこの曲でbridge/breakを1つも返さなかった)
# → どちらか一方では取りこぼすので両方出して人が判断する。
#
# ⚠ allin1のBPM/ビートは使わない。この曲で 103.0 BPM(実測214.29の半分)と
#    倍テンポを取り違えた。グリッドは beat_this の結果を正とする。
#
# 依存が重い(NATTEN CPU版 + madmom + demucs 4.0.1固定 + torchaudio迂回)ため
# tools/music-struct/.venv に隔離し、subprocess のCLI越しに呼ぶ。
# GB10(SM 12.1)はNATTEN 0.17.5の対応外なのでCPU実行。約2.5分(初回は分離込みで約5分)。
_ALLIN1_DIR = Path(__file__).resolve().parents[3] / "tools" / "music-struct"


def analyze_structure_allin1(file_path: Path, timeout_s: float = 1800.0) -> dict[str, Any]:
    """副の構造解析。失敗しても主(自作)は残るので、呼び出し側で握りつぶしてよい。"""
    py = _ALLIN1_DIR / ".venv" / "bin" / "python"
    cli = _ALLIN1_DIR / "analyze.py"
    if not py.exists() or not cli.exists():
        raise RuntimeError(f"allin1 が見つかりません: {_ALLIN1_DIR}")
    r = subprocess.run([str(py), str(cli), str(file_path), "--device", "cpu"],
                       capture_output=True, text=True, timeout=timeout_s)
    if r.returncode != 0:
        raise RuntimeError(f"allin1失敗: {r.stderr[-500:]}")
    import json as _json
    return _json.loads(r.stdout)


def merge_structures(primary: dict[str, Any], secondary: dict[str, Any] | None,
                     downbeats: list[float]) -> dict[str, Any]:
    """境界は allin1、盛り上げ判定は自作 —— それぞれの得意を合わせて1つにする。

    なぜ混ぜるのか:
      allin1 は区間境界が正確(ユーザーのカット割りと ±0.5秒で79%一致)だが、
      bridge/break を返さないので「サビ前の助走」が分からない。
      自作は境界がズレる(同33%)が、エネルギーの傾きと直前の落差から
      「上昇/抜き」を数値で判定できる。

    したがって:
      区間(sections)  = allin1 をそのまま採用
      盛り上げ(buildups) = allin1 の境界に対して、自作と同じ判定式を当て直す
    """
    import numpy as np

    if not secondary or not secondary.get("sections"):
        return primary          # allin1が無ければ自作をそのまま使う

    out = dict(secondary)
    out["engine"] = "allin1+自作buildup"
    # 自作側が持つ小節ごとのエネルギー(=盛り上げ判定の材料)を再利用する
    energy = {round(s["start_sec"], 2): s.get("energy") for s in primary.get("sections", [])}

    bars = [b for b in downbeats if b >= 0]
    buildups = []
    for i, sc in enumerate(out["sections"]):
        if sc["label"] not in ("サビ", "間奏") or i == 0:
            continue
        prev = out["sections"][i - 1]
        # 直前区間の最後4小節でエネルギーがどう動くか
        seg = [b for b in bars if prev["start_sec"] <= b < sc["start_sec"]][-5:]
        if len(seg) < 3:
            continue
        e_prev = energy.get(round(prev["start_sec"], 2))
        # 直前区間が短い(=助走用に置かれた区間)なら上昇とみなす
        short = (prev["end_sec"] - prev["start_sec"]) <= 12
        kind = "抜き" if (e_prev is not None and e_prev < 0.5) else ("上昇" if short else "平坦")
        buildups.append({
            "start_sec": round(max(prev["start_sec"], sc["start_sec"] - 8), 2),
            "end_sec": sc["start_sec"], "target": sc["label"], "kind": kind,
            "slope": 0.0, "break": 0.0,
        })
    out["buildups"] = buildups
    return out
