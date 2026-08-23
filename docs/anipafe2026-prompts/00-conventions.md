# AniPAFE2026 生成単位プロンプト — 共通規約と断片辞書

作成 2026-08-23。42生成単位(U01-U42)の唯一の正。
執筆基準: プロンプト憲法(43条+37b-f) / 幕別スタイルブロック / 対比グループ表 / cut-packets.json。

## プレースホルダ方式

`{{...}}` は**投入時にスクリプトが機械展開**する。手書きコピーの揺れを排除し、
名簿(`description_en`)やスタイルブロックの更新が全プロンプトへ自動波及する。

### キャラ定義(名簿 description_en を逐語展開・憲法37c)
| タグ | 展開元 |
|---|---|
| `{{HOMU_ID}}` | homura_devil + 「羽根スカートは膝下・指先まで黒手甲・肌は出ない」の固定追記 |
| `{{UM_ID}}` | madoka_ultimate |
| `{{ORB_ID}}` | darkorb + 「小さい: 手のひらに収まる、りんご以下」の固定追記 |
| `{{GEM_ID}}` | soulgem_homura + 「金装飾を再設計しない・翼や角を足さない」 |
| `{{QB_ID}}` | kyubey + 「表情を持たない(名簿note)」 |
| `{{EMBLEM_ID}}` | emblemstone |
| `{{MAJUU_ID}}` | majuu |
| `{{WALP_ID}}` | walpurgis |
| `{{DOLLS_ID}}` | claradolls(card) |

### スタイル(幕別ブロックを逐語展開・style-blocks.md)
`{{S:PRO}}`序・終 / `{{S:MEM}}`幕1 / `{{S:CITY}}`偽街 / `{{S:DAY}}`日常 / `{{S:STORM}}`間奏 /
`{{S:A3}}`幕3 / `{{S:WATER}}`水面 / `{{FOCUS}}` / `{{STYLE}}`(セル画+NO-TEXT+資料枠禁止) / `{{LENS}}`

### 鏡映断片(対比グループで一言一句共有・憲法41)
| タグ | 内容 | 使用単位 |
|---|---|---|
| `{{HALF_MOON}}` | "a huge pale moon whose RIGHT HALF IS SIMPLY MISSING, the remaining half ending in a PERFECTLY STRAIGHT VERTICAL EDGE that burns thin and white, the missing half being empty black sky - not a shadowed side" | U01 U15 U17 U33 U35 U42 |
| `{{SOURCELESS_SHADOW}}` | "one huge soft-edged shadow, cast by nothing that is anywhere in the sky, drifts slowly across" | U01 U17 U24 |
| `{{FRAME_A}}` | "medium close-up, facing the camera directly, perfectly centred, head and upper chest filling the upper two thirds of the frame" | U13 U29 (C14/C45対) |
| `{{FRAME_B}}` | `{{FRAME_A}}`と同一文字列(C15/C46対もこの撮りを共有) | U14 U30 |
| `{{WATER_BASE}}` | "the white water surface stretching to every edge, bright and even, figures lying/standing as delicate dark shapes upon it" | U06 U10 U36 |
| `{{SEEOFF}}` | "the two of them stand side by side in the lower left of the frame, seen from behind at a distance, perfectly still, watching something bright leave the upper right; neither raises a hand" | U25 U27 (C37/C42反復) |
| `{{REACH_HAND}}` | "a hand reaches into the frame, open, yearning, and stops short - the distance between fingertips and what they reach for stays visible" | U02 U16 U17 |

## 全単位共通の規則

1. **プロンプトはカット実尺で時間を割る**(憲法37)。生成尺の残りは
   `after that, the picture simply holds: nothing new enters, motion decays to stillness` の余韻文で埋める
2. 打点は関係で書く: `each snare triggers …` / `each kick lands as …` / `each cymbal bursts as …`
   ミリ秒の羅列は書かない(憲法7)。位置合わせは⏱リマップ
3. 統合単位の内部カット境界のみ `[Shot N] At MM:SS.mmm,`(単位頭からの相対・実測スネア位置)
4. 音は画面内の物から出す。`non_diegetic_music: N/A`(散文禁止でなくフィールドで・憲法/adh)
5. 参照は全て役割宣言 `(reference role: …)`。競合権限を作らない
6. モードは単位ごとに明記: **Ref2VA**(6セクション) / **I2VA**(3セクション+先頭行。承認済み静止画を
   первフレームに使う静的カット)
7. Ref2VAの `detailed_description` は350-500語目標(公式)。I2VAはこの限りでない
8. 対比グループは同時執筆・断片共有(上表)。片方だけ直すことを禁ずる

## 投入スクリプト

`scripts/submit_unit.py U17` が 00-conventions の辞書を展開して投入する(ゲート2承認後に作成)。
