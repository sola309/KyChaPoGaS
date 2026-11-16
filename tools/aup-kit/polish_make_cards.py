# make_cards.py : 置き換え済みの全画面の絵(project 37 の生成絵。元の素材ではない)から、カードの切り抜き用に「顔をまん中へ寄せた版」を作って登録する。
#   入力は project 37 の新しい絵だけ。足りない外側は鏡うつしを強くぼかした物(BORDER_REPLICATE)で埋める(カードの枠の外で、縮む 3 コマだけ見える所)。
import sys,json,cv2,numpy as np
sys.path.insert(0,'/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/tools/aup-kit'); import rebuild_lib as RL
OUT='/tmp/claude-1000/sakura-rebuild/POLISH/card/'
# asset: (名前, 顔の中心の割合 n, 拡大 k, 顔を置く場所(画面 px), カードのレイヤー)
SPEC={10236:('02決定',(0.27,0.27),0.9,(960,545),'o2940'),10237:('03決定',(0.37,0.37),1.3,(960,520),'o2943'),
      10242:('10',(0.30,0.42),0.6,(960,540),'o2945'),10238:('01 (2)',(0.80,0.42),0.8,(990,540),'o2947')}
res={}
ONLY=[int(x) for x in sys.argv[1:]]
for aid,(name,n,k,tg,lid) in SPEC.items():
    if ONLY and aid not in ONLY: continue
    p=RL.asset_path(aid); assert not any(x in p for x in RL.FORBIDDEN)
    im=cv2.imdecode(np.fromfile(p,np.uint8),cv2.IMREAD_COLOR); h,w=im.shape[:2]; assert (w,h)==(1920,1080),(w,h)
    M=np.float32([[k,0,tg[0]-k*n[0]*w],[0,k,tg[1]-k*n[1]*h]])
    out=cv2.warpAffine(im,M,(1920,1080),flags=cv2.INTER_AREA if k<1 else cv2.INTER_CUBIC,borderMode=cv2.BORDER_REFLECT_101)
    # 絵の外(鏡うつしで埋めた所)は強くぼかす(顔が 2 つ見えたり、すじが出たりしないように)。境目は 40px でなじませる
    valid=cv2.warpAffine(np.full((h,w),255,np.uint8),M,(1920,1080),flags=cv2.INTER_NEAREST,borderMode=cv2.BORDER_CONSTANT,borderValue=0)
    soft=cv2.GaussianBlur(out,(0,0),45)
    a=cv2.GaussianBlur(cv2.erode(valid,np.ones((41,41),np.uint8)),(0,0),14).astype(np.float32)[:,:,None]/255
    out=(out*a+soft*(1-a)).astype(np.uint8)
    fp=OUT+'polish_card_%d.png'%aid; cv2.imwrite(fp,out)
    a=RL.upload(fp,'polish_card_%s.png'%name)
    RL.put('POLISH','POLISH/card/%s.png'%name,a['id'],1920,1080,'gen+proc','make_cards.py: 生成絵 asset %d を k=%.2f で拡縮・平行移動して顔を (%d,%d) へ(外側は鏡うつしを強くぼかした物)。カードの切り抜きレイヤー %s 専用'%(aid,k,tg[0],tg[1],lid),'仮','元の絵は使っていない')
    res[aid]={'card_asset':a['id'],'layer':lid}; print(aid,'->',a['id'])
old=json.load(open(OUT+'cards.json')) if __import__('os').path.exists(OUT+'cards.json') else {}
old.update({str(k):v for k,v in res.items()}); json.dump(old,open(OUT+'cards.json','w'))
