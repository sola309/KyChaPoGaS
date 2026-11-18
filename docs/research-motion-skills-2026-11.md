# モーション・デザインのスキルと周辺ツールの調査(2026-11-18)

ユーザーが挙げた 20 件のうち、中身を知らなかった 10 件を Codex(--search)で調べた報告。HyperFrames(Apache-2.0・約 86k★・ヘッドレス Chrome で 1 コマずつ seek → FFmpeg・9 スキル)と LottieFiles motion-design-skill(MIT・約 3.3k★・ファイル構成)は Claude が出典を開いて確かめた。そのほかは Codex の報告のまま(未確認)。

調査日：2026-11-18（JST）。スター／フォーク数は同日時点の概数です。

表記は以下のとおりです。

- 【出典あり】リポジトリ、公式サイト、公式ドキュメントで確認できた内容
- 【一般】一般的な技術・ライセンス上の注意
- 【推測】comp-kitへの適用可能性に関する評価

全10リポジトリは存在しました。指定された `hairline.lucasmarkes.com/skills` と `skills.wheresryan.sh/anatomy` も現存し、404はありません。

## 比較概要

| # | 対象 | 種別 | ライセンス | 最終更新の目安 | 規模 |
|---|---|---|---|---|---|
| 1 | motion-design-skill | 汎用Agent Skill・原則集 | MIT | 2026-05-18 | 約3.3k★、242 fork、7 commits |
| 2 | Motion AI Kit | Motion向けSkill＋MCP＋Cursor plugin | SkillはMIT | 2026-10-15 v7.0.1 | 約122★、18 fork、28 commits |
| 3 | Remotion Skills | Remotion公式Agent Skills群 | **明示ライセンスなし** | 2026-11-16 | 約7.4k★、815 fork、13 skills |
| 4 | Hairline | SVGライブラリ＋生成Skill | MIT | 2026-10-14 v0.5.1 | 約4.0k★、245 fork、197 commits |
| 5 | Anatomy | Claude Code中心の大型生成Skill | MIT | 2026-10-18 | 約27.9k★、2.4k fork、153 commits |
| 6 | Anatomy Reveal | 3D分解図・動画生成Skill | MIT | 2026-10-15 | 約117★、10 fork、1 commit |
| 7 | HyperFrames | HTML動画エンジン＋9 Skills | Apache-2.0 | 2026-11-18 push、v0.9.32は11-11 | 約86.1k★、8.0k fork、7,512 commits |
| 8 | three.quarks | three.js粒子・VFXエンジン | MIT | 2026-05-21、v0.17.1 | 約1.2k★、81 fork、378 commits |
| 9 | VFX-JS | HTML要素向けWebGLエフェクト | MIT | mainは2026-11-08更新表示 | 約1.2k★、40 fork、425 commits |
| 10 | Theatre.js | Web用キーフレーム／モーションエディタ | Core Apache-2.0、Studio AGPL-3.0 | 公開repoは2024-08-14 | 約13.0k★、513 fork、1,009 commits |

## 1. LottieFiles/motion-design-skill

【出典あり】実装ライブラリではなく、オープンなAgent Skills形式のモーションデザイン指示パックです。Claude Code専用ではなく、Codex、Cursor等にも対応します。「プロンプト例の寄せ集め」ではなく、エージェントに判断基準を与える体系的な原則集です。[README](https://github.com/LottieFiles/motion-design-skill)、[SKILL.md](https://github.com/LottieFiles/motion-design-skill/blob/main/skills/motion-design/SKILL.md)

構成は明確です。

```text
skills/motion-design/
├── SKILL.md                         # 332行、8段階チェックリスト
├── director/
│   ├── core-philosophy.md
│   ├── decision-framework.md
│   ├── disney-principles.md
│   ├── motion-personality.md
│   ├── emotion-mapping.md
│   ├── choreography.md
│   ├── narrative-structure.md
│   └── context-adaptation.md
├── patterns/
│   ├── entrance-exit.md
│   ├── state-feedback.md
│   ├── ambient-continuous.md
│   └── multi-element.md
└── reference/
    ├── timing-easing-tables.md
    ├── property-selection.md
    ├── quality-checklist.md
    └── troubleshooting.md
```

【出典あり】主題は、時間・イージング・感情と動きの対応、Disneyの12原則のUI向け翻案、stagger、複数要素の振付、モーション人格、品質チェックです。特定ランタイムには依存しません。

【推測】comp-kitでは最も簡単に導入できる「AIエージェント用モーション監督Skill」の土台です。現在のJSON生成Skillの前段に、意図→重さ→所要時間→ease→視線誘導→staggerを決める設計フェーズとして取り込めます。MAD向けにはUI中心の例を、カット、歌詞、画面内階層、音ハメ、連続ショット向けに拡張するとよいです。

【一般】Markdownだけなので決定論への影響はありません。MIT表記を残せばフォーク・改変しやすい一方、Disney原則の説明をそのまま大量転載するより、出典を保持した独自Skillとして差分を加える方が管理しやすいです。

## 2. motiondivision/ai-kit

【出典あり】Motion（旧Framer Motion）チームによる、Web UIアニメーション向けのAgent Skill、Cursor plugin、リモートMCP、視覚的transition editorの集合です。単なる原則・プロンプト集ではなく、実装ガイドとツールルーターです。[リポジトリ](https://github.com/motiondivision/ai-kit)、[Motion Skill](https://github.com/motiondivision/ai-kit/blob/main/plugins/motion/skills/motion/SKILL.md)、[公式説明](https://motion.dev/docs/ai-kit-context)

```text
plugins/motion/
├── .cursor-plugin/
├── agents/
├── assets/
├── rules/
├── mcp.json
└── skills/motion/
    ├── SKILL.md
    ├── best-practices/
    │   ├── index.md
    │   ├── css-or-motion.md
    │   ├── motion.md
    │   ├── react.md
    │   ├── vue.md
    │   └── base-ui.md
    ├── codex/
    ├── css-spring/
    ├── performance-audit/
    └── transition-preview/
```

【出典あり】Skill部分は約12ファイル・33KB。GPUで扱いやすいプロパティ、layout/paint/composite、CSSとMotionの選択、springからCSS `linear()` の生成、MotionScore監査などを扱います。無料のSkillはMITですが、450以上のMotion+サンプル検索や実行時監査の一部はリモートMCP／有料Motion+に依存します。[CHANGELOG](https://github.com/motiondivision/ai-kit/blob/main/CHANGELOG.md)

【推測】comp-kitに有益なのは、実行コードより「パフォーマンス監査Skill」の設計です。AIが生成したJSONを、不要なレイアウト変化、過剰なblur、過密な同時アニメーション、見えないレイヤーの更新などで採点する `comp-score` 的な仕組みに転用できます。

【一般】Motion固有API、React、CSS DOM性能の知識が多く、three.js中心のcomp-kitへ直接コピーしても適用範囲は限定的です。MCP経由の内容は更新・認証・サービス規約に依存するため、決定論的オフライン制作の必須経路には置かない方が安全です。

## 3. remotion-dev/skills

【出典あり】Remotion公式のAgent Skills群です。Claude Code専用ではなく、Codex、Cursor、OpenCode等にも対応します。これは「モーション原則集」より、React動画プロジェクトを作成・プレビュー・レンダー・修正する運用マニュアルに近いSkillスイートです。[リポジトリ](https://github.com/remotion-dev/skills)、[Skills一覧](https://github.com/remotion-dev/skills/tree/main/skills)

主な構成は以下です。

```text
skills/
├── remotion-best-practices/   # 他Skillへのルーター
├── remotion-create/
├── remotion-markup/
├── remotion-studio/
├── remotion-render/
├── remotion-captions/
├── remotion-maps/
├── remotion-interactivity/
├── remotion-docs/
├── remotion-license/
├── remotion-upgrade/
├── remotion-multimedia/
└── remotion-saas/
```

【出典あり】特に `remotion-markup` は63ファイル規模で、3D、音声、映像、字幕、シーン遷移、モーションブラー、Lottie、FFmpeg、タイミング、シーケンス、DOM計測、各種エフェクトなどを個別Markdownに分離しています。`useCurrentFrame()` と `interpolate()` で駆動し、CSS `transition` / `animation` は正しくレンダーされない、と明記しています。[remotion-markup/SKILL.md](https://github.com/remotion-dev/skills/blob/main/skills/remotion-markup/SKILL.md)

【推測】comp-kitのSkill構成に最も参考になるのは、巨大な一枚物を避けた「ルーターSkill＋分野別Skill＋参照ファイル」という分割です。例えば `comp-create`、`comp-markup`、`comp-effects`、`comp-particles`、`comp-3d`、`comp-render`、`comp-review` に分け、JSONスキーマと実例を各Skillから必要時だけ読む構成が適します。

【一般】最大の注意点は、現時点でリポジトリにLICENSEファイルも `package.json` のlicense指定もないことです。この問題は公式Issueでも指摘されています。[ライセンスIssue #28](https://github.com/remotion-dev/skills/issues/28)  
したがって、内容をそのままcomp-kitへ同梱・改変・再配布するのは避け、構造や考え方のみを参考に独自文面で再実装するのが安全です。Remotion本体のライセンスとも自動的に同一とはみなせません。

## 4. lucasmarkes/hairline

【出典あり】Hairline本体は、ポインタに反応する33種類の等角投影ライン図形をDOM／Reactで描くライブラリです。併設されているのは次の2つのAgent Skillです。[リポジトリ](https://github.com/lucasmarkes/hairline)、[Skillsサイト](https://hairline.lucasmarkes.com/skills)

- `hairline-create`：アイデアから新規図形を作成
- `hairline-adopt`：既存SVGを読み、同じ物体をHairline風の立体として再構築

`hairline-create` の構成は概ね次のとおりです。

```text
skills/hairline-create/
├── SKILL.md
├── rules.md                   # 10の厳格な作画・モーション規則
├── concepts.md
├── source.md
├── look.md
├── kernel.js                  # 固定描画・モーションエンジン
├── bench.html
├── build.mjs
├── validate.mjs
├── look.mjs
├── read.mjs
└── examples/
    ├── terrain.js
    └── riffle.js
```

【出典あり】これは原則集だけではなく、エージェントが図形JSを1ファイル書き、build・validate・ブラウザ目視を行い、依存なしのHTMLにまとめる実行型Skillです。[SKILL.md](https://github.com/lucasmarkes/hairline/blob/main/skills/hairline-create/SKILL.md)  
規則には、静止姿勢を設計する、距離でstaggerする、連続入力はspring・離散選択はease、画面外ではループを止める、固定hit areaを使う、などが含まれます。

【推測】comp-kitへは、エンジンより生成・検証ワークフローが有用です。特に「エージェントが編集する範囲を1ファイルに限定」「固定kernelは変更禁止」「機械検査→接触シート→目視」という制約は、JSON生成の暴走防止にそのまま応用できます。

【一般】Hairlineの実行ループは `requestAnimationFrame`、`performance.now()`、spring状態を使うインタラクティブ用途です。動画出力に移植する場合は、wall clockをcomp-kitの絶対フレーム時刻へ置換する必要があります。MITですが、`hairline-adopt` で他社ロゴを扱う場合、生成物の商標権はMITとは別問題です。

## 5. wheresryan22/anatomy

【出典あり】Claude Code向けに書かれた、技術概念を「実在しそうな機械」に変換し、高密度な等角投影SVG／WebGL／3D図として作るAgent Skillです。Codex、OpenCode等にも対応します。プロンプト集ではなく、Skill・描画kit・検査スクリプト・完成例・evalを含む大型制作環境です。[リポジトリ](https://github.com/wheresryan22/anatomy)、[公式サイト](https://skills.wheresryan.sh/anatomy)、[SKILL.md](https://github.com/wheresryan22/anatomy/blob/main/SKILL.md)

```text
anatomy/
├── SKILL.md                   # 185行、約32.8KB
├── kit/
│   ├── iso-kit.mjs / .ts
│   ├── lathe.mjs
│   ├── tube.mjs
│   ├── audit.mjs
│   ├── gl.mjs
│   ├── turn.mjs
│   └── react/
├── references/               # craft、motion、3d、verify、React等
├── scripts/                  # capture、drive、lines、turn-check等
├── examples/                 # 8完成例
├── evals/
├── agents/
└── tests/fixtures/
```

【出典あり】規模は約147ファイル、約5.1万コード行、8完成例。40～80部品のFigure、80～150部品のHero、さらに大きいEpicという見積もり規則があります。純粋モデルから動き・数値表示・説明文を共通駆動し、depth order、部品干渉、配管、線端、4倍拡大での密度まで自動監査します。

【推測】comp-kitに有益なのは「美的品質を機械検査へ落とす」発想です。JSONスキーマに、各要素の目的、支持関係、可視範囲、depth、親子関係、静止画での焦点を持たせ、レンダー後に以下を検査できます。

- 画面外への逸脱
- Z順・透明順の破綻
- 意味のない孤立レイヤー
- 重要要素の遮蔽
- 停止フレームの密度不足
- 数値モデルと表示の不一致

【一般】Node 20.10+とChromeが必要です。インタラクティブspringやWebGL層をそのまま取り込むより、Skillの「Truth first」「モデルを一箇所に置く」「接触シートで全遷移を見る」を採用する方が依存を増やしません。MITです。

## 6. annnguyentt/anatomy-reveal-skill

【出典あり】Anatomyの3D kitを使い、写真または製品名から、分解可能な物体と商品リビール動画を作るAgent Skillです。Claude Code専用ではなく、標準的な `SKILL.md` を読めるエージェントで利用できます。プロンプト集ではなく、動く完成テンプレートとレンダーパイプライン込みです。[リポジトリ](https://github.com/annnguyentt/anatomy-reveal-skill)、[SKILL.md](https://github.com/annnguyentt/anatomy-reveal-skill/blob/main/SKILL.md)

```text
anatomy-reveal-skill/
├── SKILL.md                   # 101行、約9.1KB
├── references/
│   ├── inputs.md
│   ├── objects.md
│   ├── object.md
│   ├── shots.md
│   └── look.md
├── scripts/new-project.mjs
├── template/
│   ├── kit/                   # Anatomyの3D・監査kit
│   ├── object/
│   │   ├── geometry.mjs
│   │   ├── scene.mjs
│   │   ├── film.mjs
│   │   ├── live.js
│   │   └── scan-apart.mjs等
│   ├── motion/
│   │   ├── timeline.mjs
│   │   ├── build.mjs
│   │   ├── render.mjs
│   │   ├── encode.mjs
│   │   └── scan.mjs
│   └── scripts/browser.mjs
├── demo/
└── THIRD_PARTY_NOTICES.md
```

【出典あり】SKILL以外に34の同梱ファイルがあります。100～150部品、30fps、3～60秒、複数アスペクト比、単一連続テイク、whipによるショット遷移、速度に応じて1～40サブフレームを使うモーションブラー、H.264エンコードまで含みます。[同梱ファイル一覧](https://www.typingmind.com/skills/annnguyentt-anatomy-reveal)

【推測】MAD再現には、物体生成部分より次が非常に参考になります。

- `timeline.mjs` にショット・ease・カメラを集約
- `frame(t)` / `pose(state)` の純粋時間評価
- ポーズ一覧、指定時刻stills、全フレームscanの三段階QA
- 速度ベースの適応的モーションブラー
- 長尺化ではholdを引き延ばすだけでなくbeatを増やす

【一般】Node 20+、Chrome／Chromium、FFmpeg、ImageMagick 7、`puppeteer-core` が必要です。MITですが `THIRD_PARTY_NOTICES.md` も保持すべきです。決定論を保つにはChrome・フォント・FFmpeg・ImageMagickのバージョンを固定し、乱数と動画デコード条件も固定する必要があります。

## 7. heygen-com/hyperframes

【出典あり】今回の10件で、comp-kitと設計思想が最も近いプロジェクトです。「HTMLを書き、seek可能なアニメーションをヘッドレスChromeで1フレームずつ描き、FFmpegで動画化」「ビルド不要」「同じ入力から同じフレーム」というエンジンです。[リポジトリ](https://github.com/heygen-com/hyperframes)

主要パッケージは以下です。

- `hyperframes`：CLI
- `@hyperframes/core`：parser、linter、runtime、frame adapter
- `@hyperframes/engine`：Puppeteer＋FFmpegによるcapture
- `@hyperframes/producer`：capture、encode、audio mix
- `@hyperframes/studio`：ブラウザ編集UI
- `@hyperframes/player`：Web Componentプレイヤー
- `@hyperframes/shader-transitions`
- `@hyperframes/aws-lambda`

【出典あり】HTMLの `data-composition-id`、`data-start`、`data-duration`、track属性を読み、GSAP、CSS、Lottie、Three.js、Anime.js、WAAPI、自作adapterをseek可能にします。約450のレジストリ部品と9つのAgent Skillも持ちます。

【推測】丸ごと採用するより、次をcomp-kitへ移植する価値が高いです。

1. `frame adapter` という明示的なseek契約
2. JSON／HTML構文のlintと「壁時計依存」の検出
3. 部品カタログをAIが検索し、ソースとして設置する仕組み
4. `frame.md` のような、Webデザインシステムを動画用に翻訳する層
5. plan→lint→指定フレーム確認→renderというSkill
6. ゴールデンMP4／フレーム差分による回帰試験

【一般】Apache-2.0で商用利用しやすい一方、NOTICE・著作権表示を保持する必要があります。開発にはNode 22、FFmpeg、Puppeteer、テスト用Git LFS資産が絡みます。comp-kitと責務が重複するので、両エンジンを共存させるより、設計・Skill・lint規則を抽出する方が軽量です。

## 8. Alchemist0823/three.quarks

【出典あり】three.js向けの高機能な粒子・VFXシステムです。billboard、stretched billboard、mesh、trail、point/sphere/hemisphere/cone/circle/mesh surface/grid emitter、色・サイズ・回転・force・orbit・texture animation・sub-emitterを持ちます。視覚エディタからJSONを書き出せます。[README](https://github.com/Alchemist0823/three.quarks)、[CHANGELOG](https://github.com/Alchemist0823/three.quarks/blob/master/CHANGELOG.md)

```text
packages/
├── quarks.core       # three.js非依存の数学・生成器・behavior
├── three.quarks      # three.js統合
├── quarks.r3f
├── quarks.nodes      # 実験的node/WebGPU
├── quarks.examples
└── quarks.playground
```

【出典あり】v0.17系ではthree.jsをr182へ上げ、ESM/NodeNext型定義、WebGPU shader、R3F連携を追加しています。comp-kitのr180とは近いものの同一ではありません。

【推測】comp-kitへの直接的な機能追加としては非常に有力です。特に、mesh surface emission、trail、sub-emitter、JSONプリセット、Unity Shuriken風のbehavior構成は、MADで使う火花、破片、軌跡、煙、発光粒子に直結します。

【一般】最大の問題は決定論です。通常APIは `BatchedRenderer.update(delta)` による状態更新で、IntervalValueやRandomColorも乱数を使います。seed同期の要望が未解決Issueとして残っています。[Issue #89](https://github.com/Alchemist0823/three.quarks/issues/89)  
したがって、導入には以下が必要です。

- comp-kit側のseed付きPRNGを全生成器へ注入
- 固定 `dt = 1/fps`
- 任意フレームseek時は0から再シミュレーション、またはsnapshot
- r180/r182差分の固定試験
- CDNまたは事前ビルド済みESMの固定バージョン化

MITなので改変・内蔵はしやすいです。

## 9. fand/vfx-js

【出典あり】画像・動画・テキスト・DOM要素へWebGL shaderを付与するライブラリです。glitch、bloom、pixelate、halftoneなどを合成でき、ページ遷移にはpixel sort、datamosh等があります。React、Vue、Svelte、Astro連携も提供します。[リポジトリ](https://github.com/fand/vfx-js)

```text
packages/
├── @vfx-js/core
├── @vfx-js/effects
├── @vfx-js/transitions
├── @vfx-js/react
├── @vfx-js/vue
├── @vfx-js/svelte
└── @vfx-js/astro
```

【出典あり】`@vfx-js/core@1.0.0` ではthree.js依存を除去し、effect compositionを追加しました。[Releases](https://github.com/fand/vfx-js/releases)

【推測】comp-kitは既に約60エフェクトを持つため、ランタイム導入の優先度は低めです。ただし、エフェクトを小さなクラスとして直列合成するAPI、DOMを一時的にテクスチャ化してtransition終了後に通常DOMへ戻す方式、AI向け `skills/vfx-js` は参考になります。

【一般】DOMキャプチャは決定論上の弱点です。HTML-in-CanvasはChromeの実験的機能に依存し、SVGクローン方式ではWeb font、pseudo-element、canvas等が欠落します。comp-kitではDOMキャプチャを避け、shader本体またはeffect compositionの設計だけを移植する方が安全です。MITです。

## 10. theatre-js/theatre

【出典あり】任意のJavaScript値、Three.jsオブジェクト、HTML／SVGを、視覚的タイムラインとキーフレームで編集するモーションデザイン環境です。`@theatre/core`、`@theatre/studio`、`@theatre/dataverse`、`@theatre/react`、`@theatre/r3f` のモノレポです。[リポジトリ](https://github.com/theatre-js/theatre)

【出典あり】視覚エディタでカメラ、位置、shader uniform等を調整し、状態をJSONとして保存、最終ランタイムでは軽量なCoreだけを再生できます。

【出典あり】ライセンスは注意が必要です。

- `@theatre/core` と多くのパッケージ：Apache-2.0
- `@theatre/studio`：AGPL-3.0

【出典あり】公開リポジトリの最終pushは2024-08-14。READMEでは1.0開発を一時的にprivate repoへ移したと説明しています。[Theatre.js GitHub Organization](https://github.com/theatre-js)

【推測】comp-kitへは、JSONキーフレームデータ、property inspector、カーブ編集、sequence scrub、Three.js uniformの公開方法が参考になります。AI生成JSONを人間が微調整するGUIを作る際の設計資料として価値があります。

【一般】Studioを直接組み込むとAGPLの影響を受け得るため、KyChaPoGaSが非公開・商用アプリなら法務確認が必要です。React/Yarnワークスペース前提で、ビルド不要のcomp-kitへは重い依存です。公開版の保守停止状態とr180互換性も確認が必要なので、コード統合よりデータモデル・UI設計の参考に留めるのが無難です。

## comp-kitへ取り込む価値が高い5件

1. **HyperFrames**

   comp-kitとレンダー方式・ビルド不要・HTML/Three.js・AI Skill・決定論の前提がほぼ一致します。frame adapter、lint、部品レジストリ、ゴールデン回帰試験を直接ベンチマークできます。

2. **Remotion Skills**

   実装コードより、動画制作知識をルーター＋分野別Skillへ分割した構成が有用です。フレーム駆動の徹底や、CSS wall-clockアニメーション禁止規則もcomp-kit用Skillに転用できます。ただし文面のコピーはライセンス不明のため不可寄りです。

3. **LottieFiles motion-design-skill**

   AIがいきなりJSONを書く前に、意図・重さ・時間・ease・stagger・視線誘導を決めさせる層として低コストで導入できます。MITかつ実装非依存です。

4. **three.quarks**

   mesh emission、trail、sub-emitter、JSON VFXはMAD向け機能として直接的です。seed付きPRNGと固定step／seekをcomp-kit側で作り直せるなら、粒子機能を大きく拡張できます。

5. **Anatomy Reveal**

   ショット設計、純粋な `frame(t)`、指定時刻stills、全フレームscan、適応的モーションブラーという制作・QA手順が、AE製MADの再現ワークフローに近いです。物体生成部分を除いても参考価値があります。

総合すると、最優先は「HyperFramesの設計を参照しつつ、LottieFiles＋Remotion型のcomp-kit専用Skill群を作る」ことです。その次にthree.quarks相当の粒子JSONを、seedと絶対時刻評価を前提に取り込むのが効果的です。