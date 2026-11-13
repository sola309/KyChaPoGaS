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

## 4. レシピ 15

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

### レシピを組み合わせるコツ

- **重い順**: 入れ子 > 被写界深度つき 3D > 粒子 > ぼかし・縁・影 > 切り抜き・色。同時に映るレイヤーを 40〜60 枚に抑えると、プレビューが軽い。
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

### エージェントむけの注意

1. **書いたら必ず 1 コマ見る。** `thumb` で数コマ(頭・動きの途中・終わり)を取り、絵を自分の目で確かめてから「できた」と言う。書式として通っても、画面の外に出ている・透明・時刻がレイヤーの外、はよくある。
2. **`id` は文書の中で一意。** `parent` `matte.layer` `clip_to` `scope` `source.target_layer` は id で指す。レイヤーを消したら、指している側も直す。
3. **`layers` の先頭が最前面。** 背景はいちばん最後に書く。
4. **`in`〜`out` の外では映らない。** キーの `f` はコンポジションのコマ(レイヤーの頭からではない)。例外: `per_char.at` と transition はレイヤーの `in` から。
5. **知らない項目は消さない。** 取り込んだ文書には `aviutl` などの控えが入っている。読んだ `data` を直して丸ごと返す(作り直さない)。
6. **エフェクトの名前と項目は schema.json で確かめる。** 知らない `type` は警告つきで飛ばされるだけなので、綴りの誤りに気づきにくい(編集画面のプレビューの下「エンジンからの知らせ」に出る)。
7. **素材**: `image` `video` は `source.asset_id`(`GET /api/assets/?project_id=N`)。大きさは素材の元の大きさで置かれるので、`transform.scale` で合わせる。
8. **重さ**: 重いエフェクト・入れ子・被写界深度は枚数に比例して遅い(`tools/comp-kit/README.md` の「例と速さ」)。
9. 取り込み試験のプロジェクト(36)のコンポジションは参照用。試すときは `duplicate` した写しで。
