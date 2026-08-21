# MiniMax H3 プロンプト作法（検証済み）

出典: 公式スキル文書
<https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt>
（HuggingFace の `docs/VIDEO_PROMPT_WRITING_GUIDE_*.md` より詳しい。**こちらが正**）

**公式資料の索引と提出前チェックリストは `docs/h3-official-sources.md`（2026-08-18時点）。
プロンプトを書く前に毎回そちらから該当ガイドを読み直すこと。**

このファイルは「公式に書いてあること」と「このシステムで実測したこと」を分けて記録する。
⚠ 次の3つは**公式に記載がない、このシステム独自の知見**なので、公式と混同しないこと:
可視状態チェックポイント（公式は時刻をカットにのみ使う）／否定文が逆効果になる件／
ショット内の拍ヒットが制御できない件。
実測は AniPAFE2026 C19（1344×768 / step25 / scheduler=beta）で計 30本以上を回した結果。

---

## 1. モードとセクション構成

| モード | 画像 | セクション |
|---|---|---|
| T2VA / I2VA / FL2VA / L2VA | 0〜2枚（**位置の決まったキーフレーム**） | 3セクション + 先頭1行インストラクション |
| **Ref2VA** | **≤9枚**（動画≤3・音声≤3、全種合計12） | **6セクション** |

Ref2VA の6セクションは**この順序が必須**:
`subject_definitions` → `summary` → `retention_analysis` → `detailed_description` →
`overall_soundscape` → `non_diegetic_music`

`detailed_description` は生成タスクなら **350〜500語**。再生順にショットごとの
「構図・被写体の外見と位置・環境・ライティング」を書く。

---

## 2. ⚠ 音声はタイミングを駆動しない

> "Audio cannot independently drive video timing or motion; **only visual subjects do**"

`<Audio N>` が効くのは**出力音声側**（音色・リズム・曲調・台詞内容・音の質感）。
**映像のカットや動きは音から駆動されない。**

したがって**音ハメは「解析 → 拍時刻をプロンプトに数値で書く」のが唯一の正攻法**。
これは迂回策ではなく仕様どおりのやり方。

音声の関係マーカー: `fully_copy` / `partially_copy` / `reference` / `weak_reference`

**実測**: ComfyUI 経由では `fully_copy` は効かない（出力音声と元音源の波形相関 0.005）。
H3 は参照のリズムに従った**別の音声を生成**する。生成音声の包絡は参照区間と
**位相ズレ −10ms・相関 0.737**（無関係区間の対照は 0.187）で一致した。
→ **出力音声だけは参照に同調する。映像は別。**

---

## 3. ⚠ retention マーカーの意味（誤用しやすい）

| マーカー | 公式定義 |
|---|---|
| `fully_preserved` | 参照内容の役割が完全に保持される |
| `partially_preserved` | **内容は使うが、定義された特性の一部が変わる／部分的にのみ保持** |
| `attribute_transfer` | 参照の特徴を**別の識別可能な被写体へ移す** |
| `weak_reference` | 様式・カテゴリ・構図・雰囲気の大まかな類似のみ |

**「同じキャラのまま構図だけ自由にする」は `partially_preserved`。**
`attribute_transfer` は別人への付け替えなので、ここで使うと破綻する（過去に誤用した）。

### 参照画像に構図を支配させない書き方

`<Picture N>` が構図の錨になるのは **first frame / keyframe / last frame / storyboard reference**
など**役割を与えたときだけ**。役割を「被写体定義のみ」と明記すれば構図は自由になる。

```
<Picture 1> (reference role: subject definition only, not a target frame and not a
storyboard anchor) defines the design of the woman: ...
```

> "Do not treat newly added actions, backgrounds, or plot events in the target video as
> losses of reference fidelity"

新規の芝居・背景・出来事は忠実性の欠損ではない。**自由解釈は想定内。**

---

## 4. カメラ

3次元で書く: **動きの種類 + 振幅（small / large amplitude）+ 速度（slow / fast speed）**。
文末にラベルを並べず、ショット内の自然な英文の動作として書く。

種類は固定語彙: `Zoom In/Out`（本体静止・焦点距離のみ）/ `Push In/Pull Out`（**本体が前後**）/
`Pan` / `Truck` / `Tilt` / `Pedestal Up/Down` / `Arc Shot` / `Tracking Shot` / `Static Shot` /
`Shake Slightly/Strongly` / `POV` / `Roll Clockwise/Counterclockwise`

**実測**:
- 語彙を正しくしただけでは動きの**時間配分は直らない**。効くのは
  **「その時刻に何が見えるか」を書くチェックポイント**（例: `at 2.60 seconds the camera is
  directly behind her, her face is completely hidden`）。360度周回もこれで成立した。
- 「ゆっくりズームアウトに見える」問題は `Zoom Out` と `Pull Out` の取り違えが原因になりうる。
  視差が欲しいなら `Pull Out`。

---

## 4.5 ⚠ ショット内の拍ヒットは制御できない（実測）

「1拍に1体ずつ人形が出現し、そのたびに白1フレームのフラッシュ」を指示した結果:

| 指定方法 | 指定回数 | 実際に出た孤立フラッシュ | 最寄り拍とのズレ中央値 |
|---|---|---|---|
| 散文（M1: "one on every beat"） | 15 | **2** | 1.4f（でたらめ期待値 1.7f） |
| **15行の時刻テーブル**（M2c: `At 0.843 seconds ...` ×15） | 15 | **2** | 3.7f（同 1.7f） |

**粒度を上げても改善しない。** 段階ズームも同様で、指定した4回の小節頭のうち
実際に段差が出たのは1回だけ（変化量が全体中央値の47倍だったのは2.283sのみ、他は2〜3倍＝実質無し）。

→ **ショット境界（カット）だけが信頼できる制御点。** リズムを出したいなら
**拍そのものをカットで刻む**（`[Shot N] At MM:SS.mmm` を拍位置に置く）。
ショット内の静止を指定してはいけない（ヒットが出ないと何も残らず、
一枚絵にLive2D風の揺れが乗っただけの映像になる）。

## 4.6 音源参照が映像を駆動しないことの実測

数値時刻を書かず「`<Audio 1>` の拍ごと」とだけ指示し、**同一音源の通常速と半速**を比較:

| 渡した音 | 拍間隔 | イベント数 | 最寄り拍とのズレ中央値 | でたらめ期待値 |
|---|---|---|---|---|
| 通常速 | 0.288s | 17 | 1.9f | 1.7f |
| **半速** | 0.576s | 11 | 2.3f | 3.5f |

音を聴いているならイベント間隔は**2.0倍**になるはずが、**実測 0.64倍**（逆方向）。
どちらも偶然と区別がつかない。**公式の記述どおり、音は映像タイミングを駆動しない。**
映像のみを使う運用なら `ref_audio_asset_ids` は省略してよい。

## 4.7 キャラクターの同一性を保つ（実測で解決）

公式 `3d-animation-short-generator` の**キャラクターカード**方式が有効だった。

> 各キャラに「Main 3/4 view」＋「Front / side / back views」＋「Expressions」、そして
> **"Identity lock repeated in the prompt"** と、年齢帯・体型・髪型・衣装色・シグネチャ小物・
> do-not-change traits を列挙した**短い visual-ID note**

**やること**
1. 既存原図から **正面 / 3-4 / 寄り / 俯き** を切り出して1枚のカードにする（AI生成しない）
2. カードを `<Picture 1>` に置き、`retention_analysis` で **`fully_preserved`**
3. visual-ID note は**キャスト名簿の `description_en` を逐語で埋め込む**（名簿を単一の正にする）
4. **顔の造形を細かく書かない**（「同心円の虹彩に四角いハイライト」等はむしろ汎用アニメ顔を招く）

**実測**: この対策前は「要素は合っているが汎用アニメ顔」だったのが、対策後は黒ヘアバンド・赤リボン・
細い瞳・尖った顎まで再現された。**参照枚数(9枚→2枚)は同一性にほぼ影響しない**（両方で改善）。
効いたのは**カード＋fully_preserved＋顔記述を削ること**。

## 4.8 トランジションの引き出し（MV用途）

`music-video-subtitle-generator` より:

> "Cut points must hit the 1/4 or 1/8 beat grid. **Use speed ramping to align head nods, hand gestures,
> and blinks to beats.**"
> "Scene switches must be triggered by **musical impacts: bass hit, 808 drop, snare, vocal accent**"
> "splitting into **4–8 short shots of 2–5 seconds**"
> "**Editing must use hard cuts only. No fades, dissolves, or soft transitions.**"
> 繋ぎは "same-direction pan or **hand-occlusion match cut**"
> "**Alignment occurs downstream during editing** rather than during individual generation."

**ショット内のリズムは光学効果ではなく身体動作で打つ。** 頷き・まばたき・手の仕草を拍に置き、
カメラの寄りをアクセント直前で減速→直後に加速させる（speed ramping）。実測でまばたきも手の動作も実行された。

**使える繋ぎ（実測）**
| 手法 | 結果 |
|---|---|
| ハードカット（`the shot cuts to`） | 誤差 +0.2〜1.2f。2ショット構成なら高精度 |
| **手でレンズを覆うマッチカット** | **成立**。輝度の不連続が出ないので「切れ目のない転換」になる |
| **モーフ**（AがBになる） | 成立（虹彩→歯車、羽根→人形） |
| ディゾルブ / フェード / ワイプ | `base-en.txt` に語彙はあるが **MVでは公式が禁止** |

**カット密度の実測**: 9カット（最短7フレーム）→ 誤差2.3〜3.4f・カット間引きが発生。
**2ショット → 誤差 +0.2〜1.2f。** 公式の「2〜5秒」を守ること。

### 4.8.1 ⚠ トランジションは「技法名」で書くと出ない（2026-08-20 実測）

同じ歯車ワイプを2回テストし、**手前面の書き方だけ**で成否が分かれた。

| 書き方 | 結果 |
|---|---|
| `a gear wipe transitions the shot` / `red threads slice the frame` | **出ない**（job 3490。線は出たが物体としてのワイプは不発、視差も0.85と反転） |
| `an enormous dark iron gear, its teeth taller than she is, rolls in from the right edge in the foreground plane and wipes the entire frame as it crosses` | **出る**（job 3499。歯車ワイプ成立） |

**規則: トランジションを編集用語で書かず、レンズの至近を横切る実在の物体として描写する。**
① 何であるか ② 被写体との比較で大きさ ③ どの面（foreground plane）を ④ どの方向へ横切るか
⑤ ピンぼけかどうか — この5点を書く。`across the lens at very close range, thick and out of focus`
が最も効いた言い回し。

### 4.8.2 日本語タイポグラフィは使える（2026-08-20 実測）

公式ガイドは非ラテン文字の崩れを警告しているが、**縦書き日本語は字形が崩れずに出た**
（job 3500。「絶望から罪が生まれた」→赤線スライス→「また躰 引き裂くまで」）。
成立条件は3つ: **黒背景の editorial 構図に置く / 1字ずつ resolve すると書く / 短い句にする**
（検証済みは9文字・8文字）。絵の中に埋め込む用途は未検証。

## 5. ショットと時刻

- `[Shot 1]` にタイムスタンプを付けない。以降 `[Shot N] At MM:SS.mmm,` で厳密増加。
- `[Shot N]` は**ハードカット**。1ショット内の途中経過には使えない。
- **実測**: カット位置は指定どおりに落ちる（**誤差 0.4〜1.1 フレーム**）。最も信頼できる制御手段。
- 1ショット内で局面を変えたいときは、**カメラではなく「画が何に変わるか」**で書く。
  実測でモーフは高精度に成立した（虹彩→歯車、羽根→人形）。

---

## 6. ⚠ 否定文は逆効果になりうる

**実測**: 「光る形・青いシルエット・固まる光の雲としても現れない」と書いた3本すべてで
**青い発光実体化が発生**した。H3 は CFG も negative prompt も持たないため、
否定形でも語が入れば条件付けに効く。

**排除したいものは「代わりに何があるか」を肯定形で書く。**

```
✗ none of them arrives as a glowing shape or a cloud of light
✓ each doll is opaque and fully painted from the first instant, standing on the stone with
  a hard shadow beneath her, lit only by the same cold violet light that falls on the pillars
```

集中線の排除は全16本で成功したが、あれは否定文に
「速度感はカメラと髪の動きだけで出す」という**肯定形の代替**を添えていた。

---

## 7. 尺・解像度・ステップ

- 解像度は**ルール**: 短辺768 / 縦横32の倍数 / 面積上限 1,032,192px
  → 16:9 の上限は **1344×768**（学習解像度）。1920×1080 はベースモデルでは生成不可。
- フレーム数は **17n+5** にスナップし、**124 が下限**（`h3_snap_length` が `max(124,…)`）。
  **5.17秒未満のカットは作れない。** 短いカットは「124f を作ってカット尺で頭から切る」。
- fps は **24固定**。CFG も negative prompt も無い。
- 公式ベースライン `num_inference_steps: 50` / `flow_shift 12.0`（映像）/ `3.0`（音声）。
- **実測所要**（1344×768 / step25）: 約31分。step8 なら約8分。

---

## 8. このシステム固有の運用

- 参照画像は `keyframes[]`、参照動画は `ref_video_asset_ids`、参照音声は `ref_audio_asset_ids`。
- `place.auto=false` は「**配置せずテイクとして蓄積**」の意味。配置させたいなら false にしない。
- 配置は**常に等倍・頭から切る**（速度変更は人の判断）。
- ⚠ **backend/ 配下を編集すると uvicorn --reload で実行中ジョブが死ぬ。**
  生成中は backend を触らない（frontend と docs は安全）。
- `ref_image_size`: `match`=速度優先 / `max`=同一性優先（短辺2048）。多人数の造形を拾うなら `max`。

---

## 9. 制作上の経験則（実測ベース）

- **1ショットの長回しは弱い。** 5秒に「どアップ＋周回＋15人の出現＋着地」を詰めると全部が立たない。
  拍で切った3〜5カットのモンタージュのほうが圧倒的に強い。
- **明暗を作る。** 全面が同じ明るさで発光していると「安っぽい」に直結する。
  黒を黒く、光は硬く一方向から、彩度の高い色は差し色のみ。
- **終着点を柔らかい絵に固定しない。** FL2VA で最終フレームを均一発光の絵に固定すると、
  そこへ着地する限り必ずその質感になる。
- **参照の外れはシード差。** 語数や言い回しのせいにしない（word-count 仮説は反証済み）。
- 指標を信じない。**絵で判断する。** ズーム率の自動推定は内容変化が大きいと1倍に張り付く。

## 7.5 ⚠ 長尺ユニットとバックエンドのタイムアウト

`COMFY_TIMEOUT_S`(backend/app/services/comfyui.py)が生成1本の上限待ち時間。
**226フレーム(step25)は約56分かかり、旧設定の40分では必ずタイムアウトする**(2026-08-19にU03で実害)。
9000秒(150分)へ引き上げ済み — 最長362フレームでも収まる。
実測ペース: 約31分/124f(step25, 1344×768) → 所要 ≈ gen_frames/124×31分。
