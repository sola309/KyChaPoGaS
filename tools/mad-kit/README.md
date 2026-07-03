# mad-kit — 宣言的MADビルダー

ショットリスト(JSON)から音ハメMAD動画を組み上げるキット。
**編集するのは shotlist.json だけ**(コードを触らずに作品を変えられる = 軽量LLM対応の中核)。

## 使い方

```bash
PY=repo/backend/.venv/bin/python
$PY repo/tools/mad-kit/build.py check  --project <dir> --shotlist shotlist.json  # 検証のみ
$PY repo/tools/mad-kit/build.py render --project <dir> --shotlist shotlist.json  # 640x360@12 QA
$PY repo/tools/mad-kit/build.py final  --project <dir> --shotlist shotlist.json  # 1080p60+音+検証
```

project dir 必須構成: `assets/`(png=透過素材, jpg=全面絵)・`beatgrid.json`(bpm/beats/downbeats)・音源。

## shotlist の書き方

```json
{ "meta": { "title": "...", "music": "music/song.wav", "end_sec": 101.0 },
  "shots": [
    { "id": "任意", "template": "テンプレ名", "from": "db:12", "to": "db:14",
      "transition": "bandwipe|flash(省略可)", "params": { ... } } ] }
```

- 時刻は `"db:12"`(12小節目のdownbeat) or 秒数。**カットは必ずdownbeatに置く**と音ハメが保証される。
- `params.asset` 等の素材名は assets/ のファイル名(拡張子なし)。

## テンプレート一覧(params 概要)

| template | 用途 | 主要params |
|---|---|---|
| mg_intro | フラットMGイントロ | chibis[], credit, pieText |
| title_card | タイトルカード | bg, title1, title2, subtitle |
| showcase_pattern | パターン背景+切り抜き | bg(argyle/stripes/dots/checks/plaid/beige/soft/winter/solid), subject{asset,x,y,h,enter}, subjects[], ornaments[], ambient |
| showcase_card | 傾きカード+縦タイポ | asset, x,y,w,h, rot, title, titleX/Y, titleVertical, sub, stickers[], ambient |
| showcase_fullbleed | 全面絵+punch-in | asset, badge, speedlines, corners, vignette |
| panels_strip | 縦3面パネル | panels[{asset,bg,label,h}] |
| bands_repeat | 4段色違い帯 | asset |
| cv_card | 名前カード | asset, name1, name2, kanji, chips[], foot |
| rapid_cuts | 半小節高速カット | arts[], labels[] |
| riser | ビルドアップ | asset |
| mg_peak | サビMG(円→バッジ→リボン) | from, fromBar, badgeText, ribbonText, runners[] |
| profile_card | PERSONAL DATA風 | asset, name1/2, kanji, chips[], rows[[k,v]] |
| breakdown_pan | 静パート・スローパン | art1, art2, credit[] |
| finale_cuts | downbeat毎の大画替え | arts[], fromBar, cornerChibis[] |
| lineup | 全衣装ラインナップ | assets[], tags[]/tag, title |
| outro_credits | 最終カード+アイリス | thumbs[], title, year, credits[], thanks, end |

## モーション部品(paramsで指定可能)

- enter: `rise_pop, pop, slide_l/r/u/d, drop_bounce, spin_in, fade_zoom, tilt_in`
- ambient: `{kind: floaters|confetti|petals|sparkles|snow, n, set:[apple|pocky|heart|star|note]}`
- 省略時は自動: subjectはbreath+sway、ornamentはbob+sway、シーンにはfloaters層とKen Burnsが必ず付く
  (「止まっている物を作らない」ための既定値)

## 品質規約

- カット/ポップは beatgrid の beats/downbeats に必ずスナップ(kit側で保証)
- 書き出しは crf16 単一パス、音声は atrim+afade で終端処理
- `final` は書き出し後にカット/ビート一致率を自動計測して表示

## 解析メニュー (analyze.py)

`analyze.py --list` でも一覧可能。結果は **shot_id 単位**で出るため、ショットエディタ/AI指示にそのまま使える。

| 解析 | 内容 | 検出フラグ |
|---|---|---|
| beat_align | カットとビートの一致率(±50/±100ms)+ズレたカットの列挙 | — |
| motion | フレーム差分エネルギー。静止区間を検出 | STATIC(1.2s以上停止) |
| density | エッジ密度+カラフルネス | LONELY(要素が少なく寂しい) |
| palette | 明度・彩度の統計 | DARK / DULL(くすみ) |
| av_energy | 音楽RMS×映像モーションの相関 | AV_MISMATCH(音>画) |

```bash
$PY repo/tools/mad-kit/analyze.py --video <mp4> --project <dir> --shotlist shotlist.json
# → <project>/analysis/analysis.md (人間/LLM向け) + analysis.json (機械向け)
```

将来追加候補: 文字可読性 / 顔検出による構図評価 / 素材重複検出 / VLMによる内容記述。

## parallax_scene — マルチプレーンカメラ (2026-07 追加)

疑似3Dカメラ。レイヤを奥行き(depth)に配置し、仮想カメラの移動で視差を生む。
depth>0=奥 / 0=主役面 / depth<0=カメラ手前。静止時の見た目はdepth 0と同じ(WYSIWYG)。

- `camera`: プリセット名 or キーフレーム配列 `[{at:0..1|"db:N", x,y,z,yaw,pitch,roll,ease}]`
  - プリセット: `dolly_in` `dolly_out` `pan_l` `pan_r` `crane_up` `crane_down` `orbit` `pass_through` `push_beat` `still`
- `bg`: `{asset}` or `{asset, video:true}` or `{pattern, color}`(最奥、自動で112%オーバースキャン)
- `layers`: 中景 `[{asset, depth:420, x,y,h, video?, idles?}]`
- `subjects`/`subject`: 主役(showcase系と同じ座標感覚、enter/idle/db強調は自動)
- `fg`: 前景 `[{asset, depth:-240, x,y,h}]` — 通り抜け感の主成分
- `ornaments`: nameplate/pill/chibi/テキスト(depth指定可)
- `sway:false` で手持ち風微揺れOFF、`dbKick:false` で小節頭のZパンチOFF
- 粒子は自動で2深度(奥+手前)に分かれて視差する

他テンプレでも `MK.cameraRig(root, {camera:'orbit'})` で同じリグを使える。
