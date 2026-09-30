#!/usr/bin/env python3
"""隣接単位を融合する Codex 依頼ブリーフを機械生成する。

7組一括のような大量融合を、1組ずつ手書きせずに回すため。骨格(尺・素材・音声・
内部境界・打点・カット意図・前後・設計リンク・使えるPH一覧・既存版・dossier)を
一次資料から自動で組み、監督(Claude)は各組固有の「核心」だけを --note で足す。

  python3 scripts/merge_brief.py U24 U25 [--audio inst|vocal] [--note "..."] -o <out>

- 参照が9枚を超えたら中断(手動振り分けが要る)
- I2VA が混じっていたら Ref2VA 化の注記を自動で入れる
- intent の ⚠ 行は「確定事項」として抽出・強調
"""
import argparse, importlib.util, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRATCH = Path("/tmp/claude-1000/-home-kigarashi309-workspace-projects-KyChaPoGaS/"
               "90c4bd2b-b848-43d4-8569-f00bf3f48772/scratchpad")
MG_HEAVY = {7, 11, 16, 17, 21, 24, 30, 52, 56, 57, 61, 62, 63, 64}
LIPSYNC = {14, 15, 45, 46}
PLACEHOLDERS = ("{{TH:PRO}} {{TH:MEM}} {{TH:CITY}} {{TH:DAY}} {{TH:STORM}} {{TH:A3}} {{TH:WATER}} "
                "{{BEATLAW}} {{DP}} {{ST2}} {{LENS}} {{FOCUS}} "
                "{{HOMU_ID}} {{UM_ID}} {{ORB_ID}} {{GEM_ID}} {{QB_ID}} {{EMBLEM_ID}} {{MAJUU_ID}} "
                "{{WALP_ID}} {{DOLLS_ID}} {{HALF_MOON}} {{SOURCELESS_SHADOW}} {{FRAME_A}} {{FRAME_B}} "
                "{{WATER_BASE}} {{SEEOFF}} {{REACH_HAND}}")


def snap(raw):
    n = max(124, min(362, raw))
    return min(362, n + (5 - n % 17) % 17)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("units", nargs="+")
    ap.add_argument("--audio", choices=["inst", "vocal", "none"], default="inst")
    ap.add_argument("--note", default="")
    ap.add_argument("-o", "--out", default="")
    a = ap.parse_args()

    spec = importlib.util.spec_from_file_location("su", ROOT / "scripts/submit_unit.py")
    mod = importlib.util.module_from_spec(spec)
    sys.argv = ["x"]
    spec.loader.exec_module(mod)
    u = mod.parse_units_v3()
    c = mod.cut_ranges()
    cuts = mod.packet_cuts()

    target = u[a.units[0]]["head"]
    ns, refs, modes, olds = [], [], [], {}
    for uid in a.units:
        cs = [int(x) for x in re.findall(r"C(\d+)", u[uid]["head"].split("(")[0])]
        ns += cs
        refs += u[uid]["refs"]
        modes.append(u[uid]["mode"])
        olds[uid] = Path(f"docs/anipafe2026-prompts-v3/{uid}.txt").read_text()
    refs = list(dict.fromkeys(refs))
    if len(refs) > 9:
        sys.exit(f"✗ 参照が {len(refs)}枚 で上限9を超える。先に手動で振り分けが要る: {refs}")

    s0, e0 = c[ns[0]][0], c[ns[-1]][1]
    raw = e0 - s0
    # 生フレームが上限を超えるものは snap() が無言でクランプして末尾を切り落とす。
    # 融合は「尺が入る」ことが前提なので、超過は融合不可として中断する。
    if raw > 362:
        sys.exit(f"✗ 生尺 {raw}f({raw/24:.2f}s) が上限362f(15.08s)を超過。"
                 f"{(raw-362)/24:.2f}秒が失われるため融合不可。この組は単独で残すこと")
    if raw < 124:
        sys.exit(f"✗ 生尺 {raw}f が下限124f(5.17s)未満")
    frames = snap(raw)

    # 内部境界(実測)
    bounds, off = [], 0.0
    for n in ns[:-1]:
        off += cuts[n]["dur"]
        bounds.append(round(off, 3))
    # 打点(相対秒)
    lines, off = [], 0.0
    nh = 0
    for n in ns:
        cc = cuts[n]
        hh = []
        for k in ("snare", "kick", "cymbal"):
            hh += [(round(off + t, 3), k) for t in cc["hits"].get(k, [])]
            nh += len(cc["hits"].get(k, []))
        for t, k in sorted(hh):
            lines.append(f"{k} {t}")
        for b in cc["manual_buildups"]:
            lines.append(f"盛上 {b['start_sec']-cc['sec'][0]+off:.3f}〜{b['end_sec']-cc['sec'][0]+off:.3f}")
        off += cc["dur"]
        lines.append(f"-- C{n} 終端 {off:.3f}")

    mg = [n for n in ns if n in MG_HEAVY]
    lip = [n for n in ns if n in LIPSYNC]
    prev_n, next_n = ns[0] - 1, ns[-1] + 1
    links = sorted({x for n in ns for x in cuts[n]["links"] if x not in ns})
    back = sorted(n for n, cc in cuts.items() if set(cc["links"]) & set(ns) and n not in ns)

    mode_note = ""
    if "I2VA" in modes:
        mode_note = ("\n⚠ 融合前に I2VA の単位が含まれる。I2VAは参照1枚・音声不可のため、"
                     "融合後は **Ref2VA** で書くこと。I2VAだったカットの参照も subject definition として扱う。")

    audio_note = {
        "inst": ("- **参照音声: 伴奏ステム1本(<Audio 1>)。** retention marker は reference。"
                 "<Audio 1>に映像タイミングの支配者の役を与えない。映像の時刻は本文の実測生値が持つ。"),
        "vocal": ("- **参照音声: 歌唱ステム1本(<Audio 1>)。リップシンク優先。** retention marker は reference。"
                  "<Audio 1>は口の調音のみ駆動。視覚の切り替え時刻は本文の実測秒数が持つ。"
                  "歌詞は各セリフに <d>[Japanese/English] ...</d> で書いてよい。"),
        "none": "- 参照音声なし。打点は本文の実測秒数で制御する。",
    }[a.audio]

    def warn_lines(n):
        return "\n".join("  ⚠ " + ln.strip() for ln in re.split(r"(?<=。)", cuts[n]["intent"])
                         if "⚠" in ln)

    body = f"""単位 {a.units[0]}(融合版) のH3映像プロンプトを書いてください。

## 依頼の性質
{' + '.join(a.units)} を **1つの生成単位へ融合**します(C{ns[0]}〜C{ns[-1]}, {len(ns)}カット)。
先行してU01/U04/U07/U11/U13を同じやり方で融合済み。{mode_note}

## 融合後の確定条件(監督が実測・検証済み。変更不可)
- 担当カット: {'+'.join('C'+str(n) for n in ns)} / 実span {raw/24:.3f}秒 / **生成{frames}フレーム = {frames/24:.3f}秒**(17n+5・訓練域内)
- モード: Ref2VA
- 参照画像 {len(refs)}枚(この順で <Picture 1>〜<Picture {len(refs)}>): {refs}
  ⚠ この順で <Picture N> になる。9枚まで。
{audio_note}
- 内部カット境界(実測): {', '.join(f'{b}s' for b in bounds) if bounds else '(単一)'}

## 実測打点(単位先頭からの相対秒。丸めずに使う。最低3つを本文に生値で書く)
{chr(10).join(lines)}

打点 {nh}発 / {raw/24:.2f}秒 = 毎秒{nh/(raw/24):.2f}発。
{'⚠高密度。構造打点を名指しし、他は新規イベントを起こさない微小反応へ吸収すること。' if nh/(raw/24)>4 else ''}
{'⚠MG重点カット C'+str(mg)+' を含む。窓・マスク・ワイプ等のMG手法を主役に据える。' if mg else ''}
{'⚠リップシンクカット C'+str(lip)+' を含む。音節ぶんだけ口を開閉し無音で閉じる。' if lip else ''}

## カット意図(⚠は確定事項・覆せない)
{chr(10).join(f'C{n}: {cuts[n]["intent"]}' + chr(10) for n in ns)}

## 全体の中での位置
【直前 C{prev_n}】{cuts.get(prev_n,{}).get('intent','(なし)')[:170] if prev_n in cuts else '(なし)'}
【直後 C{next_n}】{cuts.get(next_n,{}).get('intent','(なし)')[:170] if next_n in cuts else '(なし)'}
【設計リンク先】{['C'+str(x) for x in links] or 'なし'}
{chr(10).join(f'  【リンク C{L}】{cuts[L]["intent"][:160]}' for L in links if L in cuts)}
【このカット群を参照している側】{['C'+str(x) for x in back] or 'なし'}

## この融合の核心(監督の指示)
{a.note or '(標準: 因果の連続で1本にまとめ、設計リンクの伏線/回収を保つ)'}

## 既存版(融合前)
{chr(10).join(f'===== {uid} ====={chr(10)}{olds[uid]}' for uid in a.units)}

## ⚠ 必須
- Ref2VAの6セクションを全て含める / 打点との関係を書く(実測生値を最低3つ)
- 参照へ storyboard anchor / target frame を与えない
- キャラ・物はプレースホルダを使う。**使える名前はこれだけ**:
  {PLACEHOLDERS}
  ⚠ この一覧に無い名前を作らない(過去に {{{{HALFMOON_ID}}}} を発明して展開失敗)

## 出力形式(この形ちょうど。前置き不要)
<<<PROMPT>>>
(プロンプト本文のみ)
<<<END>>>
<<<NOTES>>>
核心をどう解いたか / 選んだ打点 / 設計リンクの伏線 / 自信のない点
<<<END>>>
"""
    head = ("あなたはAniPAFE2026のH3映像プロンプトを書く担当です。監督(Claude)が全数検査します。\n"
            "以下は本作でこれまで蓄積した設計知識の全層です。**すべてを踏まえて**書いてください。\n"
            "特に: 物語の確定事項(層1)/演出原則(層2)/色の規則(層3)/MG辞書(層4)/質感3層(層5)/\n"
            "憲法(層6)/H3の実測知見(層10-11)/参考プロンプトの形式(層13)/名簿の逐語記述(層14)。\n\n")
    dossier = (SCRATCH / "v3_dossier.txt").read_text()
    full = head + dossier + "\n\n⚠ ファイルは読み書きしない。上の資料だけで書く。\n\n" + body
    out = Path(a.out) if a.out else SCRATCH / f"merge_{a.units[0]}_brief.txt"
    out.write_text(full)
    print(f"{a.units[0]} 融合ブリーフ {len(full):,}字 → {out}  "
          f"(C{ns[0]}-{ns[-1]} {len(ns)}cut / {frames}f / 参照{len(refs)} / 音声{a.audio}"
          f"{' / MG'+str(mg) if mg else ''}{' / lip'+str(lip) if lip else ''}"
          f"{' / I2VA→Ref2VA' if 'I2VA' in modes else ''})")


if __name__ == "__main__":
    main()
