# 004 ポップアート歌詞モンタージュ（★本作に最も近い）

- 提供: ユーザー(2026-08-22)
- 出所: https://x.com/manaimovie/status/2083452257992143357
- 尺: 15秒 / 約1,900字 / **20ショット**(≒0.75秒/ショット)
- 形式: 003と同じ `SCENE / SHOT BREAKDOWN / CAMERA / LIGHTING & PALETTE / AUDIO / AVOID`

**4件の中で唯一「歌詞に合わせた高速モンタージュ」**= 本作(MAD)と同じ構造。最重要の参考。

## 原文（改変せず保存）

```
Duration: 15 seconds | Aspect ratio: 16:9 | Style: Anime pop-art illustration, graphic design aesthetic with halftone shading and kinetic typography

SCENE
Anime schoolgirls (tan blazers, black plaid skirts, thigh-high socks, berets, diverse hair colors). Graphic urban transit settings including bus stops, crosswalks, and vivid on-screen text blocks.

SHOT BREAKDOWN
0-4s — Brown-haired girl applies makeup ("Lip gloss, bus stop"). Pink-haired girl by a clock ("Tick-tock, don't stop"). Silver-haired girl holds a drink ("Ice cup, touch down"). Brown-haired girl with headphones ("Headphones, downtown"). Pink-haired girl on a dark bus ("Late text, heartbeat").
4-8s — Silver-haired girl crosses street ("Two steps, same street"). Brown-haired girl shields eyes ("Flashback, Flash light"). Pink-haired girl poses ("You look so right"). Silver-haired girl runs ("Maybe we're running"). Brown-haired girl jumps ("Maybe we're flying").
8-12s — Pink-haired girl by a sign ("No need explaining"). Silver-haired girl on a bench ("We're just vibing"). Brown-haired girl slides ("Slide, glide"). Pink-haired girl reaches forward ("Meet me on the bright side"). Silver-haired girl under spotlights ("Slow lights").
12-15s — Brown-haired girl rests on a bench ("Everything feels"). Pink-haired girl by a transit sign ("High tide"). Silver-haired girl looks through a ring ("Keep me in your eyesight"). Brown-haired girl walks ("Good vibe"). Trio poses together at night ("Play it back all night").

CAMERA
Fast-paced montage. Static framing with 2D perspective. Rapid rhythmic cuts between graphic poses.

LIGHTING & PALETTE
Flat graphic lighting, stylized halftone dot shadows. Retro color palette: mustard yellow, navy blue, burnt orange, pale teal, dusk purple.

AUDIO
Upbeat J-pop or rhythmic electronic track. No dialogue.

AVOID
Photorealism, 3D rendering, complex gradients, cinematic depth of field, illegible text.
```

## ★★ 1ショット = 8語

```
Brown-haired girl applies makeup ("Lip gloss, bus stop").
Pink-haired girl by a clock ("Tick-tock, don't stop").
```

**20ショットを約900字で書き切っている**(1ショット45字)。本作は1ショットに段落を割いていた。
高速カットのMADで多数のカットを指定するには、この密度でなければ全部は入らない。

型: `[誰が] [何をする] ("[その瞬間の歌詞]")`

## ★★ キャラは「2語のハンドル」で呼ぶ

`Brown-haired girl` / `Pink-haired girl` / `Silver-haired girl` を**毎ショット反復**している。
外見の定義は SCENE で1回だけ。

本作は「Identity lockは登場ごとに反復」という結論を実測で得ていたが、
**反復する対象を「全身の記述」だと思い込んでいた**。正解は
**2語の識別子を反復すること**。定義は1回でよい。

本作への翻訳:
- SCENE で1回: 「まどか=桃のツインテール、ほむら=黒の長髪と羽、さやか=青髪で片目と口に包帯、
  杏子=紅の長いポニーテール、マミ=金の縦ロール、なぎさ=白髪の小さな子」
- 各ショットは `the pink-twintailed girl` `the winged black-haired woman` `the bandaged blue-haired girl` で呼ぶ

参照画像に公式設定画を渡しているのだから、外見の再説明は不要。
公式R2V注記「参照画像のタグと正確に一致させるのが最良」とも一致する。

## ★ 高速カットのときカメラは止める

> CAMERA: Fast-paced montage. **Static framing** with 2D perspective. Rapid rhythmic cuts between graphic poses.

速いモンタージュでは**フレーミングを固定**し、リズムは**カットが担う**と明示している。

本作は「速いカット」と「カメラも激しく動かす」を同時に要求していた。両者は競合する。
実測の N4(静止4+暴力3 が着地一致93%、常時動くN1/N3は5割)とも符合する。
**動かすなら止める場所を作る。速く切るならカメラは止める。**

## ★ 歌詞をショットに紐づける

各ショットに歌詞の断片が括弧で添えられている。004は kinetic typography として
**文字を画面に出す**が、**本作では文字は禁止**なので、歌詞は
「そのショットが何を意味するか」を決める**内部の指示**として使う(画面には出さない)。

本作のピンには既に `attrs_json.lyrics` が入っているので、そのまま流用できる。

## AVOID

```
Photorealism, 3D rendering, complex gradients, cinematic depth of field, illegible text.
```
5つとも様式・カテゴリの否定。003と同じく**内容否定ゼロ**。
`complex gradients` `cinematic depth of field` はセル画らしさを守る指定として本作でも有効。
