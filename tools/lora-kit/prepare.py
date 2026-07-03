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
    import json
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--trigger", default=None, help="学習トリガーワード(省略時はmeta.json)")
    ap.add_argument("--base-tags", default=None, help="固定タグ(省略時はmeta.json)")
    ap.add_argument("--repeats", type=int, default=10)
    ap.add_argument("--threshold", type=float, default=0.35)
    ap.add_argument("--augment", action="store_true",
                    help="少数素材の水増し: 左右反転 + (12枚未満なら)上半身クロップを追加")
    ap.add_argument("--no-absorb", action="store_true",
                    help="不変タグのトリガー吸収(85%%以上の画像に共通するタグの削除)を無効化")
    a = ap.parse_args()

    # meta.json のデフォルト(スロット方式)
    meta_path = DATASETS / a.name / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    trigger = a.trigger or meta.get("trigger")
    base_tags = a.base_tags if a.base_tags is not None else meta.get("base_tags", "")
    if not trigger:
        raise SystemExit("--trigger を指定するか meta.json に trigger を書いてください")

    raw = DATASETS / a.name / "raw"
    files = sorted(p for p in raw.glob("*") if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"))
    if not files:
        raise SystemExit(f"画像がありません: {raw}")
    out = DATASETS / a.name / "img" / f"{a.repeats}_{trigger}"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    print(f"タグ付け中… {len(files)}枚")
    tags = tag_images(files, a.threshold)

    # 不変タグの吸収: ほぼ全画像(85%+)に付くタグはキャラの恒常特徴 → キャプションから
    # 削除してトリガーワードに学習を吸収させる(新キャラ・少数素材の定石)
    absorbed: set = set()
    if not a.no_absorb and len(files) >= 3:
        from collections import Counter
        cnt = Counter(t for f in files for t in set(tags[f]))
        keep = {t.strip() for t in base_tags.split(",")}
        # 構図・ポーズ・背景系は「同一性」ではないので吸収しない(キャプションに残す)
        COMPOSITION = {"1girl", "solo", "full body", "upper body", "cowboy shot", "portrait",
                       "simple background", "white background", "looking at viewer", "smile",
                       "open mouth", "closed mouth", "standing", "sitting", "blush"}
        absorbed = {t for t, c in cnt.items()
                    if c >= len(files) * 0.85 and t not in keep and t not in COMPOSITION}
        if absorbed:
            print(f"トリガーに吸収(恒常特徴): {sorted(absorbed)}")

    def emit(img, suffix_tags, idx, ext):
        dst = out / f"{idx:04d}{ext}"
        img.save(dst) if hasattr(img, "save") else shutil.copy2(img, dst)
        caption = ", ".join(x for x in [trigger, base_tags.strip(", "),
                            ", ".join(t for t in suffix_tags if t not in absorbed)] if x)
        dst.with_suffix(".txt").write_text(caption)
        return dst

    idx = 0
    from PIL import Image
    for f in files:
        emit(f, tags[f], idx, f.suffix.lower()); idx += 1
    if a.augment:
        for f in files:                                   # 左右反転
            im = Image.open(f)
            emit(im.transpose(Image.FLIP_LEFT_RIGHT), tags[f], idx, ".png"); idx += 1
        if len(files) < 12:                               # 上半身クロップ(顔の学習を強化)
            for f in files:
                im = Image.open(f)
                crop = im.crop((0, 0, im.width, int(im.height * 0.62)))
                if min(crop.size) >= 512:
                    emit(crop, tags[f] + ["upper body"], idx, ".png"); idx += 1
        print(f"水増し後: {idx}枚")
    print(f"完了: {out}(train.py --name {a.name} で学習。少数素材なら --dim 8 推奨)")


if __name__ == "__main__":
    main()
