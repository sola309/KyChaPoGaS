# feel-kit — 動きの「気持ちよさ」を測る・比べる・検査する

映像の動きを 60fps の 1 コマ単位で数値にし、音(拍・立ち上がり)と突き合わせる道具。
手本の動画と再現の差を「ぎこちない順」に並べる用途と、自作の comp の検査の両方に使う。
分析の結果と原則は `repo/docs/motion-feel.md`。

新しいモデルは入れていない。Python は `repo/backend/.venv/bin/python`(cv2・numpy・scipy・librosa・beat_this・PIL が入っている)で動かす。
ステムは `tools/stem-kit/separate.py --stems-out` の出力をそのまま読む。

## 道具

| ファイル | 何をする | 主な出力 |
|---|---|---|
| `audio_feat.py` | 音から 拍・小節(beat_this)・立ち上がり(全体・低/中/高域・ステムごと)・コマごとの音量と帯域 | `audio.json`(時刻はコマ) |
| `motion_feat.py` | 動画の 1 コマごとの動き(DIS オプティカルフロー): 速さ・面積・向き・全体の相似変換(平行移動/拡大/回転)・残りの動き・明るさ・切り替わり・コマ落ち | `motion.npz` |
| `fit_events.py` | 動きの出来事(止まり → 動き → 止まり)を切り出し、進み具合の曲線をイージングの式に当てはめる(線形・2〜5 次・sine・expo・circ・back・elastic・bounce・加減速)。入りと抜きの比(t50)・行き過ぎと戻り・止まるまでのコマも出す | 表(標準出力)/ JSON |
| `compare.py` | 手本と再現を区間(小節・カット・N コマ)ごとに比べ、ぎこちない順の一覧を作る(速さ曲線の相関・ピークのずれ・量の比・重心の差・がたつき・コマ落ち・切り替わりのずれ) | `cmp.json` `cmp.md` |
| `plot.py curves` | 速さの曲線を拍の線・立ち上がりと重ねた図(PNG。字は PIL) | PNG |
| `plot.py strip` | 連続コマを並べたシート(複数の動画を上下に) | JPG |
| `render_window.py` | comp の一部の区間だけを API で描き出して測る(全編を描かずに直しを確かめる。試験プロジェクト 35 に仮の comp を作って消す) | mp4 / npz |
| `aup_habits.py` | AviUtl のプロジェクト(aup-kit の JSON)から作者の癖を数える(移動方法・イージング・長さ・拍との距離・ずらし・止め) | `habits.json` `habits.md` |
| `lint.py` | 自作 comp の検査。`--doc`/`--comp-id` = 文書の書き方、`--video` = 描き出した動画 | 一覧(JSON / md) |
| `feel_lib.py` | 共通部品(式・当てはめ・出来事の切り出し・拍との距離) | — |

## よく使う流れ

```bash
PY=repo/backend/.venv/bin/python; K=repo/tools/feel-kit
# 1) 音(ステムつき)
(cd repo/tools/stem-kit && .venv/bin/python separate.py SONG.wav --stems-out /tmp/stems)
$PY $K/audio_feat.py SONG.wav --out audio.json --stems /tmp/stems
# 2) 動画を測る(1 分半・1080p60 で約 50 秒)
$PY $K/motion_feat.py ref.mp4 --out ref.npz
$PY $K/motion_feat.py mine.mp4 --out mine.npz
# 3) 比べる → ぎこちない順
$PY $K/compare.py --ref ref.npz --test mine.npz --audio audio.json --out cmp.json --md cmp.md
# 4) 上位の区間を図とコマで見る
$PY $K/plot.py curves --audio audio.json --out fig.png --range 3380 3640 --series 手本=ref.npz 自分=mine.npz
$PY $K/plot.py strip --out strip.jpg --range 3540 3630 --step 5 --videos 手本=ref.mp4 自分=mine.mp4
# 5) その区間の動きがどの式か(手本の実測 → 自分のキーに写す)
$PY $K/fit_events.py ref.npz --range 3385 3640 --chan move --base 3389 --audio audio.json
# 6) 直した comp の区間だけ描いて確かめる
$PY $K/render_window.py --comp 284 --range 0 245 --out win.mp4 --npz win.npz
```

## 自作 comp の検査(lint)

```bash
# 文書だけ(速い。書き方の誤りが分かる)
$PY $K/lint.py --comp-id 123            # か --doc comp.json
# 描き出した動画 + 音
$PY $K/lint.py --video render.mp4 --audio audio.json --md lint.md
```

文書の検査で出る物(さくらの再現 v4 の作り直し comp 127 個では: `linear_chain` 101 か所 / 29 comp、`ease_no_change` 42 / 10、`ease_on_last_key` 17 / 4。直した v5 は 5・1・0):

- `ease_on_last_key` — 最後のキーに書いた加減速。エンジンは「そのキーから次のキーまで」に効かせるので、最後のキーの `e` は何もしない。着地の側に書いたつもりなら **全部の加減速が 1 区間ずれている**。
- `ease_no_change` — 加減速を書いた区間の両端が同じ値。これも 1 区間ずれの印。
- `unknown_ease` — エンジンに無い名前。黙って直線になる。
- `linear_chain` — 位置・拡大・回転のキーが 3 個以上あって全部直線。キーのたびに速さが折れる。`"interp": "spline"` を付ける。
- `linear_move` — 12 コマ以上の直線の動き。ゆっくり流す物(止めのあいだの漂い)以外は加減速を付ける。

動画の検査は粗い(完成版そのものでも `kink` が 18 個出る)。手本があるなら `compare.py` を使うこと。`off_beat`・`cut_off` は「情報」で、直す義務は無い
(さくらの完成版でも、動きの時刻は拍の格子にぴったりは乗っていない。docs/motion-feel.md の 2 章)。

## 数値の意味と限界

- `mag`(速さ)は「動いている画素の平均」。小さい物が 1 個だけ速く動いても、大きい物がゆっくり動いても似た値になることがある → `area`(面積)と掛けた「動きの量 = mag × √area」を曲線に使う。
- 全体の相似変換(`gtx` `gty` `gscale` `grot`)はカメラ・画面全体の動きに向く。物が何層も別々に動く画面では当てにならない(歯車のトランジションで確認)。そのときは `mag` の曲線と連続コマのシートで見る。
- イージングの当てはめは、1 つの物が動く区間でだけ意味がある。重なった動きは「頭が速い / 終わりが速い / 対称」の 3 つに丸めて読む(t50・ピークの位置)。
- 切り替わりの検出は明暗の分布の変化で見ている。白い閃光・ワイプも切り替わりに数える。
- 拍は beat_this(50fps の刻み = ±0.6 コマ)。一定のテンポの曲は `Beats` の拍に直線を当てて格子にすると細かく見られる。
- 手本を測るのは数値(軌跡・速さ・時刻)だけ。絵は使わない。`repo/tools/aup-kit/measured_feel.json` に置いた実測の曲線も速さの数の並びだけ。
