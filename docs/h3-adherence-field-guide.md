# H3 Adherence Field Guide（外部ツールから抽出・未導入）

出典: [BMB12d3/minimax-h3-prompt-composer](https://github.com/BMB12d3/minimax-h3-prompt-composer)
(V5.37.1 / 2026-08-21更新 / 43stars / **ライセンス表記なし**)

単一HTMLのオフライン・プロンプト作成ツール。本体より、**中に埋め込まれた知識ベース**が有用。
各項目に出典タグ `[OFFICIAL] MiniMax公式docs / [COMMUNITY] 第三者ガイド / [TESTED] 再現可能な検証`
が付いている。以下は原文からの抽出(2026-08-22)。**未導入。採否は要判断。**

---

## 1. Terse skeleton, verbose descriptions

> **[OFFICIAL]** H3 was trained on the output of its own prompt rewriter, not casual prose.
> The skeleton is a closed, terse vocabulary; the descriptions inside it should be long, explicit, and physical.
>
> - **Be terse / exact**: Field labels, `[Shot N]`, timestamps, camera vocabulary, `<d>` tags, retention markers. Exact strings, nothing extra.
> - **Be verbose / explicit**: Subject appearance and state (identity, wardrobe, position, orientation, lighting); actions as **causal chains of observable physics in time order**; audio as direct sound behavior (source, distance, decay, timing).
>
> **[OFFICIAL] Ref2VA `detailed_description` target is 350–500 English words** for generation tasks.
> A single shot does not justify a short description.
>
> **[COMMUNITY]** Verbose does not mean more events. Spend the complexity budget on
> **one main action arc plus one primary camera move per shot**; detail the physics of one beat
> rather than stacking four.
>
> **Repetition is intentional.** Repeating the same visual description across `subject_definitions`,
> `retention_analysis`, and `detailed_description` is **reinforcement, not redundancy**.
> Trimming it to avoid repeating yourself weakens conditioning.

**本作との差分:** 350-500語という公式目標に対し、v5は約1,700語。
「1ショット=1アクション弧+1カメラ運動」という予算を常に超過していた。
一方で「セクション間の反復は補強」は、私の重複排除の直感と逆。

## 2. The turn-away problem（背を向ける／向きを変える）

> Ref2VA is optimized to match the supplied identity images, which often show a face;
> asking that face to disappear **competes with the identity-match signal**.
>
> 1. **Cut to the reversed state (most reliable)** — 新しいShotを「既に背を向けた状態」で始める。
>    静的な向きは容易、ショット中の回転は困難
> 2. **Enumerate the rotating body parts** — 「腰・肩・頭が揃って回る」と部位を列挙する
>    (でないと頭だけ回して満足される)
> 3. **Describe the end state, not the verb** — 「振り向く」は曖昧。
>    `rotating from front view, through left profile, to full back view` と経由と終端を書く
> 4. **[COMMUNITY] Release the face in retention_analysis** — 顔が見えるショットだけ強い保持にする
>    (**per-Shot retention split**)

**本作との差分:** カメラ180°ロールが3回とも出なかった問題に直結。
「回転」を動詞で書いていた。**終端状態を書く / 部位を列挙する / 反転済みの状態でカットする**
のいずれも試していない。

## 3. Negatives are soft

> **[TESTED]** Prohibitions written in prose are **intermittently ignored**.
> `"No background music."` at the end of a prompt was dropped in community testing,
> while **`non_diegetic_music: N/A` in its proper field held**.
>
> State the desired **positive end-state in the right field** instead of prohibiting things in prose.
> The docs never promise negative-phrase control.
>
> **Exception:** orientation locks are the documented case where an explicit negative works,
> **because it is paired with a positive anatomical statement**:
> `"her feet, hips, shoulders and head remain oriented in the same direction; she does not track the camera."`

**本作との差分:** 本作の実測「内容否定は逆効果/様式否定は安全」と方向は一致。
追加の知見は **「散文で禁じるな。正しいフィールドに肯定形で書け」** という点と、
**否定が効くのは肯定的な身体記述とペアのときだけ**という条件。

## 4. Behavior beats aesthetics

> Observable physical instruction outperforms intent language.
> - **Works:** `her feet, hips, shoulders and head remain oriented in the same direction`
> - **Underperforms:** `realistic, cinematic quality, don't look AI, 4k, masterpiece`
>
> Quality tokens are **diffusion-image habits**. H3 conditions on described behavior;
> a word like "stunning" describes your reaction, not anything the camera can see.
> **Style belongs in the style label at the head of Shot 1, not sprinkled through the action.**

**本作との差分:** `Premium cinematic anime compositing.` `Luminous rim lighting...` `Cinematic colour
grading with rich blacks...` を本文各所に散らしていた。**Shot 1の頭のスタイルラベルへ集約すべき。**

## 5. Reference jobs and ownership ★

> **Every active reference should have one declared job**: what source contributes which attribute
> to which target, and what must remain controlled elsewhere.
>
> Mental model: **source → contribution → target → boundaries**
>
> Two sources can reinforce the same attribute when they agree, but **competing independent
> authorities can reduce adherence**.
>
> (別項)**Unassigned references get mined for whatever the model finds useful, which is how
> the wrong element gets copied and styles bleed between subjects.**

**本作との差分:** **「なぎさがまどかの弓を持った」の機序そのもの。**
役割未宣言の参照は「使えそうなもの」を勝手に採られる。参考007の役割宣言と同じ結論。

## 6. Canonical labels in instructional prose

> In Ref2VA, use canonical labels such as `<Subject 1>`, `<Picture 2>`, `<Video 1>`
> when instructional prose refers to defined references.
> **The label is the stable routing identity H3 sees** across the structured prompt.
> - Prefer: `<Subject 1> runs toward <Subject 2>.`
> - Avoid in instructional prose: `Jane runs toward John.`

**本作との差分:** 本文で `the blue-haired girl` のような散文ハンドルを使っていた。
参考004の「2語ハンドル」は有効だったが、**Ref2VAでは `<Subject N>` ラベルのほうが
ルーティングとして確実**という主張。要A/B。

## 7. Cuts vs. camera moves ★

> **[OFFICIAL] A cut must introduce new information: a new subject, space, state, viewpoint, or time.**
> If only distance or angle changes, **use camera motion instead**.
> **Misused cuts get merged or ignored, which usually reads as the model "skipping" your second shot.**
> Reaching for a tighter framing of the same subject in the same place is **a push in, not a cut**.

**本作との差分:** **「中盤の4人が消えた」「指定したカットが出ない」の説明になっている。**
同じ人物・同じ場所で寄りを変えるだけのカットを多数書いていた → 統合・無視される。

## 8. Resolution vs. adherence ★★（私の判断と逆）

> **[TESTED]** Multiple community reports confirm H3 follows Ref2VA, keyframe, and shot guidance
> **significantly better at 352–416p than at 768p**.
> **More resolution means quadratically more visual tokens competing with your text.**
> Extra steps at the same seed polish the image but **do not recover ignored instructions**.
>
> For adherence-critical shots: **prove the prompt at ~416p, then re-run or upscale**
> rather than fighting at 768p.

**⚠ 本作との差分:** 私は2026-08-22にT1プリセットを **640×368(368p) → 960×544(544p)** へ変更し、
368pを「公式規定(短辺768)割れ」と評価した。**この知見が正しければ、あれは改悪**。
368pは指示追従が最も効く帯だった可能性がある。
また、本番を1344×768+参照9枚+2万字で回していたのは**最悪の組み合わせ**だったことになる。
**要検証(下の提案A)。**

## 9. One variable per retry

> When a prompt fails, change exactly one thing — an orientation clause, a retention marker,
> the resolution — so you can attribute the fix. **Multi-edit retries teach you nothing.**

**本作との差分:** v3で参照とプロンプトを同時に変えて原因を切り分けられなくした前科あり。

---

## ツールが実装している検証項目（lint）

1. Audio prohibition written in prose（音の禁止を散文で書いている）
2. Camera behavior has more than one authority（カメラの権限が複数ある）
3. Camera motion has two different instructions（カメラ運動の指示が2つ矛盾）
4. **Cut may not introduce new information**（そのカットは新情報を導入していない）
5. **Pronoun may be ambiguous with multiple Subjects**（複数Subject下で代名詞が曖昧）
6. **Rear-facing action competes with fully_preserved retention**（背面の動作と完全保持の競合）
7. **Reference jobs and ownership**（役割未宣言の参照）

いずれも助言であってブロックしない設計。個別に非表示にできる。
