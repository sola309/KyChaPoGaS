#!/usr/bin/env python3
"""
lora-kit train — kohya sd-scripts で SDXL(Illustrious系)キャラ/衣装LoRAを学習する。

前提: tools/lora-trainer/ に sd-scripts + venv(scripts/install.sh lora で構築)。
出力: tools/comfyui/models/loras/<name>.safetensors(ComfyUIから即使用可)
"""
import argparse
import subprocess
import sys
from pathlib import Path

KIT = Path(__file__).resolve().parent
ROOT = KIT.parent.parent                      # repo/
TRAINER = ROOT / "tools" / "lora-trainer"
SDS = TRAINER / "sd-scripts"
VENV_PY = TRAINER / ".venv" / "bin" / "python"
LORA_OUT = ROOT / "tools" / "comfyui" / "models" / "loras"
DEFAULT_BASE = ROOT / "tools" / "comfyui" / "models" / "checkpoints" / "waiNSFWIllustrious_v170.safetensors"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--base", default=str(DEFAULT_BASE))
    ap.add_argument("--steps", type=int, default=1400)
    ap.add_argument("--dim", type=int, default=16)
    ap.add_argument("--alpha", type=int, default=8)
    ap.add_argument("--lr", default="1e-4")
    ap.add_argument("--te-lr", default="5e-5")
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--resolution", default="1024,1024")
    a = ap.parse_args()

    img_dir = KIT / "datasets" / a.name / "img"
    if not img_dir.exists():
        raise SystemExit(f"データセットがありません: {img_dir}(先に prepare.py)")
    if not VENV_PY.exists():
        raise SystemExit("学習環境がありません。`./scripts/install.sh lora` を実行してください")
    LORA_OUT.mkdir(parents=True, exist_ok=True)

    cmd = [
        str(VENV_PY), str(SDS / "sdxl_train_network.py"),
        "--pretrained_model_name_or_path", a.base,
        "--train_data_dir", str(img_dir),
        "--output_dir", str(LORA_OUT),
        "--output_name", a.name,
        "--resolution", a.resolution,
        "--enable_bucket", "--min_bucket_reso", "512", "--max_bucket_reso", "1536",
        "--network_module", "networks.lora",
        "--network_dim", str(a.dim), "--network_alpha", str(a.alpha),
        "--train_batch_size", str(a.batch),
        "--max_train_steps", str(a.steps),
        "--learning_rate", a.lr,
        "--text_encoder_lr", a.te_lr,
        "--lr_scheduler", "cosine", "--lr_warmup_steps", "100",
        "--optimizer_type", "AdamW",              # bitsandbytes非依存(aarch64安全)
        "--mixed_precision", "bf16", "--save_precision", "bf16",
        "--gradient_checkpointing",
        "--caption_extension", ".txt", "--keep_tokens", "1",
        "--shuffle_caption",
        "--save_model_as", "safetensors",
        "--save_every_n_steps", "400",
        "--cache_latents", "--cache_latents_to_disk",
        "--sdpa",
        "--seed", "309",
    ]
    print(" ".join(cmd))
    r = subprocess.run(cmd, cwd=SDS)
    if r.returncode == 0:
        print(f"\n完了: {LORA_OUT / (a.name + '.safetensors')}")
        print(f"検証: repo/backend/.venv/bin/python repo/tools/lora-kit/grid.py --lora {a.name} --prompt '...'")
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
