# コンポジション(入れ子のタイムライン)設計 v1

2026-11-14 着手。ブランチ `feature/compositions`。開発前の版はタグ `v2026.11-pocky2026-final`。

## ねらい

- After Effects のコンポジション、AviUtl の Scene にあたるものを KyChaPoGaS に入れる。
- 生成動画を置くだけでなく、多数のレイヤーを重ねたモーショングラフィックス・3D 表現を作れるようにする。
- Web アプリとして重くしない。

## 方針(重くしないための 3 つの決めごと)

1. **親のタイムラインから見たコンポジションは、ただの動画素材。**
   コンポジションは描き出して(レンダリングして)動画素材にし、`kind='comp'` のクリップがその素材を指す。
   親のプレビュー・書き出し・テイク履歴は今までの経路のまま動く。中身を変えたら「古い」印が付き、描き直すと素材が差し替わる。
2. **コンポジションの中身は 1 つの描画エンジンで描く。プレビューも書き出しも同じコード。**
   `tools/comp-kit/comp-engine.js`(three.js、ビルド不要の ES モジュール)。
   編集画面では iframe の中でそのまま動かし、書き出しでは既存の決定論キャプチャ(`motion_graphics.render_html_to_video`、ヘッドレス Chromium)で 1 コマずつ撮る。
   → プレビューと書き出しの見た目がずれない。アルファつきで出せる。
3. **エンジンは iframe の中だけで読む。**
   アプリ本体のバンドルには three.js を入れない。コンポジション編集を開いたときだけ読み込まれる。

## データ

### 表 `composition`(新設。既存の表は変えない)

| 列 | 型 | 意味 |
|---|---|---|
| id | int PK | |
| project_id | int | 持ち主のプロジェクト |
| name | str | |
| width, height | int | 画面の大きさ(px) |
| fps | float | |
| duration_frames | int | 長さ |
| data_json | str | 下の「コンポジション文書」 |
| rev | int | 保存のたびに +1 |
| rendered_rev | int | 最後に描き出したときの rev(0 = 未) |
| rendered_asset_id | int? | 最後に描き出した素材 |
| created_at, updated_at | datetime | |

### クリップ

`clip.kind = 'comp'`、`clip.attrs_json = {"comp_id": N, "rev": 描き出したときの rev}`、`clip.asset_id` = 描き出した素材。
既存の列だけで表せるので clip 表は変えない。

### コンポジション文書(data_json)v1

```jsonc
{
  "version": 1,
  "bg": null,                 // null = 透明。"#rrggbb" = 背景色
  "layers": [ /* 配列の先頭が最前面(AE・AviUtl と同じく上が手前) */ ]
}
```

レイヤー:

```jsonc
{
  "id": "L1",                 // 文書の中で一意の文字列
  "name": "タイトル",
  "type": "text",             // image | video | text | shape | solid | null | camera | comp | model | particles | adjustment
  "in": 0, "out": 120,        // コンポジションの時間(コマ)。out は含まない
  "start": 0,                 // video/comp: 素材の何コマ目から(素材のコマ = コンポジションの fps で数える)
  "speed": 1.0,               // video/comp
  "visible": true, "locked": false, "solo": false,
  "parent": null,             // 親レイヤーの id(位置・回転・拡大を継ぐ)
  "three_d": false,           // true = 3D 空間に置く(カメラの影響を受ける)
  "blend": "normal",          // normal | add | screen | multiply | overlay | lighten | darken | difference
  "matte": null,              // {"layer": "L2", "mode": "alpha" | "alpha_inv" | "luma" | "luma_inv"}
  "masks": [],                // [{"shape":"rect"|"ellipse"|"polygon", "x","y","w","h","points":[[x,y]..], "feather":0, "invert":false, "opacity":100}]  ※各数値はプロパティ値
  "transform": {              // どれも「プロパティ値」(下記)
    "position": [960, 540, 0],  // 親(なければコンポジション)の座標。左上原点・y 下向き・z は奥が正(AE と同じ)
    "anchor":   [0, 0, 0],      // レイヤーの中心からのずれ(px)。[0,0,0] = 中心で回る・拡大する
    "scale":    [100, 100, 100],// %
    "rotation": [0, 0, 0],      // 度。x, y は 3D のときだけ効く。z は時計回りが正
    "opacity":  100             // %
  },
  "source": { /* type ごと。下記 */ },
  "effects": [ /* {"type": "...", "enabled": true, "params": {...プロパティ値}} */ ],
  "motion_blur": false
}
```

**プロパティ値**: 定数(数または配列)か、キーフレーム `{"k": [{"f": 0, "v": [..], "e": "easeOut"}, ...]}`。

- `f` はコンポジションの時間(コマ、小数可)。
- `e` はそのキーから次のキーまでの補間。`linear` | `hold` | `easeIn` | `easeOut` | `easeInOut` | `easeInCubic` | `easeOutCubic` | `easeInOutCubic` | `easeOutBack` | `easeOutElastic` | `easeOutBounce` | `[x1,y1,x2,y2]`(3 次ベジェ)。省略は `linear`。
- キーの前後は端の値で止まる。
- 追加の指定(省略可): `"loop": "cycle" | "pingpong"`、`"wiggle": {"freq": Hz, "amp": 量, "seed": n}`(決定論の乱数)。

**type ごとの source**

| type | source |
|---|---|
| image | `{"asset_id": N}` または `{"url": "..."}` |
| video | `{"asset_id": N}` |
| solid | `{"color": "#rrggbb", "width": W, "height": H}`(省略時はコンポジション大) |
| shape | `{"kind": "rect"|"ellipse"|"polygon"|"star"|"line"|"path", "width","height", "radius"(角丸), "sides", "inner"(star の内径比), "points"(line/path), "closed", "fill": "#..."|null|{"gradient":...}, "stroke": "#..."|null, "stroke_width", "trim": [0,100]}` 数値・色はプロパティ値 |
| text | `{"text": "...", "font": "Noto Sans JP", "weight": 700, "size": 96, "fill", "stroke", "stroke_width", "tracking", "leading", "align": "center", "per_char": {...}}` |
| null | なし(親としてだけ使う) |
| camera | `{"fov": 39.6}` または `{"zoom": px}`。transform の position・rotation、または `"target": [x,y,z]`(注視点、プロパティ値) |
| comp | `{"comp_id": N}`(入れ子。循環は保存時に拒否) |
| model | `{"asset_id": N}`(GLB)+ `"light"` |
| particles | `{"emitter": {...}, "seed": n}`(決定論) |
| adjustment | なし(effects を下の全レイヤーの合成結果に掛ける) |

**テキストの文字ごとアニメ(per_char)**: `{"stagger": コマ, "order": "forward"|"backward"|"center"|"random", "from": {"position":[..],"scale":[..],"rotation":[..],"opacity":0}, "duration": コマ, "e": "easeOutBack", "at": 開始コマ, "out": {同じ形・消えるとき}}`。
AviUtl の「文字毎に個別オブジェクト」+ 登場アニメにあたる。

**エフェクト(v1)**: `blur`(radius) / `glow`(radius, strength, threshold) / `color`(brightness, contrast, saturation, hue, tint) / `rgb_shift`(amount, angle) / `wave`(amp, freq, speed) / `noise`(amount) / `mosaic`(size) / `wipe`(progress, angle, feather) / `drop_shadow`(distance, angle, blur, color, opacity) / `stroke_outline`(width, color)。

### 座標と既定のカメラ

- コンポジションの座標は左上が (0,0)、右下が (width,height)。レイヤーの `position` はレイヤーの anchor(既定 = 中心)が来る場所。
- `three_d: false` のレイヤーは正射影で画面に貼る(カメラの影響なし)。
- `three_d: true` のレイヤーは透視投影。カメラレイヤーが無いときの既定のカメラは、z=0 の面がちょうど画面いっぱいに映る位置(AE の既定と同じ。fov 39.6°)。
- 重なり順は配列の順(先頭が手前)。連続する 3D レイヤーの塊の中だけ、カメラからの距離で並べ替える(AE と同じ考え方)。

## エンジン(tools/comp-kit/comp-engine.js)

```js
import { CompEngine } from '/api/comps/engine/comp-engine.js'
const eng = new CompEngine(canvas, { mode: 'preview' | 'capture', assetUrl, frameUrl, compLoader })
await eng.load(comp)          // comp = {width,height,fps,duration_frames, data}
await eng.renderFrame(f)      // f コマ目を描く。capture では素材の読み込みを待ってから解決する
eng.update(comp)              // 文書の差し替え(編集中)。変わった所だけ作り直す
eng.pick(x, y, f)             // その画素の最前面のレイヤー id(編集画面の選択用)
eng.layerBounds(id, f)        // 画面上の四隅(ハンドル表示用)
eng.dispose()
```

- 決定論: 乱数は seed から、時間は f だけから決める。`Date.now()`・`Math.random()` を使わない。
- video レイヤー: preview では `<video>` をテクスチャに(軽量版を読む)。capture では `frameUrl(asset_id, n)` の画像を 1 コマずつ読む(ずれなし)。
- 入れ子(comp レイヤー): `compLoader(comp_id)` で文書を取り、別のレンダーターゲットに描いてテクスチャにする。

## バックエンド

- `routers/comps.py`
  - `GET /api/comps?project_id=` 一覧 / `POST /api/comps` 作成 / `GET|PATCH|DELETE /api/comps/{id}`
  - `POST /api/comps/{id}/render` 描き出しジョブ(`render_comp`)を投げる
  - `POST /api/comps/{id}/place` タイムラインに comp クリップを置く(未描画なら先に描く)
  - `GET /api/comps/{id}/player.html` 編集画面の iframe・キャプチャ用のページ
  - `GET /api/comps/engine/{path}` エンジンと three.js(tools/comp-kit・tools/mg-libs)
  - `GET /api/comps/vframe/{asset_id}/{n}?fps=` 動画素材の n コマ目(キャプチャ用。まとめて切り出してキャッシュ)
- `job_runner`: `render_comp` → `render_html_to_video(capture='canvas', transparent=bg が null)` → 素材を登録 → `rendered_rev`・`rendered_asset_id` を更新 → その comp を指すクリップの `asset_id` を差し替え。
- `render_final`(本番の書き出し)の前に、古い comp クリップがあれば先に描き直す。

## 編集画面(フロント)

- `components/CompEditor/`(遅延読み込み)。上: iframe のプレビュー(選択枠・ドラッグで移動)。下: レイヤーの帯とキーフレーム。右: プロパティ。
- タイムラインの comp クリップをダブルクリックで開く。パンくずで親へ戻る。
- 文書は JSON なので、Claude などのエージェントが API から直接書ける(`PATCH /api/comps/{id}`)。

## やらないこと(v1)

- コンポジションの中の音(音は親のタイムラインに置く)。
- 親のタイムラインでのライブ合成(必ず描き出した動画を通す)。
- エクスプレッション(式)。代わりに wiggle・loop・親子・文字ごとアニメを用意する。

## 段階

1. 表・API・エンジン v0(image/video/text/shape/solid/null/camera、キーフレーム、親子、3D、ブレンド)・描き出し・comp クリップ
2. 編集画面
3. マスク・マット・エフェクト・文字ごとアニメ・入れ子・adjustment
4. model(GLB)・particles・モーションブラー
5. 参考作品(AviUtl の 2 プロジェクト)との差の洗い出し → 足りない機能、exo/aup の取り込み
