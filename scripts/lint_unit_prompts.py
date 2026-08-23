#!/usr/bin/env python3
"""42単位プロンプトのlint + 素材要件の機械抽出(フロー②)。

チェック: プレースホルダの定義有無 / 参照アセットの実在 / detailed_descriptionの語数 /
禁止語(品質語) / 否定文の散文禁止パターン / non_diegetic_music: N/A の存在。
出力: docs/anipafe2026-prompts/requirements.json (単位→参照アセット/素材タグ)
"""
import json, re, glob, sys, urllib.request

KNOWN_PH={"HOMU_ID","UM_ID","ORB_ID","GEM_ID","QB_ID","EMBLEM_ID","MAJUU_ID","WALP_ID","DOLLS_ID",
 "S:PRO","S:MEM","S:CITY","S:DAY","S:STORM","S:A3","S:WATER","FOCUS","STYLE","LENS","DEPTH",
 "HALF_MOON","SOURCELESS_SHADOW","FRAME_A","FRAME_B","WATER_BASE","SEEOFF","REACH_HAND"}
QUALITY=re.compile(r"\b(cinematic|masterpiece|stunning|4k|8k|best quality|photoreal)\b",re.I)
BAD_NEG=re.compile(r"\bno (background music|music plays)\b",re.I)

def main():
    ok=True; req={}
    files=sorted(glob.glob("docs/anipafe2026-prompts/0[1-9]*.md"))
    units=0
    for f in files:
        t=open(f).read()
        for m in re.finditer(r"## (U\d+[ab]?) — ([^\(]+)\(([^\)]+)\)(.*?)(?=\n---\n## U|\Z)",t,re.S):
            uid,title,meta,body=m.group(1),m.group(2).strip(),m.group(3),m.group(4)
            units+=1
            code=re.search(r"```\n(.*?)\n```",body,re.S)
            if not code: print(f"✗ {uid}: コードブロック無し"); ok=False; continue
            pr=code.group(1)
            for ph in set(re.findall(r"\{\{([^}]+)\}\}",pr)):
                if ph not in KNOWN_PH: print(f"✗ {uid}: 未定義プレースホルダ {{{{{ph}}}}}"); ok=False
            assets=sorted({int(x) for x in re.findall(r"#(\d{3,4})",body)})
            mats=sorted(set(re.findall(r"M-\d+",body)))
            mode="I2VA" if pr.startswith("Create a video") else "Ref2VA"
            dd=re.search(r"detailed_description:(.*?)(?=\noverall_soundscape:)",pr,re.S)
            words=len(dd.group(1).split()) if dd else 0
            if mode=="Ref2VA" and not (250<=words<=560):
                print(f"⚠ {uid}: detailed_description {words}語 (目標350-500)")
            if QUALITY.search(pr): print(f"✗ {uid}: 品質語 {QUALITY.search(pr).group()}"); ok=False
            if BAD_NEG.search(pr): print(f"✗ {uid}: 散文の音楽禁止(フィールドで書く)"); ok=False
            if "non_diegetic_music: N/A" not in pr: print(f"✗ {uid}: non_diegetic_music: N/A 無し"); ok=False
            if mode=="Ref2VA":
                for sec in ("subject_definitions:","summary:","retention_analysis:","overall_soundscape:"):
                    if sec not in pr: print(f"✗ {uid}: {sec} 無し"); ok=False
            req[uid]={"title":title,"meta":meta.strip(),"mode":mode,"assets":assets,
                      "materials":mats,"dd_words":words,"file":f}
    # アセット実在確認
    missing=[]
    for uid,r in req.items():
        for a in r["assets"]:
            try: urllib.request.urlopen(f"http://localhost:8002/api/assets/{a}",timeout=5)
            except Exception: missing.append((uid,a)); ok=False
    for uid,a in missing: print(f"✗ {uid}: アセット#{a}が存在しない")
    # 承認済み素材の最新版をプロンプトが参照しているか(取りこぼしの再発防止)
    appr = "docs/anipafe2026-materials-approved.json"
    try:
        latest = json.load(open(appr))
    except FileNotFoundError:
        latest = {}
    used = {a for r in req.values() for a in r["assets"]}
    for mid, info in latest.items():
        a, unit = info["asset"], info["unit"]
        if a not in req.get(unit, {}).get("assets", []):
            print(f"✗ {unit}: {mid} の承認版 #{a} を参照していない "
                  f"(現在 {req.get(unit,{}).get('assets')})")
            ok = False
    json.dump(req,open("docs/anipafe2026-prompts/requirements.json","w"),ensure_ascii=False,indent=1)
    n_ref=sum(1 for r in req.values() if r['mode']=='Ref2VA')
    print(f"\n{units}単位 (Ref2VA {n_ref} / I2VA {units-n_ref}) → requirements.json")
    print("lint:", "PASS" if ok else "FAIL")
    return 0 if ok else 1
if __name__=="__main__": sys.exit(main())
