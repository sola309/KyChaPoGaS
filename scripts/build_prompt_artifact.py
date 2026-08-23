#!/usr/bin/env python3
"""42単位プロンプト集をレビュー用の1枚HTMLに組む。

読み: docs/anipafe2026-prompts/*.md + requirements.json
出力: 引数のパス
設計: 台本(cut sheet)の体裁。骨格(フィールド名/[Shot N]/{{tag}}/<Picture N>)を
      視覚的に分離する — 公式が「骨格は正確な文字列で」と規定する部分こそ
      レビューで確かめたい箇所だから。
"""
import html, json, re, sys, glob

ACTS = [
    ("01", "序", "C1–C3", "黒・深紫・金"),
    ("02", "幕1 前半", "C4–C10", "記憶の額縁"),
    ("03", "幕1 後半", "C11–C16", "反転へ"),
    ("04", "幕2 前半", "C17–C24", "サビ1・偽街"),
    ("05", "幕2 後半", "C25–C35", "隠蔽・日常・裁き"),
    ("06", "間奏", "C36–C42", "一回性の記録"),
    ("07", "幕3 前半", "C43–C53", "対話・決裂・交互切り"),
    ("08", "幕3 後半", "C54–C59", "融合・涙の対"),
    ("09", "終", "C60–C67", "一巡・契約・回帰"),
]
# 判断を仰ぐ単位
FLAGGED = {
    "U03": "ロゴ6点を生成から外し編集オーバーレイへ回した",
    "U16": "参照9枚の上限構成。本番前にT1でA/B推奨",
    "U25": "C38はジェムの公式情報が皆無のため代案で執筆",
}

FIELDS = ("subject_definitions", "summary", "retention_analysis",
          "detailed_description", "overall_soundscape", "non_diegetic_music")


def mark(code: str) -> str:
    """骨格を視覚的に分離する。"""
    s = html.escape(code)
    s = re.sub(r"^(%s):" % "|".join(FIELDS), r'<b class="fld">\1:</b>', s, flags=re.M)
    s = re.sub(r"(\[Shot \d+\](?: At \d\d:\d\d\.\d\d\d,)?)", r'<b class="shot">\1</b>', s)
    s = re.sub(r"(\{\{[^}]+\}\})", r'<b class="tag">\1</b>', s)
    s = re.sub(r"(&lt;Pictures? [\d\-, ]+&gt;)", r'<b class="pic">\1</b>', s)
    s = re.sub(r"\b(fully_preserved|partially_preserved|attribute_transfer|weak_reference)\b",
               r'<b class="ret">\1</b>', s)
    s = re.sub(r"^(Create a video from this image\.)", r'<b class="fld">\1</b>', s, flags=re.M)
    return s


def main():
    req = json.load(open("docs/anipafe2026-prompts/requirements.json"))
    units = {}
    for f in sorted(glob.glob("docs/anipafe2026-prompts/0[1-9]*.md")):
        t = open(f).read()
        for m in re.finditer(r"## (U\d+) — ([^\n]+)\n(.*?)(?=\n---\n## U|\Z)", t, re.S):
            uid, head, body = m.group(1), m.group(2), m.group(3)
            code = re.search(r"```\n(.*?)\n```", body, re.S).group(1)
            notes = body.split("```")[0].strip()
            units[uid] = {"head": head, "notes": notes, "code": code,
                          "act": f.split("/")[-1][:2], **req[uid]}

    n_ref = sum(1 for u in units.values() if u["mode"] == "Ref2VA")
    assets = sorted({a for u in units.values() for a in u["assets"]})

    nav, cards = [], []
    for act_id, act_name, act_cuts, act_sub in ACTS:
        us = [(k, v) for k, v in sorted(units.items()) if v["act"] == act_id]
        nav.append(f'<li class="nav-act"><span>{act_name}</span><em>{act_cuts}</em></li>')
        for uid, u in us:
            flag = ' <i class="dot"></i>' if uid in FLAGGED else ""
            nav.append(f'<li><a href="#{uid}"><b>{uid}</b>{html.escape(u["title"])}{flag}</a></li>')

        cards.append(
            f'<h2 class="act" id="act{act_id}"><span class="act-n">{act_name}</span>'
            f'<span class="act-c">{act_cuts}</span>'
            f'<span class="act-s">{act_sub}</span></h2>')
        for uid, u in us:
            gen = re.search(r"生成(\d+)f", u["meta"])
            act_f = re.search(r"実尺(\d+)f", u["meta"])
            secs = re.search(r"=([\d.]+)s", u["meta"])
            use = round(int(act_f.group(1)) / int(gen.group(1)) * 100) if gen and act_f else None
            beats = u["meta"].split("/")[-1].strip()
            refs = " ".join(f'<span class="ref">#{a}</span>' for a in u["assets"])
            mats = " ".join(f'<span class="mat">{m}</span>' for m in u["materials"])
            flagged = uid in FLAGGED
            note_html = html.escape(u["notes"]).replace("⚠", '<span class="warn">⚠</span>')
            note_html = re.sub(r"&lt;Pictures? [\d\-, ]+&gt;",
                               lambda m: f'<b class="pic">{m.group()}</b>', note_html)
            cards.append(f'''
<article class="unit{' flagged' if flagged else ''}" id="{uid}" data-mode="{u['mode']}" data-flag="{int(flagged)}">
  <header>
    <h3><span class="uid">{uid}</span> {html.escape(u["title"])}</h3>
    <span class="chip {u['mode'].lower()}">{u['mode']}</span>
  </header>
  <dl class="specs">
    <div><dt>生成</dt><dd>{gen.group(1) if gen else '—'}<small>f</small></dd></div>
    <div><dt>実尺</dt><dd>{act_f.group(1) if act_f else '—'}<small>f</small></dd></div>
    <div><dt>使用率</dt><dd>{use if use else '—'}<small>%</small></dd></div>
    <div><dt>秒</dt><dd>{secs.group(1) if secs else '—'}<small>s</small></dd></div>
    <div><dt>打点</dt><dd class="beat">{html.escape(beats)}</dd></div>
  </dl>
  {'<p class="flagnote"><span class="warn">要確認</span>' + html.escape(FLAGGED[uid]) + '</p>' if flagged else ''}
  <p class="notes">{note_html}</p>
  <div class="reflist">{refs}{mats}</div>
  <pre class="prompt"><code>{mark(u["code"])}</code></pre>
</article>''')

    doc = f'''<title>AniPAFE2026 生成単位プロンプト集</title>
<style>
:root{{
  --bg:#f6f4f9; --panel:#fff; --panel2:#f0edf5; --line:#e0dbe9; --line2:#cfc7dd;
  --ink:#1b1722; --ink2:#544d63; --ink3:#847c96;
  --violet:#6d4de0; --violet-bg:#efeafd;
  --gold:#8a6420; --red:#bf2f4a; --red-bg:#fdecef;
  --code-bg:#faf9fc;
}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{
  --bg:#121019; --panel:#1a1724; --panel2:#221e2f; --line:#2c2740; --line2:#3d3656;
  --ink:#e9e6f2; --ink2:#a49bbd; --ink3:#7b7295;
  --violet:#a98bff; --violet-bg:#251d40;
  --gold:#d0a44e; --red:#f4708a; --red-bg:#33161f;
  --code-bg:#151220;
}}}}
:root[data-theme="dark"]{{
  --bg:#121019; --panel:#1a1724; --panel2:#221e2f; --line:#2c2740; --line2:#3d3656;
  --ink:#e9e6f2; --ink2:#a49bbd; --ink3:#7b7295;
  --violet:#a98bff; --violet-bg:#251d40;
  --gold:#d0a44e; --red:#f4708a; --red-bg:#33161f;
  --code-bg:#151220;
}}
*{{box-sizing:border-box}}
body{{
  background:var(--bg); color:var(--ink); margin:0;
  font:15px/1.65 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif;
  font-feature-settings:"palt";
}}
.wrap{{display:grid; grid-template-columns:236px minmax(0,1fr); gap:40px;
  max-width:1360px; margin:0 auto; padding:0 24px 120px}}
@media (max-width:900px){{.wrap{{grid-template-columns:1fr; gap:0}} .rail{{position:static!important;height:auto!important}}}}

/* masthead */
.mast{{grid-column:1/-1; padding:44px 0 26px; border-bottom:2px solid var(--ink)}}
.kicker{{font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--violet);
  font-weight:700; margin:0 0 10px}}
h1{{font-size:clamp(26px,3.4vw,40px); line-height:1.15; margin:0 0 8px; letter-spacing:-.02em;
  text-wrap:balance; font-weight:800}}
.sub{{color:var(--ink2); margin:0; max-width:62ch}}
.stats{{display:flex; flex-wrap:wrap; gap:28px; margin:24px 0 0; padding:0; list-style:none}}
.stats li{{display:flex; flex-direction:column; gap:2px}}
.stats b{{font-size:24px; font-weight:800; font-variant-numeric:tabular-nums; line-height:1}}
.stats span{{font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink3)}}

/* rail */
.rail{{position:sticky; top:0; align-self:start; height:100vh; overflow-y:auto;
  padding:26px 0 40px; font-size:13px}}
.rail ul{{list-style:none; margin:0; padding:0}}
.rail a{{display:flex; gap:8px; align-items:baseline; padding:3px 8px; border-radius:5px;
  color:var(--ink2); text-decoration:none}}
.rail a:hover{{background:var(--panel2); color:var(--ink)}}
.rail a:focus-visible{{outline:2px solid var(--violet); outline-offset:1px}}
.rail a b{{font-variant-numeric:tabular-nums; color:var(--ink3); font-weight:600; font-size:11px;
  min-width:26px}}
.nav-act{{display:flex; justify-content:space-between; align-items:baseline;
  margin:18px 0 5px; padding:0 8px 4px; border-bottom:1px solid var(--line);
  font-size:11px; letter-spacing:.08em; color:var(--ink); font-weight:700}}
.nav-act em{{font-style:normal; color:var(--ink3); font-weight:500;
  font-variant-numeric:tabular-nums}}
.dot{{width:5px;height:5px;border-radius:50%;background:var(--red);display:inline-block}}

/* filters */
.tools{{position:sticky; top:0; z-index:5; display:flex; gap:8px; flex-wrap:wrap; align-items:center;
  padding:14px 0; margin-bottom:6px; background:var(--bg); border-bottom:1px solid var(--line)}}
.tools button{{font:inherit; font-size:12px; padding:5px 12px; border-radius:999px; cursor:pointer;
  border:1px solid var(--line2); background:transparent; color:var(--ink2)}}
.tools button:hover{{border-color:var(--violet); color:var(--ink)}}
.tools button[aria-pressed="true"]{{background:var(--ink); border-color:var(--ink); color:var(--bg)}}
.tools button:focus-visible{{outline:2px solid var(--violet); outline-offset:2px}}
.tools .count{{margin-left:auto; font-size:12px; color:var(--ink3); font-variant-numeric:tabular-nums}}

/* act heading */
h2.act{{display:flex; gap:14px; align-items:baseline; flex-wrap:wrap;
  margin:52px 0 18px; padding-bottom:8px; border-bottom:1px solid var(--line2)}}
.act-n{{font-size:19px; font-weight:800; letter-spacing:-.01em}}
.act-c{{font-size:12px; font-variant-numeric:tabular-nums; color:var(--violet); font-weight:700}}
.act-s{{font-size:12px; color:var(--ink3); margin-left:auto}}

/* unit */
.unit{{background:var(--panel); border:1px solid var(--line); border-radius:10px;
  padding:20px 22px; margin-bottom:16px; scroll-margin-top:70px}}
.unit.flagged{{border-left:3px solid var(--red)}}
.unit header{{display:flex; gap:12px; align-items:center; margin-bottom:14px}}
.unit h3{{font-size:17px; margin:0; font-weight:700; letter-spacing:-.01em; flex:1}}
.uid{{font-variant-numeric:tabular-nums; color:var(--violet); font-weight:800; margin-right:6px}}
.chip{{font-size:10px; letter-spacing:.09em; font-weight:700; padding:3px 9px; border-radius:999px;
  border:1px solid currentColor}}
.chip.ref2va{{color:var(--violet)}}
.chip.i2va{{color:var(--gold)}}

.specs{{display:flex; flex-wrap:wrap; gap:0; margin:0 0 14px; padding:10px 0;
  border-block:1px solid var(--line)}}
.specs div{{padding-right:22px; margin-right:22px; border-right:1px solid var(--line)}}
.specs div:last-child{{border:0; margin:0; padding:0}}
.specs dt{{font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink3); margin:0}}
.specs dd{{margin:1px 0 0; font-size:17px; font-weight:700; font-variant-numeric:tabular-nums}}
.specs dd small{{font-size:11px; font-weight:500; color:var(--ink3); margin-left:1px}}
.specs dd.beat{{font-size:13px; font-weight:600; color:var(--ink2); padding-top:3px}}

.flagnote{{background:var(--red-bg); border-radius:6px; padding:9px 12px; margin:0 0 12px;
  font-size:13px; color:var(--ink)}}
.warn{{color:var(--red); font-weight:700; margin-right:7px}}
.notes{{margin:0 0 12px; font-size:13.5px; color:var(--ink2); line-height:1.75}}
.reflist{{display:flex; flex-wrap:wrap; gap:5px; margin-bottom:14px}}
.ref,.mat{{font-size:11px; padding:2px 8px; border-radius:4px; font-variant-numeric:tabular-nums;
  background:var(--panel2); color:var(--ink2)}}
.mat{{background:var(--violet-bg); color:var(--violet); font-weight:600}}

pre.prompt{{background:var(--code-bg); border:1px solid var(--line); border-radius:7px;
  padding:15px 17px; margin:0; overflow-x:auto;
  font:12.5px/1.75 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  white-space:pre-wrap; word-break:break-word; color:var(--ink2)}}
.prompt .fld{{color:var(--ink); font-weight:700}}
.prompt .shot{{color:var(--gold); font-weight:700}}
.prompt .tag{{color:var(--violet); font-weight:600}}
.prompt .pic{{color:var(--ink); background:var(--panel2); padding:0 3px; border-radius:3px}}
.prompt .ret{{color:var(--violet); font-style:italic}}
.notes .pic{{font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--ink)}}
.hidden{{display:none}}
.legend{{display:flex; gap:18px; flex-wrap:wrap; font-size:11.5px; color:var(--ink3);
  padding:10px 0 0}}
.legend b{{font-weight:700}}
</style>
<div class="wrap">
<header class="mast">
  <p class="kicker">AniPAFE2026 ／ ゲート2 レビュー</p>
  <h1>生成単位プロンプト集</h1>
  <p class="sub">全67カットを42の生成単位にまとめた MiniMax H3 プロンプト。骨格
  （フィールド名・<code>[Shot N]</code>・<code>{{{{タグ}}}}</code>・参照ラベル）は公式が
  「正確な文字列で」と規定する部分なので、本文と色で分けて表示しています。</p>
  <ul class="stats">
    <li><b>42</b><span>生成単位</span></li>
    <li><b>{n_ref}</b><span>Ref2VA</span></li>
    <li><b>{len(units)-n_ref}</b><span>I2VA</span></li>
    <li><b>{len(assets)}</b><span>参照アセット</span></li>
    <li><b>92<small style="font-size:13px">%</small></b><span>フレーム使用率</span></li>
    <li><b>3</b><span>要確認</span></li>
  </ul>
  <div class="legend">
    <span><b class="fld" style="color:var(--ink)">フィールド名</b></span>
    <span><b style="color:var(--gold)">[Shot N] / 時刻</b></span>
    <span><b style="color:var(--violet)">{{{{展開タグ}}}}・retention</b></span>
    <span><b style="background:var(--panel2);padding:0 3px;border-radius:3px">&lt;Picture N&gt;</b></span>
  </div>
</header>

<nav class="rail"><ul>{"".join(nav)}</ul></nav>

<main>
  <div class="tools">
    <button data-f="all" aria-pressed="true">すべて</button>
    <button data-f="Ref2VA" aria-pressed="false">Ref2VA</button>
    <button data-f="I2VA" aria-pressed="false">I2VA</button>
    <button data-f="flag" aria-pressed="false">要確認のみ</button>
    <span class="count"></span>
  </div>
  {"".join(cards)}
</main>
</div>
<script>
const btns=[...document.querySelectorAll('.tools button')];
const units=[...document.querySelectorAll('.unit')];
const acts=[...document.querySelectorAll('h2.act')];
const count=document.querySelector('.count');
function apply(f){{
  units.forEach(u=>{{
    const ok = f==='all' || (f==='flag' ? u.dataset.flag==='1' : u.dataset.mode===f);
    u.classList.toggle('hidden',!ok);
  }});
  acts.forEach(h=>{{
    let n=h.nextElementSibling, any=false;
    while(n && n.tagName==='ARTICLE'){{ if(!n.classList.contains('hidden')) any=true; n=n.nextElementSibling; }}
    h.classList.toggle('hidden',!any);
  }});
  const shown=units.filter(u=>!u.classList.contains('hidden')).length;
  count.textContent=shown+' / '+units.length+' 単位';
}}
btns.forEach(b=>b.addEventListener('click',()=>{{
  btns.forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
  apply(b.dataset.f);
}}));
apply('all');
</script>'''
    open(sys.argv[1], "w").write(doc)
    print(f"{sys.argv[1]}: {len(units)}単位")


if __name__ == "__main__":
    main()
