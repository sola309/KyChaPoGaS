"""MiniMax H3 ジョブの事前検査(投入時に止める・実行開始時にもう一度確かめる)。

3 つの関門:
  (1) 参照の上限 … 公式の上限(画像≤9・動画≤3・音声≤3・合計≤12ファイル・参照動画は 1 回の生成で
      合計 15 秒=362f まで)を超えたら、黙って切り捨てずに投入時に止める。プロンプトの
      <Picture N> / <Video N> / <Audio N> が実際に渡す数を超えていても止める。
  (2) 系列長 … 1 回の H3 生成が詰め込む DiT 系列長(テキスト+参照+ガイド+生成映像/音声)を
      ComfyUI と同じ式で見積もり、上限(既定 198,000、H3_MAX_SEQ_TOKENS)を超えたら止める。
  (3) T3 の設定 … params.tier="t3"(または quality="t3")のジョブは、画質に効く設定
      (steps / scheduler / sampler / easycache / turbo_lora / shift / ref_image_size など)が
      全部明示されていないと止める。既定値で埋めない。

「1 回の生成」= ComfyUI に投げる 1 本のワークフロー。362f を超える継続生成(chain)は
セグメントごとに数える(参照動画は各セグメントで先頭からその生成長までしか使われない —
ComfyUI の MiniMaxH3ReferenceToVideo が frames[:frame_count] で切るため)。
LongTake(scripts/ef_c6_longtake.py)はバックエンドを通らないので対象外。

見積りの式は ComfyUI v0.39 の comfy_extras/nodes_minimax_h3.py(参照の縮小・2fps の
Qwen サンプリング・ガイド)、comfy/text_encoders/minimax.py(ラベル+視覚ブロック)、
comfy/ldm/minimax/model.py(PackedLayout)を写したもの。
"""
from __future__ import annotations

import json
import logging
import math
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from app.services.workflow_builder import (
    H3_CHAIN_OVERLAP, H3_FPS, h3_plan_segments, h3_snap_length)

log = logging.getLogger("h3_guard")

H3_MODELS = ("minimax-h3", "minimax-h3-ref")

# ── (1) 公式の上限(HF モデルカード: Images ≤ 9 / Videos ≤ 3 clips, each 2–15 s, total ≤ 15 s /
#        Audio ≤ 3 / total files 12) ─────────────────────────────────────────────
H3_MAX_REF_IMAGES = 9
H3_MAX_REF_VIDEOS = 3
H3_MAX_REF_AUDIOS = 3
H3_MAX_REF_FILES = 12
# 「15 秒」は H3 の 17k+5 グリッドでは 362f(15.08 秒)。生成の最大長と同じ単位で数える
# (362f の参照で 362f を生成する組は 960x544 では成立している: 帰巡ef E3)。
H3_REF_VIDEO_MAX_FRAMES = 362
H3_REF_VIDEO_TOTAL_MAX_FRAMES = 362
H3_REF_VIDEO_MIN_FRAMES = 5          # これ未満は ComfyUI が例外を出す

# ── (2) 系列長の上限 ───────────────────────────────────────────────────────
# 既定 198,000: 実際に走って崩れたジョブの最小 204,395(4771)と、無事だった最大 197,959(7480/7489/7490)の間。
# 変更は 1 か所: 環境変数 H3_MAX_SEQ_TOKENS(app/config.py)。再起動なしで変えるなら
# PUT /api/settings で H3_MAX_SEQ_TOKENS(data/settings.json に残る)。
# 1 本だけ試すなら params.h3_max_seq_tokens(ジョブに記録が残る)。
DEFAULT_MAX_SEQ_TOKENS = 198_000

# ── H3 の幾何(ComfyUI と同じ定数) ─────────────────────────────────────
CANVAS_MULTIPLE = 32
BASE_SHORT_EDGE = 768
MAX_PIXELS = 768 * 1344
REF_IMAGE_SHORT_EDGE = 2048
QWEN_MIN_PIXELS = 3136
QWEN_MAX_PIXELS = 12845056
AUDIO_LATENT_FPS = 40
CHAIN_AUDIO_CONTEXT_FRAMES = 24      # workflow_builder._h3_apply_chain の audio_context_length

ADVICE = ("対策: 参照動画を縮小する(例 960x544)/尺を短くする/分割する "
          "(shrink the ref video, shorten, or split)")

_TAG_RE = {kind: re.compile(r"<%s (\d+)>" % kind) for kind in ("Picture", "Video", "Audio")}


# ─────────────────────────────────────────────────────────────────────────
# 上限値
# ─────────────────────────────────────────────────────────────────────────
def _config_limit() -> int:
    """app/config.py の H3_MAX_SEQ_TOKENS(環境変数。既定 198000)。読めなければ DEFAULT。"""
    try:
        from app import config
        v = int(getattr(config, "H3_MAX_SEQ_TOKENS"))
        return v if v > 0 else DEFAULT_MAX_SEQ_TOKENS
    except Exception:
        return DEFAULT_MAX_SEQ_TOKENS


def max_seq_tokens(params: dict | None = None) -> int:
    """系列長の上限。params.h3_max_seq_tokens > settings(H3_MAX_SEQ_TOKENS) > env(config.py) > 既定。
    settings の値が数値でない/0 以下のときは警告して config.py の値に戻す(全 H3 ジョブが止まらないように)。"""
    if params and params.get("h3_max_seq_tokens") not in (None, ""):
        return int(params["h3_max_seq_tokens"])
    v = None
    try:
        from app.services import settings_store
        v = settings_store.get("H3_MAX_SEQ_TOKENS")      # 無ければ config の値が返る
    except Exception:
        v = None
    if v in (None, ""):
        return _config_limit()
    try:
        n = int(v)
        if n > 0:
            return n
    except (TypeError, ValueError):
        pass
    fallback = _config_limit()
    log.warning("H3_MAX_SEQ_TOKENS が正の整数でない(%r) → config の %d を使う", v, fallback)
    return fallback


# ─────────────────────────────────────────────────────────────────────────
# 品質プリセット(job_runner から移設。挙動は従来と同一)
# ─────────────────────────────────────────────────────────────────────────
def apply_quality_preset(params: dict) -> tuple[dict, str | None]:
    """params["quality"] の t1 / t0 を展開する。展開したときは新しい dict を返す(元は触らない)。"""
    q = str(params.get("quality", "")).lower()
    if q == "t1":
        # 2026-09-27: ユーザー指示で T1 もネイティブ 1344x768 に(縦長は縦横を入れ替える)。
        params = dict(params)
        portrait = int(params.get("height", 768) or 768) > int(params.get("width", 1344) or 1344)
        params.update({"width": 768 if portrait else 1344, "height": 1344 if portrait else 768, "steps": 4,
                       "turbo_lora": 0.75, "easycache": True,
                       "ref_image_size": "match"})
        return params, "T1プリセット適用: 1344x768(ネイティブ)/step4/turbo0.75(ref2v)/easycache"
    if q == "t0":
        params = dict(params)
        params.update({"width": 960, "height": 544, "steps": 4,
                       "turbo_lora": 0.75, "easycache": True,
                       "ref_image_size": "match", "preview_steps": 1})
        return params, "T0超速プレビュー適用: 960x544/step4→先頭1段のx0予測/turbo0.75"
    return params, None


# ─────────────────────────────────────────────────────────────────────────
# (3) Tier / T3 の設定
# ─────────────────────────────────────────────────────────────────────────
TIERS = ("t0", "t1", "t2", "t3")
# T3 で必ず明示させるキー(null を許すものは null=「使わない/モデル既定」をはっきり選んだ意味)
T3_REQUIRED_COMMON = ("width", "height", "duration_sec", "seed", "steps", "scheduler", "sampler",
                      "easycache", "turbo_lora", "shift_video", "shift_audio")
T3_REQUIRED_REF = ("ref_image_size",)


def _norm_tier(v: Any) -> str | None:
    if v is None or v == "":
        return None
    return str(v).strip().lower()


def is_t3(params: dict) -> bool:
    return _norm_tier(params.get("tier")) == "t3" or _norm_tier(params.get("quality")) == "t3"


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) or (isinstance(v, float) and v.is_integer())


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def tier_problems(params: dict, provided: Iterable[str] | None = None) -> list[str]:
    """tier の値と、T3 指定時の必須キー・矛盾を調べる。provided=実際に送られたキー
    (pydantic が既定値を補う /generation/video/i2v 用)。None なら params のキー。"""
    errs: list[str] = []
    tier = _norm_tier(params.get("tier"))
    if tier is not None and tier not in TIERS:
        errs.append(f"tier の値が不正: {params.get('tier')!r}(t0/t1/t2/t3 のいずれか)")
    q = _norm_tier(params.get("quality"))
    if not is_t3(params):
        return errs
    model = str(params.get("model", ""))
    keys = set(params) if provided is None else set(provided)
    required = T3_REQUIRED_COMMON + (T3_REQUIRED_REF if model == "minimax-h3-ref" else ())
    missing = [k for k in required if k not in keys]
    if missing:
        errs.append("T3 なのに画質に効く設定が明示されていない(既定値では埋めない): "
                    + ", ".join(missing)
                    + "。turbo_lora / shift_video / shift_audio は使わないなら null を明示")
    if tier is not None and tier != "t3":
        errs.append(f"tier={tier} と quality=t3 が矛盾")
    if q not in (None, "t3"):
        errs.append(f"T3 に quality={params.get('quality')!r} が付いている(サーバのプリセットが設定を上書きする)")

    def _present(k: str) -> bool:
        return k in keys

    if _present("steps") and not (_is_int(params.get("steps")) and int(params["steps"]) >= 1):
        errs.append(f"T3 の steps が整数(1以上)でない: {params.get('steps')!r}")
    for k in ("scheduler", "sampler"):
        if _present(k) and not (isinstance(params.get(k), str) and params[k].strip()):
            errs.append(f"T3 の {k} が空: {params.get(k)!r}")
    if _present("easycache") and not isinstance(params.get("easycache"), bool):
        errs.append(f"T3 の easycache は true/false で明示: {params.get('easycache')!r}")
    tl = params.get("turbo_lora")
    turbo_on = False
    if _present("turbo_lora"):
        if tl in (None, False, 0):
            turbo_on = False
        elif _is_num(tl) and tl > 0:
            turbo_on = True
        else:
            errs.append(f"T3 の turbo_lora は null(使わない)か正の数: {tl!r}")
    if turbo_on and not (isinstance(params.get("turbo_lora_name"), str) and params["turbo_lora_name"].strip()):
        errs.append("T3 で turbo_lora を使うなら turbo_lora_name(LoRA ファイル)も明示")
    for k in ("shift_video", "shift_audio"):
        v = params.get(k)
        if _present(k) and v is not None and not (_is_num(v) and v > 0):
            errs.append(f"T3 の {k} は null(モデル既定 12/3)か正の数: {v!r}")
    if model == "minimax-h3-ref" and _present("ref_image_size") and params.get("ref_image_size") not in ("match", "max"):
        errs.append(f"T3 の ref_image_size は match / max: {params.get('ref_image_size')!r}")
    for k in ("width", "height"):
        v = params.get(k)
        if _present(k) and not (_is_int(v) and int(v) >= 32 and int(v) % 32 == 0):
            errs.append(f"T3 の {k} は 32 の倍数の整数(切り捨てで黙って変わるため): {v!r}")
    if _present("duration_sec") and not (_is_num(params.get("duration_sec")) and params["duration_sec"] > 0):
        errs.append(f"T3 の duration_sec が正の数でない: {params.get('duration_sec')!r}")
    if _present("seed") and not _is_int(params.get("seed")):
        errs.append(f"T3 の seed は整数(-1=ランダム): {params.get('seed')!r}")
    ps = params.get("preview_steps")
    if ps not in (None, 0, False):
        st = params.get("steps")
        if not (_is_int(ps) and _is_int(st) and 0 < int(ps) < int(st)):
            errs.append(f"T3 の preview_steps は 0 < preview_steps < steps: {ps!r}(steps {st!r})")
    vdn = params.get("vdn")
    if vdn:
        if turbo_on:
            errs.append("T3 で vdn と turbo_lora を同時に指定している(サーバが turbo を黙って外す)")
        if isinstance(vdn, dict):
            for k in ("sampler", "scheduler"):
                if vdn.get(k) and params.get(k) and vdn[k] != params[k]:
                    errs.append(f"T3 の vdn.{k}={vdn[k]!r} と {k}={params[k]!r} が矛盾")
        if params.get("sol") not in (None, False):
            errs.append("vdn と sol は併用できない")
    return errs


# ─────────────────────────────────────────────────────────────────────────
# メディア情報
# ─────────────────────────────────────────────────────────────────────────
@dataclass
class Media:
    path: str
    width: int | None = None
    height: int | None = None
    frames: int | None = None        # 動画: 全フレーム数(ComfyUI LoadVideo が返す枚数)
    duration: float | None = None    # 秒(動画・音声)
    has_audio: bool = False


_probe_cache: dict[tuple, Media] = {}


def _get(row: Any, key: str):
    if row is None:
        return None
    if isinstance(row, dict):
        return row.get(key)
    return getattr(row, key, None)


def _ffprobe(path: str) -> dict | None:
    try:
        from app.services.media_info import _ffprobe_exe
        exe = _ffprobe_exe()
    except Exception:
        exe = None
    if not exe:
        return None
    try:
        r = subprocess.run([exe, "-v", "error", "-show_entries",
                            "stream=codec_type,width,height,nb_frames,avg_frame_rate,r_frame_rate,duration"
                            ":format=duration", "-of", "json", path],
                           capture_output=True, text=True, timeout=30)
        return json.loads(r.stdout or "{}")
    except Exception:
        return None


def _rate(s: str | None) -> float | None:
    try:
        a, _, b = str(s).partition("/")
        v = float(a) / float(b or 1)
        return v if v > 0 else None
    except Exception:
        return None


def media_of(row: Any, kind: str) -> Media:
    """アセット行(Asset か dict)からサイズ・フレーム数を得る。ファイルを優先し、無理なら表の値。"""
    path = str(_get(row, "file_path") or "")
    p = Path(path)
    try:
        st = p.stat()
        key = (path, st.st_mtime_ns, st.st_size, kind)
    except OSError:
        key = None
    if key and key in _probe_cache:
        return _probe_cache[key]
    m = Media(path=path, width=_get(row, "width"), height=_get(row, "height"),
              duration=_get(row, "duration_sec"))
    if kind == "image":
        try:
            from PIL import Image
            with Image.open(p) as im:
                w, h = im.size
                try:   # ComfyUI LoadImage は EXIF の向きを適用する
                    if im.getexif().get(274) in (5, 6, 7, 8):
                        w, h = h, w
                except Exception:
                    pass
            m.width, m.height = w, h
        except Exception:
            pass
    elif kind in ("video", "audio"):
        info = _ffprobe(path) if key else None
        if info:
            vs = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
            m.has_audio = any(s.get("codec_type") == "audio" for s in info.get("streams", []))
            fdur = None
            try:
                fdur = float(info.get("format", {}).get("duration"))
            except Exception:
                pass
            if fdur:
                m.duration = fdur
            if vs and kind == "video":
                m.width, m.height = vs.get("width") or m.width, vs.get("height") or m.height
                nb = vs.get("nb_frames")
                if str(nb).isdigit() and int(nb) > 0:
                    m.frames = int(nb)
                else:
                    fps = _rate(vs.get("avg_frame_rate")) or _rate(vs.get("r_frame_rate")) or H3_FPS
                    d = None
                    try:
                        d = float(vs.get("duration"))
                    except Exception:
                        d = m.duration
                    if d:
                        m.frames = int(round(d * fps))
        if kind == "video" and m.frames is None and m.duration:
            m.frames = int(round(float(m.duration) * H3_FPS))   # ffprobe 不可: 24fps とみなす
    if key:
        if len(_probe_cache) > 2000:
            _probe_cache.clear()
        _probe_cache[key] = m
    return m


# ─────────────────────────────────────────────────────────────────────────
# (2) 系列長の見積り
# ─────────────────────────────────────────────────────────────────────────
def align_frame_count(n: int) -> int:
    while n % 17 != 5:
        n += 1
    return n


def align_down(n: int) -> int:
    while n > 5 and n % 17 != 5:
        n -= 1
    return n


def video_latent_t(frame_count: int) -> int:
    return 2 if frame_count <= 5 else ((frame_count - 5) // 17) * 5 + 2


def vae_latent_t(n: int) -> int:
    """VAE が n フレームを何ラテントフレームにするか(1枚=1、それ以外は 17 枚ごと5 − 落とし3)。"""
    return 1 if n <= 1 else math.ceil(n / 17) * 5 - 3


def _r32(x: float) -> int:
    return max(CANVAS_MULTIPLE, round(x / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)


def ref_image_target(w: int, h: int, gw: int, gh: int, mode: str) -> tuple[int, int]:
    if mode == "match":
        scale = min(1.0, math.sqrt((gw * gh) / (w * h)))
    else:
        scale = min(1.0, REF_IMAGE_SHORT_EDGE / min(w, h))
    return _r32(w * scale), _r32(h * scale)


def adapt_canvas(width: int, height: int) -> tuple[int, int]:
    ratio = width / height
    if ratio >= 1.0:
        nw, nh = BASE_SHORT_EDGE * ratio, BASE_SHORT_EDGE
    else:
        nw, nh = BASE_SHORT_EDGE, BASE_SHORT_EDGE / ratio
    if nw * nh > MAX_PIXELS:
        s = math.sqrt(MAX_PIXELS / (nw * nh))
        nw, nh = nw * s, nh * s
    return _r32(nw), _r32(nh)


def ref_video_canvas(vw: int, vh: int) -> tuple[int, int]:
    cw, ch = adapt_canvas(vw, vh)
    if vw * vh < cw * ch:
        cw, ch = _r32(vw), _r32(vh)
    return cw, ch


def qwen_vision_tokens(w: int, h: int) -> int:
    """Qwen3-VL(patch16×merge2): 32px 角 1 トークン。process_qwen2vl_images と同じ丸め。"""
    factor = 32
    hb = round(h / factor) * factor
    wb = round(w / factor) * factor
    if hb * wb > QWEN_MAX_PIXELS:
        beta = math.sqrt((h * w) / QWEN_MAX_PIXELS)
        hb = max(factor, math.floor(h / beta / factor) * factor)
        wb = max(factor, math.floor(w / beta / factor) * factor)
    elif hb * wb < QWEN_MIN_PIXELS:
        beta = math.sqrt(QWEN_MIN_PIXELS / (h * w))
        hb = math.ceil(h * beta / factor) * factor
        wb = math.ceil(w * beta / factor) * factor
    return (hb // 32) * (wb // 32)


def _tok(s: str) -> int:
    from app.services.h3_tokens import count_tokens
    return count_tokens(s)[0]


@dataclass
class CallSpec:
    """1 回の H3 生成(=ComfyUI ワークフロー 1 本)が受け取るもの。"""
    index: int
    count: int
    frames: int
    width: int
    height: int
    mode: str                                   # "ref" | "fl2v"
    ref_image_size: str = "match"
    pictures: list = field(default_factory=list)       # [(w, h)] 元画像サイズ(ref) / FL2V は生成キャンバス
    ref_videos: list = field(default_factory=list)     # [(w, h, frames, soundtrack_rt)]
    ref_audios: list = field(default_factory=list)     # [audio latent t]
    guides: list = field(default_factory=list)         # [(frame_idx, frames)] frames 1=画像
    keyframes: int = 0                                 # FL2V の先頭/末尾フレーム数
    chain_context: tuple | None = None                 # (mode, overlap) i>1 のとき


@dataclass
class Estimate:
    call: CallSpec
    target_video: int = 0
    target_audio: int = 0
    ref_video: int = 0
    ref_images: int = 0
    ref_audio: int = 0
    guides: int = 0
    text_prompt: int = 0
    text_images: int = 0
    text_videos: int = 0
    text_labels: int = 0
    prompt_exact: bool = True

    @property
    def text(self) -> int:
        return self.text_prompt + self.text_images + self.text_videos + self.text_labels

    @property
    def total(self) -> int:
        return (self.text + self.ref_images + self.ref_video + self.ref_audio + self.guides
                + self.target_audio + self.target_video)

    def breakdown(self) -> str:
        c = self.call
        seg = f"セグメント {c.index}/{c.count}, " if c.count > 1 else ""
        txt = (f"テキスト {self.text:,}(プロンプト {self.text_prompt:,}"
               f"{'' if self.prompt_exact else '・文字数見積り'}"
               f"・画像の視覚 {self.text_images:,}・動画の視覚 {self.text_videos:,}・ラベル {self.text_labels:,})")
        parts = [f"生成映像 {self.target_video + self.target_audio:,}(映像 {self.target_video:,}+音声 {self.target_audio:,})",
                 f"参照動画 {self.ref_video:,}", f"参照画像 {self.ref_images:,}", txt]
        if self.guides:
            parts.append(f"ガイド/継続/先頭末尾 {self.guides:,}")
        if self.ref_audio:
            parts.append(f"参照音声 {self.ref_audio:,}")
        return (f"{seg}{c.frames}f {c.width}x{c.height}: " + " / ".join(parts))


def estimate_call(prompt: str, call: CallSpec) -> Estimate:
    from app.services.h3_tokens import count_tokens
    e = Estimate(call=call)
    F = align_frame_count(max(5, call.frames))
    lt = video_latent_t(F)
    rows = (call.width // 32) * (call.height // 32)
    e.target_video = lt * rows
    e.target_audio = round(F / H3_FPS * AUDIO_LATENT_FPS) * 2
    e.text_prompt, e.prompt_exact = count_tokens(prompt or "")
    if call.mode == "fl2v":
        # MiniMaxH3ImageToVideo: 先頭/末尾フレームは生成キャンバスに合わせて Qwen へ、VAE で 1 ラテント
        for i in range(call.keyframes):
            e.text_labels += _tok("<Picture %d>: " % (i + 1)) + 2
            e.text_images += qwen_vision_tokens(call.width, call.height)
            e.guides += rows
    else:
        for i, (w, h) in enumerate(call.pictures, start=1):
            tw, th = ref_image_target(w, h, call.width, call.height, call.ref_image_size)
            e.text_labels += _tok("<Picture %d>: " % i) + 2
            e.text_images += qwen_vision_tokens(tw, th)
            e.ref_images += (th // 32) * (tw // 32)
        audio_label = 0
        for k, (vw, vh, nf, soundtrack_rt) in enumerate(call.ref_videos, start=1):
            cw, ch = ref_video_canvas(vw, vh)
            n = align_down(min(int(nf), F))
            if soundtrack_rt:
                audio_label += 1
                e.text_labels += _tok("<Audio %d>: " % audio_label)
                e.ref_audio += soundtrack_rt * 2
            e.ref_video += video_latent_t(n) * (cw // 32) * (ch // 32)
            ts = [i / 2.0 for i in range(len(range(0, n, H3_FPS // 2)))]
            if len(ts) % 2 == 1:
                ts.append(ts[-1])
            e.text_labels += _tok("<Video %d>: " % k)
            qb = qwen_vision_tokens(cw, ch)
            for i in range(0, len(ts), 2):
                e.text_labels += _tok("<%.1f seconds>" % ((ts[i] + ts[i + 1]) / 2.0)) + 2
                e.text_videos += qb
        for rt in call.ref_audios:
            audio_label += 1
            e.text_labels += _tok("<Audio %d>: " % audio_label)
            e.ref_audio += rt * 2
        for _, gf in call.guides:
            n = 1 if gf < 5 else align_down(gf)
            e.guides += vae_latent_t(n) * rows
    if call.chain_context:
        mode, ov = call.chain_context
        n = 1 if ov < 5 else align_down(ov)
        e.guides += (vae_latent_t(n) if mode == "guide" else video_latent_t(n)) * rows
        if mode == "latent":
            e.guides += round(CHAIN_AUDIO_CONTEXT_FRAMES / H3_FPS * AUDIO_LATENT_FPS) * 2
    return e


# ─────────────────────────────────────────────────────────────────────────
# ジョブ → 生成ごとの受け取り物
# ─────────────────────────────────────────────────────────────────────────
Resolver = Callable[[int], Any]


def _ids(v) -> list:
    return list(v or [])


def plan_calls(params: dict, resolve: Resolver, unknown: list | None = None) -> tuple[list[CallSpec], list[str]]:
    """job_runner._generate_video_wan22 と同じ順序・既定値で、各生成が受け取るものを組み立てる。
    戻り値: (calls, problems)。problems = アセットが無い等(実行しても必ず失敗するもの)。
    ファイルはあるが大きさ/フレーム数が読めないものは unknown に積む(見積りを省くだけで止めない)。"""
    errs: list[str] = []
    if unknown is None:
        unknown = []
    mode = str(params.get("model", ""))
    is_ref = mode == "minimax-h3-ref"
    width = max(32, (int(params.get("width", 640)) // 32) * 32)
    height = max(32, (int(params.get("height", 640)) // 32) * 32)
    duration = float(params.get("duration_sec", 3.0))
    chain_cfg = params.get("chain") if isinstance(params.get("chain"), dict) else {}
    chain_mode = str(chain_cfg.get("mode") or "latent")
    overlap = int(chain_cfg.get("overlap") or H3_CHAIN_OVERLAP)
    try:
        plan = h3_plan_segments(int(round(duration * H3_FPS)), overlap)
    except ValueError as e:
        return [], [str(e)]

    def row(aid, what):
        try:
            key = int(aid)
        except (TypeError, ValueError):
            errs.append(f"{what} の asset_id が不正: {aid!r}")
            return None
        # resolve の例外(DB の一時的なロック等)は「アセットが無い」にせず、そのまま上へ投げる。
        # 呼び出し側(check_submission / job_runner)が検査の不具合として扱い、ジョブを止めない。
        r = resolve(key)
        if r is None:
            errs.append(f"{what} のアセット {aid} が見つからない")
            return None
        if not Path(str(_get(r, "file_path") or "")).exists():
            errs.append(f"{what} のアセット {aid} のファイルが無い: {_get(r, 'file_path')}")
            return None
        return r

    keyframes = params.get("keyframes") or []
    pics: list[tuple[int, int]] = []
    for kf in keyframes:
        aid = kf.get("asset_id") if isinstance(kf, dict) else kf
        r = row(aid, "参照画像" if is_ref else "キーフレーム")
        if r is None:
            continue
        m = media_of(r, "image")
        if not m.width or not m.height:
            unknown.append(f"画像アセット {aid} の大きさが読めない")
            continue
        pics.append((int(m.width), int(m.height)))
    vids: list[tuple[int, int, int, int]] = []
    auds: list[int] = []
    guides: list[tuple[int, int]] = []
    if is_ref:
        for aid in _ids(params.get("ref_video_asset_ids"))[:H3_MAX_REF_VIDEOS]:
            r = row(aid, "参照動画")
            if r is None:
                continue
            m = media_of(r, "video")
            if not (m.width and m.height and m.frames):
                unknown.append(f"参照動画 {aid} の大きさ/フレーム数が読めない")
                continue
            st = 0
            if params.get("use_ref_video_audio") and m.has_audio and m.duration:
                st = math.ceil(float(m.duration) * AUDIO_LATENT_FPS)
            vids.append((int(m.width), int(m.height), int(m.frames), st))
        for aid in _ids(params.get("ref_audio_asset_ids"))[:H3_MAX_REF_AUDIOS]:
            r = row(aid, "参照音声")
            if r is None:
                continue
            m = media_of(r, "audio")
            auds.append(math.ceil(float(m.duration or 0) * AUDIO_LATENT_FPS))
        for g in params.get("guide_keyframes") or []:
            if row(g.get("asset_id"), "ガイド画像") is not None:
                guides.append((int(g.get("frame_idx", 0)), 1))
        for g in params.get("guide_videos") or []:
            r = row(g.get("asset_id"), "ガイド動画")
            if r is None:
                continue
            length = int(g.get("length", 22))
            bi = int(g.get("batch_index", 0))
            m = media_of(r, "video")
            if not m.frames:
                # 枚数が分からないと範囲判定も見積りもできない → 見積りを省くだけ(止めない)
                unknown.append(f"ガイド動画 {g.get('asset_id')} のフレーム数が読めない")
                continue
            # ComfyUI ImageFromBatch と同じ切り出し: 負の batch_index は末尾から数え、範囲内へ丸め、
            # length は残りの枚数で切る(例: batch_index=-5, length=22 → 実際は 5 枚)
            nf = int(m.frames)
            b = bi + nf if bi < 0 else bi
            b = max(0, min(nf - 1, b))
            length = max(1, min(nf - b, length))
            guides.append((int(g.get("frame_idx", 0)), length))
    calls = []
    n_seg = len(plan)
    for i, L in enumerate(plan, start=1):
        c = CallSpec(index=i, count=n_seg, frames=L, width=width, height=height,
                     mode="ref" if is_ref else "fl2v",
                     ref_image_size=str(params.get("ref_image_size") or "match"))
        if is_ref:
            c.pictures = pics[:H3_MAX_REF_IMAGES]
            c.ref_videos = vids
            c.ref_audios = auds
            c.guides = guides
        else:
            n_kf = len(pics)
            has_first = n_kf >= 1 and i == 1
            has_last = n_kf >= 2 and i == n_seg
            c.keyframes = int(has_first) + int(has_last)
        if n_seg > 1 and i > 1:
            c.chain_context = (chain_mode, overlap)
        calls.append(c)
    return calls, errs


# ─────────────────────────────────────────────────────────────────────────
# (1) 参照の上限と <Picture N> 等の番号
# ─────────────────────────────────────────────────────────────────────────
def reference_problems(params: dict, calls: list[CallSpec]) -> list[str]:
    errs: list[str] = []
    if str(params.get("model", "")) != "minimax-h3-ref":
        return errs
    n_img = len(params.get("keyframes") or [])
    n_vid = len(_ids(params.get("ref_video_asset_ids")))
    n_aud = len(_ids(params.get("ref_audio_asset_ids")))
    if n_img > H3_MAX_REF_IMAGES:
        errs.append(f"参照画像が {n_img} 枚(H3 Ref2VA の上限 {H3_MAX_REF_IMAGES} 枚)。"
                    f"10 枚目以降は黙って捨てられるので投入しない")
    if n_vid > H3_MAX_REF_VIDEOS:
        errs.append(f"参照動画が {n_vid} 本(上限 {H3_MAX_REF_VIDEOS} 本)")
    if n_aud > H3_MAX_REF_AUDIOS:
        errs.append(f"参照音声が {n_aud} 本(上限 {H3_MAX_REF_AUDIOS} 本)")
    if n_img + n_vid + n_aud > H3_MAX_REF_FILES:
        errs.append(f"参照ファイルが合計 {n_img + n_vid + n_aud} 個(上限 {H3_MAX_REF_FILES} 個)")
    if n_img + n_vid + n_aud == 0:
        errs.append("Ref2VA には参照(画像/動画/音声)が最低 1 つ必要")
    ris = params.get("ref_image_size")
    if ris not in (None, "", "match", "max"):
        errs.append(f"ref_image_size は match / max: {ris!r}")
    # 参照動画の長さ: 各生成が実際に受け取る分(ComfyUI は生成長で先頭から切る)
    for c in calls:
        F = align_frame_count(max(5, c.frames))
        used = []
        for k, (_, _, nf, _) in enumerate(c.ref_videos, start=1):
            if nf < H3_REF_VIDEO_MIN_FRAMES:
                errs.append(f"<Video {k}> が {nf} フレームしかない(最低 {H3_REF_VIDEO_MIN_FRAMES} フレーム)")
                continue
            u = align_down(min(nf, F))
            used.append(u)
            if u > H3_REF_VIDEO_MAX_FRAMES:
                errs.append(f"<Video {k}> が 1 回の生成で {u}f({u / H3_FPS:.2f} 秒)使われる"
                            f"(上限 {H3_REF_VIDEO_MAX_FRAMES}f = 15 秒)")
        if sum(used) > H3_REF_VIDEO_TOTAL_MAX_FRAMES:
            seg = f"セグメント {c.index}/{c.count} で" if c.count > 1 else ""
            errs.append(f"参照動画の合計が{seg} {sum(used)}f({sum(used) / H3_FPS:.2f} 秒)"
                        f"(上限 合計 {H3_REF_VIDEO_TOTAL_MAX_FRAMES}f = 15 秒)")
    # 生成ごとに同じ参照を受けるので、メッセージは 1 回に畳む
    errs = list(dict.fromkeys(errs))
    # プロンプトの番号
    prompt = str(params.get("prompt") or "")
    n_audio_labels = n_aud + (n_vid if params.get("use_ref_video_audio") else 0)
    for kind, n in (("Picture", min(n_img, H3_MAX_REF_IMAGES)), ("Video", min(n_vid, H3_MAX_REF_VIDEOS)),
                    ("Audio", n_audio_labels)):
        used = sorted({int(x) for x in _TAG_RE[kind].findall(prompt)})
        bad = [u for u in used if u < 1 or u > n]
        if bad:
            errs.append(f"プロンプトが <{kind} {bad[0]}> を参照しているが、渡す{kind}は {n} 個"
                        f"(該当: {', '.join(f'<{kind} {b}>' for b in bad)})")
    # ガイドの位置(ComfyUI MiniMaxH3AddGuide と同じ判定。外れると実行中に例外になる)
    for c in calls:
        F = align_frame_count(max(5, c.frames))
        for fi, gf in c.guides:
            n = 1 if gf < 5 else align_down(gf)
            pos = fi if fi >= 0 else F + fi
            if pos < 0 or pos + n > F:
                seg = f"(セグメント {c.index}/{c.count})" if c.count > 1 else ""
                errs.append(f"ガイド frame_idx={fi}({n} フレーム)が生成 {F}f の外{seg}")
    return list(dict.fromkeys(errs))


def token_estimates(params: dict, calls: list[CallSpec]) -> list[Estimate]:
    prompt = str(params.get("prompt") or "")
    return [estimate_call(prompt, c) for c in calls]


def token_problems(params: dict, estimates: list[Estimate]) -> list[str]:
    limit = max_seq_tokens(params)
    over = [e for e in estimates if e.total > limit]
    if not over:
        return []
    worst = max(over, key=lambda e: e.total)
    more = f"(ほか {len(over) - 1} セグメントも超過)" if len(over) > 1 else ""
    return [f"H3 の系列長が上限を超える: 推定 {worst.total:,} > 上限 {limit:,}{more}。"
            f"内訳 {worst.breakdown()}。{ADVICE}"]


# ─────────────────────────────────────────────────────────────────────────
# 入口
# ─────────────────────────────────────────────────────────────────────────
def check_job(params: dict, resolve: Resolver, provided: Iterable[str] | None = None) -> list[str]:
    """H3 ジョブの全検査。問題のリスト(空なら合格)。H3 以外のモデルは常に空。"""
    if str(params.get("model", "")) not in H3_MODELS:
        return []
    errs = tier_problems(params, provided)
    if params.get("h3_max_seq_tokens") not in (None, ""):
        try:
            if int(params["h3_max_seq_tokens"]) <= 0:
                raise ValueError
        except (TypeError, ValueError):
            errs.append(f"h3_max_seq_tokens は正の整数: {params.get('h3_max_seq_tokens')!r}")
            return errs
    eff, _ = apply_quality_preset(params)
    unknown: list[str] = []
    try:
        calls, res_errs = plan_calls(eff, resolve, unknown)
    except (TypeError, ValueError) as e:
        return errs + [f"H3 パラメータを解釈できない: {e}"]
    errs += res_errs
    if str(eff.get("model")) == "minimax-h3" and not (eff.get("keyframes") or []):
        errs.append("minimax-h3(FL2VA)には最低 1 枚のキーフレーム(先頭フレーム)が必要")
    errs += reference_problems(eff, calls)
    if unknown:
        # 測れない素材があるときは系列長の見積りだけ省く(止めない)。数の上限と番号は上で検査済み
        log.warning("H3 系列長の見積りを省略(素材を測れない): %s", unknown)
    elif calls and not res_errs:
        errs += token_problems(eff, token_estimates(eff, calls))
    return errs


def session_resolver(session) -> Resolver:
    from app.models import Asset
    return lambda aid: session.get(Asset, aid)


def check_submission(project_id: int, job_type: str, params: dict, session,
                     provided: Iterable[str] | None = None) -> list[str]:
    """ジョブ作成の窓口(POST /jobs/・/generation/video/i2v・夜間バッチ・エージェント)から呼ぶ。"""
    if job_type != "generate_video_i2v":
        return []
    try:
        return check_job(params or {}, session_resolver(session), provided)
    except Exception as e:
        # 検査そのものの不具合で投入を全部止めないよう、見積り側の例外は記録して通す。
        # ただし T3 の明示チェック(単純な辞書検査)だけは必ず効かせる。
        log.exception("H3 事前検査が例外で失敗(T3 の明示チェックだけ行い、残りは通す): %s", e)
        if str((params or {}).get("model", "")) not in H3_MODELS:
            return []
        return tier_problems(params or {}, provided)
