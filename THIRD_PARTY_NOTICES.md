# サードパーティ・ライセンス通知

## リポジトリに同梱しているもの

| 同梱物 | 場所 | ライセンス |
|---|---|---|
| M PLUS Rounded 1c / Mochiy Pop One / Yusei Magic (フォント) | `tools/mad-kit/fonts/` | SIL OFL 1.1(`fonts/OFL.txt` 参照)。同梱・再配布可 |
| PixiJS / pixi-filters | `tools/mg-libs/` | MIT |
| GSAP (gsap.min.js) | `tools/mg-libs/` | GSAP Standard License(Webflow)。2025年以降すべての用途で無償。GSAP自体を製品として再販することのみ不可 |

npm / pip 依存(React, FastAPI, Playwright ほか)は各パッケージマネージャ経由で取得され、
MIT / BSD / Apache-2.0 系です(同梱していません)。

## ユーザーが各自インストールするもの(リポジトリには含まれない)

セットアップスクリプト(`scripts/install.sh`, `scripts/install_models.py`)は以下を**ユーザーの環境に**
ダウンロードします。本リポジトリはこれらを再配布しません。

| ソフトウェア/モデル | ライセンス | 備考 |
|---|---|---|
| ComfyUI | GPL-3.0 | 独立プロセス(HTTP連携)。本アプリとはプロセス分離 |
| Wan 2.2 (動画生成モデル) | Apache-2.0 | |
| ACE-Step (音楽生成) | Apache-2.0 | |
| Ollama / 各種LLM | MIT / モデル毎 | モデルは各配布元のライセンスに従う |
| GPT-SoVITS | MIT | |
| WAI-illustrious-SDXL 等のCivitaiモデル | モデル毎(Illustrious系ライセンス等) | **要確認**: 各モデルページの利用条件(商用可否・生成物の扱い)に従うこと。DLには各自のCIVITAI_TOKENが必要 |
| FLUX.1 Dev | FLUX Dev 非商用ライセンス | gated model(HuggingFaceログイン必須) |

## 生成物について

画像・音楽・動画の生成物の権利や利用条件は、**使用したモデルのライセンスに従います**。
特にキャラクターの二次創作物を生成・公開する場合は、権利者のガイドラインに従ってください。
