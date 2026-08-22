# 005 フォーリー同期ノワール・シルエット（★結論を修正させた例）

- 提供: ユーザー(2026-08-22)
- 出所: https://x.com/renataro9/status/2090573248752934994
- 尺: 15秒 / **約5,500字** ← 他の4件(1,504〜2,969字)より**明確に長い**
- 形式: H3の `integrated_multimodal_description` + `overall_soundscape` + `non_diegetic_music`。
  本文は `[Shot 1]〜[Shot 6]` + 大文字の法則ブロック4つ(FOLEY-SYNC LAW / MOTION SYSTEM /
  SILHOUETTE RULES / NO-TEXT RULE)

## ⚠ この例は「短いほど良い」を単純には支持しない

001-004から「15秒に1,500〜3,000字」と結論しかけたが、005は**その倍近く**あり、
しかも**ミリ秒のタイムスタンプを使っている**。

だが中身を見ると矛盾しない。**長さの使い道が違う。**

| | 本作の失敗版(20,671字) | 005(約5,500字) |
|---|---|---|
| 文字数の主な用途 | **状態の描写**とミリ秒打点40本 | **法則(ルール)**と技法語彙 |
| タイムスタンプ | ショット内のイベントに多数 | **ショットの開始のみ6個**(=2.5秒に1個) |
| 音との対応 | 時刻で個別指定 | **法則を1ブロックで宣言** |

本作の実測「`[Shot N] At` のカットは2-3ショットなら0.2-1.2f精度、詰め込むと消える」とも整合する。
005のタイムスタンプは**ショット境界にしか使われていない**。

**修正した結論: 制約は文字数ではなく「状態の描写に使う量」。ルールと技法語彙になら長く使ってよい。**

## ★★ FOLEY-SYNC LAW — 因果を「法」として宣言する

```
FOLEY-SYNC LAW: Every major visual change begins on the exact transient of a visible sound.
Lighter creates line and portrait; footsteps build architecture; metal clicks move masks;
casing creates rings; umbrella creates wedges; impacts change poses; chimes create squares;
landing creates freeze; engine accelerates layers; lighter close ends the film.
Never drift. Use two-to-four-frame anticipation, contact on the transient and
immediate follow-through.
```

ユーザー仮説「イベント発生ルールを固定する」の完成形。しかも:

- **`A creates B` を9個並べた対応表**を1ブロックに集約している
- **アニメーションのタイミング原則そのものを指定**している
  (2〜4フレームの予備動作 → トランジェントで接触 → 即座に追従)。本作は「anticipation →
  解放 → overshoot」を散文で各所に書いていたが、**1回、数値付きで宣言**すればよい

## ★★ 最大の発見 — 音を「画面内の物」から出す

> Every major visual change begins on the exact transient of a **visible sound**.

005の音は全て**画面内の物体が出す音**(ライターの火打ち、足音、薬莢の落下、傘の開閉、
チャイム、エンジン)。**H3は映像と音を同時生成する**ので、音源が画面に映っていれば
モデルは自然に同期できる。

**本作はここを外していた。** H3の生成音を捨てて、外部の楽曲に合わせようとしていた。
モデルから見れば「聞こえていない音」に合わせろと言われている状態で、打点指定が
偶然と同水準だったのは当然だった。

→ 本作への翻訳: **画面内の出来事が音を出すように書く**(槍の節が鳴る/銃床が砂を叩く/
羽根が裂ける/泡が割れる)。モデルはその音に合わせて動きを組む。**その結果できた
リズムを、⏱時間リマップで楽曲に合わせる。** これが正しい二段構え。

## ★ MOTION SYSTEM — 技法を実名で並べる

```
Professional After Effects-style kinetic motion graphics using track mattes, shape layers,
parented rotations, time remapping, posterized frame stepping, silhouette echo trails,
directional blur, impact frames, counter-motion and hard occlusion.
Movement is decisive and causal.
No slow zoom, slow pan, idle hold except the intentional half-beat freeze, slideshow,
floating cards, soft crossfade, random particles or decorative motion unrelated to sound.
```

- 実在のAE技法名で語彙を与えている(本作の「実在物体でトランジションを書く」の別解)
- **`Movement is decisive and causal.`** — 動きの性格を1文で決める
- 否定は全て**技法カテゴリ**の否定。特に `decorative motion unrelated to sound` は
  「音と無関係な飾りの動き」を封じる強い一撃

## ★ SILHOUETTE RULES — 顔を出さずに人物を識別させる

> Never reveal faces, skin or internal costume detail.
> **Identify characters through outline, posture and props.**

顔を捨てる代わりに**輪郭・姿勢・持ち物**で識別させると明言している。
本作は逆に顔の再現に苦しんでいるが、**シルエットで見せる区間**を意図的に作れば
その区間は破綻しない。武器(槍/マスケット/角笛/弓/盾)は全員シルエットで判別可能。

## ★ NO-TEXT RULE — 文字禁止の完全な書き方

```
NO-TEXT RULE: Show no letters, words, numbers, logos, credits, captions, subtitles, signs,
license plates, interface labels, pseudo-writing or watermark. All surfaces remain unmarked.
```

ユーザーの「文字は使わない主義」を実装する決定版。**専用ブロックを立てて列挙し尽くす**。
`pseudo-writing`(文字のような模様)まで潰しているのが効きそう。カテゴリ否定なので安全側。

## その他

- **半拍の完全静止**: `a two-frame white impact flash followed by a half-beat of total visual
  stillness and near silence` — 着地の作り方。本作の実測「着地=減速の谷が観客の感じる点」と一致
- **6フレームの逆再生**: `motion reverses for six frames: rain rises, arcs rewind` — 具体的な
  フレーム数で指定された時間操作
- **音楽は編成の積み上げ順で書く**: 「薬莢が跳ねるたびに1層足す: ウッドベース→リムショット
  →ジャズギター」。本作は生成音を捨てるが、**音楽の起伏を書くと映像の緩急に効く**可能性がある
- `[Shot N]` は6個で15秒 = 1ショット2.5秒。本作のカット(中央値4.3秒)なら1〜2個が妥当
