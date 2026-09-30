#!/usr/bin/env python3
"""融合原稿を本適用する: 退避 → v3設置 → v2ヘッダ融合 → 音源切り出し。

merge_brief.py + Codex で作った原稿(scratchpad/<dest>_final.txt)を、
これまで手作業でやってきた融合の後処理(U01/U04/U07/U11/U13で確立)を機械化して
一括適用する。6組を1組ずつ手で処理するのは事故が多いため。

  python3 scripts/apply_merges.py           # 下のMERGESを全適用
  python3 scripts/apply_merges.py --dry     # 変更せず計画だけ出す

各融合: (dest, [gone...], audio, refs_override)
  refs_override は None なら dest+gone の参照 union(≤9)。U20 のように手動で
  9枚に絞った組だけ明示する。
結果は docs/anipafe2026-prompts-v3/_superseded/ に旧版を退避してから行う。
"""
import argparse, importlib.util, json, re, shutil, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
V3 = ROOT / "docs/anipafe2026-prompts-v3"
SUP = V3 / "_superseded"
V2DIR = ROOT / "docs/anipafe2026-prompts-v2"
SCRATCH = Path("/tmp/claude-1000/-home-kigarashi309-workspace-projects-KyChaPoGaS/"
               "90c4bd2b-b848-43d4-8569-f00bf3f48772/scratchpad")

# (dest, gone, audio, refs_override)
MERGES = [
    ("U20", ["U21"], "inst", [3048, 953, 956, 954, 955, 2911, 3045, 2946, 2947]),
    ("U24", ["U25"], "inst", None),
    ("U29", ["U30"], "vocal", None),
    ("U31", ["U32"], "inst", None),
    ("U33", ["U34"], "inst", None),
    ("U39", ["U40"], "inst", None),
]


def snap(raw):
    n = max(124, min(362, raw))
    return min(362, n + (5 - n % 17) % 17)


def title_of(head):
    # "C7 約束の水面 (Ref2VA / ...)" → "約束の水面"
    t = re.sub(r"^(C\d+\+?)+\s*", "", head.split("(")[0]).strip()
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()

    spec = importlib.util.spec_from_file_location("su", ROOT / "scripts/submit_unit.py")
    mod = importlib.util.module_from_spec(spec)
    sys.argv = ["x"]
    spec.loader.exec_module(mod)
    u = mod.parse_units_v3()
    c = mod.cut_ranges()

    SUP.mkdir(exist_ok=True)
    log = []
    for dest, gone, audio, ov in MERGES:
        units = [dest] + gone
        ns = [int(x) for uid in units for x in re.findall(r"C(\d+)", u[uid]["head"].split("(")[0])]
        s0, e0 = c[ns[0]][0], c[ns[-1]][1]
        frames = snap(e0 - s0)
        refs = ov or list(dict.fromkeys(sum((u[uid]["refs"] for uid in units), [])))[:9]
        title = "→".join(title_of(u[uid]["head"]) for uid in units)
        cutstr = "+".join("C" + str(n) for n in ns)
        final = SCRATCH / f"{dest}_final.txt"
        if not final.exists():
            log.append(f"✗ {dest}: 原稿 {final.name} が無い"); continue

        # v2ヘッダ用の新台帳見出し(尺・モード・参照の台帳)
        refline = " / ".join(f"<Picture {i+1}> #{r}" for i, r in enumerate(refs))
        ledger = (f"## {dest} — {cutstr} {title} (Ref2VA / 生成{frames}f / "
                  f"実尺{(e0-s0)/24:.2f}s / 融合{len(ns)}カット)\n\n"
                  f"参照: {refline}\n"
                  f"⚠ {'+'.join(units)} を融合(apply_merges.py)。"
                  f"音声={audio}。融合前は _superseded/。\n\n"
                  f"```\n(本文は v3/{dest}.txt。この見出しは尺・モード・参照の台帳)\n```")

        if a.dry:
            log.append(f"[DRY] {dest} {cutstr} {frames}f 参照{len(refs)} 音声{audio} 消滅{gone}")
            continue

        # ① 旧v3退避 + 新v3設置 + goneのv3削除
        if (V3 / f"{dest}.txt").exists():
            shutil.copy(V3 / f"{dest}.txt", SUP / f"{dest}_before_merge.txt")
        shutil.copy(final, V3 / f"{dest}.txt")
        for g in gone:
            if (V3 / f"{g}.txt").exists():
                shutil.move(str(V3 / f"{g}.txt"), str(SUP / f"{g}_before_merge.txt"))

        # ② v2ヘッダ書き換え(全mdを走査。dest→台帳、gone→old化)
        for md in V2DIR.glob("*.md"):
            s = md.read_text()
            orig = s
            # dest見出し行(1行)を台帳ブロックへ。既存見出し行だけを対象にする。
            s = re.sub(rf"^## {dest} — [^\n]*$", ledger.replace("\\", "\\\\"),
                       s, count=1, flags=re.M)
            for g in gone:
                s = re.sub(rf"^## {g} — ([^\n]*)$",
                           rf"## {g}old — \1 〔{dest}へ融合により停止〕", s, count=1, flags=re.M)
            if s != orig:
                md.write_text(s)

        # ③ 音源切り出し(role別)。台帳を掃除してから切り直す
        led_p = ROOT / "docs/anipafe2026-ref-audio.json"
        led = json.loads(led_p.read_text()) if led_p.exists() else {}
        for k in [k for k in led if k.split(":")[0] in units]:
            led.pop(k)
        led_p.write_text(json.dumps(led, ensure_ascii=False, indent=1))
        import ref_audio as RA
        stem = {"inst": "inst", "vocal": "vocal"}[audio]
        aid = RA.make(dest, stem, force=True)
        log.append(f"✓ {dest} {cutstr} {frames}f 参照{len(refs)} 音声{audio}#{aid} 消滅{gone}")

    (SCRATCH / "apply_merges.log").write_text("\n".join(log))
    print("\n".join(log))
    print(f"\n{len([l for l in log if l.startswith('✓')])}/{len(MERGES)} 適用"
          + ("(dry)" if a.dry else ""))


if __name__ == "__main__":
    main()
