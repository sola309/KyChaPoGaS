# CPU-only: estimate MiniMax H3 packed sequence length per job, mirroring
# comfy_extras/nodes_minimax_h3.py (MiniMaxH3ReferenceToVideo) and
# comfy/ldm/minimax/model.py (PackedLayout) and comfy/text_encoders/minimax.py.
import json, math, re, sqlite3, subprocess, os
from transformers import Qwen2Tokenizer

TOK = "/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/tools/comfyui/comfy/text_encoders/qwen25_tokenizer"
tok = Qwen2Tokenizer.from_pretrained(TOK)
INP = "/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/tools/comfyui/input"
H = json.load(open(os.path.join(os.path.dirname(__file__), "comfy_history.json")))
MAXPIX = 768 * 1344


def snap(n):
    while n % 17 != 5:
        n += 1
    return n


def lat_t(f):
    return 2 if f <= 5 else ((f - 5) // 17) * 5 + 2


def r32(x):
    return max(32, round(x / 32) * 32)


def ref_img_size(w, h, W, Hh, mode):
    s = min(1.0, math.sqrt((W * Hh) / (w * h))) if mode == "match" else min(1.0, 2048 / min(w, h))
    return r32(w * s), r32(h * s)


def adapt_canvas(w, h):
    ratio = w / h
    nw, nh = (768 * ratio, 768) if ratio >= 1 else (768, 768 / ratio)
    if nw * nh > MAXPIX:
        s = math.sqrt(MAXPIX / (nw * nh)); nw, nh = nw * s, nh * s
    cw, ch = r32(nw), r32(nh)
    if w * h < cw * ch:
        cw, ch = r32(w), r32(h)
    return cw, ch


def qwen_tokens(w, h):
    # Qwen3-VL: patch16 x merge2 -> one token per 32x32 (smart resize to multiples of 32)
    return (round(h / 32)) * (round(w / 32))


def estimate(prompt, W, Hh, length, mode, imgs, vids, guides):
    F = snap(length)
    lt = lat_t(F)
    frame_rows = (W // 32) * (Hh // 32)
    text = 0; ref_img = 0; ref_vid = 0; cond = 0
    q_img = 0; q_vid = 0
    for i, (w, h) in enumerate(imgs, 1):
        tw, th = ref_img_size(w, h, W, Hh, mode)
        n = (th // 32) * (tw // 32)
        ref_img += n
        q = qwen_tokens(tw, th); q_img += q + 2
        text += len(tok(f"<Picture {i}>: ")["input_ids"])
    for k, (vw, vh, nf) in enumerate(vids, 1):
        cw, ch = adapt_canvas(vw, vh)
        n = min(nf, F)
        while n % 17 != 5:
            n -= 1
        ref_vid += lat_t(n) * (cw // 32) * (ch // 32)
        nq = len(range(0, n, 12)); nq += nq % 2
        blocks = nq // 2
        q_vid += blocks * (qwen_tokens(cw, ch) + 2 + 6)
        text += len(tok(f"<Video {k}>: ")["input_ids"])
    for (gw, gh) in guides:
        cond += frame_rows  # 1-frame guide -> 1 latent frame on target grid
    ptoks = len(tok(prompt)["input_ids"])
    text += ptoks + q_img + q_vid
    audio = round(F / 24 * 40) * 2
    target = lt * frame_rows
    total = text + ref_img + ref_vid + cond + audio + target
    return dict(frames=F, latent_t=lt, prompt_tok=ptoks, text_len=text, qwen_img=q_img, qwen_vid=q_vid,
                ref_img=ref_img, ref_vid=ref_vid, guide=cond, audio=audio, target=target, total=total)


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,nb_frames", "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()
    w, h, n = out.split(",")[:3]
    return int(w), int(h), int(n)


def from_history(prefix):
    from PIL import Image
    k = [x for x in H if x.startswith(prefix)][0]
    pr = H[k]["prompt"][2]; inp = pr["cond"]["inputs"]
    imgs = []
    for key in sorted(x for x in inp if x.startswith("ref_images.")):
        with Image.open(os.path.join(INP, pr[inp[key][0]]["inputs"]["image"])) as im:
            imgs.append(im.size)
    vids = []
    for key in sorted(x for x in inp if x.startswith("ref_videos.")):
        src = pr[inp[key][0]]["inputs"]["video"][0]
        vids.append(probe(os.path.join(INP, pr[src]["inputs"]["file"])))
    guides = [(0, 0) for n, v in pr.items() if v["class_type"] == "MiniMaxH3AddGuide"]
    return estimate(inp["prompt"], inp["width"], inp["height"], inp["length"], inp["ref_image_size"], imgs, vids, guides)


def from_db(jid, img_dims, vid):
    c = sqlite3.connect("file:/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/backend/data/kychapogas.db?mode=ro", uri=True)
    p = json.loads(c.execute("select params from job where id=?", (jid,)).fetchone()[0])
    F = round(p["duration_sec"] * 24)
    return estimate(p["prompt"], p["width"], p["height"], F, p["ref_image_size"], img_dims, [vid], [])


rows = {
    "7311 (345f, 12 requested/9 sent) COLLAPSED": from_history("1fa538ac"),
    "7478 (226f, 13 requested/9 sent, 1 guide) OK": from_history("f93eb5ee"),
    "C13_15 872928fa (277f, 5 pics) OK": from_history("872928fa"),
    "C13_15 cbd7900b (277f, 4 pics, guide) OK": from_history("cbd7900b"),
    "4714 (328f@1344, 1 pic) COLLAPSED": from_db(4714, [(1114, 626)], (1920, 1080, 328)),
    "4709 (328f@1152x640, 1 pic) OK": from_db(4709, [(1114, 626)], (1920, 1080, 328)),
    "4600 (362f@1344, 1 pic) OOM": from_db(4600, [(1114, 626)], (1920, 1080, 362)),
}
# hypothetical: 7311 with 0 / 3 images, and split into 2 x 185f
for name, r in rows.items():
    print(f"{name:48s} total={r['total']:>7,}  target={r['target']:>7,} refvid={r['ref_vid']:>7,} refimg={r['ref_img']:>6,} text={r['text_len']:>6,} (prompt {r['prompt_tok']}, qwen img {r['qwen_img']}, qwen vid {r['qwen_vid']}) guide={r['guide']} audio={r['audio']}")
json.dump(rows, open(os.path.join(os.path.dirname(__file__), "seqlen.json"), "w"), indent=1)
