#!/usr/bin/env python3
"""素材承認シートを1枚のHTMLに組む(ゲート用)。

使い方: python3 scripts/build_approval_page.py <out.html> <verdict_json>
verdict_json: [{"id":"M-1","title":"半月・本作基準","use":"C1,C17,C22,C51,C67",
                "cands":[{"asset":2948,"seed":1,"rec":true,"note":"..."}],
                "note":"...","status":"ok|retry"}]
画像はdata URIで埋め込む(CSP対策・単体で開ける)。
"""
import base64, json, sys, urllib.request
from io import BytesIO
from PIL import Image

B = "http://localhost:8002/api"

def thumb(aid, w=560):
    a = json.load(urllib.request.urlopen(f"{B}/assets/{aid}"))
    im = Image.open(a["file_path"]).convert("RGB")
    im = im.resize((w, int(im.height * w / im.width)), Image.LANCZOS)
    b = BytesIO(); im.save(b, "JPEG", quality=86)
    return "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()

def main():
    out, vpath = sys.argv[1], sys.argv[2]
    mats = json.load(open(vpath))
    rows = []
    for m in mats:
        cards = []
        for c in m["cands"]:
            rec = " rec" if c.get("rec") else ""
            cards.append(
                f'<figure class="cand{rec}"><img src="{thumb(c["asset"])}" alt="">'
                f'<figcaption><b>#{c["asset"]}</b> seed{c["seed"]}'
                f'{" ★推薦" if c.get("rec") else ""}'
                f'<span>{c.get("note","")}</span></figcaption></figure>')
        rows.append(
            f'<section class="mat {m.get("status","ok")}"><h2>{m["id"]} — {m["title"]}'
            f'<span class="use">使い先: {m["use"]}</span></h2>'
            f'<p class="note">{m.get("note","")}</p>'
            f'<div class="cands">{"".join(cards)}</div></section>')
    html = """<title>AniPAFE2026 素材承認シート</title>
<style>
:root{--bg:#fff;--fg:#1a1a1c;--sub:#5b5b63;--line:#dedee3;--rec:#0a7f5f;--warn:#b45309}
:root:not([data-theme="light"]) @media (prefers-color-scheme:dark){}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#131316;--fg:#ececf0;--sub:#a0a0aa;--line:#2e2e36;--rec:#3ddba4;--warn:#fbbf24}}
:root[data-theme="dark"]{--bg:#131316;--fg:#ececf0;--sub:#a0a0aa;--line:#2e2e36;--rec:#3ddba4;--warn:#fbbf24}
body{background:var(--bg);color:var(--fg);font:15px/1.7 system-ui,"Hiragino Sans",sans-serif;margin:0;padding:32px 20px 80px}
.wrap{max-width:1240px;margin:0 auto}
h1{font-size:26px;margin:0 0 6px}
.lead{color:var(--sub);margin:0 0 32px}
.mat{border-top:1px solid var(--line);padding:22px 0}
.mat h2{font-size:17px;margin:0 0 4px;display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
.use{font-size:12px;color:var(--sub);font-weight:400}
.note{color:var(--sub);font-size:13px;margin:0 0 12px}
.cands{display:flex;gap:14px;flex-wrap:wrap}
figure{margin:0;max-width:560px;flex:1 1 400px}
figure img{width:100%;height:auto;border-radius:7px;border:2px solid transparent;display:block}
figure.rec img{border-color:var(--rec)}
figcaption{font-size:12px;color:var(--sub);padding-top:5px}
figcaption span{display:block}
.retry h2::after{content:"要再試行";color:var(--warn);font-size:12px}
</style>
<div class="wrap"><h1>AniPAFE2026 素材承認シート</h1>
<p class="lead">★=私の推薦。承認/差し替え/やり直しをご指示ください。承認後にH3映像生成へ進みます。</p>
""" + "".join(rows) + "</div>"
    open(out, "w").write(html)
    print(f"{out}: {len(mats)}素材")

if __name__ == "__main__":
    main()
