#!/usr/bin/env python3
"""Wait for jobs, evaluate each with ef_cut_eval.sh (brief body = pin intent), then place the best take per cut on Shots.
usage: ef_batch_eval_place.py <spec.json>  where spec = {"C23": {"jobs":[..], "ref":"path.mp4", "start":1481, "len":49, "gen":124}, ...}"""
import sys, json, time, re, subprocess, sqlite3, urllib.request
API='http://localhost:8002/api'; spec=json.load(open(sys.argv[1]))
cuts={int(l.split()[0]):tuple(map(int,l.split()[1:])) for l in open('outputs/kijun-ef/plan/cuts.tsv')}
db=sqlite3.connect('backend/data/kychapogas.db')
def status(j): return json.load(urllib.request.urlopen(f'{API}/jobs/{j}'))
alljobs=[j for v in spec.values() for j in v['jobs']]
while True:
    st={j:status(j)['status'] for j in alljobs}
    if all(s in ('completed','failed','cancelled') for s in st.values()): break
    time.sleep(60)
out={}
for cut,v in spec.items():
    n=int(v.get('cut', cut[1:])); pin=cuts[n][2]
    intent=v.get('body') or json.loads(db.execute('select attrs_json from clip where id=?',(pin,)).fetchone()[0] or '{}').get('intent','')
    body=f'{B}/eval_{cut}.txt' if False else f'outputs/kijun-ef/batch/eval_{cut}.txt'
    open(body,'w').write('生成の目的(カット意図): '+intent+'\n')
    procs=[]
    for j in v['jobs']:
        if st.get(j)!='completed': continue
        procs.append((j,subprocess.Popen(['scripts/ef_cut_eval.sh',str(j),v['ref'],f'{cut}t1','outputs/kijun-ef/batch',body],stdout=open(f'outputs/kijun-ef/batch/eval_{j}.log','w'),stderr=subprocess.STDOUT)))
    for j,p in procs: p.wait()
    best=None
    for j,_ in procs:
        log=open(f'outputs/kijun-ef/batch/eval_{j}.log').read()
        m=re.findall(r'総合[^0-9]*([0-9]+(?:\.[0-9]+)?)',log); sc=float(m[-1]) if m else -1
        nm=re.search(r'ncc=([0-9.\-]+)',log)
        if v.get('replace',True) and nm and float(nm.group(1))>=0.97:
            print(f"   {cut} job {j}: 参照動画との NCC {nm.group(1)} ≥ 0.97 → 未置換として除外"); sc=-1
        a=re.search(r'asset (\d+)',log); asset=int(a.group(1)) if a else None
        ncc=re.search(r'ncc=([0-9.\-]+)',log); out.setdefault(cut,[]).append((j,asset,sc,ncc.group(1) if ncc else '?'))
        if asset and (best is None or sc>best[2]): best=(j,asset,sc)
    if best and v.get('beat') is not None and best[2] <= float(v['beat']):
        print(f"{cut}: best job {best[0]} score {best[2]} <= 現行 {v['beat']} のため採用せず(テイク履歴には残る)")
    elif best and v.get('replace_clip'):
        r=urllib.request.Request(f"{API}/clips/{v['replace_clip']}",data=json.dumps({'asset_id':best[1],'asset_in_frame':0}).encode(),headers={'Content-Type':'application/json'},method='PATCH'); urllib.request.urlopen(r)
        print(f"{cut}: adopted job {best[0]} asset {best[1]} score {best[2]} into clip {v['replace_clip']} (現行 {v.get('beat')})")
    elif best and v.get('noplace'):
        print(f'{cut}: best job {best[0]} asset {best[1]} score {best[2]} (not placed; adopt via take history)')
    elif best:
        sp=round(v['gen']/v['len'],4)
        r=urllib.request.Request(f'{API}/clips/',data=json.dumps({'track_id':70,'asset_id':best[1],'start_frame':v['start'],'duration_frames':v['len'],'asset_in_frame':0}).encode(),headers={'Content-Type':'application/json'})
        cid=json.load(urllib.request.urlopen(r))['id']
        r=urllib.request.Request(f'{API}/clips/{cid}',data=json.dumps({'speed':sp,'duration_frames':v['len']}).encode(),headers={'Content-Type':'application/json'},method='PATCH'); urllib.request.urlopen(r)
        print(f'{cut}: placed job {best[0]} asset {best[1]} score {best[2]} clip {cid} speed {sp}')
    for row in out.get(cut,[]): print('   ',cut,'job',row[0],'asset',row[1],'score',row[2],'ncc',row[3])
json.dump(out,open(sys.argv[1]+'.result.json','w'),ensure_ascii=False,indent=1)
