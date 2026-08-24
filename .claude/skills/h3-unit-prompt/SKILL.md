---
name: h3-unit-prompt
description: AniPAFE2026のMiniMax H3プロンプト(生成単位)を書く・直すための手順。カットの設計意図・実測打点・名簿・参照集を必ず引いてから書く。バックエンドの関門(prompt_gate)が拒否する条件を事前に満たすための型と、機械検査できない品質(MGが意味に紐づいているか等)の自己点検を含む。H3の映像プロンプトを書く/直す/検証するときに必ず使う。
---

# H3 生成単位プロンプトの書き方

このスキルは**書き始める前の手順**を固定する。関門(`backend/app/services/prompt_gate.py`)は
「間違ったら止める」を担うが、止まらない失敗 — 設計意図の取り違え、MGの欠落、参照の画角違い —
は防げない。ここはその穴を埋める。

## 失敗の履歴（同じ轍を踏まないために）

いずれも「規則を書いた後に、自分でその規則を破った」ものだけを挙げる。

| 事故 | 原因 | 対策 |
|---|---|---|
| 42単位が「静止画を動かしただけ」 | `storyboard anchor` を24箇所に書いた。**役割を与えれば構図は固定される**(公式) | 参照の既定役割は `subject definition only, not a target frame and not a storyboard anchor` |
| MG語彙がほぼゼロ(wipe 3/panel 2/mask 0) | 「映像を説明」する散文に戻った | 各単位に**MG辞書から最低1つ、意味に紐づけて**配置 |
| 音合わせが完全消失 | 001形式に寄せる過程で6セクションごと捨てた | 001は**T2VA**の例。Ref2VAは6セクション必須。**両立させる** |
| 悪魔ほむらがレオタードに | 名簿の`description_en`を使わず自分の言葉で書いた | キャラ記述は**名簿から機械展開**(`{{HOMU_ID}}`等)。手書きしない |
| 手が欲しいのに全身が出た | 全身画を参照に渡した | **参照は「欲しい部位・欲しい画角だけが写った画」を渡す** |
| カメラがガタつく | ロールを動詞で書き、複数運動を重ね、チェックポイント0 | 1ショット1運動 / 振幅・速度を必ず付ける / **到達点をチェックポイントで書く** |
| 除外したロゴが参照に混入 | 注記の「#2936は使わない」をパーサが拾った | 参照は`参照:`行のブロックだけを読む |

## 手順（この順に必ず引く）

1. **カットの設計意図** — `docs/anipafe2026-cut-packets.json` の該当カットの `intent` 全文。
   ⚠ 記憶で書かない。⚠ `⚠` が付いた行は確定事項で、覆せない
2. **実測打点** — 同ファイルの `hits`(snare/kick/cymbal の相対秒)と `manual_buildups`。
   **ショット境界はここの生値に置く**(丸めない)
3. **設計リンク** — `links` と逆リンク。**そのカットが何の伏線で、何の回収か**を確認する
4. **名簿** — `backend/data/bible/0.json`。登場するキャラ・物の `description_en` と `caution`
5. **方針** — `docs/anipafe2026-rewrite-policy.md`(MG密度・モード・音・リップシンク・光)
   ⚠ **MG重点カット**は `docs/anipafe2026-mg-heavy-cuts.md` を先に見る。
   C7/C11/C16/C17/C21/C24/C30/C52/C56-57/C61-64 は密度計画より優先してMGを重くする
6. **憲法** — `docs/anipafe2026-prompt-constitution.md`(43条+37b-h)
7. **参照集** — `docs/prompt-refs/001〜008`。**形式を借りる相手を決める**

## retention marker（固有名7種・混同しない）

**可視参照(画像/動画)用 4種**: `fully_preserved` / `partially_preserved` /
`attribute_transfer`(属性を別の識別可能な対象へ転写) / `weak_reference`(様式・カテゴリ・構図・雰囲気のみ)
**音声参照用 4種**: `fully_copy` / `partially_copy` / `reference`(信号を複製せず声色・リズムを参照) /
`weak_reference`(可視と共通)

本作は音声参照を使わないので、実質は可視用4種。

## 型（Ref2VA。I2VAは3条件を満たすときだけ）

```
subject_definitions: <Picture N> (reference role: …) …
summary: …（1〜2文）
retention_analysis: …（fully_preserved / partially_preserved / attribute_transfer / weak_reference）
detailed_description: {{TH:*}}
STAGE: …（空間配置。誰がどこにどの向きで、カメラはどこから見ているか）
[Shot 1] 短い命令文。短い命令文。…
[Shot 2] At 00:0X.XXX, …（実測スネアの生値）
…
XXX LAW: …（この単位固有の法則。A triggers B の形）
BEAT LAW: {{BEATLAW}} 固有の対応
{{DP}} {{ST2}}
overall_soundscape: …
non_diegetic_music: N/A
```

**打点ゼロの単位**は `SILENT UNIT: there are no drums in this cut.` を明記する（関門の免除条件）。

## 書き方の規律

- **1文=1イベント。** 目標 平均12語/文以下。従属節で繋がない
- **主語は物。** 「カメラが寄る」より「帯が滑る」「羽根が落ちる」「窓が割れる」
- **カメラは1ショット1運動**、固定語彙 + `small/large amplitude` + `slow/fast speed`。
  **ロールは単独で使わない**(実測で3回とも不発)。回すなら終端状態を書く
- **チェックポイント**で時間配分を制御: `At 4.60 seconds …が見える`。
  実測で「これだけが効く」と確認済み。語彙だけでは配分は直らない
- **トランジションは実在の物体**で: ①何か ②被写体比の大きさ ③どの面 ④どの方向 ⑤ピンぼけか
- **状態でなくルール**を書く。`A triggers B` / `A becomes B`
- **否定は様式分類のみ。** 内容の排除は肯定形の代替で書く
- **ショットは2秒以上**を目安に(1.2秒に4イベント詰めると実行されない)

## 自己点検（関門が見られないもの）

書き終えたら以下を自問する。

1. **設計リンクの伏線は入ったか。** このカットが仕込むもの・回収するものは何か
2. **MGは意味に紐づいているか。** 装飾になっていないか(演出原則3)
3. **参照の画角=ショットの画角か。** クローズアップに全身画を渡していないか
4. **盛り上げ区間に連続量が割り当たっているか**(点でなく面で使う)
5. **キャラ記述は名簿からの展開か。** 手書きしていないか
6. **曲が盛り上がる単位ほど映像が強いか。** v1はここが逆転していた

## 投入

```
python3 scripts/submit_unit.py --v2 --dry U06     # 展開結果を確認
python3 scripts/submit_unit.py --v2 --t1 U06      # T1検証(960x544/step4)
python3 scripts/lint_unit_prompts.py docs/anipafe2026-prompts-v2
```

⚠ **APIへ直接POSTしない。** 関門は通るが、名簿展開・承認台帳の突合・place付与(テイク履歴)が
全て抜ける。実際にこれで事故を起こしている。

⚠ **生成後は必ずタイムラインへ配置してから報告する**(運用規約)。
`python3 scripts/place_units.py <jobs.json> --track 63 --v2`

## 現在の運用値

- v2 = `docs/anipafe2026-prompts-v2/`(43単位)。v1は比較用に凍結
- I2VAは **U01/U06/U10/U42** のみ。他は全てRef2VA
- リップシンクは **U13/U14(日本語)・U29/U30(英語)** の4箇所のみ。
  **キュゥべえは口が動かない**(テレパシー・公式設定)
- 文字は **U03のロゴのみ**。他42単位は完全禁止
