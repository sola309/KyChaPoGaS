# mk_sil.py : 暗い場面の白い影絵(素材 11242 = 自分たちの生成絵 10440 から作った肌の形)の、目と口の穴を埋める(顔を出さない)。元素材は読まない。
import numpy as np, sys
from PIL import Image, ImageFilter
from scipy import ndimage
sys.path.insert(0,'/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/tools/aup-kit'); import rebuild_lib as RL
p=RL.asset_path(11242); assert not any(x in p for x in RL.FORBIDDEN)
im=Image.open(p).convert('RGBA'); a=np.asarray(im)[...,3]>100
f=ndimage.binary_fill_holes(ndimage.binary_closing(a,iterations=6))|a
out=Image.new('RGBA',im.size,(255,255,255,0)); out.putalpha(Image.fromarray((f*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)))
out.save('sil_noface.png'); print(im.size, a.sum(), f.sum())
v=Image.new('RGB',im.size,(40,10,30)); v.paste(out,(0,0),out); v.thumbnail((700,700)); v.save('th/sil_noface_view.jpg')
if '--up' in sys.argv: print(RL.upload('sil_noface.png','polish4_silhouette_noface.png'))
