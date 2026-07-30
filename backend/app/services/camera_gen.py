"""
ビート駆動3Dカメラ生成 — beatgrid から scene3d/3dcam 用カメラキーフレームを作る。

出力形式は render_orbit.mjs / mad-kit scene3d / generate_video_3dcam と共通:
  [{at: 0..1, az, el, dist, fov, roll, ease}, ...]
at はショット内正規化時刻。az/el ラジアン、dist はシーン半径倍率。
"""

import math


def beat_camera(
    bpm: float,
    beats: list[float],
    downbeats: list[float],
    start_sec: float,
    end_sec: float,
    style: str = "punch_in",
    intensity: float = 1.0,
) -> list[dict]:
    """区間[start_sec, end_sec]のビートに同期したカメラキーを生成する。

    style:
      punch_in   — 小節頭で一段ずつ寄る(サビ前の圧)
      orbit_beat — 小節ごとに回り込みが進む(ease付きステップ)
      sway_beat  — ビートで左右に揺れる(ノリ)
      riser      — ゆっくり寄り+仰角上昇+最後にFOV開放(ビルドアップ)
    intensity: 0.5=控えめ 1.0=標準 1.5=強め
    """
    dur = max(0.01, end_sec - start_sec)
    dbs = [t for t in downbeats if start_sec <= t <= end_sec]
    bts = [t for t in beats if start_sec <= t <= end_sec]
    k = max(0.0, min(2.0, intensity))

    def at(t: float) -> float:
        return round(max(0.0, min(1.0, (t - start_sec) / dur)), 4)

    keys: list[dict] = []

    if style == "punch_in" and dbs:
        d0, step = 2.6, (1.1 * k) / max(1, len(dbs))
        keys.append({"at": 0.0, "az": -0.15 * k, "el": 0.18, "dist": d0, "fov": 38})
        for i, t in enumerate(dbs):
            keys.append({"at": at(t), "az": -0.15 * k + 0.06 * k * (i + 1),
                         "el": 0.18 + 0.015 * i,
                         "dist": d0 - step * (i + 1), "fov": 38 + i,
                         "ease": "outCubic"})
        keys.append({"at": 1.0, "az": keys[-1]["az"] + 0.04 * k,
                     "el": keys[-1]["el"], "dist": keys[-1]["dist"] - 0.05,
                     "fov": keys[-1]["fov"], "ease": "linear"})

    elif style == "orbit_beat" and dbs:
        swing = 0.5 * k
        total = swing * len(dbs)
        keys.append({"at": 0.0, "az": -total / 2, "el": 0.22, "dist": 2.3, "fov": 40})
        for i, t in enumerate(dbs):
            keys.append({"at": at(t), "az": -total / 2 + swing * (i + 1),
                         "el": 0.22, "dist": 2.3, "fov": 40, "ease": "inOut"})

    elif style == "sway_beat" and bts:
        # 全ビートだと過密なので2拍ごと
        pick = bts[::2] or bts
        amp = 0.18 * k
        keys.append({"at": 0.0, "az": 0.0, "el": 0.2, "dist": 2.2, "fov": 40})
        for i, t in enumerate(pick):
            keys.append({"at": at(t), "az": amp * (1 if i % 2 == 0 else -1),
                         "el": 0.2, "dist": 2.2, "fov": 40, "ease": "inOut"})
        keys.append({"at": 1.0, "az": 0.0, "el": 0.2, "dist": 2.2,
                     "fov": 40, "ease": "inOut"})

    elif style == "riser":
        keys = [
            {"at": 0.0, "az": 0.0, "el": 0.10, "dist": 2.8, "fov": 36},
            {"at": 0.85, "az": 0.12 * k, "el": 0.30, "dist": 1.9,
             "fov": 38, "ease": "inCubic"},
            {"at": 1.0, "az": 0.15 * k, "el": 0.34, "dist": 1.55,
             "fov": 46 + 6 * k, "ease": "outCubic"},
        ]

    if not keys:
        # フォールバック: ゆっくりアーク
        keys = [{"at": 0.0, "az": -0.4, "el": 0.2, "dist": 2.3, "fov": 40},
                {"at": 1.0, "az": 0.4, "el": 0.25, "dist": 2.0, "fov": 42,
                 "ease": "inOut"}]

    # at重複(同一小節頭に2キー等)を除去して昇順を保証
    seen: set = set()
    out = []
    for kf in sorted(keys, key=lambda x: x["at"]):
        if kf["at"] in seen:
            continue
        seen.add(kf["at"])
        out.append({k2: (round(v, 4) if isinstance(v, float) else v)
                    for k2, v in kf.items()})
    return out
