# mesh_avatar: 一枚絵をメッシュで動かす(さくら再現 v20〜・POLISH9)

[Mesh Avatar Studio](https://github.com/shinshin86/mesh-avatar-studio)(MIT・Yuki Shindo)を手元に clone して使う。本体はこのリポジトリに入れていない。

1. 素材の絵(自作の生成絵)から、画面に映る範囲を切り出す。位置と倍率は `locate.py <layer> <asset> <root_frame>`(comp 199 のレイヤーと描いたコマを照合)
2. Mesh Avatar Studio の `tools/new-project.py` → リグの下書き(`rig_*.py` が実例。目は 5px の目盛りで読む)→ `validate-rig`・`overlay.py` → `build-layers.py` → `render-poses` で確認
3. `motion_cast.py`(拍 = FEEL/audio.json の beat_this。入りで首が戻る・拍でうなずく・2 小節で揺れる・呼吸)で 1 コマごとの数値を作り、`render-seq-sakura.mjs`(Mesh Avatar Studio の tools/ に置いて動かす)で透明 PNG の連番に
4. 連番を project 37 に登録 → `apply_cast.py` で comp 199 の板を `sequence` に替える直しを polish_align_37.json に書く(戻せる)

ほか: `stiff.py`(映像の急発進・急停止・段・等速)、`keyaudit.py`(キーのつなぎ目の速さの段)、`fastlayers.py`(速いレイヤー = ブラーの候補)、`vrm_hairfix.py`(VRM の当たり判定を大きくした別名の版を作る。元のファイルは上書きしない。VRM 本体はユーザー本人の作で再配布禁止 → 出力を git に入れない)。
パス(/tmp/claude-1000/sakura-rebuild/…)は作業場の物。
