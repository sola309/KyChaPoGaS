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
