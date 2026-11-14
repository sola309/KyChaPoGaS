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
| image | `{"asset_id": N}` または `{"url": "..."}`。大きさを px で決めるなら `"fit"`(下の「v1.1 の追加(4 回目)」) |
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

### v1.1 の追加(4 回目・2026-11-14): N px に合わせる・切り抜き・破線・px あたりの角度

どれも足しただけで、書かなければ今までどおり(例 14 本 × 5 コマは 1 バイトも変わらない)。確かめ方は `tools/comp-kit/test/check_test.py`。

| 書式 | 意味 |
|---|---|
| image・video・sequence の `source.fit: {"width": N}` / `{"height": N}` | 幅(高さ)を N px に。もう一方は縦横比どおり。素材の画素数を調べて `scale` を割り算しなくてよい |
| `source.fit: {"width": W, "height": H, "mode": "contain" \| "cover" \| "stretch"}` | W×H の箱に合わせる。contain(既定)= 収まる最大 / cover = 覆う(はみ出しは切る・中央を映す)/ stretch = 縦横比を無視 |
| `source.fit: {"mode": "cover"}`・`{}` | 幅も高さも書かなければ箱 = コンポジションの大きさ(全面を覆う・全体を収める) |
| `source.cutout_of: N` | 編集画面の「✂ 背景を消す」が書く控え(切り抜く前の素材)。絵には効かない |
| `trace_outline` の `dash_period` `dash_gap`(%) | 破線。1 周に対する周期とすき間(角度で刻む近似) |
| text の `on_circle.deg_per_px`(`arc.deg_per_px`) | 角度 = 文字の横位置 px × これ(度)。AviUtl の円形配置(文字毎に個別) |

- `fit` はレイヤーの箱(レイヤー空間での大きさ)を変える。`transform.scale` はその上に掛かる(100 % = 合わせた大きさ)。`anchor`・エフェクト・マスクの px、選択枠も合わせたあとの箱。
- 切り抜きは新しいエンジンの機能ではなく、既存のジョブ `cutout`(`tools/cutout-kit`。isnet-anime / birefnet-general)を呼ぶだけ。できた透過 PNG は新しい素材になり、
  レイヤーの `source.asset_id` をそれに差し替える(元の素材は残る)。編集画面は `crop: false`(絵の大きさを変えない)で呼ぶので、位置・拡大・エフェクトはそのまま合う。
  API からの呼び方は `docs/composition-authoring.md` の 5 章。
- 編集画面(`frontend/src/components/CompEditor/SourceTools.tsx`): 「中身」の頭に「↔ 幅に合わせる / ↕ 高さに合わせる / ⛶ 全面を覆う / ▣ 全体を収める / 元の大きさ」と「✂ 背景を消す」「↩ 元の絵に戻す」。
  大きさのワンタップは `fit` を書き、拡大率を 100 % に、位置をまん中に戻す(キーつき・親つきの値は触らない)。どれも取り消し 1 回で戻る。
- `threshold` の自動判定(大津)は入れていない(`reference/aviutl_mad/ENGINE_ISSUES.md` R-3 に理由)。


### v1.1 の追加(5 回目・2026-11-14): mesh レイヤー(手続きで作る 3D)

Blender で作っていた立体(押し出し文字・宝石・箱・レール・紙吹雪・割れる板)を、アプリの中で書けるようにした。レイヤー種別 `mesh` を足しただけで、ほかの書式は変わらない
(例 00〜13 の絵は 1 バイトも変わらない)。エンジンは `tools/comp-kit/mesh3d.js`、例は `examples/14_mesh_3d.json` `15_confetti_shatter.json`、レシピは `docs/composition-authoring.md` の 16〜21。

- `mesh` は `model` と同じく **いつも 3D**(`three_d` を書かなくてよい)。1 レイヤー = three.js のシーン 1 つを、そのレイヤーに効くカメラ(無ければ既定のカメラ)で画面大の RT に描き、1 枚の絵としてレイヤーに戻す。
  だから `transform`・`effects`・`blend`・マスク・`transition_*`・`parent`・`group`・被写界深度(レイヤーの原点の奥行きで、レイヤーごと一様にぼける)は、ほかの 3D レイヤーと同じに効く。
  レイヤーどうしの前後は原点の奥行きで並ぶだけ(1 レイヤーの中のオブジェクトどうしは、深度バッファで正しく隠れる)。**交差・影を落とし合わせたい物は、同じ mesh レイヤーの `objects` に入れる。**
- 座標は文書の決まりのまま: px・**y は下が正・z は奥が正**。オブジェクトの `position` はレイヤーの原点(`transform.position`)から。既定のカメラでは z = 0 が等倍(100 px の箱の手前の面を z = 0 に置けば、画面で 100 px)。
- 回転は度。向きはレイヤーの `transform.rotation` と同じ(x = 上が奥へ、y = 右が奥へ、z = 時計回り。掛ける順は X·Y·Z)。y を正に回すと **左の面** が見えてくる。x を正に回すと **下の面** が見えてくる。
- `scale` は **倍率**(1 = 等倍。レイヤーの `transform.scale` は今までどおり %)。
- 数・色・ベクトルはプロパティ値(キーフレーム・wiggle・loop)にできる。ベクトルは `{"k": [{"f", "v": [x,y,z]}]}` のほか、成分ごとに `[10, {"k": [...]}, 0]` とも書ける。キーの `f` はコンポジションのコマ。
  **形を決める項目**(大きさ・分割数・文字・断面など)もキーにできるが、値が変わるたびに形を作り直す(240 個まで使い回す)。動かすなら `scale` `rotation` `position` を使う。
- 決定論: 乱数はすべて種つき(`props.js` の `rand01`)。複製の動きは「(種, 番号, 時刻)の式」で、前のコマに依らない(どのコマから描いても同じ絵)。
- 色: マテリアルの色は sRGB で書く(光の計算はリニア。`basic` `emissive` と `unlit` は、書いた色・貼った絵がそのまま出る)。貼る絵は、エンジンのテクスチャ(画像・入れ子の絵)をそのまま使う。

```jsonc
{"type": "mesh", "id": "m1", "in": 0, "out": 120, "transform": {"position": [960, 540, 0]},
 "source": {
  "unlit": false,                       // true = 光を使わない(全部 basic 扱い。色・絵がそのまま出る)
  "light": {"ambient": 0.6, "intensity": 2, "color": "#ffffff", "direction": [-0.5, -1, -1],   // direction = 光の来る方向(x 負 = 左、y 負 = 上、z 負 = 手前)
            "shadows": false, "shadow_area": null, "shadow_opacity": 1,
            "points": [{"position": [0, -300, -300], "color": "#ffffff", "intensity": 1, "distance": 0}]},
  "env": "studio",                      // 映り込みの環境: "studio" | "soft" | "sunset" | "night" | "none" | {"top", "bottom", "horizon", "panels", "panel_color"}
  "env_intensity": 1, "env_rotation": 0,
  "objects": [ {…}, {…} ]
 }}
```

**source**

| 項目 | 既定 | 意味 |
|---|---|---|
| `unlit` | false | true = 光・影・映り込みを使わない。どのマテリアルも `basic`(`emissive` は `emissive`)として描く |
| `light.ambient` | 0.6 | 環境光(上が白・下が灰色の半球光)の強さ |
| `light.intensity` `light.color` | 2・`#ffffff` | 主光(平行光)。白い面が主光に正対すると 2 / π ≒ 0.64 の明るさ。環境光・映り込みが足されて 1 前後になる |
| `light.direction` | `[-0.5, -1, -1]` | 主光の **来る方向**(光源のある側)。文書の座標。既定 = 左上手前 |
| `light.shadows` | false | 主光の影(2048 px のシャドウマップ)。オブジェクトごとに `cast_shadow` `receive_shadow`(既定はどちらも true) |
| `light.shadow_area` | 画面の長辺 × 1.2 | 影を計算する範囲(px。レイヤーの原点を中心にした正方形)。小さいほど影がくっきり。範囲の外には影が落ちない |
| `light.shadow_opacity` | 1 | 影の濃さ(0〜1) |
| `light.points[]` | なし | 点の光。`position`(レイヤーの原点から)`color` `intensity` `distance`(0 = どこまでも同じ強さ。正 = その距離でなめらかに 0)。距離による減衰はない |
| `env` | `"studio"` | 金属・ガラスに映る環境(式で作る。外部ファイルなし)。`studio` = 灰色の空 + 明るい面 5 枚、`soft` = 白っぽい一様、`sunset` `night`、`none` = 映り込みなし(金属は黒くなる)。`{"top": 色, "bottom": 色, "horizon": 色, "panels": 真偽, "panel_color": 色}` で自作も可 |
| `env_intensity` `env_rotation` | 1・0 | 映り込みの強さ、環境を縦軸まわりに回す角度(度)。環境は世界に固定(カメラを動かすと映り込みが流れる) |
| `objects[]` | — | 下の表。配列の順は見た目に関係しない(深度バッファ)。半透明どうしは奥から描く |

**objects[] の共通項目**

| 項目 | 既定 | 意味 |
|---|---|---|
| `geometry` | `"box"` | 形。下の表 |
| `position` `rotation` `scale` | `[0,0,0]`・`[0,0,0]`・1 | レイヤーの原点からの位置(px)、回転(度。数 1 個なら z)、倍率(数か `[x,y,z]`) |
| `visible` | true | false で描かない |
| `material` | `{}` | 下の表 |
| `faces` | なし | 面ごとのマテリアルの配列。`null`・足りない分は `material`。箱 = `[右, 左, 上, 下, 手前, 奥]`、押し出し・文字 = `[表と裏, 側面(面取りを含む)]`、円柱 = `[側面, 上, 下]` |
| `instances` | なし | 複製(下の表)。`shards` と `group` には効かない |
| `cast_shadow` `receive_shadow` | true | `light.shadows` のとき |
| `render_order` | 0 | 半透明の重なりを手で決めるとき(大きいほどあとに描く) |
| `children` | — | `"geometry": "group"` のとき、子のオブジェクトの配列(親の位置・回転・倍率について動く。8 段まで)。schema(編集画面)には無い、JSON だけの書式 |

**形(`geometry`)**。どれも原点 = 形の中心。分割数 `segments` は省略でよい。

| geometry | 項目(既定) |
|---|---|
| `box` | `size: [幅, 高さ, 奥行き]`([200,200,200]。数 1 個 = 立方体) |
| `plane` | `size: [幅, 高さ]`([200,200])。手前を向いた板。裏も描く |
| `sphere` | `radius`(100)、`segments`(48。`[横, 縦]` も可) |
| `cylinder` | `radius`(100)か `radius_top` `radius_bottom`、`height`(200)、`open_ended`(ふた無し)、`segments`(48)。軸は縦 |
| `cone` | `radius`(100)、`height`(200)。とがった側が上 |
| `torus` | `radius`(100。輪の半径)、`tube`(20。管の半径)、`arc`(360)`start`(0。上から時計回り)、`segments`(96)`radial_segments`(24)。輪は手前を向く |
| `ring` | `inner`(60)`outer`(120)、`arc` `start`。平らな輪。裏も描く |
| `icosahedron` `octahedron` `dodecahedron` `tetrahedron` | `radius`(100)、`detail`(0 = 角ばったまま。上げると球に近づく)。宝石には `material.flat: true` |
| `lathe` | `profile: [[半径, y], …]`(断面。y は下が正。上から下・下から上どちらの順でもよい)、`smooth`(0 = 折れ線。N = 点の間を N 分割してなめらかに)、`segments`(64。8 前後 + `flat` でカット面)、`arc`(360) |
| `extrude` | 形は `shape`(`star` `heart` `petal` `flower` `polygon` `hexagon` `pentagon` `triangle` `rect` `rounded_rect` `ellipse` `ring` `burst` `arrow` `cross` `chevron` `bubble` `pie`)+ `size: [幅, 高さ]`、または `points: [[x,y], …]`(y は下が正)+ `holes: [[[x,y], …], …]`。`shape` はシェイプレイヤーの source と同じ書式のオブジェクト(`{"kind": "star", "sides": 6, "inner": 0.4}`)でもよく、文字列のときは `shape_sides` `shape_inner` `shape_radius` で足せる。`depth`(40。0 = 平らな面で、裏も描く)、`bevel: {"size": 4, "thickness": size, "segments": 3, "offset": 0}`(面取り。**輪郭が size ぶん外へ太る**。太らせたくなければ `offset: -size`)、`smooth_angle`(40。この角度までの折れ目は陰をなめらかに)。厚みのまん中が z = 0。`path` を書くと、断面を道に沿って伸ばす(レール・帯。`depth` `bevel` は効かない。`segments` = 道の分割数 200) |
| `text` | `text`(改行可)、`font`(`Noto Sans JP`)、`weight`(700)、`italic`、`font_size`(200)、`tracking`(字間 px)、`leading`(行送りの倍率 1.2)、`align`(`center` `left` `right`)。あとは `extrude` と同じ(`depth` `bevel` `smooth_angle`)。日本語可。箱(行の並び)の中心が原点。輪郭は Canvas2D で描いた字から起こす(下の「文字の輪郭」)。`quality`(1。輪郭の細かさ 0.25〜4)、`simplify`(0.3。輪郭を間引く許容差・絵の px) |
| `tube` | `path`(下)、`tube`(20。管の半径)、`segments`(200)`radial_segments`(12)、`closed`(省略 = 道が閉じていれば閉じる)。端は開いている(裏も描く) |
| `shards` | 下の「破片」 |
| `group` | `children` をまとめるだけ(形なし) |

**道(`path`)**: `tube`・`extrude` の道、`instances.layout: "along"` で使う。

| type | 項目(既定) |
|---|---|
| `helix` | `radius`(300)、`radius_end`(省略 = 同じ。書くと渦巻き・円すい)、`turns`(3)、`height`(400。**正 = 上へ進む**。原点が中心)、`axis`(`"y"` = 縦の軸 / `"x"` / `"z"`)、`start`(開始角。0 = 手前。軸 z のときは上)。t が進むと右へ回る |
| `circle` | `radius` `axis` `start`、`arc`(360。360 なら閉じた道) |
| `line` | `from: [x,y,z]` `to: [x,y,z]` |
| `points` | `points: [[x,y,z], …]`、`closed`、`curve`(`"catmullrom"` = なめらか / `"linear"` = 折れ線)、`tension`(0.5) |

- `path.up: [x,y,z]`(`extrude` の道だけ。2026-11-14 追加): 断面の向きを固定する。断面の縦(y)= `up` の向き、横(x)= 道と `up` に直角。らせんで `up` を軸の向き(軸 z なら `[0,0,1]`)にすると、横が半径の向き = **ねじれない帯**(幅のある平らならせん)になる。省略 = 今までどおり(three.js の平行移動の枠。らせんでは巻くごとに少しずつねじれる)。

**マテリアル(`material`・`faces[]`)**

| 項目 | 既定 | 意味 |
|---|---|---|
| `type` | `"standard"` | `standard` = 光・影・映り込み(PBR)/ `basic` = 光なし(色・絵そのまま)/ `emissive` = 光なしで `color × emissive_intensity` / `glass` = 透ける本体 + 透けない映り込み(下)/ `toon` = 段々の陰(`toon_steps` 3)/ `shadow` = 影だけを受ける透明な面(床) |
| `color` | `#ffffff`(`shadow` は黒) | 色。`#rrggbbaa` のアルファは不透明度に掛かる |
| `opacity` | 1(`glass` 0.25、`shadow` 0.4) | 0〜1。1 未満なら半透明として描く |
| `metalness` `roughness` | 0・0.5(`glass` 0.05) | 金属らしさ・粗さ(0〜1)。金 = `{"color": "#d4af37", "metalness": 1, "roughness": 0.25}` |
| `emissive` `emissive_intensity` | `#000000`・1 | 自分で光る色(光の当たり方に足される) |
| `env_intensity` | 1 | このマテリアルの映り込みの強さ(`source.env_intensity` に掛かる) |
| `clearcoat` | 0 | クリア塗装(0〜1)。つやのある箱・プラスチック |
| `side` | 自動 | `front` `back` `double`。自動 = 板・輪・破片・回転体・管・ふた無し・厚み 0 の押し出し・ガラスは両面、ほかは表だけ |
| `flat` | false | 面ごとに平らな陰(宝石のカット面) |
| `wireframe` | false | 線だけ |
| `texture` | なし | 貼る絵。`{"asset_id": N}`(画像素材)/ `{"url": "…"}` / `{"comp_id": N, "frame"?, "start"?, "speed"?, "loop"?, "transparent"?}`(入れ子の絵。`frame` = 子のコマを固定。省略 = `(レイヤーの in からのコマ × speed + start)` を子の fps に直したコマ。終わりを超えたら最後のコマ、`loop: true` で繰り返す。`transparent: true` = 子の背景色を塗らない)。色に掛かる(白いマテリアルなら絵そのまま) |
| `texture_repeat` `texture_offset` | `[1,1]`・`[0,0]` | 繰り返しの回数、ずらす量(1 = 絵 1 枚ぶん。キーにすれば流れる) |
| `transparent` | 自動 | 透過 PNG を貼るとき true(半透明として描く)。くっきり切り抜くなら `alpha_test: 0.5`(その値より薄い所は描かない。重なりが乱れない) |
| `depth_write` | 自動 | 半透明の重なりが欠けるとき false |

- uv(絵の貼られ方): 箱・板・球・円柱は three.js の標準(箱は面ごとに 1 枚、上が上)。押し出し・文字は外接矩形に 1 枚(側面は縁の色が伸びる)。破片は元の板に 1 枚。
- `glass` は屈折を計算しない(レイヤーの後ろの絵は、ふつうの半透明として透ける)。本体は `color` × `opacity` で透け、映り込みとハイライトだけ不透明に乗る。ガラスも影を落とすので、要らなければ `cast_shadow: false`。
- 動画を貼るときは、動画を入れたコンポジションを作って `comp_id` で貼る。

**複製(`instances`)**: 同じ形を InstancedMesh で 1 回の描画にまとめる(2000 個でも軽い。上限 20000)。3D の紙吹雪・花びら・星・並べた部品に使う。
i 番目の姿は (種, i, 時刻) の式で決まる。時刻 = `(コマ − レイヤーの in) ÷ fps + time_offset` 秒。

| 項目 | 既定 | 意味 |
|---|---|---|
| `count` `seed` | 100・1 | 個数、種 |
| `layout` | `"box"` | 最初の並び。`box` = `area: [幅, 高さ, 奥行き]`([600,600,600])の中にばらまく / `sphere` = 半径 `radius`(300)の球の中(`surface: true` = 表面だけ)/ `grid` = `grid: [nx, ny, nz]` 個を `spacing: [x, y, z]`([100,100,100])で(左上手前から。`count` が上限)/ `ring` = 半径 `radius` の円周に等間隔(`axis` 既定 `"y"` = 水平の輪、`"z"` = 画面に正対した輪。`start` `arc`)/ `along` = `path`(省略 = オブジェクトの `path`)に沿って等間隔(開いた道は両端を含む。1 個だけなら始点。閉じた道は 1 周を等分)/ `point` = 全部が原点 |
| `align` | true | `ring` `along` で、並びの向きに合わせて回す(`along` は形の x が道の向き、y が上。枕木は `size: [道の向きの幅, 厚み, 道を横切る長さ]`) |
| `offset` | 0 | `ring` `along` の並びをずらす(1 = 1 周・道の全長。キーにすれば流れる。閉じていない道では、端から出た分は消える) |
| `scale` | `[1, 1]` | 大きさの幅 `[最小, 最大]`(倍率。数 1 個なら全部同じ) |
| `rotation` `rotation_random` | 0 | 最初の回転(度)と、ばらつき(± 度。`[x,y,z]`) |
| `velocity` `velocity_random` | 0 | 速さ(px/秒。y 正 = 落ちる)と、ばらつき(±) |
| `radial` | `[0, 0]` | 中心から外へ飛ぶ速さ `[最小, 最大]`(px/秒。`point` なら全方向へ) |
| `gravity` | 0 | 加速度(px/秒²。`[0, 600, 0]` = 下へ) |
| `drag` | 0 | 空気の抵抗(1/秒)。大きいほど早く止まり、重力では一定の速さに落ち着く |
| `spin` `spin_random` | 0 | 回る速さ(度/秒)と、ばらつき(±) |
| `sway` | なし | ゆらゆら `{"amp": [x, y, z] か数(x), "freq": 1 秒あたりの回数}`。1 個ごとに位相が違う |
| `lifetime` `lifetime_random` | 0・0 | 寿命(秒。0 = ずっと)。ばらつき 0.3 = 寿命が 70〜100 % |
| `loop` `prewarm` | false・true | `loop` = 寿命が尽きたら最初の位置から生まれ直す(周ごとに乱数が変わる)。`prewarm: false` = 頭のコマでは何も無く、順に生まれてくる(true = 最初から途中の姿) |
| `emit_duration` | `loop` なら寿命、ほかは 0 | 生まれる時刻を 0〜この秒数にばらす |
| `colors` | なし | 色の配列。1 個ごとに 1 色選び、マテリアルの色に掛ける(マテリアルは白にしておく) |
| `fade_in` `fade_out` `fade_mode` | 0・0・`"opacity"` | 現れる・消える時間(秒。消えるのは寿命の終わり)。`opacity` = 不透明度 / `scale` = 大きさ / `both` |
| `time_offset` | 0 | 時刻をずらす(秒)。動きの途中から始めたいとき |

- 位置の式: `p = 最初の位置 + v·t + g·t²/2 + ゆらゆら`(`drag` k > 0 のとき `v·(1−e^(−kt))/k + g·(t/k − (1−e^(−kt))/k²)`)。回転 = 最初の回転 + 回る速さ × t。
- 降り続ける紙吹雪: `layout: "box"` で画面の上に薄い箱を置き、`velocity: [0, 300, 0]`・`lifetime: 5`・`loop: true`。

**破片(`"geometry": "shards"`)**: 四角い板を割って飛び散らせる。場面転換では、前の場面をコンポジションにして `texture: {"comp_id": N}` で貼り、後ろに次の場面を置く。

| 項目 | 既定 | 意味 |
|---|---|---|
| `size` | `[1920, 1080]` | 板の大きさ |
| `count` `seed` `cut` `jitter` | 120・1・`"voronoi"`・1 | 破片の数(およそ。縦横の升に丸める)、種、割り方(`voronoi` = 不ぞろいな多角形 / `triangles` / `grid` = 四角)、不ぞろいさ(0〜1) |
| `depth` | 0 | 厚み。0 = 紙(裏は同じ絵の鏡像)。正 = 側面つき |
| `progress` | 0 | 割れ具合 0〜1。**0 = 元の板そのもの**(継ぎ目なし。板に絵を貼ったのと同じ絵)。キーで動かす |
| `stagger` `stagger_amount` | `"none"`・0.5 | 割れていく順: `none`(一斉)`left_to_right` `right_to_left` `top_to_bottom` `bottom_to_top` `center_out` `edges_in` `random`。量 = 時間差の割合(0 = 一斉、0.95 = ほぼ 1 枚ずつ) |
| `spread` `spread_z` `origin` | 600・spread の半分・`[0,0]` | `origin`(板の中心から px)から外へ飛ぶ距離(px。破片ごとに 0.5〜1.5 倍)、奥行き方向の散り(±) |
| `direction` | `[0,0,0]` | 全体が流れる先(progress 1 での移動量 px。`[0, 0, -500]` = 手前へ) |
| `gravity` | 0 | 落ちる量(px。progress の 2 乗に比例。`[x,y,z]` か数 = y) |
| `spin` | 240 | 回る角度(度。破片ごとに 0.4〜1.6 倍・向きはばらばら) |
| `scale_end` | 1 | 終わりの大きさ(倍率。0 で消えていく) |
| `fade` | 0 | 終わりに消える割合(0.3 = 各破片の動きの最後の 30 % で透明に) |

**文字の輪郭**: エンジンが使える書体は Canvas2D の書体(機械の書体・プロジェクトの Web フォント)で、輪郭のデータは取れない。
そこで、文字を 1 em ≒ 320 px の大きさで Canvas2D に描き、アルファ 50 % の等高線をマーチングスクエアでたどって(境目はアルファから補間するので 1 px より細かい)、折れ線を間引き(許容差 0.3 px)、
外周と穴に分けて three.js の押し出しに渡す。できた形は (文字・書体・大きさ・厚み・面取り) ごとに使い回す。テキストレイヤーの字と比べて、大きさの差は 1 px 以内・面積の差は 1 % ほど(`check_test.py`)。
書体が読み込まれる前は代わりの書体で作り、読めたら作り直す(書き出しでは、読み終わるまで待つ)。

**できないこと**

- 屈折・反射に周りのオブジェクトやレイヤーは映らない(映るのは `env` だけ)。影は主光 1 本だけ(点の光は影を落とさない)。
- 被写界深度は 1 レイヤーごとに一様(1 枚の mesh レイヤーの中での奥行きの差ではぼけ方が変わらない)。奥と手前で変えたいときは、mesh レイヤーを分ける。
- 別のレイヤー(2D・ほかの mesh)との交差・影の受け渡しはない。
- 文字の面取りは外へ太る。細い画の書体で大きな `bevel.size` を使うと、隣の画とつながる(`size` は画の太さの 1/4 まで)。`offset` を負にしすぎると、細い画が消える。
- 複製 1 個ずつの当たり判定・並べ替えはしない(フェード(`opacity`)を使うときだけ、奥から順に並べ直す)。
- 立体文字は 1 つの `text` を 4096 px 幅の絵に描いて輪郭を起こす。長い行(20 字を超えるあたり)は輪郭が粗くなるので、オブジェクトを分ける。文字ごとのアニメは無い(1 文字ずつ動かすなら 1 文字 1 オブジェクト)。
- `texture.comp_id` で使った子は、バックエンドの依存関係(子を直したら親が「古い」になる印・循環の検査 = `comp_render.child_comp_ids`)には **まだ数えられない**。絵は正しく出る(エンジンが自分で子を読む。エンジンの中の循環は検査して止める)が、
  子を直したあとは親を自分で描き直す。
- 編集画面の選択枠は目安(形の外接球からの四角)。編集画面で 3D として扱わせたいとき(z のつまみなど)は、レイヤーに `three_d: true` も書いておく(エンジンは無くても 3D)。

### v1.1 の追加(mesh: マネキン・2026-11-14): 関節つきの人形

3D モデルの人物が要る場面を、モデルのファイルなしでアプリの中だけで「仮置き」できるようにした(Blender を使わない方針の続き)。書式は **追加だけ**(mesh の objects の `geometry` に `"mannequin"` が増えた。既存の例の絵は変わらない)。
エンジンは `mesh3d.js` の `buildMannequin`、例は `examples/17_mannequin_presets.json` `18_mannequin_walk.json`、作り方は `composition-authoring.md` の「マネキン」。

考え方: 人形は「関節の木 + 部品(球・円柱)」。書くのは体格と角度だけで、形はエンジンが決める。角度は **どれも普通のプロパティ値**(定数 / キーフレーム / loop / wiggle)なので、アニメーションの仕組みは既存のまま。
よく使う姿は `preset`(式で作る。歩きは位相の sin)で出し、`pose` で一部の関節だけ上書きする。原点は足もと(置く・歩かせる・カメラを合わせるのが楽)。光・影・toon・`unlit` は mesh の通常の仕組みにそのまま乗る。

```json
{"geometry": "mannequin", "position": [0, 300, 0], "rotation": [0, 30, 0],
 "style": "mannequin", "body": {"height": 600, "heads": 6.5}, "colors": {"top": "#86ab9d", "bottom": "#55698f", "hair": "#b5334f"},
 "hair": {"style": "ponytail", "length": 0.45}, "outfit": {"sleeves": 1, "pants": 0.2}, "outline": {"width": 3}, "material": {"type": "toon"},
 "preset": "hand_on_hip", "pose": {"head": [0, 20, 0], "elbow_l": {"k": [{"f": 0, "v": 10}, {"f": 30, "v": 80}]}}}
```

| 項目 | 既定 | 意味 |
|---|---|---|
| `position` `rotation` `scale` `visible` `cast_shadow` `receive_shadow` `render_order` | | ほかのオブジェクトと同じ。原点 = 両足の間の地面。`rotation` 0 = こちら向き(z 負の側)、y 正 = 画面の右を向く |
| `style` | `"mannequin"` | `mannequin` = 丸みのある筒と球 / `stick` = 細い棒(棒人形。関節に小さい球) |
| `body` | | `height` 身長(600 px)・`heads` 頭身(6.5)・`thickness` 太さ・`shoulder` 肩幅・`hip` 腰幅・`arm_length`・`leg_length`(どれも倍率 1)。式は README の「マネキンの体格」 |
| `colors` | | `skin` `top`(服の上)`bottom`(服の下)`hair` `shoes` `ribbon` `eyes`、省略できる `skirt`(= bottom)`sleeves`(= top)`pants`(= bottom)`socks`(= shoes)。キーフレーム可 |
| `outfit` | | `sleeves` 袖(0〜1。1 = 手首まで。既定 1)・`pants` ズボン(0〜1。既定 0.2 = 短パン)・`skirt` スカート(0 = なし。1 = ももの長さ。腰から広がる円すい台)・`skirt_flare` 広がり(0.6)・`socks`(1 = ひざ、2 = ももの上)・`boots`(1 = ひざ) |
| `hair` | | `style`: `none`(既定)/ `short` / `ponytail`(頭の後ろ上から下がる太い房。関節 3 個 `pony_1〜3`)。`length`(身長に対する割合 0.42)`thickness` `bangs`(前髪と横の房)`ribbon`(根元の黒いリボン) |
| `face` | true | 目(2 個の小さいだ円)を描く。顔の向きが分かる |
| `outline` | なし | `{width, color}`: 輪郭線(部品を width px 太らせた殻の裏面)。数 1 個なら width |
| `self_light` | 0 | 自分で光る割合(部品の色 × この値を発光に足す。暗い光の場面むけ) |
| `material` | | 部品すべての土台のマテリアル(`type: "toon"` など。色は `colors` が上書き) |
| `preset` | `"stand"` | `stand` `a_pose` `t_pose` `idle` `walk` `run` `wave` `sit` `hand_on_hip` `peace` `lean_forward` `cheer` |
| `phase` | 0 | 位相(0〜1 で 1 周)。`idle` `walk` `run` `wave` が見る |
| `preset_b` `preset_mix` `phase_b` | なし・0 | 2 つ目のプリセットと、混ぜる割合(関節の角度を線形に混ぜる。手の形・接地は 0.5 で切り替わる) |
| `pose` | | 関節ごとの角度(度)の上書き。`{関節: [a, b, c] | 数}`。数 1 個 = 1 つ目だけ。配列の `null` = プリセットのまま。ほかに `offset`(体の移動。身長に対する割合 [x, y 下, z 奥])、`hand_l` `hand_r`(`mitt` `fist` `open` `peace` `point`) |
| `ground` | walk・run だけ true | いちばん低い足の裏を地面(y = 0)に付ける(歩きの上下動がこれで出る) |

関節と角度(度。本人から見た向き。`_l` = 本人の左): 体の軸 `root`(腰)`spine`(背)`chest`(胸)`neck` `head` = `[前へ倒す, 向きを変える(rotation の y と同じ向き), 横へ傾ける(画面で時計回り)]`。
`shoulder_l/r` `hip_l/r` = `[前へ上げる, 内へひねる, 外へ開く]`(掛ける順は ひねり → 前後 → 開き)。`elbow_l/r` = `[曲げる(前へ), 前腕を内へひねる]`。`knee_l/r` = 曲げる(後ろへ)。`wrist_l/r` = `[前へ曲げる, 内へひねる, 外へ]`。
`ankle_l/r` = `[つま先を下げる, 内へ向ける]`。`pony_1〜3` = `[後ろへ振る, 横へ振る]`(何も書かなければ、後ろへ出てから下がる形)。

できないこと: 表情・口・まばたき、指の関節(手の形 5 種だけ)、服のしわ・フード・襟などの形、スカート・髪の物理(揺れは角度のキーか wiggle で書く)、手先から角度を決める IK、部品へのテクスチャ。関節は球でつなぐだけ(皮膚の変形なし)。
仮置き・アタリ・群衆の遠景むけ。顔の寄りの本番には使えない。
### v1.1 の追加(6 回目・2026-11-14): AviUtl 取り込みの全編再現で足した物

- `overlay_source` の `mode: "atop"`(絵のある所にだけ重ねる。アルファはそのまま)。
- `glow` の `variant: "diffuse"`(拡散光: ぼかした絵との明るいほうへ寄せる)。
- `duotone` の `gray: "max"`(明るさを RGB の最大値で取る白黒)。
- text の `per_char.hide_outside`(順番が来る前・消えたあとの文字を描かない)。
- 書き出し(capture)での静止画テクスチャの上限(160 M 画素。古い物から捨てて、要るときに読み直す)。文書の書式には関係しない。

### v1.1 の追加(7 回目・2026-11-14): 取り込みで「未対応」だった効果

どれも書式は足しただけ(既存の文書の意味は変わらない。例 00〜15 の絵は 1 バイトも変わらない)。式は `tools/comp-kit/effects.js`、項目の一覧は `schema.json`、見本は `examples/16_fx_extras.json`。

| 書式 | 何をする | AviUtl の何に当たるか |
|---|---|---|
| `polar` に `fit` `inner` `center_width` `scale` `rotation` `swirl` `cx` `cy` `clamp` | 極座標変換を箱基準で。`fit: "cover"` で四隅まで埋める | 極座標変換(中心幅・拡大率・回転・渦巻) |
| `rough_edges` | ノイズで絵をずらし、アルファを切り直す | スクリプト「ラフエッジ」 |
| `block_noise` | 四角い区画をずらす | カスタムオブジェクト「本当のブロックノイズ」 |
| `lens_flare` | 芯・にじみ・光芒・輪の光を足す | カスタムオブジェクト「フレア」 |
| `refract` | レンズ / すりガラス。調整レイヤーで下の絵をゆがめる | (取り込みでは未使用。ガラスの見た目用) |
| `palette` | 決めた色のうち近い色へ置き換える | メディアンカット減色@T_Color_Module(色は取り込み側で選ぶ) |
| `inner_shadow` の `x` `y` | 影のずれを px で | 内側シャドー@ANM1 |
| `motion_blur: {samples, shutter, phase}` | 足し込む幅と位置を決める | モーションブラー(間隔・分解能) |

- 決定論: 乱数はコマ・種・区画の番号から決まる(時計も Math.random も使わない)。ノイズ・区画の座標は箱の左上を原点にした px(RT の余白や解像度に左右されない)。
- 取り込み側(`aup_to_comp.py`)の読みのうち、スクリプトの本文を読めていない物(ラフエッジ・内側シャドー・字間調整・フレア・雪・ブロックノイズ・モーションブラー・極座標変換の細部)は、完成動画のコマを見て合わせた**推測**(コメントに書いた)。
- グループ制御に付いた「輪郭追跡拡張機能」(破線)と「モーションブラー」は、取り込みの後処理で対象のレイヤーへ配る(エンジンのグループの effects は 1 枚ずつに掛かるので、意味は同じ)。

### v1.1 の追加(puppet・2026-11-14): puppet レイヤー(パーツ分解した立ち絵のリグ)

Live2D のように、1 枚の立ち絵を意味ごとの透過レイヤーに分けて、格子メッシュの変形で動かす。分解とリグの元はコンパニオン機能のもの
(See-Through 分解 → `scripts/rig_compiler.py` → `backend/data/puppets/<id>/manifest.json`(v2: レイヤーの z 順・bbox・depth・sway の分類・`pivots`・`rig.eye / mouth / variants`)+ ハロー除去済みの PNG)をそのまま使う。
エンジンは `tools/comp-kit/puppet.js`。バックエンドは既存の `GET /api/puppet/<id>/manifest`・`/layer/<file>` を読むだけ(変更なし)。

- **書式**: `{"type": "puppet", "source": {"puppet_id", "crop", "hide", "blink", "auto_blink", "blink_interval", "blink_seed", "look", "brow", "mouth", "vowel",
  "head_turn", "head_tilt", "head_nod", "head_shift", "body_lean", "breath", "breath_period", "sway", "wind", "sway_speed", "sway_lag", "sway_seed"}}`。
  項目の表は `tools/comp-kit/README.md` の「puppet レイヤー」、編集画面むけの一覧は `schema.json` の `layer_types.puppet`。
- **決定論**: コンパニオンの画面(`PuppetStage.ts`)は実時間のばね(前のコマの位置・速さを持つ)で髪を動かすが、コンポジションでは使えない(コマを飛ばして描く・並列に書き出す)。
  puppet.js は状態を持たず、(文書, コマ) だけから頂点を決める: ゆれ = 正弦の重ね(レイヤーごとの位相)、毛先の遅れ = `sway_lag` 秒前の頭・体の行列を毛先ほど強く混ぜる、
  自動まばたき = 区間ごとに種から決まる時刻。同じコマは何度描いても、どの順で描いても同じ絵(`check_test.py` 2f)。
- **変形の考え方**(PuppetStage.ts と同じ): 体 = 足元を軸にしたアフィン(傾き・呼吸)。頭 = 首の付け根を軸にしたアフィンが体に乗る。
  首ふり = 顔を縦の円筒の前面とみなした写像を、顔の全部の部品に共通で掛ける(同じ x は同じ x' へ行くので部品どうしがずれない)+ 奥行きの視差。
  首 = 下端は体・上端は頭の行列を smoothstep で混ぜる。髪・布 = 根元(`pinY` まで)は頭・体に固定、先ほど大きくゆれる。
- **描き方**: パペットのキャンバス大の RT に z 順で重ね、その 1 枚を image レイヤーと同じ道(transform・effects・マスク・マット・親子・3D・ブレンド)に流す。
- **限界**: 腕・脚は曲げられない(See-Through の層が腕 1 枚・脚 1 枚で、関節の位置も無い)。首ふりは ±0.42 rad まで。表情の切り替え・視線の描き差分は未対応。
  絵の質は分解しだい(口が数画素・腕が服と 1 枚、など)。新しいパペットは `POST /api/puppet/decompose`(GPU 約 7 分)。
- **次の候補**(調査 2026-11-14、未導入・許可待ち): See-Through の層に DWPose の骨と頂点スキニングを足す(Stretchy Studio の方式)と腕・脚が曲げられる。
