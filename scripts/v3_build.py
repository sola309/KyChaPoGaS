#!/usr/bin/env python3
"""v3プロンプトをCodexに執筆させる（監督=Claude / 実作業=Codex）。

各単位に必要な材料をこちらで抽出して渡す。Codexにファイルを読ませない
（サンドボックスが壊れているのと、読ませると必読漏れが検知できないため）。

  python3 scripts/v3_build.py --units U01 U02 ... [--parallel 4]
  python3 scripts/v3_build.py --all --parallel 4

出力: docs/anipafe2026-prompts-v3/<unit>.txt （プロンプト本文のみ）
      scratchpad/v3_notes/<unit>.md （Codexの自己申告）
"""
import argparse, importlib.util, json, os, re, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs/anipafe2026-prompts-v3"
SCRATCH = Path("/tmp/claude-1000/-home-kigarashi309-workspace-projects-KyChaPoGaS/"
               "90c4bd2b-b848-43d4-8569-f00bf3f48772/scratchpad/v3_notes")
CODEX = os.path.expanduser("~/.npm-global/bin/codex")

MG_HEAVY = {7, 11, 16, 17, 21, 24, 30, 52, 56, 57, 61, 62, 63, 64}


def load():
    pk = json.load(open(ROOT / "docs/anipafe2026-cut-packets.json"))
    cuts = {c["n"]: c for c in pk["cuts"]}
    spec = importlib.util.spec_from_file_location("su", ROOT / "scripts/submit_unit.py")
    m = importlib.util.module_from_spec(spec)
    sys.argv = ["x"]
    spec.loader.exec_module(m)
    m.PDIR = m.PDIR_V2
    return cuts, m.parse_units(), m


def noir_text():
    t = open(ROOT / "docs/prompt-refs/001-noir-editorial.md").read()
    mm = re.search(r"## 原文.*?```\n(.*?)\n```", t, re.S) or re.search(r"```\n(.*?)\n```", t, re.S)
    return mm.group(1)


def brief_for(uid, cuts, units, v2code):
    """1単位ぶんの指示書。前後関係と伏線を必ず載せる（全体整合のため）。"""
    u = units[uid]
    ns = [int(x) for x in re.findall(r"C(\d+)", u["head"].split("(")[0])]
    off, hits, bu, marks = 0.0, {"snare": [], "kick": [], "cymbal": []}, [], []
    intents, lyr = [], []
    for n in ns:
        c = cuts[n]
        for k in hits:
            hits[k] += [round(off + t, 3) for t in c["hits"].get(k, [])]
        for b in c["manual_buildups"]:
            bu.append((round(b["start_sec"] - c["sec"][0] + off, 3),
                       round(b["end_sec"] - c["sec"][0] + off, 3)))
        if off:
            marks.append(round(off, 3))
        intents.append(f"C{n}: {c['intent']}")
        lyr.append(c["lyrics"] or "(歌詞なし)")
        off += c["dur"]

    # 前後のカット（全体の流れを保つため）
    prev_n, next_n = ns[0] - 1, ns[-1] + 1
    ctx = []
    if prev_n in cuts:
        ctx.append(f"【直前 C{prev_n}】{cuts[prev_n]['intent'][:150]}")
    if next_n in cuts:
        ctx.append(f"【直後 C{next_n}】{cuts[next_n]['intent'][:150]}")
    # 設計リンク（伏線と回収）
    links = sorted({x for n in ns for x in cuts[n]["links"]})
    for L in links:
        if L in cuts:
            ctx.append(f"【リンク C{L}】{cuts[L]['intent'][:150]}")
    back = [n for n, c in cuts.items() if any(x in ns for x in c["links"]) and n not in ns]
    if back:
        ctx.append(f"【このカットを参照している側】{', '.join('C'+str(x) for x in sorted(back))}")

    mg = "★このカットはMG重点指定。窓・マスク・ワイプ・Z順を主役に据える" if set(ns) & MG_HEAVY else \
         "MGは控えめでよい。光と芝居が主役"
    return f"""単位 {uid} のH3映像プロンプトを書いてください。

## このカット
- 担当カット: {'+'.join('C'+str(n) for n in ns)} / 実尺 {round(off,2)}秒 / 生成 {u['frames']}フレーム
- 歌詞: {' / '.join(lyr)}
- モード: {u['mode']}
- {mg}

## 設計意図（⚠印は確定事項・覆せない）
{chr(10).join(intents)}

## 全体の中での位置（**ここを外すと物語が壊れる**）
{chr(10).join(ctx) if ctx else '(前後リンクなし)'}

## 実測打点（**丸めずに使う**。ショット境界はこの生値に置く）
snare: {hits['snare']}
kick: {hits['kick']}
cymbal: {len(hits['cymbal'])}発
盛り上げ区間: {bu if bu else 'なし'}
{'内部カット境界（統合単位）: ' + str(marks) if marks else ''}

## 参照画像（役割は自分で決めてよいが storyboard anchor は禁止）
{u['refs'][:9]}
⚠ 参照に `storyboard anchor` / `target frame` の役割を与えると**構図が固定され動かない映像**になる。
既定は `subject definition only, not a target frame and not a storyboard anchor`。

## 既存版（v2）— これを土台に、上の規則で作り直す
{v2code}

## 出力形式（この形ちょうど。前置き不要）
<<<PROMPT>>>
(プロンプト本文のみ)
<<<END>>>
<<<NOTES>>>
(a)前後カットとの繋がりをどう作ったか (b)設計リンクの伏線/回収をどう入れたか
(c)実測打点の使用箇所 (d)自信のない点
<<<END>>>
"""


def run_one(uid, rules, brief):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(rules + "\n\n" + brief)
        path = f.name
    try:
        # 10万字級を引数で渡すと Argument list too long になるため標準入力から渡す
        r = subprocess.run(
            [CODEX, "exec", "-m", "gpt-5.6-sol",
             "-c", "model_reasoning_effort=high",
             "--skip-git-repo-check", "--sandbox", "read-only", "-"],
            stdin=open(path), capture_output=True, text=True, timeout=1800)
        out = r.stdout
    except subprocess.TimeoutExpired:
        return uid, None, "timeout"
    finally:
        os.unlink(path)
    # 指示文のエコーを避けるため最後の出現を取る
    ps = re.findall(r"<<<PROMPT>>>\s*(.*?)\s*<<<END>>>", out, re.S)
    ns = re.findall(r"<<<NOTES>>>\s*(.*?)\s*<<<END>>>", out, re.S)
    body = next((p for p in reversed(ps) if len(p) > 400), None)
    note = next((p for p in reversed(ns) if len(p) > 80), "")
    return uid, body, note


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--units", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--parallel", type=int, default=4)
    a = ap.parse_args()

    cuts, units, _ = load()
    targets = sorted(units) if a.all else (a.units or [])
    OUT.mkdir(exist_ok=True); SCRATCH.mkdir(parents=True, exist_ok=True)

    dossier = Path("/tmp/claude-1000/-home-kigarashi309-workspace-projects-KyChaPoGaS/"
                   "90c4bd2b-b848-43d4-8569-f00bf3f48772/scratchpad/v3_dossier.txt").read_text()
    rules = (
        "あなたはAniPAFE2026のH3映像プロンプトを書く担当です。監督(Claude)が全数検査します。\n"
        "以下は本作でこれまで蓄積した設計知識の全層です。**すべてを踏まえて**書いてください。\n"
        "特に: 物語の確定事項(層1)/演出原則(層2)/色の規則(層3)/MG辞書(層4)/質感3層とモチーフ3回則(層5)/\n"
        "憲法(層6)/H3の実測知見(層10-11)/参考プロンプトの形式(層13)/名簿の逐語記述(層14)。\n\n"
        + dossier +
        "\n\n⚠ ファイルは読み書きしない。上の資料だけで書く。\n"
        "⚠ プレースホルダ {{TH:*}} {{BEATLAW}} {{DP}} {{ST2}} {{HOMU_ID}} {{UM_ID}} {{ORB_ID}} "
        "{{GEM_ID}} {{QB_ID}} {{EMBLEM_ID}} {{MAJUU_ID}} {{WALP_ID}} {{DOLLS_ID}} は"
        "そのまま書いてよい（投入時に名簿から展開される）。\n"
        "⚠ キャラの外見を自分の言葉で書かず、プレースホルダを使うこと（過去に事故あり）。\n")

    jobs = [(uid, rules, brief_for(uid, cuts, units, units[uid]["code"])) for uid in targets]
    done, fail = 0, []
    with ThreadPoolExecutor(max_workers=a.parallel) as ex:
        for uid, body, note in ex.map(lambda j: run_one(*j), jobs):
            if body:
                (OUT / f"{uid}.txt").write_text(body)
                (SCRATCH / f"{uid}.md").write_text(note or "")
                done += 1
                print(f"✓ {uid}: {len(body.split())}語")
            else:
                fail.append(uid)
                print(f"✗ {uid}: {note}")
    print(f"\n完了 {done}/{len(targets)}  失敗 {fail}")


if __name__ == "__main__":
    main()
