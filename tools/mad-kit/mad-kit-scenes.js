// mad-kit-scenes.js — bespoke scene templates + shotlist compiler.
'use strict';
(() => {
const M = window.MK;
const { W, H, PAL, clamp, lerp, map, el, img, txt, svgEl, starPts, HEART, motorize,
        confettiLayer, petalLayer, sparkleLayer, floaterLayer, ambientOf, patternBG,
        nameplate, pill, cardEl, TEMPLATES, db, T, beatAfter, beatPulse, dbPulse, beatsFloat,
        flashAt, BANDCUTS } = M;
const { outCubic, outQuint, outExpo, inCubic, inOutCubic, outBack, outElastic } = M.EASE;
const BEATS = M.BEATS;

/* ---- mg_intro ---- */
TEMPLATES.mg_intro = (root, p, ctx) => {
  root.style.background = '#fff';
  const bar = i => db(i);
  const stairsT = [], stairsB = [];
  for (let i = 0; i < 6; i++) {
    stairsT.push(el(root, { left: 0, width: '100%', height: '64px', top: (i * 64) + 'px', background: i % 2 ? '#f2b9c4' : PAL.pink, zIndex: 2 }));
    stairsB.push(el(root, { left: 0, width: '100%', height: '64px', bottom: (i * 64) + 'px', background: i % 2 ? '#f2b9c4' : PAL.pink, zIndex: 2 }));
  }
  const midBand = el(root, { left: 0, top: '384px', width: '100%', height: (H - 768) + 'px', background: PAL.pink2, zIndex: 1, opacity: 0 });
  const ticks = [];
  for (let i = 0; i < 4; i++) ticks.push(el(root, { width: '150px', height: '34px', borderRadius: '17px', zIndex: 5,
    background: 'linear-gradient(90deg,#f3e3c0 0 20%,#7a4a2b 20% 100%)', boxShadow: '0 6px 18px rgba(120,60,20,.25)',
    left: (570 + i * 210) + 'px', top: '520px', opacity: 0 }));
  const line = el(root, { left: 0, top: '820px', width: '100%', height: '6px', background: PAL.wine, zIndex: 4, transformOrigin: '0 50%' });
  const chibis = (p.chibis || ['chibi_00', 'chibi_03', 'chibi_05']).map((n, i) =>
    M.tag(img(root, n, { height: '240px', zIndex: 6 }), ctx, `chibis[${i}]`, n));
  const ribbon = el(root, { left: '70px', top: '905px', padding: '10px 38px', background: PAL.wine, color: '#fff',
    fontSize: '34px', fontFamily: 'Yusei', zIndex: 20, borderRadius: '4px' });
  ribbon.textContent = p.credit || 'Presented by sola × Claude';
  M.tag(ribbon, ctx, 'credit', 'クレジット');
  const squares = [0, 1, 2].map(i => el(root, { width: (170 + i * 90) + 'px', height: (170 + i * 90) + 'px', background: PAL.wine, zIndex: 8 }));
  const stars = []; const starPos = [[260, 210], [1660, 260], [420, 800], [1500, 820], [960, 160], [180, 560], [1740, 620]];
  for (let i = 0; i < 7; i++) { const R = 90 + (i % 3) * 70;
    stars.push(svgEl(root, R * 2 + 20, R * 2 + 20, `<polygon points="${starPts(R + 10, R + 10, R, R * .42)}" fill="none" stroke="#fff" stroke-width="10" stroke-linejoin="round"/>`, { zIndex: 9 })); }
  const pieWrap = el(root, { left: '50%', top: '45%', zIndex: 12, width: '620px', height: '620px', marginLeft: '-310px', marginTop: '-310px' });
  el(pieWrap, { inset: 0, borderRadius: '50%', background: '#fff', boxShadow: '0 0 0 26px rgba(255,255,255,.35)' });
  const pie = el(pieWrap, { inset: '60px', borderRadius: '50%' });
  const dots = []; for (let i = 0; i < 5; i++) dots.push(el(pieWrap, { width: '54px', height: '54px', borderRadius: '50%', background: PAL.wine, left: '50%', top: '50%' }));
  const pieText = M.tag(txt(root, p.pieText || 'Pocky & Pretz Day — 11.11', { left: '50%', top: '86%', fontSize: '40px', color: PAL.wine, fontFamily: 'Yusei', zIndex: 13, opacity: 0, background: 'rgba(255,255,255,.94)', padding: '10px 42px', borderRadius: '999px', boxShadow: '0 10px 30px rgba(120,30,60,.25)', transform: 'translateX(-50%)' }), ctx, 'pieText', 'テキスト');
  const floats = floaterLayer(root, { n: 8, seed: 12, zi: 7, set: ['heart', 'star', 'note'], alpha: .7 });
  const userAmb = p.ambient ? ambientOf(root, p.ambient, 121) : null;
  flashAt(db(8) - .05, .35, 1);
  return t => {
    const [b1, b2, b3, b4, b5, b6, b7, b8] = [bar(1), bar(2), bar(3), bar(4), bar(5), bar(6), bar(7), db(8)];
    ticks.forEach((tk, i) => { const bt = .08 + i * .28; const u = map(t, bt, bt + .18);
      tk.style.opacity = t < b2 ? u : Math.max(0, 1 - map(t, b2, b2 + .3));
      tk.style.transform = `rotate(${-8 + i * 5 + Math.sin(t * 2.6 + i) * 6}deg) scale(${lerp(.4, 1, outBack(u)) * (1 + beatPulse(t, 8) * .12)}) translateY(${Math.sin(t * 2.1 + i * 2) * 16}px)`; });
    line.style.transform = `scaleX(${outExpo(map(t, .55, 1.35))})`;
    line.style.opacity = t > b6 ? Math.max(0, 1 - map(t, b6, b6 + .3)) : 1;
    chibis.forEach((c, i) => { const enter = map(t, b1 + i * .19, b1 + i * .19 + 1.05);
      const exitU = map(t, b4 + i * .12, b4 + i * .12 + .8);
      const x = lerp(W + 140 + i * 120, 300 + i * 470, outCubic(enter)) - inCubic(exitU) * (W * .8 + 400);
      const bf = beatsFloat(t), hop = Math.abs(Math.sin(bf * Math.PI));
      const y = 820 - 236 - hop * (t > b2 ? 90 : 30);
      const rot = t < b2 ? -enter * 720 : Math.sin(bf * Math.PI * 2) * 8;
      c.style.transform = `translate(${x}px,${y}px) rotate(${rot}deg) scaleY(${1 - hop * .12})`;
      c.style.opacity = enter > 0 ? 1 : 0; });
    stairsT.forEach((s, i) => { const u = outExpo(map(t, b2 + i * .045, b2 + .5 + i * .045)); const out = inCubic(map(t, b6, b6 + .5));
      s.style.transform = `translateX(${lerp(-100, 0, u) + out * 100}%)`; });
    stairsB.forEach((s, i) => { const u = outExpo(map(t, b2 + i * .045, b2 + .5 + i * .045)); const out = inCubic(map(t, b6, b6 + .5));
      s.style.transform = `translateX(${lerp(100, 0, u) - out * 100}%)`; });
    midBand.style.opacity = map(t, b2 + .3, b3) * (1 - map(t, b6, b6 + .4));
    const ru = outBack(map(t, b3, b3 + .5));
    ribbon.style.transform = `translateY(${lerp(160, 0, ru)}px) rotate(${-2 + Math.sin(t * 1.4) * 1}deg)`;
    ribbon.style.opacity = Math.min(ru, 1 - map(t, b7 + .6, b8));
    squares.forEach((sq, i) => { const u = map(t, b4 + i * .16, b5 + .9 + i * .1);
      sq.style.transform = `translate(${lerp(-500, W + 300, u)}px,${330 + i * 130 + Math.sin(u * 9 + i) * 55}px) rotate(${u * 540 + i * 40}deg)`;
      sq.style.opacity = u > 0 && u < 1 ? 1 : 0; });
    stars.forEach((st, i) => { const t0 = b5 + i * .186; const u = outBack(map(t, t0, t0 + .32));
      st.style.transform = `translate(${starPos[i][0] - 100}px,${starPos[i][1] - 100}px) scale(${u * (1 + beatPulse(t, 9) * .08)}) rotate(${Math.sin(t + i) * 6}deg)`;
      st.style.opacity = u > 0 ? 1 - map(t, b6 + .2, b6 + .6) : 0; });
    const pu = outBack(map(t, b6, b6 + .5), 1.2);
    const ang = 720 * inOutCubic(map(t, b6 + .2, b7 + .9));
    pie.style.background = `conic-gradient(${PAL.wine} 0deg ${ang % 360}deg, ${Math.floor(ang / 360) % 2 ? PAL.wine : 'transparent'} ${ang % 360}deg 360deg)`;
    pieWrap.style.transform = `scale(${pu * (1 - .86 * inCubic(map(t, b7 + .55, b8 - .05)))})`;
    pieWrap.style.opacity = pu > 0 ? 1 : 0;
    dots.forEach((d, i) => { const a = i / 5 * Math.PI * 2 + t * 1.6;
      d.style.transform = `translate(${Math.cos(a) * 252 - 27}px,${Math.sin(a) * 252 - 27}px) scale(${.8 + beatPulse(t) * .5})`; });
    pieText.style.opacity = map(t, b6 + .4, b6 + .8) * (1 - map(t, b7 + .8, b8));
    root.style.background = t > b2 + .5 ? PAL.pink2
      : `radial-gradient(circle at 50% ${52 + Math.sin(t * 2.4) * 5}%, #fff, #fbeaec ${64 + beatPulse(t, 6) * 18}%)`;
    floats(t, Math.max(map(t, .3, 1.2) * .5, map(t, b3, b4)) * (1 - map(t, b6, b6 + .4)));
    if (userAmb) userAmb(t, map(t, .3, 1.2) * .8);
  };
};

/* ---- title_card ---- */
TEMPLATES.title_card = (root, p, ctx) => {
  const bg = M.tag(img(root, p.bg || 'bg_sky', { width: '112%', height: '112%', objectFit: 'cover', left: '-6%', top: '-6%' }), ctx, 'bg', p.bg || 'bg_sky');
  const bT = el(root, { left: 0, top: 0, width: '100%', height: '86px', zIndex: 5, ...M.PATTERNS.plaid() });
  const bB = el(root, { left: 0, bottom: 0, width: '100%', height: '86px', zIndex: 5, ...M.PATTERNS.plaid() });
  const heart = svgEl(root, 900, 800, `<path d="M450 700 C 140 480 60 260 210 150 C 330 60 440 130 450 230 C 460 130 570 60 690 150 C 840 260 760 480 450 700 Z" fill="none" stroke="#ff9fc0" stroke-width="16" stroke-linecap="round" stroke-dasharray="2600"/>`,
    { left: '50%', top: '50%', marginLeft: '-450px', marginTop: '-430px', zIndex: 6, opacity: .9 });
  const hp = heart.querySelector('path');
  const plate = el(root, { left: '50%', top: '50%', zIndex: 8, width: '1150px', padding: '46px 60px 40px', marginLeft: '-575px',
    background: 'rgba(255,255,255,.94)', borderRadius: '22px', border: '10px solid transparent', textAlign: 'center',
    backgroundClip: 'padding-box', boxShadow: '0 24px 80px rgba(120,30,60,.35)' });
  el(plate, { inset: '-10px', zIndex: -1, borderRadius: '22px', ...M.PATTERNS.plaid() });
  const t1 = M.tag(txt(plate, p.title1 || '杏子ちゃんと', { position: 'relative', fontSize: '64px', color: PAL.wine, fontFamily: 'Mochiy', letterSpacing: '.06em' }), ctx, 'title1', p.title1);
  const t2 = M.tag(txt(plate, p.title2 || 'ポッキーゲームしたい', { position: 'relative', fontSize: '104px', color: PAL.deep, fontFamily: 'Mochiy' }), ctx, 'title2', p.title2);
  t2.className = 'outline-pink';
  const t3 = M.tag(txt(plate, p.subtitle || '', { position: 'relative', fontSize: '30px', color: PAL.wine2, fontFamily: 'Yusei', marginTop: '18px' }), ctx, 'subtitle', p.subtitle);
  [t1, t2, t3].forEach(e => e.style.position = 'relative');
  const diaC = ['#ff6b8a', '#ffb35c', '#ffe066', '#7fd87f', '#5cc9e8', '#9b8cff', '#f48fb1', '#ff6b8a'];
  const dias = []; for (let i = 0; i < 16; i++) { const top = i % 2 === 0;
    dias.push(el(root, { width: '46px', height: '46px', background: diaC[i % 8], zIndex: 7,
      boxShadow: '0 6px 16px rgba(120,30,60,.3)', left: (90 + (i >> 1) * 230) + 'px', top: top ? '110px' : (H - 156) + 'px' })); }
  const conf = confettiLayer(root, { n: 30, seed: 9, zi: 4 });
  const spark = sparkleLayer(root, { n: 22, seed: 14, zi: 6 });
  const petals = petalLayer(root, { n: 16, seed: 33, zi: 4 });
  return t => { const tl = t - ctx.t0;
    bg.style.transform = `scale(${1 + tl * .012}) translateX(${tl * -4}px)`;
    const bu = outExpo(map(tl, 0, .5));
    bT.style.transform = `translateY(${lerp(-100, 0, bu)}%)`; bB.style.transform = `translateY(${lerp(100, 0, bu)}%)`;
    hp.style.strokeDashoffset = 2600 * (1 - inOutCubic(map(tl, .15, 1.6)));
    const pu = outBack(map(tl, .22, .85), 1.1);
    plate.style.transform = `translateY(${lerp(120, -46, pu) - 50}%) rotate(${lerp(-7, -1.5, pu) + Math.sin(t * .9) * .6}deg) scale(${lerp(.7, 1, pu)})`;
    plate.style.opacity = clamp(pu * 2);
    t2.style.transform = `scale(${1 + beatPulse(t, 9) * .045})`;
    dias.forEach((d, i) => { const bt = beatAfter(ctx.t0, i);
      d.style.transform = `rotate(45deg) scale(${outBack(map(t, bt, bt + .3)) * (1 + beatPulse(t, 10) * .1)}) translateY(${Math.sin(t * 1.7 + i) * 5}px)`; });
    conf(t, map(tl, .4, 1) * .9); spark(t, map(tl, .3, .8)); petals(t, .7); };
};

/* ---- mg_peak: rings → badge → ribbon+runners → handled by shot splits ---- */
TEMPLATES.mg_peak = (root, p, ctx) => {
  root.style.background = PAL.mag;
  const stripes = el(root, { inset: '-100px', opacity: .16, background: 'repeating-linear-gradient(-30deg, #fff 0 40px, transparent 40px 120px)' });
  const ringC = ['#fff', PAL.blue, '#fff', '#ffd9e2'];
  const rings = ringC.map((c, i) => el(root, { left: '50%', top: '50%', width: '200px', height: '200px', margin: '-100px',
    borderRadius: '50%', border: `46px solid ${c}`, zIndex: 20, opacity: 0 }));
  const badge = el(root, { left: '50%', top: '50%', width: '620px', height: '620px', margin: '-310px', zIndex: 10 });
  el(badge, { inset: 0, borderRadius: '50%', background: '#fff', boxShadow: '0 0 0 30px rgba(255,255,255,.3)' });
  el(badge, { inset: '55px', borderRadius: '50%', background: PAL.blue });
  const bTxt = el(badge, { inset: 0 });
  bTxt.innerHTML = `<svg width="620" height="620" viewBox="0 0 620 620"><defs><path id="circ" d="M310,310 m-175,0 a175,175 0 1,1 350,0 a175,175 0 1,1 -350,0"/></defs><text font-family="MPR" font-size="72" fill="#fff" letter-spacing="6"><textPath href="#circ">${p.badgeText || 'SAKURA・KYOKO・2026・'}</textPath></text></svg>`;
  const oDots = []; for (let i = 0; i < 8; i++) oDots.push(el(root, { left: '50%', top: '50%', width: '26px', height: '26px', margin: '-13px', borderRadius: '50%', background: '#fff', zIndex: 11 }));
  const rw = el(root, { left: 0, top: '470px', width: '100%', height: '150px', zIndex: 12 });
  const rb = el(rw, { left: '-4%', top: '30px', width: '108%', height: '92px', background: PAL.wine, boxShadow: '0 16px 50px rgba(90,10,40,.4)' });
  const rl = el(rw, { left: '50%', top: '6px', background: '#fff', color: PAL.deep, fontFamily: 'Mochiy', fontSize: '74px',
    padding: '12px 60px', borderRadius: '999px', boxShadow: '0 12px 40px rgba(90,10,40,.35)' });
  rl.textContent = p.ribbonText || 'はんぶんこ！';
  M.tag(rl, ctx, 'ribbonText', p.ribbonText);
  M.tag(badge, ctx, 'badgeText', 'バッジ');
  const runners = (p.runners || ['chibi_02', 'chibi_04', 'chibi_06', 'chibi_08']).map((n, i) =>
    M.tag(img(rw, n, { height: '150px', top: '-115px', zIndex: 13 }), ctx, `runners[${i}]`, n));
  const conf = confettiLayer(root, { n: 110, seed: 42, zi: 8 });
  const floats = floaterLayer(root, { n: 8, seed: 61, zi: 9, set: ['apple', 'pocky', 'heart'], alpha: .85 });
  const c1 = T(p.from), c2 = db(p.fromBar + 1), c3 = db(p.fromBar + 3), cPD = ctx.t1;
  flashAt(cPD, .22, .9);
  return t => {
    stripes.style.transform = `translateX(${(t * 60) % 139}px)`;
    rings.forEach((r, i) => { const bt = c1 + i * .186, u = map(t, bt, bt + .8);
      r.style.transform = `scale(${.2 + outCubic(u) * 10})`; r.style.opacity = u > 0 && u < 1 ? 1 - inCubic(u) : 0; });
    const bu = outBack(map(t, c2, c2 + .55), 1.1);
    const bx = lerp(0, -1450, inOutCubic(map(t, c3 - .4, c3 + .15)));
    badge.style.transform = `translate(${bx}px,${Math.sin(t * 1.2) * 8}px) scale(${bu * (1 + beatPulse(t, 8) * .05)})`;
    badge.style.opacity = bu > 0 ? 1 : 0;
    bTxt.style.transform = `rotate(${t * 40}deg)`;
    oDots.forEach((d, i) => { const a = i / 8 * Math.PI * 2 + t * 2.1; const r = 360 * bu;
      d.style.transform = `translate(${Math.cos(a) * r + bx}px,${Math.sin(a) * r}px) scale(${.7 + beatPulse(t) * .7})`; });
    const ru = outExpo(map(t, c3, c3 + .5));
    rw.style.opacity = t >= c3 - .1 ? 1 : 0;
    rb.style.transform = `rotate(-2.4deg) scaleX(${ru})`;
    rl.style.transform = `translateX(-50%) scale(${outBack(map(t, c3 + .25, c3 + .6), 1.6)}) rotate(${Math.sin(beatsFloat(t) * Math.PI * 2) * 2}deg)`;
    runners.forEach((r, i) => { const u = (t - c3) / (cPD - c3);
      const x = lerp(-220 - i * 420, W + 260, clamp(u * 1.3));
      r.style.transform = `translate(${x}px,${-Math.abs(Math.sin(beatsFloat(t) * Math.PI)) * 46}px) rotate(${Math.sin(beatsFloat(t) * Math.PI * 2) * 7}deg)`; });
    conf(Math.max(0, t - c3 + 1.2), t >= c3 - .05 ? 1 : 0);
    floats(t, map(t, c2, c2 + .5)); };
};

/* ---- profile_card ---- */
TEMPLATES.profile_card = (root, p, ctx) => {
  root.style.background = '#8c2f4b';
  const ov = el(root, { inset: 0, opacity: .12, background: 'repeating-linear-gradient(45deg,#fff 0 4px,transparent 4px 60px)' });
  const head = txt(root, p.head || 'PERSONAL DATA', { left: '90px', top: '64px', fontFamily: 'MPR', fontSize: '38px', letterSpacing: '.5em', color: '#ffc9d6' });
  const n1 = txt(root, '', { left: '90px', top: '150px', fontFamily: 'MPR', fontSize: '150px', color: '#fff' });
  const n2 = txt(root, '', { left: '90px', top: '310px', fontFamily: 'MPR', fontSize: '150px', color: '#fff' });
  const kanji = txt(root, p.kanji || '佐倉杏子', { left: '700px', top: '190px', fontFamily: 'Mochiy', fontSize: '54px', color: '#ffd9e2', writingMode: 'vertical-rl' });
  const chips = (p.chips || []).map((c, i) => txt(root, c, { left: (90 + i * 250) + 'px', top: '510px', background: '#5e1f33', color: '#fff', fontSize: '36px', fontFamily: 'Mochiy', padding: '10px 34px' }));
  const rows = (p.rows || []).map(([k, v], i) => { const w = el(root, { left: (90 + (i % 2) * 420) + 'px', top: (640 + (i >> 1) * 170) + 'px', borderLeft: '10px solid #ffc9d6', paddingLeft: '24px', color: '#fff' });
    const a = txt(w, k, { position: 'relative', fontSize: '30px', fontFamily: 'Yusei', color: '#ffc9d6' });
    const b = txt(w, v, { position: 'relative', fontSize: '62px', fontFamily: 'MPR', marginTop: '2px' });
    a.style.position = b.style.position = 'relative'; return w; });
  const pImg = M.tag(img(root, p.asset, { height: '100%', right: '30px', bottom: '-30px' }), ctx, 'asset', p.asset);
  M.tag(n1, ctx, 'name1', p.name1); M.tag(n2, ctx, 'name2', p.name2); M.tag(kanji, ctx, 'kanji', p.kanji);
  chips.forEach((c, i) => M.tag(c, ctx, `chips[${i}]`, (p.chips||[])[i]));
  rows.forEach((r, i) => M.tag(r, ctx, `rows[${i}]`, (p.rows||[])[i]?.[0]));
  const spark = sparkleLayer(root, { n: 14, seed: 71, zi: 4, color: '#ffb7cd' });
  const SCR = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#*+';
  const scr = (e, base, t0, t, dur = .45) => { const u = map(t, t0, t0 + dur);
    if (u <= 0) { e.style.opacity = 0; return; } e.style.opacity = 1;
    const rev = Math.floor(u * base.length * 1.3); let s = '';
    for (let i = 0; i < base.length; i++) s += (base[i] === ' ' || i < rev) ? base[i] : SCR[(i * 31 + Math.floor(t * 28) * 7) % SCR.length];
    e.textContent = s; };
  flashAt(ctx.t1 - .03, .3, 1);
  return t => { const a = ctx.t0;
    ov.style.backgroundPosition = `${(t * 20) % 85}px 0`;
    scr(n1, p.name1 || 'SAKURA', a + .05, t); scr(n2, p.name2 || 'KYOKO', a + .25, t);
    head.style.opacity = map(t, a, a + .3);
    kanji.style.opacity = map(t, a + .4, a + .7);
    kanji.style.transform = `translateY(${Math.sin(t * 1.2) * 6}px)`;
    chips.forEach((c, i) => { const bt = beatAfter(a + .5, i);
      c.style.transform = `scale(${outBack(map(t, bt, bt + .26))}) rotate(${-2 + Math.sin(t * 1.6 + i) * 1.4}deg)`; });
    rows.forEach((r, i) => { const uu = map(t, a + .8 + i * .19, a + 1.1 + i * .19);
      r.style.opacity = uu; r.style.transform = `translateY(${lerp(50, 0, outCubic(uu)) + Math.sin(t * 1.3 + i) * 3}px)`; });
    pImg.style.transform = `translateX(${lerp(320, 0, outExpo(map(t, a, a + .6)))}px) scale(${1 + beatPulse(t, 9) * .02}) translateY(${Math.sin(t * .9) * 5}px)`;
    spark(t, 1); };
};

/* ---- breakdown_pan ---- */
TEMPLATES.breakdown_pan = (root, p, ctx) => {
  root.style.background = '#f6dfe6';
  const mid = ctx.t0 + (ctx.t1 - ctx.t0) / 2;
  const isVid = n => (window.kycha.videoAssets || []).includes(n);
  const mk1 = isVid(p.art1) ? M.vid(root, p.art1, { width: '112%', height: '112%', objectFit: 'cover', left: '-6%', top: '-6%', filter: 'saturate(.92)' }) : null;
  const mk2 = isVid(p.art2) ? M.vid(root, p.art2, { width: '112%', height: '112%', objectFit: 'cover', left: '-6%', top: '-6%', filter: 'saturate(.95)' }) : null;
  const im1 = M.tag(mk1 ? mk1.v : img(root, p.art1, { width: '112%', height: '112%', objectFit: 'cover', left: '-6%', top: '-6%', filter: 'saturate(.88) brightness(.97)' }), ctx, 'art1', p.art1);
  const im2 = M.tag(mk2 ? mk2.v : img(root, p.art2, { width: '112%', height: '112%', objectFit: 'cover', left: '-6%', top: '-6%', filter: 'saturate(.95)' }), ctx, 'art2', p.art2);
  im2.style.opacity = 0;
  el(root, { inset: 0, background: 'radial-gradient(circle, transparent 55%, rgba(60,20,60,.35))' });
  const pt = petalLayer(root, { n: 30, seed: 77, zi: 20 });
  const spark = sparkleLayer(root, { n: 12, seed: 81, zi: 21, color: '#ffe3ee' });
  const cred = M.tag(el(root, { left: '110px', bottom: '150px', zIndex: 25, color: '#fff', padding: '26px 34px', borderRadius: '18px',
    background: 'rgba(120,30,60,.42)', backdropFilter: 'blur(4px)', textShadow: '0 3px 14px rgba(40,0,20,.85)' }), ctx, 'credit', '楽曲クレジット');
  const circle = el(cred, { left: '-34px', top: '-30px', width: '400px', height: '400px', borderRadius: '50%', border: '3px solid rgba(255,255,255,.65)', zIndex: -1 });
  (p.credit || []).forEach((line, i) => { const e = txt(cred, line, { position: 'relative',
    fontSize: i === 1 ? '52px' : i === 0 ? '30px' : '28px', fontFamily: i === 1 ? 'Mochiy' : 'Yusei', marginTop: i ? '12px' : '0' });
    e.style.position = 'relative'; });
  return t => { const tl = t - ctx.t0;
    const lbu = outCubic(map(tl, 0, 1.2)) * (1 - inCubic(map(t, ctx.t1 - 1.3, ctx.t1 - .1)));
    M.lbT.style.height = (110 * lbu) + 'px'; M.lbB.style.height = (110 * lbu) + 'px';
    im1.style.transform = `scale(${1.02 + map(t, ctx.t0, mid) * .09}) translateX(${map(t, ctx.t0, mid) * -40}px)`;
    im1.style.opacity = 1 - map(t, mid - .5, mid + .3);
    im2.style.opacity = map(t, mid - .5, mid + .3);
    im2.style.transform = `scale(${1.12 - map(t, mid, ctx.t1) * .08}) translateX(${map(t, mid, ctx.t1) * 30}px)`;
    if (mk1 && t < mid + .5) mk1.seekTo(t - ctx.t0);
    if (mk2 && t > mid - .8) mk2.seekTo(t - mid + .8);
    pt(t * .6, .85); spark(t * .7, .8);
    const cu = map(tl, .8, 1.6);
    cred.style.opacity = cu * (1 - map(t, ctx.t1 - 1.6, ctx.t1 - .8));
    cred.style.transform = `translateY(${lerp(40, 0, outCubic(cu)) + Math.sin(t * .8) * 3}px)`;
    circle.style.transform = `scale(${lerp(.85, 1, outCubic(cu))}) rotate(${t * 6}deg)`; };
};

/* ---- outro_credits ---- */
TEMPLATES.outro_credits = (root, p, ctx) => {
  root.style.background = PAL.cream;
  const ring = (p.thumbs || []).map((n, i) => { const { c } = cardEl(root, n, { width: '240px', height: '170px', left: '50%', top: '50%', zIndex: 2 }); return M.tag(c, ctx, `thumbs[${i}]`, n); });
  const plate = el(root, { left: '50%', top: '50%', transform: 'translate(-50%,-50%)', zIndex: 6, width: '980px', padding: '54px 40px',
    textAlign: 'center', background: 'rgba(255,255,255,.96)', borderRadius: '24px', boxShadow: '0 24px 90px rgba(140,40,70,.3)' });
  const a = txt(plate, p.title || '', { position: 'relative', fontSize: '58px', fontFamily: 'Mochiy', color: PAL.deep });
  const b = txt(plate, p.year || '2 0 2 6', { position: 'relative', fontSize: '44px', fontFamily: 'MPR', color: PAL.wine, letterSpacing: '.6em', marginTop: '6px' });
  const credits = M.tag(el(plate, { position: 'relative', marginTop: '30px', fontFamily: 'Yusei', fontSize: '27px', color: PAL.wine2, lineHeight: 1.85 }), ctx, 'credits', 'クレジット');
  M.tag(a, ctx, 'title', p.title); M.tag(b, ctx, 'year', p.year);
  credits.innerHTML = (p.credits || []).join('<br>');
  [a, b, credits].forEach(e => e.style.position = 'relative');
  const thanks = M.tag(txt(root, p.thanks || 'ありがとうございました！', { left: 0, right: 0, top: '80%', textAlign: 'center', fontFamily: 'Mochiy', fontSize: '40px', color: PAL.wine, zIndex: 6 }), ctx, 'thanks', 'ありがとう');
  const spark = sparkleLayer(root, { n: 20, seed: 5, zi: 7, color: '#f7b8cb' });
  const floats = floaterLayer(root, { n: 8, seed: 6, zi: 3, alpha: .55 });
  const END = p.end ?? ctx.t1;
  return t => { const tl = t - ctx.t0;
    ring.forEach((c, i) => { const a2 = i / ring.length * Math.PI * 2 + tl * .12;
      const R = 620 * outExpo(map(tl, .05, .8));
      c.style.transform = `translate(${Math.cos(a2) * R * 1.28 - 120}px,${Math.sin(a2) * R * .72 - 85}px) rotate(${Math.sin(a2 * 2) * 10}deg)`;
      c.style.opacity = map(tl, .05, .5); });
    plate.style.transform = `translate(-50%,-50%) scale(${outBack(map(tl, .15, .75), 1.1)}) rotate(${Math.sin(t * .7) * .5}deg)`;
    thanks.style.opacity = map(tl, 1.2, 1.7);
    thanks.style.transform = `translateY(${lerp(30, 0, outCubic(map(tl, 1.2, 1.8)))}px)`;
    spark(t, 1); floats(t, .55);
    const iu = map(t, END - 1.25, END - .15);
    M.irisEl.style.background = iu > 0 ? `radial-gradient(circle ${lerp(1400, 0, inOutCubic(iu))}px at 50% 50%, transparent ${lerp(1400, 0, inOutCubic(iu)) - 3}px, ${PAL.wine} ${lerp(1400, 0, inOutCubic(iu))}px)` : 'none'; };
};

/* ============ compiler ============ */
function compile(shotlist) {
  const scenes = [];
  shotlist.shots.forEach((shot, idx) => {
    const t0 = T(shot.from), t1 = T(shot.to);
    const root = el(M.scenesRoot, { inset: 0, display: 'none', overflow: 'hidden' }, 'scene');
    const tpl = TEMPLATES[shot.template];
    if (!tpl) { console.error('unknown template', shot.template); return; }
    const update = tpl(root, shot.params || {}, { t0, t1, idx, sid: shot.id, fromBar: shot.params?.fromBar });
    if (shot.transition === 'bandwipe') BANDCUTS.push(t0);
    if (shot.transition === 'flash') flashAt(t0 - .02, .28, .85);
    scenes.push({ t0, t1, root, update, shot });
  });
  const lbReset = new Set(shotlist.shots.filter(s => s.template === 'breakdown_pan').map((s, i) => i));
  window.seek = ms => { const t = ms / 1000 + (window.kycha.offset || 0);
    let anyLB = false;
    for (const s of scenes) { const on = t >= s.t0 && t < s.t1;
      s.root.style.display = on ? 'block' : 'none';
      if (on) { s.update(t); if (s.shot.template === 'breakdown_pan') anyLB = true; } }
    if (!anyLB) { M.lbT.style.height = '0px'; M.lbB.style.height = '0px'; }
    if (!scenes.some(s => t >= s.t0 && t < s.t1 && s.shot.template === 'outro_credits')) M.irisEl.style.background = 'none';
    M.updateBands(t); M.updateFlash(t);
    if (M.VIDEO_WAITS.length) { const ws = M.VIDEO_WAITS.splice(0); return Promise.all(ws); } };
  window.seek(0);
  document.body.style.zoom = (window.innerWidth / 1920) || 1;
}
window.MK.compile = compile;
// hot-swap for the live Shot Editor: throw away all scene DOM + timed events
// and rebuild from a new shotlist (global overlays in #bands etc. survive).
window.MK.recompile = shotlist => {
  M.scenesRoot.innerHTML = '';
  M.FLASHES.length = 0; M.BANDCUTS.length = 0;
  compile(shotlist);
};
if (window.kycha.shotlist) compile(window.kycha.shotlist);
})();
