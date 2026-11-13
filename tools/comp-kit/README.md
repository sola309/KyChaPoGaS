# comp-kit — コンポジションの描画エンジン

`docs/composition-design.md` のコンポジション文書を描く。three.js r180(`tools/mg-libs`)だけに依存し、ビルドは不要。
プレビュー(iframe)も書き出し(`motion_graphics.render_html_to_video` の決定論キャプチャ)も同じコードで描く。

## ファイル

| ファイル | 役目 |
|---|---|
| `comp-engine.js` | 入口。`CompEngine`(load / renderFrame / update / pick / layerBounds / dispose) |
| `scene.js` | 1 つの文書を描く本体(変形・カメラ・描く順・マスク・マット・ブレンド・調整レイヤー・入れ子・選択) |
| `props.js` | プロパティ値(キーフレーム・イージング・loop・wiggle)、決定論の乱数、色 |
| `gfx.js` | RT の使い回し、全画面パス、四角形のまとめ描き、レイヤー用シェーダ(縁 AA・マスク) |
| `effects.js` | エフェクト(blur / glow / color / rgb_shift / wave / noise / mosaic / wipe / drop_shadow / stroke_outline) |
| `text.js` `shape.js` `particles.js` `model.js` | 種別ごとの中身(Canvas2D のラスタライズ、粒子の式、GLB) |
| `assets.js` | 画像・動画・素材情報の読み込み |
| `player.html` | iframe / キャプチャ用のページ。`/*__COMP_BOOT__*/` を `window.__COMP_BOOT = {...};` に置き換えて使う |
| `examples/*.json` | 例(01 文字アニメ / 02 シェイプ・親子・ブレンド / 03 3D カメラ / 04 マスク・マット・エフェクト / 05 粒子・調整 / 06 入れ子) |
| `test/render_test.py` | 単体の描画テスト |

配信は `comp-kit` と `mg-libs` を同じ URL(`/api/comps/engine/`)に平らに並べる。
- どの応答にも `Access-Control-Allow-Origin: *` が要る(キャプチャのページは `set_content` で作るのでオリジンが無い。モジュール・画像・動画のコマすべて CORS 扱い)。
- `.js` は `text/javascript` で返す。動画ファイルは Range(206)に対応していること。
- model レイヤーは `GLTFLoader.js` を後から読む。`'three'` の import map は player.html が自分で入れる。

## テスト

```sh
PY=repo/backend/.venv/bin/python
$PY tools/comp-kit/test/render_test.py examples/01_kinetic_type.json --frames 0,12,48 --out /tmp/x
$PY tools/comp-kit/test/render_test.py examples/03_camera_3d.json --video /tmp/x/cam.mp4     # bg が null なら .mov(アルファつき)
$PY tools/comp-kit/test/render_test.py examples/04_mask_matte_fx.json --frames 40 --mode preview   # プレビュー経路(同じ絵になる)
$PY tools/comp-kit/test/render_test.py examples/06_nested.json --serve     # サーバだけ立てて URL を出す(手で見る用)
```

テスト用サーバは空きポートで立ち、`/api/comps/<id>` は examples の JSON、`/api/comps/vframe/..` は ffmpeg の切り出し、
`/api/assets/..` は本番(8002)への GET の中継で代用する。

## player.html

boot: `{ comp:{id,name,width,height,fps,duration_frames,data}, mode:'preview'|'capture', apiBase, engineBase:'/api/comps/engine/' }`

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

iframe → 親

| type | 中身 |
|---|---|
| `comp:ready` | `{width,height,fps,duration_frames,frame}` |
| `comp:frame` | `{frame}` 再生中 |
| `comp:select` | `{ids}` クリックで選択(Shift で追加・解除、何もない所 = `[]`) |
| `comp:edit` | `{id, path:'transform.position', value, final}` ドラッグで移動。position がキーフレームなら `keyframed:true, frame` がつき、value はそのコマでの値 |

ドラッグ中の値は iframe の中だけの仮の値。親が保存して `comp:set` を送り返すと確定する。

## 文書の読み方(仕様に書いていない所の決め)

- レイヤー空間の原点は中身の中心。子の `position` は親のレイヤー空間(= 親の中心が原点)。
- 回転: z は時計回り。x は上が奥へ、y は右が奥へ倒れる向きが正(CSS の rotateX / rotateY と同じ見え方)。掛ける順は X·Y·Z。
- カメラ: `fov` は水平画角。`position` 省略時は既定の位置。`source.target` があれば注視、`rotation` はその上に足す。有効なのはいちばん上の表示中のカメラ。
- マスクの座標はレイヤーの箱の左上が原点(シェイプは線の太さを含まない外接矩形、テキストは行の箱)。1 レイヤー 4 個、多角形は 24 頂点まで。
- エフェクトは変形のあとの画面空間で掛ける(長さは px、角度は 0° = 上・時計回り)。`wipe` の範囲はレイヤーの画面上の外接矩形。
- `per_char.at` はレイヤーの `in` からのコマ。`out` は `{stagger, order, from|to, duration, e, at?}`、`at` 省略時は最後の文字がレイヤーの `out` で消え終わる。
  `rotation` を `[x,y,z]` にすると文字ごとに 3D で回る。`order` は forward / backward / center / edges / random(`seed`)。
- プロパティ値: `{"k":[...], "loop", "wiggle"}` のほか、定数に揺れだけ足す `{"v": 値, "wiggle": {...}}` も可。文字列(text など)のキーは hold 扱い。
- shape: `points` は `[x,y]` / `[x,y,inx,iny,outx,outy]` / `{x,y,in:[dx,dy],out:[dx,dy]}`(原点 = レイヤーの中心)。`cap` `join` `trim_offset`、
  `fill: {"gradient": {"type":"linear"|"radial","from":[x,y],"to":[x,y],"radius","stops":[[0,"#.."],..]}}`。trim は線だけに効く。
- text: `font` は CSS の並びに直す(`Noto Sans JP` → この機械の `Noto Sans CJK JP`、Serif / Mono も同様)。`italic` `stroke_over`。箱の中心が原点。
- particles の `emitter`: `position`(生まれた時刻の値を使う)`area` `rate` `burst` `life` `life_random` `speed` `speed_random` `direction` `spread`
  `z_speed` `gravity` `drag` `size:[始,終]` `size_random` `color:[始,終]` `opacity:[始,終]` `spin` `sprite`(soft/circle/square/star/spark) `blend`(add/normal)。
- model: `{"asset_id"|"url", "height": px, "light": {"intensity","ambient","color","direction"}}`。常に 3D。
- `motion_blur: true`(16 回)または回数。前後 1/4 コマずつを足し込む。
- `source.url` の `/...` は apiBase からの道として読む。

## 仕様との差・できていないこと

- 3D レイヤー同士の交差は扱わない(塊の中を anchor の奥行きで並べるだけ)。大きな床のような面は並びが崩れる。
- エフェクトは画面空間。AE のようにレイヤー空間では掛けない(拡大・回転についてこない)。
- 文字・シェイプのテクスチャは scale のキーの最大値に合わせて最大 4 倍で作る。3D でカメラが寄ったぶんは見ないのでぼける。
- テキスト: 縦書き・箱組み・折り返しなし。行送り・字間・左右中央そろえのみ。塗りのグラデーションなし。
- マスクはパス(ベジェ)なし。マットは 1 段(マットのマットは不可)。調整レイヤーにマットは効かない。
- プレビューの動画は `<video>` のシークなのでコマ単位では甘い(書き出しは 1 コマずつの画像で正確)。capture の動画で `speed` が 1 でないときは最近傍のコマ。
- model は GLB の見た目を出すだけ(アニメーション・環境マップなし)。本番の素材では未確認(Duck.glb で確認)。
- プレビュー(実 GPU)と書き出し(SwiftShader)は同じコードだが、GPU が違うので 1 階調ほどの差はありうる。同じ GL なら 1 バイトも違わない。
- コンポジションの中の音・エクスプレッションは無い(仕様どおり)。
