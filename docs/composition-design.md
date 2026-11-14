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

## v1.1 の追加

2026-11-14。参考作品(AviUtl / AE)の読み解き(`reference/aviutl_mad/ANALYSIS.md` 7 章)に合わせて、文書の書式を足した。
v1 の文書はそのまま読める(`version` は 1 のまま。足した項目は書かなければ v1 と同じ動き)。
編集画面むけの機械可読な一覧は `tools/comp-kit/schema.json`(エフェクト・レイヤー種別・共通項目・合成モード・イージング・プリセット)。

### エフェクトは「上から順の列」。位置の足し算・切り抜きも同じ列に書く

`effects` は配列の順に掛かる。同じ種類を何個重ねてもよい。長さ・座標の単位は **拡大・回転する前のレイヤーの px**(原点 = レイヤーの中心。拡大率 50% のレイヤーに幅 30 の帯を切ると、画面では 15px)。
角度は 0° = 上・時計回り。エフェクトはレイヤー空間で掛かり、そのあと transform で画面に置く(v1 の「画面空間で掛ける」をやめた。`"fx_space": "screen"` は無い)。

- **軽いエフェクト**(schema の `cheap: true`)は、レンダーターゲットを使わない。位置の足し算は行列に畳み、切り抜き・色はレイヤーを描くシェーダの中で順に評価する。
  切り抜き(`clip_line` `crop` `mask_shape` `iris`)は描く四角形そのものも切りつめる(全面の四角を細い帯に切る、という作りが軽い)。
- **重いエフェクト**(ぼかし・縁・影・ゆがみ)が出てきたときだけ、「レイヤーの箱 + はみ出す分」の大きさの RT に描いて掛ける。RT が画面の 1.5 倍より大きくなるとき・範囲の決まらない絵(粒子・文字ごとアニメ・モデル)は画面大の RT で掛ける。
- `crop` で切ったあとは、切ったあとの箱が「レイヤーの箱」になる(あとに続く `clip_line` の中心、`mask_shape` の既定の大きさ、`border`、`wipe` の範囲など)。
- 対応していない `type`(取り込みで残した `{"type":"aviutl_script","name":...}` など)は飛ばす。警告は名前ごとに 1 回。

**位置・並べる**

| type | params(数・色はプロパティ値) | 働き |
|---|---|---|
| `offset` | `position:[x,y,z]`(足す。`{"x":..,"y":..}` の分け書きも可)、`scale`(% を掛ける。数か `[sx,sy]`)、`rotation`(足す。数 = Z、`[x,y,z]`)、`opacity`(% を掛ける) | AviUtl の 座標・拡大率・回転・透明度。1 レイヤーに何個でも。position は親の空間の px(拡大率に関係なく足す) |
| `flip` | `h` `v`(真偽。別名 `horizontal` `vertical`。何も書かなければ左右)、`luma` `hue` `alpha`(輝度・色相・透明度の反転) | 反転。箱の中心で裏返す |
| `repeat`(別名 `tile`) | `mode: "grid"`: `count_x` `count_y`、`gap_x` `gap_y`(自分の幅・高さに対する %。100 = すき間なし)、`spacing_x` `spacing_y`(足すすき間 px)、`stagger_rows`、`scroll_x` `scroll_y`(px。流す)、`mirror` / `"line"`: `count`(= `count_x`)、`gap`(= `gap_x`。ピッチ px。省略 = 自分の幅)、`angle`(既定 90 = 右)、`both` / `"circle"`: `count`、`radius`、`rotation`(開始角。= `angle`)、`arc`(範囲の度。= `sweep`。既定 360)、`rotate`(中心を向ける。既定 true) | 画像ループ・一方向に並べる・円形配置。この前に書いたエフェクトは 1 個ずつに、後に書いたものは並べた全体に掛かる。grid は中心をそろえて広がり、箱も全体の大きさになる |

**切る・隠す**(どれも軽い)

| type | params | 働き |
|---|---|---|
| `clip_line` | `cx` `cy`(箱の中心から px)、`angle`、`width`、`feather`、`invert` | 斜めクリッピング。法線 n = (−sin a, cos a)(a = 0 で下向き)。`width` 0 = n の側(a = 0 なら中心より下)を消す / 正 = 線を中心にその幅の帯だけ残す / 負 = 帯を消す |
| `crop`(別名 `clip`) | `top` `bottom` `left` `right`(px)、`feather`、`recenter`(= `center`。切ったあとの絵の中心を元の中心へ寄せる) | クリッピング。絵は動かさず端が欠ける |
| `blinds` | `ratio`(残す %)、`pitch`(縞の幅 px。別名 `width`。`count` でも可)、`angle`、`stagger`(%。縞ごとに開く時刻をずらす)、`feather`、`phase`(px) | 斜めブラインド。角度の向きに pitch ごとの縞を並べ、各縞の頭から ratio % を残す |
| `clip_sector` | `start`、`sweep`(時計回りが正。負も可)、`cx` `cy`、`feather`、`keep` | 扇クリッピング。start から sweep の扇形を **消す**。`keep: true` でその扇形だけ残す |
| `radial_wipe` | `start`、`sweep`(または `progress` %)、`cx` `cy`、`feather` | 扇形だけ **残す**(clip_sector の逆) |
| `iris` | `progress`(%)か `radius`(px)、`shape`(circle / rect / diamond / star / polygon)、`sides`、`inner`、`cx` `cy`、`feather`、`invert` | 形で開く |
| `wipe` | `progress` `angle` `feather` | v1 と同じ。範囲はレイヤーの箱 |
| `mask_shape`(別名 `mask`) | `shape`(rect / ellipse / diamond / triangle / pentagon / hexagon / star / polygon)、`x` `y`、`size` + `aspect`(正 = 横を縮める %、負 = 縦を縮める %)または `w` `h`、`rotation`、`radius`(rect の角丸)、`sides` `inner`、`feather`、`expansion`、`invert`、`opacity`、`fit_original` | マスク(図形)。レイヤーに付いて動く。大きさを書かなければレイヤーの箱 |
| `mask_image` | `asset_id`(または `url`)、`x` `y`、`size`(画像の長辺 px。0・省略 = 元の大きさ)、`scale`、`aspect`、`rotation`、`feather`、`invert`、`channel`("alpha" / "luma" / 省略 = アルファがあればアルファ、無ければ輝度)、`opacity` | マスク(画像)。1 回の描画で 2 枚まで(超えると RT に描き出す) |
| `opacity` | `amount`(%) | 列の途中で不透明度を掛ける |

**色**(どれも軽い)

`fill`(`color` `amount` `keep_luma`。単色化)、`tint`(= 輝度を保つ fill)、`color`(v1 の brightness / contrast / saturation / hue / tint に `luminance`(100 = 元)と `gamma` を足した)、`grayscale`(`amount`)、
`duotone`(`dark` `light` `gamma` `amount`)、`threshold`(別名 `binarize`。`level` 0〜255、`light` `dark`、`softness`、`amount`。色に `#rrggbbaa` を書けば片側を透明にできる)、
`bleach_bypass`(`amount` `saturation` `gamma`)、`invert`(`amount` `luma_only`)、`levels`(`in_black` `in_white` `gamma` `out_black` `out_white`)、`gradient_map`(`colors` 2〜4、`amount`)、`posterize`(`levels`)、
`chroma_key`(`color` `hue_range` `sat_range` `edge` `spill`。範囲は 256 目盛り。`mode: "color_key"` + `diff_range` で色の近さだけ)、`luma_key`(`threshold` `softness` `invert`)、
`vignette`(`amount` `radius` `softness` `color`)、`flash`(`amount` `color`)、`lightleak`(`color` `x` `y` `radius` `amount` `angle` `stretch`)、
`gradient_overlay`(別名 `gradient`。`color` → `color2` または `colors` 2〜4、`shape` linear / radial、`angle`(0 = 上から下へ)、`cx` `cy`、`width`、`amount`、`blend` normal / add / subtract / multiply / screen / overlay / lighten / darken / difference)、
`border`(`width` `color` `position` inside / center / outside、`opacity`)、`noise`(v1 と同じ)、
`overlay_source`(`asset_id` / `url` / `comp_id`、`mode` over / under / replace_color / luma_to_alpha、`x` `y` `scale` `opacity`、`start` `speed`、`tile`、`fit`、`kind: "video"`)= 別の素材をレイヤーの絵に重ねる・色だけ置き換える。

**重いエフェクト**

v1 の `blur`(+ `variant: "directional" | "radial"`)`glow` `rgb_shift` `wave` `mosaic` `drop_shadow`(+ `x` `y` での指定)`stroke_outline` に加えて:
`stroke_outline`(別名 `outline`)に `position`(outer / inner / center)`blur` `opacity` `only`(縁だけ。`mix < 0` も同じ)、
`inner_shadow`、`long_shadow`(`length` `angle` `color` `opacity` `fade`)、`trace_outline`(`progress` `width` `start` `threshold` `color` `only_line`。輪郭の帯を、中心まわりの角度で progress % まで見せる。AviUtl の輪郭追跡の近似)、`feather`(`radius`)、
`directional_blur`(`length` `angle`)、`radial_blur`(`amount`、`mode` zoom / spin、`cx` `cy`)、`sharpen`、`raster`(`amp` `wavelength` `speed` `vertical`)、`turbulent_displace`(`amount` `size` `seed` `evolution` `octaves`)、
`halftone`(`size` `min` `max` `angle` `fg` `bg` `stagger` `self_mask` `use_color` `invert`)、`glitch`(`amount` `block` `rate` `rgb_shift` `seed` `speed`)、`mirror`(`angle` `cx` `cy`)、`polar`(`invert`)。
`wave` の `freq` は v1 と同じく「コンポジションの高さあたりの山の数」。

### プロパティ値・イージング

- `e`: v1 の名前に加えて Penner 式の全種類 `inQuad` `outQuad` `inOutQuad` `outInQuad`、同じく `Cubic` `Quart` `Quint` `Sine` `Expo` `Circ` `Elastic` `Back` `Bounce`。
  ほかに `{"pow": n}`(n 乗で減速。TA の beki。`"out": false` で加速)、`{"back": s, "mode": "out" | "in" | "inOut"}`、`{"penner": 番号}`(AviUtl のイージング番号 1〜41)。
- `{"k": [...], "ignore_mid": true, "e": ...}`: 最初のキーから最後のキーへ 1 本の補間(途中のキーは見ない。中間点無視)。
- `transform.position`(と `offset.position`)は `{"x": <prop>, "y": <prop>, "z": <prop>}` と分けて書ける。

### レイヤーの追加項目

| 項目 | 意味 |
|---|---|
| `type: "pattern"` | 模様。`source: {kind, colors(1〜4), size, angle, offset:[x,y], line_width, softness, ratio, width, height, …}`。kind = stripes / checker / dots / grid / hex / triangles / uroko / yagasuri / asanoha / seigaiha / shippo / kagome / halftone / rays / concentric / waves / noise / grain / zigzag / gradient。式で描くのでどの拡大率でもくっきり。`offset` を動かすと流れる。kind ごとの追加: `stagger`(dots・halftone)、`slope`(yagasuri)、`rings`(seigaiha)、`count` `jitter` `inner` `seed`(rays)、`amplitude` `wavelength`(waves・zigzag)、`contrast` `octaves` `seed`(noise)、`amount`(grain)、`grad_angle` `grad_length` `grad_center` `grad_type` `dot_min` `dot_max`(halftone) |
| `fill: {"pattern": {...}}` | shape・text・solid の塗りに模様。solid は `fill: {"gradient": {...}}` も可 |
| `type: "group"` | グループ制御。`scope`: 自分より下の N 層(0・省略 = 下すべて)または id の配列。自分の `in`〜`out` の間だけ効く。transform は「画面の中心を軸にした回転・拡大 + 位置のずれ」(position が画面の中心なら動かさない)、`opacity` と `effects` は対象の各レイヤーへ配る(effects は各レイヤーの列の末尾に足す)。入れ子可(内側 → 外側) |
| `type: "camera"` の追加 | `scope`(group と同じ。範囲の違うカメラを同時に置ける。範囲に入っていない 3D レイヤーは既定のカメラ)、`source.zoom`(距離。AviUtl は 1024)、`source.ortho`、`source.target_layer` / `source.targets` + `source.target_index`(レイヤーの位置を注視。position を書かなければその正面 zoom の距離に据える)、`source.zbuffer: false`(奥行きで並べ替えず配列の順)、`source.dof: {focus_distance, aperture, max_blur}`(レイヤーごとに、ぼかし半径 = aperture × |d − focus| / d。d = anchor の奥行き)。`target` は position と同じ空間(親があれば親の空間) |
| `type: "sequence"` / `source.sequence` | 連番画像。`{"asset_ids": [...]}` または `{"url_pattern": ".../%04d.png", "start": 1, "count": N, "fps": 24}`。image・video レイヤーの source に書いてもよい |
| `repeater` | 複製。`{"count", "mode": "linear" | "grid" | "radial" | "random", "offset": {position, rotation, scale, opacity}(1 個ごとに重ねて掛かる), "grid": {cols, gap:[x,y], pitch:[x,y], stagger}, "radial": {radius, start_angle, sweep, face_center}, "random": {area:[w,h,d], seed, rotation, scale_range:[min,max], rotation_3d}, "time_offset": コマ, "order": "back" | "front"}`。置き場所のずれは親の空間で足し、回転・拡大は 1 個ずつ自分の anchor を中心に掛かる。`time_offset` は複製 i を i × time_offset コマ前の時刻で評価する(変形・不透明度。中身やエフェクトが動くレイヤーは 64 個まで中身ごと)。描画は 1 回にまとめる。3D レイヤーは奥から並べる。エフェクトは複製の前に 1 回だけ掛かる |
| `time_remap` | 素材のコマを直接指定するプロパティ値(video・comp・sequence。`source.time_remap` でも可)。`freeze`(そのコマで止める)、`reverse`、`loop`(true / "pingpong"。`source.loop` でも可) |
| `posterize_time` | コマ打ち。1 秒あたり N コマに間引いてレイヤー全体(変形・中身・エフェクト)を評価 |
| `transition_in` / `transition_out` | `{"type": "fade" | "slide" | "wipe" | "blinds" | "iris" | "radial" | "zoom" | "flip" | "blur" | "clip", "duration": コマ, "e", …}`。文書は書き換えず、評価のときに変形・エフェクトとして足す。type ごと: slide `direction`(left / right / up / down か角度)`distance` `fade`、wipe `angle` `feather`、blinds `pitch` `angle` `stagger`、iris `shape` `feather`、radial `start` `direction: "ccw"`、zoom `from`(%)、flip `axis`、blur `radius`、clip `side`(最後まで隠れている側)|
| `clip_to: "<id>"` | そのレイヤーのアルファで切り抜く(相手も映る。AviUtl の「上のオブジェクトでクリッピング」)。`clip_mode` は matte の mode と同じ。`matte.keep_source: true` も同じ意味 |
| `billboard` / `double_sided` | 3D: いつもカメラを向く / `false` で裏面を描かない |
| `guide: true` | 下絵。preview では描き、capture(書き出し)では描かない |
| `blend` の追加 | `subtract` `exclusion` `hard_light` `soft_light` `color_dodge` `color_burn` `linear_burn` |
| adjustment の `snapshot` | `true` = ここまでの画面に effects を掛けた 1 枚を、transform を掛けて元の画面の上に重ねる(フレームバッファ)。`"replace"` = 置き換える |
| `masks[]` の追加 | `shape`: rounded_rect(`radius`)・path(`points` にベジェのハンドル)・シェイプの形(star / heart / flower など。`sides` `inner` も)。`expansion`(px。動かせる)。多角形は 48 頂点まで |

描く順: v1 と同じ(配列の順。連続する 3D レイヤーの塊だけ anchor の奥行きで並べ替え)。交差する面・大きな床は正しく並ばない。

### テキストの追加

`writing: "vertical"`(縦書き。長音・かっこ・半角英数は 90° 回す、句読点・小書きは右上へ寄せる。`vertical_latin: "upright"` で英数字を立てる)、
`align` × `valign`(`valign` を書くと、その側の端がレイヤーの原点になる = AviUtl の「左寄せ[上]」など。書かなければ箱の中心)、`wrap_width`(折り返し。禁則つき。縦書きでは列の長さ)、
`runs: [{text, font, size, weight, italic, fill, tracking, baseline_shift}]`(文の途中の書体・サイズ替え)、`plate: {color, opacity, padding, radius, stroke, stroke_width}`(座布団)、
`fill` に gradient(`{"gradient": {angle | from/to, stops}}`)・pattern、`strokes: [{color, width}]`(外側へ重ねる縁)、`shadow: {color, x, y, blur, opacity}`、
`counter: {value(プロパティ値)| start + rate(/秒)+ from_frame, decimals, pad, prefix, suffix, separator, format, fixed_width, scramble, seed}`
(format: "number" / "timecode" / "hh:mm:ss" / "mm:ss" / "mm:ss.cc" / `"####.##.##.##:##"` のひな形(# に数字を右づめ)/ AviUtl の番号 0〜7。scramble % は右側の数字をコマごとの乱数にする)、
`visible_chars`(プロパティ値。タイプライター)、`arc: {radius, start, sweep}`(円周に沿わせる。負の radius で下側。`on_circle: {radius, rotation, arc}` も同じ)、`rotated_glyphs`(@ つき書体)、
`per_char` に `unit: "char" | "word" | "line"`、`ranks: [...]`(順番の表)、`random: {position, rotation, scale, opacity, seed, amount}`(文字ごとの決まった乱れ)。
書体: 起動時の `boot.fonts: [{family, url, weight, style, aliases}]` を `FontFace` で読んでから最初の 1 コマを描く。

### シェイプ・粒子の追加

- shape の `kind`: arc / pie / ring(`start` `end` `inner`)、arrow(`head` `shaft`)、chevron・cross(`thickness`)、heart、flower(`petals` `inner`)、petal、burst(`sides` `inner` `jitter` `seed`)、bubble(`radius` `tail` `tail_x` `tail_width`)。
  polygon・star・path に `radius`(角丸)。`dash: [線, すき間]` `dash_offset`。path に `morph_to`(同じ頂点数のパス)+ `morph`(%)。
- particles の `emitter`: `preset`(petals / confetti / snow / sparks / dust)、`sprite` に petal / heart / flower / rect と `{asset_id}` `{shape: {...}}` `{text: "桜"}`、`emit`(box / circle / line / point)`emit_edge`、
  `wind` `turbulence: {amp, freq}` `sway: {amp, freq}` `flutter`(度/秒。立体のひらひら)`orient`、`size` `opacity` `color` は 3 個以上の列も可、`colors`(粒ごとに 1 色)、`bursts: [{f, count}]`。3D レイヤーではカメラから遠い順に描く(通常合成のとき)。

### player.html

boot に `fonts` を足した。postMessage に `comp:fonts {fonts}` を足した。ほかは v1 と同じ。

### v1.1 の追加(2 回目・2026-11-14): 順番の決まり・足した書式・player の約束

実装の決めと確かめ方は `tools/comp-kit/README.md`、機械可読な一覧は `tools/comp-kit/schema.json`。v1・v1.1 の文書はそのまま読める。

**エフェクトの順番**(`test/order_test.py` で、順番つきの全部の組を「1 個ずつ RT に描く手本」と比べている)

- `effects` は、軽い・重い・形(flip / repeat)のどの組み合わせでも **書いた順** に掛かる。`flip` / `repeat` のあとの切り抜き・色は、反転・並べたあとの絵の座標で効く。
- アルファを足す・読むエフェクト(`invert_alpha`・`border`・`overlay_source` の over / under)は、それまでの切り抜きのあとに掛かる。効くのは「いまの絵の範囲」の中だけ
  (レイヤーの箱 + 線の太さ・縁取りなどのはみ出し。`crop` のあとは切ったあとの箱)。
- `fill.keep_luma: true` = 輝度(Y)はそのまま、色差だけ指定色のものにする(AviUtl の単色化「輝度を保持する」)。`false` = `amount` % のベタ塗り。`tint` は従来どおり 色 × 輝度。
- `overlay_source` の `mode: "replace_color"` = 素材のアルファに関係なく、色を丸ごと置き換える(形・アルファはレイヤーのまま)。

**足した書式**

| 書式 | 意味 |
|---|---|
| `type: "pattern"` の `cols` `rows` `origin` | 升目の数(箱 = `size × 個数`、模様の原点 = 箱の左上、左上の升 = `colors[0]`)。`origin: "top_left"` だけでも原点を左上にできる。AviUtl の市松模様N |
| `repeat` の `mode: "random"` | `count` `area_x` `area_y`(ばらまく範囲 px)`seed` `random_rotation`(± 度)`scale_min` `scale_max`(%)。AviUtl のランダム配置 |
| `vignette_blur`(重い) | `amount`(周辺の暗さ %)`blur`(周辺のぼかし px)`radius`(効き始め %)`softness` `color_shift`(px)`color` `cx` `cy`。AviUtl の周辺ボケ光量。調整レイヤーに付けて使う |
| `per_char.ranks` / `per_char.sequence` | ranks[i] = i 文字目が何番目に出るか。sequence[k] = k 番目に出る文字の番号(0 始まり)。`order` より優先。AviUtl の TA指定順で登場 |
| `blend` の追加 | `luminosity`(輝度は上・色は下)`color`(色は上・輝度は下)`hue` `saturation` |

**player.html の約束**(くわしくは README の postMessage の表)

- iframe → 親: `comp:key {key, code, ctrl, shift, alt, meta, repeat}`(iframe の中の keydown をすべて)、
  `comp:edit {id, path: "transform.position" | "transform.scale" | "transform.rotation", value, final, keyframed?, frame?}`(scale と rotation の value はいつも `[x, y, z]`。複数選択の移動はレイヤーごとに 1 通)、
  `comp:error {level: "warn" | "error", message, layer_id?}`(同じ内容は 1 回・1 秒に 12 件まで)。
- 親 → iframe: `comp:guides {show}`(下絵レイヤーの表示)、`comp:overlay {safe, grid}`(セーフフレーム・三分割の線)。
- 選択枠のつまみ: 四隅 = 縦横比を保って拡大(Shift で自由)、辺 = 1 軸、上辺の外 = 回転(Shift で 15° 刻み)。1 枚だけ選んでいるときに出る。
- 下絵(`guide: true`)は、書き出しのほか **入れ子の中でも描かない**(プレビューでも。親に置いた子の絵が、書き出しと同じになるように)。

### v1.1 の追加(3 回目・2026-11-14): 箱の決まり・AviUtl 取り込みで足した書式

どれも足しただけで、書かなければ今までどおり(例 14 本 × 3 コマは 1 バイトも変わらない)。確かめ方は `tools/comp-kit/test/check_test.py`、経緯は `reference/aviutl_mad/ENGINE_ISSUES.md` の B-8〜B-11。

**直した決まり**

- `stroke_outline` は箱も広げる(外側 = 幅ぶん)。あとの `crop` は広がった箱から測る(前は縁取り前の箱から測っていた = 不具合)。
- 重いエフェクト(ぼかしなど)のあとの `flip` / `repeat` は、画面より大きいレイヤーでも効く。

**足した書式**

| 書式 | 意味 |
|---|---|
| shape の `source.stroke_in_box: true` | 線の外側の縁までを箱にする(crop・マスク・選択枠の基準。絵は同じ)。AviUtl の図形 + ライン幅 |
| `vignette_blur` の `shape: "box" \| "circle"`、`ramp: "smooth" \| "linear"`、`brightness`(%。100 = そのまま) | 正円・まっすぐな変わり方・周辺を明るく。AviUtl の 周辺ボケ光量 = circle + linear + brightness |
| `clip_line` の `feather_mode: "center" \| "inside"` | inside = ぼかしは帯の内側だけ(端で 0・cos カーブ)。AviUtl の斜めクリッピングの帯 |
| `matte.layers: [id, …]`、`matte.absent: "hide" \| "show"` | 時間で入れ替わるマット元(その時刻に表示中の 1 枚)。どれも無い時刻に show なら切らない |
| comp レイヤーの `source.transparent: true` | 子の背景色を塗らない |
| `overlay_source` の `anchor: "center" \| "top_left"` | top_left = 箱の左上に素材の左上を合わせる |
| `repeat`(circle)の `copy_scale` `copy_rotation`、(random)の `spin` `drift_x` `drift_y` | 1 個ずつの拡大・回転、時間で回る・流れる |

**player.html**: つまみの当たり判定は、マウス 10px・指 22px(見た目は同じ)。
