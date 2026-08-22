# 003 狩人と白獣（2Dアニメ・アクション）

- 提供: ユーザー(2026-08-22)
- 出所: https://x.com/akakuma0219/status/2082796505417801823
- 尺: 15秒 / **約1,300字** ← 3件中もっとも短い
- 形式: 大文字ベタのセクション名 `SCENE / SHOT BREAKDOWN / CAMERA / LIGHTING & PALETTE / AUDIO / AVOID`

## 原文（改変せず保存）

```
Duration: 15 seconds | Aspect ratio: 16:9 | Style: 2D anime fantasy, detailed cel-shaded animation

SCENE
Tribal huntress with fiery red-orange hair, bone necklace, fur-trimmed bracers, and strapped sandals. Massive white feline beast with backward-curving ridged horns and golden eyes. Dense, mossy ancient forest with thick branches.

SHOT BREAKDOWN
0-4s — High-angle. Huntress crouches silently on a thick tree branch, gripping a vine. The giant white beast prowls directly beneath her.
4-8s — Low-angle extreme close-up of a massive clawed paw stomping down, kicking up dirt. Cut to beast looking up as huntress clings to the tree trunk.
8-12s — Profile shot. Huntress drops onto a lower branch facing the creature. Mid-air action shot as she leaps aggressively toward its face, hair and clothing whipping in the wind.
12-15s — Top-down bird's-eye view. Huntress lands in the dirt clearing directly before the beast. A circular shockwave of dust ripples outward from her impact.

CAMERA
Dynamic anime framing. Mix of high-angle establishing shots, extreme low-angle close-ups, and mid-air tracking. Fast, rhythmic action cuts. 

LIGHTING & PALETTE
Dappled sunlight filtering through canopy. High-contrast shadows. Deep forest greens, fiery orange, bone white, and earthy browns.

AUDIO
Forest ambience, heavy thudding footsteps, rustling foliage, dramatic orchestral action music, sharp impact boom upon landing.

AVOID
Photorealism, 3D render style, modern elements, on-screen text, sluggish pacing.
```

## ★ 各ブロックを「ショットの種類」で始める

```
0-4s  — High-angle. …
4-8s  — Low-angle extreme close-up of …
8-12s — Profile shot. …
12-15s— Top-down bird's-eye view. …
```

**時刻ブロックの冒頭が必ずカメラの呼び名**になっている。本作は「何が起きるか」を散文で書き、
カメラは動きの説明(「ゆっくり押す」「180度ロールする」)にしていた。実測ではロールは1度も出ていない。

**ショットの種類は名前で呼ぶほうが通る**可能性が高い。ハイアングル/ローアングル/俯瞰/
プロフィール/エクストリームクローズアップ は、モデルが確実に知っている語彙。

## ★ 着地を「物体の出来事」として書く

> A **circular shockwave of dust** ripples outward from her impact.

本作の実測で「観客が感じるのは減速の谷=着地」と結論づけたが、それを
**カメラや timing の指示**として書こうとしていた。003は**土煙の輪**という物体で書いている。
トランジションを技法名でなく実在物体で書く、という既存ルールと同じ原理が着地にも効く。

## ★ グローバル方針とショット別指定を分ける

`CAMERA` セクションで全体の方針を1回(「ダイナミックなアニメの構図。ハイアングルの
説明ショット、極端なローアングルの寄り、空中トラッキングの混合。速くリズミカルなカット」)、
その上で `SHOT BREAKDOWN` の各ブロックで個別指定。本作は両者を混ぜて書いていた。

## その他

| 要素 | 原文 | 適用 |
|---|---|---|
| **1行目にメタ情報** | `Duration: 15 seconds \| Aspect ratio: 16:9 \| Style: …` | 尺・比率・様式を最初の1行で確定 |
| **キャラは"固有の物"で書く** | `bone necklace, fur-trimmed bracers, strapped sandals` / `backward-curving ridged horns` | 形容詞の散文でなく**識別できる物体名**。約25語 |
| **照明は世界の状態で書く** | `Dappled sunlight filtering through canopy` | 「キーは上から/返しは無し」等の撮影用語より、実際の光の状況を書くほうが通ると思われる |
| **各ショットに明確な動詞** | crouches / prowls / stomping / clings / drops / leaps / lands | 1ブロック1〜2アクション |

## AVOID が全て「分類の否定」— 本作の実測と完全に整合

```
Photorealism, 3D render style, modern elements, on-screen text, sluggish pacing.
```

5つとも**様式・カテゴリ**の否定で、**具体的な視覚要素の否定がゼロ**。
本作の実測(内容の否定は呼び寄せる/様式分類の否定は安全)と矛盾しない。
002の `no fire, no blood` より安全な書き方の見本。

なお `on-screen text` の否定は、ユーザーの「文字は使わない主義」を実装する手段として
そのまま使える(カテゴリ否定なので安全側)。
