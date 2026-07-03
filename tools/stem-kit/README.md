# stem-kit — ステム分離→ステム反応モーション

HTDemucs(GPU)で曲を drums/bass/other/vocals に分離し、30Hz音量エンベロープを
beatgrid.json の "stems" に書き足す。mad-kit がそれを読んでモーションを駆動する。

```bash
.venv/bin/python separate.py SONG.wav --beatgrid <project>/beatgrid.json [--stems-out stems/]
```

mad-kit での使い方:
- FX: `"fx":[{"kind":"shake","on":"drums"},{"kind":"vignette_pulse","on":"vocal"}]`
- IDLE: `"idles":[{"kind":"stem_pump","stem":"drums","amp":0.08}]` / stem_bob
- カメラ: `"dbKick":{"stem":"drums","z":30}`
- JS: `MK.stemLevel('vocal', t)` (0..1)

--stems-out のwavは音MAD素材・ミックス差し替えに使える。
