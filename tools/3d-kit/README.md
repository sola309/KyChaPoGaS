# 3d-kit — 画像→3Dモデル→映像素材

生成AI 3Dモデルを MAD 映像に組み込むためのキット。

## パイプライン

```
画像アセット ─┬─ object: Hunyuan3D-2 (ComfyUIネイティブ) ─→ GLBメッシュ(無テクスチャ)
              ├─ object_mv: Hunyuan3D-2mv (正面/左/背面/右) → 精度向上GLB
              └─ relief: MoGe-2 ─→ 元絵テクスチャ付きレリーフGLB(3Dフォト用)
GLB ─→ render_orbit.mjs ─→ 透過webm(vp9+alpha, カメラワーク焼き込み)
GLB ─→ mad-kit scene3d テンプレート ─→ リアルタイム3Dカメラワーク(最終レンダも決定論)
```

## API

- `POST /api/generation/model3d` — {project_id, mode, image_asset_id, seed, orbit?}
  - orbit 付きなら GLB 生成後に透過webmも連続生成
- `POST /api/generation/model3d/orbit` — 既存 model3d アセットから別カメラで焼き直し
- UI: 生成パネル「🧊 3D」タブ

## render_orbit.mjs

```
node render_orbit.mjs --glb model.glb --out out.webm \
  --preset orbit|dolly_in|dolly_out|sway|arc_l|arc_r|parallax \
  --seconds 4 --fps 30 --width 1280 --height 720 \
  --style standard|toon|wire [--turns 1]
```

- headless Chromium (swiftshader) + three.js。frontend の playwright-core を借用
- toon: 3段グラデ MeshToonMaterial + 反転ハル輪郭線(白彫像風)
- relief には `--preset parallax`(平行移動+微ドリー、画面充填フレーミング)

## ハマりどころ(実測)

- **ボクセル由来メッシュは巻き向き反転**していることがある → 多数決判定で
  面を裏返してから computeVertexNormals(真っ黒レンダ対策、実装済み)
- MoGePointMapToMesh の `decimation` は頂点ストライド(1-8)。頂点数ではない
- three r180 は `three.core.min.js` に分割 — mg-libs に両方必要
- GLTFLoader.js の `../utils/BufferGeometryUtils.js` 相対importは `./` にパッチ済み
- モデル重み: `tools/comfyui/models/checkpoints/hunyuan3d-dit-v2{,-mv}_fp16.safetensors`,
  `models/geometry_estimation/moge_2_vitl_normal_fp16.safetensors`(+DA3 mono large)

## mad-kit scene3d

```json
{ "template": "scene3d", "params": {
    "model": "kyoko3d", "camera": "orbit", "turns": 0.5,
    "style": "toon", "bg": {"pattern": "soft"},
    "ornaments": [{"kind": "nameplate", "text": "杏子3D", "x": 1400, "y": 820}] } }
```

- `camera` はプリセット名 or `[{at,az,el,dist,fov}]` キーフレーム配列
- GLB は project/assets/*.glb → data URL 同梱(three.js は importmap+dataURL で自己完結)
- ヘッドレスレンダは `window.__madAssetsReady` を待つ(motion_graphics.py 側実装済み)

## AIレンダ動画: 3Dカメラ × Wan2.2 Fun Control (2026-07-06 追加)

「カメラワークは3Dで決め、絵はAIが描く」ワークフロー。

```
GLB + カメラ指定 → render_orbit.mjs --style depth (81f/16fps, 近=白)
  → Wan2.2 Fun Control (ref_image=キャラ原画, control_video=深度列)
  → 原画品質のカメラワーク動画 (約5秒)
```

- API: `POST /api/generation/video/3dcam` {model_asset_id, ref_image_asset_id, prompt,
  camera: {preset,turns} or [{at,az,el,dist,fov}], length(4n+1), seed, keep_control_video}
- UI: 🧊3Dタブ「🎬 AIレンダ動画」
- 重み: wan2.2_fun_control_{high,low}_noise_14B_fp8_scaled (各14.3GB) + Lightning LoRA 4step
- job: generate_video_3dcam (heavy, VRAM~24GB)。lengthは4n+1(81=5.06s@16fps)
- 深度は uNear=0.9r/uFar=3.2r 固定レンジ(フリッカー防止)。DL中断に注意(サイズ検証すること)
