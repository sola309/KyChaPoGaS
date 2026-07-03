#!/usr/bin/env python3
"""
lora-kit prepare — datasets/<name>/raw/ の画像に WD14 タグを付け、
kohya 形式のデータセット(datasets/<name>/img/<repeats>_<trigger>/)を作る。

タガー: SmilingWolf/wd-swinv2-tagger-v3 (onnxruntime; 初回にHFから自動DL)
キャプション: "<trigger>, <base_tags>, <wd14タグ...>"(keep_tokens で trigger を保護)
"""
import argparse
import csv
import shutil
from pathlib import Path

KIT = Path(__file__).resolve().parent
DATASETS = KIT / "datasets"
TAGGER_REPO = "SmilingWolf/wd-swinv2-tagger-v3"


def download_tagger() -> tuple[Path, Path]:
    from huggingface_hub import hf_hub_download
    model = Path(hf_hub_download(TAGGER_REPO, "model.onnx"))
    tags = Path(hf_hub_download(TAGGER_REPO, "selected_tags.csv"))
    return model, tags


def tag_images(files, threshold=0.35, char_threshold=0.75):
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    model_path, tags_path = download_tagger()
    sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    _, h, w, _ = sess.get_inputs()[0].shape
    rows = list(csv.DictReader(open(tags_path)))
    results = {}
    for f in files:
        im = Image.open(f).convert("RGB")
        # pad to square then resize (white bg — WD14 の標準前処理)
        s = max(im.size)
        canvas = Image.new("RGB", (s, s), (255, 255, 255))
        canvas.paste(im, ((s - im.width) // 2, (s - im.height) // 2))
        arr = np.asarray(canvas.resize((w, h)), dtype=np.float32)[:, :, ::-1]  # BGR
        probs = sess.run(None, {sess.get_inputs()[0].name: arr[None]})[0][0]
        tags = []
        for row, p in zip(rows, probs):
            cat = int(row["category"])
            if cat == 0 and p >= threshold:          # general
                tags.append(row["name"].replace("_", " "))
            elif cat == 4 and p >= char_threshold:   # character
                tags.append(row["name"].replace("_", " "))
        results[f] = tags
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--trigger", required=True, help="学習トリガーワード(例: madoka_wr)")
    ap.add_argument("--base-tags", default="", help="全キャプション先頭に入れる固定タグ")
    ap.add_argument("--repeats", type=int, default=10)
    ap.add_argument("--threshold", type=float, default=0.35)
    a = ap.parse_args()

    raw = DATASETS / a.name / "raw"
    files = sorted(p for p in raw.glob("*") if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"))
    if not files:
        raise SystemExit(f"画像がありません: {raw}")
    out = DATASETS / a.name / "img" / f"{a.repeats}_{a.trigger}"
    out.mkdir(parents=True, exist_ok=True)

    print(f"タグ付け中… {len(files)}枚")
    tags = tag_images(files, a.threshold)
    for i, f in enumerate(files):
        dst = out / f"{i:04d}{f.suffix.lower()}"
        shutil.copy2(f, dst)
        caption = ", ".join(
            x for x in [a.trigger, a.base_tags.strip(", "), ", ".join(tags[f])] if x)
        dst.with_suffix(".txt").write_text(caption)
        print(f"  {dst.name}: {caption[:110]}")
    print(f"完了: {out}(train.py --name {a.name} で学習)")


if __name__ == "__main__":
    main()
