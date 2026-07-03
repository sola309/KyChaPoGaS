#!/usr/bin/env python3
"""
stem-kit — 曲をステム分離し、ステム別の音量エンベロープを beatgrid.json に書き足す。

用途: mad-kit のステム反応モーション(fx/カメラの on:"vocal"|"drums"|"bass"|"other")。
  .venv/bin/python separate.py SONG.wav --beatgrid path/to/beatgrid.json [--stems-out dir]

出力:
  * beatgrid.json に "stems": {vocals|drums|bass|other: [0..1,...]}, "stemsHz": 30 を追記
  * --stems-out 指定時は分離済みwavも保存(音MAD素材/ミックス差し替え用)
"""
import argparse
import json
from pathlib import Path

import numpy as np

ENV_HZ = 30  # エンベロープのサンプリングレート(30Hz ≒ フレーム単位)


def envelopes(wavs: dict[str, np.ndarray], sr: int) -> dict[str, list[float]]:
    out = {}
    hop = sr // ENV_HZ
    for name, w in wavs.items():
        mono = np.abs(w).mean(axis=0)
        n = len(mono) // hop
        env = mono[: n * hop].reshape(n, hop).max(axis=1)
        # 対数圧縮 + 各ステム内で正規化(0..1)。無音は0。
        env = np.log1p(env * 30)
        m = env.max()
        out[name] = [round(float(v), 4) for v in (env / m if m > 0 else env)]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("song")
    ap.add_argument("--beatgrid", required=True)
    ap.add_argument("--stems-out", default=None)
    ap.add_argument("--model", default="htdemucs")
    a = ap.parse_args()

    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model
    from demucs.audio import AudioFile

    model = get_model(a.model)
    model.eval()
    dev = "cuda" if torch.cuda.is_available() else "cpu"

    wav = AudioFile(Path(a.song)).read(streams=0, samplerate=model.samplerate,
                                       channels=model.audio_channels)
    ref = wav.mean(0)
    wav_n = (wav - ref.mean()) / ref.std()
    with torch.no_grad():
        sources = apply_model(model, wav_n[None], device=dev, progress=True)[0]
    sources = sources * ref.std() + ref.mean()

    stems = {name: src.cpu().numpy() for name, src in zip(model.sources, sources)}
    print("stems:", list(stems))

    if a.stems_out:
        import soundfile as sf
        od = Path(a.stems_out); od.mkdir(parents=True, exist_ok=True)
        for name, w in stems.items():
            sf.write(od / f"{name}.wav", w.T, model.samplerate)
        print("wavs →", od)

    envs = envelopes(stems, model.samplerate)
    bg_path = Path(a.beatgrid)
    bg = json.loads(bg_path.read_text())
    bg["stems"] = envs
    bg["stemsHz"] = ENV_HZ
    bg_path.write_text(json.dumps(bg, ensure_ascii=False))
    print(f"beatgrid updated: {bg_path} (stems {ENV_HZ}Hz, {len(envs['drums'])} samples)")


if __name__ == "__main__":
    main()
