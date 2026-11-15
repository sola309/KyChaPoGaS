# 3Dプリビズを用いた生成動画のタイミング・カメラ制御調査

調査日: 2026年11月15日。2025〜2026年の一次資料を優先し、2024年以前は基礎技術として必要なものだけ含めた。以下では「確認済み事実」と「設計上の推論・推奨」を明示的に分ける。

## 結論の要約

**確認済み事実**

- 「簡素な3Dシーンで人物・物体・カメラを先にブロッキングし、深度・骨格・輪郭などをComfyUIへ渡して生成映像にする」という仮説そのものに、2026年の研究システム **PrevizWhiz** がほぼ完全に一致する。React Three Fiberによる3D画面、キャラクター／カメラ軌道、深度・骨格・バウンディングボックス・輪郭の書き出し、Wan 2.1・Wan Fun Control・VACEによる生成まで実装されている。[PrevizWhiz](https://arxiv.org/abs/2602.03838)

- 低品質な無着色3Dアニメーションを最終スタイル動画へ変換する手法は、研究上は **Generative Rendering / 3D-guided video generation / mesh-to-video / generative previs** など複数の名称で存在する。分野全体の統一名称はまだ定着していない。[Generative Rendering](https://openaccess.thecvf.com/content/CVPR2024/papers/Cai_Generative_Rendering_Controllable_4D-Guided_Video_Generation_with_2D_Diffusion_Models_CVPR_2024_paper.pdf) [Diffusion as Shader](https://igl-hkust.github.io/das/) [PrevizWhiz](https://arxiv.org/abs/2602.03838)

- 現時点で最も実用的なのは、RGBの灰色人形をそのままRef2Vへ入れる方式ではなく、**同一3Dアニメーションから「深度＋Pose」と「カメラ軌道」を分離し、キャラクター／衣装は別の設定画で指定する方式**である。MiniMax H3 Fun ControlNet、VACE、LTX IC-LoRAはこの分離に利用できる。[MiniMax H3 Fun ControlNet 2.0](https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union-2.0) [VACE公式ComfyUI手順](https://github.com/Comfy-Org/docs/blob/main/tutorials/video/wan/vace.mdx) [LTX IC-LoRA](https://docs.ltx.io/open-source-model/usage-guides/ic-lo-ra/)

**設計上の推論**

- 音ハメでは、生成モデルに「音を聴かせて拍を理解させる」より、音源解析結果を3D側のキーフレームに確定的に焼き込み、そのフレーム列をControlNetへ渡す方が再現性は高い。
- 人物の動作タイミングはPose、画面全体の移動・遮蔽・パースはDepth、カメラは数値軌道または点群レンダで受け持たせるのがよい。
- 衣装替えでは、三案のうち **(ii) 顔のない灰色素体からDepth＋Poseを抽出し、衣装設定画をRef2VAへ渡す方式**が、カメラ忠実度と衣装自由度のバランスが最もよい。

---

## 1. 「3Dプリビズ → 生成」の実例と分類

### 1.1 直接該当する研究・実装

| 手法 | 確認できた内容 | 判定 |
|---|---|---|
| **PrevizWhiz（CHI 2026）** | 粗い3D空間で人物・物体・カメラを配置し、タイミングと軌道を編集。React Three Fiberから深度・骨格・輪郭などをComfyUIへ渡し、Wan/VACE系で生成する。論文自身が衣装・小物・照明のショット間不一致も限界として報告している。[論文](https://arxiv.org/abs/2602.03838) | 仮説に最も直接的 |
| **Generative Rendering（CVPR 2024）** | 無着色の低忠実度3Dアニメーションから、Depth ControlNetとUV／Object ID情報を使ってスタイル動画を生成する。[論文PDF](https://openaccess.thecvf.com/content/CVPR2024/papers/Cai_Generative_Rendering_Controllable_4D-Guided_Video_Generation_with_2D_Diffusion_Models_CVPR_2024_paper.pdf) | 3Dレンダ→生成の基礎例 |
| **CineMaster（2025）** | Blender上で箱状のオブジェクトとカメラをキーフレーム配置し、深度、物体マスク／クラス、カメラ姿勢を条件として動画生成する。[論文](https://arxiv.org/abs/2502.08639) | 3Dレイアウトとカメラに直接該当 |
| **Diffusion as Shader（SIGGRAPH 2025）** | アニメーションメッシュ、3Dトラック、深度から作る点群レンダを利用し、mesh-to-video、モーション転写、カメラ制御を行う。[プロジェクト](https://igl-hkust.github.io/das/) | 直接該当 |
| **Go-with-the-Flow（CVPR 2025）** | 3Dターンテーブルなどから得たオプティカルフローで初期ノイズをワープし、動きだけを生成動画に移す。制御強度をノイズ劣化量で調整できる。[プロジェクト](https://eyeline-labs.github.io/Go-with-the-Flow/) | 3D映像を運動信号として利用 |
| **CameraReference3D** | 中立的な3DシーンからRGB、Depth、Normal、Mask、カメラパスを出し、LTX IC-LoRA、Wan Fun Camera、AnimateDiff CameraCtrlなどへ同じ軌道を渡すComfyUI向け実装。MITライセンス。[GitHub](https://github.com/lovemachine100/ComfyUI-CameraReference3D) | 実用的な個人／コミュニティ実装 |

個人例では、Blenderの簡易セットと人物をDepth＋Poseへ変換し、LTX 2.3 IC-LoRAに渡して動きと構図を維持するワークフローが報告されている。一方で表情・細部品質の乱れもコメントされており、これは再現性未検証のユーザー報告である。[Reddit例](https://www.reddit.com/r/comfyui/comments/1vdqav7/blender_comfyui_ltx23_iclora/)

BlenderのZ-passをVACEのDepth条件に使い、必要に応じてCannyを混ぜる例もある。投稿者は長尺化で品質が落ち、複数の約5秒クリップへ分けた方がよいと報告しているが、これも個人の比較結果である。[Reddit例](https://www.reddit.com/r/comfyui/comments/1pls2vx/trying_to_improve_my_controlled_generation/)

### 1.2 候補技術の仕分け

#### 3Dプリビズの「受け皿」として使えるもの

- **Wan VACE** はDepth、Pose、Edgeなどのコントロール動画と参照画像を受け取れるため、Blender／three.jsのレンダパスを渡せば3Dプリビズ方式になる。ただしVACE自体が3Dエディタを提供するわけではない。ComfyUI公式ノードは `WanVaceToVideo`。[公式手順](https://github.com/Comfy-Org/docs/blob/main/tutorials/video/wan/vace.mdx) [公式リポジトリ](https://github.com/ali-vilab/VACE/blob/main/README.md)

- **MiniMax H3 Fun ControlNet Union 2.0** はCanny、Depth、HED、MLSD、Pose、Scribble、Layout、Grayを単一チェックポイントで扱う。公式ComfyUI手順には `Apply MiniMax H3 Fun ControlNet` がある。[モデルカード](https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union-2.0) [ComfyUI公式手順](https://github.com/Comfy-Org/docs/blob/main/tutorials/video/minimax/minimax-h3-fun-controlnet.mdx)

- **LTX IC-LoRA** はDepth、Pose、Cannyによるフレーム単位の空間制御を提供する。公式手順ではDepthの時間的一貫性や、PoseのFPS一致・欠損キーポイント補間を推奨している。[公式手順](https://docs.ltx.io/open-source-model/usage-guides/ic-lo-ra/) [リポジトリ](https://github.com/Lightricks/LTX-Video)

- **AnimateDiff＋ControlNet** は同じ原理の旧世代構成として使用可能だが、現在の長めの動画や高解像度用途ではVACE、H3 Fun Control、LTX IC-LoRAの方が実用上の優先度は高い。CameraCtrlはAnimateDiff上にも実装されている。[CameraCtrl](https://arxiv.org/abs/2404.02101)

#### カメラ／軌跡制御だが、単独では3Dプリビズ変換ではないもの

- **Uni3C** はWan 2.1系へ3D点群レンダとカメラ条件を与え、カメラと人間モーションを統合制御する。ComfyUI本体には `Apply Wan Uni3C ControlNet` があり、点群ワープレンダをガイド動画として使う。[公式リポジトリ](https://github.com/alibaba-damo-academy/Uni3C) [ComfyUIノード文書](https://github.com/Comfy-Org/embedded-docs/blob/main/comfyui_embedded_docs/docs/WanUni3CControlnetApply/en.md)

- **CameraCtrl** はカメラ姿勢を数値化して専用モジュールへ入れる方式で、人物の灰色プリビズを変換するものではない。[論文](https://arxiv.org/abs/2404.02101)

- **MotionCtrl** は物体モーションとカメラモーションを制御するが、3Dレンダをスタイル変換するシステムではない。[公式リポジトリ](https://github.com/TencentARC/MotionCtrl/blob/main/README.md?plain=1)

- **ATI** はWan 2.1上で点の軌跡を編集し、局所物体運動とカメラ運動を統一的に制御する。3Dプリビズから点を抽出して渡す用途には使える。[公式リポジトリ](https://github.com/bytedance/ATI)

- **MagicMotion** はマスク、箱、疎な軌跡で物体運動を指示する方式であり、完全な人体プリビズより「注目点の運動」に向く。[論文](https://arxiv.org/abs/2503.16421)

#### 既存動画の再カメラ化

- **ReCamMaster** と **TrajectoryCrafter** は、既存動画を別カメラ軌道から撮り直す用途で、プリビズからキャラクター映像を生成する方式とは別系統である。ReCamMasterは公開Wan版と論文デモのモデル差に注意が必要で、TrajectoryCrafterは大きな視点変更や深度誤差を限界として挙げている。[ReCamMaster](https://github.com/KlingAIResearch/ReCamMaster) [TrajectoryCrafter論文](https://openaccess.thecvf.com/content/ICCV2025/papers/Yu_TrajectoryCrafter_Redirecting_Camera_Trajectory_for_Monocular_Videos_via_Diffusion_Models_ICCV_2025_paper.pdf)

- TrajectoryCrafterの公開ライセンスは研究・教育用途中心で、一般的なApache/MIT型の自由な制作利用とは異なる。[ライセンス](https://github.com/TrajectoryCrafter/TrajectoryCrafter/blob/main/License)

#### クラウド製品・隣接機能

- **Autodesk Flow Studio（旧Wonder Studio）** は3D人物・カメラ・環境を先にステージングし、生成処理へ渡せるため概念上は直接該当するが、クラウド製品である。[公式ページ](https://www.autodesk.com/products/flow-studio/overview)

- **Intangible** は3DシーンからRunway Gen-4.5動画を生成する統合を2026年に公開したが、これもクラウド依存である。[更新履歴](https://studio.intangible.ai/updates)

- **Runway Act-Two** と **Kling Motion Control** は人物のパフォーマンス動画をキャラクターへ転写する方式であり、3D人形動画も入力候補にはなるが、ローカルでは動かない。[Runway](https://help.runwayml.com/hc/en-us/articles/42311337895827-Performance-Capture-with-Act-Two) [Kling](https://kling.ai/quickstart/motion-control-user-guide)

- **Luma Ray3 Modify** は入力動画への忠実度と再解釈の強さを調整できるが、再解釈を強めるほど入力カメラ保持が弱くなると公式説明されている。[公式ガイド](https://lumalabs.ai/learning-hub/ray3-modify-user-guide)

- **Veo** は参照画像、カメラ制御、物体のモーションパスを備えるが、ローカル利用や任意のDepth／Pose入力は確認できない。[公式ページ](https://deepmind.google/models/veo/?_sm_nck=1)

- **Sora Storyboard** は歴史的には隣接するが、SoraのWeb／アプリは2026年4月26日、APIは同年9月24日に終了しており、現在の候補にはならない。[OpenAI告知](https://help.openai.com/en/articles/20001152-what-to-know-about-the-sora-discontinuation)

---

## 2. 制御信号の比較

以下の星評価は、共通ベンチマークの実測値ではなく、各信号が保持する情報量と公開事例から導いた**設計上の推論**である。

| 信号 | 人物の緩急 | カメラ忠実度 | 参照漏れ | 評価 |
|---|---:|---:|---:|---|
| (a) 灰色人形RGB | ★★★ | ★★★ | 非常に高い | 全情報が入る反面、灰色・裸・顔なし・元衣装の形まで画として解釈されやすい。H3用コミュニティ実装でも「無着色3Dをそのまま入れると無着色キャラになる」と説明されている。[H3 Fun Controlノード](https://github.com/wyzborrero/ComfyUI-H3-FunControl) |
| (b) Depth | ★★★★ | ★★★★ | 低い | シルエット、奥行き、遮蔽、カメラ移動を保つ。顔や服の色は漏れにくいが、素体の体積・衣服シルエットは残る。[VACE](https://github.com/Comfy-Org/docs/blob/main/tutorials/video/wan/vace.mdx) |
| (c) OpenPose/DWPose | ★★★★★ | ★ | 最小 | 関節の開始・停止には強い。体積、指、顔、遮蔽、背景カメラは弱い。高速な腕・手の動作を落とすとのDensePose利用者報告もある。[ユーザー報告](https://www.reddit.com/r/StableDiffusion/comments/1vrrrab/minimax_h3_is_seems_to_be_able_to_process/) |
| (d) Normal | ★★★★ | ★★★★ | 中程度 | 面方向と形状をDepthより強く拘束できるが、素体の筋肉・服の皺まで写しやすい。CameraReference3DはNormal出力を提供する。[CameraReference3D](https://github.com/lovemachine100/ComfyUI-CameraReference3D) |
| (e) Canny／線画 | ★★★★ | ★★★ | 高い | 輪郭位置は正確だが、元衣装・顔・人形のエッジが最も残りやすい。H3 Fun Controlが正式に対応する。[モデルカード](https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union-2.0) |
| (f) ID／Layoutマップ | ★★ | ★★ | 低い | 人物A、人物B、背景などの分離には強いが、内部関節や速度は表さない。CineMasterは物体マスク／クラスを、Generative RenderingはObject IDを利用する。[CineMaster](https://arxiv.org/abs/2502.08639) [Generative Rendering](https://openaccess.thecvf.com/content/CVPR2024/papers/Cai_Generative_Rendering_Controllable_4D-Guided_Video_Generation_with_2D_Diffusion_Models_CVPR_2024_paper.pdf) |
| (g) 点の軌跡 | 注目点は★★★★★ | ★★〜★★★★ | 最小 | 手・頭・物体など選んだ点の加速・停止には非常に強い。疎すぎると身体回転や形状が不明になる。3D背景点を多数使えばカメラ条件にもなる。[ATI](https://github.com/bytedance/ATI) [Go-with-the-Flow](https://eyeline-labs.github.io/Go-with-the-Flow/) |
| (h) カメラ軌道数値 | 人物には無効 | ★★★★★ | なし | カメラだけを分離して制御する最善の信号。CameraCtrlやUni3Cが該当する。[CameraCtrl](https://arxiv.org/abs/2404.02101) [Uni3C](https://github.com/alibaba-damo-academy/Uni3C) |

### 推奨する組み合わせ

1. カメラ: 数値軌道またはUni3C用点群レンダ  
2. 人物全体: Depth  
3. 手足の音ハメ: DWPose／DensePose  
4. キャラクターと衣装: 別の設定画  
5. 複数人物: 必要に応じてID／Layoutマップ

これにより、「カメラ」「身体の体積」「関節タイミング」「見た目」を別々に担当させられる。PrevizWhizも骨格と深度の再合成を行う構成である。[PrevizWhiz](https://arxiv.org/abs/2602.03838)

### 参照漏れを減らす方法

**確認済み**

- H3 Fun ControlNetの `control_context_scale` を下げると制御が弱くなり、0で無効になる。強すぎる制御と弱すぎる制御の中間探索が必要である。[モデルカード](https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union)

- H3の利用者からは、Depthを強くすると元オブジェクト形状が漏れ、弱くすると動きまで失われるという報告がある。[ユーザー報告](https://www.reddit.com/r/StableDiffusion/comments/1waqkwd/minimax_h3_3d_animation_preview_to_a_realistic/)

**推奨**

- RGB人形ではなくDepth／Poseへ変換する。
- 元衣装の裾・スカート・帽子など大きな輪郭を素体から除く。
- Cannyは空間的に軽くぼかすか線を細くする。ただし時間方向のぼかしは停止フレームを壊すので避ける。
- 動作の重要区間だけ制御強度を上げ、それ以外は下げる。
- 顔・衣装は設定画側に任せ、プリビズ側では顔パーツやテクスチャを持たせない。
- DepthとPoseを同時に強くしすぎず、まずDepth 0.5〜0.8相当、Pose 0.8〜1.0相当を探索する。これは実験開始値であり、モデル間で同じ数値を直接比較できるという意味ではない。

---

## 3. 衣装替えに適したガイド

### 比較結論

| 案 | 衣装自由度 | キャラ同一性 | カメラ／体積 | 推奨 |
|---|---:|---:|---:|---|
| (i) 普段着モデル動画＋衣装設定画 | 低〜中 | 中 | 高 | 3位 |
| (ii) 顔なし灰色素体＋設定画 | 高 | 高 | 高 | **1位** |
| (iii) 棒人形／骨＋設定画 | 最高 | 中 | 低 | 2位 |

### (i) 普段着モデル

**推論:** 元衣装のシルエットがDepth、Normal、Canny、RGBに残るため、別衣装の設定画と競合する。特にロングコートから水着、スカートからパンツのように輪郭が大きく変わる場合に不利である。

ただし、(i)の動画からDWPoseだけを取り出せば実質的に(iii)となり、Depthを裸に近い素体へ再投影すれば(ii)へ近づけられる。

### (ii) 顔のない灰色素体

**推論:** カメラ、身体体積、遮蔽、足の接地を保ちながら、顔・髪・色・衣装を設定画へ委ねられるため最もバランスがよい。RGBをそのまま使わず、Depth＋Poseへ変換するのが重要である。

H3用コミュニティ実装では、裸／無着色マネキンのControlNetとキャラクターシートを `MiniMaxH3ReferenceToVideo` で組み合わせ、実キャラクター化する構成が説明されている。[ComfyUI-H3-FunControl](https://github.com/wyzborrero/ComfyUI-H3-FunControl)

### (iii) 骨格だけ

**推論:** 衣装の漏れは最小だが、体格、胸郭、髪、布、身体回転、前後関係をモデルが再推定する必要がある。アップや高速ダンスには有効だが、強いパースの3Dカメラや床との接触ではDepth併用が望ましい。

**推奨構成:** 通常は(ii)のDepth＋Pose。衣装形状が極端に変わるショットだけ(iii)へ切り替える。

---

## 4. 音ハメ、急加速、停止

### 関連研究

- **MTV（NeurIPS 2025）** は音声を発話、効果音、音楽へ分離し、それぞれ口、イベント、ムードの時間条件に使う。[論文](https://proceedings.neurips.cc/paper_files/paper/2025/hash/133239b0506b84c802a12b0e5a764a17-Abstract-Conference.html)

- **Syncphony（ICLR 2026）** は、既存モデルが正確な音映像タイミングを苦手とすることを課題にし、モーション認識損失と音同期ガイダンスを導入する。[論文](https://proceedings.iclr.cc/paper_files/paper/2026/hash/4b43f14df70be3b93e8c415d46df0598-Abstract-Conference.html)

- **MVAA（2025）** は音楽のビート時刻と動画の顕著なモーションピークを対応づけ、キーフレームを配置した後にフレーム条件付き拡散で間を埋める。[論文](https://arxiv.org/abs/2506.18881)

これらから、ビートに合う「顕著なポーズ／速度ピーク」を先に確定し、生成はその間を埋めさせる設計が妥当だと判断できる。

### ローカル向け実装案

1. `librosa.onset.onset_detect` でオンセット、`librosa.beat.beat_track` で拍を検出する。オンセット検出は立ち上がり側へ少し早く出る場合があるため、フレーム単位だけでなくサンプル時刻も保持する。[librosa onset](https://librosa.org/doc/main/auto_tutorials/01-intro/05-onsets.html) [beat_track](https://librosa.org/doc/main/api/generated/librosa.beat.beat_track.html)

2. 24fpsなら1フレーム約41.7msなので、検出時刻を最寄りフレームへ量子化する。

3. three.js／Blender側で次を明示的に作る。

   - 加速: 速度カーブを急勾配にする
   - ヒット: 拍フレームで最大速度または最大姿勢変化
   - 停止: 同じポーズを複数フレーム保持
   - カメラヒット: 拍フレームでパン／ズームを停止
   - 予備動作: ヒット前2〜5フレームに逆方向の小動作

4. DepthとPoseを毎フレーム書き出し、生成へ渡す。停止中も同じ制御フレームを繰り返す。

### 平滑化への対策

**確認済み:** MiniMax H3のネイティブRef2VAが、参照動画の物体・カメラ運動を完全一致で再現するという公式保証や定量評価は見つからなかった。利用者からも、Ref2Vのみでは正確に追従せず、ControlNetを強くすると形状漏れが増えるという報告がある。[ユーザー報告](https://www.reddit.com/r/StableDiffusion/comments/1waqkwd/minimax_h3_3d_animation_preview_to_a_realistic/)

**推奨**

- 最も重要な停止は、Pose／Depthで最低3〜6フレーム完全保持する。
- ガイド側で急変を1フレームだけにせず、直前・ヒット・保持の最低3状態を作る。
- 生成後に速度ピークがずれた場合は、DaVinci ResolveのRetime Curve／Optical Flowで時間を詰め直す。[DaVinci Resolve](https://www.blackmagicdesign.com/products/davinciresolve/edit)
- 追加フレームが必要ならRIFEを利用できる。RIFEは任意時刻補間とアニメ向けモデルを持ち、MITライセンスである。[RIFE](https://github.com/hzwer/ECCV2022-RIFE)
- 停止区間をまたいで補間すると「ぴたっと止まる」が再び滑るため、停止前と停止後を別区間として補間する。

---

## 5. MiniMax H3

### 正式名称と配布

正式な公開名は **MiniMax H3**。公式配布には `MiniMax-H3 Base FL2VA` と `MiniMax-H3 Base Ref2VA` があり、後者が参照画像・動画・音声を受けるローカル向けチェックポイントである。[公式発表](https://www.minimax.io/news/minimax-h3-open-source) [Hugging Face](https://huggingface.co/MiniMaxAI/MiniMax-H3)

したがって「ローカルで動くオープン版」は実在する。ただしOSI型オープンソースではなく、重みは **MiniMax H3 Community License** である。[ライセンス](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)

ライセンスのApplicable Territoryは米国、EU、英国、韓国を除外している。日本は列挙された除外地域には含まれないが、商用利用を含む最終判断では全文確認が必要である。[ライセンス](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)

### 参照動画と構造制御の違い

- ネイティブRef2VAは参照動画から人物、シーン、スタイル、アクション、カメラ、物語構造などを解釈する汎用参照生成であり、Depthや骨格のような決定的なフレーム拘束ではない。[公式配布](https://huggingface.co/MiniMaxAI/MiniMax-H3)

- **MiniMax-H3-Fun-Controlnet-Union-2.0** は別の制御枝で、Depth、Pose、Canny、Layout、Gray等をフレーム単位で与える。24fps固定、フレーム数は `17n+5` に切り下げられ、最大15秒と記載されている。[モデルカード](https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union-2.0)

- したがってH3では、**Ref2VAにキャラクター／衣装設定画、Fun ControlNetにDepth／Pose**を渡すのが本調査の用途に最も近い。

### 非公式知見

- DensePoseを介すと元動画の見た目の漏れは減るが、指や非常に速い手の運動を落とすという報告がある。[Reddit](https://www.reddit.com/r/StableDiffusion/comments/1vrrrab/minimax_h3_is_seems_to_be_able_to_process/)

- 灰色人形のRGBまたは強いDepthだけでは、裸・灰色・元シルエットが残りやすい。キャラクターシートとの同時利用が必要とするコミュニティ実装が存在する。[ComfyUI-H3-FunControl](https://github.com/wyzborrero/ComfyUI-H3-FunControl)

H3ネイティブRef2VAが「速度の急変」「完全停止」を何フレーム精度で保持するかについて、公式の定量資料は確認できなかった。

---

## 6. 1〜3秒の高速MADでの区切り方・つなぎ方

### 推奨ワークフロー

1. 音源全体に対して一つの3Dマスタータイムラインを作る。
2. カメラ軌道、人物のワールド位置、拍マーカーは全ショット共通座標で保持する。
3. 生成単位は完成カットより少し長くし、前後に4〜12フレームのハンドルを付ける。
4. H3では `17n+5` の制約に合わせ、約1.63秒なら39フレーム、約2.33秒なら56フレーム、約3.04秒なら73フレームを基本単位にする。[H3 Fun ControlNet](https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union-2.0)
5. 接続フレームでは前カット末尾と次カット先頭の人物ポーズ、画面上の注目点、カメラ移動方向を一致させる。
6. キャラクター設定画、プロンプトの衣装記述、色指定は全カットで固定する。

### 接続方式

- 拍上のハードカット
- 同一ポーズ／同一画面位置によるマッチカット
- 高速パン中のカット
- 前景物体による全画面オクルージョン
- 白フラッシュ／黒フレーム
- 円形、帯、文字などIDマップ化しやすいモーショングラフィックスによるワイプ

「連続した3Dカメラ」を見せる場合は、ショットごとにカメラを作り直さず、一つの軌道をショット範囲ごとに切り出す。CameraReference3Dは複数セグメントを一つのタイムラインで扱う設計を持つ。[CameraReference3D](https://github.com/lovemachine100/ComfyUI-CameraReference3D)

PrevizWhizは複数ショットで衣装、小物、照明の連続性が崩れることを限界として報告しているため、ショット間の生成だけで完全なシームレス性を期待すべきではない。[PrevizWhiz](https://arxiv.org/abs/2602.03838)

---

## 7. 小規模な比較実験

### 固定条件

- 同一音源、FPS、解像度
- 同一3Dリグ、モーション、カメラ
- 同一キャラクター／衣装設定画
- 同一プロンプト
- 同一モデル、Sampler、Steps
- 同じSeed群を各条件に使用
- 制御強度だけは弱・中・強の3段階

### 比較条件

- A: 普段着モデルのRGB動画＋設定画
- B: 顔なし灰色素体から抽出したDepth＋Pose＋設定画
- C: Poseのみ＋設定画

同じモーションから以下の3ショットを作る。

1. 腕が急加速し、拍で完全停止
2. 全身ジャンプと着地
3. カメラが高速パンし、拍で停止

最初は `3条件 × 3ショット × 4 Seed = 36本`。制御強度を2段階追加すると108本になるため、36本で傾向を見てから拡張する。

### タイミング指標

前景マスク内のオプティカルフロー速度を

\[
v_t=\operatorname{median}_{x\in mask}\|\mathrm{Flow}(I_t,I_{t+1})(x)\|
\]

として求め、次を測る。

- ガイドと出力の速度曲線のPearson／Spearman相関
- 相互相関が最大になる時間ラグ
- 拍から最大速度ピークまでのずれ〔フレーム、ms〕
- 停止後の残留速度面積
- ガイドに対するピーク速度比
- カメラ停止後の背景グローバルフロー

### 同一性・衣装指標

- 顔埋め込みの設定画との類似度
- キャラクター全身の画像埋め込み類似度
- 髪色、服色、袖、襟、裾、装飾の属性一致率
- 元の普段着シルエットが残った失敗率
- 灰色、骨線、Canny線など制御画像由来のアーティファクト率
- 5段階のブラインド人手評価

自動埋め込みだけではアニメ衣装の細部を十分評価できないため、属性チェックと人手評価を併用する。

### 採用基準の例

- 速度曲線相関 0.75以上
- ピークずれ2フレーム以内
- 停止後3フレームの残留速度がガイドの1.5倍以内
- 衣装属性一致率80%以上
- 参照漏れ失敗率10%未満

これらは提案する評価基準であり、既存論文の標準閾値ではない。

---

## 8. 優先して試す価値のある3手法

### 1位: MiniMax H3 Ref2VA ＋ Fun ControlNet Union 2.0

- モデル: `MiniMax-H3 Base Ref2VA`、`MiniMax-H3-Fun-Controlnet-Union-2.0`
- ノード: `Apply MiniMax H3 Fun ControlNet`、Ref2VA系ノード、Depth／DWPose Preprocessor
- 入力: 設定画＋Depth＋Pose
- 理由: 現在の主力モデルをそのまま使い、キャラクター参照とフレーム単位制御を分離できる。
- ライセンス: 両重みともMiniMax H3 Community License。[H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) [ControlNet 2.0](https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union-2.0)

### 2位: VACE-Wan2.1-14B

- モデル: `VACE-Wan2.1-14B`
- ノード: `WanVaceToVideo`、`comfyui_controlnet_aux` のDWPose／Depth系Preprocessor
- 入力: 参照画像＋Depth／Pose／Edge動画
- 理由: 公式ComfyUI手順があり、H3とは独立した比較基準になる。人物アニメーションとFirst/Last Frame制御にも使いやすい。
- ライセンス: VACEリポジトリはApache-2.0。[公式リポジトリ](https://github.com/ali-vilab/VACE/blob/main/README.md) [ComfyUI手順](https://github.com/Comfy-Org/docs/blob/main/tutorials/video/wan/vace.mdx)

### 3位: Uni3C ＋ Wan 2.1 I2V

- モデル: Uni3C camera controller＋Wan 2.1 I2V
- ノード: `Apply Wan Uni3C ControlNet`
- 前処理: `cam_render.py` 等でカメラ軌道に沿った点群レンダを作る
- 理由: 人物タイミングよりも、3Dカメラの数値的忠実度を独立検証できる。H3／VACEのDepthカメラと比較する基準になる。
- ライセンス: Uni3CはApache-2.0。[公式リポジトリ](https://github.com/alibaba-damo-academy/Uni3C) [ライセンス](https://github.com/alibaba-damo-academy/Uni3C/blob/main/LICENSE) [ComfyUIノード](https://github.com/Comfy-Org/embedded-docs/blob/main/comfyui_embedded_docs/docs/WanUni3CControlnetApply/en.md)

次点は **LTX IC-LoRA**。Blender Depth＋Poseの個人例があり、公式手順も整っているが、コードのApache-2.0とモデル重みのCommunity Licenseを分けて確認する必要がある。[LTX-Video](https://github.com/Lightricks/LTX-Video) [IC-LoRA手順](https://docs.ltx.io/open-source-model/usage-guides/ic-lo-ra/)

---

## 確認できなかった事

- MiniMax H3ネイティブRef2VAについて、急加速・完全停止・カメラ軌道の保持誤差を測った公式ベンチマーク。
- MiniMax公式による「3D灰色人形＋衣装設定画→アニメキャラ」の完成ワークフロー。確認できたものはFun ControlNetおよびコミュニティ実装まで。
- NVIDIA GB10でのH3、VACE、Uni3Cの実測速度、最大解像度、最適量子化。メモリ容量だけから実時間性能は断定できない。
- (i)普段着モデル、(ii)灰色素体、(iii)骨格を同一モデル・同一Seedで比較した公開研究。
- 1〜3秒の高速アニメMAD全体を3Dプリビズから生成した、再現可能な公開ComfyUIワークフロー。
- Cuebricが任意の灰色3Dプリビズ動画を動画生成の構造条件として直接受けるという一次資料。
- Runway AlephがDepth／Pose／3Dプリビズを構造条件として受けるという一次資料。Act-Twoのパフォーマンス転写は確認できた。
- Google Flowが任意のDepth／Pose／灰色人形動画を直接受ける機能。Veoの参照画像・カメラ・物体軌道機能までしか確認できなかった。
- 現行H3 Fun ControlNetでNormalまたは任意の色分けObject IDを専用条件として扱う公式対応。2.0のLayout／Grayは確認できたが、Normal／ID専用モードは確認できなかった。
- three.js単体の一般公開ワークフロー。React Three Fiberを使うPrevizWhizは確認できた。