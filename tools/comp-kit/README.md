# comp-kit — コンポジションの描画エンジン

`docs/composition-design.md` のコンポジション文書を描く。three.js r180(`tools/mg-libs`)だけに依存し、ビルドは不要。
プレビュー(iframe)も書き出し(`motion_graphics.render_html_to_video` の決定論キャプチャ)も同じコードで描く。

## ファイル

| ファイル | 役目 |
|---|---|
| `comp-engine.js` | 入口。`CompEngine`(load / loadFonts / renderFrame / update / pick / layerBounds / dispose) |
| `scene.js` | 1 つの文書を描く本体(変形・グループ・カメラ・描く順・エフェクトの列・複製・マット・ブレンド・調整レイヤー・入れ子・選択) |
| `props.js` | プロパティ値(キーフレーム・イージング(Penner 式の全種類)・loop・wiggle・ignore_mid)、決定論の乱数、色 |
| `gfx.js` | RT の使い回し、全画面パス、四角形のまとめ描き、レイヤー用シェーダ(縁 AA・マスク・模様・軽いエフェクト) |
| `ops.js` | **軽いエフェクト**(切る・隠す・色)。RT を使わず、レイヤーを描くシェーダの中で順に評価する。並び(署名)ごとにシェーダを作って使い回す |
| `effects.js` | **重いエフェクト**(ぼかし・光・縁・影・ゆがみ)。RT → RT のパス |
| `pattern.js` | 模様(矢絣・麻の葉・青海波・市松など 20 種)。式で描く |
| `text.js` `shape.js` `particles.js` `model.js` | 種別ごとの中身(Canvas2D のラスタライズ、粒子の式、GLB) |
| `assets.js` | 画像・動画・連番・素材情報の読み込み |
| `player.html` | iframe / キャプチャ用のページ。`/*__COMP_BOOT__*/` を `window.__COMP_BOOT = {...};` に置き換えて使う |
| `schema.json` | 編集画面むけの一覧(エフェクト・レイヤー種別・共通項目・合成モード・イージング・プリセット)。`test/schema_gen.py` で作る |
| `examples/*.json` | 例(下の表) |
| `test/render_test.py` | 描画テスト(コマの書き出し・動画・`--bench`) |
| `test/check_test.py` | 数値の約束(50% 赤・画像 100%・`source.fit`・破線・`deg_per_px`・箱の決まり(縁取り → crop・stroke_in_box・ぼかし → flip・transparent・matte.layers・vignette_blur の円)・決定論・プレビュー = 書き出し) |
| `test/schema_test.py` | schema.json の全項目がエンジンで通るか。エフェクトの全項目(256 個)・レイヤーの source・共通項目を「効き目が見える場面」で動かし、絵が変わらなければ NG |
| `test/order_test.py` | エフェクトが書いた順に掛かるか。軽いエフェクト + flip / repeat の順番つきの全部の組(812 組)を、1 個ずつ RT に描く手本と比べる。先読みの切り抜きも |
| `test/player_test.py` | player.html と親の間の postMessage(選択・移動・拡大・回転・複数選択・キー・知らせ・下絵・目安)を、iframe に本物のマウスとキーを送って確かめる |

配信は `comp-kit` と `mg-libs` を同じ URL(`/api/comps/engine/`)に平らに並べる。
- どの応答にも `Access-Control-Allow-Origin: *` が要る(キャプチャのページは `set_content` で作るのでオリジンが無い。モジュール・画像・動画のコマ・書体すべて CORS 扱い)。
- `.js` は `text/javascript` で返す。動画ファイルは Range(206)に対応していること。
- model レイヤーは `GLTFLoader.js` を後から読む。`'three'` の import map は player.html が自分で入れる。

## 例と速さ

SwiftShader(書き出しと同じ GL)・1920×1080 での 1 コマあたりの時間(`render_test.py <例> --bench 16`。全体から等間隔に 16 コマ)。

| 例 | 中身 | 層 | 平均 ms | 最大 ms |
|---|---|---|---|---|
| 01 kinetic_type | 文字アニメ | 8 | 12 | 14 |
| 02 shapes_parent_blend | シェイプ・親子・ブレンド | 27 | 22 | 28 |
| 03 camera_3d | 3D カメラ | 29 | 15 | 20 |
| 04 mask_matte_fx | マスク・マット・エフェクト | 18 | 36 | 40 |
| 05 particles_adjustment | 粒子・調整レイヤー | 8 | 78 | 82 |
| 06 nested | 入れ子 | 6 | 110 | 143 |
| 07 patterns | 模様 20 種(流れるものも) | 41 | 21 | 26 |
| 08 repeater_shapes | 複製(500 個を 1 回の描画)・シェイプの形 | 40 | 36 | 39 |
| 09 transitions | 登場・退場 10 種 | 30 | 32 | 57 |
| 10 text | 縦書き・カウンター・runs・タイプライター・座布団・円周 | 14 | 34 | 45 |
| 11 character_card | 参考作品ふうのキャラ紹介(斜めクリッピングの帯・網点・名札) | 19 | 88 | 98 |
| 12 petals_3d_dof | 3D の花びら 5 層 + 被写界深度 | 11 | 74 | 81 |
| 13 title_sequence | 19 秒・151 層(同時に 40〜60 層)。矢じりの列 48 枚、名札、3D の札 36 枚 + 被写界深度、扇の切り替え | 151 | 104 | 169 |

速さの勘どころ:
- 切る・色・位置の足し算だけのレイヤーは RT を使わず 1 回の描画で済む(13 の矢じり 48 枚で 25 ms ほど)。
- 重いエフェクトは 1 個につきパス 1〜6 回。RT の大きさ(= レイヤーの箱 × 拡大率)に比例する。太い縁取り・大きなぼかしは縮小して掛ける。
- 被写界深度は 3D レイヤー 1 枚ごとにぼかしを掛ける。ぼかしが使う解像度(σ が 1.2 画素になるまで 1/2・1/4…に縮めた大きさ)でレイヤーを直接描き、
  縮小のパスを省く。小さなぼかし(σ ≤ 1.2 画素)は 4 回読みの 1 パス。式で描く模様だけはモアレを避けて 2 倍の大きさで描いてから縮める(12 が 186 → 74 ms)。
- 入れ子は子を画面大の RT に描く(06)。同じ子の同じコマは使い回す(`renderCached`): 1 コマの中で 2 回使うとき(マット元でもあり自分も映る・同じ時刻で 2 回置く)と、
  子のコマが前のコマと同じとき(freeze・time_remap の止め)。素材・書体が読めるたび、子を読み直すたびに無効になる。別の時刻で 2 回置けば 2 回描く。
- 重いエフェクトのあとに切り抜きが続くとき(全面の絵に影・縁 → 細い帯に切る)は、あとの切り抜きを先読みして、帯 + はみ出しぶんだけを RT に描く。
  先読みできるのは、まわりの画素だけで決まるパス(blur / glow / drop_shadow / stroke_outline など)と色の op だけをはさんで続く `clip_line` `crop` `mask_shape` `iris`。
- シェイプの先頭の `stroke_outline`(外側・ぼかしなし・動かない値・不透明な色・閉じた形)は、形のラスタライズに畳み込む(RT もパスも使わない)。
  それ以外の細い縁(幅 2.5px 以下)は 1 パス。太い縁は「広げる → 仕上げ」の 2 パス以上。
- 取り込んだ comp 12(キャラ羅列紹介。入れ子 + 太い縁取り 12 枚 + 影 12 枚)は 13 コマの平均 211 → 124 ms、最大 434 → 276 ms。

## テスト

```sh
PY=repo/backend/.venv/bin/python
$PY tools/comp-kit/test/render_test.py examples/01_kinetic_type.json --frames 0,12,48 --out /tmp/x
$PY tools/comp-kit/test/render_test.py examples/03_camera_3d.json --video /tmp/x/cam.mp4     # bg が null なら .mov(アルファつき)
$PY tools/comp-kit/test/render_test.py examples/04_mask_matte_fx.json --frames 40 --mode preview   # プレビュー経路(同じ絵になる)
$PY tools/comp-kit/test/render_test.py examples/13_title_sequence.json --bench 16   # 1 コマあたりの時間(描き終わりまで待って測る)
$PY tools/comp-kit/test/render_test.py examples/06_nested.json --serve     # サーバだけ立てて URL を出す(手で見る用)
$PY tools/comp-kit/test/check_test.py       # 数値の約束
$PY tools/comp-kit/test/schema_test.py      # schema.json の全項目
```

テスト用サーバは空きポートで立ち、`/api/comps/<id>` は examples の JSON(無ければ本番へ)、`/api/comps/vframe/..` は ffmpeg の切り出し、
`/api/assets/..` は本番(8002)への GET の中継で代用する。例 11・13 は本番の画像素材(asset 7514)を使う(無ければその層が出ないだけ)。

## player.html

boot: `{ comp:{id,name,width,height,fps,duration_frames,data}, mode:'preview'|'capture', apiBase, engineBase:'/api/comps/engine/', fonts:[{family,url,weight,style,aliases}] }`

- `fonts`: プロジェクトの書体。`url` の `/...` は apiBase から。読み終えてから最初の 1 コマを描く(capture でも同じ)。
  `aliases`(日本語の書体名「あんずもじ」・太さつきの名前「Noto Sans JP Bold」など)は、同じファイルを別名の family としても登録する(文書がどの名前で書いていても引ける)。

- capture: canvas は width×height px・余白 0・背景透明。`window.__madAssetsReady`、`window.seek(tMs)`(素材がそろって描き終わってから解決)。
  `document.querySelector('canvas').toDataURL('image/png')` はストレートアルファの PNG になる。
- preview: 窓に収まるよう縮めて市松模様の上に表示。表示が小さいときは 0.5 / 0.75 倍で描く(`?scale=1` で固定)。`?frame=N` で最初のコマ。

### postMessage

親 → iframe

| type | 中身 |
|---|---|
| `comp:set` | `{comp}` 文書の差し替え(ドラッグ中の仮の値を消して描き直す) |
| `comp:seek` | `{frame}` |
| `comp:play` | `{playing, frame?}` 実時間で再生(コマ単位・最後で頭に戻る) |
| `comp:select` | `{ids:[...]}` 選択枠を出す。1 枚だけのときは拡大・回転のつまみも出る |
| `comp:invalidate` | `{comp_id}` 入れ子の子を読み直す |
| `comp:quality` | `{scale}` 描く解像度の倍率。0 で自動 |
| `comp:fonts` | `{fonts}` 書体を足して描き直す |
| `comp:guides` | `{show: boolean}` 下絵(`guide: true`)のレイヤーを出す・隠す。既定は出す(書き出し・入れ子の中では、もともと出ない) |
| `comp:overlay` | `{safe: boolean, grid: boolean}` 重ね描きの目安。safe = セーフフレーム(実線 = 90% アクションセーフ、破線 = 80% タイトルセーフ、中心の十字)、grid = 三分割の線。絵には焼かれない |

iframe → 親

| type | 中身 |
|---|---|
| `comp:ready` | `{width,height,fps,duration_frames,frame}` |
| `comp:frame` | `{frame}` 再生中 |
| `comp:select` | `{ids}` クリックで選択(Shift で追加・解除、何もない所 = `[]`)。複数選択の中の 1 枚をつかんだときは、選択を変えずに全部を動かす |
| `comp:edit` | `{id, path, value, final, keyframed?, frame?}`(下) |
| `comp:key` | `{key, code, ctrl, shift, alt, meta, repeat}` iframe にフォーカスがある間の keydown をすべて知らせる。iframe の中ではショートカットを何も処理しない |
| `comp:error` | `{level: 'warn' \| 'error', message, layer_id?}` 困りごとの知らせ(下) |

**`comp:edit`**: ドラッグで変形したとき。動かしている間は `final: false`、離したとき `final: true` を 1 回。その項目がキーフレームなら `keyframed: true, frame` がつき、`value` はそのコマでの値。

| path | value | 操作 |
|---|---|---|
| `transform.position` | `[x, y]` か `[x, y, z]`(元が 3 個・または 3D で奥行きが動いたとき) | レイヤーをドラッグ。複数選択なら **レイヤーごとに 1 通**(親・効いているグループもいっしょに選んでいる子は、親について動くので送らない) |
| `transform.scale` | `[x, y, z]`(%)。文書の値が 2 個(`[x, y]`)なら `[x, y]` | つまみ 8 個。四隅 = 縦横比を保つ(x・y に同じ倍率。z は 3D レイヤーのときだけいっしょに動き、2D では元の値のまま)、Shift で自由。辺の中央 = その軸だけ。基準は anchor。反対側へ越えると負(裏返し) |
| `transform.rotation` | `[x, y, z]`(度。いつも 3 個。動くのは z) | 上辺の外の丸いつまみ。anchor を中心に回す。Shift で 15° 刻み。何周でも回せる(360 を超える値も出る) |

- つまみは **1 枚だけ選んでいるとき** に出る(ロックしたレイヤー・カメラには出ない)。再生中は出ない。コンポジションの外(iframe の余白)にはみ出したつまみもつかめる。
- つまみの当たり判定は、マウスでは中心から 10px。指(`pointerType: "touch"`。ペンなどは `pointer: coarse` の機械のとき)では 22px(見た目は同じ)。
  箱の内側では短い辺の 1/4 まで(小さいレイヤーでも、まん中をつかめば移動になる)。指でつかんだときは、つかんだ所とつまみのずれを保つ(つかんだ瞬間に大きさが跳ねない)。
- どの値も 0.1 刻みに丸める。ドラッグ中の値は iframe の中だけの仮の値(`setOverride`)。親が保存して `comp:set` を送り返すと確定する(送り返さなければ仮の値のまま表示が残る)。
- 矢印キーでの移動などは親の仕事(`comp:key` を受けて文書を書き換え、`comp:set` を送る)。
- `comp:key`: ブラウザの既定の動きは、Ctrl / Cmd + S・Z・Y・A・D・G と、修飾なしの Space・矢印・Backspace・Delete・Tab・Home・End だけ止める(それ以外は止めない)。

**`comp:error`**: 素材が読めない・見つからない(`error`。画像・動画・動画のコマ・素材情報・書体・入れ子のコンポジション)、取り込みで `missing` と印を付けたレイヤー(`warn`)、
知らない種類(レイヤー種別・エフェクト・ブレンド・transition・AviUtl スクリプト。`warn`)、レイヤーを描けなかった・エフェクトの失敗・シェーダを作れない・入れ子の循環(`error`)。
`layer_id` は、いちばん上のコンポジションでのレイヤー(入れ子の中の出来事は、それを置いているレイヤー)。分からないときは付かない。
同じ内容(level + layer_id + message)は 1 回だけ、1 秒に 12 件まで(あふれた分は次の機会に「ほかに N 件」の 1 通)。`comp:set` では消えない(文書を読み込み直す `load` で消える)。
エンジンを直接使うときは `new CompEngine(canvas, { onError: ({level, message, layer_id}) => ... })`。

## 文書の読み方(仕様に書いていない所の決め)

v1.1 で足した書式は `docs/composition-design.md` の「v1.1 の追加」に全部書いた。ここは実装の決めだけ。

- レイヤー空間の原点は中身の中心。子の `position` は親のレイヤー空間(= 親の中心が原点)。
- 回転: z は時計回り。x は上が奥へ、y は右が奥へ倒れる向きが正(CSS の rotateX / rotateY と同じ見え方)。掛ける順は X·Y·Z。
- カメラ: `fov` は水平画角。`position` 省略時は既定の位置。`source.target` があれば注視、`rotation` はその上に足す。レイヤーごとに、範囲(`scope`)に入っている表示中のカメラのうち、いちばん上のものが効く。
- マスク(`masks[]`)の座標はレイヤーの箱の左上が原点(シェイプは線の太さを含まない外接矩形、テキストは行の箱)。1 レイヤー 4 個、多角形は 48 頂点まで。エフェクトの列より前に掛かる。
- エフェクトの座標はレイヤーの箱の中心が原点。`crop` のあとは切ったあとの箱。長さは拡大する前のレイヤーの px。
- `stroke_outline`(`outline`)は **箱も広げる**(外側 = 幅ぶん、`position: "center"` = 半分、`"inner"` = 0。形に畳み込んだ縁取りも同じ)。
  あとに続く `crop`・% の切り抜きは、広がったあとの箱から測る(AviUtl の 縁取り → クリッピング と同じ。600×400 + 縁取り 46 + crop 135 → 422×222 が残る)。
- shape の `source.stroke_in_box: true`: 線の外側の縁までを箱にする(既定は線の中心を通る形の外接矩形)。crop・マスク・選択枠の基準が変わるだけで、絵は同じ。
  AviUtl の図形 + ライン幅(線は箱の内側)を取り込むときに使う。
- エフェクト用の RT の解像度は、scale のキーの最大値(親・グループ・offset も含む)から決める(0.25〜4 倍の段)。カメラが寄ったぶんは見ない。
- 1 回の描画に入れられる軽いエフェクトは vec4 で 96 個ぶん・画像は 2 枚まで。超えたぶんは RT に描き出してから続ける(見た目は同じ)。
- `repeat`(エフェクト)のあとに書いた切り抜き・色は、並べた全体の座標で効く。その後にさらに `flip` / `repeat` を書くと、いったん RT に描き出す。
- `per_char.at` はレイヤーの `in` からのコマ。`out` は `{stagger, order, from|to, duration, e, at?}`、`at` 省略時は最後の文字がレイヤーの `out` で消え終わる。
  `rotation` を `[x,y,z]` にすると文字ごとに 3D で回る。`order` は forward / backward / center / edges / random(`seed`)。
- プロパティ値: `{"k":[...], "loop", "wiggle"}` のほか、定数に揺れだけ足す `{"v": 値, "wiggle": {...}}` も可。文字列(text など)のキーは hold 扱い。
- shape: `points` は `[x,y]` / `[x,y,inx,iny,outx,outy]` / `{x,y,in:[dx,dy],out:[dx,dy]}`(原点 = レイヤーの中心)。trim・破線は線だけに効く。
- text: `font` は CSS の並びに直す(`Noto Sans JP` → この機械の `Noto Sans CJK JP`、Serif / Mono も同様)。箱の中心が原点(`valign` を書いたときは align × valign の端)。
  文字ごとアニメ・円周の文字は「範囲の決まらない絵」なので、重いエフェクトは画面空間で掛かる(長さは画面の px)。
- model: `{"asset_id"|"url", "height": px, "light": {"intensity","ambient","color","direction"}}`。常に 3D。
- `motion_blur: true`(16 回)または回数。前後 1/4 コマずつを足し込む。軽いエフェクトは 1 回ごとに、重いエフェクトは足し込んだあとの絵に掛かる。
- `source.url` の `/...` は apiBase からの道として読む。
- **エフェクトは書いた順に掛かる**(`order_test.py`)。軽いエフェクトはシェーダの中でまとめるが、結果は「1 個ずつ順に掛けた絵」と同じ:
  - `flip` / `repeat` のあとに書いた切り抜き・色は、反転・並べた **あと** の絵の座標で効く(反転 → 斜めクリッピングで影を作る、など)。
  - 並べた絵どうしが重なっているときは、1 枚にまとめてから次を掛ける(すき間 0 以上の格子は重ならないので、まとめずに済む)。
  - アルファを足す・読むもの(`invert_alpha`・`border`・`overlay_source` の over / under)は、それまでの切り抜きを済ませてから掛かる。
    効く範囲は「いまの絵の範囲」(レイヤーの箱 + 線の太さ・縁取りのはみ出し。`crop` のあとは切ったあとの箱)の中だけ。
  - RT に描き出すと、完全に透明な画素の色は残らない(乗算済みで持つため)。切り抜き → 重いエフェクト → `invert_alpha` では、切った所は黒く出る。
- `fill` の `keep_luma: true` は、輝度(Y。BT.601)をそのままに色差(Cb・Cr)だけ指定色のものにする(AviUtl の「輝度を保持する」)。`false` は `amount` % のベタ塗り。
  `tint` は別物で、指定色 × 輝度(暗い色を指定すると暗くなる)。
- `overlay_source` の `replace_color` は、素材のアルファに関係なく色を丸ごと置き換える(素材が半透明の PNG でも混ぜない。素材の外・完全に透明な所は元の色のまま)。
- `pattern` の `cols` / `rows`: 升目の数。書くと箱の大きさが `size × 個数` になり、模様の原点が箱の左上に来る(左上の升が `colors[0]`)。`origin: "top_left"` だけでも原点を左上にできる。
- `repeat` の `mode: "random"`: `count` 個を `area_x` × `area_y`(px。中心は元の位置)にばらまく。`seed` が同じなら同じ配置。`random_rotation`(± 度)、`scale_min` `scale_max`(%)。
- `per_char.ranks: [..]` = i 文字目が何番目に出るか(同じ番号は同時)。`per_char.sequence: [..]` = 出る順に文字の番号(0 始まり)を並べたもの。どちらも `order` より優先。
- `blend`: `luminosity`(輝度は上・色は下)、`color`(色は上・輝度は下)、`hue`、`saturation` を足した(W3C の式。重みは 0.3 / 0.59 / 0.11)。
- `vignette_blur`(重い): 周辺へ向かってぼかし + 暗くする。`amount`(暗さ %)`blur`(px)`radius`(効き始め。箱の対角の半分 = 100)`softness` `color_shift`(px。外向きに R・B をずらす)`color` `cx` `cy`。
  `shape: "circle"` = 正円(どの向きにも同じ距離。`radius` `softness` の 100 は同じく対角の半分)。既定の `"box"` は箱の縦横比のだ円。
  `ramp: "linear"` = まっすぐ変わる(既定 `"smooth"` は smoothstep)。`brightness`(%。100 = そのまま)= ぼかした側の明るさ(足し算。110 で +10 %)。
  AviUtl の 周辺ボケ光量 は `shape: "circle", ramp: "linear", amount: 0, brightness: 光量`。
- `clip_line` の `feather_mode: "inside"`: ぼかしを帯の内側だけに付ける(端で 0、内へ `feather` px ぶんを cos カーブで上がる: `t = (幅/2 − |d|) / feather`、`(1 − cos πt) / 2`)。
  AviUtl の斜めクリッピングの帯(幅 > 0)を完成動画で測った形(幅 1000・ぼかし 2000 だと帯のまん中でも 14.6 %)。既定の `"center"` は今までどおり(境目をまん中に、直線)。
  片側(幅 = 0)でも使える(境目で 0、残る側へ上がる)が、AviUtl の片側がこの形かは確かめていない。
- `matte.layers: [id, …]`: マット元が時間で入れ替わるとき(そのコマで表示区間に入っている最初の 1 枚を使う)。`matte.absent: "show"` = マット元がどれも表示区間の外のコマは、切らずに全部見せる
  (既定 `"hide"` = 今までどおり何も見えない)。AviUtl の「上のオブジェクトでクリッピング」(その時刻に上の段にある物で切る。無ければ切らない)。
- comp レイヤーの `source.transparent: true`: 子の背景色(`bg`)を塗らない。子に何も無い所は、親の下のレイヤーが透けて見える。
- `overlay_source` の `anchor: "top_left"`: 箱の左上に素材の左上を合わせた所から `x` `y` だけずらす(AviUtl の画像ファイル合成)。既定は中心どうし。
- `repeat` の円形に `copy_scale`(%)`copy_rotation`(度): 1 個ずつを、置いた位置はそのままに自分の中心で拡大・回転。
  ばらまく(random)に `spin`(度/秒)`drift_x` `drift_y`(px/秒): 1 個ずつ ± その幅の中の決まった速さで回る・流れる(レイヤーの `in` からの時間)。
- 画像・動画・連番の `source.fit`(N px に合わせる。素材の画素数を知らなくてよい): レイヤーの箱の大きさを変えるだけで、`transform.scale` はその上に掛かる(100 % = 合わせた大きさ)。
  エフェクト・マスクの px も合わせたあとの箱で測る。書かなければ今までどおり素材の画素数。
  - `{"width": 600}` = 幅 600 px(高さは縦横比どおり)。`{"height": 400}` = 高さ 400 px。
  - `{"width": 600, "height": 400, "mode": "contain" | "cover" | "stretch"}` = 箱に合わせる。contain(既定)= 収まる最大、cover = 箱を覆い、はみ出しは切る(中央を映す)、stretch = 縦横比を無視。
  - 幅も高さも書かなければ、箱 = コンポジションの大きさ(`{"mode": "cover"}` = 全面を覆う、`{}` = 全体を収める)。数はキーフレームにもできる。
  - `source.cutout_of`(数)は編集画面の「✂ 背景を消す」が書く控え(切り抜く前の素材の番号)。エンジンは読まない。
- `trace_outline` の破線: `dash_period`(1 周に対する %)`dash_gap`(すき間 %)。`fract(t / 周期) × 周期 <= 周期 − すき間` の所だけ描く。周期 0・すき間 0 = 実線。
  t は、このエフェクトの `progress` と同じ「中心まわりの角度」(輪郭の道のりではない。円に近い形なら道のりとほぼ同じ、でこぼこの形ではずれる)。
- テキストの `on_circle.deg_per_px`(`arc.deg_per_px` も同じ): 角度 = `rotation` + 文字の横位置 px × これ(度)。書かなければ今までどおり 字幅 ÷ 半径。
  AviUtl の円形配置(文字毎に個別)は `円周 % × 72 / (文字数 × 画面幅)`。`arc`(等間隔に配る範囲)を書いたときはそちらが優先。
- 重いエフェクトのあとの `flip` / `repeat`: 範囲の決まるレイヤー(画像・単色・シェイプ・入れ子など)なら、画面より大きくても効く(レイヤーの RT のまま続ける)。
  使えないのは、範囲の決まらない絵(粒子・文字ごとアニメ・モデル)に重いエフェクトを掛けたあとだけ(警告が出る)。

## 仕様との差・できていないこと

- 3D レイヤー同士の交差は扱わない(塊の中を anchor の奥行きで並べるだけ)。大きな床のような面は並びが崩れる。
- 被写界深度はレイヤー 1 枚ごとの一様なぼかし(1 枚の中での奥行きの差・複製 1 個ずつの差は見ない)。
- 文字・シェイプのテクスチャは scale のキーの最大値に合わせて最大 4 倍で作る。3D でカメラが寄ったぶんは見ないのでぼける。
- `trace_outline` は輪郭を順にたどらない(輪郭の帯を、中心まわりの角度で見せていく近似)。破線(`dash_period`)も同じ角度で刻む。
- `threshold` の自動判定(その時の絵から大津の方法でしきい値を決める)は無い(ENGINE_ISSUES R-3。絵を読み戻す必要があり、プレビューと書き出しで値がずれうるので見送り)。
- `chroma_key` は RGB から求めた色相・彩度で判定する(AviUtl の YC48 とは境目が少し違う)。合成も RGB(YC48 の乗算・スクリーンとは少し違う)。
- 縦書きの字形は Canvas2D で回す・寄せるだけ(書体の縦書き用の字形は使わない)。ルビなし。
- グループの effects は対象の 1 枚ずつに掛かる(グループ全体を 1 枚にまとめてから掛けることはしない)。
- マットは 1 段(マットのマットは不可)。調整レイヤーにマットは効かない。
- `repeater.time_offset` で中身まで時刻をずらすのは 64 個まで(それより多いと変形・不透明度だけ)。
- プレビューの動画は `<video>` のシークなのでコマ単位では甘い(書き出しは 1 コマずつの画像で正確)。capture の動画で `speed` が 1 でないときは最近傍のコマ。
- model は GLB の見た目を出すだけ(アニメーション・環境マップなし)。
- プレビュー(実 GPU)と書き出し(SwiftShader)は同じコードだが、GPU が違うので 1 階調ほどの差はありうる。同じ GL なら 1 バイトも違わない。
- コンポジションの中の音・エクスプレッションは無い(仕様どおり)。
