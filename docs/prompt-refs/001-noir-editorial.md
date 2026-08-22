# 001 ノワール × ラグジュアリー・エディトリアル

- 提供: ユーザー(2026-08-21)「よさげな映像が作れた」
- 出所(推定): `@📷` というキャラ参照記法を持つ動画生成系(Sora / Kling / Higgsfield 等)。
  MiniMax H3 の `<Picture N>` + 6セクション構造とは形式が異なるので、**中身の翻訳が要る**。
- 尺: 15秒 / 16:9 / 音声同期あり

## 原文（改変せず保存）

```
15s, 16:9, cinematic hand-drawn 2D anime, hard-boiled noir × luxury editorial motion graphics, synchronized stereo audio.Use @📷 as the ONLY character reference.Keep the exact same woman from @📷 throughout the entire video: same face, right-facing profile, hairstyle, hair color, red eye, silver earrings, red jacket, black clothing, black gloves, lit cigarette, body proportions and calm hard-boiled expression.　Do not create additional people or duplicate her. Keep her as hand-drawn 2D anime, never photorealistic or 3D.COLOR PALETTE: black, deep charcoal, blood red, dirty ivory. STYLE: luxury fashion magazine × noir crime-film title sequence. Bold negative space, tall condensed typography, asymmetric layouts, red geometric panels, thin lines, portrait masks, split screens and smoke transitions. Clean and intentional motion design, no random glitch effects.Only show these exact text strings: "AFTER DARK" "CASE 01" "NO WITNESS" "02:43 A.M."No other text, subtitles, logos or watermarks.[0–3s] Begin on pure black.A tiny red point glows like a cigarette ember in the center.A thin ivory vertical line grows from it.Large tall typography appears: "AFTER" on the left, "DARK" on the right.Inside the letters, reveal cropped details of @📷: her red eye, hair, silver earrings, cigarette and red jacket.The center line expands into a blood-red vertical rectangle.[3–6s] The red rectangle slides right and reveals @📷📷.The strips slide horizontally at different speeds.Large blood-red typog📷ile cigarette smoke moves.Large ivory text "02:43 A.M." slowly passes BEHIND her silhouette.Subtle camera push toward her eye. Her red eye briefly appears from the darkness.Transition into several fast editorial close-ups: red eye, silver earrings and hair, black glove and cigarette.　Red, black and ivory geometric panels move rapidly around these details with precise mechanical timing.[12–15s] Return to pure black.@📷 appears quietly on the right in exact right-facing profile.Her red eye, cigarette ember, earrings and red jacket remain subtly visible.On the left:"AFTER DARK"Below:"NO WITNESS"A thin vertical red line separates the typography from the character. Final composition becomes completely still for approximately the last 0.8 seconds.Only faint cigarette smok📷anical clicks.A deep sub-bass impact accompanies the rapid graphic section.During the final shot, reduce the soundtrack to a low bass drone, distant urban electrical hum and faint cigarette burn, becoming almost silent at the end.IMPORTANT: Prioritize exact character consistency with @📷. Keep the right-facing profile and original costume. Keep typography behind the character whenever they overlap. Never cover her face with text. Keep character motion restrained and motion-graphics movement bold and precise. No extra characters, character duplication, frontal-face transformation, costume changes, random glitches, photorealism, 3D character rendering, extra text, subtitles, logos or watermarks.
```

（原文には貼り付け時の破損とみられる箇所がある: `typog📷ile` / `smok📷anical` / `@📷📷`。
文意は前後から補える。要素の抽出には影響しない）

## ★ 最重要 — 短さそのものが技法

**原文は2,969字(413語)で15秒。** 本作のH3プロンプトは9.4秒に対して17,000〜20,000字を
使っていた(**尺は6割なのに6〜7倍の文字数**)。そして良い映像が出たのは短い方である。

実測(2026-08-22): 17,233字(v2) → 20,671字(v3)へ増やしたところ、増分を終盤描写に使ったために
**モデルが終盤へ早期に飛びついて居座り、中盤の4人が消えた**。尺の40%が静止した引き画になった。
「語数は長大でよい」は**情報密度**の話であって冗長さの許可ではない。

原文の骨格はこれだけ:
`書式1行 → 同一性ロック → COLOR PALETTE → STYLE(A×B) → 時刻ブロック4つ → 音 → 制約`

各時刻ブロックの出来事は数個。**ミリ秒打点の羅列は無い**(下記「採用しない」参照)。

## 採用した要素

### ~~文字を「窓」にする~~ — ❌ 本作では禁止

> Inside the letters, reveal cropped details of @📷: her red eye, hair, silver earrings...

当初これを最大の収穫として記録したが、**2026-08-22にユーザーから禁止された**:
「文字を窓にするのは日本語でやるとダサいので禁止です。そもそも文字は使わない主義」。

**窓の構造そのものは有効なので、マスクをオブジェクトやキャラクターのシルエットで作ること。**
文字列ホワイトリスト(後述)も、本作では「文字を出さない」運用になるため使いどころが無い。

### Z順の明示

> Keep typography behind the character whenever they overlap. Never cover her face with text.

本作は**レイヤー順を一度も指定していない**。文字と人物が重なる場面では必須。

### COLOR PALETTE を独立行で

> COLOR PALETTE: black, deep charcoal, blood red, dirty ivory.

本作はカラースクリプト(`anipafe2026-color-script.md`)を持つが、プロンプトでは散文に溶かしていた。
**独立行で3〜4色に絞る**ほうが輪郭が出るはず。

### スタイルは「A × B」の一行

> hard-boiled noir × luxury editorial motion graphics
> STYLE: luxury fashion magazine × noir crime-film title sequence

長い散文より二領域の融合を一行で。本作なら
`Puella Magi Madoka Magica cel animation × Gekidan Inu Curry cut-paper collage` など。

### ~~文字列のホワイトリスト~~ — ❌ 本作では不要

> Only show these exact text strings: "AFTER DARK" ...

文字を使わない方針のため出番が無い(2026-08-22の禁止指示)。

### 末尾の静止を明示

> Final composition becomes completely still for approximately the last 0.8 seconds.

実測ではH3のカメラ運動は2.5秒以降どのみち静止するが、**明示的に止めると終端が編集で扱いやすい**
(次カットへの繋ぎが安定する)。

### 帯が異なる速度で滑る

> The strips slide horizontally at different speeds.

本作の2.5Dパララックスを**エディトリアルな板**として表現したもの。同じ原理の別の見た目。

## 採用しない / 注意する要素

### 否定文の多用 — 本作の実測と衝突する

原文は否定が非常に多い(`Do not create additional people` / `no random glitch effects` /
`No other text` / 末尾IMPORTANTブロック全体)。

本作の実測では **H3で否定は逆効果**(発光を否定して3/3で発光)。
ただし精査すると:
- **具体的な視覚要素の否定** → 呼び寄せる(実測の失敗例はこれ)
- **スタイル分類の否定** → 問題を起こしていない
  (LOOK基盤の `never photoreal, never 3D render` は事故なし)

→ **内容の否定は肯定文へ書き換えて**採り入れる。この線引き自体は未確定なので検証枠 X-4 で測る。

### 形式は移植不可

`@📷` はそのプラットフォームの参照記法。H3は `<Picture N>` と6セクション必須。

### 15秒の一発撮り

本作のカットは4〜5秒。362フレーム生成は約90分かかり、実測で長尺ほど指示精度が落ちる。

### 時刻ブロック内の複数イベント

`[0–3s]` の中に複数の出来事を並べる書き方。H3では**順序は伝わるが個々のタイミングは制御できない**
(実測: ショット内の等間隔・拍ヒットは不可)。刻みは編集側で持つ前提は変わらない。

**⚠ 私はこの結論を書いた後も、ミリ秒打点(`At 00:05.443 every musket barrel catches the light`)を
40本近く並べ続けていた**(2026-08-22に発覚)。制御できないと自分で測った形式にプロンプトの3割を
使い、その分だけ本編の記述が押し出されていた。**打点は書かない。音ハメは時間リマップ機能で持つ。**
