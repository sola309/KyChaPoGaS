# 002 クリムゾン・エディトリアルMG（ゲームPV）

- 提供: ユーザー(2026-08-22)「よさげな出力だったH3プロンプト」
- 出所: https://x.com/Mayz1169/status/2086430481072218307
- 尺: 15秒 / **約2,100字** ← 001(2,969字)よりさらに短い
- 形式: `[Art Style] [Characters] [Storyboard] [Restrictions]` の角括弧ラベル構成

## 原文（改変せず保存）

```
Game promotional PV, 15s. Pure 2D Japanese cel animation combined with abstract Editorial MG composition.

[Art Style]
Minimal crimson visual style. Ultra high-contrast palette of black, deep red, crimson, burgundy, and white, with limited dark gray. Hard-edge cel shading, large solid-color silhouettes, 1–2 shadow layers.
Flat graphic environments with only building outlines, stairs, steel beams, wires, window frames, and geometric blocks. Mix Editorial MG, game UI, sharp lines, rings, warning lines, speed lines, halftone, scanlines, glitch slices, negative space, and graphic deconstruction.

The entire video feels like a constantly reconstructed game poster. Allow tilting, flipping, compression, and distortion. No realistic 3D space.

[Characters]
Female protagonist: black shoulder-length hair, black uniform, long boots, oversized katana. Black silhouette with white skin and red outlines, cold expression.

Villain: gray long hair, black wide-brim hat, black long coat, elegant and hidden in shadows.
[Storyboard]

0–3s
Black background. A crimson diagonal line cuts the screen. The heroine appears as a black silhouette, showing only boots and blade tip. Her step triggers red geometric blocks, warning lines, UI marks, and building outlines.

3–6s
Camera moves along the blade. The heroine shifts between black silhouette, white silhouette, and cel animation. A red-black city rebuilds behind her as rings, rectangles, and speed lines slice, flip, and reshape the frame.

6–10s
Fast MG montage. Sword movement becomes crimson geometric slices, radial lines, glitch blocks, and rotating UI. Black monsters appear only as eyes, claws, and distorted silhouettes. Beats trigger inversion, red flashes, graphic bursts, and freeze frames.
10–13s
Pure red background. The villain sits inside a giant black ring, eyes hidden by the hat. Buildings rotate and rearrange. Heroine and villain silhouettes appear on different geometric planes without direct combat.

13–15s
The city shatters into black-red fragments. The heroine stands at the center with her sword drawn. A giant red disc cracks behind her. Fragments freeze, leaving only her silhouette and a crimson sun before cutting to black.

[Restrictions]
Keep a flat 2D Editorial MG style. No realistic lighting, no 3D cities, no cinematic perspective, no continuous fighting, no fire, no blood, no cyberpunk neon.

All characters, environments, and objects must remain graphic, flat, and silhouette-based. Every frame should look like a premium game poster.
```

## ★ 最大の収穫 — 打点は「時刻」でなく「関係」で書く

> **Beats trigger** inversion, red flashes, graphic bursts, and freeze frames.

**ミリ秒の時刻を1つも書かずに、音と映像の対応を指定している。**

本作は「At 00:05.443 …」形式の打点を40本並べて失敗した(2026-08-22)。
ショット内の正確なタイミングは制御不能というのは実測済みだったのに、
**制御可能な書き方があることに気づいていなかった**。

- ❌ `At 00:05.443 every musket barrel catches the storm-light at once`
- ⭕ `Snare hits trigger hard cuts. Kicks trigger body impacts. Cymbals trigger light bursts.`

**振る舞いの規則**として書けば、モデルは音に合わせて自分で配置する。
正確な位置合わせは⏱時間リマップの仕事。これが役割分担の正しい線。

## ★ シルエット主義

> large solid-color silhouettes / Black silhouette with white skin and red outlines /
> Black monsters appear **only as eyes, claws, and distorted silhouettes** /
> All characters, environments, and objects must remain graphic, flat, and **silhouette-based**

本作でも「人形の顔アップで速度が死ぬ」問題を、否定文でなく
「レンズに近い人形は逆光シルエット」と**肯定で書いて解決した**(v5)。
002はそれを作品全体の様式にまで押し上げている。

ユーザーの「窓構造は文字でなくオブジェクト/シルエットで作る」方針とも直結する。

## その他の採用要素

| 要素 | 原文 | 本作への適用 |
|---|---|---|
| **1フレームの目標を1文で** | `Every frame should look like a premium game poster.` | 全フレームが何に見えるべきかを1文で固定する。本作にこの錨が無い |
| **統一メタファ** | `feels like a constantly reconstructed game poster` | 001の教訓(メタファは1つ)と一致 |
| **影の層数を明示** | `Hard-edge cel shading, 1–2 shadow layers` | セル画らしさの具体的な指定。未使用の強い梃子 |
| **環境の要素を列挙で限定** | `only building outlines, stairs, steel beams, wires, window frames` | 「何を描くか」を名詞リストで閉じる。散文の描写より輪郭が出る |
| **変形の許可** | `Allow tilting, flipping, compression, and distortion.` | 指示ではなく**許可**という書き方。自由度を与える枠 |
| **角括弧ラベル構成** | `[Art Style][Characters][Storyboard][Restrictions]` | H3の6セクションと相性が良い。時刻ブロックは5個 |

## 注意する要素

### Restrictionsの否定文 — 半分は本作の実測と衝突する

本作の実測: **内容の否定は呼び寄せる / スタイル分類の否定は安全**。

- ⭕ 安全: `No realistic lighting` `no 3D cities` `no cinematic perspective` `no cyberpunk neon`
  → いずれも**様式の分類**の否定
- ⚠ 危険: `no continuous fighting` `no fire` `no blood`
  → **具体的な視覚要素**の否定。本作では発光を否定して3/3で発光した前科がある

採るなら肯定へ書き換える(例: `no fire` → `the only light is the golden vortex`)。

### キャラ記述が極端に短い(約20語)

本作は参照画像に**公式設定画**を渡せるので、同じ方針が使えるはず。
公式R2Vテンプレの注記「**参照画像のタグと正確に一致させるのが最良**」とも符合する。
v5では subject_definitions に約1,800字を割いていたが、**画像が持っている情報を
文章で繰り返している**可能性が高い。短いタグ的記述で参照と紐づける方式を試す価値あり。
