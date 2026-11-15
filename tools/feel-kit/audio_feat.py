#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""feel-kit / 音の解析: 拍・小節(beat_this)・オンセット(全体と帯域、あればステムごと)・コマごとの音量と帯域のエネルギー。

  backend/.venv/bin/python audio_feat.py <音つき動画 か 音声> --out audio.json [--fps 60] [--stems <stem-kit の --stems-out フォルダ>]

出力 audio.json(時刻はすべて「コマ」= 秒 × fps。小数):
  bpm, beats[], downbeats[], beat_pos[](小節の中の何拍目か 1..)
  onsets{all, low, mid, high, (drums, bass, vocals, other)}: [[コマ, 強さ 0..1], …]
  rms[], band{low, mid, high}[]: コマごと(0..1 に正規化)
  sections[]: 小節ごとの音量の平均(曲の展開を見る)
新しいモデルは入れない(beat_this は backend/.venv に入っている物。librosa は立ち上がりと帯域だけに使う)。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

import numpy as np


def to_wav(path, sr=44100):
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', path, '-vn', '-ac', '2', '-ar', str(sr), tmp], check=True)
    return tmp


def onsets_of(y, sr, fps, fmin=None, fmax=None, delta=0.07):
    import librosa
    hop = 256
    S = librosa.feature.melspectrogram(y=y, sr=sr, n_fft=2048, hop_length=hop, n_mels=128, fmin=fmin or 20, fmax=fmax or sr / 2)
    env = librosa.onset.onset_strength(S=librosa.power_to_db(S, ref=np.max), sr=sr, hop_length=hop)
    if env.max() <= 0:
        return [], env
    env = env / env.max()
    fr = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, backtrack=False, delta=delta, wait=int(0.05 * sr / hop))
    t = librosa.frames_to_time(fr, sr=sr, hop_length=hop)
    return [[round(float(a * fps), 2), round(float(env[i]), 3)] for a, i in zip(t, fr)], env


def per_frame(x, sr, fps, n):
    hop = sr / fps
    out = np.zeros(n)
    for i in range(n):
        a, b = int(i * hop), int((i + 1) * hop)
        seg = x[a:b]
        out[i] = np.sqrt(np.mean(seg ** 2)) if len(seg) else 0
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--out', required=True)
    ap.add_argument('--fps', type=float, default=60)
    ap.add_argument('--stems', default=None, help='drums.wav bass.wav vocals.wav other.wav のあるフォルダ(stem-kit separate.py --stems-out)')
    a = ap.parse_args()
    import librosa
    import soundfile as sf
    from scipy.signal import butter, sosfiltfilt
    wav = to_wav(a.src)
    y2, sr = sf.read(wav)
    y = y2.mean(axis=1) if y2.ndim > 1 else y2
    y = y.astype(np.float32)
    fps = a.fps
    n = int(len(y) / sr * fps)
    out = {'src': os.path.abspath(a.src), 'fps': fps, 'frames': n}
    # 拍(beat_this)
    try:
        import torch
        from beat_this.inference import File2Beats
        f2b = File2Beats(checkpoint_path='final0', device='cuda' if torch.cuda.is_available() else 'cpu', dbn=False)
        beats, down = f2b(wav)
        out['engine'] = 'beat_this'
    except Exception as e:      # noqa: BLE001
        print('beat_this が使えない → librosa:', e, file=sys.stderr)
        tempo, bf = librosa.beat.beat_track(y=y, sr=sr)
        beats = librosa.frames_to_time(bf, sr=sr)
        down = beats[::4]
        out['engine'] = 'librosa'
    beats, down = np.asarray(beats, float), np.asarray(down, float)
    out['bpm'] = round(float(60 / np.median(np.diff(beats))), 2)
    out['beats'] = [round(float(t * fps), 2) for t in beats]
    out['downbeats'] = [round(float(t * fps), 2) for t in down]
    pos, k = [], 0
    for t in beats:
        if len(down) and np.min(np.abs(down - t)) < 0.03:
            k = 1
        else:
            k += 1
        pos.append(k)
    out['beat_pos'] = pos
    # オンセット
    bands = {'all': (None, None), 'low': (20, 200), 'mid': (200, 2500), 'high': (2500, 16000)}
    out['onsets'] = {}
    for name, (lo, hi) in bands.items():
        out['onsets'][name], _ = onsets_of(y, sr, fps, lo, hi)
    # コマごとの音量と帯域
    def norm(v):
        m = np.percentile(v, 99.5) or 1
        return [round(float(min(1, x / m)), 3) for x in v]
    out['rms'] = norm(per_frame(y, sr, fps, n))
    out['band'] = {}
    for name, (lo, hi) in list(bands.items())[1:]:
        sos = butter(4, [lo, min(hi, sr / 2 - 100)], btype='band', fs=sr, output='sos')
        out['band'][name] = norm(per_frame(sosfiltfilt(sos, y), sr, fps, n))
    # ステム(あれば)
    if a.stems and os.path.isdir(a.stems):
        out['stem_rms'] = {}
        for name in ('drums', 'bass', 'vocals', 'other'):
            p = os.path.join(a.stems, name + '.wav')
            if not os.path.exists(p):
                continue
            s, ssr = sf.read(p)
            s = (s.mean(axis=1) if s.ndim > 1 else s).astype(np.float32)
            out['onsets'][name], _ = onsets_of(s, ssr, fps, delta=0.1)
            out['stem_rms'][name] = norm(per_frame(s, ssr, fps, n))
    # 小節ごとの音量(展開)
    rms = np.array(out['rms'])
    sec = []
    db = out['downbeats']
    for i in range(len(db) - 1):
        a0, a1 = int(db[i]), int(db[i + 1])
        sec.append({'bar': i + 1, 'f0': a0, 'f1': a1, 'rms': round(float(rms[a0:a1].mean()), 3),
                    'low': round(float(np.mean(out['band']['low'][a0:a1])), 3), 'high': round(float(np.mean(out['band']['high'][a0:a1])), 3)})
    out['sections'] = sec
    json.dump(out, open(a.out, 'w'), ensure_ascii=False)
    os.unlink(wav)
    print('bpm', out['bpm'], 'beats', len(out['beats']), 'bars', len(db), {k: len(v) for k, v in out['onsets'].items()})


if __name__ == '__main__':
    main()
