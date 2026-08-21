# drum-kit — ドラム個別打点(ADTOF-pytorch)の自作ブリッジ

`transcribe.py` は `tools/adtof-pytorch/`(git clone、.venv込みのためgit管理外)に置いて使う
CLIのコピー。リポジトリ再現時は:

```
git clone https://github.com/xavriley/ADTOF-pytorch tools/adtof-pytorch
cd tools/adtof-pytorch && python3 -m venv .venv
.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cu130
.venv/bin/pip install librosa pretty_midi numpy && .venv/bin/pip install -e .
cp ../drum-kit/transcribe.py .
```

音楽構造(allin1)側 `tools/music-struct/` の再現手順は docs/audio-analysis-roadmap.md 参照
(NATTEN 0.17.5 CPUビルド + demucs 4.0.1 固定 + torchaudio迂回 kycha_audio_compat)。
