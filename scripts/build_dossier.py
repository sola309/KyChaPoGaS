#!/usr/bin/env python3
"""Codex への融合/執筆依頼に渡す「14層の設計資料一式」(dossier)を組み立てる。

これまで dossier は手作業で作って scratchpad に置いていたため、scratchpad が
揮発すると再構築の手順ごと失われた(2026-08-31に実害)。ここでリポジトリ内の
一次資料から機械的に組み立てられるようにし、いつでも再生成できるようにする。

  python3 scripts/build_dossier.py [-o <出力先>]

出力を省くと scratchpad/v3_dossier.txt へ書く(v3_build.py の既定の読み先)。
各層の元ファイルは下の LAYERS で一元管理する。ファイルが増減したらここを直す。
"""
import argparse, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRATCH = Path("/tmp/claude-1000/-home-kigarashi309-workspace-projects-KyChaPoGaS/"
               "90c4bd2b-b848-43d4-8569-f00bf3f48772/scratchpad/v3_dossier.txt")

# (層番号, 見出し, 元ファイル) — v3_build.py の rules 文が参照する層番号に合わせる
LAYERS = [
    (1,  "物語の確定事項(ストーリー)",        "docs/anipafe2026-story.md"),
    (2,  "演出原則",                          "docs/anipafe2026-direction-principles.md"),
    (3,  "色の規則(カラースクリプト)",        "docs/anipafe2026-color-script.md"),
    (4,  "MG辞書(モーショングラフィックス語彙)", "docs/anipafe2026-mg-language.md"),
    (5,  "質感3層とモチーフ3回則(graphic-language)", "docs/anipafe2026-graphic-language.md"),
    (6,  "憲法",                              "docs/anipafe2026-prompt-constitution.md"),
    (7,  "書き直し方針(rewrite policy)",      "docs/anipafe2026-rewrite-policy.md"),
    (8,  "MG重点カット一覧",                   "docs/anipafe2026-mg-heavy-cuts.md"),
    (9,  "様式ブロック(style-blocks)",        "docs/anipafe2026-style-blocks.md"),
    (10, "H3プロンプトの書き方",               "docs/h3-prompt-writing.md"),
    (11, "H3遵守フィールドガイド(実測知見)",   "docs/h3-adherence-field-guide.md"),
    (12, "SKILL(生成単位プロンプト手順)",      ".claude/skills/h3-unit-prompt/SKILL.md"),
]
# 層13: 参考プロンプト5本(逐語)
REF_PROMPTS = ["001-noir-editorial.md", "002-crimson-editorial-mg.md",
               "005-foley-sync-noir-silhouette.md", "006-ref2va-multi-subject-title.md",
               "008-pastel-layered-camera-mv.md"]
BIBLE = "backend/data/bible/0.json"   # 層14: キャスト名簿 description_en


def read(rel: str) -> str:
    p = ROOT / rel
    return p.read_text(encoding="utf-8") if p.exists() else f"(欠落: {rel})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", default=str(SCRATCH))
    a = ap.parse_args()

    parts = []
    for num, title, rel in LAYERS:
        parts.append(f"\n\n========== 層{num}: {title} ==========\n{read(rel)}")

    parts.append("\n\n========== 層13: 参考プロンプト(逐語・形式を借りる相手) ==========")
    for name in REF_PROMPTS:
        parts.append(f"\n----- {name} -----\n{read('docs/prompt-refs/' + name)}")

    # 層14: 名簿の description_en / caution だけを抜き出す(全文だと重すぎる)。
    # 構造: {"cast": [{"key","name","outfits": {"<variant>": {"description_en","caution",...}}}]}
    parts.append("\n\n========== 層14: キャスト名簿(description_en / caution) ==========")
    try:
        bible = json.loads(read(BIBLE))
        for ch in bible.get("cast", []):
            key, name = ch.get("key", "?"), ch.get("name", "")
            for variant, v in (ch.get("outfits") or {}).items():
                if not isinstance(v, dict):
                    continue
                de = v.get("description_en") or v.get("description")
                if de:
                    label = v.get("label", variant)
                    cau = v.get("caution")
                    parts.append(f"\n[{key}:{variant} {name}/{label}] {de}"
                                 + (f"\n  ⚠caution: {cau}" if cau else ""))
        # 物・背景など cast 以外の登録物(あれば)
        for k, entry in bible.items():
            if k in ("cast", "style_rules", "updated", "updated_by", "note", "usage_guide"):
                continue
            if isinstance(entry, dict):
                de = entry.get("description_en") or entry.get("description")
                if de:
                    parts.append(f"\n[{k}] {de}"
                                 + (f"\n  ⚠caution: {entry['caution']}" if entry.get("caution") else ""))
    except Exception as e:
        parts.append(f"\n(名簿の解析に失敗: {e})")

    dossier = "".join(parts).lstrip("\n")
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(dossier, encoding="utf-8")
    print(f"dossier {len(dossier):,}字 / {len(LAYERS)+2}層 → {out}")


if __name__ == "__main__":
    main()
