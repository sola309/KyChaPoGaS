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


# ── 参照音声(<Audio N>)の宣言文 ────────────────────────────────
# 執筆: Codex(gpt-5.6-sol / 資料一式106,868字 + 公式ガイド調査)。Claudeは検査のみ。
#
# 監督が独断で書いた初版は3点とも誤りだった:
#   ① fully_copy を打点駆動に使った → fully_copy は「参照音声をそのまま完成音声にする」
#      という音声側の関係指定。映像同期の強度ではない。リズム参照は `reference` が正しい
#   ② <Audio 1> を "the clock for every visual event" と書いた → 公式にない役割の過剰指定
#   ③ "Visual events occur only on transients" と書いた → 二次動作と着地まで禁じてしまう。
#      実測でも総動き量が 5.41→3.83 と減った(U18 同一シード比較)
# 映像の時刻精度は従来どおり [Shot N] At MM:SS.mmm の実測生値が主制御。
# 参照音声はリズム条件を補強するだけで、フレーム時刻を拘束しない。
AUDIO_BLOCK = {
    "lipsync": (
        "\n<Audio 1> is the synchronized vocal-performance reference for <Subject 1> (S1).\n"
        "<Audio 1> supplies the exact lyric, syllable rhythm, vowel holds, pauses, breaths "
        "and phrase endings for this cut.",
        "\n<Audio 1>: reference - its lyric content, syllable rhythm, pauses, breaths and "
        "measured delivery guide the newly generated vocal performance of <Subject 1> (S1).",
        "{DTAG}"
        "LIPSYNC LAW: Each syllable onset triggers one small jaw opening.\n"
        "Each syllable ending triggers one smaller mouth aperture.\n"
        "Each held vowel keeps one stable mouth pose.\n"
        "Each audible pause brings the lips together.\n"
        "Each phrase ending brings the lips together.\n"
        "The closed lips stop the jaw until the next onset.\n"
        "The next syllable onset restarts the jaw.",
        None),
    "beat": (
        "\n<Audio 1> is the instrumental rhythm reference for this cut.\n"
        "<Audio 1> supplies the snare, kick, cymbal, tempo, accent hierarchy, phrase contour "
        "and buildup.",
        "\n<Audio 1>: reference - its rhythm, accent hierarchy and phrase contour guide the "
        "newly generated audiovisual sequence.",
        "RAW-TIME LAW: Each [Shot N] boundary uses its written unrounded measured transient time.\n"
        "SNARE LAW: Each selected snare boundary triggers one hard cut, mask swap or physical wipe.\n"
        "KICK LAW: Each selected kick transient triggers one body impact or depth-plane displacement.\n"
        "CYMBAL LAW: Each selected cymbal transient triggers one rim-light burst or particle burst.\n"
        "Each primary impact releases one short overshoot.\n"
        "Hair and cloth continue moving between primary impacts.\n"
        "Haze and particles continue moving between primary impacts.\n"
        "MG LAW: Each silhouette window encloses the lyric-indicated image behind the subject.\n"
        "The hard window edge confines the inner image.\n"
        "Each panel appears on its assigned depth plane.\n"
        "The panel slides toward its final position.\n"
        "The settled panel LOCKS at its assigned Z-order.\n"
        "Each MG edge catches one hard specular accent from the shot key.\n"
        "Each assigned wipe uses a pink causal thread, crack edge, golden storm band or "
        "black feather group.\n"
        "The motif object crosses the near foreground plane at very close range.\n"
        "The motif object covers the lens before the next shot appears.",
        "<Audio 1> guides a newly generated instrumental score with the same rhythm, "
        "accent hierarchy and phrase contour."),
    # 歌と伴奏を1本に混ぜず、<Audio 1>=歌唱 / <Audio 2>=伴奏 と分けて別々の役へ配線する
    "full": (
        "\n<Audio 1> is the synchronized vocal-performance reference for <Subject 1> (S1).\n"
        "<Audio 1> supplies the exact lyric, syllable rhythm, vowel holds, pauses, breaths "
        "and phrase endings.\n"
        "<Audio 2> is the instrumental rhythm reference for this cut.\n"
        "<Audio 2> supplies the snare, kick, cymbal, tempo, accent hierarchy, phrase contour "
        "and buildup.",
        "\n<Audio 1>: reference - its lyric content, syllable rhythm, pauses, breaths and "
        "measured delivery guide the newly generated vocal performance of <Subject 1> (S1).\n"
        "<Audio 2>: reference - its rhythm, accent hierarchy and phrase contour guide the "
        "newly generated audiovisual sequence.",
        "{DTAG}"
        "DUAL-TRACK ROUTING LAW: Each vocal onset in <Audio 1> triggers one mouth-performance "
        "response.\nEach instrumental accent in <Audio 2> triggers one assigned visual response.\n"
        "LIPSYNC LAW: Each syllable onset triggers one small jaw opening.\n"
        "Each syllable ending triggers one smaller mouth aperture.\n"
        "Each held vowel keeps one stable mouth pose.\n"
        "Each audible pause brings the lips together.\n"
        "Each phrase ending brings the lips together.\n"
        "The closed lips stop the jaw until the next onset.\n"
        "RAW-TIME LAW: Each [Shot N] boundary uses its written unrounded measured transient time.\n"
        "SNARE LAW: Each selected snare boundary triggers one hard cut, mask swap or physical wipe.\n"
        "KICK LAW: Each selected kick transient triggers one body impact or depth-plane displacement.\n"
        "CYMBAL LAW: Each selected cymbal transient triggers one rim-light burst or particle burst.\n"
        "Each primary impact releases one short overshoot.\n"
        "Secondary motion continues between primary impacts.\n"
        "MG LAW: Each silhouette window encloses the lyric-indicated image behind the subject.\n"
        "The hard window edge confines the inner image.\n"
        "Each panel appears on its assigned depth plane.\n"
        "The panel slides toward its final position.\n"
        "The settled panel LOCKS at its assigned Z-order.\n"
        "Each assigned motif object crosses the near foreground plane.\n"
        "The motif object covers the lens before the next shot appears.",
        "<Audio 2> guides a newly generated instrumental score with the same rhythm, "
        "accent hierarchy and phrase contour."),
}
# ロール → 渡すステム。歌わない人物に余計な口の動きが出るのを避けるため、
# MG(打点駆動)には歌声を渡さない。full は歌唱と伴奏を別々の参照として2本渡す。
# ⚠ 公式: 参照音声は1本2〜15秒・合計15秒以内。full の2本構成は単位が7.5秒以下でないと超える。
AUDIO_STEM = {"lipsync": ["vocal"], "beat": ["inst"], "full": ["vocal", "inst"]}


_PACKET = None


def packet_cuts():
    """設計意図・歌詞・実測打点の台帳。歌詞は <d> タグの文言をここから取る。"""
    global _PACKET
    if _PACKET is None:
        p = Path(__file__).resolve().parent.parent / "docs/anipafe2026-cut-packets.json"
        _PACKET = {c["n"]: c for c in json.load(open(p))["cuts"]}
    return _PACKET


def _dtag(uid, units, cuts):
    """公式の発話タグ <d>[Language] ...</d>。歌詞は本編の確定文言をそのまま置く。"""
    ns = [int(x) for x in re.findall(r"C(\d+)", units[uid]["head"].split("(")[0])]
    ly = (cuts[ns[0]].get("lyrics") or "").strip("「」 ")
    if not ly:
        return ""
    lang = "Japanese" if re.search(r"[぀-ヿ㐀-鿿]", ly) else "English"
    return (f"<Subject 1> (S1) performs the referenced vocal line: "
            f"<d>[{lang}] {ly}</d>\n")


def with_audio(prompt: str, role: str, dtag: str = "") -> str:
    """プロンプトに <Audio N> を織り込む。6セクション構造は壊さない。"""
    sd, ra, law, ndm = AUDIO_BLOCK[role]
    law = law.replace("{DTAG}", dtag)
    out = []
    for line in prompt.split("\n"):
        if line.startswith("subject_definitions:"):
            line = line.rstrip() + sd
        elif line.startswith("retention_analysis:"):
            line = line.rstrip() + ra
        elif line.startswith("non_diegetic_music:") and ndm:
            line = "non_diegetic_music: " + ndm
        elif line.startswith("overall_soundscape:"):
            out.append(law)
            out.append("")
        out.append(line)
    return "\n".join(out)


def submit(uid, u, prompt, t1, ref_audio=None, seed=-1):
    """実APIの形式に合わせる。参照画像はモードによらず keyframes[] で渡す。
    I2VA = model 'minimax-h3'(先頭1枚をfirst frameに) / Ref2VA = model 'minimax-h3-ref'(≤9枚)。
    尺は duration_sec で渡し、バックエンド側で h3_snap_length により 17n+5 へ丸められる。"""
    n = 1 if u["mode"] == "I2VA" else 9
    p = {"project_id": PROJECT, "prompt": prompt,
         "model": "minimax-h3" if u["mode"] == "I2VA" else "minimax-h3-ref",
         "keyframes": [{"time_sec": 0.0, "asset_id": a} for a in u["refs"][:n]],
         "duration_sec": round(u["frames"] / 24.0, 3), "fps": 24, "seed": seed,
         "negative_prompt": "", "scheduler": "simple", "easycache": False,
         "note": f"AniPAFE2026 {uid} {u['head'][:60]}"}
    if ref_audio:
        p["ref_audio_asset_ids"] = ref_audio[:3]
        p["note"] += f" +audio{ref_audio[:3]}"
    # 🗂テイク履歴はこの place.start_frame でカットへ紐付く。
    # auto=false = タイムラインへ自動配置せずテイクとして蓄積する(運用規約)。
    ns = [int(x) for x in re.findall(r"C(\d+)", u["head"].split("(")[0])]
    if ns:
        cuts = cut_ranges()
        st, en = cuts[ns[0]][0], cuts[ns[-1]][1]
        p["place"] = {"track_id": 64, "start_frame": st,
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
    ap.add_argument("--audio", choices=["lipsync", "beat", "full"],
                    help="参照音声を渡す。lipsync=歌唱ステム / beat=伴奏ステム / full=元音源。"
                         "該当区間を自動で切り出し、<Audio 1>としてプロンプトに宣言する")
    ap.add_argument("--seed", type=int, default=-1, help="A/B比較用に固定する")
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
        ra = None
        if a.audio:
            # I2VA(FL2VA)は参照音声を取れない。渡しても静かに無視される一方、
            # プロンプトには <Audio 1> の宣言だけが残り、存在しない参照を指す。
            if u["mode"] != "Ref2VA":
                sys.exit(f"✗ {uid} は {u['mode']} — 参照音声を取れるのは Ref2VA だけ。"
                         f"音声を使うならモードを変える必要がある")
            import ref_audio as RA
            # 公式: 参照音声は1本2〜15秒・合計15秒以内
            total = u["frames"] / 24.0 * len(AUDIO_STEM[a.audio])
            if u["frames"] / 24.0 < 2.0 or total > 15.0:
                sys.exit(f"✗ {uid}: 参照音声 {len(AUDIO_STEM[a.audio])}本×"
                         f"{u['frames']/24:.2f}秒 = 合計{total:.2f}秒 — 公式上限(1本2〜15秒/"
                         f"合計15秒)を外れる")
            ra = [RA.make(uid, s) for s in AUDIO_STEM[a.audio]]
            dtag = _dtag(uid, units, packet_cuts()) if a.audio in ("lipsync", "full") else ""
            prompt = with_audio(prompt, a.audio, dtag)
        if a.dry:
            print(f"===== {uid} ({u['mode']} / {u['frames']}f / refs={u['refs'][:9]}) "
                  f"{len(prompt.split())}語 =====\n{prompt}\n")
            continue
        jid = submit(uid, u, prompt, a.t1, ref_audio=ra, seed=a.seed)
        jobs[uid] = jid
        print(f"{uid} → job {jid} ({u['mode']} / {u['frames']}f / {len(prompt.split())}語)")
    if jobs:
        print(json.dumps(jobs))


if __name__ == "__main__":
    main()
