import sqlite3,hashlib
def snap(p):
    c=sqlite3.connect(f"file:{p}?mode=ro",uri=True); out={}
    tabs=[r[0] for r in c.execute("select name from sqlite_master where type='table'")]
    for t in tabs:
        cols=[r[1] for r in c.execute(f"pragma table_info({t})")]
        for pid in (29,30,32,33):
            if 'project_id' in cols:
                q=f"select * from {t} where project_id={pid} order by 1"
            elif t=='clips' and 'track_id' in cols:
                q=f"select * from clips where track_id in (select id from tracks where project_id={pid}) order by 1"
            elif t=='projects':
                q=f"select * from projects where id={pid}"
            else: continue
            rows=c.execute(q).fetchall()
            out[(t,pid)]=(len(rows),hashlib.md5(repr(rows).encode()).hexdigest())
    return out
a=snap("outputs/backups/compositions_20261114/kychapogas_before.db"); b=snap("backend/data/kychapogas.db")
d=[(k,a.get(k),b.get(k)) for k in sorted(set(a)|set(b)) if a.get(k)!=b.get(k)]
print("diff",len(d)); [print(x) for x in d]
