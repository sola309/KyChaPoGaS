"""
🌧 雨フィルター — タイムラインで強さ・粒・ぼかしを調整できる雨(2026-10-15、ポッキー2026 C23〜28)。

雨は「そのカットの元動画に描かれている雨筋」だけを取り出して使う。使い回しの素材や、
一様な合成の雨は使わない(10/14 ユーザー:「同じ素材の使いまわし感や機械的に均質な不自然な雨しか
合成できないと判断した場合には却下」)。取り出しの数式は
outputs/pocky2026/v13/fix1013/night/rain_layer.py と同じ(数式は変えていない):

  雨の層(元の各コマ i、白黒): 正の残り r = i − 前後 ±3 コマの中央値(動くものだけ) → 縦 1×L の線で開いた r −
  5×5 で開いた r(細くて縦に長いものだけ) → 前後 gap コマの近くにも出る筋(柱・手すりの縁)を引く →
  しきい値 t0〜t1 で 0→1 → 幅 wmax / 高さ hmax を超える・高さ 6 未満のかたまりを外す →
  twinkle(筋ごとの明るさのばらつき)・glint(しずくの光の点)→ ぼかし blur(cut コマ目からは blur2)→
  lit(明かりの近くほど明るく)→ glow(まわりのやわらかな光)→ 上限 1/k。
  重ねる色 rain = clip(g×0.35+0.72)(その場所の下の絵 g を明るくした色)、a3 = al×k。

タイムライン上のしくみ:
  - 雨クリップ = kind 'rain' のクリップ。素材は「黒地に雨だけ」の層 L = rain×a3 の動画(rain_layer.py の
    重ねた結果 o = 1−(1−g)(1−rain×a3) の rain×a3 そのもの)。blend 'screen' で下に重ねるので
    screen(g, L) = 元の重ねた結果に戻る。書き出し(ffmpeg blend screen + all_opacity)もプレビュー
    (canvas 'screen' + globalAlpha)も「不透明度 a = L を a 倍して screen」なので、同じ層・同じ重ね方で一致する。
  - クリップの不透明度 = 強さ(すぐ反映)。それ以外の設定は attrs_json {"rain": {...}} に持ち、
    「雨を作り直す」(ジョブ render_rain_layer、軽いレーン・CPU のみ)で層を作り直してクリップの素材を差し替える。
    前の層はアセットとして残る(gen_params_json の "rain_fx")ので、テイクとして戻せる(GET /api/rain/clips/{id}/takes)。
  - 元動画 = Video トラックの素材(attrs.rain.src_asset_id / src_offset、無ければ Video トラックから解決)。
    下の絵 g = 雨クリップより下の映像レイヤーで、そのコマを覆う最前面のクリップ(Shots の生成)。

このファイルは単体でも動く(サブプロセスで計算する): python -m app.services.rain_fx <plan.json>
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator, Optional

import numpy as np

log = logging.getLogger("rain_fx")

JOB_TYPE = "render_rain_layer"
CLIP_KIND = "rain"
BACKEND_DIR = Path(__file__).resolve().parent.parent.parent

# ── 設定 ─────────────────────────────────────────────────────────────────────
# key: (型, 既定値, 下限, 上限)。既定値は rain_layer.py と同じ。ただし k は 1.0
# (rain_layer.py の既定 0.8 は「不透明度 80%」で同じ見た目になる。強さはクリップの不透明度で持つ)。
SPEC: dict[str, tuple[type, object, float, float]] = {
    "k":       (float, 1.0, 0.0, 4.0),     # 層に焼き込む濃さの倍率(上限 1/k で頭打ち)
    "L":       (int,   9,   1, 61),        # 縦の線の長さ(これより短い筋は消える)
    "t0":      (float, 3.0, 0.0, 100.0),   # これより淡い筋は消す(量)
    "t1":      (float, 14.0, 0.0, 120.0),  # ここで濃さが最大
    "wmax":    (int,   5,   1, 40),        # かたまりの幅の上限 px(太い筋を外す)
    "hmax":    (int,   90,  1, 3000),      # かたまりの高さの上限 px(長い筋を外す)
    "gap":     (int,   1,   1, 4),         # 前後何コマと比べるか(2 コマ打ちの雨は 2)
    "blur":    (float, 0.6, 0.0, 8.0),     # 筋のぼかし σ
    "lit":     (float, 0.0, 0.0, 1.0),     # 明かりの近くの筋ほど明るく
    "glow":    (float, 0.0, 0.0, 4.0),     # 筋のまわりのやわらかな光
    "twinkle": (float, 0.0, 0.0, 1.0),     # 筋 1 本ずつの明るさのばらつき
    "glint":   (float, 0.0, 0.0, 3.0),     # しずくの光の点
    "cut":     (int,   0,   0, 100000),    # このコマ(クリップ先頭から)以降は blur2 でぼかす(0 = なし)
    "blur2":   (float, None, 0.0, 8.0),    # 寄りでのぼかし σ(None = blur と同じ)
}
META_INT = ("src_asset_id", "src_offset")   # 元動画の素材と「元のコマ − タイムラインのコマ」


def normalize(raw: dict | None, base: dict | None = None) -> dict:
    """設定を正規化する(base に raw を重ね、型・範囲をそろえる)。知らないキーは捨てる。"""
    d: dict = {}
    for src in (base or {}, raw or {}):
        if isinstance(src, dict):
            d.update(src)
    out: dict = {}
    for key, (typ, default, lo, hi) in SPEC.items():
        v = d.get(key, default)
        if v is None or v == "":
            out[key] = default
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            out[key] = default
            continue
        if not math.isfinite(fv):
            out[key] = default
            continue
        fv = min(hi, max(lo, fv))
        out[key] = int(round(fv)) if typ is int else round(fv, 4)
    # t1 は t0 より大きく(rain_layer.py は (t − t0)/(t1 − t0) で割る)
    if out["t1"] <= out["t0"]:
        out["t1"] = round(out["t0"] + 0.5, 4)
    for key in META_INT:
        v = d.get(key)
        if v is None or v == "":
            continue
        try:
            out[key] = int(v)
        except (TypeError, ValueError):
            pass
    return out


def clamp_opacity(v) -> float:
    """雨クリップの強さ(不透明度)を 0.01〜1 にそろえる。0 は使わない: 書き出し(ffmpeg_render)は
    不透明度 0 を 1.0 として扱う(`opacity or 1.0`)ので、プレビューは雨なし・書き出しは雨 100% になってしまう。"""
    try:
        f = float(1.0 if v is None else v)
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(f):
        return 1.0
    return max(0.01, min(1.0, f))


def settings_equal(a: dict | None, b: dict | None) -> bool:
    na, nb = normalize(a), normalize(b)
    return all(na.get(k) == nb.get(k) for k in SPEC)


# ── 計算(rain_layer.py と同じ式) ──────────────────────────────────────────────

def median7_u8(frames) -> np.ndarray:
    """7 枚の uint8 画像の画素ごとの中央値(N. Devillard の opt_med7 の比較網、13 回の比較)。
    7 個の中央値は 4 番目に小さい値そのものなので、np.median(float32) と同じ値になる。"""
    p = [np.array(f, dtype=np.uint8, copy=True) for f in frames]

    def srt(a: int, b: int) -> None:
        lo_ = np.minimum(p[a], p[b]); np.maximum(p[a], p[b], out=p[b]); p[a] = lo_

    for a, b in ((0, 5), (0, 3), (1, 6), (2, 4), (0, 1), (3, 5), (2, 6), (2, 3), (3, 6), (4, 5), (1, 4), (1, 3), (3, 4)):
        srt(a, b)
    return p[3]


class RainLayer:
    """元動画の白黒コマ gray(長さ N+10。gray[j] = 層の (j−5) コマ目の元のコマ)から、層の k コマ目を作る。

    rain_layer.py との違いは計算の順番と持ち方だけ: thin_at を 1 コマにつき 1 回だけ計算して使い回す
    (元は 3 回)、白黒コマを uint8 で持って使うときに float32 にする(値は同じ)、σ=0 のぼかしは飛ばす
    (元は OpenCV がエラーで止まる)。式・乱数の種・しきい値は同じ。
    """

    def __init__(self, gray: list, s: dict):
        import cv2
        self.cv2 = cv2
        self.g = gray
        self.M = len(gray)
        self.s = s
        self.K = float(s["k"]); self.L = int(s["L"]); self.T0 = float(s["t0"]); self.T1 = float(s["t1"])
        self.HMAX = int(s["hmax"]); self.WMAX = int(s["wmax"]); self.D = int(s["gap"])
        self.BLUR = float(s["blur"]); self.LIT = float(s["lit"]); self.GLOW = float(s["glow"])
        self.TW = float(s["twinkle"]); self.GLINT = float(s["glint"]); self.CUT = int(s["cut"])
        b2 = s.get("blur2")
        self.BLUR2 = float(self.BLUR if b2 is None else b2)
        self.vline = cv2.getStructuringElement(cv2.MORPH_RECT, (1, self.L))
        self.blob = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        self.hdil = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 3))
        self._thin: dict[int, np.ndarray] = {}

    def thin_at(self, i: int) -> np.ndarray:
        t = self._thin.get(i)
        if t is not None:
            return t
        cv2 = self.cv2
        lo, hi = max(0, i - 3), min(self.M, i + 4)
        if hi - lo == 7:
            bg = median7_u8(self.g[lo:hi]).astype(np.float32)   # np.median と同じ値(7 個の 4 番目)。速い
        else:
            bg = np.median(np.stack(self.g[lo:hi]).astype(np.float32), axis=0)
        r = np.clip(self.g[i].astype(np.float32) - bg, 0, 255)
        t = np.clip(cv2.morphologyEx(r, cv2.MORPH_OPEN, self.vline) - cv2.morphologyEx(r, cv2.MORPH_OPEN, self.blob), 0, 255)
        self._thin[i] = t
        return t

    def _evict(self, below: int) -> None:
        for j in [j for j in self._thin if j < below]:
            del self._thin[j]

    def layer(self, k: int) -> np.ndarray:
        cv2 = self.cv2
        i = k + 5
        D_ = self.D
        self._evict(i - D_)
        t = self.thin_at(i)
        # 1 コマだけに出る筋だけ(雨は 1 コマで遠くへ落ちる。カメラで少しずつ動く柱・手すりの縁は前後のコマの近くにも出る)
        nb = np.maximum(cv2.dilate(self.thin_at(i - D_), self.hdil), cv2.dilate(self.thin_at(i + D_), self.hdil))
        t = np.clip(t - nb, 0, 255)
        al = np.clip((t - self.T0) / (self.T1 - self.T0), 0, 1)
        # 長すぎる・太すぎるかたまり(柱・手すり・髪)を外す
        n, lab_, st, _ = cv2.connectedComponentsWithStats((al > 0.25).astype(np.uint8), 8)
        bad = np.zeros(n, bool)
        bad[1:] = (st[1:, cv2.CC_STAT_HEIGHT] > self.HMAX) | (st[1:, cv2.CC_STAT_WIDTH] > self.WMAX) | (st[1:, cv2.CC_STAT_HEIGHT] < 6)
        m = cv2.dilate((~bad[lab_]).astype(np.uint8) * (lab_ > 0), np.ones((3, 3), np.uint8)).astype(np.float32)
        if self.TW:
            rng = np.random.default_rng(1000 + k); f = 1 + self.TW * (2 * rng.random(n) - 1); f[0] = 0
            m = m * cv2.dilate(f[lab_].astype(np.float32), np.ones((3, 3), np.uint8))
        out = al * m
        if self.GLINT:
            rng = np.random.default_rng(2000 + k); gl = np.zeros_like(out)
            for c in np.where(~bad)[0][1:]:
                if rng.random() < 0.5:
                    x = st[c, cv2.CC_STAT_LEFT] + st[c, cv2.CC_STAT_WIDTH] // 2; y = st[c, cv2.CC_STAT_TOP] + st[c, cv2.CC_STAT_HEIGHT] - 1
                    gl[y, x] = 1.0
            gl = cv2.GaussianBlur(gl, (0, 0), 1.3); gl = gl / max(gl.max(), 1e-6) * self.GLINT if gl.max() > 0 else gl
            out = np.maximum(out, gl)
        return out

    def alpha(self, k: int, tgt: np.ndarray) -> np.ndarray:
        """ぼかし・明かり・光まで済ませた al(上限 1/k で切ったもの)。tgt = 下の絵(BGR uint8)。"""
        cv2 = self.cv2
        al = self.layer(k)
        sig = self.BLUR2 if self.CUT and k >= self.CUT else self.BLUR
        if sig > 0:
            al = cv2.GaussianBlur(al, (0, 0), sig)
        LIT, GLOW, K = self.LIT, self.GLOW, self.K
        if LIT:
            lm = cv2.GaussianBlur(cv2.cvtColor(tgt, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 30)
            lm = np.clip((lm - np.percentile(lm, 5)) / max(np.percentile(lm, 99.5) - np.percentile(lm, 5), 1), 0, 1)
            al = al * ((1 - LIT) + LIT * 1.6 * lm)
        if GLOW:
            al = al + GLOW * cv2.GaussianBlur(al, (0, 0), 3.5)
        return np.clip(al, 0, 1.0 / max(K, 1e-3))

    def frame(self, k: int, tgt: np.ndarray) -> tuple[np.ndarray, float]:
        """層の k コマ目(BGR uint8、黒地に雨)と、雨が覆う割合 %(rain_layer.py の cover と同じ)。"""
        al = self.alpha(k, tgt)
        g = tgt.astype(np.float32) / 255
        rain = np.clip(g * 0.35 + 0.72, 0, 1)                       # その場所の色を明るくした雨の色
        a3 = (al * self.K)[..., None]
        L = rain * a3                                                # screen で足すもの(o = 1−(1−g)(1−L))
        return np.clip(L * 255 + 0.5, 0, 255).astype(np.uint8), float((al > 0.3).mean()) * 100


def screen_u8(base: np.ndarray, layer: np.ndarray, opacity: float = 1.0) -> np.ndarray:
    """確認用: 8bit の screen(不透明度つき)。書き出しの ffmpeg blend=screen:all_opacity と同じ式。"""
    b = base.astype(np.float32); l_ = layer.astype(np.float32)
    s = 255 - (255 - b) * (255 - l_) / 255
    return np.clip(b + (s - b) * float(opacity) + 0.5, 0, 255).astype(np.uint8)


# ── 読み書き ─────────────────────────────────────────────────────────────────

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def ffmpeg_exe() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def iter_frames(path: str, start: int, n: int, w: int, h: int, step: float = 1.0) -> Iterator[np.ndarray]:
    """素材の start コマ目から n コマを BGR uint8 で返す(BT.709 で読む。cmp_takes.decode と同じ読み方)。

    start < 0 は先頭のコマ、素材の終わりより先は最後のコマで埋める。step ≠ 1(速度つきのクリップ)は
    j コマ目に start + floor(j×step) コマ目を使う。画像は 1 枚を繰り返す。"""
    if n <= 0:
        return
    if Path(path).suffix.lower() in _IMAGE_EXTS:
        img = next(_decode(path, 0, 1, w, h), None)
        if img is None:
            raise RuntimeError(f"画像を読めませんでした: {path}")
        for _ in range(n):
            yield img
        return
    step = float(step) if step and step > 0 else 1.0
    want = [start + int(math.floor(j * step + 1e-9)) for j in range(n)]
    lo, hi = max(0, want[0]), max(0, want[-1])
    src = _decode(path, lo, hi - lo + 1, w, h)
    cur_idx, cur = lo - 1, None
    for wi in want:
        wi = max(lo, wi)
        while cur_idx < wi:
            nxt = next(src, None)
            if nxt is None:
                break                      # 素材の終わり: 最後のコマで埋める
            cur, cur_idx = nxt, cur_idx + 1
        if cur is None:                    # 1 コマも読めない(壊れた・無いファイル、範囲外)は黒で埋めずに止める
            src.close()
            raise RuntimeError(f"動画を読めませんでした({lo} コマ目〜): {path}")
        yield cur
    src.close()


def _decode(path: str, start: int, n: int, w: int, h: int) -> Iterator[np.ndarray]:
    vf = (f"select=gte(n\\,{start}),setpts=PTS-STARTPTS,scale={w}:{h}:in_color_matrix=bt709:in_range=tv,format=bgr24"
          if start else f"scale={w}:{h}:in_color_matrix=bt709:in_range=tv,format=bgr24")
    cmd = [ffmpeg_exe(), "-nostdin", "-v", "error", "-i", str(path), "-vf", vf, "-frames:v", str(n), "-f", "rawvideo", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = w * h * 3
    try:
        for _ in range(n):
            b = p.stdout.read(size)
            if not b or len(b) < size:
                break
            yield np.frombuffer(b, np.uint8).reshape(h, w, 3)
    finally:
        try:
            p.stdout.close()
        except Exception:
            pass
        if p.poll() is None:
            p.kill()
        p.wait()


def _encoder(out: str, w: int, h: int, fps: float) -> subprocess.Popen:
    # rain_layer.py と同じ書き出し(BT.709・tv・crf 12)
    return subprocess.Popen(
        [ffmpeg_exe(), "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
         "-r", f"{fps:g}", "-i", "-",
         "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-crf", "12",
         "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
         "-movflags", "+faststart", out],
        stdin=subprocess.PIPE)


def iter_base(plan: dict) -> Iterator[np.ndarray]:
    """下の絵(g)を層のコマ順に返す。plan["base"] の区間(f0..f1、層のコマ)ごとに素材を読む。区間外は黒。"""
    w, h, n = plan["width"], plan["height"], plan["n"]
    segs = sorted(plan.get("base") or [], key=lambda s: s["f0"])
    black = np.zeros((h, w, 3), np.uint8)
    f = 0
    for s in segs:
        f0, f1 = max(f, int(s["f0"])), min(n, int(s["f1"]))
        if f1 <= f0:
            continue
        while f < f0:
            yield black; f += 1
        sp = float(s.get("speed", 1.0) or 1.0)
        idx0 = int(s["idx0"]) + int(math.floor((f0 - int(s["f0"])) * sp + 1e-9))
        for fr in iter_frames(s["path"], idx0, f1 - f0, w, h, sp):
            yield fr; f += 1
    while f < n:
        yield black; f += 1


def render_plan(plan: dict, progress: Optional[Callable[[float], None]] = None) -> dict:
    """plan(build_plan が作る)に従って層を作り、plan["out"] へ書く。CPU のみ。"""
    import cv2
    try:
        cv2.setNumThreads(int(plan.get("threads", 4)))
    except Exception:
        pass
    t_start = time.time()
    w, h, n, fps = int(plan["width"]), int(plan["height"]), int(plan["n"]), float(plan["fps"])
    s = normalize(plan["rain"])
    src = plan["src"]
    # 元のコマ: 層の 0 コマ目 = 元の src.start コマ目。前後 5 コマずつ余分に読む(rain_layer.py と同じ N+10)
    gray = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
            for f in iter_frames(src["path"], int(src["start"]) - 5, n + 10, w, h)]
    t_dec = time.time()
    ex = RainLayer(gray, s)
    out = str(plan["out"])
    tmp = out + ".part.mp4"
    enc = _encoder(tmp, w, h, fps)
    covers = []
    try:
        for k, tgt in enumerate(iter_base(plan)):
            lay, cov = ex.frame(k, np.ascontiguousarray(tgt))
            enc.stdin.write(lay.tobytes())
            covers.append(cov)
            if progress and (k % 4 == 3 or k == n - 1):
                progress((k + 1) / n)
        enc.stdin.close()
        if enc.wait() != 0:
            raise RuntimeError("雨の層の書き出しに失敗しました(ffmpeg)")
    except BaseException:
        try:
            enc.kill()
        except Exception:
            pass
        Path(tmp).unlink(missing_ok=True)
        raise
    os.replace(tmp, out)
    return {"out": out, "frames": len(covers), "cover_mean": round(float(np.mean(covers)) if covers else 0.0, 4),
            "cover_max": round(float(np.max(covers)) if covers else 0.0, 4),
            "sec_decode": round(t_dec - t_start, 2), "sec_total": round(time.time() - t_start, 2)}


# ── 計画(DB から: 元動画・下の絵・出力先) ────────────────────────────────────

def _is_image(asset) -> bool:
    return asset.asset_type == "image" or (asset.asset_type == "generated" and asset.duration_sec is None)


def parse_attrs(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else {}
    except (ValueError, TypeError):
        return {}


def resolve_source(session, project_id: int, start: int, settings: dict) -> tuple[int, int]:
    """元動画の (asset_id, src_offset)。設定に無ければ Video トラック(無ければ最下段の映像トラック)の、
    start を覆うクリップから取る。src_offset = 元のコマ − タイムラインのコマ。"""
    from sqlmodel import select
    from app.models import Asset, Clip, Track
    aid = settings.get("src_asset_id")
    if aid:
        if not session.get(Asset, int(aid)):
            raise ValueError(f"元動画の素材 {aid} が見つかりません")
        return int(aid), int(settings.get("src_offset", 0) or 0)
    vts = session.exec(select(Track).where(Track.project_id == project_id, Track.track_type == "video")).all()
    named = [t for t in vts if t.name == "Video"]
    cands = named or sorted(vts, key=lambda t: -t.order)[:1]
    for t in cands:
        for c in session.exec(select(Clip).where(Clip.track_id == t.id, Clip.asset_id.is_not(None))).all():
            if c.start_frame <= start < c.start_frame + c.duration_frames:
                return int(c.asset_id), int(c.asset_in_frame) - int(c.start_frame)
    raise ValueError("元動画が見つかりません(Video トラックにこの位置を覆う素材がありません)")


def resolve_base(session, project_id: int, track, start: int, n: int) -> list[dict]:
    """下の絵の区間。雨クリップより下(order が大きい)の、隠していない映像トラックを上から順に見て、
    コマごとに「覆う最前面のクリップ」を選ぶ(雨・単色・ぼかし・撮影は除く)。"""
    from sqlmodel import select
    from app.models import Asset, Clip, Track
    from app.services.ffmpeg_render import FILTER_KINDS
    below = [t for t in session.exec(select(Track).where(Track.project_id == project_id, Track.track_type == "video")).all()
             if t.order > track.order and not t.hidden]
    below.sort(key=lambda t: t.order)
    lanes = []
    for t in below:
        cs = [c for c in session.exec(select(Clip).where(Clip.track_id == t.id, Clip.asset_id.is_not(None))).all()
              if (c.kind or "media") not in (CLIP_KIND, *FILTER_KINDS)
              and c.start_frame < start + n and c.start_frame + c.duration_frames > start]
        lanes.append(sorted(cs, key=lambda c: (c.start_frame, c.id)))
    pick: list = []
    for f in range(start, start + n):
        hit = None
        for cs in lanes:
            for c in cs:   # 同じレイヤーで重なるときは後から始まるクリップが上
                if c.start_frame <= f < c.start_frame + c.duration_frames:
                    hit = c
            if hit is not None:
                break
        pick.append(hit)
    segs: list[dict] = []
    k = 0
    while k < n:
        c = pick[k]
        k1 = k
        while k1 < n and pick[k1] is c:
            k1 += 1
        if c is not None:
            a = session.get(Asset, c.asset_id)
            if a is not None and Path(a.file_path).exists():
                sp = float(c.speed or 1.0)
                segs.append({"f0": k, "f1": k1, "path": a.file_path, "image": _is_image(a),
                             "idx0": int(c.asset_in_frame) + int(math.floor((start + k - c.start_frame) * sp + 1e-9)),
                             "speed": sp, "clip_id": c.id, "asset_id": a.id,
                             "approx": bool((c.remap_json or "").strip() or (c.speed_ease or "linear") != "linear")})
        k = k1
    return segs


def build_plan(job_id: int, params: dict, out_dir: Path) -> dict:
    """ジョブのパラメータから計算の計画を作る(DB を読むだけ。書かない)。"""
    from sqlmodel import Session
    from app.db.database import engine
    from app.models import Asset, Clip, Project, Track
    with Session(engine) as session:
        project_id = int(params["project_id"])
        proj = session.get(Project, project_id)
        if not proj:
            raise ValueError(f"プロジェクト {project_id} が見つかりません")
        create = params.get("create")
        if params.get("clip_id"):
            clip = session.get(Clip, int(params["clip_id"]))
            if not clip:
                raise ValueError(f"クリップ {params['clip_id']} が見つかりません(削除された?)")
            track = session.get(Track, clip.track_id)
            start, n = int(clip.start_frame), int(clip.duration_frames)
            cur = parse_attrs(clip.attrs_json).get("rain") or {}
        elif isinstance(create, dict):
            clip = None
            track = session.get(Track, int(create["track_id"]))
            start, n = int(create["start_frame"]), int(create["duration_frames"])
            cur = {}
        else:
            raise ValueError("clip_id か create が必要です")
        if not track or track.project_id != project_id or track.track_type != "video":
            raise ValueError("雨クリップは映像トラックに置いてください")
        if n < 1 or n > 2400:
            raise ValueError(f"雨クリップの長さが範囲外です({n} コマ)")
        s = normalize(params.get("rain"), base=cur)
        src_aid, src_off = resolve_source(session, project_id, start, s)
        s["src_asset_id"], s["src_offset"] = src_aid, src_off
        src_asset = session.get(Asset, src_aid)
        base = resolve_base(session, project_id, track, start, n)
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / f"rain_f{start}_n{n}_j{job_id}.mp4"
        return {"job_id": job_id, "project_id": project_id, "clip_id": clip.id if clip else None,
                "create": create if clip is None else None,
                "track_id": track.id, "start": start, "n": n,
                "width": int(proj.width), "height": int(proj.height), "fps": float(proj.fps),
                "rain": s, "src": {"path": src_asset.file_path, "start": start + src_off, "asset_id": src_aid},
                "base": base, "out": str(out), "threads": int(params.get("threads", 4))}


# ── ジョブ ───────────────────────────────────────────────────────────────────

def _job_status(job_id: int) -> str:
    from sqlmodel import Session
    from app.db.database import engine
    from app.models import Job
    with Session(engine) as session:
        j = session.get(Job, job_id)
        return j.status if j else "missing"


def _set_result_json(job_id: int, data: dict) -> None:
    from sqlmodel import Session
    from app.db.database import engine
    from app.models import Job
    with Session(engine) as session:
        j = session.get(Job, job_id)
        if j:
            j.result_json = json.dumps(data, ensure_ascii=False)
            session.add(j)
            session.commit()


def _finish(plan: dict, stats: dict) -> dict:
    """層をアセットに登録し、クリップの素材を差し替える(create のときはクリップを作る)。"""
    from sqlmodel import Session
    from app.db.database import engine
    from app.models import Asset, Clip
    from app.services.media_info import probe
    out = Path(plan["out"])
    info = probe(out)
    s = dict(plan["rain"])
    gen = {"rain_fx": {**s, "clip_id": plan["clip_id"], "track_id": plan["track_id"],
                       "start_frame": plan["start"], "duration_frames": plan["n"], "job_id": plan["job_id"],
                       "base": [{k: b[k] for k in ("f0", "f1", "clip_id", "asset_id")} for b in plan["base"]],
                       "cover_mean": stats.get("cover_mean"), "sec": stats.get("sec_total")}}
    result: dict = {"stats": stats}
    with Session(engine) as session:
        asset = Asset(project_id=plan["project_id"], name=out.name, asset_type="generated",
                      file_path=str(out), duration_sec=info.duration_sec, width=info.width, height=info.height,
                      file_size_bytes=info.file_size_bytes, gen_params_json=json.dumps(gen, ensure_ascii=False))
        # プロキシは作らない: 640px・crf28 だと 1〜2px の雨筋が消え、プレビューと書き出しが合わなくなる
        session.add(asset)
        session.commit()
        session.refresh(asset)
        aid = asset.id
        result["asset_id"] = aid
        meta = {**s, "job_id": plan["job_id"], "asset_id": aid, "rendered_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "base_asset_ids": sorted({b["asset_id"] for b in plan["base"]})}
        if plan.get("clip_id"):
            clip = session.get(Clip, int(plan["clip_id"]))
            note = ""
            if clip is None:
                note = "クリップが消えていたので差し替えませんでした(層はテイクとして残しました)"
            elif clip.locked:
                note = "クリップが🔒ロック中なので差し替えませんでした(層はテイクとして残しました)"
            elif (clip.start_frame, clip.duration_frames, clip.track_id) != (plan["start"], plan["n"], plan["track_id"]):
                note = "作り直しの間にクリップが動いたので差し替えませんでした(もう一度「雨を作り直す」を押してください)"
            if note:
                result.update(swapped=False, note=note)
            else:
                attrs = parse_attrs(clip.attrs_json)
                attrs["rain"] = meta
                clip.asset_id = aid
                clip.asset_in_frame = 0
                clip.kind = CLIP_KIND
                clip.attrs_json = json.dumps(attrs, ensure_ascii=False)
                session.add(clip)
                session.commit()
                result.update(swapped=True, clip_id=clip.id)
        else:
            c = plan["create"] or {}
            clip = Clip(track_id=plan["track_id"], asset_id=aid, start_frame=plan["start"],
                        duration_frames=plan["n"], asset_in_frame=0, kind=CLIP_KIND, blend="screen",
                        opacity=clamp_opacity(c.get("opacity")),
                        attrs_json=json.dumps({"rain": meta}, ensure_ascii=False))
            session.add(clip)
            session.commit()
            session.refresh(clip)
            gen["rain_fx"]["clip_id"] = clip.id
            a = session.get(Asset, aid)
            a.gen_params_json = json.dumps(gen, ensure_ascii=False)
            session.add(a)
            session.commit()
            result.update(swapped=True, clip_id=clip.id, created=True)
    try:
        from app.services.thumbnail import generate_video_thumbnail
        generate_video_thumbnail(out, aid)
    except Exception as e:  # サムネイルは無くてもよい
        log.warning(f"rain thumbnail failed: {e}")
    return result


async def run_job(job, params: dict) -> None:
    """ジョブ render_rain_layer の本体(job_runner._dispatch から呼ぶ)。計算は nice したサブプロセスで行う。"""
    from app.services.job_runner import GENERATED_DIR, _update_progress, _update_result_assets, _update_phase
    out_dir = GENERATED_DIR / str(params["project_id"])
    if _job_status(job.id) == "cancelled":
        return
    plan = await asyncio.to_thread(build_plan, job.id, params, out_dir)
    plan_file = out_dir / f"rain_plan_j{job.id}.json"
    plan_file.write_text(json.dumps(plan, ensure_ascii=False))
    _update_phase(job.id, "雨の層を作っています(CPU)")
    _update_progress(job.id, 0.03)
    env = {**os.environ, "PYTHONPATH": str(BACKEND_DIR) + os.pathsep + os.environ.get("PYTHONPATH", "")}
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "app.services.rain_fx", str(plan_file), cwd=str(BACKEND_DIR), env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    err_task = asyncio.create_task(proc.stderr.read())
    stats: dict = {}
    last_check = time.monotonic()
    cancelled = False
    try:
        while True:
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), 1.0)
            except asyncio.TimeoutError:
                line = None
            if line == b"":
                break
            if line:
                try:
                    msg = json.loads(line)
                except ValueError:
                    msg = {}
                if "p" in msg:
                    _update_progress(job.id, 0.03 + 0.9 * float(msg["p"]))
                if msg.get("done"):
                    stats = msg.get("stats") or {}
            if time.monotonic() - last_check > 1.0:
                last_check = time.monotonic()
                if _job_status(job.id) == "cancelled":
                    cancelled = True
                    proc.kill()
                    break
        rc = await proc.wait()
        err = (await err_task).decode(errors="replace")
        if not cancelled and _job_status(job.id) == "cancelled":   # 計算が終わる直前に取り消された
            cancelled = True
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        plan_file.unlink(missing_ok=True)
    if cancelled:
        Path(plan["out"]).unlink(missing_ok=True)
        Path(plan["out"] + ".part.mp4").unlink(missing_ok=True)
        log.info(f"rain job {job.id} cancelled")
        return
    if rc != 0 or not Path(plan["out"]).exists():
        raise RuntimeError(f"雨の層の計算に失敗しました: {err.strip()[-600:]}")
    _update_progress(job.id, 0.95)
    result = await asyncio.to_thread(_finish, plan, stats)
    _update_result_assets(job.id, [result["asset_id"]])
    _set_result_json(job.id, result)
    try:
        from sqlmodel import Session
        from app.db.database import engine
        from app.services import command_api
        with Session(engine) as session:
            command_api._after_edit(plan["project_id"], "rain_render", session,
                                    detail=f"clip {result.get('clip_id')} asset {result['asset_id']}", actor="雨フィルター")
    except Exception as e:
        log.warning(f"rain notify failed: {e}")
    log.info(f"rain job {job.id}: {result}")


def main(argv: list[str]) -> int:
    plan = json.loads(Path(argv[1]).read_text())
    try:
        os.nice(10)   # GPU キューや UI の邪魔をしない
    except (AttributeError, OSError):
        pass

    def prog(p: float) -> None:
        sys.stdout.write(json.dumps({"p": round(p, 4)}) + "\n"); sys.stdout.flush()

    stats = render_plan(plan, prog)
    sys.stdout.write(json.dumps({"done": True, "stats": stats}) + "\n"); sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
