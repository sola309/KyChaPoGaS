# cutout-kit — 高品質切り抜き

生成イラスト→透過PNG。旧 white-matte 除去(白かぶり・背景残りの原因)の置き換え。

- マスク: rembg / **isnet-anime**(既定・アニメ生成向け) or birefnet-general(写真・汎用)
- デフリンジ: 白背景生成の縁の白かぶりを逆算除去 (--bg white)
- 影抑制: ドロップシャドウ(半透明・低彩度・暗)をαから除去
- 掃除: 浮きゴミ成分除去 + 外側1pxフェザー

```bash
# CLI (backend venv)
repo/backend/.venv/bin/python cutout.py IN.png [OUT.png] [--model birefnet-general] [--bg none]

# API (lightレーンのジョブになる)
POST /api/assets/{id}/cutout  {"model":"isnet-anime","bg":"white"}
```

AI指示・シートからは「この画像を切り抜いて」で cutout ジョブを投入する。

- bleed.py: 縁にミラーのりしろ+外周ぼかし(パン/視差の切れ目対策)。`bleed.py IN.jpg --frac 0.10`
