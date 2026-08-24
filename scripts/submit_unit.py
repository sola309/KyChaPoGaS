#!/usr/bin/env python3
"""生成単位プロンプトを展開してH3ジョブへ投入する。

  python3 scripts/submit_unit.py U01 [U02 ...]      # 本番(step25 / 1344x768)
  python3 scripts/submit_unit.py --t1 U01           # T1検証(960x544 / step4 / turbo)
  python3 scripts/submit_unit.py --dry U01          # 展開結果を表示するだけ

プレースホルダは 00-conventions.md の規約どおりここで機械展開する。
名簿(bible)を単一の正とし、記述の揺れを構造的に排除する(憲法37c)。
"""
import argparse, json, re, sys, glob, urllib.request
from pathlib import Path

API = "http://localhost:8002/api"
PROJECT = 31
ROOT = Path(__file__).resolve().parent.parent
PDIR = ROOT / "docs/anipafe2026-prompts"
PDIR_V2 = ROOT / "docs/anipafe2026-prompts-v2"
PDIR_V3 = ROOT / "docs/anipafe2026-prompts-v3"

# ── 名簿から展開するキャラ定義 ────────────────────────────────
BIBLE_KEY = {
    "HOMU_ID": ("homura_devil", "default"), "UM_ID": ("madoka_ultimate", "default"),
    "ORB_ID": ("darkorb", "default"), "GEM_ID": ("soulgem_homura", "default"),
    "QB_ID": ("kyubey", "default"), "EMBLEM_ID": ("emblemstone", "default"),
    "MAJUU_ID": ("majuu", "default"), "WALP_ID": ("walpurgis", "default"),
    "DOLLS_ID": ("claradolls", "card"),
}
# 名簿記述に必ず添える固定文(実害から導いた不変条件)
ADDENDUM = {
    "HOMU_ID": (" Her feathered skirt is FLOOR-LENGTH and split open at the front - never short, never "
                "knee-length. One leg wears a grey-and-black diamond-checkered thigh-high stocking, the "
                "other is bare with a red ribbon spiralling. Her hands are covered to the fingertips; no "
                "bare fingers."),
    "ORB_ID": (" It is SMALL - it fits in a cupped human palm, no larger than an apple. Compare its size "
               "to a hand, never to a body."),
    "GEM_ID": (" Keep its gold mount, laurel band, front medallion, stepped foot and finial exactly; do "
               "not redesign them and do not add wings, horns or extra jewels."),
    "QB_ID": (" Its mouth NEVER OPENS and never moves - it speaks only by telepathy, so it never speaks "
              "aloud, never mouths words and never forms syllables. Its face holds no expression of any "
              "kind and does not change. Do not animate its mouth under any circumstances."),
}

STYLE_BASE = ("STYLE: 2D Japanese cel animation, hard-edge cel shading, 1-2 shadow layers, flat anime "
              "line art. Do not output any reference sheet's frame, panels, swatches or layout elements.")
NO_TEXT = (" Do not output any letters, numbers, logos, captions or pseudo-writing.")
LENS = ("LENS: the near plane is softly out of focus, the subject is sharp, the far plane is soft.")
DEPTH = ("DEPTH: build the picture from five to eight separate depth planes and move them at different "
         "speeds - the nearest plane travels fastest and may briefly cover the whole frame as it passes, "
         "the middle planes travel at moderate speed, the farthest plane barely moves. Never move every "
         "layer with the camera; some layers lag a little behind it. Depth is carried by these speed "
         "differences, not only by blur.")
FOCUS = ("FOCUS: only the subject carries detail. The ground, the walls and the background are simplified "
         "to large flat masses with almost no texture, pattern or small objects, and they fall away into "
         "near-black within a short distance of the subject. Light falls only where the eye must go; "
         "everywhere else is allowed to be empty. Fewer things, further apart, most of them dark.")

# ── 幕別スタイルブロック(style-blocks.md と同一文言) ──────────
S = {
"PRO": ("LIGHT: near-black space. The only light is a cold violet glow from high above, falling steeply, "
  "so upward-facing surfaces take a faint violet edge and everything else sinks to black. There is no "
  "fill from below and no warm light except on the single brightest element. Near-black occupies more "
  "than half of the picture. Thin haze separates the depth planes; the farthest plane is palest. Only the "
  "single brightest element blooms. PALETTE: near-black, deep violet, and cold gold on the one brightest "
  "element."),
"MEM": ("LIGHT: the scene keeps its own anime colours but pulled toward cold blue-grey, like a remembered "
  "image. One soft key from the scene's own light source, gentle contrast, and a deep dark vignette "
  "closing every corner like an old picture frame. Highlights stay quiet; only one small point may bloom. "
  "PALETTE: desaturated cel colours over cold blue-grey."),
"CITY": ("LIGHT: the only light is a cold VIOLET source low and far to the LEFT, outside the frame. It "
  "rakes almost horizontally, so left-facing surfaces take a hard violet edge and everything turned away "
  "falls to near-black. No fill from below, no warm light anywhere. Near-black occupies about half the "
  "picture. Thin haze separates near, middle and far planes; the far plane sits paler and lower in "
  "contrast. Only the single brightest element blooms. PALETTE: near-black, violet, porcelain white."),
"DAY": ("LIGHT: warm afternoon daylight, soft and even, with gentle cel shadows. Blacks stay open; almost "
  "nothing in the frame is truly dark. Contrast is mild and edges are kind. PALETTE: warm cel colours in "
  "full saturation, cream light."),
"STORM": ("LIGHT: cold storm light from high behind the clouds, blue-grey and directionless, broken by "
  "sudden hard flashes that light everything for a single frame. Between flashes, near-black holds the "
  "lower third of the frame. Thin rain-haze separates the planes. PALETTE: storm blue, near-black, pale "
  "grey; soul-gem colours are the only saturation."),
"A3": ("LIGHT: a cold violet key from the left and, opposing it, a low blood-red rim from the right that "
  "touches only edges and thread-like shapes. Near-black holds about half the frame. Thin haze between "
  "planes; only the brightest element blooms. PALETTE: near-black, violet, porcelain white, blood red on "
  "edges and threads only."),
"WATER": ("LIGHT: a white water surface fills the frame, bright and even, like an overcast sky seen in "
  "still water. Figures read as delicate dark shapes on white; shadows are pale grey, contrast is low, "
  "edges soft. PALETTE: white, pale grey, and the subjects' own muted colours."),
}
# ── 鏡映断片(対比グループで逐語共有) ─────────────────────────
FRAG = {
"HALF_MOON": ("a huge pale moon whose RIGHT HALF IS SIMPLY MISSING, the remaining half ending in a "
  "PERFECTLY STRAIGHT VERTICAL EDGE that burns thin and white, the missing half being empty black sky - "
  "not a shadowed side and not a dark disc"),
"SOURCELESS_SHADOW": ("one huge soft-edged shadow, cast by nothing that is anywhere in the sky, drifts "
  "slowly across"),
"FRAME_A": ("medium close-up, facing the camera directly, perfectly centred, head and upper chest filling "
  "the upper two thirds of the frame"),
"WATER_BASE": ("the white water surface stretching to every edge, bright and even, figures reading as "
  "delicate dark shapes upon it"),
"SEEOFF": ("the two of them stand side by side in the lower left of the frame, seen from behind at a "
  "distance, perfectly still, watching something bright leave the upper right; neither raises a hand"),
"REACH_HAND": ("a hand reaches into the frame, open, yearning, and stops short - the distance between "
  "fingertips and what they reach for stays visible"),
}
FRAG["FRAME_B"] = FRAG["FRAME_A"]

# ── v2: 様式テーゼ(冒頭1行・幕内逐語共有)と短縮ブロック ──────────
TH = {
"TH:PRO": ("STYLE THESIS: a funeral-quiet cosmic prologue in near-black and deep violet - one cold "
  "glow from high above, hard blacks over half the frame, and only the single brightest element "
  "allowed to bloom."),
"TH:MEM": ("STYLE THESIS: a remembered film - cel colours pulled to cold blue-grey inside a heavy "
  "vignette, one soft key, quiet highlights, every image framed like something being looked back on."),
"TH:CITY": ("STYLE THESIS: an editorial night noir in near-black, violet and porcelain white - one "
  "cold violet key raking from the left, hard graphic shadows, black holding half the frame."),
"TH:GOLD": ("STYLE THESIS: an editorial storm noir where a GOLDEN tempest replaces the violet key - "
  "hard rims of gold, dark broken ground, black holding half the frame."),
"TH:DAY": ("STYLE THESIS: one warm ordinary afternoon in full saturation - soft daylight, open "
  "blacks, kind edges; the only warm passage in the film."),
"TH:STORM": ("STYLE THESIS: storm-blue war reportage - directionless grey light broken by "
  "single-frame lightning, rain-haze between planes, soul-gem colours the only saturation."),
"TH:A3": ("STYLE THESIS: a duel of violet and blood-red - cold violet key from the left, red allowed "
  "only on edges and threads, black holding half the frame."),
"TH:WATER": ("STYLE THESIS: a white-on-white water world - one bright still surface to every edge, "
  "figures as delicate dark shapes, low contrast, soft edges."),
}
V2 = {
"BEATLAW": ("Every hard cut lands exactly on a snare. Each kick lands as one physical impact of a "
  "visible body or object. Each cymbal bursts as light or particles from a visible source. Never "
  "drift."),
"DP": ("DEPTH: five to eight planes at different speeds - the nearest may sweep the whole frame, "
  "the farthest barely moves; never move every layer with the camera."),
"ST2": ("STYLE: 2D Japanese cel animation, hard-edge cel shading, editorial motion-graphic "
  "compositing. Do not output any letters, numbers, logos or pseudo-writing, nor any reference "
  "sheet's frame or panels."),
}


def load_bible():
    return json.load(open(ROOT / "backend/data/bible/0.json"))


def build_dict():
    d = load_bible()
    by = {c["key"]: c for c in d["cast"]}
    out = dict(FRAG)
    for tag, (key, outfit) in BIBLE_KEY.items():
        desc = by[key]["outfits"][outfit].get("description_en", "")
        out[tag] = desc + ADDENDUM.get(tag, "")
    for k, v in S.items():
        out["S:" + k] = v
    out.update(TH); out.update(V2)
    out.update({"STYLE": STYLE_BASE, "LENS": LENS, "DEPTH": DEPTH, "FOCUS": FOCUS})
    return out


def parse_units_v3():
    """v3は <unit>.txt が本文そのもの。尺・モード・参照はv2の見出しから引き継ぐ。"""
    base = {}
    global PDIR
    keep = PDIR
    PDIR = PDIR_V2
    try:
        base = parse_units()
    finally:
        PDIR = keep
    out = {}
    for f in sorted(PDIR_V3.glob("U*.txt")):
        uid = f.stem
        if uid not in base:
            continue
        out[uid] = dict(base[uid], code=f.read_text())
    return out


def parse_units():
    units = {}
    for f in sorted(glob.glob(str(PDIR / "0[1-9]*.md"))):
        t = open(f).read()
        for m in re.finditer(r"## (U\d+[ab]?) — ([^\n]+)\n(.*?)(?=\n---\n## U|\Z)", t, re.S):
            uid, head, body = m.group(1), m.group(2), m.group(3)
            code = re.search(r"```\n(.*?)\n```", body, re.S).group(1)
            # 参照は「参照:」行から⚠または空行までのブロックだけを読む。
            # 注記中の除外指示(例: 「#2936は使わない」)を拾わないため。
            notes = body.split("```")[0]
            mref = re.search(r"^参照[^:\n]*:(.*?)(?=^⚠|^\s*$)", notes, re.S | re.M)
            refs = [int(x) for x in re.findall(r"#(\d{3,4})", mref.group(1) if mref else "")]
            gen = re.search(r"生成(\d+)f", head)
            units[uid] = {"head": head, "code": code, "refs": refs,
                          "frames": int(gen.group(1)) if gen else 124,
                          "mode": "I2VA" if code.startswith("Create a video") else "Ref2VA"}
    return units


def expand(code, uid, D):
    # U03 のみ NO-TEXT を外す(C3のロゴが唯一の文字使用箇所)
    style = STYLE_BASE if uid == "U03" else STYLE_BASE + NO_TEXT
    st2 = V2["ST2"].replace("Do not output any letters, numbers, logos or pseudo-writing, nor any",
                            "Do not output any") if uid == "U03" else V2["ST2"]
    D = dict(D, STYLE=style, ST2=st2)
    missing = [p for p in set(re.findall(r"\{\{([^}]+)\}\}", code)) if p not in D]
    if missing:
        sys.exit(f"✗ {uid}: 未定義プレースホルダ {missing}")
    return re.sub(r"\{\{([^}]+)\}\}", lambda m: D[m.group(1)], code)


_CUTS = None


def cut_ranges():
    """ピン(track 54)を2つずつ組にして C番号 → (start, end)。テイク紐付けに使う。"""
    global _CUTS
    if _CUTS is None:
        pins = [c for c in json.load(urllib.request.urlopen(API + "/clips/?track_id=54"))
                if c.get("asset_id")]
        pins.sort(key=lambda c: c["start_frame"])
        _CUTS = {i // 2 + 1: (pins[i]["start_frame"], pins[i + 1]["start_frame"])
                 for i in range(0, len(pins) - 1, 2)}
    return _CUTS


def submit(uid, u, prompt, t1):
    """実APIの形式に合わせる。参照画像はモードによらず keyframes[] で渡す。
    I2VA = model 'minimax-h3'(先頭1枚をfirst frameに) / Ref2VA = model 'minimax-h3-ref'(≤9枚)。
    尺は duration_sec で渡し、バックエンド側で h3_snap_length により 17n+5 へ丸められる。"""
    n = 1 if u["mode"] == "I2VA" else 9
    p = {"project_id": PROJECT, "prompt": prompt,
         "model": "minimax-h3" if u["mode"] == "I2VA" else "minimax-h3-ref",
         "keyframes": [{"time_sec": 0.0, "asset_id": a} for a in u["refs"][:n]],
         "duration_sec": round(u["frames"] / 24.0, 3), "fps": 24, "seed": -1,
         "negative_prompt": "", "scheduler": "simple", "easycache": False,
         "note": f"AniPAFE2026 {uid} {u['head'][:60]}"}
    # 🗂テイク履歴はこの place.start_frame でカットへ紐付く。
    # auto=false = タイムラインへ自動配置せずテイクとして蓄積する(運用規約)。
    ns = [int(x) for x in re.findall(r"C(\d+)", u["head"].split("(")[0])]
    if ns:
        cuts = cut_ranges()
        st, en = cuts[ns[0]][0], cuts[ns[-1]][1]
        p["place"] = {"track_id": 63, "start_frame": st,
                      "duration_frames": en - st + 1, "auto": False}
    if t1:
        p["quality"] = "t1"
    else:
        p.update({"width": 1344, "height": 768, "steps": 25, "ref_image_size": "max"})
    r = urllib.request.Request(API + "/jobs/",
        data=json.dumps({"project_id": PROJECT, "job_type": "generate_video_i2v", "params": p}).encode(),
        headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r)).get("id")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("units", nargs="+")
    ap.add_argument("--t1", action="store_true", help="T1検証(960x544/step4/turbo)")
    ap.add_argument("--dry", action="store_true", help="展開結果を表示するだけ")
    ap.add_argument("--v2", action="store_true", help="v2ディレクトリを使う")
    ap.add_argument("--v3", action="store_true", help="v3(Codex執筆)を使う")
    a = ap.parse_args()
    global PDIR
    if a.v2:
        PDIR = PDIR_V2
    if a.v3:
        PDIR = PDIR_V3
    D = build_dict()
    units = parse_units_v3() if a.v3 else parse_units()
    jobs = {}
    for uid in a.units:
        if uid not in units:
            sys.exit(f"✗ 未知の単位: {uid}")
        u = units[uid]
        prompt = expand(u["code"], uid, D)
        if a.dry:
            print(f"===== {uid} ({u['mode']} / {u['frames']}f / refs={u['refs'][:9]}) "
                  f"{len(prompt.split())}語 =====\n{prompt}\n")
            continue
        jid = submit(uid, u, prompt, a.t1)
        jobs[uid] = jid
        print(f"{uid} → job {jid} ({u['mode']} / {u['frames']}f / {len(prompt.split())}語)")
    if jobs:
        print(json.dumps(jobs))


if __name__ == "__main__":
    main()
