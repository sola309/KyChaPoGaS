# ACE-Step 1.5 で良い曲を作る — ソース/公式ドキュメント精読レポート

> 2026-07-05。tools/ace-step のソースコード・INFERENCE.md・musicians guide・
> 公式songwritingスキル・examplesを精読した結果と、**我々の誤用の監査**。
> 音楽タブ/AI作曲の実装はこのレポートを規範とする。

## 0. 結論: これまでの曲がイマイチだった直接原因(誤用監査)

| # | 誤用 | 影響 | 根拠 |
|---|---|---|---|
| 1 | **thinking未指定(アダプタ既定False)** | 5Hz LM(作曲家ブレイン)が完全OFF。構造計画・音楽意味コード・メタ推論なしで、生captionが直接DiTへ。**最大の品質損失** | openrouter_adapter.py:381 `thinking=req.thinking if ... else False` |
| 2 | use_cot_caption/language=False を明示指定 | LMによるcaption整形・言語検出まで切っていた(「速度と決定論のため」という誤った最適化) | 我々のacestep.py |
| 3 | **(囁き)(爆発)等の括弧演出指示** | ACE-Stepでは**括弧=バックコーラス歌唱**。演出指示がコーラスとして歌われる事故 | songwritingスキル「Parentheses = background vocals」 |
| 4 | captionにテンポ/転調語(「tempo increase」「key change」「quiet-loud」) | 公式の禁じ手。「BPM/key/tempoはcaptionに入れない」+矛盾語は劣化 | スキル原則8 |
| 5 | duration 150秒で2verse+2chorus+bridge | 推奨は**180-240秒**。「短いと曲が焦って聞こえる」そのもの | スキルDuration表 |
| 6 | shift未指定(サーバ既定1.0) | turboの推奨はshift=3.0(CLIは上書きしている)。サンプリング分布が非推奨状態 | cli.py:523, INFERENCE.md:366 |
| 7 | 構造タグが[verse][chorus]だけ | [Intro][Build][Breakdown][Guitar Solo][whispered][powerful belting]等の「時間軸台本」を未活用 | スキルStructure/Vocal/Energyタグ表 |
| 8 | 1個ずつ生成して判断 | 公式は「絶対に1個だけ生成するな」— batchでチェリーピックが前提 | musicians guide:411 |

セグメント縫合(却下済み)も、本来は **Repaint/coverタスク**でやるのが公式想定だった。

## 1. アーキテクチャ理解(2ブレイン)

- **Brain1 = 5Hz LM(Songwriter)**: caption/lyricsを読み、CoTでBPM/key/duration/整形captionを推論(Phase1)、
  続いて5Hzの音楽意味コード=曲の設計図を生成(Phase2)。`thinking=true`で有効。
- **Brain2 = DiT(Studio Engineer)**: LMの計画+条件から拡散でオーディオ生成。
- cover/repaint/extractではLMは自動スキップ(ソース音源が設計図になる)。

**含意**: text2musicの品質はthinking=trueが前提。彼らの「良い曲」はLMに設計させている。

## 2. Caption規範

- 形式: タグ列/自然文どちらも可。**具体>曖昧**。style+emotion+instruments+timbre+era+productionを組む。
- **入れてはいけない**: BPM・キー・テンポ語・転調指示(専用パラメータ/構造タグの仕事)。
- 矛盾語禁止。時間変化は「Start with X, middle becomes Y」の発展記述かlyricsタグで。
- vocal記述(female, breathy, powerful...)はcaption側、**歌い方の時間変化はlyricsタグ側**。
- 例(公式example_01): アニメ主題歌風は長文自然文で楽器/声/展開まで書いてよい。

## 3. Lyrics規範(時間軸の台本)

- 構造タグ: `[Intro] [Verse 1] [Pre-Chorus] [Chorus] [Bridge] [Outro]` + 動的 `[Build] [Drop] [Breakdown]`
  + インスト `[Instrumental] [Guitar Solo] [Piano Interlude]` + 特殊 `[Fade Out] [Silence]`
- ボーカル制御タグ: `[whispered] [powerful belting] [falsetto] [raspy vocal] [spoken word] [harmonies] [ad-lib]`
- エネルギー: `[high energy] [building energy] [explosive] [melancholic]` 等。結合は `[Chorus - anthemic]`(1個まで)。
- **大文字=シャウト** (`TURN THE WHEEL!`)。**括弧=バックコーラス**(演出指示に使うな)。
- 1行6-10音節、同位置の行は±1-2で揃える(→我々のlyric_craftモーラ設計と完全整合)。
- セクション間は空行。caption⇔lyricsのタグ矛盾禁止(モデルは矛盾解決が苦手)。
- インスト曲は `[Instrumental]`(旧`[inst]`も通るが公式表記へ)。

## 4. パラメータ規範

| 項 | 推奨 | メモ |
|---|---|---|
| thinking | **true**(text2music) | LM設計。cover/repaintでは自動無視 |
| inference_steps | turbo: 8 (1-20) / base: 32-64 | |
| shift | **3.0**(turbo) | アダプタに項が無かったため**当リポでフィールド追加済** |
| guidance_scale | 5-9(non-turboのみ有効) | turboでは実質無視 |
| bpm/keyscale/timesig | 明確な要求がある時だけ指定、他はLM推論に任せる | 30-300 / 70キー / {2,3,4,6} |
| duration | 2V2C=120-150s / +bridge=**180-240s** / フル=210-270s | 迷ったら長め |
| batch | 2-4生成してチェリーピック | retake_variance/flow_editは発展編 |
| lm_temperature | 一貫0.7-0.85 / 冒険0.9-1.1 | |

## 5. タスク(1.5)

- `text2music` 通常 / `cover` 構造維持スタイル変換(strength 0.3-0.9) / `repaint` 区間再生成(配線済) /
  `lego` トラック追加・`extract` ステム抽出・`complete` 補完(**baseモデルのみ**)。
- 転調・ジャンル豹変の正攻法: **thinking=trueで一発生成→気になる区間だけrepaint**。
  (lyricsの[Bridge - explosive]等の動的タグで最初から起伏を台本化するのが先。repaintは外科手術)

## 6. 我々のパイプラインへの適用(実施済み/この後)

1. acestep.py: `thinking=True`既定・cot系のFalse固定を撤廃・`shift`/`inference_steps`透過
2. openrouter_models/adapterに`shift`フィールド追加(turbo既定3.0)
3. lyric_craft(モーラ設計)+本レポートのタグ規範で作詞 → 🩺score85+
4. 生成テンプレ: 「螺旋の朝」= caption(矛盾なし)+タグ台本+duration 185s+thinking+2variants
5. S2V歌唱カット用は同一曲のボーカル区間をそのまま使用(声の一貫性)

## 参照

- tools/ace-step/docs/en/INFERENCE.md(全パラメータ+実例10)
- tools/ace-step/docs/en/ace_step_musicians_guide.md(2ブレイン図解・ワークフロー)
- tools/ace-step/.claude/skills/acestep-songwriting/SKILL.md(公式作詞作曲規範)
- tools/ace-step/examples/text2music/*.json(理想形サンプル)
- acestep/inference.py(GenerationParams)・openrouter_adapter.py(既定値の罠)
