# MiniMax H3 公式資料インデックス（2026-08-18 時点）

プロンプトを書く前に**毎回ここから該当ファイルを読み直す**。
記憶で書くと必ず外す（実際に `attribute_transfer` の誤用、音声でタイミング駆動できるという誤解、
語数不足、修飾の付けすぎを起こした）。

実測で得た知見は `docs/h3-prompt-writing.md` に、**公式記述と自前の仮説を分けて**記録している。

---

## 0. 読む順（プロンプト作成の手順）

1. **モードを判定する** → `skills/h3-prompt-writing/SKILL.md`
   - T2VA / I2VA / FL2VA / L2VA → `references/base-en.txt`（3セクション）
   - **Ref2VA** → `references/ref-en.txt`（6セクション）※本プロジェクトはほぼこちら
2. **用途別スキルを重ねる**
   - 音楽もの・拍合わせ → `skills/music-video-subtitle-generator/SKILL.md`
   - キャラクターの同一性 → `skills/3d-animation-short-generator/SKILL.md`
3. **書き上げたら §4 のセルフチェックに通す**

---

## 1. 中核（必読）

| ファイル | URL | 何が書いてあるか | 既読 |
|---|---|---|---|
| `skills/h3-prompt-writing/SKILL.md` | [link](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md) | モード判定と、どちらの reference を読むかの分岐だけ。フィールド名・セクション順・ラベル・時刻記法を**そのまま維持せよ**と指示 | ✅ |
| `references/ref-en.txt` | [link](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt) | **Ref2VA の6セクション**、retention マーカー4種の定義、`<Picture N>`/`<Audio N>` の役割、**音声はタイミングを駆動しない**、`detailed_description` は350〜500語 | ✅ |
| `references/base-en.txt` | [link](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt) | **カメラ語彙の全表**（種類＋振幅＋速度）、**トランジション語彙**、モード別の先頭1行、`[Shot 1]` 冒頭で様式と初期構図を述べる | ✅ |

## 2. 用途別（該当時は必読）

| ファイル | 何が書いてあるか | 既読 |
|---|---|---|
| `skills/music-video-subtitle-generator/SKILL.md` | **カットは1/4・1/8拍グリッドに乗せる**／**speed ramping で頷き・手の仕草・まばたきを拍に合わせる**／シーン転換は**音の衝撃**（バスヒット・スネア・ボーカルアクセント）で起こす／**2〜5秒のショットを4〜8本**／**ハードカットのみ、フェード・ディゾルブ禁止**／繋ぎは同方向パンか**手で覆うマッチカット**／**細かい同期は生成でなく編集で取る** | ✅ |
| `skills/3d-animation-short-generator/SKILL.md` | **キャラクターカード**（3/4・正面・側面・背面・表情）／**Identity lock をプロンプト内で繰り返す**／visual-ID note は年齢帯・体型・髪型・衣装色・小物・do-not-change traits／デザインは先に固定して後から変えない | ✅ |
| `.../3d-animation-short-generator/references/qc-checklist.md` | 最終レビュー項目: キャラ一貫性／シーン継続性／**絵コンテの痕跡が残っていないか**（枠線・スケッチ線・矢印・ラベル・手書きメモ・タイミングマーク・ポーズの残像・絵コンテ文字）／二重バインドのラベルが映り込んでいないか／要再生成の素材 | ✅ |
| `skills/README.md` | スキル9種の索引 | ✅ |

## 3. 未読（必要になったら読む）

`3d-animation-short-generator/references/` の `storyboard-guidelines.md`（一部読了）/ `shot-table-spec.md` /
`model-selection.md` / `fallback-policy.md`、および
`handdrawn-live-video-generator` / `papercraft-stop-motion-explainer` / `paper-collage-explainer-generator` /
`brand-promo-video-generator` / `minimalist-product-ad-generator` / `co-op-game-intro-generator`

**HuggingFace 側**: モデルカード（解像度ルール・面積上限・17n+5・学習域124〜362・flow_shift・Regenerate-2K）と
`docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md` / `_ref_en.md`。
→ **GitHub の skills 版のほうが詳しい。仕様値はモデルカード、書き方は skills を正とする。**

---

## 4. 提出前セルフチェック（公式記述から機械的に導けるもの）

- [ ] セクションは6つ、順序は `subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`
- [ ] `detailed_description` が **350〜500語**
- [ ] `[Shot 1]` の冒頭で**様式と初期構図**を述べている
- [ ] 各ショットに**構図・被写体の外見と位置・環境・ライティング**がある
- [ ] `[Shot 1]` に時刻が無く、以降は `[Shot N] At MM:SS.mmm,` で厳密増加
- [ ] カメラは**固定語彙**（Zoom と Push/Pull を混同していないか）
- [ ] **振幅と速度は意味があるときだけ**付けている（既定は省略）
- [ ] retention マーカーの選択は正しいか（同一キャラで構図だけ変えるのは `partially_preserved`。`attribute_transfer` は**別被写体への移し替え**）
- [ ] 参照に**役割**を与えているか（構図を支配させたくないなら `subject definition only, not a target frame`）
- [ ] 排除したいものを**否定形で名指ししていない**（肯定形の代替で書く）
- [ ] 尺は **17n+5 かつ 124 以上**
- [ ] MV用途なら: カットは拍グリッド上／ショットは2〜5秒／**ディゾルブを使っていない**

## 5. 生成後チェック（qc-checklist より）

- [ ] キャラクターの一貫性・シーンの継続性
- [ ] **絵コンテの痕跡が映っていないか**（枠線・矢印・ラベル・手書き文字・ポーズの残像）
- [ ] ショットの目的が明確か／弱いカットはないか
