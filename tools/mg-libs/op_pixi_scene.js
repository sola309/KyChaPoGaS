// ===== Pixi + GSAP + shader-filter OP — deterministic window.seek(t), beat-synced =====
const W=1920,H=1080, K=window.kycha||{};
const FPS=K.fps||30, DUR=K.duration||15;
const beats=(K.beats||[]).slice().sort((a,b)=>a-b);
const downs=(K.downbeats||[]).slice().sort((a,b)=>a-b);
const EN=K.energy||[], BS=K.bass||[], TR=K.treble||[];
const F=PIXI.filters;
const clamp=(v,a,b)=>v<a?a:v>b?b:v, lerp=(a,b,t)=>a+(b-a)*t;
const arr=(a,t)=>{if(!a.length)return 0;const i=clamp(t*FPS,0,a.length-1),i0=i|0;return lerp(a[i0],a[Math.min(a.length-1,i0+1)],i-i0);};
const pulse=(L,t,d)=>{let e=0;for(const b of L){if(b<=t){const x=(t-b)/d;if(x<6)e=Math.max(e,Math.exp(-x));}}return e;};
const lastB=(L,t)=>{let r=-9;for(const b of L)if(b<=t)r=b;return r;};
const IMG=id=>{const e=document.getElementById('im_'+id);const bt=new PIXI.BaseTexture(e);bt.update();return {tex:new PIXI.Texture(bt),w:e.naturalWidth,h:e.naturalHeight};};

let app, root, tl, shake, layers={}, FX={}, inited=false;

function coverSprite(key){const im=IMG(key);const s=new PIXI.Sprite(im.tex);s.anchor.set(0.5);s.x=W/2;s.y=H/2;
  s._cover=Math.max(W/im.w,H/im.h);s.scale.set(s._cover);s._iw=im.w;s._ih=im.h;return s;}
function placed(key,cx,cy,frac){const im=IMG(key);const s=new PIXI.Sprite(im.tex);s.anchor.set(0.5);s.x=cx;s.y=cy;
  const sc=(H*frac)/im.h;s.scale.set(sc);s._base=sc;return s;}

function init(){
  app=new PIXI.Application({width:W,height:H,backgroundColor:0x05030a,antialias:true,preserveDrawingBuffer:true});
  document.body.appendChild(app.view); app.ticker.stop();
  root=new PIXI.Container(); app.stage.addChild(root);
  shake=new PIXI.Container(); root.addChild(shake);

  // ----- layered shot containers -----
  const C=()=>{const c=new PIXI.Container();shake.addChild(c);c.alpha=0;return c;};
  layers.s1=C(); layers.s2=C(); layers.s3=C(); layers.s4=C();

  // Shot1: portraitA hero + soft bg (room)
  layers.s1.addChild(coverSprite('room'));
  const veil1=new PIXI.Graphics().beginFill(0x140a22,0.45).drawRect(0,0,W,H).endFill(); layers.s1.addChild(veil1);
  const pA=coverSprite('portraitA'); pA.x=W*0.56; layers.s1.addChild(pA); layers.s1._hero=pA;

  // Shot2: city bg + portraitB placed (layered compositing!) + panel
  layers.s2.addChild(coverSprite('city'));
  layers.s2.addChild(new PIXI.Graphics().beginFill(0x08041a,0.4).drawRect(0,0,W,H).endFill());
  const pB=placed('portraitB',W*0.62,H*0.56,1.02); layers.s2.addChild(pB); layers.s2._pB=pB;
  const panel=new PIXI.Container(); panel.x=W*0.2; panel.y=H*0.5; layers.s2.addChild(panel); layers.s2._panel=panel;
  const pic=placed('sky',0,0,0.42); const mask=new PIXI.Graphics().beginFill(0xffffff).drawRect(-300,-200,600,400).endFill();
  const border=new PIXI.Graphics().lineStyle(5,0x6cf0ff,1).drawRect(-300,-200,600,400);
  panel.addChild(pic); pic.mask=mask; panel.addChild(mask); panel.addChild(border);

  // Shot3: fullA full-frame DROP
  layers.s3.addChild(coverSprite('fullA')); layers.s3._hero=layers.s3.children[0];
  layers.s3.addChild(new PIXI.Graphics().beginFill(0x2a0030,0.25).drawRect(0,0,W,H).endFill());

  // Shot4: sky + both characters outro
  layers.s4.addChild(coverSprite('sky'));
  const oA=placed('portraitA',W*0.3,H*0.55,1.05); const oB=placed('portraitB',W*0.72,H*0.55,1.05);
  layers.s4.addChild(oA); layers.s4.addChild(oB);

  // ----- text (Pixi.Text) -----
  const titleStyle=new PIXI.TextStyle({fontFamily:'Arial Black',fontSize:200,fontWeight:'900',fill:0xffffff,letterSpacing:6});
  const title=new PIXI.Text('RESONANCE',titleStyle); title.anchor.set(0.5); title.x=W/2; title.y=H/2; title.alpha=0;
  title.filters=[new F.GlowFilter({distance:40,outerStrength:2.2,color:0xff4d96,quality:0.4})];
  shake.addChild(title); FX.title=title;
  const sub=new PIXI.Text('Feel the light, forever shine',new PIXI.TextStyle({fontFamily:'Arial',fontSize:46,fontWeight:'700',fill:0xeafcff,letterSpacing:3}));
  sub.anchor.set(0.5); sub.x=W/2; sub.y=H*0.62; sub.alpha=0; shake.addChild(sub); FX.sub=sub;
  const lyric=new PIXI.Text('In the fading light I call your name',new PIXI.TextStyle({fontFamily:'Arial',fontSize:50,fontWeight:'800',fill:0xeafcff,letterSpacing:2,dropShadow:true,dropShadowColor:0x3a78ff,dropShadowBlur:14,dropShadowDistance:0}));
  lyric.anchor.set(0.5); lyric.x=W/2; lyric.y=H*0.86; lyric.alpha=0; shake.addChild(lyric); FX.lyric=lyric;

  // ----- global post FX -----
  const grade=new F.AdjustmentFilter({saturation:1.12,contrast:1.12,brightness:1.0,gamma:1.05});
  const bloom=new F.AdvancedBloomFilter({threshold:0.9,bloomScale:0.7,brightness:1.0,blur:5,quality:4});
  const god=new F.GodrayFilter({gain:0.35,lacunarity:2.4,angle:-32,parallel:true,alpha:0.5});
  const rgb=new F.RGBSplitFilter([0,0],[0,0],[0,0]);
  const crt=new F.CRTFilter({vignetting:0.32,vignettingAlpha:0.9,noise:0.06,lineWidth:1.0,lineContrast:0.12,time:0});
  const zoom=new F.ZoomBlurFilter({strength:0,center:[W/2,H/2],innerRadius:120});
  const shock=new F.ShockwaveFilter([W/2,H/2],{amplitude:0,wavelength:220,speed:900,brightness:1.1},-1);
  app.stage.filters=[grade,god,rgb,zoom,shock,bloom,crt];
  FX.bloom=bloom; FX.god=god; FX.rgb=rgb; FX.crt=crt; FX.zoom=zoom; FX.shock=shock; FX.grade=grade;

  buildTimeline();
  inited=true;
}

function buildTimeline(){
  tl=gsap.timeline({paused:true});
  const s1=layers.s1,s2=layers.s2,s3=layers.s3,s4=layers.s4;
  // SHOT 1 (0-4): fade in, hero push-in, title fade
  tl.to(s1,{alpha:1,duration:0.6},0)
    .fromTo(s1._hero.scale,{x:s1._hero._cover,y:s1._hero._cover},{x:s1._hero._cover*1.12,y:s1._hero._cover*1.12,duration:4,ease:'power1.out'},0)
    .fromTo(s1,{x:-30},{x:10,duration:4,ease:'sine.inOut'},0)
    .to(FX.title,{alpha:0.0,duration:0.01},0)
    .fromTo(FX.lyric,{alpha:0,y:H*0.9},{alpha:1,y:H*0.86,duration:0.8,ease:'power2.out'},1.4)
    .to(FX.lyric,{alpha:0,duration:0.4},3.4)
    .to(s1,{alpha:0,duration:0.5},3.7)
  // SHOT 2 (4-8): city + portraitB layered + panel slides in
    .fromTo(s2,{alpha:0},{alpha:1,duration:0.4},4)
    .fromTo(s2._pB.scale,{x:s2._pB._base*1.06,y:s2._pB._base*1.06},{x:s2._pB._base,y:s2._pB._base,duration:4,ease:'power1.out'},4)
    .fromTo(s2._panel,{x:W*0.2-80,alpha:0,rotation:-0.04},{x:W*0.2,alpha:1,rotation:0,duration:0.7,ease:'back.out(1.6)'},4.3)
    .to(s2,{alpha:0,duration:0.4},7.7)
  // SHOT 3 (8-12) DROP: fullA punch-in, title SLAM
    .fromTo(s3,{alpha:0},{alpha:1,duration:0.2},8)
    .fromTo(s3._hero.scale,{x:s3._hero._cover*1.35,y:s3._hero._cover*1.35},{x:s3._hero._cover*1.12,y:s3._hero._cover*1.12,duration:3.4,ease:'expo.out'},8)
    .fromTo(FX.title.scale,{x:2.6,y:2.6},{x:1,y:1,duration:0.5,ease:'expo.out'},8.05)
    .fromTo(FX.title,{alpha:0},{alpha:1,duration:0.3},8.05)
    .to(FX.title,{alpha:0,duration:0.4},11.6)
    .to(s3,{alpha:0,duration:0.5},11.7)
  // SHOT 4 (12-15) outro
    .fromTo(s4,{alpha:0},{alpha:1,duration:0.6},12)
    .fromTo(s4.scale,{x:1.12,y:1.12},{x:1.0,y:1.0,duration:3,ease:'power2.out'},12)
    .set(s4,{transformOrigin:'50% 50%'},12)
    .fromTo(FX.title.scale,{x:1,y:1},{x:1,y:1,duration:0.01},12)
    .fromTo(FX.title,{alpha:0},{alpha:1,duration:0.8},12.2)
    .fromTo(FX.sub,{alpha:0,y:H*0.64},{alpha:1,y:H*0.62,duration:0.8},12.8);
  tl.totalDuration(DUR);
}

window.seek=(ms)=>{
  if(!inited)init();
  const t=ms/1000; tl.seek(t);
  const e=arr(EN,t), bass=arr(BS,t), be=pulse(beats,t,0.12), de=pulse(downs,t,0.30);
  // reactive filters
  FX.god.time=t; FX.god.gain=0.3+0.25*e;
  FX.bloom.bloomScale=0.6+0.7*e; FX.bloom.brightness=1.0+0.05*be;
  FX.crt.time=t; FX.crt.seed=Math.sin(t*99.0);
  // RGB split + glitch jolt on strong beats
  const rs=(be*8 + de*16);
  FX.rgb.red=[rs,0]; FX.rgb.blue=[-rs,0]; FX.rgb.green=[0,0];
  // zoom-blur kick on downbeats
  FX.zoom.strength=de*0.18;
  // shockwave from drop downbeats
  const db=lastB(downs,t); const age=t-db;
  FX.shock.time = (db>-9 && age<1.4 && t>=8 && t<12) ? age : -1;
  FX.shock.amplitude = (t>=8&&t<12)? 18 : 0;
  // camera shake (energy-driven, strong on drop)
  const amp=(e* (t>=8&&t<12?26:8));
  const r=Math.sin(t*97.1), r2=Math.cos(t*61.7);
  shake.x=r*amp; shake.y=r2*amp;
  // title glow pulse
  if(FX.title.filters&&FX.title.filters[0]) FX.title.filters[0].outerStrength=1.8+1.4*be;
  app.renderer.render(app.stage);
};
