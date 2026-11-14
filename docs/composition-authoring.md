# コンポジションの作り方(人と AI エージェントむけ)

コンポジション = レイヤーを重ねてキーフレームで動かす、入れ子のタイムライン(After Effects のコンポジション、AviUtl の Scene にあたる)。
描き出すと 1 本の動画素材になり、本体のタイムラインに置ける。文書の書式の正本は `docs/composition-design.md`(v1 + 「v1.1 の追加」)と
`tools/comp-kit/README.md`、機械可読な一覧は `tools/comp-kit/schema.json`(`GET /api/comps/engine/schema.json`)。
この文書は「どう作るか」の手引き。下のレシピの JSON はどれも、プロジェクト 35「🎞 コンポジション試験」に「レシピ: …」の名前で入っていて、開いて確かめられる(2026-11-14 に全部の 1 コマを描いて確認)。

## 1. 開き方

- 編集画面(本体)のプレビューの上の **「🎞 コンポジション」** → 一覧。カードの「開く」で編集、「+ 新しいコンポジション」で作る(大きさ・fps・長さ・背景)。
- 本体のタイムラインの comp クリップ(紫)を **ダブルクリック** → そのコンポジションが開く。
- 入れ子(comp レイヤー)は帯をダブルクリックで中へ。上のパンくずで親へ戻る。
- 編集は自動で保存される(見出しの「✓ 保存済み」)。Ctrl+Z / Ctrl+Shift+Z で取り消し・やり直し。

## 2. 考え方

| もの | 中身 |
|---|---|
| **文書** | `{"version": 1, "bg": null または "#rrggbb", "layers": [...]}`。大きさ・fps・長さは文書の外(コンポジションの設定)。`bg: null` は透明(アルファつきで描き出す) |
| **レイヤー** | `layers` の **先頭が最前面**。`id`(文書の中で一意)・`type`・`in`〜`out`(コマ。out は含まない)・`transform`・`source`(種類ごとの中身)・`effects` |
| **座標** | 左上が (0,0)、y は下向き。`transform.position` はレイヤーの中心(anchor)が来る場所。1920×1080 の中央は `[960, 540]` |
| **プロパティ値** | 定数(`100`、`[960,540]`、`"#ffffff"`)か、キーフレーム `{"k": [{"f": コマ, "v": 値, "e": "イージング"}, ...]}`。`e` はそのキーから次のキーまで。`"loop": "cycle"｜"pingpong"`、`"wiggle": {"freq", "amp", "seed"}`(揺れ)を足せる。定数 + 揺れは `{"v": 値, "wiggle": {...}}` |
| **エフェクトの列** | `effects` は **上から順** に掛かる。同じ種類を何個でも。長さ・座標は「拡大・回転する前のレイヤーの px、原点 = レイヤーの中心」。切り抜き(`clip_line` `crop` `mask_shape` `blinds`)・色・位置の足し算(`offset`)は軽い。ぼかし・縁・影は重い(schema の `cheap`) |
| **登場・退場** | `transition_in` / `transition_out`。レイヤーの `in` / `out` に合わせて自動で掛かる(キーフレームを書かない) |
| **親子** | `parent: "<id>"` で位置・回転・拡大を継ぐ。子の position は親の中心が原点。`type: "null"` は親専用の見えないレイヤー |
| **グループ** | `type: "group"` は自分より下の N 層(`scope`: 数、0 = 下すべて、または id の配列)をまとめて動かす・エフェクトを配る。自分の `in`〜`out` の間だけ効く |
| **3D・カメラ** | `three_d: true` のレイヤーだけ透視投影。`type: "camera"`(position・`source.target`・`zoom` か `fov`・`dof`)。カメラが無ければ「z=0 がちょうど画面いっぱい」の既定のカメラ |
| **立体(mesh)** | `type: "mesh"`, `source: {"objects": [...]}`。箱・球・回転体・押し出し・立体文字・管・破片を式で作り、光・影・映り込みつきで描く(いつも 3D)。同じ形の複製(`instances`)で 3D の紙吹雪・花びら。レシピ 16〜21 |
| **入れ子** | `type: "comp"`, `source: {"comp_id": N}`。子を保存し直すと親も「古い」になる(循環は保存時に断られる) |
| **マット・マスク** | `matte: {"layer": "<id>", "mode": "alpha"}` = 別のレイヤーの形で切り抜く(マット元は映らない)。`clip_to: "<id>"` = 相手も映したまま切り抜く。`masks[]`(箱の左上が原点)やエフェクト `mask_shape` = 自分に付いた形 |
| **下絵** | `guide: true`。プレビューには出るが、描き出しには出ない(位置合わせの参考) |
| **描き出し → 置く** | 「🎬 描き出し」で動画素材になる。「⤵ タイムラインに置く ▾」で本体のタイムラインの再生位置に comp クリップを置く(置き先のトラックを選べる)。中身を変えるとクリップに「古い」印が付き、描き直すと絵が差し替わる。本番の書き出しの前には、古いものが自動で描き直される |

**時間の決まり**: 再生は決定論(同じコマは必ず同じ絵)。乱数は seed から。`f` はコンポジションのコマ(小数可)。動画・入れ子の `start` は素材の何コマ目から(コンポジションの fps で数える)。

## 3. 編集画面の使い方(要点)

- **プレビュー**: クリックで選択(Shift で追加)、ドラッグで移動、角のつまみで拡大、上のつまみで回転。キーフレームのあるプロパティは、動かすと再生位置にキーが打たれる。下の「下絵」「セーフ枠」「グリッド」で重ね描きを切り替え。エンジンからの知らせ(読めない素材など)はプレビューの下に出て、押すとそのレイヤーを選ぶ。
- **タイムライン**: 帯のドラッグ = 時刻、端 = 詰める、⠿ = 重なり順。▸ でキーフレームの行。何もない所からドラッグ = 範囲選択(レイヤーの行から始めると帯、キーの行から始めるとキー)。🔍 で名前・種類のしぼり込み、「今だけ」で再生位置にあるレイヤーだけ。group / camera の範囲は字下げされ、⊟ でたたむ。プレビューで選んだレイヤーの行は自動で見える所へスクロールする。
- **プロパティ**: ◇ = キーフレーム、〰 = ループ・揺れ。□ のついた項目は「書かなければ無し」の機能で、チェックで入切(切 = 項目ごと消す)。エフェクトは「+ 足す…」(組ごと・検索つき)。複数選択では、数値を**ドラッグ**すると全部が同じ量だけ動き、**入力**すると全部が同じ値になる。
- **プリセット**: 登場・退場・帯・シール風・文字の登場などをボタン 1 つで足す(あとからプロパティで直せる)。
- **画像・動画の大きさ**: プロパティの「中身」の頭の「↔ 幅に合わせる」「↕ 高さに合わせる」「⛶ 全面を覆う」「▣ 全体を収める」で、コンポジションに合わせた大きさになる(拡大率は 100 % に、位置はまん中に戻る)。
  好きな px にするなら、その下の「大きさを合わせる(px)」の 幅 px・高さ px に数字を書く(片方だけ = 縦横比どおり)。「元の大きさ」でやめる。
- **✂ 背景を消す**(画像レイヤー): 「中身」の「✂ 背景を消す」を押すと、背景を消した透過画像が新しい素材としてでき、レイヤーの絵がそれに替わる(数秒。白い背景のアニメ絵が既定。写真などは右の一覧で選ぶ)。
  元の素材は消えない。「↩ 元の絵に戻す」か Ctrl+Z で戻せる。絵の大きさは変わらないので、位置・拡大率はそのまま。
- **JSON タブ**: 文書そのもの。下のレシピは、ここの `layers` に貼って「適用」でも試せる。

| キー | 働き |
|---|---|
| Space | 再生 / 停止 |
| , . / PageUp PageDown(Shift で 10 コマ) | コマ送り |
| ← → | タイムラインを触ったあと = コマ送り / プレビューを触ったあと = 選んだレイヤーを 1 px 動かす(Shift で 10 px) |
| ↑ ↓ | 選んだレイヤーを 1 px 動かす(Shift で 10 px) |
| K | 選んだレイヤーの位置・拡大・回転・不透明度にキーを打つ |
| [ ] | 選んだレイヤーの先頭 / 末尾を再生位置に |
| Ctrl+C / Ctrl+V | レイヤー(別のコンポジションへも貼れる)。キーを選んでいるときはキーをコピーし、再生位置から貼る(別のレイヤーを選んで貼ることもできる) |
| Ctrl+D / Delete | 複製 / 削除(キーを選んでいるときはキーを消す) |
| Ctrl+A / Esc | すべて選ぶ / 選択をやめる |
| Ctrl+ホイール | タイムラインの拡大 |

## 4. レシピ 21

どれも 1920×1080・30fps・90 コマのコンポジションの `layers`(配列の先頭が最前面)。`asset_id` は自分のプロジェクトの画像素材の番号に替える(例はプロジェクト 35 の 935)。
`{"k": [...]}` の `f` はコマ。レイヤーの長さやコンポジションの fps を変えたら、キーの時刻も合わせて直す。

### 1. キネティックな文字の登場

テキストの `per_char` が 1 文字ずつの登場。`from` が「出る前の姿」、`stagger` が文字ごとの時間差(コマ)。`e` はイージング(`outBack` = 行きすぎて戻る)。

```json
[
 {"id": "title", "type": "text", "in": 0, "out": 90, "transform": {"position": [960, 540]}, "source": {"text": "ポッキーの日", "font": "Noto Sans JP", "weight": 900, "size": 180, "fill": "#ffffff", "tracking": 8, "per_char": {"stagger": 3, "duration": 22, "order": "forward", "e": "outBack", "from": {"position": [0, 250, 0], "scale": [40, 40], "rotation": -20, "opacity": 0}}}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#e65163"}}
]
```

### 2. 名札(縦書き + clip_line のワイプ)

縦書きの名札は `writing: "vertical"` + `plate`(座布団)。`clip_line` は線の片側を消すエフェクトで、`cy`(線の位置)を動かすと上から下へ開く。`angle` を変えると斜めのワイプになる。

```json
[
 {"id": "name", "type": "text", "in": 0, "out": 90, "transform": {"position": [960, 540]}, "source": {"text": "佐倉杏子", "writing": "vertical", "font": "Noto Serif JP", "weight": 700, "size": 120, "fill": "#221914", "plate": {"color": "#ffffff", "padding": [26, 36], "stroke": "#221914", "stroke_width": 3}}, "effects": [{"type": "clip_line", "params": {"angle": 0, "cy": {"k": [{"f": 0, "v": -420, "e": "inOutExpo"}, {"f": 30, "v": 420}]}}}]},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#7fd0d8"}}
]
```

### 3. 流れる模様の背景

`pattern` レイヤーは式で描く模様(20 種)。`offset` を動かすと流れる。`kind` を `stripes` `checker` `asanoha` `seigaiha` などに替えるだけで別の柄になる。

```json
[
 {"id": "pat", "type": "pattern", "in": 0, "out": 90, "source": {"kind": "yagasuri", "colors": ["#e65163", "#f6a5b0"], "size": 90, "angle": 0, "offset": {"k": [{"f": 0, "v": [0, 0]}, {"f": 90, "v": [0, -360]}]}}}
]
```

### 4. 形の中にキャラを切り抜く(マット)

マット: `chara` の `matte.layer` に形のレイヤー(`hole`)を指定すると、その形で切り抜かれる(マット元の `hole` 自体は映らない)。下に同じ形の地(`disc`)、上に枠(`frame`)を置くと窓になる。

```json
[
 {"id": "frame", "type": "shape", "in": 0, "out": 90, "transform": {"position": [960, 540]}, "source": {"kind": "ellipse", "width": 720, "height": 720, "fill": null, "stroke": "#ffffff", "stroke_width": 14}},
 {"id": "chara", "type": "image", "in": 0, "out": 90, "matte": {"layer": "hole", "mode": "alpha"}, "transform": {"position": {"k": [{"f": 0, "v": [960, 900], "e": "outCubic"}, {"f": 40, "v": [960, 800]}]}, "scale": [62, 62]}, "source": {"asset_id": 935}},
 {"id": "hole", "type": "shape", "in": 0, "out": 90, "transform": {"position": [960, 540]}, "source": {"kind": "ellipse", "width": 720, "height": 720, "fill": "#ffffff"}},
 {"id": "disc", "type": "shape", "in": 0, "out": 90, "transform": {"position": [960, 540]}, "source": {"kind": "ellipse", "width": 720, "height": 720, "fill": {"pattern": {"kind": "dots", "colors": ["#ffd23f", "#fff2b8"], "size": 36}}}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#2b2230"}}
]
```

### 5. 形の中にキャラを切り抜く(マスク)

マスク(エフェクト `mask_shape`)は**そのレイヤーに付いて動く**切り抜き。座標はレイヤーの中心が原点・拡大する前の px。あとに書いた縁取り・影は、切り抜いた形に掛かる(エフェクトは上から順)。

```json
[
 {"id": "chara", "type": "image", "in": 0, "out": 90, "transform": {"position": [960, 1000], "scale": [80, 80]}, "source": {"asset_id": 935}, "effects": [{"type": "mask_shape", "params": {"shape": "hexagon", "size": 900, "y": -480}}, {"type": "stroke_outline", "params": {"width": 12, "color": "#ffffff"}}, {"type": "drop_shadow", "params": {"distance": 22, "angle": 135, "blur": 0, "color": "#2b2230", "opacity": 85}}]},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#7fd0d8"}}
]
```

### 6. 斜めブラインドの場面転換

`transition_in` はレイヤーの頭(`in`)から自動で掛かる登場。`blinds` は斜めの縞で開く。文書にキーフレームを書かずに済むので、まず transition で組むのが楽。

```json
[
 {"id": "next", "type": "solid", "in": 0, "out": 90, "source": {"color": "#e65163", "fill": {"pattern": {"kind": "stripes", "colors": ["#e65163", "#f08a97"], "size": 60, "angle": 40}}}, "transition_in": {"type": "blinds", "pitch": 160, "angle": 40, "stagger": 100, "duration": 28, "e": "inOutQuad"}},
 {"id": "next_t", "type": "text", "in": 14, "out": 90, "transform": {"position": [960, 540]}, "source": {"text": "NEXT", "font": "Noto Sans JP", "weight": 900, "size": 220, "fill": "#ffffff"}, "transition_in": {"type": "zoom", "from": 0, "duration": 14, "e": "outBack"}},
 {"id": "prev_t", "type": "text", "in": 0, "out": 90, "transform": {"position": [960, 540]}, "source": {"text": "前の場面", "font": "Noto Sans JP", "weight": 700, "size": 120, "fill": "#2b2230"}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#f4efe6"}}
]
```

### 7. カウンター(走る日付)

`counter` を書くとテキストが数字になる。`value` をキーフレームで動かし、`format` のひな形(# に数字を右づめ)で日付の形に、`scramble` で右の桁を回す。

```json
[
 {"id": "date", "type": "text", "in": 0, "out": 90, "transform": {"position": [960, 540]}, "source": {"font": "Noto Sans JP", "weight": 300, "size": 110, "fill": "#00060b", "tracking": 10, "counter": {"value": {"k": [{"f": 0, "v": 201111110000, "e": "outExpo"}, {"f": 70, "v": 202611111111}]}, "format": "####.##.##.##:##", "fixed_width": true, "scramble": {"k": [{"f": 0, "v": 100}, {"f": 75, "v": 0}]}}, "plate": {"color": "#bdeef2", "opacity": 90, "padding": [60, 16]}}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#102028"}}
]
```

### 8. 円形に並べる(複製)

`repeater` はレイヤーの複製。`mode: "radial"` で円形に並ぶ。`count` や `radius` もキーフレームにできる(花が開く)。エフェクトと違い 1 回の描画にまとまるので数百個でも軽い。

```json
[
 {"id": "petals", "type": "shape", "in": 0, "out": 90, "transform": {"position": [960, 540], "rotation": {"k": [{"f": 0, "v": 0}, {"f": 90, "v": 60}]}}, "source": {"kind": "petal", "width": 90, "height": 170, "fill": "#ffb7cd", "stroke": "#e65163", "stroke_width": 3}, "repeater": {"count": {"k": [{"f": 0, "v": 1, "e": "outQuad"}, {"f": 40, "v": 12}]}, "mode": "radial", "radial": {"radius": {"k": [{"f": 0, "v": 30, "e": "outBack"}, {"f": 40, "v": 260}]}, "start_angle": 0, "sweep": 360, "face_center": true}}},
 {"id": "core", "type": "shape", "in": 0, "out": 90, "transform": {"position": [960, 540]}, "source": {"kind": "ellipse", "width": 150, "height": 150, "fill": "#ffd23f"}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#fff4f7"}}
]
```

### 9. 3D の札の上をカメラが動く

`three_d: true` のレイヤーだけがカメラの影響を受ける。カメラは `transform.position` と `source.target`(注視点)を動かす。z は奥が正。カメラレイヤーは配列のどこに置いてもよい(範囲を絞るなら `scope`)。

```json
[
 {"id": "cam", "type": "camera", "in": 0, "out": 90, "source": {"zoom": 1400, "target": {"k": [{"f": 0, "v": [500, 540, 0], "e": "inOutQuad"}, {"f": 90, "v": [1420, 540, 400]}]}}, "transform": {"position": {"k": [{"f": 0, "v": [200, 380, -1500], "e": "inOutQuad"}, {"f": 90, "v": [1500, 620, -1100]}]}}},
 {"id": "card0", "type": "shape", "three_d": true, "in": 0, "out": 90, "transform": {"position": [360, 540, 0], "rotation": [0, -25, 0]}, "source": {"kind": "rect", "width": 260, "height": 380, "radius": 18, "fill": "#e65163", "stroke": "#ffffff", "stroke_width": 8}},
 {"id": "card1", "type": "shape", "three_d": true, "in": 0, "out": 90, "transform": {"position": [660, 540, 220], "rotation": [0, -25, 0]}, "source": {"kind": "rect", "width": 260, "height": 380, "radius": 18, "fill": "#ffd23f", "stroke": "#ffffff", "stroke_width": 8}},
 {"id": "card2", "type": "shape", "three_d": true, "in": 0, "out": 90, "transform": {"position": [960, 540, 440], "rotation": [0, -25, 0]}, "source": {"kind": "rect", "width": 260, "height": 380, "radius": 18, "fill": "#7fd0d8", "stroke": "#ffffff", "stroke_width": 8}},
 {"id": "card3", "type": "shape", "three_d": true, "in": 0, "out": 90, "transform": {"position": [1260, 540, 660], "rotation": [0, -25, 0]}, "source": {"kind": "rect", "width": 260, "height": 380, "radius": 18, "fill": "#9b7bff", "stroke": "#ffffff", "stroke_width": 8}},
 {"id": "card4", "type": "shape", "three_d": true, "in": 0, "out": 90, "transform": {"position": [1560, 540, 880], "rotation": [0, -25, 0]}, "source": {"kind": "rect", "width": 260, "height": 380, "radius": 18, "fill": "#7cff6b", "stroke": "#ffffff", "stroke_width": 8}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#15121c"}}
]
```

### 10. 花びらが舞う(粒子)

`particles` は決定論の粒子(同じ seed なら同じ絵)。`preset: "petals"` に、出る場所(`position` `area`)・風・ゆれを足す。`in` を負にすると、頭のコマからすでに舞っている。

```json
[
 {"id": "petals", "type": "particles", "in": -90, "out": 90, "transform": {"position": [960, 540]}, "source": {"seed": 7, "emitter": {"preset": "petals", "position": [0, -640, 0], "area": [2200, 60, 0], "rate": 26, "life": 6, "size": [44, 44], "wind": [90, 0, 0], "sway": {"amp": 60, "freq": 0.4}, "colors": ["#ffd9e4", "#ffb7cd", "#fff0f4", "#f8a5c2"]}}},
 {"id": "sky", "type": "solid", "in": 0, "out": 90, "source": {"color": "#bfe6ff", "fill": {"gradient": {"type": "linear", "angle": 180, "stops": [[0, "#7fc4ff"], [1, "#ffe9f1"]]}}}}
]
```

### 11. 説明の帯(座布団 + スライド)

説明の帯は `plate` つきのテキスト。`transition_in: slide` で横から入り、`transition_out: fade` で消える。

```json
[
 {"id": "cap", "type": "text", "in": 0, "out": 90, "transform": {"position": [960, 860]}, "source": {"text": "いつも何かを食べている魔法少女", "font": "Noto Sans JP", "weight": 700, "size": 56, "tracking": 6, "fill": "#ffffff", "plate": {"color": "#2b2230", "padding": [36, 14], "stroke": "#7fd0d8", "stroke_width": 4}}, "transition_in": {"type": "slide", "direction": "left", "distance": 600, "duration": 18, "e": "outCirc"}, "transition_out": {"type": "fade", "duration": 10}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#3a3144"}}
]
```

### 12. 矢じりの列(帯 + ブラインド)

画面より大きい平面を `clip_line`(幅 = 帯を残す)で縦の帯に切り、`blinds` で斜めに間引くと矢じりの列になる。`blinds.phase` を動かすと流れる。`repeater` で横に並べる。軽いエフェクトだけなので 1 回の描画で済む。

```json
[
 {"id": "arrows", "type": "solid", "in": 0, "out": 90, "transform": {"position": [80, 540]}, "source": {"color": "#ffffff", "width": 1920, "height": 1500}, "effects": [{"type": "clip_line", "params": {"angle": 90, "width": 120}}, {"type": "blinds", "params": {"ratio": 50, "pitch": 240, "angle": 40, "phase": {"k": [{"f": 0, "v": 0}, {"f": 90, "v": -480}]}}}], "repeater": {"count": 9, "mode": "linear", "offset": {"position": [220, 0, 0]}}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#e65163"}}
]
```

### 13. 白フチと影のシール風

切り抜き画像に `stroke_outline`(白フチ)→ `drop_shadow`(ぼかし 0 の影)でシール風。回転の `{"v": 値, "wiggle": {...}}` は「定数 + 揺れ」。

```json
[
 {"id": "sticker", "type": "image", "in": 0, "out": 90, "transform": {"position": [960, 560], "scale": [80, 80], "rotation": {"v": -6, "wiggle": {"freq": 1.2, "amp": 3, "seed": 2}}}, "source": {"asset_id": 935}, "effects": [{"type": "stroke_outline", "params": {"width": 14, "color": "#ffffff"}}, {"type": "drop_shadow", "params": {"distance": 18, "angle": 135, "blur": 0, "color": "#2b2230", "opacity": 85}}], "transition_in": {"type": "zoom", "from": 0, "duration": 14, "e": "outBack"}},
 {"id": "pat", "type": "pattern", "in": 0, "out": 90, "source": {"kind": "dots", "colors": ["#ffd23f", "#ffe680"], "size": 70}}
]
```

### 14. 線が描かれていく(トリム)

シェイプの `trim` は線を描く範囲(%)。`[0,0] → [0,100]` で描かれていく。`[50,50] → [0,100]` なら中央から両側へ伸びる。

```json
[
 {"id": "ring", "type": "shape", "in": 0, "out": 90, "transform": {"position": [960, 540], "rotation": -90}, "source": {"kind": "ellipse", "width": 520, "height": 520, "fill": null, "stroke": "#ffd23f", "stroke_width": 22, "cap": "round", "trim": {"k": [{"f": 0, "v": [0, 0], "e": "inOutCubic"}, {"f": 50, "v": [0, 100]}]}}},
 {"id": "line", "type": "shape", "in": 0, "out": 90, "transform": {"position": [960, 880]}, "source": {"kind": "line", "points": [[-700, 0], [700, 0]], "stroke": "#ffffff", "stroke_width": 10, "cap": "round", "trim": {"k": [{"f": 10, "v": [50, 50], "e": "outExpo"}, {"f": 50, "v": [0, 100]}]}}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#1b1524"}}
]
```

### 15. グループでまとめて揺らす + 調整レイヤー

`group` は、自分より下の N 層(`scope`)をまとめて動かす(画面の中心を軸に回転・拡大、位置のずれ、不透明度、エフェクトの配布)。`adjustment` は、それより下の絵ぜんぶにエフェクトを掛ける。

```json
[
 {"id": "grade", "type": "adjustment", "in": 0, "out": 90, "effects": [{"type": "vignette", "params": {"amount": 60, "radius": 55, "softness": 60}}, {"type": "color", "params": {"contrast": 15, "saturation": 20}}]},
 {"id": "grp", "type": "group", "in": 0, "out": 90, "scope": 3, "transform": {"position": {"v": [960, 540], "wiggle": {"freq": 3, "amp": [18, 18], "seed": 4}}, "rotation": {"k": [{"f": 0, "v": -4, "e": "inOutSine"}, {"f": 45, "v": 4, "e": "inOutSine"}, {"f": 90, "v": -4}]}, "scale": [100, 100]}},
 {"id": "a", "type": "shape", "in": 0, "out": 90, "transform": {"position": [660, 540]}, "source": {"kind": "star", "width": 300, "height": 300, "sides": 5, "inner": 0.45, "fill": "#ffd23f"}},
 {"id": "b", "type": "shape", "in": 0, "out": 90, "transform": {"position": [960, 540]}, "source": {"kind": "heart", "width": 280, "height": 280, "fill": "#e65163"}},
 {"id": "c", "type": "shape", "in": 0, "out": 90, "transform": {"position": [1260, 540]}, "source": {"kind": "flower", "width": 300, "height": 300, "petals": 6, "inner": 0.4, "fill": "#7fd0d8"}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#2b2230"}}
]
```

### 16. 押し出し文字(金属・面取り)

ここから 21 までは **`mesh` レイヤー**(手続きで作る 3D。書式の全部は `docs/composition-design.md` の「mesh レイヤー」)。`mesh` はいつも 3D で、`source.objects` に立体を並べる。
オブジェクトの `position` はレイヤーの原点から(px・y は下が正・z は奥が正)、`rotation` は度、`scale` は倍率(1 = 等倍)。

`"geometry": "text"` が立体文字(日本語可)。`depth` が厚み、`bevel` が面取り(`size` ぶん外へ太る)。金属は `metalness: 1` + `roughness`(小さいほど鏡)。`faces: [表裏, 側面]` で側面だけ色を変えられる。
影は `light.shadows: true` と、影だけを受ける透明な面(`"type": "shadow"`)。回転は成分ごとにキーを書ける(`[x のキー, y のキー, 0]`)。

```json
[
 {"id": "title", "type": "mesh", "in": 0, "out": 90, "transform": {"position": [960, 520, 0]}, "source": {"light": {"direction": [-0.6, -1, -0.8], "shadows": true, "shadow_area": 2600}, "objects": [{"geometry": "text", "text": "ポッキーの日", "font": "Noto Sans JP", "weight": 900, "font_size": 240, "depth": 60, "bevel": {"size": 5, "segments": 3}, "rotation": [{"k": [{"f": 0, "v": -50, "e": "outCubic"}, {"f": 40, "v": 0}]}, {"k": [{"f": 0, "v": -30, "e": "inOutSine"}, {"f": 90, "v": 20}]}, 0], "material": {"color": "#d4af37", "metalness": 1, "roughness": 0.3}, "faces": [null, {"color": "#8a5a1c", "metalness": 1, "roughness": 0.5}]}, {"geometry": "plane", "size": [4000, 2400], "position": [0, 0, 220], "cast_shadow": false, "material": {"type": "shadow", "opacity": 0.45}}]}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#2b2230"}}
]
```

### 17. 宝石・金属(回転体・多面体・ガラス)

`lathe` は断面 `profile: [[半径, y], …]` を縦の軸のまわりに回した形(y は下が正)。`segments: 8` + `flat: true` でカット面の宝石、`smooth` を上げればつるんとした卵形。
`icosahedron` などの多面体も `flat: true` で宝石になる。`"type": "glass"` は透ける本体に映り込みが乗る。金属・ガラスの見え方は `source.env`(映り込みの環境)で決まる。

```json
[
 {"id": "gems", "type": "mesh", "in": 0, "out": 90, "transform": {"position": [960, 540, 0]}, "source": {"env": "studio", "light": {"points": [{"position": [0, -300, -400], "color": "#fff2d0", "intensity": 1.5}]}, "objects": [{"geometry": "lathe", "profile": [[0, -150], [70, -110], [110, -40], [110, 0], [0, 170]], "segments": 8, "position": [-520, 0, 0], "rotation": [15, {"k": [{"f": 0, "v": 0}, {"f": 90, "v": 180}]}, 0], "material": {"color": "#e0245e", "metalness": 0.9, "roughness": 0.1, "flat": true}}, {"geometry": "lathe", "profile": [[0, -160], [70, -130], [105, -40], [95, 60], [50, 140], [0, 160]], "smooth": 8, "position": [-170, 0, 0], "material": {"type": "glass", "color": "#7fe7ff", "opacity": 0.3}}, {"geometry": "icosahedron", "radius": 130, "position": [190, 0, 0], "rotation": [{"k": [{"f": 0, "v": 0}, {"f": 90, "v": 90}]}, {"k": [{"f": 0, "v": 0}, {"f": 90, "v": 120}]}, 0], "material": {"color": "#3fd28b", "metalness": 0.8, "roughness": 0.1, "flat": true}}, {"geometry": "torus", "radius": 120, "tube": 26, "position": [540, 0, 0], "rotation": [{"k": [{"f": 0, "v": 60}, {"f": 90, "v": 60}]}, {"k": [{"f": 0, "v": 0}, {"f": 90, "v": 180}]}, 0], "material": {"color": "#d4af37", "metalness": 1, "roughness": 0.2}}]}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#15121c"}}
]
```

### 18. 紙吹雪・桜吹雪(3D)

`instances` が 3D の複製(1 回の描画。数百〜数千個でも軽い)。板(紙吹雪)や `extrude` の `petal`(厚み 0 の花びら)を、画面の上の薄い箱(`area`)から降らせる。
`velocity`(px/秒。y 正 = 落ちる)・`spin`(度/秒)・`sway`(ゆらゆら)と、それぞれの `_random`(ばらつき)。`lifetime` + `loop: true` で降り続ける。`colors` は 1 枚ごとの色(マテリアルは白にしておく)。
頭のコマから舞っている(`prewarm`。順に降り始めたいときは `"prewarm": false`)。粒子レイヤー(レシピ 10)との違い: こちらは 1 枚ずつが 3D で回り、光で表と裏の明るさが変わる。

```json
[
 {"id": "cam", "type": "camera", "in": 0, "out": 90, "source": {"zoom": 1400}},
 {"id": "confetti", "type": "mesh", "in": 0, "out": 90, "transform": {"position": [960, 540, 0]}, "source": {"env": "soft", "light": {"ambient": 1}, "objects": [{"geometry": "plane", "size": [34, 20], "position": [0, -700, 0], "material": {"color": "#ffffff", "roughness": 0.6}, "instances": {"count": 400, "seed": 11, "layout": "box", "area": [2600, 300, 1400], "velocity": [0, 330, 0], "velocity_random": [90, 110, 60], "spin": [220, 160, 90], "spin_random": [260, 240, 180], "rotation_random": [180, 180, 180], "sway": {"amp": [70, 0, 30], "freq": 0.45}, "scale": [0.7, 1.5], "lifetime": 5, "loop": true, "colors": ["#ff5d73", "#ffd23f", "#3fd2c7", "#7b6cf6", "#ffffff"], "fade_in": 0.25, "fade_out": 0.5}}, {"geometry": "extrude", "shape": "petal", "size": [30, 38], "depth": 0, "position": [0, -700, 0], "material": {"color": "#ffffff", "roughness": 0.8}, "instances": {"count": 200, "seed": 5, "layout": "box", "area": [2600, 300, 1400], "velocity": [-60, 210, 0], "velocity_random": [60, 60, 40], "spin": [120, 90, 60], "spin_random": [200, 200, 120], "rotation_random": [180, 180, 180], "sway": {"amp": [110, 0, 50], "freq": 0.3}, "scale": [0.8, 1.6], "lifetime": 7, "loop": true, "colors": ["#ffc7d6", "#ff9dba", "#ffe6ee"], "fade_in": 0.3, "fade_out": 0.6}}]}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#232a4d"}}
]
```

### 19. 破片トランジション(割れて次の場面へ)

`"geometry": "shards"` は、板を `count` 個ほどに割って飛び散らせる。`progress` 0 = 元の板(継ぎ目なし)、1 = 飛び散ったあと。前の場面をコンポジションにして `texture: {"comp_id": N}` で貼り(`frame` で止めるコマ)、
その下に次の場面を置く。`stagger: "center_out"` で中心から順に割れる。`direction: [0, 0, -500]` = 手前へ飛ぶ。`fade` で終わりに消える。`comp_id` は自分のコンポジションの番号に替える。

```json
[
 {"id": "shatter", "type": "mesh", "in": 0, "out": 80, "transform": {"position": [960, 540, 0]}, "source": {"objects": [{"geometry": "shards", "size": [1920, 1080], "count": 160, "seed": 3, "progress": {"k": [{"f": 20, "v": 0, "e": "inQuad"}, {"f": 78, "v": 1}]}, "stagger": "center_out", "stagger_amount": 0.45, "spread": 900, "spread_z": 700, "direction": [0, 0, -500], "spin": 300, "gravity": [0, 700, 0], "fade": 0.35, "material": {"type": "basic", "texture": {"comp_id": 101, "frame": 0}}}]}},
 {"id": "next", "type": "text", "in": 0, "out": 90, "transform": {"position": [960, 540]}, "source": {"text": "次の場面", "font": "Noto Sans JP", "weight": 900, "size": 200, "fill": "#ffffff"}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#e65163"}}
]
```

### 20. 箱に絵を貼る(パッケージ)

`box` の `faces: [右, 左, 上, 下, 手前, 奥]` に面ごとのマテリアルを書く(`null` は `material` のまま)。`texture` は画像素材(`asset_id`)でも、コンポジション(`comp_id`)でもよい。絵はその面いっぱいに 1 枚貼られる
(面の縦横比に合わせた絵を用意する)。`clearcoat` でつやのある箱。y を正に回すと左の面が、x を正に回すと下の面が見えてくる。

```json
[
 {"id": "box", "type": "mesh", "in": 0, "out": 90, "transform": {"position": [960, 540, 0]}, "source": {"light": {"shadows": true, "shadow_area": 1600}, "objects": [{"geometry": "box", "size": [300, 460, 90], "rotation": [{"k": [{"f": 0, "v": 8}, {"f": 90, "v": 8}]}, {"k": [{"f": 0, "v": -40, "e": "inOutSine"}, {"f": 90, "v": 220}]}, 0], "material": {"color": "#e8323c", "roughness": 0.45, "clearcoat": 0.6}, "faces": [null, null, null, null, {"color": "#ffffff", "texture": {"asset_id": 935}, "roughness": 0.45, "clearcoat": 0.6}, {"color": "#ffffff", "texture": {"comp_id": 101}, "roughness": 0.45, "clearcoat": 0.6}]}, {"geometry": "plane", "size": [3000, 2000], "position": [0, 232, 0], "rotation": [90, 0, 0], "cast_shadow": false, "material": {"type": "shadow", "opacity": 0.4}}]}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#f3ead8"}}
]
```

### 21. らせんのレール(管 + 道に沿った複製)

`path`(`helix` = らせん。`height` 正 = 上へ進む)を `tube`(管)と `instances.layout: "along"`(道に沿って等間隔)で使う。レール 2 本は半径を変えた同じらせん、枕木は道の向きに合わせて回る箱
(`size: [道の向きの幅, 厚み, 道を横切る長さ]`)。`offset` をキーにすると道の上を進む(1 個だけの複製は道の始点から)。全体を回すのはレイヤーの `transform.rotation`。

```json
[
 {"id": "cam", "type": "camera", "in": 0, "out": 90, "source": {"zoom": 1400, "target": [960, 540, 0]}, "transform": {"position": {"k": [{"f": 0, "v": [960, 160, -1400], "e": "inOutSine"}, {"f": 90, "v": [960, 420, -1250]}]}}},
 {"id": "rail", "type": "mesh", "in": 0, "out": 90, "transform": {"position": [960, 560, 0], "rotation": [0, {"k": [{"f": 0, "v": 0}, {"f": 90, "v": 120}]}, 0]}, "source": {"objects": [{"geometry": "tube", "path": {"type": "helix", "radius": 278, "turns": 3, "height": 620}, "tube": 7, "material": {"color": "#c9ccd6", "metalness": 1, "roughness": 0.25}}, {"geometry": "tube", "path": {"type": "helix", "radius": 322, "turns": 3, "height": 620}, "tube": 7, "material": {"color": "#c9ccd6", "metalness": 1, "roughness": 0.25}}, {"geometry": "box", "size": [16, 8, 70], "position": [0, 8, 0], "material": {"color": "#7a4a22", "roughness": 0.8}, "instances": {"count": 110, "layout": "along", "path": {"type": "helix", "radius": 300, "turns": 3, "height": 620}}}, {"geometry": "sphere", "radius": 26, "position": [0, -30, 0], "material": {"type": "emissive", "color": "#ffd23f", "emissive_intensity": 1.2}, "instances": {"count": 1, "layout": "along", "path": {"type": "helix", "radius": 300, "turns": 3, "height": 620}, "offset": {"k": [{"f": 0, "v": 0.02}, {"f": 90, "v": 0.95}]}}}]}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#101624"}}
]
```

### マネキン(関節つきの人形)を立たせる・歩かせる・ポーズを付ける

3D の人物の「仮置き」や、立体のアタリに。`mesh` レイヤーの objects に `geometry: "mannequin"` を 1 個書くと 1 体。原点 = 両足の間の地面(`position` = 足もと)、`rotation: [0, 0, 0]` でこちら向き(y を正にすると画面の右を向く。180 = 後ろ姿)。
`body` = 体格(`height` 身長 px・`heads` 頭身)、`colors` = 肌・服の上・服の下・髪・靴・リボン、`outfit` = 袖・ズボン・スカート・靴下・ブーツの長さ、`hair.style: "ponytail"` = 長いポニーテール + 黒いリボン。
ポーズは `preset`(12 種。`walk` `run` `wave` `idle` は `phase` 0〜1 で 1 周 → `{"k": [{"f": 0, "v": 0}, {"f": 54, "v": 1}], "loop": true}` で歩き続ける)に、`pose` の関節の角度(度)を上書きする。
`pose` の数はどれもキーフレーム・wiggle にできる(下の例は 首を振り向かせる・ポニーテールを揺らす)。`preset_b` + `preset_mix`(0〜1)で 2 つのポーズの間をなめらかに移る。見本は `examples/17_mannequin_presets.json` `18_mannequin_walk.json`。

```json
[
 {"id": "fig", "type": "mesh", "in": 0, "out": 90, "transform": {"position": [960, 540, 0]}, "source": {"light": {"ambient": 1.0, "intensity": 1.8, "direction": [-0.6, -1, -0.7], "shadows": true, "shadow_area": 2400, "shadow_opacity": 0.5}, "objects": [
  {"geometry": "plane", "size": [3000, 1200], "position": [0, 380, 0], "rotation": [-90, 0, 0], "cast_shadow": false, "material": {"type": "shadow", "opacity": 0.3}},
  {"geometry": "mannequin", "position": [{"k": [{"f": 0, "v": -500}, {"f": 90, "v": -60}]}, 380, 0], "rotation": [0, 62, 0], "body": {"height": 520, "heads": 6.2},
   "colors": {"top": "#a32f48", "bottom": "#a32f48", "skirt": "#e68aa8", "hair": "#b5334f", "socks": "#3b2233", "shoes": "#5a2030"}, "hair": {"style": "ponytail", "length": 0.5},
   "outfit": {"sleeves": 0.15, "pants": 0.05, "skirt": 0.75, "skirt_flare": 0.9, "socks": 1.5}, "outline": {"width": 3, "color": "#3a2028"}, "material": {"type": "toon"},
   "preset": "walk", "phase": {"k": [{"f": 0, "v": 0}, {"f": 54, "v": 1}], "loop": true},
   "pose": {"head": [0, {"k": [{"f": 40, "v": 0, "e": "inOutSine"}, {"f": 60, "v": -55}]}, 0]}},
  {"geometry": "mannequin", "position": [520, 380, 0], "rotation": [0, -20, 0], "body": {"height": 500}, "colors": {"top": "#86ab9d", "bottom": "#55698f"}, "hair": {"style": "ponytail"}, "outline": {"width": 3}, "material": {"type": "toon"},
   "preset": "stand", "preset_b": "wave", "preset_mix": {"k": [{"f": 30, "v": 0, "e": "outBack"}, {"f": 50, "v": 1}]}, "phase": {"k": [{"f": 0, "v": 0}, {"f": 40, "v": 1}], "loop": true},
   "pose": {"pony_1": [0, {"v": 0, "wiggle": {"amp": 9, "freq": 0.7, "seed": 3}}, 0], "pony_2": [0, {"v": 0, "wiggle": {"amp": 12, "freq": 0.7, "seed": 4}}, 0]}}]}},
 {"id": "bg", "type": "solid", "in": 0, "out": 90, "source": {"color": "#e9e4dc"}}
]
```

- 角度の読み方(本人から見た向き。`_l` = 本人の左 = こちら向きのとき画面の右): 肩・股 `[前へ上げる, 内へひねる, 外へ開く]`、ひじ `[曲げる, 前腕のひねり]`、ひざ `曲げる`、体の軸(root spine chest neck head)`[前へ倒す, 向きを変える, 横へ傾ける]`、ポニーテール `[後ろへ振る, 横へ振る]`。
  数 1 個なら 1 つ目だけを替える(`"elbow_r": 90`)。配列の `null` はプリセットの値のまま。ひじは「前へ」曲がるので、横に上げた腕の前腕を上へ立てるには上腕を外へひねる(`"shoulder_r": [0, -90, 90], "elbow_r": 90`)。
- 手の形は `pose.hand_l` `hand_r`: `mitt`(既定)`fist` `open` `peace` `point`。座らせるときは `preset: "sit"`(腰がももの長さだけ下がる)+ 椅子の箱。体を持ち上げる・沈めるのは `pose.offset: [x, y, z]`(身長に対する割合)。
- 暗い場面で服の色が沈むときは `self_light: 0.3` ほど。棒人形は `style: "stick"`。顔の大写しは、身長を大きくして(頭の高さ = 身長 ÷ 頭身)レイヤーの位置で頭を画面に入れる。
- 表情・服の細部・指の関節は無い(仮置き用)。本番の絵は、絵の素材(puppet レイヤー)か、3D モデル(model レイヤー)に差し替える。
### 足した効果の使い方(極座標・ラフエッジ・フレア・ガラス・減色ほか)

見本は `tools/comp-kit/examples/16_fx_extras.json`(8 個を 1 枚に並べた)。どれも `effects` の列に書く。

```json
[
 {"id": "rays", "type": "pattern", "in": 0, "out": 90, "source": {"kind": "stripes", "colors": ["#d9b65a", "#b08f3c"], "size": 107},
  "effects": [{"type": "polar", "params": {"fit": "cover", "inner": "top"}}]},
 {"id": "tear", "type": "image", "in": 0, "out": 90, "transform": {"position": [960, 540]}, "source": {"asset_id": 935},
  "effects": [{"type": "rough_edges", "params": {"amount": {"k": [{"f": 0, "v": 140, "e": "outQuad"}, {"f": 12, "v": 0}]}, "size": 80, "threshold": 50}}]},
 {"id": "flare", "type": "shape", "in": 0, "out": 90, "transform": {"position": [960, 540]}, "source": {"kind": "rect", "width": 1920, "height": 1080, "fill": "#00000000"},
  "effects": [{"type": "lens_flare", "params": {"cx": 300, "cy": -80, "radius": 120, "streak_length": 1600, "rays": 1, "color": "#9999ff"}}]},
 {"id": "glass", "type": "adjustment", "in": 0, "out": 90, "masks": [{"shape": "ellipse", "x": 760, "y": 340, "w": 400, "h": 400}],
  "effects": [{"type": "refract", "params": {"radius": 200, "amount": 45, "aberration": 6, "highlight": 60, "shade": 35}}]}
]
```

- しま模様 → 放射状の光: `pattern`(stripes)に `polar`(`fit: "cover"`)。しまの本数 = 光の本数。`swirl` を動かすと渦になる。
- ちぎれて現れる・消える: `rough_edges` の `amount` を大きい値 → 0(現れる)。`threshold: 0` にすると切り直さず、ゆがむだけ。
- 光(フレア): 透明な四角(画面大)に `lens_flare`。光芒は `rays` 本(1 = 一文字、2 = 十字)、`angle: 90` で横。カメラに付けたいときは、その四角を 3D にする。
- ガラス玉・レンズ: 調整レイヤー + だ円のマスク + `refract`(`radius` はマスクの半径に合わせる。`cx` `cy` は画面の中心からのずれ)。すりガラスは `kind: "frost"` + 角丸のマスク。
- 区画がずれるノイズ: 調整レイヤーに `block_noise`(`count: [5, 15]`、`shift_x: [-30, 30]`)。`speed` で切り替えの速さ。
- 色数を絞る: 色を決めたいなら `palette`(`colors` に 2〜32 色)、段だけ切るなら `posterize`(`levels`)。
- 内側の影: `inner_shadow`(`x` `y` `blur` `opacity` `color`)。白い `color` + 小さい `x` `y` で、縁の内側の光にもなる。
- 動きに尾を引かせる: レイヤーに `"motion_blur": {"samples": 10, "shutter": 1, "phase": -1}`(1 コマ前からいままでを重ねる)。`true` だけなら前後 1/4 コマずつ。
- 字が寄ってくる: text の `tracking` を `{"k": [{"f": 0, "v": 1000, "e": "outExpo"}, {"f": 16, "v": 0}]}`。
- 破線: shape の線は `"dash": [28, 16]`(`dash_offset` を動かすと流れる)。画像・文字の輪郭は `trace_outline` の `dash_period`(1 周に対する %)`dash_gap`。

### 立ち絵を少し動かす(puppet。まばたき・口・髪ゆれ・首ふり)

パーツ分解済みの立ち絵(コンパニオンのパペット)を置き、値を書くだけで動く。例: `tools/comp-kit/examples/puppet_01_idle.json`。

```json
{"id": "kyoko", "type": "puppet", "in": 0, "out": 150, "transform": {"position": [960, 560], "scale": [80, 80]},
 "source": {"puppet_id": "kyoko_flat", "auto_blink": true, "sway": 1,
            "wind": {"k": [{"f": 60, "v": 0}, {"f": 90, "v": 0.9, "e": "inOutSine"}, {"f": 130, "v": 0, "e": "inOutSine"}]},
            "head_turn": {"k": [{"f": 40, "v": 0}, {"f": 62, "v": -0.8, "e": "inOutSine"}, {"f": 92, "v": 0.3, "e": "inOutSine"}]},
            "head_tilt": {"k": [{"f": 96, "v": 0}, {"f": 110, "v": 6, "e": "inOutSine"}]},
            "mouth": {"k": [{"f": 18, "v": 0}, {"f": 24, "v": 0.85}, {"f": 30, "v": 0.3}, {"f": 36, "v": 0.9}, {"f": 44, "v": 0}]}}}
```

- 使えるパペットは `GET /api/puppet/`。パーツは `GET /api/puppet/<id>/manifest` の `layers`(名前・bbox・`sway`)。箱はパペットのキャンバス(1280×1280 など)なので、`transform.scale` で大きさを決める。
- 顔の寄り・バストアップは `"crop": [左, 上, 右, 下]`(キャンバスの px)。箱がその範囲になるので、`position` はその中心を置く場所。
- 「立っているだけ」の間は `auto_blink` + 既定の `breath` `sway` で十分動いて見える。首ふりは ±0.5 くらいまでが自然(±1 は端の絵が足りなくなる)。動かす前後に 6〜10 コマのためを作り、`inOutSine` でつなぐ。
- 風で髪をなびかせるときは `wind` にキーを打つ(0 → 0.9 → 0)。`sway_speed` にはキーを打たない(位相が飛ぶ)。
- 影・白フチ・光は effects で(`drop_shadow` `stroke_outline` `glow`)。登場は transition か `offset`。腕を振る・歩くはできない(関節が無い)。そういう動きは別の絵を作るか、映像生成に回す。
- 新しい立ち絵から作る: 全身・正面・腕を体から離さず下ろした絵(`arms at sides, straight-on view, symmetrical, flat color, simple background`)を 1 枚作り、
  `POST /api/puppet/decompose {"project_id", "asset_id", "puppet_id", "name"}`(GPU を約 7 分占有。ほかの生成と重ねない)→ できた id を `puppet_id` に書く。
- 書いたら 12 コマおきに `thumb` で見る(顔の部品のずれ・髪の根元・首の継ぎ目)。

### レシピを組み合わせるコツ

- **重い順**: mesh(光・影・映り込みつき)≒ 入れ子 > 被写界深度つき 3D > 粒子 > ぼかし・縁・影 > 切り抜き・色。同時に映るレイヤーを 40〜60 枚に抑えると、プレビューが軽い。
- **まず transition、足りなければ offset**: 登場は `transition_in`。位置の動きを足すなら、`transform.position` を直接キーにする代わりにエフェクト `offset`(足し算)を使うと、置き場所と動きを分けて直せる。
- **同じ動きを何枚にも**: `group`(下の N 層)か `parent`(null レイヤー)でまとめる。同じ絵を並べるなら `repeater`。
- **1 枚の絵として動かしたい**: 入れ子(プリコンポーズ。行の右クリック)にまとめる。

## 5. AI エージェントが API から作る・直す

文書は JSON なので、HTTP だけで作れる。編集画面を開いている人がいても、保存した内容は開き直すと見える(同じコンポジションを同時に書くと、あとから保存したほうが勝つ)。

| やること | API |
|---|---|
| 一覧 | `GET /api/comps/?project_id=N`(`rev` `rendered_rev` `stale` `stale_deep` `layer_count`) |
| 読む | `GET /api/comps/{id}` → `{id, name, width, height, fps, duration_frames, rev, data}` |
| 作る | `POST /api/comps/` `{project_id, name, width, height, fps, duration_frames, data}` |
| 直す | `PATCH /api/comps/{id}` `{data}`(文書を丸ごと)。`name` `width` `height` `fps` `duration_frames` も同じ口。循環する入れ子は 422 |
| 複製・削除 | `POST /api/comps/{id}/duplicate` / `DELETE /api/comps/{id}`(置かれている・入れ子で使われていると 409) |
| 1 コマ見る | `GET /api/comps/{id}/thumb?frame=N&width=960`(JPEG。描き出す前でも出る。初回は 2 秒ほど) |
| 描き出す | `POST /api/comps/{id}/render` → `{job_id}`。`GET /api/jobs/{job_id}` の `status` が `completed` になるまで待つ |
| 置く | `POST /api/comps/{id}/place` `{start_frame, track_id?, render?}`(track_id を省くと「Comps」トラック) |
| 書式の一覧 | `GET /api/comps/engine/schema.json`(エフェクト 50 種以上・レイヤーの種類・共通項目・イージング・プリセットと、それぞれの既定値・範囲) |
| 書体 | `GET /api/comps/fonts`(`family` を `source.font` に書く) |

```python
"""コンポジションを API から作って、1 コマ確かめ、描き出す最小の例。標準ライブラリだけで動く。"""
import json, time, urllib.request

BASE = "http://127.0.0.1:8002"
PROJECT_ID = 35          # 置き先のプロジェクト

def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        raw = r.read()
        return json.loads(raw) if r.headers.get("content-type", "").startswith("application/json") else raw

# 1) 作る(文書 = data。layers の先頭が最前面)
doc = {"version": 1, "bg": "#1b1524", "layers": [
    {"id": "title", "type": "text", "in": 0, "out": 90, "transform": {"position": [960, 540]},
     "source": {"text": "API から作った", "font": "Noto Sans JP", "weight": 900, "size": 140, "fill": "#ffffff"},
     "transition_in": {"type": "fade", "duration": 15}},
]}
comp = call("POST", "/api/comps/", {"project_id": PROJECT_ID, "name": "レシピ: API の例", "width": 1920, "height": 1080,
                                    "fps": 30, "duration_frames": 90, "data": doc})
cid = comp["id"]

# 2) 直す(読む → 変える → data を丸ごと PATCH。保存のたびに rev が上がる)
cur = call("GET", f"/api/comps/{cid}")["data"]
cur["layers"][0]["source"]["fill"] = "#ffd23f"
cur["layers"].append({"id": "bar", "type": "shape", "in": 10, "out": 90, "transform": {"position": [960, 680]},
                      "source": {"kind": "rect", "width": 900, "height": 12, "fill": "#e65163"},
                      "transition_in": {"type": "clip", "side": "right", "duration": 20, "e": "inOutExpo"}})
comp = call("PATCH", f"/api/comps/{cid}", {"data": cur})

# 3) 1 コマ見て確かめる(描き出す前でも出る。JPEG)
open("/tmp/comp_check.jpg", "wb").write(call("GET", f"/api/comps/{cid}/thumb?frame=40&width=960"))

# 4) 描き出す(動画素材になる。bg が null ならアルファつき)。ジョブが終わるまで待つ
job = call("POST", f"/api/comps/{cid}/render")
while True:
    j = call("GET", f"/api/jobs/{job['job_id']}")
    if j["status"] in ("completed", "failed", "cancelled"):
        break
    time.sleep(1)
print("render:", j["status"], "asset:", call("GET", f"/api/comps/{cid}")["rendered_asset_id"])

# 5) 本体のタイムラインに置く(track_id を省くと「Comps」トラック。描き出しが古ければ先に描き直す)
# clip = call("POST", f"/api/comps/{cid}/place", {"start_frame": 0})
```

### 背景を消す(切り抜き)を API から

編集画面の「✂ 背景を消す」と同じこと。新しい API は無く、ジョブ `cutout`(`tools/cutout-kit`)を投げて、できた素材の番号をレイヤーに書くだけ。

```python
# 上の call() の続き。cid = コンポジション、"chara" = 背景を消したい画像レイヤーの id
comp = call("GET", f"/api/comps/{cid}")
layer = next(l for l in comp["data"]["layers"] if l["id"] == "chara")
src_id = layer["source"]["asset_id"]
# project_id = できた素材を入れるプロジェクト(コンポジションのプロジェクト)。crop: False = 絵の大きさを変えない(位置・拡大率がそのまま合う)
# model: "isnet-anime"(アニメ絵・既定)/ "birefnet-general"(写真・汎用。重い)。bg: "white"(白い背景の絵。縁の白かぶりと落ち影も取る)/ "none"
job = call("POST", "/api/jobs/", {"project_id": PID, "job_type": "cutout",
           "params": {"project_id": PID, "asset_id": src_id, "model": "isnet-anime", "bg": "white", "feather": 1, "crop": False}})
while True:
    j = call("GET", f"/api/jobs/{job['id']}")
    if j["status"] in ("completed", "failed", "cancelled"): break
    time.sleep(0.7)
assert j["status"] == "completed", j.get("error_msg")
layer["source"]["cutout_of"] = layer["source"].get("cutout_of", src_id)   # 控え(「↩ 元の絵に戻す」が読む。絵には効かない)
layer["source"]["asset_id"] = j["result_asset_ids"][0]
call("PATCH", f"/api/comps/{cid}", {"data": comp["data"]})
# 戻すとき: layer["source"]["asset_id"] = layer["source"].pop("cutout_of")
```

- `POST /api/assets/{id}/cutout {"model", "bg", "feather", "crop"}` でも同じジョブになるが、できた素材は**元の素材のプロジェクト**に入り、`crop` の既定が `true`(透明な余白を切り落とす = 絵の大きさが変わる)。
  コンポジションのレイヤーを差し替えるなら、上の `POST /api/jobs/` で `project_id` と `crop: false` を明示する。
- 切り抜きは CPU で数秒(birefnet-general は数十秒)。できた絵は `thumb` で必ず 1 コマ見る(髪の先・白い服が欠けることがある。欠けたら model か bg を変える)。

### エージェントむけの注意

1. **書いたら必ず 1 コマ見る。** `thumb` で数コマ(頭・動きの途中・終わり)を取り、絵を自分の目で確かめてから「できた」と言う。書式として通っても、画面の外に出ている・透明・時刻がレイヤーの外、はよくある。
2. **`id` は文書の中で一意。** `parent` `matte.layer` `clip_to` `scope` `source.target_layer` は id で指す。レイヤーを消したら、指している側も直す。
3. **`layers` の先頭が最前面。** 背景はいちばん最後に書く。
4. **`in`〜`out` の外では映らない。** キーの `f` はコンポジションのコマ(レイヤーの頭からではない)。例外: `per_char.at` と transition はレイヤーの `in` から。
5. **知らない項目は消さない。** 取り込んだ文書には `aviutl` などの控えが入っている。読んだ `data` を直して丸ごと返す(作り直さない)。
6. **エフェクトの名前と項目は schema.json で確かめる。** 知らない `type` は警告つきで飛ばされるだけなので、綴りの誤りに気づきにくい(編集画面のプレビューの下「エンジンからの知らせ」に出る)。
7. **素材**: `image` `video` は `source.asset_id`(`GET /api/assets/?project_id=N`)。何も書かなければ素材の元の大きさで置かれる。**大きさは `source.fit` で px で決める**(素材の画素数を調べて `scale` を割り算しなくてよい):
   `{"fit": {"width": 600}}`(幅 600 px・高さは縦横比どおり)、`{"fit": {"height": 800}}`、`{"fit": {"width": 600, "height": 800, "mode": "cover"}}`(箱を覆う・はみ出しは切る。`contain` = 収める・`stretch` = 引きのばす)、
   `{"fit": {"mode": "cover"}}`(コンポジションの全面を覆う)。`transform.scale` はその上に掛かる(100 % = 合わせた大きさ)。エフェクトの px(`mask_shape` の幅など)も合わせたあとの大きさで書く。
8. **背景を消す(切り抜き)**: 既存のジョブ `cutout` を呼び、できた素材にレイヤーを差し替える(下の「背景を消す」の例)。元の素材は残す。
9. **重さ**: 重いエフェクト・入れ子・被写界深度は枚数に比例して遅い(`tools/comp-kit/README.md` の「例と速さ」)。
10. 取り込み試験のプロジェクト(36)のコンポジションは参照用。試すときは `duplicate` した写しで。
11. **mesh(立体)**: 書式は `docs/composition-design.md` の「mesh レイヤー」に全部ある。間違えやすい所:
    `scale` は倍率(% ではない)。y は下が正(`lathe` の `profile`・`extrude` の `points`・`velocity`・`gravity` も)。金属は `env` が `"none"` だと黒い。
    透過 PNG を貼るときは `transparent: true` か `alpha_test: 0.5`。交差・影を落とし合う物は同じ mesh レイヤーに入れる(レイヤーどうしは原点の奥行きで並ぶだけ)。
    `instances.colors` を使うときマテリアルは白。破片(`shards`)の `progress` 0 は元の板そのものなので、割れ始めるコマまで置いておいてよい。
