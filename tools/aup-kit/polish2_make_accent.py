# mk_accent.py : 丸窓の場面の影絵の「赤い部分」を作り直す(髪・目・口を赤にせず、水着・パレオ・花・ボールだけ赤)。
# 入力は生成絵の切り抜き(project 37 の素材 10504 = genb_257.png)だけ。元素材は読まない。
import numpy as np
from PIL import Image,ImageFilter
A='/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/backend/data/assets/37/'
c=np.asarray(Image.open(A+'genb_257.png').convert('RGBA')).astype(np.int32)
H,W=c.shape[:2]; r,g,b,a=c[...,0],c[...,1],c[...,2],c[...,3]
yy,xx=np.mgrid[0:H,0:W]; X=xx/W; Y=yy/H
op=a>128
red=(r>70)&(g<75)&(b<95)&(r-g>55)
orange=(r>150)&(g>60)&(g<200)&(b<110)&(r-b>90)
brown=(r>110)&(g>40)&(g<120)&(b<60)
m=np.zeros((H,W),bool)
m|=op&red&(X>0.44)&(X<0.62)&(Y>0.295)&(Y<0.44)            # 水着の上
m|=op&(red|orange|brown)&(X>0.43)&(X<0.92)&(Y>0.40)&(Y<0.72)   # パレオと水着の下
m|=op&(r>215)&(g<70)&(X<0.30)&(Y<0.235)                        # ボールの赤
m|=op&(r>200)&(g>140)&(b>140)&(X>0.304)&(X<0.362)&(Y>0.213)&(Y<0.272)&~((r>240)&(g>235)&(b>200)&(X>0.345)) # 花
im=Image.fromarray((m*255).astype(np.uint8))
im=im.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9)).filter(ImageFilter.MedianFilter(5))
out=Image.new('RGBA',(W,H),(230,81,99,0)); out.putalpha(im)
out.save('accent_10504.png')
v=out.resize((W//4,H//4)); bg=Image.new('RGB',v.size,(60,66,78)); bg.paste(v,(0,0),v); bg.crop((0,0,987,750)).save('accent_view.jpg')
