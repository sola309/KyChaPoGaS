#!/usr/bin/env python
"""ドラム個別打点の書き出し(キック/スネア/タム/ハイハット/シンバル)。

本体(backend/.venv)とは別のvenvで動かすためのCLI。
ADTOF-pytorch は torch/librosa を要求し、本体と依存が衝突しうるので隔離してある。
呼び出し側は subprocess でこれを実行し、stdout の JSON を受け取る。

  usage: transcribe.py <audio> [--fps 100] [--thresholds a,b,c,d,e]
  出力: {"fps":100, "classes":{"kick":[t,...], "snare":[...], ...}, "peak":{...}}
"""
import argparse, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

# MIDIノート番号 → 役割名。ADTOF の LABELS_5 と同じ並び。
NOTE_NAME = {35: "kick", 38: "snare", 47: "tom", 42: "hihat", 49: "cymbal"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--fps", type=int, default=100)
    ap.add_argument("--thresholds", default="")
    ap.add_argument("--device", default="cuda")
    a = ap.parse_args()

    # ライブラリが重み読込のログを print する。stdout は JSON 専用なので
    # 取り込み中だけ stderr へ逃がす(呼び出し側が JSON をパースできなくなるため)。
    import contextlib
    with contextlib.redirect_stdout(sys.stderr):
        from adtof_pytorch import (transcribe_to_midi, PeakPicker, LABELS_5,
                                   FRAME_RNN_THRESHOLDS)

    with contextlib.redirect_stdout(sys.stderr):
        act = transcribe_to_midi(a.audio, "/dev/null", return_activations=True,
                                 fps=a.fps, device=a.device)
    thr = ([float(v) for v in a.thresholds.split(",")] if a.thresholds
           else FRAME_RNN_THRESHOLDS)
    peaks = PeakPicker(thresholds=thr, fps=a.fps).pick(
        act, labels=LABELS_5, label_offset=0)[0]

    # 打点ごとの強さ(アクティベーション値)も返す。UI側で絞り込みに使う。
    out: dict[str, list] = {}
    for i, note in enumerate(LABELS_5):
        name = NOTE_NAME.get(note, str(note))
        ts = list(peaks.get(note, []))
        col = act[0, :, i]
        vals = []
        for t in ts:
            f = min(len(col) - 1, int(round(t * a.fps)))
            vals.append(round(float(col[f]), 3))
        out[name] = [{"t": round(float(t), 3), "v": v} for t, v in zip(ts, vals)]

    json.dump({"fps": a.fps, "engine": "adtof-pytorch",
               "thresholds": list(map(float, thr)) if hasattr(thr, "__iter__") else thr,
               "classes": out}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
