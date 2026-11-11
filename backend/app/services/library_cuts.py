"""📚 共有素材ライブラリ: 長尺素材(劇場版の本編など)をカットに分ける解析。

  python -m app.services.library_cuts analyze <asset_id> [--db PATH]
  python -m app.services.library_cuts reanalyze-thresholds <asset_id> [--db PATH] [--set key=value ...]
  python -m app.services.library_cuts filmstrips <asset_id> [--db PATH]   (タイムラインのフィルムストリップだけ作る)

流れ(CPU だけ。GPU は使わない):
  1. ffmpeg で 1 回だけデコードする(-threads 0 → 256×144 に縮小(area・BT.709 を明示)→ rgb24 をパイプで受ける)。
     塊(CHUNK コマ)ずつ読み、映画全体を持たない。
  2. コマごとの特徴: 明るさ・HSV ヒストグラム(16×4×4)・64×36 / 32×18 の灰色の縮小・前のコマとの差
     (ずらして合わせた差・変わった区画の割合・ヒストグラムの差、2〜4 コマ前との差も)。
  3. 判定(アニメ向け): ハードカット(前後 ~12 コマの差の中央値と比べて大きい差)、
     フラッシュ(1〜3 コマの光で前後が同じ絵なら切らない)、黒/白へのフェード、
     ディゾルブ(離れたコマの差がたまる+(1−a)A + aB の当てはめで確かめる)。
     判定は特徴だけで決まり、各コマの判断は前後 CONTEXT コマの特徴しか見ない。
     そのためデコードしながら「CONTEXT コマより前」の境目を確定でき、そのカットのサムネイルを
     同じデコードから切り出せる(今のカットのコマだけを持つ。2000 コマを超えたら間引く)。
  4. 保存: backend/data/library/<asset_id>/ に cuts.json(結果・特徴・判定の版としきい値)、
     sprites/s{n}.jpg(カット 50 本ずつ。1 本が 1 行 = 頭・中・尻の 3 コマ 192×108)、
     features.npz(コマごとの特徴。しきい値だけを変えた再判定に使う)。
     どれも .new の名前で作り、DB を 1 回のトランザクションで書いてから入れ替える(commit_staged)。
     デコードが途中で止まった(ffmpeg が殺された・コマ数が足りない)ら何も書かない。
  再解析はユーザーが付けたタグ・評価・★・メモを重なり 60 % 以上のカットへ引き継ぎ
  (2 つに分かれた・隣に吸収されたカットの値は重なるカットへ足す)、ユーザーの値は DB を書く
  トランザクションの中で読み直す(解析中に付けた値を消さない)。
  つなぐ・分けるで直したカット(edited)の境目は上書きしない。
  ついでにタイムラインのフィルムストリップ(data/proxies/<プロジェクト>/<id>_strip96_<n>.jpg)も作っておく。
"""
from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

DETECTOR_VERSION = 3
# v3 (2026-10-17): にぎやかな場面の色ごと変わるカット(cbusy)・光の直前のカット・白地の線画へのカット・
#   1 コマの黒のまばたき・白へ明るくなる光の中の候補・同じ絵の上のグロー(ディゾルブ)を直した
# 保存先(コードの場所から決める)。LIBRARY_DATA_DIR はテスト用の差し替え
DATA_DIR = Path(os.environ.get("LIBRARY_DATA_DIR") or (Path(__file__).parent.parent.parent / "data" / "library"))
# タイムラインのフィルムストリップのキャッシュ(routers/assets.py の FILMSTRIP_DIR と同じ場所・同じ名前)。
# 2 時間の映画で無いと、クリップを置いたとたんに映画全体のデコードが何本も走る → 解析のデコードのついでに作っておく
PROXIES_DIR = Path(os.environ.get("LIBRARY_PROXIES_DIR") or (Path(__file__).parent.parent.parent / "data" / "proxies"))
STRIP_W, STRIP_H = 96, 54
STRIP_COUNTS = tuple(range(2, 41))   # assets.py は count を 2〜40 に丸める(ClipBlock は 2,3,4,6,8,12,16,24,32,40)
AUTO_TAGS = ("黒", "白")              # 解析が付けるタグ(ユーザーの値の引き継ぎでは数えない)

FW, FH = 256, 144          # デコードの大きさ
TW, TH = 192, 108          # サムネイル 1 コマ
SPRITE_CUTS = 50           # 1 枚のスプライトに入るカット数
JPEG_Q = 82
CHUNK = 96                 # 1 回に読むコマ数
NLAG = 4                   # 何コマ前まで差を取るか
LONG_SHOT = 2000           # これより長いカットはサムネイル用のコマを間引いて持つ

# ── しきい値(features.npz から再判定できる) ─────────────────────────────────────
DEFAULTS: dict = {
    "w_hist": 0.3,          # スコア = 形の差 dz + w_hist × 色の分布の差 dh
    "ncc_lo": 0.015,        # 32×18 の標準偏差がこれ以下 → 形の差(相関)を使わず画素の差にする
    "ncc_hi": 0.05,         # これ以上 → 相関だけ(間は混ぜる)
    "pix_gain": 2.5,        # 画素の差を形の差の目盛りへ直す倍率
    "ctx": 12,              # ハードカット: 前後それぞれ何コマを比べる相手にするか
    "ctx_rank": 2,          # 前後のスコアの何番目に大きい値と比べるか(2 = 2 番目。作画の 3・4 コマ打ちの動きを外す)
    "hard_abs": 0.30,       # ハードカットのスコアの下限
    "hard_ratio": 1.8,      # スコア ≥ ratio × 前後の 2 番目 + add
    "hard_add": 0.02,
    "hard_strong": 0.62,    # これを超え、前後 3 コマの strong_ratio 倍あればカット(速いカット割り)
    "strong_ratio": 1.25,
    "busy_c": 0.5,          # にぎやかな場面でも、スコアがこれ以上で
    "busy_mind": 0.4,       #   前後 4 コマずつのどの組もこれ以上違えばカット
    "cbusy_c": 0.4,         # 色の分布ごと変わるカット: スコア・形の差(mind)・色の差(hmind)の下限
    "cbusy_mind": 0.25,
    "cbusy_h": 0.35,
    "cbusy_after": 0.8,     #   かつ直後 3 コマの変化がスコアの cbusy_after 倍以下(速いカメラの動きの途中を外す)
    "loc_c": 9.0,           # 前後 3 コマより loc_ratio 倍大きく、mind が loc_mind 以上ならカット
    "loc_ratio": 2.5,
    "loc_mind": 0.2,
    "quiet_c": 0.15,        # 止まった絵どうし(前後の 2 番目 ≤ quiet_ref)で色が変わる(dh ≥ quiet_dh)カット
    "quiet_ref": 0.08,
    "quiet_dh": 0.25,
    "quiet_dl": 0.12,       #   ただし明るさが大きく変わるもの(照明の変化)は除く
    "quiet_mind": 0.0,
    "still_c": 0.2,         # 前後が止まっている(前後の 2 番目 ≤ still_ref)ときのカットの下限
    "still_ref": 0.03,
    "still_mind": 0.0,
    "light_mz": 0.08,       # 形の差がこれ未満で明るさの差が light_dl 以上 → 照明の変化(カットにしない)
    "light_dl": 0.15,
    "veto_mind": 0.12,      # 前後に似たコマがある(差 < veto_mind)候補は、スコア < veto_c なら外す
    "veto_c": 0.5,
    "ctx_iter": 1,          # 決まったカットを前後の比べる相手から外して比べ直す回数(1 = 比べ直さない)
    "min_len": 4,           # 最短カット(コマ)
    "ramp_min": 0.03,       # フェードの坂の明るさの変化の合計の下限(これ未満は黒/白の止めに含める)
    "ramp_plateau": 4,      # 坂の途中の平ら(光の一休み)をこのコマ数まで越える
    "same_std": 0.03,       # 同じ絵かを比べるとき、32×18 の標準偏差がこれ未満(白飛び・一様)のコマは比べない
    "same_shape": 0.15,     # 同じ絵: 形の差 (1 − 相関)/2 < same_shape
    "same_hue": 0.35,       #   かつ色(色相)の分布の差 < same_hue
    "ret_span": 0,         # quiet / still のカット: このコマ数以内に前の絵へ戻るなら明滅(カットではない)
    "flash_w": 0.3,
    "flash_abs": 9.0,       # フラッシュの「戻った」判定の差の上限(絶対値)
    "blink_shape": 0.09,    # 1〜3 コマの黒/白の前後が同じ絵(まばたき): 形の差の上限
    "glare_c": 0.5,         # 白へ明るくなっていく光の中(白の止めの手前)の、これ未満のハードカット候補は外す
    "glare_luma": 0.8,
    "glare_span": 16,         # フラッシュの「戻った」判定: コントラストの重みがこれ未満のコマどうしは決めない
    "flash_max": 3,         # フラッシュ・差し込みとみなす最長(コマ)
    "flash_long": 6,        # 明るい光(前後より明るい)ならこのコマ数まで
    "flash_bright": 0.6,    # flash_max を超える長さの光は、明るさの平均がこれ以上のときだけ
    "flash_match": 0.45,    # その後のコマと前のコマの差 < flash_match × カットのスコア なら同じ絵
    "flash_luma": 0.08,     # flash_cut: 間のコマが前後より明るい差
    "black": 0.06,          # 黒とみなす明るさ
    "white": 0.94,          # 白とみなす明るさ
    "flat_std": 0.010,      # 黒は一様(32×18 の標準偏差がこれ未満)。暗い場面(0.02〜0.035)と分ける
    "flat_std_white": 0.025,  # 白は少し模様が残っても白
    "white_ctx": 0.85,      # 白の前後の絵の明るさがこれより暗いときだけ白への遷移とみなす
    "hold_own": 12,         # 黒/白がこれより長いと独立のカット
    "hold_tol": 0.006,      # 黒/白の止まっている部分 = いちばん暗い(明るい)値からこの差まで
    "ramp_max": 48,         # フェードの坂の最長
    "ramp_step": 0.08,      # 坂の 1 コマの明るさの変化の上限(これより大きい = いきなり切り替わった)
    "diss_ks": [4, 8, 14],  # ディゾルブ: 離して比べるコマ数
    "diss_peak": 0.10,      # d_K の山の下限
    "diss_peak_ratio": 1.8, # d_K の山 > ratio × まわりの中央値
    "diss_fit": 0.6,        # 混ぜ方の残り < fit × 片方の残り
    "diss_mono": 0.85,      # a の単調さ(相関)
    "diss_min": 4,          # ディゾルブの最短
    "diss_ab": 0.10,        # 両端の絵の形の差(相関)がこれ以上
    "diss_aff": 0.6,        # 混ぜ方の残り < aff × 片方の絵を明るさ・コントラストだけ変えたときの残り
    "dark": 0.16,           # カットの明るさの平均がこれ未満 → 暗い
    "bright": 0.62,         # これを超える → 明るい
    "hue_sat": 0.12,        # 主な色相を出す彩度の下限
}
CONTEXT = 160               # 判定が見る前後のコマ数(これより前の境目はデコード中に確定できる)
DETECT_EVERY = 480          # デコード中に何コマごとに判定するか
RECENT = CONTEXT + DETECT_EVERY + 32   # サムネイル用に間引かずに持つ最近のコマ数

SERIES = ("luma", "sat", "dh1", "dh2", "dh3", "dh4", "dp1", "dp2", "dp3", "dp4", "dps", "fc",
          "dz1", "dz2", "dz3", "dz4")


def _now() -> datetime:
    """UTC の naive datetime(アプリの他のテーブルと同じ持ち方)。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def log(msg: str) -> None:
    print(f"[library_cuts] {msg}", file=sys.stderr, flush=True)


# ── デコード ───────────────────────────────────────────────────────────────────

def decode_cmd(path: str, start_sec: float | None = None, dur_sec: float | None = None,
               w: int = FW, h: int = FH) -> list[str]:
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-threads", "0"]
    if start_sec:
        cmd += ["-ss", f"{start_sec:.4f}"]
    cmd += ["-i", str(path)]
    if dur_sec:
        cmd += ["-t", f"{dur_sec:.4f}"]
    cmd += ["-map", "0:v:0", "-an", "-sn", "-dn",
            "-vf", (f"scale={w}:{h}:flags=area:in_color_matrix=bt709:in_range=tv"
                    f":out_color_matrix=bt709:out_range=pc,format=rgb24"),
            "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
    return cmd


def iter_chunks(path: str, start_sec: float | None = None, dur_sec: float | None = None,
                chunk: int = CHUNK, w: int = FW, h: int = FH, nice: bool = False):
    """(N, h, w, 3) uint8 の塊を順に返す。

    ffmpeg が 0 以外で終わったら(シグナルで殺された = 負の終了コードも)例外にする。
    途中で止まったデコードを「ファイルの終わり」と取り違えて、短い結果を正しいものとして保存しないため。"""
    cmd = decode_cmd(path, start_sec, dur_sec, w, h)
    if nice:
        cmd = ["nice", "-n", "10"] + cmd
    fsz = w * h * 3
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=fsz * chunk)
    eof = False
    try:
        while True:
            buf = proc.stdout.read(fsz * chunk)
            if not buf:
                eof = True
                break
            n = len(buf) // fsz
            if n == 0:
                eof = True
                break
            yield np.frombuffer(buf[: n * fsz], np.uint8).reshape(n, h, w, 3)
            if n < chunk:
                eof = True
                break
    finally:
        if not eof and proc.poll() is None:
            proc.kill()                      # 呼び出し側が途中でやめた(読み残しは捨てる)
        try:
            proc.stdout.close()
        except Exception:
            pass
        err = b""
        try:
            err = proc.stderr.read() or b""
        except Exception:
            pass
        rc = proc.wait()
        if eof and rc != 0:
            why = f"シグナル {-rc} で止められました" if rc < 0 else f"終了コード {rc}"
            raise RuntimeError(f"ffmpeg のデコードが途中で止まりました({why}): {err.decode(errors='replace')[-400:]}")


def probe(path: str) -> dict:
    """fps・コマ数・長さ・チャプター。"""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "stream=r_frame_rate,nb_frames,width,height:format=duration",
                          "-show_chapters", "-of", "json", str(path)],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe に失敗しました: {out.stderr[-300:]}")
    j = json.loads(out.stdout or "{}")
    st = (j.get("streams") or [{}])[0]
    num, _, den = (st.get("r_frame_rate") or "24/1").partition("/")
    fps = float(num) / float(den or 1) if float(num or 0) > 0 else 24.0
    dur = float((j.get("format") or {}).get("duration") or 0)
    try:
        nb = int(st.get("nb_frames") or 0)
    except ValueError:
        nb = 0
    frames = nb or int(round(dur * fps))
    chapters = []
    for c in j.get("chapters") or []:
        s = float(c.get("start_time") or 0)
        e = float(c.get("end_time") or 0)
        sf, ef = int(round(s * fps)), min(frames, int(round(e * fps)))
        if ef <= sf:
            continue
        chapters.append({"title": (c.get("tags") or {}).get("title") or f"Chapter {len(chapters) + 1:02d}",
                         "start_frame": sf, "end_frame": ef})
    return {"fps": fps, "frames": frames, "duration": dur, "width": st.get("width"),
            "height": st.get("height"), "chapters": chapters}


def detect_letterbox(path: str, duration: float, samples: int = 24) -> tuple[int, int, int, int]:
    """黒帯(シネスコのレターボックス・ピラーボックス)を、ちらばった数十コマから見つける。
    戻り値 (y0, y1, x0, x1) は FW×FH の座標。帯がなければ (0, FH, 0, FW)。
    どのコマでも暗い行/列だけを帯とする(暗い場面・黒の止めは他のコマで明るくなるので帯にならない)。"""
    if not duration or duration <= 0:
        return (0, FH, 0, FW)
    ims = []
    for k in range(samples):
        t = duration * (k + 0.5) / samples
        r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{t:.3f}", "-i", str(path), "-map", "0:v:0",
                            "-frames:v", "1", "-an", "-sn", "-dn",
                            "-vf", f"scale={FW}:{FH}:flags=area:in_color_matrix=bt709:in_range=tv:out_range=pc,format=gray",
                            "-f", "rawvideo", "pipe:1"], capture_output=True, timeout=60)
        if len(r.stdout) >= FW * FH:
            ims.append(np.frombuffer(r.stdout[:FW * FH], np.uint8).reshape(FH, FW))
    if len(ims) < max(4, samples // 3):
        return (0, FH, 0, FW)
    a = np.stack(ims).astype(np.float32) / 255.0
    if float(a.max()) < 0.2:                       # ほとんど真っ黒の素材は判断しない
        return (0, FH, 0, FW)
    rmax, cmax = a.max(axis=(0, 2)), a.max(axis=(0, 1))

    def edge(v: np.ndarray) -> int:
        k = int(np.argmax(v > 0.06)) if (v > 0.06).any() else 0
        return k + 1 if k >= 3 else 0             # 3 行以上の帯だけ。境目のにじんだ 1 行も外す
    y0, y1 = edge(rmax), FH - edge(rmax[::-1])
    x0, x1 = edge(cmax), FW - edge(cmax[::-1])
    if y1 - y0 < FH // 2 or x1 - x0 < FW // 2:
        return (0, FH, 0, FW)
    return (y0, y1, x0, x1)


# ── コマごとの特徴 ─────────────────────────────────────────────────────────────

_LW = np.array([0.2126, 0.7152, 0.0722], np.float32)   # BT.709 の輝度


class FeatureExtractor:
    """塊ごとに特徴を出す。前の塊の末尾 NLAG コマを覚えて、差をつなげる。"""

    def __init__(self, crop: tuple[int, int, int, int] | None = None) -> None:
        # crop: 黒帯(レターボックス)を除いた絵の範囲 (y0, y1, x0, x1)(FW×FH の座標)。特徴はこの中だけで取る
        self.crop = crop if crop and crop != (0, FH, 0, FW) else None
        self.prev_hist: np.ndarray | None = None   # (NLAG, 256)
        self.prev_g64: np.ndarray | None = None    # (NLAG, 36, 64)
        self.prev_g32: np.ndarray | None = None
        self.n = 0

    def add(self, chunk: np.ndarray) -> dict[str, np.ndarray]:
        import cv2
        N = len(chunk)
        if self.crop:
            y0, y1, x0, x1 = self.crop
            chunk = np.stack([cv2.resize(np.ascontiguousarray(f[y0:y1, x0:x1]), (FW, FH), interpolation=cv2.INTER_LINEAR)
                              for f in chunk])
        x = chunk.astype(np.float32)
        Y = (x @ _LW) * (1.0 / 255.0)                                  # (N,144,256)
        luma = Y.mean(axis=(1, 2))
        g64 = Y.reshape(N, 36, 4, 64, 4).mean(axis=(2, 4))
        g32 = g64.reshape(N, 18, 2, 32, 2).mean(axis=(2, 4))
        small = chunk[:, ::2, ::2]                                     # 128×72(ヒストグラム用)
        hsv = np.stack([cv2.cvtColor(np.ascontiguousarray(f), cv2.COLOR_RGB2HSV) for f in small])
        Hh = hsv[..., 0].astype(np.int32) * 16 // 180
        S = hsv[..., 1]
        V = hsv[..., 2]
        npix = Hh.shape[1] * Hh.shape[2]
        idx = (Hh * 16 + (S >> 6).astype(np.int32) * 4 + (V >> 6).astype(np.int32)).reshape(N, -1)
        idx += (np.arange(N, dtype=np.int32) * 256)[:, None]
        hist = np.bincount(idx.ravel(), minlength=N * 256).reshape(N, 256).astype(np.float32) / npix
        sf = S.reshape(N, -1).astype(np.float32) * (1.0 / 255.0)
        sat = sf.mean(axis=1)
        hidx = Hh.reshape(N, -1) + (np.arange(N, dtype=np.int32) * 16)[:, None]
        hueh = np.bincount(hidx.ravel(), weights=sf.ravel(), minlength=N * 16).reshape(N, 16) / npix

        # 前の塊の末尾とつなげる(最初の塊は先頭のコマを繰り返して差 0 にする)
        if self.prev_hist is None:
            self.prev_hist = np.repeat(hist[:1], NLAG, axis=0)
            self.prev_g64 = np.repeat(g64[:1], NLAG, axis=0)
            self.prev_g32 = np.repeat(g32[:1], NLAG, axis=0)
        Hc = np.concatenate([self.prev_hist, hist])
        G64 = np.concatenate([self.prev_g64, g64])
        G32 = np.concatenate([self.prev_g32, g32])
        o = NLAG
        out: dict[str, np.ndarray] = {}
        for k in range(1, NLAG + 1):
            out[f"dh{k}"] = 0.5 * np.abs(Hc[o:] - Hc[o - k:o - k + N]).sum(axis=1)
            out[f"dp{k}"] = np.abs(G64[o:] - G64[o - k:o - k + N]).mean(axis=(1, 2))
        # ずらして合わせた差(カメラの揺れ・パン): ±2 px(64×36 で)の中で最小
        cur, prv = G64[o:], G64[o - 1:o - 1 + N]
        best = np.full(N, np.inf, np.float32)
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                a = cur[:, max(0, dy):36 + min(0, dy), max(0, dx):64 + min(0, dx)]
                b = prv[:, max(0, -dy):36 + min(0, -dy), max(0, -dx):64 + min(0, -dx)]
                best = np.minimum(best, np.abs(a - b).mean(axis=(1, 2)))
        out["dps"] = best
        # 明るさ・コントラストをそろえた相関の差(1 − 相関)/2(±2 px ずらした中で最小)。
        # 光の変化・暗い場面に強い。1〜4 コマ前(2 コマ目以降は ±1 px)
        for k in range(1, NLAG + 1):
            out[f"dz{k}"] = _ncc_dist(G64[o:], G64[o - k:o - k + N], 2 if k == 1 else 1)
        out["fc"] = (np.abs(G32[o:] - G32[o - 1:o - 1 + N]) > 0.06).reshape(N, -1).mean(axis=1)
        out["luma"] = luma
        out["sat"] = sat
        out = {k: v.astype(np.float32) for k, v in out.items()}
        out["g32"] = np.clip(np.rint(g32 * 255), 0, 255).astype(np.uint8)
        out["hueh"] = hueh.astype(np.float32)
        self.prev_hist = Hc[-NLAG:].copy()
        self.prev_g64 = G64[-NLAG:].copy()
        self.prev_g32 = G32[-NLAG:].copy()
        self.n += N
        return out


def _ncc_dist(cur: np.ndarray, prv: np.ndarray, r: int) -> np.ndarray:
    """(1 − 正規化相関)/2 の、±r px ずらした中での最小。両方ほぼ一様なら 0、片方だけ一様なら 0.5。"""
    N = len(cur)
    best = np.full(N, np.inf, np.float32)
    h, w = cur.shape[1:]
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            a = cur[:, max(0, dy):h + min(0, dy), max(0, dx):w + min(0, dx)].reshape(N, -1)
            b = prv[:, max(0, -dy):h + min(0, -dy), max(0, -dx):w + min(0, -dx)].reshape(N, -1)
            a = a - a.mean(axis=1, keepdims=True)
            b = b - b.mean(axis=1, keepdims=True)
            sa = np.sqrt((a * a).sum(axis=1))
            sb = np.sqrt((b * b).sum(axis=1))
            ncc = (a * b).sum(axis=1) / np.maximum(sa * sb, 1e-9)
            d = (1.0 - ncc) * 0.5
            m = a.shape[1] ** 0.5 * 0.012          # 標準偏差 0.012 未満 = ほぼ一様
            flat_a, flat_b = sa < m, sb < m
            d = np.where(flat_a & flat_b, 0.0, np.where(flat_a | flat_b, 0.5, d))
            best = np.minimum(best, d.astype(np.float32))
    return best


class GrowingFeatures:
    """デコード中の判定用: 塊を足すたびに伸びる配列(コピーを減らすため倍々で確保)。"""

    def __init__(self) -> None:
        self.cap = 0
        self.n = 0
        self.a: dict[str, np.ndarray] = {}

    def extend(self, d: dict[str, np.ndarray]) -> None:
        m = len(d["luma"])
        if self.n + m > self.cap:
            cap = max(4096, (self.n + m) * 2)
            for k, v in d.items():
                arr = np.zeros((cap,) + v.shape[1:], v.dtype)
                if k in self.a:
                    arr[: self.n] = self.a[k][: self.n]
                self.a[k] = arr
            self.cap = cap
        for k, v in d.items():
            self.a[k][self.n:self.n + m] = v
        self.n += m

    def view(self) -> dict[str, np.ndarray]:
        return {k: v[: self.n] for k, v in self.a.items()}


# ── 判定 ───────────────────────────────────────────────────────────────────────

@dataclass
class Boundary:
    frame: int                  # 新しいカットの最初のコマ
    kind: str                   # hard / dissolve / fade_black / fade_white / flash_cut
    trans: int = 0              # 入りの遷移の長さ
    score: float = 0.0


def _th(th: dict | None) -> dict:
    t = dict(DEFAULTS)
    if th:
        t.update(th)
    return t


def _contrast_weight(f: dict, k: int, t: dict) -> np.ndarray:
    """相関の差 dz を信じてよい度合い(0..1)。コントラストの低いコマ(粒子ノイズの紙・ほぼ黒の星空)では
    相関がでたらめになるので、k コマ前と今の両方が十分に模様を持つときだけ 1 に近づける。"""
    if "_std" not in f:
        f["_std"] = frame_std(f)
    sd = f["_std"]
    prev = np.concatenate([np.full(k, sd[0] if len(sd) else 0.0, np.float32), sd[:-k]]) if len(sd) > k else sd
    m = np.minimum(sd, prev)
    lo, hi = t["ncc_lo"], t["ncc_hi"]
    return np.clip((m - lo) / max(1e-6, hi - lo), 0.0, 1.0).astype(np.float32)


def _mix(f: dict, k: int, t: dict) -> np.ndarray:
    w = _contrast_weight(f, k, t)
    pix = f["dps"] if k == 1 else f[f"dp{k}"]
    alt = np.minimum(1.0, t["pix_gain"] * pix.astype(np.float32))
    return w * f[f"dz{k}"].astype(np.float32) + (1.0 - w) * alt


def _weight_at(f: dict, k: int, j: int, t: dict) -> float:
    """_contrast_weight(f, k, t)[j] を 1 コマだけ計算する。"""
    if "_std" not in f:
        f["_std"] = frame_std(f)
    sd = f["_std"]
    m = min(float(sd[j]), float(sd[j - k] if j - k >= 0 else sd[0]))
    lo, hi = t["ncc_lo"], t["ncc_hi"]
    return min(1.0, max(0.0, (m - lo) / max(1e-6, hi - lo)))


def _lag_score_at(f: dict, k: int, j: int, t: dict) -> float:
    """lag_score(f, k, t)[j] を 1 コマだけ計算する(フラッシュの判定用。配列全体を作らない)。"""
    w = _weight_at(f, k, j, t)
    pix = float(f["dps"][j] if k == 1 else f[f"dp{k}"][j])
    alt = min(1.0, t["pix_gain"] * pix)
    return w * float(f[f"dz{k}"][j]) + (1.0 - w) * alt + t["w_hist"] * float(f[f"dh{k}"][j])


def hard_score(f: dict, t: dict | None = None) -> np.ndarray:
    """1 コマごとの「切り替わりらしさ」= 絵の形の差(明るさをそろえた相関。コントラストが低いときは
    ずらして合わせた画素の差)+ 色の分布の差。"""
    t = t or DEFAULTS
    return _mix(f, 1, t) + t["w_hist"] * f["dh1"].astype(np.float32)


def lag_score(f: dict, k: int, t: dict | None = None) -> np.ndarray:
    t = t or DEFAULTS
    return _mix(f, k, t) + t["w_hist"] * f[f"dh{k}"].astype(np.float32)


def frame_std(f: dict) -> np.ndarray:
    g = f["g32"].reshape(len(f["g32"]), -1).astype(np.float32) * (1.0 / 255.0)
    return g.std(axis=1)


def detect(f: dict, th: dict | None = None, lo: int = 0, hi: int | None = None) -> list[Boundary]:
    """特徴 f から境目を出す。[lo, hi) の境目だけを返す(判定には前後 CONTEXT コマを使う)。"""
    t = _th(th)
    n = len(f["luma"])
    hi = n if hi is None else min(n, hi)
    a0 = max(0, lo - CONTEXT)
    b0 = min(n, hi + CONTEXT)
    sub = {k: v[a0:b0] for k, v in f.items()}
    out = _detect_core(sub, t, base=a0, at_film_end=(b0 >= n))
    return [b for b in out if lo <= b.frame < hi]


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    if not len(mask):
        return []
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.where(d == 1)[0].tolist(), np.where(d == -1)[0].tolist()))


def _detect_core(f: dict, t: dict, base: int, at_film_end: bool) -> list[Boundary]:
    n = len(f["luma"])
    if n < 2:
        return []
    luma = f["luma"].astype(np.float32)
    c = hard_score(f, t)
    if base == 0:
        c[0] = 0.0
    std = frame_std(f)
    mz1 = _mix(f, 1, t)                  # 形だけの差(フェードの坂の途中の飛びを見る)
    glare = np.zeros(n, bool)            # 白の止めの手前の、明るくなっていく光
    covered = np.zeros(n, bool)          # ハードカット・ディゾルブの候補から外すコマ
    bounds: list[Boundary] = []

    # 1) 黒・白(ほぼ一様)の続き = フェード
    blk = (luma < t["black"]) & ((std < t["flat_std"]) | (luma < t["black"] * 0.05))
    wht = (luma > t["white"]) & ((std < t["flat_std_white"]) | (luma > 1 - (1 - t["white"]) * 0.1))
    step = t["ramp_step"]
    for kind, mask in (("fade_black", blk), ("fade_white", wht)):
        sign = 1.0 if kind == "fade_black" else -1.0    # 黒: 坂は暗くなる向き
        for a, b in _runs(mask):
            touch_start = a == 0 and base > 0
            touch_end = b == n and not at_film_end
            # 止まっている部分(いちばん暗い/明るい値の近く)だけを「黒/白」とし、残りは坂に回す
            ext = float(luma[a:b].min()) if kind == "fade_black" else float(luma[a:b].max())
            tol = t["hold_tol"]
            a1, b1 = a, b
            b_orig = b
            if not touch_start:
                while a1 < b1 - 1 and abs(float(luma[a1]) - ext) > tol:
                    a1 += 1
            if not touch_end:
                while b1 - 1 > a1 and abs(float(luma[b1 - 1]) - ext) > tol:
                    b1 -= 1
            a, b = a1, b1
            ra, ja = _ramp_walk(luma, mz1, a, -1, sign, t) if not touch_start else (a, False)
            rb, jb = _ramp_walk(luma, mz1, b, +1, sign, t) if not touch_end else (b, False)
            # 坂の外側が絵の飛び(カット)で、坂と呼べないほど明るさが変わらない(白地の線画など)なら、
            # その飛びが黒/白の頭(尻)になる(線画の白地を白の止めと取り違え、境目が 2 コマ遅れていた)
            if ja and ra < a and abs(float(luma[ra]) - float(luma[a])) < t["ramp_min"]:
                a = ra
            if jb and rb > b and abs(float(luma[rb - 1]) - float(luma[b - 1])) < t["ramp_min"]:
                b = rb
            L = b - a
            long_hold = L > t["hold_own"] or touch_start or touch_end
            if kind == "fade_white":
                # 白っぽい場面(白地のスタッフロールなど)の中の白は遷移ではない: 前か後に、はっきり暗い絵があること
                before = luma[max(0, ra - 3):ra] if ra > 0 else luma[:0]
                after = luma[rb:min(n, rb + 3)]
                lows = [float(x.min()) for x in (before, after) if len(x)]
                if not lows or min(lows) > t["white_ctx"]:
                    continue
            if kind == "fade_white" and not long_hold and L <= t["flash_max"] and (a - ra) + (rb - b) <= 2:
                continue                                # 短い白はフラッシュの判定に任せる
            if (not long_hold and L <= t["flash_max"] and (a - ra) + (rb - b) <= 3 and ra >= 1 and rb < n
                    and _same_picture(f, ra - 1, rb, t, shape=t["blink_shape"])):
                covered[ra:rb + 1] = True               # 1〜3 コマの黒/白の後に同じ絵へ戻る(まばたき)= カットではない
                continue
            # 黒/白の直後(元の続きの終わり +2 まで)のハードカットは、この黒/白を頭にした同じカットの入り
            # 坂の頭が絵の飛び(カットの直後から暗く/明るくなっていく)なら、その飛びはカットとして残す
            c0 = ra + 1 if (ja and ra < a) else ra
            covered[c0:min(n, max(rb, b_orig + 2 if not long_hold else b + 1))] = True
            if kind == "fade_white":
                # 白へ向かって明るくなる光の中(形も光で崩れて飛ぶ)の弱い候補は、カットではない
                k, low = ra - 1, float(luma[ra]) if ra < n else 1.0
                while k >= 0 and ra - k <= t["glare_span"] and float(luma[k]) >= t["glare_luma"] \
                        and float(luma[k]) <= low + 0.015:
                    low = min(low, float(luma[k]))
                    k -= 1
                if ra - (k + 1) >= 2:
                    glare[k + 1:c0] = True
            film_start = a == 0 and base == 0
            if not long_hold:
                if not film_start:
                    bounds.append(Boundary(a, kind, (b - a) + (rb - b), 1.0))
            else:
                if not touch_start and not film_start:
                    bounds.append(Boundary(a, kind if a > ra else "hard", 0, 1.0))
                if not touch_end and b < n:
                    bounds.append(Boundary(b, kind if rb > b else "hard", rb - b, 1.0))

    # 2) フラッシュ・短い差し込み: 1〜flash_max コマ後(明るい光なら flash_long コマ後まで)に
    #    元の絵へ戻るなら切らない。先に外しておき、前後の比べる相手にも入れない。
    nxt = np.concatenate([c[1:], [0.0]])
    prv = np.concatenate([[0.0], c[:-1]])
    peaks = np.where((c >= min(t["hard_abs"], t["quiet_c"])) & (c >= prv) & (c > nxt) & ~covered)[0]
    g = f["g32"].reshape(n, -1).astype(np.float32) * (1.0 / 255.0)
    checked: set[int] = set()
    for _round in range(3):
        for i in peaks.tolist():
            if covered[i] or i < 1 or i in checked:
                continue
            checked.add(i)
            back = _transient_len(f, c, luma, g, i, t)
            if back:
                covered[i:i + back + 1] = True
        cm = np.where(covered, 0.0, c).astype(np.float32)
        # フラッシュのコマを外したスコアでピークを取り直す(光の直前のカットは、光のコマの方がスコアが
        # 大きいのでピークにならず落ちていた)。新しくピークになったコマもフラッシュかどうか調べる
        nxt = np.concatenate([cm[1:], [0.0]])
        prv = np.concatenate([[0.0], cm[:-1]])
        peaks = np.where((cm >= min(t["hard_abs"], t["quiet_c"])) & (cm >= prv) & (cm > nxt) & ~covered)[0]
        if all(int(i) in checked or int(i) < 1 for i in peaks):
            break

    # 3) ハードカットの候補(局所的に最大・絶対値・前後との比)
    cand = np.array([i for i in peaks.tolist() if not covered[i]], np.int64)
    if len(cand):
        mind = np.array([_min_cross(g, int(i)) for i in cand], np.float32)
        acc = np.zeros(len(cand), bool)
        cm2 = cm.copy()
        # 決まったカットは、まわりの候補の「前後の動き」から外して比べ直す(速いカット割りで、
        # となりの本物のカットが前後の値を押し上げて、ほかのカットが比で落ちていた)
        for _it in range(max(1, int(t["ctx_iter"]))):
            feat = _cand_features(f, t, c, cm2, cand, luma, mind)
            ok = _hard_rules(t, feat)
            if _DEBUG is not None and _it == 0:
                _DEBUG.setdefault("first", []).append({k: v.copy() for k, v in feat.items()} | {"cand": cand + base})
            new = ok & ~acc
            acc |= ok
            if not new.any():
                break
            cm2[cand[acc]] = 0.0
        if _DEBUG is not None:
            _DEBUG.setdefault("final", []).append({k: v.copy() for k, v in feat.items()} | {"cand": cand + base, "ok": acc.copy()})
        cand = cand[acc]
        cand = cand[~(glare[cand] & (c[cand] < t["glare_c"]))]
    hard: list[Boundary] = [Boundary(int(i), "hard", 0, float(c[i])) for i in cand.tolist()]
    hard = _merge_flash_cuts(hard, luma, t)
    bounds += hard

    # 4) ディゾルブ
    bounds += _dissolves(f, c, t, covered, sorted(b.frame for b in bounds))

    # 5) 並べて、短すぎるカットを消す
    bounds.sort(key=lambda b: b.frame)
    bounds = _enforce_min_len(bounds, int(t["min_len"]))
    for b in bounds:
        b.frame += base
    return bounds


_DEBUG: dict | None = None          # 調べる用(候補ごとの値を集める)。ふだんは None


def _cand_features(f: dict, t: dict, c: np.ndarray, cm: np.ndarray, cand: np.ndarray, luma: np.ndarray,
                   mind: np.ndarray) -> dict:
    """ハードカット候補ごとの値: スコア・前後 ctx コマの 2 番目(ref)・前後 3 コマの最大(near)・前後の似た組の差(mind)など。"""
    from numpy.lib.stride_tricks import sliding_window_view
    ctx = int(t["ctx"])
    pad = np.concatenate([np.full(ctx, -1.0, np.float32), cm, np.full(ctx, -1.0, np.float32)])
    win = sliding_window_view(pad, 2 * ctx + 1)[cand].copy()
    win[:, ctx] = -1.0
    srt = np.sort(win, axis=1)
    ref = np.maximum(srt[:, -int(t["ctx_rank"])], 0.0)
    near = np.concatenate([win[:, ctx - 3:ctx], win[:, ctx + 1:ctx + 4]], axis=1).max(axis=1)
    near = np.maximum(near, 0.0)
    return {"ci": c[cand].astype(np.float32), "ref": ref.astype(np.float32), "near": near.astype(np.float32),
            "mind": mind, "dl": np.abs(luma[cand] - luma[np.maximum(cand - 1, 0)]).astype(np.float32),
            "dh1": f["dh1"][cand].astype(np.float32), "mz": _mix(f, 1, t)[cand].astype(np.float32),
            "hmind": _hmind(f, cand),
            "nearR": np.maximum(win[:, ctx + 1:ctx + 4].max(axis=1), 0.0).astype(np.float32),
            "returns": np.array([_colour_returns(f, int(i), t) for i in cand], bool)}


def _hmind(f: dict, cand: np.ndarray) -> np.ndarray:
    """境目をまたぐ組(後の 4 コマ × 前のコマ、1〜4 コマ離れ)の色の分布の差のいちばん小さい値。
    色の分布は動き・ポーズの変化に強い: 同じ絵の大きな動きなら、どこかの組の色が似ていて小さくなる。"""
    n = len(f["luma"])
    out = np.full(len(cand), 9.0, np.float32)
    for x_off in range(4):
        x = cand + x_off
        valid = x < n
        xc = np.minimum(x, n - 1)
        for k in range(x_off + 1, NLAG + 1):
            v = f[f"dh{k}"][xc].astype(np.float32)
            out = np.where(valid, np.minimum(out, v), out)
    return out


def _hard_rules(t: dict, x: dict) -> np.ndarray:
    ci, ref, near, mind, dl = x["ci"], x["ref"], x["near"], x["mind"], x["dl"]
    ok = (ci >= t["hard_abs"]) & ((ci >= t["hard_ratio"] * ref + t["hard_add"]) |
                                  ((ci >= t["hard_strong"]) & (ci >= t["strong_ratio"] * near)))
    # 前後に似たコマがある(同じ絵の上の爆発・光・段階的なズーム)なら、強くない候補は外す
    ok &= ~((mind < t["veto_mind"]) & (ci < t["veto_c"]))
    # にぎやかな場面(2・3 コマ打ちの大きな動き)の中のカット: 前後のどのコマどうしも似ていない
    ok |= (ci >= t["busy_c"]) & (mind >= t["busy_mind"])
    # 止まった絵どうしの、色だけが変わるカット(ふちの暗い回想の絵など。形はふちが同じなので似て見える)
    # 止まった絵から止まった絵へ(前後がほとんど動かない)なら、少しの差でもカット。
    # ただし形が同じで明るさだけ変わるもの(照明・光)は除く
    light = (x["mz"] < t["light_mz"]) & (dl >= t["light_dl"])
    ok_qs = (ci >= t["still_c"]) & (ref <= t["still_ref"]) & ~light & (mind >= t["still_mind"])
    ok_qs |= (ci >= t["quiet_c"]) & (ref <= t["quiet_ref"]) & (x["dh1"] >= t["quiet_dh"]) & \
        (dl < t["quiet_dl"]) & (mind >= t["quiet_mind"])
    # 止まった絵どうしの弱いカット(quiet / still)は、すぐ元の絵に戻るもの(点滅・色の明滅)を除く
    if "returns" in x:
        ok_qs &= ~x["returns"] | (ci >= t["veto_c"])
    ok |= ok_qs
    # にぎやかな場面の中の、色の分布ごと変わるカット(形も色も、またぐどの組も似ていない)
    ok |= (ci >= t["cbusy_c"]) & (mind >= t["cbusy_mind"]) & (x["hmind"] >= t["cbusy_h"]) & \
        (x["nearR"] <= t["cbusy_after"] * ci)
    # まわりがにぎやかでも、すぐ前後(3 コマ)は落ち着いている孤立した大きな変化(となりのカットが比を押し上げた場合)
    ok |= (ci >= t["loc_c"]) & (ci >= t["loc_ratio"] * near) & (mind >= t["loc_mind"])
    return ok


def _ramp_walk(luma: np.ndarray, mz: np.ndarray, start: int, direction: int, sign: float,
               t: dict) -> tuple[int, bool]:
    """黒/白の止めの端 start から、フェードの坂をたどる(direction −1: 前へ、+1: 後へ)。
    戻り値: (坂の端, 端の先が絵の飛びか)。1 コマの明るさの変化が (0.0005, ramp_step) の間なら坂。
    形の飛び(明るさをそろえた形の差 mz ≥ hard_abs)では止まる(色のヒストグラムは一様な灰色の
    フェードでも段で飛ぶので使わない)。ramp_plateau コマまでの平ら(光が強まる途中の一休み)は、
    その先も同じ向きに続くなら越える。"""
    n = len(luma)
    step, lim, plat, jump = t["ramp_step"], int(t["ramp_max"]), int(t["ramp_plateau"]), t["hard_abs"]
    pos = start

    def edge(p: int) -> bool:
        return p - 1 < 0 if direction < 0 else p >= n

    def delta(p: int) -> float:
        # 一歩 (p−1 → p) の、止めへ向かう明るさの変化(坂の向きなら +)
        d = float(luma[p - 1] - luma[p])
        return sign * d if direction < 0 else -sign * d

    while abs(pos - start) < lim:
        if edge(pos):
            return pos, False
        if float(mz[pos]) >= jump:
            return pos, True                   # 形が飛ぶ = カット(坂ではない)
        dl = delta(pos)
        if 0.0005 < dl < step:
            pos += direction
            continue
        if abs(dl) > 0.0005:
            return pos, dl >= step             # 大きく飛ぶ = いきなり切り替わった
        q, ok = pos, False                     # 平ら: plat コマ先までに同じ向きの坂が続くなら越える
        for _k in range(plat):
            q += direction
            if edge(q):
                break
            if float(mz[q]) >= jump:
                # 平らなコマの先が絵の飛び: 平らなコマごと止めの側(飛びの直後のコマが端)
                return (q if direction < 0 else q), True
            d2 = delta(q)
            if 0.0005 < d2 < step:
                ok = True
                break
            if abs(d2) > 0.0005:
                break
        if not ok:
            return pos, False
        pos = q + direction
    return pos, False


def _same_picture(f: dict, i: int, j: int, t: dict, shape: float | None = None) -> bool:
    """コマ i と j が同じ絵か(形の相関 + 色)。どちらかがほぼ一様(白飛び・黒)なら判断しない(False)。"""
    g = f["g32"]
    a = g[i].astype(np.float32).ravel() * (1.0 / 255.0)
    b = g[j].astype(np.float32).ravel() * (1.0 / 255.0)
    if a.std() < t["same_std"] or b.std() < t["same_std"]:
        return False
    a, b = a - a.mean(), b - b.mean()
    d = float((1.0 - (a * b).sum() / max(1e-9, float(np.sqrt((a * a).sum() * (b * b).sum())))) * 0.5)
    h = f["hueh"]
    dh = 0.5 * float(np.abs(h[i] - h[j]).sum()) / max(1e-6, 0.5 * float(h[i].sum() + h[j].sum()))
    return d < (t["same_shape"] if shape is None else shape) and dh < t["same_hue"]


def _colour_returns(f: dict, i: int, t: dict) -> bool:
    """点滅・色の明滅か: i で変わった絵が ret_span コマ以内に i−1 の絵(形も色も)へ戻る、
    または i の絵が少し前(i−2〜i−ret_span)にもあった(同じ 2 枚の絵の行き来)。"""
    n = len(f["luma"])
    for k in range(2, int(t["ret_span"]) + 1):
        j = i + k
        if j < n and _same_picture(f, i - 1, j, t):
            return True
        j = i - k
        if j >= 0 and _same_picture(f, i, j, t):
            return True
    return False


def _gdist(g: np.ndarray, i: int, j: int) -> float:
    """32×18 の灰色どうしの (1 − 相関)/2(ずらしなし)。両方一様なら 0、片方だけなら 0.5。"""
    a = g[i] - g[i].mean()
    b = g[j] - g[j].mean()
    sa, sb = float(np.sqrt((a * a).sum())), float(np.sqrt((b * b).sum()))
    m = len(a) ** 0.5 * 0.012
    if sa < m and sb < m:
        return 0.0
    if sa < m or sb < m:
        return 0.5
    return float((1.0 - (a * b).sum() / (sa * sb)) * 0.5)


def _min_cross(g: np.ndarray, i: int, k: int = 4) -> float:
    """i の後の k コマと前の k コマの、いちばん似ている組の差。カットなら大きく、同じ絵の動きなら小さい。"""
    n = len(g)
    best = 1.0
    for a in range(k):
        x = i + a
        if x >= n:
            break
        for b in range(k):
            y = i - 1 - b
            if y < 0:
                break
            d = _gdist(g, x, y)
            if d < best:
                best = d
    return best


def _transient_len(f: dict, c: np.ndarray, luma: np.ndarray, g: np.ndarray, i: int, t: dict) -> int:
    """i から始まる変化が L コマで元の絵へ戻るなら L(戻らなければ 0)。"""
    n = len(c)
    ci = float(c[i])
    for L in range(1, int(t["flash_max"]) + 1):
        j = i + L
        if j >= n or L + 1 > NLAG:
            break
        # 白飛び・コントラストの低いコマどうしは画素の差が小さく、別の絵でも同じに見える → 決めない
        if _weight_at(f, L + 1, j, t) < t["flash_w"]:
            continue
        ls = _lag_score_at(f, L + 1, j, t)
        if ls < t["flash_match"] * ci and ls < t["flash_abs"]:
            return L
    # 明るい光(前後より明るい)は flash_long コマまで: 灰色の縮小で光の前と後を比べる
    for L in range(1, int(t["flash_long"]) + 1):
        j = i + L
        if j >= n:
            break
        spike = float(luma[i:j].mean())
        if spike < max(float(luma[i - 1]), float(luma[j])) + t["flash_luma"]:
            continue
        if L > t["flash_max"] and spike < t["flash_bright"]:
            continue                                   # 4 コマ以上は本当に明るい光だけ(明るい挿し絵は切る)
        if any(float(luma[x]) > t["white_ctx"] and float(g[x].std()) < t["same_std"] for x in (i - 1, j)):
            continue                                   # どちらかが白飛び: 同じ絵かどうか決められない
        d = _gdist(g, i - 1, j)
        if d < t["flash_match"] * max(float(f["dz1"][i]), 0.2):
            return L
    return 0


def _merge_flash_cuts(hard: list[Boundary], luma: np.ndarray, t: dict) -> list[Boundary]:
    """「明るいコマが 1〜3 コマ → 別の絵」の 2 つの境目を 1 つ(flash_cut、光は次のカットの頭)にする。"""
    hard = sorted(hard, key=lambda b: b.frame)
    out: list[Boundary] = []
    i = 0
    while i < len(hard):
        b = hard[i]
        if i + 1 < len(hard):
            nb = hard[i + 1]
            L = nb.frame - b.frame
            if 1 <= L <= t["flash_max"]:
                seg = luma[b.frame:nb.frame]
                before = luma[max(0, b.frame - 3):b.frame]
                after = luma[nb.frame:nb.frame + 3]
                ref = max(float(before.mean()) if len(before) else 0.0, float(after.mean()) if len(after) else 0.0)
                if len(seg) and float(seg.mean()) > ref + t["flash_luma"]:
                    out.append(Boundary(b.frame, "flash_cut", L, max(b.score, nb.score)))
                    i += 2
                    continue
        out.append(b)
        i += 1
    return out


def _dissolves(f: dict, c: np.ndarray, t: dict, covered: np.ndarray, hard_at: list[int]) -> list[Boundary]:
    g = f["g32"].reshape(len(f["g32"]), -1).astype(np.float32) * (1.0 / 255.0)
    n = len(g)
    luma = f["luma"]
    found: list[tuple[int, int, float]] = []
    hard_arr = np.array(hard_at, np.int64) if hard_at else np.zeros(0, np.int64)
    for K in t["diss_ks"]:
        K = int(K)
        if n < 4 * K + 3:
            continue
        dK = np.zeros(n, np.float32)
        dK[K:n - K] = np.abs(g[2 * K:] - g[:n - 2 * K]).mean(axis=1)
        prv = np.concatenate([[0.0], dK[:-1]])
        nxt = np.concatenate([dK[1:], [0.0]])
        pk = np.where((dK >= t["diss_peak"]) & (dK >= prv) & (dK > nxt))[0]
        for i in pk.tolist():
            if i < 2 * K or i >= n - 2 * K:
                continue
            v = float(dK[i])
            loc = float(np.median(dK[max(0, i - 40):i + 41])) + 1e-6
            if v < t["diss_peak_ratio"] * loc:
                continue
            if covered[max(0, i - K):i + K + 1].any():
                continue
            if len(hard_arr) and np.min(np.abs(hard_arr - i)) <= 2 * K:
                continue
            a, b = i - 2 * K, i + 2 * K
            A, B = g[a], g[b]
            if min(luma[a], luma[b]) < t["black"] or max(luma[a], luma[b]) > t["white"]:
                continue
            dAB = B - A
            den = float((dAB * dAB).sum()) + 1e-6
            al = np.clip(((g[a:b + 1] - A) @ dAB) / den, -0.3, 1.3)
            idx = np.arange(a, b + 1)
            xs = idx[(al >= 0.05) & (al <= 0.95)]
            if len(xs) == 0:
                continue
            t0, t1 = int(xs[0]), int(xs[-1])
            if t1 - t0 + 1 < t["diss_min"]:
                continue
            seg = al[t0 - a:t1 - a + 1]
            mid = [k for k in range(t0, t1 + 1) if 0.25 <= al[k - a] <= 0.75]
            if not mid:
                continue
            r_mix = float(np.mean([np.abs(g[k] - ((1 - al[k - a]) * A + al[k - a] * B)).mean() for k in mid]))
            r_one = float(np.mean([min(np.abs(g[k] - A).mean(), np.abs(g[k] - B).mean()) for k in mid]))
            mono = float(np.corrcoef(np.arange(len(seg)), seg)[0, 1]) if len(seg) > 2 and seg.std() > 0 else 0.0
            jump = float(c[t0:t1 + 1].max())
            # 両端の絵の形が違うこと(同じ絵の上の光・グロー・明るさの変化をディゾルブにしない)
            ab = _gdist(g, a, b)
            if r_mix < t["diss_fit"] * r_one and mono > t["diss_mono"] and jump < t["hard_abs"] and ab >= t["diss_ab"]:
                # 途中のコマが片方の絵の明るさ・コントラストを変えただけ(g·A + o)で説明できるなら、
                # 同じ絵の上の光・グローの変化(ディゾルブではない)
                r_aff = float(np.mean([min(_affine_resid(g[k], A), _affine_resid(g[k], B)) for k in mid]))
                if r_mix < t["diss_aff"] * r_aff:
                    found.append((t0, t1, v))
    found.sort(key=lambda x: -x[2])
    keep: list[tuple[int, int, float]] = []
    for x in found:
        if all(x[1] < k[0] - 2 or x[0] > k[1] + 2 for k in keep):
            keep.append(x)
    return [Boundary(t0, "dissolve", t1 - t0 + 1, sc) for t0, t1, sc in keep]


def _affine_resid(y: np.ndarray, x: np.ndarray) -> float:
    """y ≈ g·x + o の最小二乗の残り(平均の絶対値)。"""
    xm, ym = float(x.mean()), float(y.mean())
    xc = x - xm
    den = float((xc * xc).sum())
    gain = float((xc * (y - ym)).sum()) / den if den > 1e-9 else 0.0
    return float(np.abs(y - (ym + gain * xc)).mean())


def _enforce_min_len(bounds: list[Boundary], min_len: int) -> list[Boundary]:
    pri = {"fade_black": 3, "fade_white": 3, "dissolve": 2, "flash_cut": 2, "hard": 1}
    out: list[Boundary] = []
    for b in bounds:
        if out and b.frame - out[-1].frame < min_len:
            prev = out[-1]
            if (pri.get(b.kind, 1), b.score) > (pri.get(prev.kind, 1), prev.score):
                out[-1] = b
            continue
        out.append(b)
    return out


# ── カットの特徴 ───────────────────────────────────────────────────────────────

def cut_features(f: dict, a: int, b: int, t: dict) -> dict:
    luma = float(f["luma"][a:b].mean()) if b > a else 0.0
    motion = float(f["dp1"][a + 1:b].mean()) if b > a + 1 else 0.0
    sat = float(f["sat"][a:b].mean()) if b > a else 0.0
    hh = f["hueh"][a:b].sum(axis=0) if b > a else np.zeros(16)
    hue = None
    if sat >= t["hue_sat"] and float(hh.sum()) > 0:
        k = int(np.argmax(hh))
        hue = round((k + 0.5) * 360.0 / 16, 1)
    return {"luma": round(luma, 4), "motion": round(motion, 5), "sat": round(sat, 4), "hue": hue,
            "dark": luma < t["dark"], "bright": luma > t["bright"]}


def thumb_frames(a: int, b: int) -> tuple[int, int, int]:
    L = b - a
    k = min(2, L // 4)
    return a + k, a + L // 2, b - 1 - k


def make_cuts(f: dict, bounds: list[Boundary], frames: int, t: dict) -> list[dict]:
    starts = [Boundary(0, "start", 0, 0.0)] + sorted([b for b in bounds if 0 < b.frame < frames],
                                                      key=lambda b: b.frame)
    luma = f["luma"]
    std = frame_std(f)
    cuts = []
    for k, b in enumerate(starts):
        e = starts[k + 1].frame if k + 1 < len(starts) else frames
        if e <= b.frame:
            continue
        c = {"idx": len(cuts), "start": b.frame, "end": e, "trans_in": b.kind,
             "trans_frames": int(min(b.trans, e - b.frame)), "score": round(float(b.score), 4)}
        tags = []
        seg_l, seg_s = luma[b.frame:e], std[b.frame:e]
        if e - b.frame > t["hold_own"] and float((seg_l < t["black"]).mean()) > 0.8 and float(seg_s.mean()) < t["flat_std"]:
            tags.append("黒")
        if e - b.frame > t["hold_own"] and float((seg_l > t["white"]).mean()) > 0.8 and float(seg_s.mean()) < t["flat_std"]:
            tags.append("白")
        c["auto_tags"] = tags
        c.update(cut_features(f, b.frame, e, t))
        cuts.append(c)
    return cuts


# ── サムネイル(スプライト) ─────────────────────────────────────────────────────

class SpriteWriter:
    """カット 50 本で 1 枚(576×5400)。1 本が 1 行(頭・中・尻)。"""

    def __init__(self, out_dir: Path) -> None:
        self.dir = out_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.sheet: np.ndarray | None = None
        self.sheet_no = -1
        self.written: set[int] = set()

    def put(self, idx: int, cells: list[np.ndarray]) -> None:
        import cv2
        n = idx // SPRITE_CUTS
        if n != self.sheet_no:
            self.flush()
            self.sheet_no = n
            self.sheet = np.zeros((SPRITE_CUTS * TH, 3 * TW, 3), np.uint8)
        r = idx % SPRITE_CUTS
        for c, im in enumerate(cells):
            if im.shape[:2] != (TH, TW):
                im = cv2.resize(im, (TW, TH), interpolation=cv2.INTER_AREA)
            self.sheet[r * TH:(r + 1) * TH, c * TW:(c + 1) * TW] = im

    def flush(self, rows: int | None = None) -> None:
        import cv2
        if self.sheet is None or self.sheet_no < 0:
            return
        p = self.dir / f"s{self.sheet_no}.jpg"
        tmp = self.dir / f"s{self.sheet_no}.tmp.jpg"
        cv2.imwrite(str(tmp), cv2.cvtColor(self.sheet, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])
        os.replace(tmp, p)
        self.written.add(self.sheet_no)
        self.sheet = None
        self.sheet_no = -1


def write_sprite_cells(out_dir: Path, idx: int, cells: list[np.ndarray]) -> None:
    """既存のスプライトの 1 行だけ書き換える(つなぐ・分ける・シークでの作り直し)。"""
    import cv2
    out_dir.mkdir(parents=True, exist_ok=True)
    n = idx // SPRITE_CUTS
    p = out_dir / f"s{n}.jpg"
    sheet = None
    if p.exists():
        im = cv2.imread(str(p))
        if im is not None and im.shape[1] == 3 * TW:
            sheet = cv2.cvtColor(im, cv2.COLOR_BGR2RGB)
            if sheet.shape[0] < SPRITE_CUTS * TH:
                pad = np.zeros((SPRITE_CUTS * TH - sheet.shape[0], 3 * TW, 3), np.uint8)
                sheet = np.concatenate([sheet, pad])
    if sheet is None:
        sheet = np.zeros((SPRITE_CUTS * TH, 3 * TW, 3), np.uint8)
    r = idx % SPRITE_CUTS
    for c, cell in enumerate(cells):
        if cell.shape[:2] != (TH, TW):
            cell = cv2.resize(cell, (TW, TH), interpolation=cv2.INTER_AREA)
        sheet[r * TH:(r + 1) * TH, c * TW:(c + 1) * TW] = cell
    tmp = out_dir / f"s{n}.tmp.jpg"
    cv2.imwrite(str(tmp), cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])
    os.replace(tmp, p)


GRAB_RUN = 96              # grab_frames: これ以内に並ぶコマは 1 回のデコードでまとめて取る


def grab_frames(path: str, fps: float, frames: list[int], w: int = TW, h: int = TH) -> dict[int, np.ndarray]:
    """シークで指定コマを取り出す(つなぐ・分ける・再判定のサムネイル用)。RGB uint8。

    入力側シーク(キーフレームから正確にデコード)の時刻はコマの時刻の半コマ前にする。
    ちょうどの時刻(fr / fps)を丸めると 23.976・29.97 fps では次のコマの時刻を少し過ぎ、1 コマ先が出ていた。
    近いコマ(GRAB_RUN 以内)は 1 回のシークから続けてデコードして取る(固定 fps の素材)。"""
    import cv2
    out: dict[int, np.ndarray] = {}
    want = sorted({int(x) for x in frames if x >= 0})
    runs: list[list[int]] = []
    for fr in want:
        if runs and fr - runs[-1][0] < GRAB_RUN:
            runs[-1].append(fr)
        else:
            runs.append([fr])
    fsz = FW * FH * 3
    for run in runs:
        first, cnt = run[0], run[-1] - run[0] + 1
        t = max(0.0, (first - 0.5) / fps)
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-threads", "2"]
        if first > 0:
            cmd += ["-ss", f"{t:.6f}"]
        # -fps_mode passthrough: シークの後の最初のコマを固定 fps に合わせて複製させない(複製されると 2 枚目から 1 コマずれる)
        cmd += ["-i", str(path), "-map", "0:v:0", "-fps_mode", "passthrough", "-frames:v", str(cnt), "-an", "-sn", "-dn",
                "-vf", (f"scale={FW}:{FH}:flags=area:in_color_matrix=bt709:in_range=tv"
                        f":out_color_matrix=bt709:out_range=pc,format=rgb24"),
                "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
        r = subprocess.run(cmd, capture_output=True, timeout=120)
        if r.returncode != 0:
            continue
        got = len(r.stdout) // fsz
        for fr in run:
            k = fr - first
            if k < got:
                im = np.frombuffer(r.stdout[k * fsz:(k + 1) * fsz], np.uint8).reshape(FH, FW, 3)
                out[fr] = cv2.resize(im, (w, h), interpolation=cv2.INTER_AREA)
    return out


# ── 保存先 ─────────────────────────────────────────────────────────────────────

def item_dir(asset_id: int) -> Path:
    return DATA_DIR / str(int(asset_id))


def sprites_dir(asset_id: int) -> Path:
    return item_dir(asset_id) / "sprites"


def save_features(path: Path, f: dict, fps: float) -> None:
    d = {k: f[k].astype(np.float16) for k in SERIES}
    d["g32"] = f["g32"]
    d["hueh"] = f["hueh"].astype(np.float16)
    d["fps"] = np.array([fps], np.float64)
    tmp = path.with_suffix(".tmp.npz")
    np.savez_compressed(tmp, **d)
    os.replace(tmp, path)


def load_features(path: Path) -> tuple[dict, float]:
    z = np.load(path)
    f = {k: z[k].astype(np.float32) for k in SERIES}
    f["g32"] = z["g32"]
    f["hueh"] = z["hueh"].astype(np.float32)
    fps = float(z["fps"][0])
    return f, fps


# ── 解析本体(デコードしながら境目を確定し、サムネイルを切り出す) ──────────────

class FrameBuffer:
    """確定していないカットのコマを持つ(サムネイル用)。長いカットは間引く。"""

    def __init__(self) -> None:
        self.frames: dict[int, np.ndarray] = {}
        self.base = 0          # これより前のコマは捨ててよい
        self.stride = 1

    def add(self, first: int, chunk: np.ndarray) -> None:
        for j in range(len(chunk)):
            fr = first + j
            self.frames[fr] = chunk[j].copy()
        self._thin(first + len(chunk))

    def _thin(self, now: int) -> None:
        if len(self.frames) <= LONG_SHOT + RECENT:
            return
        # 頭の 8 コマと最近の RECENT コマ(まだ確定していない尻を含む)は全部残し、その間は間を空ける
        self.stride *= 2
        keep_recent = now - RECENT
        for fr in list(self.frames):
            if fr < self.base + 8 or fr >= keep_recent:
                continue
            if (fr - self.base) % self.stride:
                del self.frames[fr]

    def drop_before(self, fr: int) -> None:
        if fr <= self.base:
            return
        for k in [k for k in self.frames if k < fr]:
            del self.frames[k]
        self.base = fr
        self.stride = 1

    def get(self, fr: int) -> np.ndarray | None:
        if fr in self.frames:
            return self.frames[fr]
        if not self.frames:
            return None
        k = min(self.frames, key=lambda x: abs(x - fr))
        return self.frames[k]


def _cells_from(buf: FrameBuffer, a: int, b: int) -> list[np.ndarray]:
    import cv2
    out = []
    for fr in thumb_frames(a, b):
        im = buf.get(fr)
        if im is None:
            im = np.zeros((FH, FW, 3), np.uint8)
        out.append(cv2.resize(im, (TW, TH), interpolation=cv2.INTER_AREA))
    return out


@dataclass
class AnalysisResultData:
    fps: float
    frames: int
    cuts: list
    features: dict
    thresholds: dict
    decode_fps: float
    elapsed: float
    stream_mismatch: int
    strip_cells: dict = field(default_factory=dict)    # フィルムストリップ用のコマ(コマ番号 → 96×54 RGB)


def analyze_file(path: str, out_dir: Path, th: dict | None = None, progress=None,
                 nice: bool = False, expect_frames: int | None = None, fps: float = 24.0,
                 crop: tuple[int, int, int, int] | None = None, sprite_name: str = "sprites",
                 strip_frames: set[int] | None = None) -> AnalysisResultData:
    """映画 1 本を 1 回デコードして、カット・特徴・スプライトを作る。crop: 黒帯を除いた範囲(detect_letterbox)。

    スプライトは <out_dir>/<sprite_name>/ に置く(解析の CLI は "sprites.new" に作り、DB を書いてから入れ替える)。
    strip_frames: ついでに 96×54 で取っておくコマ(タイムラインのフィルムストリップの下ごしらえ)。"""
    import shutil
    import cv2
    t = _th(th)
    out_dir.mkdir(parents=True, exist_ok=True)
    sp_dir = out_dir / f"{sprite_name}.tmp"
    if sp_dir.exists():
        shutil.rmtree(sp_dir)
    writer = SpriteWriter(sp_dir)
    strip_want = sorted(strip_frames or ())
    strip_cells: dict[int, np.ndarray] = {}
    sw = 0
    ex = FeatureExtractor(crop)
    gf = GrowingFeatures()
    buf = FrameBuffer()
    final: list[Boundary] = [Boundary(0, "start", 0, 0.0)]
    emitted = 0                     # スプライトに書いたカット数
    t0 = time.time()
    last_prog = 0.0
    n = 0
    detect_every = DETECT_EVERY
    next_detect = detect_every

    def finalize(upto: int, at_end: bool) -> None:
        nonlocal emitted
        lo = final[-1].frame + 1
        hi = upto
        if hi <= lo:
            return
        f = gf.view()
        new = detect(f, t, lo=lo, hi=hi)
        final.extend(b for b in new if b.frame > final[-1].frame)
        # 確定したカット(次の境目が確定したもの)のサムネイル
        last_end = n if at_end else None
        while emitted < len(final) - (0 if at_end else 1):
            a = final[emitted].frame
            b = final[emitted + 1].frame if emitted + 1 < len(final) else last_end
            writer.put(emitted, _cells_from(buf, a, b))
            emitted += 1
        if not at_end:
            buf.drop_before(final[-1].frame)

    for chunk in iter_chunks(path, nice=nice):
        gf.extend(ex.add(chunk))
        buf.add(n, chunk)
        while sw < len(strip_want) and strip_want[sw] < n + len(chunk):
            fr = strip_want[sw]
            if fr >= n:
                strip_cells[fr] = cv2.resize(chunk[fr - n], (STRIP_W, STRIP_H), interpolation=cv2.INTER_AREA)
            sw += 1
        n += len(chunk)
        if n >= next_detect:
            finalize(n - CONTEXT, at_end=False)
            next_detect = n + detect_every
        if progress and time.time() - last_prog >= 2.0:
            last_prog = time.time()
            frac = n / expect_frames if expect_frames else 0.0
            progress(min(0.99, frac), n, n / max(1e-6, time.time() - t0))
    if n == 0:
        raise RuntimeError("動画のコマを 1 枚も読めませんでした")
    finalize(n, at_end=True)
    writer.flush()
    dec_elapsed = time.time() - t0
    f = gf.view()
    f = {k: v.copy() for k, v in f.items()}

    # 一括で判定し直した結果と、デコード中に確定した結果を比べる(判定が局所的であることの確認)
    batch = [b for b in detect(f, t) if 0 < b.frame < n]
    stream = [b for b in final[1:] if 0 < b.frame < n]
    sb = [(b.frame, b.kind, b.trans) for b in stream]
    bb = [(b.frame, b.kind, b.trans) for b in batch]
    mismatch = len(set(sb) ^ set(bb))
    cuts = make_cuts(f, stream, n, t)
    final_sp = out_dir / sprite_name
    if final_sp.exists():
        shutil.rmtree(final_sp)
    os.replace(sp_dir, final_sp)
    return AnalysisResultData(fps=fps, frames=n, cuts=cuts, features=f, thresholds=t,
                              decode_fps=n / max(1e-6, dec_elapsed), elapsed=time.time() - t0,
                              stream_mismatch=mismatch, strip_cells=strip_cells)


# ── DB への書き込み(ユーザーの付けた値を引き継ぐ) ─────────────────────────────

def _overlap(a0: int, a1: int, b0: int, b1: int) -> int:
    return max(0, min(a1, b1) - max(a0, b0))


def _has_user_fields(o: dict) -> bool:
    tags = [t for t in (o.get("tags") or []) if t not in AUTO_TAGS]
    return bool(tags) or int(o.get("rating") or 0) > 0 or bool(o.get("starred")) or bool((o.get("note") or "").strip())


def _merge_user_fields(c: dict, o: dict) -> None:
    """o のユーザーの値を c に足す(タグは和、評価は大きい方、★ はどちらか、メモはつなぐ)。"""
    tags = list(c.get("tags") or [])
    for tg in o.get("tags") or []:
        if tg not in AUTO_TAGS and tg not in tags:
            tags.append(tg)
    c["tags"] = tags
    c["rating"] = max(int(c.get("rating") or 0), int(o.get("rating") or 0))
    c["starred"] = bool(c.get("starred")) or bool(o.get("starred"))
    a, b = (c.get("note") or ""), (o.get("note") or "")
    if b.strip() and b not in a:
        a = (a + "\n" + b) if a.strip() else b
    c["note"] = a[:2000]


def merge_with_existing(new_cuts: list[dict], old: list[dict], frames: int = 0,
                        stats: dict | None = None) -> list[dict]:
    """再解析: edited の境目を守り、ユーザーの値(タグ・評価・★・メモ)を引き継ぐ。

    new_cuts / old: {start, end, ...}。old は DB の行(tags などを含む dict)。
    1) 重なり 60 % 以上(長い方に対して)の古いカット 1 本 → 新しいカット 1 本(行の id も引き継ぐ: keep_id)。
    2) 1) で行き先の無かった、ユーザーの値を持つ古いカット(2 つに分かれた・隣へ吸収された)は、
       半分以上重なる新しいカット全部へ値を足す(無ければいちばん重なるカットへ)。
    返り値: 新しいカット列(時間順、idx 振り直し)。stats に引き継ぎの件数を入れる。
    """
    edited = sorted([o for o in old if o.get("edited")], key=lambda o: o["start"])
    e_starts = [e["start"] for e in edited]
    # 1) edited のカットはそのまま残し、重なる新しいカットを切り詰める
    cuts: list[dict] = []
    for c in new_cuts:
        segs = [(c["start"], c["end"])]
        k = max(0, bisect.bisect_right(e_starts, c["start"]) - 1)
        while k < len(edited) and edited[k]["start"] < c["end"]:
            e = edited[k]
            k += 1
            nxt = []
            for s0, s1 in segs:
                if e["end"] <= s0 or e["start"] >= s1:
                    nxt.append((s0, s1))
                    continue
                if s0 < e["start"]:
                    nxt.append((s0, e["start"]))
                if e["end"] < s1:
                    nxt.append((e["end"], s1))
            segs = nxt
        for s0, s1 in segs:
            if s1 - s0 <= 0:
                continue
            d = dict(c)
            if s0 != c["start"]:
                d["trans_in"], d["trans_frames"] = "hard", 0
            d["start"], d["end"] = s0, s1
            cuts.append(d)
    for e in edited:
        d = dict(e)
        d["keep_id"] = e.get("id")
        d["edited"] = True
        cuts.append(d)
    cuts.sort(key=lambda c: c["start"])
    # 2) ユーザーの値を引き継ぐ(edited でない古いカット → 重なり 60 % 以上の新しいカット)
    plain = sorted([o for o in old if not o.get("edited")], key=lambda o: o["start"])
    p_starts = [o["start"] for o in plain]
    used: set = set()
    for c in cuts:
        if c.get("edited"):
            continue
        best, bov = None, 0.0
        k = max(0, bisect.bisect_right(p_starts, c["start"]) - 1)
        while k < len(plain) and plain[k]["start"] < c["end"]:
            o = plain[k]
            k += 1
            if o.get("id") in used:
                continue
            ov = _overlap(c["start"], c["end"], o["start"], o["end"])
            if ov <= 0:
                continue
            r = ov / max(1, max(c["end"] - c["start"], o["end"] - o["start"]))
            if r > bov:
                best, bov = o, r
        if best is not None and bov >= 0.6:
            used.add(best.get("id"))
            c["keep_id"] = best.get("id")
            for key in ("tags", "rating", "starred", "note"):
                if key in best:
                    c[key] = best[key]
    # 3) 行き先の無かったユーザーの値(分かれた・吸収された古いカット)
    fresh = [c for c in cuts if not c.get("edited")]
    f_starts = [c["start"] for c in fresh]
    partial = lost = 0
    for o in plain:
        if o.get("id") in used or not _has_user_fields(o):
            continue
        hits = []
        k = max(0, bisect.bisect_right(f_starts, o["start"]) - 1)
        while k < len(fresh) and fresh[k]["start"] < o["end"]:
            c = fresh[k]
            k += 1
            ov = _overlap(c["start"], c["end"], o["start"], o["end"])
            if ov > 0:
                hits.append((ov, c))
        if not hits:
            lost += 1
            continue
        lo = o["end"] - o["start"]
        targets = [c for ov, c in hits if ov >= 0.5 * min(lo, c["end"] - c["start"])]
        if not targets:
            targets = [max(hits, key=lambda x: x[0])[1]]
        for c in targets:
            _merge_user_fields(c, o)
        partial += 1
    for i, c in enumerate(cuts):
        c["idx"] = i
    if stats is not None:
        stats.update({"carried": len(used), "carried_partial": partial, "not_carried": lost,
                      "edited_kept": len(edited)})
    return cuts


def _db_engine(db: str | None):
    if db:
        from sqlmodel import create_engine
        from sqlalchemy import event
        eng = create_engine(f"sqlite:///{db}", connect_args={"timeout": 30})

        @event.listens_for(eng, "connect")
        def _p(c, _r):
            cur = c.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA busy_timeout=10000")
            cur.close()
        return eng
    from app.db.database import engine
    return engine


def _ensure_tables(eng) -> None:
    from sqlmodel import SQLModel
    from app.models.library import LibraryItem, LibraryCut  # noqa: F401
    SQLModel.metadata.create_all(eng, tables=[LibraryItem.__table__, LibraryCut.__table__])


def _set_item(eng, asset_id: int, **kw) -> None:
    from sqlmodel import Session
    from app.models.library import LibraryItem
    with Session(eng) as s:
        it = s.get(LibraryItem, asset_id)
        if not it:
            return
        for k, v in kw.items():
            setattr(it, k, v)
        it.updated_at = _now()
        s.add(it)
        s.commit()


def _row_dict(r) -> dict:
    try:
        tags = json.loads(r.tags_json or "[]")
    except ValueError:
        tags = []
    return {"id": r.id, "idx": r.idx, "start": r.start_frame, "end": r.end_frame, "trans_in": r.trans_in,
            "trans_frames": r.trans_frames, "luma": r.luma, "motion": r.motion, "sat": r.sat,
            "hue": r.hue, "dark": r.dark, "bright": r.bright, "tags": tags if isinstance(tags, list) else [],
            "rating": r.rating, "starred": r.starred, "note": r.note, "edited": r.edited, "thumb_ver": r.thumb_ver}


def _old_cut_rows(eng, asset_id: int) -> list[dict]:
    from sqlmodel import Session, select
    from app.models.library import LibraryCut
    with Session(eng) as s:
        rows = s.exec(select(LibraryCut).where(LibraryCut.asset_id == asset_id)).all()
        return sorted((_row_dict(r) for r in rows), key=lambda o: (o["idx"], o["start"]))


def _lock_db_for_write(s, asset_id: int) -> None:
    """このトランザクションで先に書き込みのロックを取る(読んでから書くまでの間に、別の書き込み
    = 解析中に付けた評価・タグなどが割り込んで消えないように)。SQLite は最初の書き込みでロックを取る。"""
    from sqlalchemy import text
    s.connection().execute(text("UPDATE libraryitem SET updated_at = updated_at WHERE asset_id = :a"),
                           {"a": int(asset_id)})


def _write_rows(s, asset_id: int, cuts: list[dict], rows: dict) -> list:
    """カットの行を置き換える(keep_id のある行は id を保つ)。s: 書き込みのロックを持ったセッション。"""
    from app.models.library import LibraryCut
    keep = {c.get("keep_id") for c in cuts if c.get("keep_id") in rows}
    for rid, r in rows.items():
        if rid not in keep:
            s.delete(r)
    s.flush()
    objs = []
    for c in cuts:
        r = rows.get(c.get("keep_id")) if c.get("keep_id") in keep else None
        kept = r is not None
        if r is None:
            r = LibraryCut(asset_id=asset_id)
        r.idx = c["idx"]
        r.start_frame, r.end_frame = int(c["start"]), int(c["end"])
        r.trans_in, r.trans_frames = c.get("trans_in", "hard"), int(c.get("trans_frames", 0))
        for k in ("luma", "motion", "sat"):
            setattr(r, k, float(c.get(k) or 0.0))
        r.hue = c.get("hue")
        r.dark, r.bright = bool(c.get("dark")), bool(c.get("bright"))
        tags = list(c.get("tags") if c.get("tags") is not None else [])
        for tg in c.get("auto_tags") or []:
            if tg not in tags:
                tags.append(tg)
        r.tags_json = json.dumps(tags, ensure_ascii=False)
        r.rating = int(c.get("rating") or 0)
        r.starred = bool(c.get("starred"))
        r.note = c.get("note") or ""
        r.edited = bool(c.get("edited"))
        r.thumb_ver = (int(r.thumb_ver or 0) + 1) if kept else 0
        s.add(r)
        objs.append(r)
    return objs


def write_cuts_db(eng, asset_id: int, cuts: list[dict]) -> list[dict]:
    """カットを 1 回のトランザクションで置き換える。keep_id のある行は id を保つ。"""
    from sqlmodel import Session, select
    from app.models.library import LibraryCut
    with Session(eng) as s:
        _lock_db_for_write(s, asset_id)
        rows = {r.id: r for r in s.exec(select(LibraryCut).where(LibraryCut.asset_id == asset_id)).all()}
        objs = _write_rows(s, asset_id, cuts, rows)
        s.commit()
        return [{"id": o.id, "idx": o.idx} for o in objs]


class EditConflict(RuntimeError):
    """解析・つなぐ・分けるの間に、別の操作がカットの境目を変えた。"""


def write_analysis_db(eng, asset_id: int, new_raw: list[dict], expect_sig: str, item_kw: dict,
                      stats: dict | None = None) -> list[dict]:
    """解析の結果を DB へ 1 回で書く。ユーザーの値は(解析の始めではなく)このトランザクションの中で
    読み直して引き継ぐ: 解析中に付けた評価・★・タグ・メモを古い値で上書きしない。
    境目(edited のカット)が、スプライトを作ったときから変わっていたら EditConflict(何も書かない)。"""
    from sqlmodel import Session, select
    from app.models.library import LibraryCut, LibraryItem
    with Session(eng) as s:
        _lock_db_for_write(s, asset_id)
        rows = s.exec(select(LibraryCut).where(LibraryCut.asset_id == asset_id)).all()
        old = [_row_dict(r) for r in rows]
        cuts = merge_with_existing(new_raw, old, stats=stats)
        if cuts_signature((c["start"], c["end"]) for c in cuts) != expect_sig:
            raise EditConflict("解析の間にカットがつなぐ・分けるで直されました。もう一度解析してください")
        _write_rows(s, asset_id, cuts, {r.id: r for r in rows})
        it = s.get(LibraryItem, asset_id)
        if it is None:
            raise EditConflict("解析の間にライブラリから外されました")
        for k, v in item_kw.items():
            setattr(it, k, v)
        it.cut_count = len(cuts)
        it.updated_at = _now()
        s.add(it)
        s.commit()
    return cuts


# ── 書き換えの確定(DB とファイルを食い違わせない) ───────────────────────────
# 解析・再判定・つなぐ・分けるは、新しいスプライト・特徴・cuts.json を別の名前(.new)で作ってから
#   1) pending.json(DB に書くカットの境目の指紋と、置き換えるファイルの一覧)を書き、
#   2) DB を 1 回のトランザクションで書き、
#   3) .new を本来の名前へ置き換えて pending.json を消す。
# 2 の前に落ちたら .new を捨てる(DB も前のまま)。2 の後で落ちたら、次に開いたとき(recover_item)に
# DB の境目の指紋が pending.json と同じなら 3 をやり直し、違えば捨てる。
# 別のプロセス(解析の CLI とバックエンド)どうしは <item_dir>/.lock の flock で順番にする。

def cuts_signature(pairs) -> str:
    h = hashlib.sha1()
    for s0, s1 in sorted((int(a), int(b)) for a, b in pairs):
        h.update(f"{s0},{s1};".encode())
    return h.hexdigest()


def db_signature(eng, asset_id: int) -> str:
    from sqlmodel import Session, select
    from app.models.library import LibraryCut
    with Session(eng) as s:
        rows = s.exec(select(LibraryCut.start_frame, LibraryCut.end_frame)
                      .where(LibraryCut.asset_id == asset_id)).all()
    return cuts_signature(rows)


@contextmanager
def item_lock(asset_id: int, blocking: bool = True):
    """素材ごとのファイルのロック(プロセスをまたぐ)。blocking=False で取れなければ False を返す。"""
    import fcntl
    d = item_dir(asset_id)
    d.mkdir(parents=True, exist_ok=True)
    fh = open(d / ".lock", "a+")
    got = False
    try:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            got = True
        except BlockingIOError:
            got = False
        yield got
    finally:
        if got:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        fh.close()


def _rm(p: Path) -> None:
    if p.is_dir():
        shutil.rmtree(p, ignore_errors=True)
    elif p.exists():
        try:
            p.unlink()
        except OSError:
            pass


def _apply_staged(d: Path, files: list) -> None:
    """[(src, dst)] を置き換える(src が None なら dst を消す)。途中で落ちても、もう一度呼べば終わる。"""
    for src, dst in files:
        D = d / dst
        old = D.with_name(D.name + ".old")
        if src is None:
            _rm(D)
            continue
        S = d / src
        if S.is_dir():
            if D.exists():
                _rm(old)
                os.replace(D, old)
            os.replace(S, D)
        elif S.exists():
            os.replace(S, D)
        if old.is_dir():
            _rm(old)


def _discard_staged(d: Path, files: list) -> None:
    for src, _dst in files:
        if src is not None:
            _rm(d / src)


def commit_staged(eng, asset_id: int, files: list, sig: str, db_write):
    """files を置き換える前に DB を書く(db_write)。DB が書けなければ files を捨てて例外。"""
    d = item_dir(asset_id)
    with item_lock(asset_id):
        pend = d / "pending.json"
        _write_json(pend, {"sig": sig, "files": [list(x) for x in files], "pid": os.getpid(),
                           "t": _now().isoformat() + "Z"})
        try:
            out = db_write()
        except BaseException:
            _discard_staged(d, files)
            _rm(pend)
            raise
        _apply_staged(d, files)
        _rm(pend)
        return out


def recover_item(eng, asset_id: int, blocking: bool = False) -> str | None:
    """前の書き換えが途中で止まっていたら終わらせる(DB を書いた後なら置き換え、前なら捨てる)。"""
    d = item_dir(asset_id)
    pend = d / "pending.json"
    if not pend.exists():
        return None
    with item_lock(asset_id, blocking=blocking) as got:
        if not got or not pend.exists():
            return None                         # 書き換えの最中(終われば pending.json は消える)
        try:
            p = json.loads(pend.read_text(encoding="utf-8"))
            files = [(x[0], x[1]) for x in p.get("files") or []]
        except (ValueError, OSError, IndexError, TypeError):
            _rm(pend)
            return "broken"
        if db_signature(eng, asset_id) == p.get("sig"):
            _apply_staged(d, files)
            res = "applied"
        else:
            _discard_staged(d, files)
            res = "discarded"
        _rm(pend)
        log(f"素材 {asset_id}: 途中で止まった書き換えを{'仕上げました' if res == 'applied' else '取り消しました'}")
        return res


def _cuts_json(asset_id: int, res_fps: float, frames: int, chapters: list, cuts: list[dict], t: dict,
               extra: dict) -> dict:
    keys = ("idx", "start", "end", "trans_in", "trans_frames", "luma", "motion", "sat", "hue", "dark",
            "bright", "score", "auto_tags", "edited")
    return {"asset_id": asset_id, "version": DETECTOR_VERSION, "fps": res_fps, "frames": frames,
            "chapters": chapters, "thresholds": t, "created_at": _now().isoformat() + "Z",
            **extra,
            "cuts": [{k: c.get(k) for k in keys if k in c} for c in cuts]}


def _write_json(path: Path, obj: dict) -> None:
    tmp = path.with_suffix(".tmp.json")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def _asset_row(eng, asset_id: int):
    from sqlmodel import Session
    from app.models import Asset
    with Session(eng) as s:
        a = s.get(Asset, asset_id)
        if not a:
            return None
        return {"id": a.id, "file_path": a.file_path, "name": a.name, "duration_sec": a.duration_sec,
                "project_id": a.project_id}


def build_sprites(path: str, fps: float, src_dir: Path, src_layout: list[tuple[int, int]], dst_dir: Path,
                  cuts: list[dict]) -> int:
    """cuts の並び(idx)でスプライトを dst_dir に作る。src_dir(並びは src_layout)に同じ境目の行があれば
    それを使い、無い行はシークで作る。src_dir と dst_dir が同じで並びも同じなら何もしない。
    戻り値: シークで作った行の数。"""
    import cv2
    by_se = {(int(s0), int(s1)): i for i, (s0, s1) in enumerate(src_layout)}
    if (src_dir == dst_dir and dst_dir.exists() and len(cuts) == len(src_layout)
            and all(by_se.get((c["start"], c["end"])) == c["idx"] for c in cuts)):
        return 0
    sheets: dict[int, np.ndarray | None] = {}

    def old_row(i: int) -> list[np.ndarray] | None:
        n = i // SPRITE_CUTS
        if n not in sheets:
            p = src_dir / f"s{n}.jpg"
            im = cv2.imread(str(p)) if p.exists() else None
            sheets[n] = cv2.cvtColor(im, cv2.COLOR_BGR2RGB) if im is not None and im.shape[1] == 3 * TW else None
        sh = sheets[n]
        r = i % SPRITE_CUTS
        if sh is None or (r + 1) * TH > sh.shape[0]:
            return None
        return [sh[r * TH:(r + 1) * TH, k * TW:(k + 1) * TW].copy() for k in range(3)]

    rows: dict[int, list[np.ndarray]] = {}
    need: list[dict] = []
    for c in cuts:
        j = by_se.get((c["start"], c["end"]))
        got = old_row(j) if j is not None else None
        if got is not None:
            rows[c["idx"]] = got
        else:
            need.append(c)
    if need:
        frs = []
        for c in need:
            frs += list(thumb_frames(c["start"], c["end"]))
        got = grab_frames(path, fps, frs)
        blank = np.zeros((TH, TW, 3), np.uint8)
        for c in need:
            rows[c["idx"]] = [got.get(fr, blank) for fr in thumb_frames(c["start"], c["end"])]
    tmp = dst_dir.with_name(dst_dir.name + ".tmp")
    _rm(tmp)
    w = SpriteWriter(tmp)
    blank3 = [np.zeros((TH, TW, 3), np.uint8)] * 3
    for c in cuts:
        w.put(c["idx"], rows.get(c["idx"]) or blank3)
    w.flush()
    _rm(dst_dir)
    os.replace(tmp, dst_dir)
    return len(need)


# ── フィルムストリップの下ごしらえ ───────────────────────────────────────────

def filmstrip_plan(duration_sec: float, fps: float, frames: int) -> dict[int, list[int]]:
    """routers/assets.py の get_filmstrip と同じコマ。ffmpeg の fps={n/長さ:.4f} フィルタ(丸めは near)は
    k 枚目に「時刻 × r を丸めて k 以下になる最後のコマ」= 時刻 (k + 0.5) / r の直前のコマを出す。"""
    import math
    out: dict[int, list[int]] = {}
    if not duration_sec or duration_sec <= 0 or frames <= 0:
        return out
    for n in STRIP_COUNTS:
        r = float(f"{n / max(0.1, duration_sec):.4f}")
        if r <= 0:
            continue
        out[n] = [min(frames - 1, max(0, int(math.ceil((k + 0.5) / r * fps - 1e-9)) - 1)) for k in range(n)]
    return out


def write_filmstrips(asset_id: int, project_id: int | None, plan: dict[int, list[int]],
                     cells: dict[int, np.ndarray]) -> int:
    """data/proxies/<プロジェクト>/<id>_strip96_<n>.jpg を、まだ無いものだけ作る。戻り値: 作った枚数。"""
    import cv2
    if project_id is None or not plan:
        return 0
    d = PROXIES_DIR / str(int(project_id))
    made = 0
    for n, frs in plan.items():
        dest = d / f"{asset_id}_strip96_{n}.jpg"
        if dest.exists() or not all(fr in cells for fr in frs):
            continue
        d.mkdir(parents=True, exist_ok=True)
        strip = np.concatenate([cells[fr] for fr in frs], axis=1)
        tmp = d / f".{asset_id}_strip96_{n}.{os.getpid()}.tmp.jpg"
        cv2.imwrite(str(tmp), cv2.cvtColor(strip, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 85])
        if dest.exists():
            _rm(tmp)
        else:
            os.replace(tmp, dest)
            made += 1
    return made


def run_filmstrips(asset_id: int, db: str | None = None) -> int:
    """フィルムストリップだけ作る(解析済みの素材向け。シークで 1 コマずつ。CPU)。"""
    eng = _db_engine(db)
    a = _asset_row(eng, asset_id)
    if not a or not Path(a["file_path"]).exists():
        log("素材のファイルが見つかりません")
        return 2
    info = probe(a["file_path"])
    plan = filmstrip_plan(a["duration_sec"] or info["duration"], info["fps"], info["frames"])
    todo = {n: frs for n, frs in plan.items()
            if not (PROXIES_DIR / str(a["project_id"]) / f"{asset_id}_strip96_{n}.jpg").exists()}
    if not todo:
        log("フィルムストリップはもうそろっています")
        return 0
    want = sorted({fr for frs in todo.values() for fr in frs})
    cells = grab_frames(a["file_path"], info["fps"], want, w=STRIP_W, h=STRIP_H)
    made = write_filmstrips(asset_id, a["project_id"], todo, cells)
    log(f"フィルムストリップ: {made} 枚(コマ {len(cells)} / {len(want)})")
    return 0


# ── 解析の CLI ─────────────────────────────────────────────────────────────────

def _cleanup_stage(out_dir: Path) -> None:
    """失敗した解析の作りかけ(pending.json が指していないもの)を消す。"""
    if (out_dir / "pending.json").exists():
        return
    for name in ("sprites.new", "sprites.new.tmp", "features.new.npz", "features.new.tmp.npz",
                 "cuts.new.json", "cuts.new.tmp.json"):
        _rm(out_dir / name)


def run_analyze(asset_id: int, db: str | None = None, th: dict | None = None) -> int:
    eng = _db_engine(db)
    _ensure_tables(eng)
    from app.models.library import LibraryItem
    from sqlmodel import Session
    a = _asset_row(eng, asset_id)
    if not a:
        log(f"アセット {asset_id} が見つかりません")
        return 2
    with Session(eng) as s:
        it = s.get(LibraryItem, asset_id)
        if not it:
            log(f"アセット {asset_id} はライブラリに入っていません(先に登録してください)")
            return 2
    if not Path(a["file_path"]).exists():
        _set_item(eng, asset_id, analysis_status="error", analysis_error="素材のファイルが見つかりません",
                  analysis_pid=None)
        log("素材のファイルが見つかりません")
        return 3
    out_dir = item_dir(asset_id)
    committed = False
    try:
        _set_item(eng, asset_id, analysis_status="running", analysis_progress=0.0, analysis_error="",
                  analysis_pid=os.getpid())
        recover_item(eng, asset_id, blocking=True)
        _cleanup_stage(out_dir)
        info = probe(a["file_path"])
        fps = info["fps"]

        def prog(frac, nfr, rate):
            _set_item(eng, asset_id, analysis_progress=round(frac, 4))

        crop = detect_letterbox(a["file_path"], info["duration"])
        if crop != (0, FH, 0, FW):
            log(f"黒帯を除いて解析します: {crop}({FW}×{FH} の座標)")
        plan = filmstrip_plan(a["duration_sec"] or info["duration"], fps, info["frames"])
        res = analyze_file(a["file_path"], out_dir, th=th, progress=prog, nice=False,
                           expect_frames=info["frames"], fps=fps, crop=crop, sprite_name="sprites.new",
                           strip_frames={fr for frs in plan.values() for fr in frs})
        expect = int(info["frames"] or 0)
        if expect and res.frames < 0.99 * expect:
            raise RuntimeError(f"デコードが途中で止まりました({res.frames} / {expect} コマ)。"
                               f"前の解析結果はそのまま残しています")
        # 1) いまの DB の行で並びを決め、スプライト・特徴・cuts.json を .new に作る
        old = _old_cut_rows(eng, asset_id)
        stats: dict = {}
        cuts = merge_with_existing(res.cuts, old, stats=stats)
        sig = cuts_signature((c["start"], c["end"]) for c in cuts)
        build_sprites(a["file_path"], fps, out_dir / "sprites.new", [(c["start"], c["end"]) for c in res.cuts],
                      out_dir / "sprites.new", cuts)
        save_features(out_dir / "features.new.npz", res.features, fps)
        extra = {"decode_fps": round(res.decode_fps, 1), "elapsed_sec": round(res.elapsed, 1),
                 "stream_mismatch": res.stream_mismatch, "source": a["file_path"], "carry": stats,
                 "active_area": {"y0": crop[0], "y1": crop[1], "x0": crop[2], "x1": crop[3], "w": FW, "h": FH}}
        _write_json(out_dir / "cuts.new.json", _cuts_json(asset_id, fps, res.frames, info["chapters"], cuts,
                                                          res.thresholds, extra))
        # 2) DB(ユーザーの値はここで読み直す)→ 3) ファイルを入れ替える
        item_kw = dict(analysis_status="done", analysis_progress=1.0, analysis_error="",
                       analysis_version=DETECTOR_VERSION, analysis_pid=None, analyzed_at=_now(),
                       fps=fps, frames=res.frames, chapters_json=json.dumps(info["chapters"], ensure_ascii=False))
        final_stats: dict = {}
        files = [("sprites.new", "sprites"), ("features.new.npz", "features.npz"), ("cuts.new.json", "cuts.json")]
        final = commit_staged(eng, asset_id, files, sig,
                              lambda: write_analysis_db(eng, asset_id, res.cuts, sig, item_kw, final_stats))
        committed = True
        try:
            made = write_filmstrips(asset_id, a["project_id"], plan, res.strip_cells)
        except Exception as e:  # noqa: BLE001
            made = 0
            log(f"フィルムストリップを作れませんでした(解析の結果には影響しません): {e}")
        log(f"完了: {len(final)} カット / {res.frames} コマ / デコード {res.decode_fps:.0f} fps / "
            f"{res.elapsed:.0f} 秒 / 一括判定との差 {res.stream_mismatch} / "
            f"前のカットと対応 {final_stats.get('carried', 0)} 本"
            f"(分かれた・吸収されたカットへ値を足した {final_stats.get('carried_partial', 0)} 本、"
            f"値を引き継げなかった {final_stats.get('not_carried', 0)} 本)/ フィルムストリップ {made} 枚")
        return 0
    except Exception as e:  # noqa: BLE001
        msg = f"解析に失敗しました: {e}"
        log(msg)
        _cleanup_stage(out_dir)
        try:
            if committed:
                _set_item(eng, asset_id, analysis_error=msg[:500])
            else:
                _set_item(eng, asset_id, analysis_status="error", analysis_error=msg[:500], analysis_pid=None)
        except Exception:
            pass
        return 1


def _other_analysis_running(eng, asset_id: int) -> bool:
    from sqlmodel import Session
    from app.models.library import LibraryItem
    with Session(eng) as s:
        it = s.get(LibraryItem, asset_id)
        if not it or it.analysis_status != "running" or not it.analysis_pid or it.analysis_pid == os.getpid():
            return False
        return analysis_pid_alive(it.analysis_pid, asset_id)


def analysis_pid_alive(pid: int | None, asset_id: int | None = None) -> bool:
    """pid がこの素材の解析の CLI として生きているか(番号の使い回しで別のプロセスを解析と取り違えない)。"""
    if not pid:
        return False
    try:
        with open(f"/proc/{int(pid)}/stat") as fh:
            if fh.read().split(")")[-1].split()[0] == "Z":
                return False                    # ゾンビ
        with open(f"/proc/{int(pid)}/cmdline", "rb") as fh:
            argv = [x.decode(errors="replace") for x in fh.read().split(b"\0") if x]
    except (OSError, ValueError, IndexError):
        return False
    if "app.services.library_cuts" not in argv or not ({"analyze", "reanalyze-thresholds"} & set(argv)):
        return False
    return asset_id is None or str(int(asset_id)) in argv


def run_reanalyze(asset_id: int, db: str | None = None, th: dict | None = None) -> int:
    """features.npz から判定だけやり直す(デコードしない)。境目の変わったカットのサムネイルはシークで作る。"""
    eng = _db_engine(db)
    _ensure_tables(eng)
    from app.models.library import LibraryItem
    from sqlmodel import Session
    a = _asset_row(eng, asset_id)
    out_dir = item_dir(asset_id)
    fp = out_dir / "features.npz"
    if not a or not fp.exists():
        log("特徴ファイル(features.npz)がありません。先に analyze を実行してください")
        return 2
    with Session(eng) as s:
        it = s.get(LibraryItem, asset_id)
        if not it:
            log(f"アセット {asset_id} はライブラリに入っていません")
            return 2
        prev_status = it.analysis_status
    if _other_analysis_running(eng, asset_id):
        log("この素材は解析中です。終わってから再判定してください")
        return 4
    committed = False
    try:
        _set_item(eng, asset_id, analysis_status="running", analysis_pid=os.getpid(), analysis_error="")
        recover_item(eng, asset_id, blocking=True)
        _cleanup_stage(out_dir)
        f, fps = load_features(fp)
        t = _th(th)
        n = len(f["luma"])
        bounds = [b for b in detect(f, t) if 0 < b.frame < n]
        new = make_cuts(f, bounds, n, t)
        prev_json = {}
        try:
            prev_json = json.loads((out_dir / "cuts.json").read_text(encoding="utf-8"))
        except Exception:
            pass
        old = _old_cut_rows(eng, asset_id)
        stats: dict = {}
        cuts = merge_with_existing(new, old, stats=stats)
        sig = cuts_signature((c["start"], c["end"]) for c in cuts)
        # いまのスプライトは DB の idx の並び(つなぐ・分けるの後も)。同じ境目の行は動かし、ほかはシークで作る
        seeks = build_sprites(a["file_path"], fps, sprites_dir(asset_id), [(o["start"], o["end"]) for o in old],
                              out_dir / "sprites.new", cuts)
        extra = {"reanalyzed_from_features": True, "source": a["file_path"], "carry": stats,
                 "active_area": prev_json.get("active_area")}
        _write_json(out_dir / "cuts.new.json", _cuts_json(asset_id, fps, n, prev_json.get("chapters") or [], cuts,
                                                          t, extra))
        item_kw = dict(analysis_status="done", analysis_progress=1.0, analysis_error="",
                       analysis_version=DETECTOR_VERSION, analysis_pid=None, analyzed_at=_now(), fps=fps, frames=n)
        final_stats: dict = {}
        files = [("sprites.new", "sprites"), ("cuts.new.json", "cuts.json")]
        final = commit_staged(eng, asset_id, files, sig,
                              lambda: write_analysis_db(eng, asset_id, new, sig, item_kw, final_stats))
        committed = True
        log(f"再判定: {len(old)} → {len(final)} カット(シークで作ったサムネイル {seeks} 本)/ "
            f"前のカットと対応 {final_stats.get('carried', 0)} 本"
            f"(分かれた・吸収されたカットへ値を足した {final_stats.get('carried_partial', 0)} 本、"
            f"値を引き継げなかった {final_stats.get('not_carried', 0)} 本)")
        return 0
    except Exception as e:  # noqa: BLE001
        log(f"再判定に失敗しました: {e}")
        _cleanup_stage(out_dir)
        try:
            if committed:
                _set_item(eng, asset_id, analysis_error=f"再判定の後片付けに失敗しました: {e}"[:500])
            else:
                _set_item(eng, asset_id, analysis_status=prev_status if prev_status != "running" else "done",
                          analysis_pid=None, analysis_error=f"再判定に失敗しました: {e}"[:500])
        except Exception:
            pass
        return 1


def _parse_set(items: list[str] | None) -> dict:
    out = {}
    for it in items or []:
        k, _, v = it.partition("=")
        try:
            out[k] = json.loads(v)
        except ValueError:
            out[k] = v
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="library_cuts", description="長尺素材のカット解析")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("analyze", "reanalyze-thresholds", "filmstrips"):
        p = sub.add_parser(name)
        p.add_argument("asset_id", type=int)
        p.add_argument("--db", default=None)
        if name != "filmstrips":
            p.add_argument("--set", nargs="*", default=None, help="しきい値の上書き key=value")
    a = ap.parse_args(argv)
    if a.cmd == "filmstrips":
        return run_filmstrips(a.asset_id, a.db)
    th = _parse_set(a.set)
    if a.cmd == "analyze":
        return run_analyze(a.asset_id, a.db, th)
    return run_reanalyze(a.asset_id, a.db, th)


if __name__ == "__main__":
    sys.exit(main())
