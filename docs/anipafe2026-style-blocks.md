# AniPAFE2026 幕別スタイルブロック（2026-08-23 制定）

静止画・映像プロンプトが**逐語で共有する**共通ブロック。カットごとに書き直さない(揺れ防止)。
出典: カラースクリプトのブロック値を「光の物理」へ翻訳したもの(憲法第7条)。
検証: 撮影設計版(2924-2931)で4カット同時に世界が揃うことを確認済み。

共通(全幕・全プロンプト末尾):
```
STYLE: 2D Japanese cel animation, hard-edge cel shading, 1-2 shadow layers, flat anime line art.
Do not output any letters, numbers, logos, captions or pseudo-writing.
Do not output any reference sheet's frame, panels, swatches or layout elements.
LENS: the near plane is softly out of focus, the subject is sharp, the far plane is soft.
```

## 序 C1-C3 / 終 C67 (黒・深紫・金)
```
LIGHT: near-black space. The only light is a cold violet glow from high above, falling steeply,
so upward-facing surfaces take a faint violet edge and everything else sinks to black. There is
no fill from below and no warm light except on the single brightest element. Near-black occupies
more than half of the picture. Thin haze separates the depth planes; the farthest plane is
palest. Only the single brightest element blooms.
PALETTE: near-black, deep violet, and cold gold on the one brightest element.
```

## 幕1 C4-C15 (記憶の額縁)
```
LIGHT: the scene keeps its own anime colours but pulled toward cold blue-grey, like a remembered
image. One soft key from the scene's own light source, gentle contrast, and a deep dark vignette
closing every corner like an old picture frame. Highlights stay quiet; only one small point may
bloom.
PALETTE: desaturated cel colours over cold blue-grey.
```

## 幕2偽街 C16-C26 / C31-C34 (黒・菫・磁器白)
```
LIGHT: the only light is a cold VIOLET source low and far to the LEFT, outside the frame. It
rakes almost horizontally, so left-facing surfaces take a hard violet edge and everything turned
away falls to near-black. No fill from below, no warm light anywhere. Near-black occupies about
half the picture. Thin haze separates near, middle and far planes; the far plane sits paler and
lower in contrast. Only the single brightest element blooms.
PALETTE: near-black, violet, porcelain white.
```
※ C18-19のみ世界が#2872(黄金嵐)なので、菫→黄金に読み替えた変種を使う(検証済みの3592系)。

## 日常 C27-C30 (唯一の彩度開放)
```
LIGHT: warm afternoon daylight, soft and even, with gentle cel shadows. Blacks stay open;
almost nothing in the frame is truly dark. Contrast is mild and edges are kind.
PALETTE: warm cel colours in full saturation, cream light.
```
※ C30(崩壊)はこのブロックのまま**被写体だけが異常**、が正(光は無垢のまま)。

## 間奏 C35-C42 (storm-blue・黒)
```
LIGHT: cold storm light from high behind the clouds, blue-grey and directionless, broken by
sudden hard flashes that light everything for a single frame. Between flashes, near-black holds
the lower third of the frame. Thin rain-haze separates the planes.
PALETTE: storm blue, near-black, pale grey; soul-gem colours are the only saturation.
```

## 幕3 C43-C59 (菫+赤の漸増)
```
LIGHT: a cold violet key from the left and, opposing it, a low blood-red rim from the right
that touches only edges and thread-like shapes. Near-black holds about half the frame. Thin
haze between planes; only the brightest element blooms.
PALETTE: near-black, violet, porcelain white, blood red on edges and threads only.
```
※ 赤の面積はC43→C54へ漸増(カラースクリプト)。C49-53で最大へ。

## 水面 C7 / C11 / C56-C57 (白の世界・例外ブロック)
```
LIGHT: a white water surface fills the frame, bright and even, like an overcast sky seen in
still water. Figures read as delicate dark shapes on white; shadows are pale grey, contrast is
low, edges soft.
PALETTE: white, pale grey, and the subjects' own muted colours.
```

## 廻天 C54-C55 / 走馬灯 C60-C64
C54-55: 幕3ブロック+`the golden storm of the fused sky replaces the violet key`(#2872へ接続)。
C60-64: 序ブロック+`fragments of remembered scenes keep their own colours inside the darkness`。
