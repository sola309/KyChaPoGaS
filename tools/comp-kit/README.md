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
| `test/check_test.py` | 数値の約束(50% 赤・画像 100%・決定論・プレビュー = 書き出し) |
| `test/schema_test.py` | schema.json の全項目がエンジンで通るか(警告なしで描けるか・値を変えると絵が変わるか) |

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
| 04 mask_matte_fx | マスク・マット・エフェクト | 18 | 47 | 53 |
| 05 particles_adjustment | 粒子・調整レイヤー | 8 | 78 | 82 |
| 06 nested | 入れ子 | 6 | 137 | 170 |
| 07 patterns | 模様 20 種(流れるものも) | 41 | 21 | 26 |
| 08 repeater_shapes | 複製(500 個を 1 回の描画)・シェイプの形 | 40 | 36 | 39 |
| 09 transitions | 登場・退場 10 種 | 30 | 32 | 57 |
| 10 text | 縦書き・カウンター・runs・タイプライター・座布団・円周 | 14 | 34 | 45 |
| 11 character_card | 参考作品ふうのキャラ紹介(斜めクリッピングの帯・網点・名札) | 19 | 88 | 98 |
| 12 petals_3d_dof | 3D の花びら 5 層 + 被写界深度 | 11 | 186 | 203 |
| 13 title_sequence | 19 秒・151 層(同時に 40〜60 層)。矢じりの列 48 枚、名札、3D の札 36 枚 + 被写界深度、扇の切り替え | 151 | 133 | 277 |

速さの勘どころ:
- 切る・色・位置の足し算だけのレイヤーは RT を使わず 1 回の描画で済む(13 の矢じり 48 枚で 25 ms ほど)。
- 重いエフェクトは 1 個につきパス 1〜6 回。RT の大きさ(= レイヤーの箱 × 拡大率)に比例する。太い縁取り・大きなぼかしは縮小して掛ける。
- 被写界深度は 3D レイヤー 1 枚ごとにぼかしを掛けるので、枚数に比例して重い(12・13 の後半)。粒子は画面大の RT になる。
- 入れ子は子を画面大の RT に描く(06)。同じ子を別の時刻で 2 回置くと 2 回描く。

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
| `comp:select` | `{ids:[...]}` 選択枠を出す |
| `comp:invalidate` | `{comp_id}` 入れ子の子を読み直す(追加) |
| `comp:quality` | `{scale}` 描く解像度の倍率。0 で自動(追加) |
| `comp:fonts` | `{fonts}` 書体を足して描き直す(追加) |

iframe → 親

| type | 中身 |
|---|---|
| `comp:ready` | `{width,height,fps,duration_frames,frame}` |
| `comp:frame` | `{frame}` 再生中 |
| `comp:select` | `{ids}` クリックで選択(Shift で追加・解除、何もない所 = `[]`) |
| `comp:edit` | `{id, path:'transform.position', value, final}` ドラッグで移動。position がキーフレームなら `keyframed:true, frame` がつき、value はそのコマでの値 |

ドラッグ中の値は iframe の中だけの仮の値。親が保存して `comp:set` を送り返すと確定する。

## 文書の読み方(仕様に書いていない所の決め)

v1.1 で足した書式は `docs/composition-design.md` の「v1.1 の追加」に全部書いた。ここは実装の決めだけ。

- レイヤー空間の原点は中身の中心。子の `position` は親のレイヤー空間(= 親の中心が原点)。
- 回転: z は時計回り。x は上が奥へ、y は右が奥へ倒れる向きが正(CSS の rotateX / rotateY と同じ見え方)。掛ける順は X·Y·Z。
- カメラ: `fov` は水平画角。`position` 省略時は既定の位置。`source.target` があれば注視、`rotation` はその上に足す。レイヤーごとに、範囲(`scope`)に入っている表示中のカメラのうち、いちばん上のものが効く。
- マスク(`masks[]`)の座標はレイヤーの箱の左上が原点(シェイプは線の太さを含まない外接矩形、テキストは行の箱)。1 レイヤー 4 個、多角形は 48 頂点まで。エフェクトの列より前に掛かる。
- エフェクトの座標はレイヤーの箱の中心が原点。`crop` のあとは切ったあとの箱。長さは拡大する前のレイヤーの px。
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

## 仕様との差・できていないこと

- 3D レイヤー同士の交差は扱わない(塊の中を anchor の奥行きで並べるだけ)。大きな床のような面は並びが崩れる。
- 被写界深度はレイヤー 1 枚ごとの一様なぼかし(1 枚の中での奥行きの差・複製 1 個ずつの差は見ない)。
- 文字・シェイプのテクスチャは scale のキーの最大値に合わせて最大 4 倍で作る。3D でカメラが寄ったぶんは見ないのでぼける。
- `trace_outline` は輪郭を順にたどらない(輪郭の帯を、中心まわりの角度で見せていく近似)。
- `chroma_key` は RGB から求めた色相・彩度で判定する(AviUtl の YC48 とは境目が少し違う)。合成も RGB(YC48 の乗算・スクリーンとは少し違う)。
- 縦書きの字形は Canvas2D で回す・寄せるだけ(書体の縦書き用の字形は使わない)。ルビなし。
- グループの effects は対象の 1 枚ずつに掛かる(グループ全体を 1 枚にまとめてから掛けることはしない)。
- マットは 1 段(マットのマットは不可)。調整レイヤーにマットは効かない。
- `repeater.time_offset` で中身まで時刻をずらすのは 64 個まで(それより多いと変形・不透明度だけ)。
- プレビューの動画は `<video>` のシークなのでコマ単位では甘い(書き出しは 1 コマずつの画像で正確)。capture の動画で `speed` が 1 でないときは最近傍のコマ。
- model は GLB の見た目を出すだけ(アニメーション・環境マップなし)。
- プレビュー(実 GPU)と書き出し(SwiftShader)は同じコードだが、GPU が違うので 1 階調ほどの差はありうる。同じ GL なら 1 バイトも違わない。
- コンポジションの中の音・エクスプレッションは無い(仕様どおり)。
