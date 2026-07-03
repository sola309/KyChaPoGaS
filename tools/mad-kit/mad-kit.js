// mad-kit.js — declarative motion-graphics kit for MAD builds.
//
// A shotlist (JSON) describes the whole video; this kit renders it inside the
// KyChaPoGaS code-MG renderer (window.seek(t_ms) drives every frame).
//
// Design rules baked in ("never static, never lonely"):
//   * every subject/ornament gets at least one IDLE motion (breath/bob/sway)
//   * every shot gets a camera move (ken-burns) and an AMBIENT particle layer
//   * every cut lands on a beat; enter/exit stagger on 8th notes
//
// LLM-facing surface: the shotlist JSON only (template name + flat params).
'use strict';
window.MK = (() => {

/* ============ A. utils ============ */
const K = window.kycha;
const W = 1920, H = 1080;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, u) => a + (b - a) * u;
const map = (t, a, b) => clamp((t - a) / (b - a));
const outCubic = u => 1 - Math.pow(1 - u, 3);
const outQuint = u => 1 - Math.pow(1 - u, 5);
const outExpo = u => u >= 1 ? 1 : 1 - Math.pow(2, -10 * u);
const inCubic = u => u * u * u;
const inOutCubic = u => u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
const outBack = (u, k = 1.70158) => u <= 0 ? 0 : u >= 1 ? 1 : 1 + (k + 1) * Math.pow(u - 1, 3) + k * Math.pow(u - 1, 2);
const outElastic = u => u <= 0 ? 0 : u >= 1 ? 1 : Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
const EASE = { outCubic, outQuint, outExpo, inCubic, inOutCubic, outBack, outElastic, linear: u => clamp(u) };
function rng32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const BEATS = K.beats, DBS = K.downbeats;
function lastLE(arr, t) { let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
const beatPulse = (t, d = 7) => { const i = lastLE(BEATS, t); return i < 0 ? 0 : Math.exp(-(t - BEATS[i]) * d); };
const dbPulse = (t, d = 5) => { const i = lastLE(DBS, t); return i < 0 ? 0 : Math.exp(-(t - DBS[i]) * d); };
const beatsFloat = t => { const i = lastLE(BEATS, t); if (i < 0) return 0;
  const n = BEATS[i + 1] ?? BEATS[i] + .372; return i + (t - BEATS[i]) / (n - BEATS[i]); };
const db = i => DBS[Math.min(Math.max(i, 0), DBS.length - 1)];
const beatAfter = (t0, k) => { const i = lastLE(BEATS, t0 + 1e-4) + 1 + k; return BEATS[Math.min(i, BEATS.length - 1)]; };
// parse "db:12" | "db:12.5" | seconds
function T(v) { if (typeof v === 'number') return v;
  const m = /^db:([\d.]+)$/.exec(v); if (!m) return parseFloat(v);
  const f = parseFloat(m[1]), i = Math.floor(f), fr = f - i;
  return fr ? db(i) + (db(i + 1) - db(i)) * fr : db(i); }

/* ============ B. DOM ============ */
function el(parent, css, cls) { const d = document.createElement('div');
  if (cls) d.className = cls; d.style.position = 'absolute';
  if (css) Object.assign(d.style, css); parent.appendChild(d); return d; }
function img(parent, name, css) { const m = document.createElement('img');
  m.src = K.assets[name] || ''; m.style.position = 'absolute';
  if (css) Object.assign(m.style, css); parent.appendChild(m); return m; }
function txt(parent, s, css) { const d = el(parent, { whiteSpace: 'pre', ...css }); d.textContent = s; return d; }
// looping <video> asset. update(t) seeks it deterministically for renders;
// in live mode it free-runs (currentTime corrections only on drift).
const VIDEO_WAITS = [];
function vid(parent, name, css) {
  const v = document.createElement('video');
  v.src = K.assets[name] || ''; v.muted = true; v.loop = true; v.playsInline = true;
  v.preload = 'auto'; v.style.position = 'absolute';
  if (css) Object.assign(v.style, css);
  parent.appendChild(v);
  const seekTo = tt => {
    if (!isFinite(v.duration) || v.duration <= 0) return;
    const target = tt % v.duration;
    if (K.live) {
      if (v.paused) v.play().catch(() => {});
      if (Math.abs(v.currentTime - target) > 0.3) v.currentTime = target;
    } else {
      if (Math.abs(v.currentTime - target) < 1 / 120) return;
      VIDEO_WAITS.push(new Promise(res => {
        const done = () => { v.removeEventListener('seeked', done); res(); };
        v.addEventListener('seeked', done); setTimeout(done, 400);
      }));
      v.currentTime = target;
    }
  };
  return { v, seekTo };
}
// tag an element as a pickable object for the live Shot Editor.
// path is "<shotId>:params.<jsonpath>", label a human-friendly name.
function tag(e, ctx, sub, label) { if (!ctx || ctx.sid == null) return e;
  e.dataset.mk = `${ctx.sid}:params.${sub}`; if (label) e.dataset.mkLabel = label; return e; }
function svgEl(parent, w, h, inner, css) { const d = el(parent, css);
  d.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`; return d; }
function starPts(cx, cy, R, r, n = 5, rot = -90) { const p = [];
  for (let i = 0; i < n * 2; i++) { const a = (rot + i * 180 / n) * Math.PI / 180;
    const rr = i % 2 ? r : R; p.push(`${cx + rr * Math.cos(a)},${cy + rr * Math.sin(a)}`); } return p.join(' '); }
const HEART = (c, s = 1) => `<path transform="scale(${s})" d="M150 250 C 40 170 10 90 70 45 C 115 12 150 40 150 80 C 150 40 185 12 230 45 C 290 90 260 170 150 250 Z" fill="${c}"/>`;

/* ============ C. palette & patterns ============ */
const PAL = { wine: '#a5405c', wine2: '#8c3450', pink: '#f7dede', pink2: '#fbecec',
  deep: '#e0355f', mag: '#e8446e', cream: '#fff6f2', blue: '#3fa0d0', mint: '#dff0e4' };
const PATTERNS = {
  argyle: c => ({ background: `repeating-linear-gradient(45deg, rgba(165,64,92,.16) 0 2px, transparent 2px 84px),repeating-linear-gradient(-45deg, rgba(165,64,92,.16) 0 2px, transparent 2px 84px),repeating-linear-gradient(45deg, rgba(233,155,177,.5) 0 42px, rgba(247,222,222,.9) 42px 84px),repeating-linear-gradient(-45deg, rgba(233,155,177,.35) 0 42px, transparent 42px 84px) ${c || '#f7dede'}` }),
  stripes: c => ({ background: `repeating-linear-gradient(-55deg, ${c || '#fbecec'} 0 46px, #f5cfd6 46px 92px)` }),
  dots: c => ({ backgroundImage: 'radial-gradient(circle, rgba(165,64,92,.28) 9px, transparent 10px)', backgroundSize: '72px 72px', backgroundColor: c || '#e9f3ec' }),
  checks: c => ({ background: `repeating-linear-gradient(0deg, transparent 0 40px, rgba(255,255,255,.09) 40px 80px),repeating-linear-gradient(90deg, ${c || '#a5405c'} 0 40px, #97394f 40px 80px)` }),
  plaid: () => ({ background: 'repeating-linear-gradient(0deg, rgba(165,64,92,.24) 0 3px, transparent 3px 26px),repeating-linear-gradient(90deg, rgba(165,64,92,.24) 0 3px, transparent 3px 26px),repeating-linear-gradient(0deg, rgba(240,170,180,.55) 0 13px, rgba(250,225,225,.9) 13px 26px)' }),
  beige: () => ({ background: 'repeating-linear-gradient(45deg,#f6efe4 0 60px,#f0e4d0 60px 120px)' }),
  soft: c => ({ background: `radial-gradient(circle at 70% 20%, #ffe8f0, ${c || '#ffd3e2'})` }),
  winter: () => ({ background: 'linear-gradient(180deg,#dfe9f5,#c9d9ec)' }),
  solid: c => ({ background: c || PAL.pink2 }),
};
function patternBG(root, kind, color) {
  const wrap = el(root, { inset: '-140px', ...(PATTERNS[kind] || PATTERNS.solid)(color) });
  return t => { wrap.style.backgroundPosition = `${(t * 26) % 168}px ${(t * 14) % 168}px`; };
}

/* ============ D. particles / ambient layers ============ */
function confettiLayer(root, { n = 70, seed = 1, kind = 'mix', zi = 40 } = {}) {
  const rnd = rng32(seed), parts = [];
  const colors = ['#ff8fb0', '#ffd166', '#7fd8be', '#9fc7ff', '#f4a2c0', '#fff'];
  for (let i = 0; i < n; i++) {
    const pocky = kind === 'pocky' || (kind === 'mix' && rnd() < .35);
    const d = el(root, { zIndex: zi, left: 0, top: 0 });
    if (pocky) { const L = 26 + rnd() * 30;
      d.style.cssText += `;width:${L}px;height:7px;border-radius:4px;background:linear-gradient(90deg,#f3e3c0 0 22%,#7a4a2b 22% 100%)`; }
    else { const s = 10 + rnd() * 14;
      d.style.cssText += `;width:${s}px;height:${s * (.5 + rnd() * .7)}px;background:${colors[(rnd() * 6) | 0]};border-radius:2px`; }
    parts.push({ d, x: rnd() * W, ph: rnd(), spd: 130 + rnd() * 190, sway: 30 + rnd() * 60, sf: .4 + rnd() * 1.2, rs: (rnd() - .5) * 700, r0: rnd() * 360 });
  }
  return (t, a = 1) => { for (const p of parts) { const tot = H + 260, y = ((t * p.spd + p.ph * tot) % tot) - 130;
    p.d.style.transform = `translate(${p.x + Math.sin((t * p.sf + p.ph * 6.28) * 2) * p.sway}px,${y}px) rotate(${p.r0 + t * p.rs}deg)`;
    p.d.style.opacity = a; } };
}
function petalLayer(root, { n = 34, seed = 5, zi = 30 } = {}) {
  const rnd = rng32(seed), ps = [];
  for (let i = 0; i < n; i++) { const s = 14 + rnd() * 16;
    const d = el(root, { zIndex: zi, width: s + 'px', height: s + 'px',
      background: 'radial-gradient(circle at 30% 30%, #ffd9e6, #f9a8c4)', borderRadius: '80% 10% 60% 60%', opacity: .9 });
    ps.push({ d, x: rnd() * (W + 300) - 150, ph: rnd(), spd: 60 + rnd() * 80, drift: 60 + rnd() * 120, rs: (rnd() - .5) * 300 }); }
  return (t, a = 1) => { for (const p of ps) { const tot = H + 200, y = ((t * p.spd + p.ph * tot) % tot) - 100;
    let x = p.x - (t * p.drift) % (W + 300) + Math.sin(t * 1.3 + p.ph * 9) * 40;
    x = ((x % (W + 300)) + W + 300) % (W + 300) - 150;
    p.d.style.transform = `translate(${x}px,${y}px) rotate(${t * p.rs + p.ph * 360}deg)`; p.d.style.opacity = a; } };
}
function sparkleLayer(root, { n = 26, seed = 8, zi = 45, color = '#fff' } = {}) {
  const rnd = rng32(seed), ps = [];
  for (let i = 0; i < n; i++) { const R = 7 + rnd() * 13;
    const d = svgEl(root, R * 2, R * 2, `<polygon points="${starPts(R, R, R, R * .28, 4)}" fill="${color}"/>`, { zIndex: zi, left: 0, top: 0 });
    ps.push({ d, x: rnd() * W, y: rnd() * H, ph: rnd() * 9, rate: .5 + rnd() * 1.4 }); }
  return (t, a = 1) => { for (const p of ps) { const s = Math.max(0, Math.sin(t * p.rate * 2 + p.ph));
    p.d.style.transform = `translate(${p.x}px,${p.y}px) scale(${s}) rotate(${t * 40 + p.ph * 60}deg)`;
    p.d.style.opacity = a * .95; } };
}
// floating props: apples / pocky / hearts / stars / notes — the "not lonely" layer
function floaterLayer(root, { n = 10, seed = 3, zi = 6, set = ['apple', 'pocky', 'heart', 'star', 'note'], alpha = .8 } = {}) {
  const rnd = rng32(seed), ps = [];
  const mk = kind => {
    if (kind === 'apple') { const d = el(root, { width: '44px', height: '44px' });
      d.innerHTML = `<svg width="44" height="44"><circle cx="22" cy="26" r="16" fill="#e0355f"/><circle cx="16" cy="21" r="5" fill="rgba(255,255,255,.45)"/><rect x="20" y="4" width="4" height="9" rx="2" fill="#7a4a2b"/><ellipse cx="29" cy="8" rx="7" ry="4" fill="#6fbf6f" transform="rotate(20 29 8)"/></svg>`; return d; }
    if (kind === 'pocky') { const d = el(root, { width: '52px', height: '10px', borderRadius: '5px',
      background: 'linear-gradient(90deg,#f3e3c0 0 22%,#7a4a2b 22% 100%)' }); return d; }
    if (kind === 'heart') return svgEl(root, 46, 42, HEART('#ff7fa2', .15), {});
    if (kind === 'note') { const d = txt(root, '♪', { fontSize: '46px', color: '#c7647f', fontFamily: 'sans-serif' }); return d; }
    const R = 16; return svgEl(root, R * 2, R * 2, `<polygon points="${starPts(R, R, R, R * .45)}" fill="#ffd166"/>`, {});
  };
  for (let i = 0; i < n; i++) { const d = mk(set[i % set.length]); d.style.zIndex = zi;
    ps.push({ d, x: rnd() * W, y: rnd() * H, ax: 26 + rnd() * 46, ay: 18 + rnd() * 36,
      rx: .25 + rnd() * .5, ry: .2 + rnd() * .45, ph: rnd() * 9, rs: (rnd() - .5) * 80, sc: 1.1 + rnd() * .9 }); }
  return (t, a = alpha) => { for (const p of ps) {
    const x = p.x + Math.sin(t * p.rx + p.ph) * p.ax, y = p.y + Math.cos(t * p.ry + p.ph * 1.7) * p.ay - t * 6 % 40;
    p.d.style.transform = `translate(${x}px,${y}px) rotate(${Math.sin(t * .8 + p.ph) * 14 + t * p.rs * .1}deg) scale(${p.sc * (1 + beatPulse(t, 9) * .06)})`;
    p.d.style.opacity = a; } };
}
function snowLayer(root, o = {}) { return confettiLayer(root, { n: 44, seed: 21, kind: 'square', zi: 36, ...o }); }
const AMBIENTS = { confetti: confettiLayer, petals: petalLayer, sparkles: sparkleLayer, floaters: floaterLayer, snow: snowLayer };

/* ============ E. components ============ */
function nameplate(parent, s, css = {}) { return txt(parent, s, { fontFamily: 'Mochiy', color: PAL.wine,
  background: 'rgba(255,255,255,.92)', padding: '14px 22px', borderRadius: '12px',
  boxShadow: '0 8px 30px rgba(120,30,60,.25)', fontSize: '54px', ...css }); }
function pill(parent, s, css = {}) { return txt(parent, s, { fontFamily: 'Mochiy', fontSize: '30px', color: PAL.wine2,
  background: '#fff', padding: '8px 26px', borderRadius: '999px', boxShadow: '0 6px 20px rgba(120,30,60,.2)', ...css }); }
function cardEl(parent, asset, css = {}) { const c = el(parent, { background: '#fff', borderRadius: '14px',
  boxShadow: '0 18px 60px rgba(90,20,40,.28)', overflow: 'hidden', ...css });
  const im = img(c, asset, { width: '100%', height: '100%', objectFit: 'cover', position: 'relative' });
  im.style.position = 'relative'; return { c, im }; }
function cornerRibbons(root, color = PAL.wine, zi = 3) { // diagonal corner decorations
  const mk = (x, y, r) => el(root, { left: x + 'px', top: y + 'px', width: '420px', height: '54px',
    background: color, opacity: .9, zIndex: zi, transform: `rotate(${r}deg)`, borderRadius: '8px' });
  return [mk(-160, 90, -35), mk(W - 270, H - 150, -35)];
}
function dotsRow(root, { x, y, n = 4, c = PAL.wine, s = 34 }) { const ds = [];
  for (let i = 0; i < n; i++) ds.push(el(root, { width: s + 'px', height: s + 'px', borderRadius: '50%',
    background: c, left: (x + i * (s + 30)) + 'px', top: y + 'px' })); return ds; }

/* ============ F. motion (enter / idle / emphasis / exit) ============ */
const ENTERS = {
  rise_pop: (u, o) => ({ y: lerp(o.dist ?? 340, 0, outBack(u, 1.25)), s: lerp(.75, 1, outBack(u, 1.25)), o: u > 0 ? 1 : 0 }),
  pop:      (u)    => ({ s: outBack(u, 1.5), o: u > 0 ? 1 : 0 }),
  slide_l:  (u, o) => ({ x: lerp(-(o.dist ?? 520), 0, outExpo(u)), o: u > 0 ? 1 : 0 }),
  slide_r:  (u, o) => ({ x: lerp(o.dist ?? 520, 0, outExpo(u)), o: u > 0 ? 1 : 0 }),
  slide_u:  (u, o) => ({ y: lerp(o.dist ?? 420, 0, outExpo(u)), o: u > 0 ? 1 : 0 }),
  slide_d:  (u, o) => ({ y: lerp(-(o.dist ?? 420), 0, outExpo(u)), o: u > 0 ? 1 : 0 }),
  drop_bounce: (u) => ({ y: lerp(-720, 0, outElastic(u)), o: u > 0 ? 1 : 0 }),
  spin_in:  (u)    => ({ s: outBack(u, 1.1), r: lerp(-160, 0, outExpo(u)), o: u > 0 ? 1 : 0 }),
  fade_zoom:(u)    => ({ s: lerp(1.25, 1, outCubic(u)), o: outCubic(u) }),
  tilt_in:  (u, o) => ({ y: lerp(o.dist ?? 220, 0, outExpo(u)), r: lerp(o.rot ?? -12, 0, outExpo(u)), o: clamp(u * 2) }),
  flip_in:  (u, o) => ({ ry: lerp(o.deg ?? 75, 0, outCubic(u)), o: clamp(u * 3) }),
};
const IDLES = {
  breath: (t, o) => ({ s: 1 + Math.sin(t * (o.rate ?? 1.6) + (o.ph ?? 0)) * (o.amp ?? .008) }),
  bob:    (t, o) => ({ y: Math.sin(t * (o.rate ?? 1.8) + (o.ph ?? 0)) * (o.amp ?? 12) }),
  sway:   (t, o) => ({ r: Math.sin(t * (o.rate ?? 1.2) + (o.ph ?? 0)) * (o.amp ?? 2.4) }),
  float:  (t, o) => ({ x: Math.sin(t * .7 + (o.ph ?? 0)) * (o.amp ?? 16), y: Math.cos(t * .9 + (o.ph ?? 0) * 1.6) * (o.amp ?? 16) * .7 }),
  hop_beat:(t, o) => ({ y: -Math.abs(Math.sin(beatsFloat(t) * Math.PI)) * (o.amp ?? 26), sy: 1 - Math.abs(Math.sin(beatsFloat(t) * Math.PI)) * .08 }),
  pulse_beat:(t, o) => ({ s: 1 + beatPulse(t, 8) * (o.amp ?? .05) }),
  wiggle_beat:(t, o) => ({ r: Math.sin(beatsFloat(t) * Math.PI * 2) * (o.amp ?? 2) }),
  spin:   (t, o) => ({ r: t * (o.rate ?? 30) }),
  sway3d: (t, o) => ({ ry: Math.sin(t * (o.rate ?? .8) + (o.ph ?? 0)) * (o.amp ?? 6),
                       rx: Math.cos(t * .6 + (o.ph ?? 0)) * (o.amp ?? 6) * .35 }),
};
const EMPHS = {
  punch_db: (t, o) => ({ s: 1 + dbPulse(t, 5.5) * (o.amp ?? .055) }),
  punch_beat: (t, o) => ({ s: 1 + beatPulse(t, 7) * (o.amp ?? .04) }),
  none: () => ({}),
};
// motorize: compose base + enter + idles + emphasis each frame
function motorize(elm, spec, t0) {
  const idles = (spec.idles ?? [{ kind: 'breath' }, { kind: 'bob', amp: 8, rate: 1.4 }]).map(o => ({ f: IDLES[o.kind] || (() => ({})), o }));
  const ent = spec.enter ? { f: ENTERS[spec.enter.kind] || ENTERS.pop, o: spec.enter } : null;
  const emp = spec.emph ? { f: EMPHS[spec.emph.kind] || EMPHS.none, o: spec.emph } : null;
  if (spec.origin) elm.style.transformOrigin = spec.origin;
  return t => {
    let x = spec.x ?? 0, y = spec.y ?? 0, s = spec.s ?? 1, r = spec.r ?? 0, sy = 1, o = 1, rx = 0, ry = 0;
    if (ent) { const at = t0 + (ent.o.at ?? 0), u = map(t, at, at + (ent.o.dur ?? .55));
      const d = ent.f(u, ent.o); x += d.x ?? 0; y += d.y ?? 0; s *= d.s ?? 1; r += d.r ?? 0;
      rx += d.rx ?? 0; ry += d.ry ?? 0; o = Math.min(o, d.o ?? 1); }
    for (const { f, o: oo } of idles) { const d = f(t, oo); x += d.x ?? 0; y += d.y ?? 0; s *= d.s ?? 1;
      r += d.r ?? 0; rx += d.rx ?? 0; ry += d.ry ?? 0; sy *= d.sy ?? 1; }
    if (emp) { const d = emp.f(t, emp.o); s *= d.s ?? 1; r += d.r ?? 0; }
    const p3 = (rx || ry) ? `perspective(${spec.persp ?? 1100}px) ` : '';
    elm.style.transform = `${p3}translate(${x}px,${y}px) rotateX(${rx}deg) rotateY(${ry}deg) rotate(${r}deg) scale(${s}) scaleY(${sy})`;
    elm.style.opacity = o;
  };
}

/* ============ F2. multiplane camera ============ */
// cameraRig: perspective camera over depth-sorted layers (擬似3Dカメラワークの心臓部)。
//   depth > 0 = 奥(背景側), depth < 0 = 手前(カメラ側)。
//   各レイヤは translateZ(-depth) scale((P+depth)/P) で置くので、カメラ静止時の
//   見た目は depth 0 と同一(WYSIWYG)。カメラが動いた時だけ視差が現れる。
// camera path: [{at, x, y, z, yaw, pitch, roll, ease}] — at は 0..1(ショット内正規化)
//   または "db:N"(絶対拍)。z>0 でドリーイン。
const CAM_PRESETS = {
  dolly_in:   [{ at: 0, z: 0, y: 18 }, { at: 1, z: 300, y: -14, ease: 'inOutCubic' }],
  dolly_out:  [{ at: 0, z: 280, y: -10 }, { at: 1, z: -60, y: 12, ease: 'inOutCubic' }],
  pan_l:      [{ at: 0, x: 210, z: 60 }, { at: 1, x: -210, z: 60, ease: 'inOutCubic' }],
  pan_r:      [{ at: 0, x: -210, z: 60 }, { at: 1, x: 210, z: 60, ease: 'inOutCubic' }],
  crane_up:   [{ at: 0, y: 190, z: 40, pitch: -3 }, { at: 1, y: -150, z: 120, pitch: 2.5, ease: 'inOutCubic' }],
  crane_down: [{ at: 0, y: -170, z: 40, pitch: 2.5 }, { at: 1, y: 150, z: 120, pitch: -3, ease: 'inOutCubic' }],
  orbit:      [{ at: 0, yaw: -7, x: -120, z: 90 }, { at: 1, yaw: 7, x: 120, z: 90, ease: 'inOutCubic' }],
  pass_through: [{ at: 0, z: -80 }, { at: .82, z: 620, ease: 'inCubic' }, { at: 1, z: 1150, ease: 'inCubic' }],
  push_beat:  [{ at: 0, z: 40 }, { at: 1, z: 200, ease: 'linear' }],
  still:      [{ at: 0 }, { at: 1 }],
};
function cameraRig(root, opts = {}) {
  const P = opts.persp ?? 1200;
  // perspectiveはroot直付けせず専用コンテナに隔離する:
  // rootに付けると兄弟のFXオーバーレイまで3D文脈に取り込まれ、
  // 手前レイヤ(depth<0)より奥と判定されて描画順が壊れる
  const viewport = el(root, { inset: 0, zIndex: 0 });
  viewport.style.perspective = P + 'px';
  viewport.style.perspectiveOrigin = '50% 50%';
  const world = el(viewport, { inset: 0, transformStyle: 'preserve-3d' });
  function layer(depth = 0, css) {
    const L = el(world, { inset: 0, ...css });
    const s = (P + depth) / P;
    if (depth) L.style.transform = `translateZ(${-depth}px) scale(${s})`;
    L.dataset.mkDepth = depth;
    return L;
  }
  const path = (typeof opts.camera === 'string' ? CAM_PRESETS[opts.camera] : opts.camera) || CAM_PRESETS.dolly_in;
  const sway = opts.sway === false ? null : { x: 6, y: 4, roll: .3, rate: .5, ...(opts.sway || {}) };
  const dbKick = opts.dbKick === false ? null : { z: 26, d: 6, ...(opts.dbKick || {}) };
  const CH = ['x', 'y', 'z', 'yaw', 'pitch', 'roll'];
  function evalPath(t, t0, t1) {
    const abs = v => typeof v === 'string' ? T(v) : t0 + v * (t1 - t0);
    const ts = path.map(k => abs(k.at ?? 0));
    let i = 0; while (i < path.length - 1 && t >= ts[i + 1]) i++;
    const j = Math.min(i + 1, path.length - 1);
    const a = path[i], b = path[j];
    const u = ts[j] <= ts[i] ? 1 : (EASE[b.ease || 'inOutCubic'] || inOutCubic)(map(t, ts[i], ts[j]));
    const c = {}; for (const k of CH) c[k] = lerp(a[k] ?? 0, b[k] ?? (a[k] ?? 0), u);
    return c;
  }
  function update(t, t0, t1) {
    const c = evalPath(t, t0, t1);
    if (sway) { c.x += Math.sin(t * sway.rate * 2.1) * sway.x; c.y += Math.cos(t * sway.rate * 1.7) * sway.y;
      c.roll += Math.sin(t * sway.rate * 1.3) * sway.roll; }
    if (dbKick) c.z += dbPulse(t, dbKick.d) * dbKick.z;
    world.style.transform = `rotateX(${-c.pitch}deg) rotateY(${-c.yaw}deg) rotate(${-c.roll}deg) translate3d(${-c.x}px,${-c.y}px,${c.z}px)`;
    return c;
  }
  return { world, layer, update, P };
}

/* ============ G. global overlays ============ */
const stage = document.getElementById('stage');
const scenesRoot = document.getElementById('scenes');
const flashEl = document.getElementById('flash');
const lbT = document.getElementById('letterbox-top'), lbB = document.getElementById('letterbox-bot');
const irisEl = document.getElementById('iris');
const FLASHES = [], BANDCUTS = [];
const flashAt = (t, dur = .3, peak = 1) => FLASHES.push({ t, dur, peak });
const bandsRoot = document.getElementById('bands');
const bandEls = [];
for (let i = 0; i < 4; i++) bandEls.push(el(bandsRoot, { left: 0, width: '100%', height: '25%',
  top: (i * 25) + '%', background: i % 2 ? PAL.wine : '#f2b9c4', zIndex: 85, transform: 'translateX(-102%)' }));
function updateBands(t) { let u = -1;
  for (const c of BANDCUTS) if (t >= c - .22 && t <= c + .20) { u = (t - (c - .22)) / .42; break; }
  bandEls.forEach((e, i) => { if (u < 0) { e.style.transform = 'translateX(-102%)'; return; }
    const uu = clamp((u - i * .06) / (1 - i * .084));
    e.style.transform = `translateX(${uu < .5 ? lerp(-102, 0, outCubic(uu * 2)) : lerp(0, 102, inCubic((uu - .5) * 2))}%)`; });
}
function updateFlash(t) { let o = 0;
  for (const f of FLASHES) if (t >= f.t && t <= f.t + f.dur) o = Math.max(o, f.peak * (1 - (t - f.t) / f.dur));
  flashEl.style.opacity = o; }
let letterboxH = () => 0, irisFn = () => null;

/* ============ H. shot framework ============ */
// A template builds DOM under `root` from params `p` and returns update(t).
// ctx: {t0,t1,idx} — absolute start/end and shot index (for auto variety).
const TEMPLATES = {};
const AUTO_ENTERS = ['rise_pop', 'slide_l', 'slide_r', 'tilt_in', 'spin_in', 'slide_u'];
function autoEnter(idx) { return AUTO_ENTERS[idx % AUTO_ENTERS.length]; }
function ambientOf(root, spec, seedBase) {
  if (spec === 'none') return () => {};
  const list = Array.isArray(spec) ? spec : [spec || { kind: 'floaters', n: 9 }];
  const ups = list.map((s, i) => (AMBIENTS[s.kind] || floaterLayer)(root, { seed: seedBase + i * 7, ...s }));
  return (t, a = 1) => ups.forEach(u => u(t, a * (list[0].alpha ?? 1)));
}
function kenburns(im, idx, amount = .06) { const dir = idx % 2 ? -1 : 1;
  return (t, t0, t1) => { const u = map(t, t0, t1);
    im.style.transform = `scale(${1.05 + u * amount}) translate(${dir * lerp(18, -18, u)}px,${lerp(8, -8, u) * dir}px)`; }; }

/* ---- showcase_pattern: pattern bg + subject cutout + ornaments + props ---- */
TEMPLATES.showcase_pattern = (root, p, ctx) => {
  const drift = patternBG(root, p.bg || 'argyle', p.bgColor);
  cornerRibbons(root, p.accent || PAL.wine);
  const amb = ambientOf(root, p.ambient, ctx.idx * 31 + 5);
  const subs = (p.subjects || [p.subject]).filter(Boolean).map((sp, i) => {
    const m = img(root, sp.asset, { height: (sp.h ?? 860) + 'px', left: (sp.x ?? 640) + 'px', top: (sp.y ?? 220) + 'px', zIndex: 8 });
    tag(m, ctx, p.subjects ? `subjects[${i}]` : 'subject', sp.asset);
    return motorize(m, { origin: '50% 100%', enter: { kind: sp.enter || autoEnter(ctx.idx + i), at: .05 + i * .19, dur: .55 },
      idles: [{ kind: 'breath' }, { kind: 'sway', amp: 1.2, rate: .9, ph: i }], emph: { kind: 'punch_db', amp: .03 } }, ctx.t0);
  });
  const orns = (p.ornaments || []).map((o, i) => {
    let e;
    if (o.kind === 'nameplate') e = nameplate(root, o.text, { left: o.x + 'px', top: o.y + 'px', zIndex: 10,
      ...(o.vertical ? { writingMode: 'vertical-rl', fontSize: '72px', letterSpacing: '.2em' } : {}), ...(o.css || {}) });
    else if (o.kind === 'pill') e = pill(root, o.text, { left: o.x + 'px', top: o.y + 'px', zIndex: 10 });
    else if (o.kind === 'chibi') e = img(root, o.asset, { height: (o.h ?? 180) + 'px', left: o.x + 'px', top: o.y + 'px', zIndex: 9 });
    else if (o.kind === 'banner') { e = el(root, { left: o.x + 'px', top: o.y + 'px', padding: '18px 44px', background: PAL.wine,
      color: '#fff', fontFamily: 'Mochiy', fontSize: '58px', borderRadius: '8px', zIndex: 10, boxShadow: '0 14px 40px rgba(120,30,60,.35)' }); e.textContent = o.text; }
    else if (o.kind === 'sub') e = txt(root, o.text, { left: o.x + 'px', top: o.y + 'px', fontFamily: 'Yusei', fontSize: '30px', color: PAL.wine2, zIndex: 10, ...(o.vertical ? { writingMode: 'vertical-rl' } : {}) });
    else if (o.kind === 'heart') { e = svgEl(root, 300, 280, HEART(PAL.deep), { left: o.x + 'px', top: o.y + 'px', zIndex: 9 }); }
    else e = txt(root, o.text || '★', { left: o.x + 'px', top: o.y + 'px', zIndex: 9 });
    tag(e, ctx, `ornaments[${i}]`, o.text || o.asset || o.kind);
    const idleSets = { chibi: [{ kind: 'hop_beat', amp: 26 }], heart: [{ kind: 'pulse_beat', amp: .16 }, { kind: 'bob', amp: 6 }] };
    return motorize(e, { enter: { kind: o.enter || 'pop', at: .3 + i * .186, dur: .34 },
      idles: idleSets[o.kind] || [{ kind: 'bob', amp: 7, rate: 1.6, ph: i * 1.7 }, { kind: 'sway', amp: 1.6, ph: i }] }, ctx.t0);
  });
  const dots = dotsRow(root, { x: p.dotsX ?? 330, y: p.dotsY ?? 830 });
  return t => { drift(t); amb(t, map(t, ctx.t0, ctx.t0 + .6));
    subs.forEach(u => u(t)); orns.forEach(u => u(t));
    dots.forEach((d, i) => { const bt = beatAfter(ctx.t0, i + 1);
      d.style.transform = `scale(${outBack(map(t, bt, bt + .25))}) translateY(${Math.sin(t * 2 + i) * 5}px)`; }); };
};

/* ---- showcase_card: tilted photo card + side typography + particles ---- */
TEMPLATES.showcase_card = (root, p, ctx) => {
  const drift = patternBG(root, p.bg || 'soft', p.bgColor);
  const amb = ambientOf(root, p.ambient || { kind: 'petals', n: 26 }, ctx.idx * 17 + 3);
  const { c, im } = cardEl(root, p.asset, { width: (p.w ?? 640) + 'px', height: (p.h ?? 900) + 'px',
    left: (p.x ?? 340) + 'px', top: (p.y ?? 90) + 'px', zIndex: 8 });
  tag(c, ctx, 'asset', p.asset);
  const rot = p.rot ?? -6;
  const vert = p.titleVertical !== false;
  const typo = p.title ? tag(txt(root, p.title, { left: p.titleX + 'px', top: p.titleY + 'px', fontFamily: 'Mochiy',
    fontSize: (p.titleSize ?? 96) + 'px', color: p.titleColor || '#e8608a', letterSpacing: '.3em', zIndex: 10,
    ...(vert ? { writingMode: 'vertical-rl' } : {}) }), ctx, 'title', p.title) : null;
  const sub = p.sub ? tag(txt(root, p.sub, { fontFamily: 'Yusei', fontSize: '30px', color: p.titleColor || '#c04a72', zIndex: 10,
    ...(vert ? { writingMode: 'vertical-rl', left: (p.titleX + 150) + 'px', top: (p.titleY + 50) + 'px' }
             : { left: p.titleX + 'px', top: (p.titleY + (p.titleSize ?? 96) + 40) + 'px' }) }), ctx, 'sub', p.sub) : null;
  const stickers = (p.stickers || []).map((o, i) => { const e = img(root, o.asset, { height: (o.h ?? 340) + 'px', left: o.x + 'px', top: o.y + 'px', zIndex: 9 });
    tag(e, ctx, `stickers[${i}]`, o.asset);
    return motorize(e, { enter: { kind: 'pop', at: .35 + i * .25, dur: .4 },
      idles: [{ kind: 'float', amp: 14, ph: i * 2 }, { kind: 'sway', amp: 4, ph: i }] }, ctx.t0); });
  return t => { drift(t); amb(t, 1);
    const cu = outExpo(map(t, ctx.t0, ctx.t0 + .6));
    c.style.transform = `perspective(1300px) translateY(${lerp(200, 0, cu)}px) rotateY(${Math.sin(t * .75) * 5.5}deg) rotateX(${Math.cos(t * .55) * 2.2}deg) rotate(${lerp(rot * 2.2, rot, cu)}deg) translateX(${Math.sin(t * .8) * 6}px)`;
    c.style.opacity = clamp(cu * 2);
    im.style.transform = `scale(${1.13 - map(t, ctx.t0, ctx.t1) * .09})`;
    if (typo) { typo.style.opacity = map(t, ctx.t0 + .35, ctx.t0 + .7);
      typo.style.transform = `translateY(${lerp(60, 0, outCubic(map(t, ctx.t0 + .35, ctx.t0 + .8))) + Math.sin(t * 1.1) * 5}px)`; }
    if (sub) sub.style.opacity = map(t, ctx.t0 + .55, ctx.t0 + .9);
    stickers.forEach(u => u(t)); };
};

/* ---- showcase_fullbleed: full art + punch + frame + optional speedlines ---- */
TEMPLATES.showcase_fullbleed = (root, p, ctx) => {
  root.style.background = '#111';
  const im = img(root, p.asset, { width: '116%', height: '116%', objectFit: 'cover', left: '-8%', top: '-8%' });
  tag(im, ctx, 'asset', p.asset);
  const vig = el(root, { inset: 0, zIndex: 3, background: `radial-gradient(circle, transparent 55%, ${p.vignette || 'rgba(160,20,50,.5)'})` });
  let speed = null;
  if (p.speedlines) speed = el(root, { inset: '-200px', zIndex: 4,
    background: 'repeating-conic-gradient(from 0deg at 50% 50%, rgba(255,255,255,0) 0deg 5deg, rgba(255,255,255,.5) 5deg 6.2deg)',
    WebkitMaskImage: 'radial-gradient(circle, transparent 34%, black 72%)' });
  const corners = [];
  if (p.corners !== false) [[40, 40, 'Top', 'Left'], [W - 260, 40, 'Top', 'Right'], [40, H - 260, 'Bottom', 'Left'], [W - 260, H - 260, 'Bottom', 'Right']]
    .forEach(([x, y, v, h2]) => { const c = el(root, { left: x + 'px', top: y + 'px', width: '220px', height: '220px', zIndex: 5 });
      c.style['border' + v] = '16px solid #fff'; c.style['border' + h2] = '16px solid #fff'; corners.push(c); });
  const badge = p.badge ? tag(txt(root, p.badge, { right: '70px', bottom: '70px', fontFamily: 'Yusei', fontSize: '34px', color: '#fff',
    background: 'rgba(165,64,92,.9)', padding: '8px 22px', borderRadius: '999px', zIndex: 6 }), ctx, 'badge', p.badge) : null;
  const amb = ambientOf(root, p.ambient || { kind: 'sparkles', n: 18 }, ctx.idx * 13 + 9);
  const kb = kenburns(im, ctx.idx, .07);
  return t => { const u = map(t, ctx.t0, ctx.t1);
    im.style.transform = `perspective(1600px) rotateY(${Math.sin(t * .5 + ctx.idx) * 2}deg) rotateX(${Math.cos(t * .4) * 1}deg) scale(${1.06 + u * .06 + dbPulse(t) * .055}) rotate(${(u - .5) * (p.rock ?? 1.2)}deg)`;
    if (speed) { speed.style.opacity = .22 + beatPulse(t) * .55; speed.style.transform = `rotate(${t * 14}deg)`; }
    corners.forEach((c, i) => { c.style.opacity = map(t, ctx.t0 + .1 + i * .09, ctx.t0 + .3 + i * .09);
      c.style.transform = `translate(${Math.sin(t * 1.5 + i) * 4}px,${Math.cos(t * 1.3 + i) * 4}px)`; });
    if (badge) { badge.style.opacity = map(t, ctx.t0 + .4, ctx.t0 + .7);
      badge.style.transform = `rotate(${Math.sin(beatsFloat(t) * Math.PI * 2) * 1.5}deg)`; }
    amb(t, 1); };
};

/* ---- panels_strip: N vertical panels ---- */
TEMPLATES.panels_strip = (root, p, ctx) => {
  root.style.background = '#fff';
  const n = p.panels.length;
  const amb = ambientOf(root, p.ambient || { kind: 'sparkles', n: 16, color: '#ffd9e6' }, 77);
  const ups = p.panels.map((pp, i) => {
    const pn = el(root, { left: (i * (W / n)) + 'px', top: 0, width: (W / n - 6) + 'px', height: '100%', background: pp.bg || PAL.pink, overflow: 'hidden' });
    const inner = img(pn, pp.asset, { height: (pp.h ?? '78%'), left: '50%', top: '52%' });
    tag(inner, ctx, `panels[${i}]`, pp.asset);
    tag(txt(pn, pp.label, { left: 0, right: 0, bottom: '60px', textAlign: 'center', fontFamily: 'Mochiy', fontSize: '44px', color: PAL.wine }), ctx, `panels[${i}]`, pp.label);
    const fl = floaterLayer(pn, { n: 4, seed: i * 9 + 2, set: ['heart', 'star', 'note'], alpha: .5 });
    return t => { const pu = outExpo(map(t, ctx.t0 + i * .07, ctx.t0 + .42 + i * .07));
      pn.style.transform = `perspective(1400px) translateY(${lerp(i % 2 ? -104 : 104, 0, pu)}%) rotateY(${(1 - pu) * (i % 2 ? -40 : 40) + Math.sin(t * .7 + i * 2) * 2.5}deg)`;
      inner.style.transform = `translate(-50%,-50%) translateY(${Math.sin(t * 1.8 + i) * 14}px) rotate(${Math.sin(t * 1.1 + i * 2) * 2}deg) scale(${1 + beatPulse(t, 8) * .03})`;
      fl(t); };
  });
  return t => { ups.forEach(u => u(t)); amb(t, 1); };
};

/* ---- bands_repeat / cv_card / rapid_cuts / riser ---- */
TEMPLATES.bands_repeat = (root, p, ctx) => {
  root.style.background = '#3a3a3a';
  const tints = ['none', 'sepia(.4) hue-rotate(-20deg) saturate(1.6)', 'grayscale(.85)', 'grayscale(.4) brightness(1.25)'];
  const bands = [];
  for (let i = 0; i < 4; i++) { const b = el(root, { left: 0, top: (i * 25) + '%', width: '100%', height: '25%', overflow: 'hidden' });
    const m = tag(img(b, p.asset, { width: '100%', height: '400%', objectFit: 'cover', left: 0, top: (-i * 100) + '%', filter: tints[i] }), ctx, 'asset', p.asset);
    bands.push({ b, m }); }
  const amb = ambientOf(root, { kind: 'sparkles', n: 12 }, 55);
  return t => { bands.forEach(({ b }, i) => { const e2 = outExpo(map(t, ctx.t0 + i * .1, ctx.t0 + .45 + i * .1));
      b.style.transform = `translateX(${lerp(i % 2 ? 104 : -104, 0, e2) + Math.sin(t * .9 + i) * 1.6}%)`; }); amb(t, .7); };
};
TEMPLATES.cv_card = (root, p, ctx) => {
  root.style.background = '#efe7e9';
  el(root, { right: 0, top: 0, width: '54%', height: '100%', background: 'repeating-linear-gradient(0deg,#efe7e9 0 90px,#e6d9dd 90px 180px)' });
  const left = el(root, { left: 0, top: 0, width: '46%', height: '100%', background: PAL.wine2, zIndex: 2, padding: '120px 90px', color: '#fff' });
  const lines = [txt(left, p.name1 || 'SAKURA', { position: 'relative', fontSize: '120px', fontFamily: 'MPR' }),
                 txt(left, p.name2 || 'KYOKO', { position: 'relative', fontSize: '120px', fontFamily: 'MPR', marginTop: '-14px' }),
                 txt(left, p.kanji || '佐倉 杏子', { position: 'relative', fontSize: '54px', fontFamily: 'Mochiy', marginTop: '26px', color: '#ffd9e2' }),
                 txt(left, p.foot || '', { position: 'relative', fontSize: '24px', fontFamily: 'Yusei', marginTop: '150px', color: '#f3c3cf' })];
  lines.forEach(e2 => e2.style.position = 'relative');
  ['name1','name2','kanji','foot'].forEach((k, i) => tag(lines[i], ctx, k, p[k] || k));
  const chips = (p.chips || []).map(c => { const e2 = txt(left, c, { position: 'relative', display: 'inline-block', marginTop: '40px', marginRight: '18px',
    padding: '8px 26px', background: '#fff', color: PAL.wine2, fontSize: '30px', fontFamily: 'Mochiy', borderRadius: '999px' });
    e2.style.position = 'relative'; return tag(e2, ctx, `chips[${(p.chips||[]).indexOf(c)}]`, c); });
  const gl = img(root, p.asset, { height: '92%', left: '52%', bottom: '-40px', zIndex: 3 });
  tag(gl, ctx, 'asset', p.asset);
  const amb = ambientOf(root, { kind: 'floaters', n: 6, set: ['heart', 'star'], alpha: .5 }, 91);
  return t => { left.style.transform = `translateX(${lerp(-100, 0, outExpo(map(t, ctx.t0, ctx.t0 + .5)))}%)`;
    lines.forEach((e2, i) => { const u = map(t, ctx.t0 + .25 + i * .14, ctx.t0 + .55 + i * .14);
      e2.style.opacity = u; e2.style.transform = `translateX(${lerp(-60, 0, outCubic(u))}px)`; });
    chips.forEach((c, i) => { const bt = beatAfter(ctx.t0 + .8, i);
      c.style.transform = `scale(${outBack(map(t, bt, bt + .3))})`; });
    gl.style.transform = `translateX(${lerp(340, 0, outExpo(map(t, ctx.t0 + .15, ctx.t0 + .7)))}px) scale(${1 + beatPulse(t, 9) * .02}) translateY(${Math.sin(t * 1.1) * 6}px)`;
    amb(t, 1); };
};
TEMPLATES.rapid_cuts = (root, p, ctx) => {
  root.style.background = '#000';
  const imgs = p.arts.map((n, i) => tag(img(root, n, { width: '100%', height: '100%', objectFit: 'cover', display: 'none' }), ctx, `arts[${i}]`, n));
  const label = tag(txt(root, '', { left: '70px', bottom: '70px', fontFamily: 'Mochiy', fontSize: '52px', color: '#fff',
    textShadow: '0 4px 20px rgba(0,0,0,.5)', zIndex: 5, transformOrigin: '0 100%' }), ctx, 'labels', 'labels');
  const ring = el(root, { left: '50%', top: '50%', width: '260px', height: '260px', margin: '-130px', border: '18px solid #fff', borderRadius: '50%', zIndex: 4, opacity: 0 });
  return t => { const seg = (ctx.t1 - ctx.t0) / p.arts.length;
    const k = Math.min(p.arts.length - 1, Math.floor((t - ctx.t0) / seg));
    imgs.forEach((m, i) => m.style.display = i === k ? 'block' : 'none');
    const lt = ctx.t0 + k * seg, lu = map(t, lt, lt + seg);
    imgs[k].style.transform = `scale(${1.18 - outCubic(lu) * .08}) rotate(${(lu - .5) * 1.4}deg)`;
    label.textContent = (p.labels || [])[k] ?? '';
    label.style.transform = `scale(${outBack(map(t, lt, lt + .2), 2)})`;
    const ru = map(t, lt, lt + .45); ring.style.transform = `scale(${1 + ru * 5})`; ring.style.opacity = ru < 1 ? (1 - ru) * .9 : 0; };
};
TEMPLATES.riser = (root, p, ctx) => {
  root.style.background = '#fff';
  const im = tag(img(root, p.asset, { width: '100%', height: '100%', objectFit: 'cover', filter: 'brightness(1.05)' }), ctx, 'asset', p.asset);
  const rings = []; for (let i = 0; i < 4; i++) rings.push(el(root, { left: '50%', top: '50%', width: '100px', height: '100px',
    margin: '-50px', borderRadius: '50%', border: '14px solid #fff', zIndex: 4, opacity: 0 }));
  const wh = el(root, { inset: 0, background: '#fff', zIndex: 5, opacity: 0 });
  return t => { im.style.transform = `scale(${1 + inCubic(map(t, ctx.t0, ctx.t1)) * .22})`;
    rings.forEach((r, i) => { const bt = beatAfter(ctx.t0, i), uu = map(t, bt, bt + .55);
      r.style.transform = `scale(${1 + uu * 13})`; r.style.opacity = uu > 0 && uu < 1 ? 1 - uu : 0; });
    wh.style.opacity = inCubic(map(t, ctx.t1 - .45, ctx.t1)); };
};

/* ---- parallax_scene: マルチプレーンカメラの標準テンプレート ----
   bg(最奥) / layers(中景) / subjects(主役 depth0) / fg(前景=カメラ手前) を
   仮想カメラが移動して視差を生む。camera: プリセット名 or キーフレーム配列。
   例: { "template": "parallax_scene", "params": {
     "bg": { "pattern": "soft" }, "camera": "dolly_in",
     "layers": [{ "asset": "loop_dusk.webm", "depth": 520, "video": true }],
     "subjects": [{ "asset": "fb_pocky_cut.png", "x": 700, "y": 200, "h": 860 }],
     "fg": [{ "asset": "chibi_run.png", "depth": -240, "x": 120, "y": 700, "h": 300 }],
     "ornaments": [{ "kind": "nameplate", "text": "杏子", "x": 1300, "y": 640, "depth": -120 }] } } */
TEMPLATES.parallax_scene = (root, p, ctx) => {
  const rig = cameraRig(root, { persp: p.persp, camera: p.camera || 'dolly_in',
    sway: p.sway, dbKick: p.dbKick });
  const vids = [], ups = [];

  // 最奥: パターン or 画像 or 動画 (深度ぶん拡大されるので端は見えない)
  const bgDepth = p.bgDepth ?? 780;
  const bgL = rig.layer(bgDepth);
  if (p.bg?.asset) {
    if (p.bg.video) { const { v, seekTo } = vid(bgL, p.bg.asset, { width: '112%', height: '112%', objectFit: 'cover', left: '-6%', top: '-6%' }); vids.push(seekTo); tag(v, ctx, 'bg', p.bg.asset); }
    else tag(img(bgL, p.bg.asset, { width: '112%', height: '112%', objectFit: 'cover', left: '-6%', top: '-6%' }), ctx, 'bg', p.bg.asset);
  } else {
    ups.push(patternBG(bgL, p.bg?.pattern || 'soft', p.bg?.color));
  }

  // 中景レイヤ群
  (p.layers || []).forEach((L, i) => {
    const lay = rig.layer(L.depth ?? 420);
    let e;
    if (L.video) { const { v, seekTo } = vid(lay, L.asset, { height: (L.h ?? 1080) + 'px', left: (L.x ?? 0) + 'px', top: (L.y ?? 0) + 'px', objectFit: 'cover' }); vids.push(seekTo); e = v; }
    else e = img(lay, L.asset, { height: (L.h ?? 1080) + 'px', left: (L.x ?? 0) + 'px', top: (L.y ?? 0) + 'px' });
    tag(e, ctx, `layers[${i}]`, L.asset);
    if (L.idles) ups.push(motorize(e, { x: 0, y: 0, idles: L.idles }, ctx.t0));
  });

  // 主役 (depth 0 — 構図はshowcase系と同じ座標感覚)
  const subL = rig.layer(0);
  (p.subjects || (p.subject ? [p.subject] : [])).forEach((sp, i) => {
    const m = img(subL, sp.asset, { height: (sp.h ?? 860) + 'px', left: (sp.x ?? 640) + 'px', top: (sp.y ?? 220) + 'px', zIndex: 8 });
    tag(m, ctx, p.subjects ? `subjects[${i}]` : 'subject', sp.asset);
    ups.push(motorize(m, { origin: '50% 100%',
      enter: { kind: sp.enter || autoEnter(ctx.idx + i), at: .05 + i * .19, dur: .55 },
      idles: sp.idles || [{ kind: 'breath' }, { kind: 'sway', amp: 1.2, rate: .9, ph: i }],
      emph: { kind: 'punch_db', amp: .03 } }, ctx.t0));
  });

  // 飾り (depth指定可、既定は主役と同面)
  (p.ornaments || []).forEach((o, i) => {
    const lay = o.depth ? rig.layer(o.depth) : subL;
    let e;
    if (o.kind === 'nameplate') e = nameplate(lay, o.text, { left: o.x + 'px', top: o.y + 'px', zIndex: 10, ...(o.css || {}) });
    else if (o.kind === 'pill') e = pill(lay, o.text, { left: o.x + 'px', top: o.y + 'px', zIndex: 10 });
    else if (o.kind === 'chibi') e = img(lay, o.asset, { height: (o.h ?? 180) + 'px', left: o.x + 'px', top: o.y + 'px', zIndex: 9 });
    else e = txt(lay, o.text || '★', { left: o.x + 'px', top: o.y + 'px', zIndex: 9, fontFamily: 'Mochiy', fontSize: (o.size ?? 46) + 'px', color: o.color || PAL.wine });
    tag(e, ctx, `ornaments[${i}]`, o.text || o.asset || o.kind);
    ups.push(motorize(e, { enter: { kind: o.enter || 'pop', at: .3 + i * .186, dur: .34 },
      idles: o.kind === 'chibi' ? [{ kind: 'hop_beat', amp: 26 }] : [{ kind: 'bob', amp: 7, rate: 1.6, ph: i * 1.7 }] }, ctx.t0));
  });

  // 前景 (カメラ手前を横切る要素 — 通り抜け感の主成分)
  (p.fg || []).forEach((f, i) => {
    const lay = rig.layer(f.depth ?? -240);
    const e = img(lay, f.asset, { height: (f.h ?? 320) + 'px', left: (f.x ?? 100) + 'px', top: (f.y ?? 640) + 'px', opacity: f.alpha ?? .96 });
    tag(e, ctx, `fg[${i}]`, f.asset);
    ups.push(motorize(e, { idles: f.idles || [{ kind: 'float', amp: 20, ph: i * 2.4 }, { kind: 'sway', amp: 3, ph: i }] }, ctx.t0));
  });

  // 粒子を2深度に分けて撒く: 視差する粒子は「空間がある」感を一気に上げる
  if (p.ambient !== 'none') {
    const far = ambientOf(rig.layer(p.bgDepth ? bgDepth * .55 : 430), p.ambient || { kind: 'petals', n: 16 }, ctx.idx * 29 + 1);
    const near = ambientOf(rig.layer(-160), p.ambientNear || { kind: 'sparkles', n: 10 }, ctx.idx * 29 + 8);
    ups.push(t => { far(t, 1); near(t, .85); });
  }

  return t => {
    rig.update(t, ctx.t0, ctx.t1);
    const tt = t - ctx.t0;
    vids.forEach(sk => sk(tt));
    ups.forEach(u => u(t));
  };
};

/* ---- lineup ---- */
TEMPLATES.lineup = (root, p, ctx) => {
  root.style.background = PAL.pink2;
  const flashBG = el(root, { inset: 0, background: '#fff', opacity: 0, zIndex: 1 });
  el(root, { left: 0, top: 0, width: '100%', height: '70px', background: PAL.wine });
  el(root, { left: 0, bottom: 0, width: '100%', height: '70px', background: PAL.wine });
  const amb = ambientOf(root, [{ kind: 'confetti', n: 60 }, { kind: 'sparkles', n: 14, color: '#ffb7cd' }], 99);
  const n = p.assets.length, cw = (W - 220) / n;
  const items = p.assets.map((a, i) => {
    const wrap = el(root, { left: (110 + i * cw) + 'px', top: '190px', width: (cw - 20) + 'px', textAlign: 'center' });
    const m = img(wrap, a, { position: 'relative', height: '640px', left: '50%' }); m.style.position = 'relative';
    tag(m, ctx, `assets[${i}]`, a);
    const tagEl = txt(wrap, p.tags?.[i] ?? p.tag ?? '佐倉杏子', { position: 'relative', marginTop: '14px', fontFamily: 'Mochiy', fontSize: '34px',
      color: PAL.wine, background: '#fff', display: 'inline-block', padding: '4px 22px', borderRadius: '999px' });
    tagEl.style.position = 'relative'; return { wrap, m, i };
  });
  const title = tag(txt(root, p.title || '', { left: 0, right: 0, top: '84px', textAlign: 'center', fontFamily: 'Mochiy', fontSize: '58px', color: PAL.wine }), ctx, 'title', p.title);
  return t => { amb(t, 1);
    flashBG.style.opacity = beatPulse(t, 10) * .28;
    items.forEach(({ wrap, m, i }) => { const uu = outBack(map(t, ctx.t0 + i * .13, ctx.t0 + .34 + i * .13), 1.2);
      const hop = Math.abs(Math.sin(beatsFloat(t) * Math.PI));
      wrap.style.transform = `translateY(${lerp(500, 0, uu) - hop * 26}px)`;
      m.style.transform = `translateX(-50%) scaleY(${1 - hop * .07}) rotate(${Math.sin(beatsFloat(t) * Math.PI * 2 + i) * 2.6}deg)`; });
    title.style.opacity = map(t, ctx.t0 + .35, ctx.t0 + .65);
    title.style.transform = `scale(${1 + beatPulse(t, 9) * .04})`; };
};

/* ---- finale_cuts: downbeat art switches + heavy party layer ---- */
TEMPLATES.finale_cuts = (root, p, ctx) => {
  root.style.background = '#fff';
  const slides = p.arts.map(n => { const wrap = el(root, { inset: 0, overflow: 'hidden', display: 'none' });
    const m = img(wrap, n, { width: '114%', height: '114%', objectFit: 'cover', left: '-7%', top: '-7%' });
    const ring = el(wrap, { left: '50%', top: '50%', width: '300px', height: '300px', margin: '-150px', border: '20px solid #fff', borderRadius: '50%', zIndex: 5, opacity: 0 });
    return { wrap, m, ring }; });
  const conf = confettiLayer(root, { n: 130, seed: 99, zi: 40 });
  const spark = sparkleLayer(root, { n: 20, seed: 44, zi: 41 });
  const chb = (p.cornerChibis || []).map((a, i) => img(root, a, { height: '190px', zIndex: 42,
    left: i % 2 ? (W - 260) + 'px' : '70px', top: (H - 280) + 'px' }));
  const bounds = []; for (let i = 0; i < p.arts.length; i++) bounds.push(T(`db:${p.fromBar + i}`));
  bounds.push(ctx.t1);
  return t => { let k = 0; for (let i = 0; i < p.arts.length; i++) if (t >= bounds[i]) k = i;
    slides.forEach((s, i) => s.wrap.style.display = i === k ? 'block' : 'none');
    const a = bounds[k], b = bounds[k + 1], u = map(t, a, b), dir = k % 2 ? -1 : 1;
    slides[k].m.style.transform = `translateX(${dir * lerp(50, -50, u)}px) scale(${1.1 + beatPulse(t, 6) * .05}) rotate(${dir * (u - .5) * 1.2}deg)`;
    const ru = map(t, a, a + .5); slides[k].ring.style.transform = `scale(${1 + ru * 6})`;
    slides[k].ring.style.opacity = ru < 1 ? 1 - ru : 0;
    conf(t, 1); spark(t, 1);
    chb.forEach((c, i) => c.style.transform = `translateY(${-Math.abs(Math.sin(beatsFloat(t) * Math.PI)) * 40}px) rotate(${Math.sin(t * 2 + i) * 8}deg)`); };
};

/* ============ I. FX — MAD定番エフェクト(shot単位で合成可能) ============
   shotlist: "fx": [{kind, on, amp, ...}] — on: "db"(小節頭) | "beat" | [秒...] | "always"
   すべて決定論(tの純関数)。SVGフィルタはdefsを共有し、per-shotでパラメータ更新。 */
let _fxDefs = null, _fxSeq = 0;
function _fxSvg() {
  if (_fxDefs) return _fxDefs;
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', 0); s.setAttribute('height', 0);
  s.style.position = 'absolute';
  document.body.appendChild(s);
  _fxDefs = s; return s;
}
// トリガー包絡線: on指定 → 0..1 の強度(直近イベントからの減衰)
function _fxEnv(on, t, ctx, decay = 6) {
  if (on === 'always') return 1;
  if (Array.isArray(on)) { let e = 0;
    for (const v of on) { const tv = T(v); if (t >= tv) e = Math.max(e, Math.exp(-(t - tv) * decay)); }
    return e; }
  if (on === 'beat') return beatPulse(t, decay);
  return dbPulse(t, decay);   // 既定 "db"
}
const FXS = {
  // 歪みグリッチ: feTurbulence+feDisplacementMap + 時々の色反転コマ
  glitch(root, o, ctx) {
    const id = `mkfx${_fxSeq++}`;
    _fxSvg().innerHTML += `<filter id="${id}" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0 0.12" numOctaves="1" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="0" xChannelSelector="R" yChannelSelector="G"/></filter>`;
    const disp = () => _fxDefs.querySelector(`#${id} feDisplacementMap`);
    return t => { const e = _fxEnv(o.on, t, ctx, o.decay ?? 7) * (o.amp ?? 1);
      const d = disp(); if (!d) return;
      d.setAttribute('scale', String(e * 90));
      const fr = Math.floor(t * 30);
      root.style.filter = e > .04 ? `url(#${id})${(fr % 7 === 0 && e > .5) ? ' invert(1) hue-rotate(90deg)' : ''}` : '';
    };
  },
  // RGBずれ(色収差): R/Bチャンネルを左右にオフセットして再合成
  rgb_shift(root, o, ctx) {
    const id = `mkfx${_fxSeq++}`;
    _fxSvg().innerHTML += `<filter id="${id}" x="-5%" y="-5%" width="110%" height="110%">
      <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r"/>
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="g"/>
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="b"/>
      <feOffset in="r" dx="0" result="ro"/><feOffset in="b" dx="0" result="bo"/>
      <feBlend in="ro" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="bo" mode="screen"/></filter>`;
    const offs = () => _fxDefs.querySelectorAll(`#${id} feOffset`);
    return t => { const e = _fxEnv(o.on, t, ctx, o.decay ?? 8) * (o.amp ?? 1);
      const [ro, bo] = offs(); if (!ro) return;
      ro.setAttribute('dx', String(e * (o.px ?? 14))); bo.setAttribute('dx', String(-e * (o.px ?? 14)));
      if (!root.style.filter.includes('mkfx')) root.style.filter = e > .02 ? `url(#${id})` : '';
      else if (e <= .02 && root.style.filter === `url(#${id})`) root.style.filter = '';
    };
  },
  // 集中線
  speedlines(root, o, ctx) {
    const e = el(root, { inset: '-200px', zIndex: o.zi ?? 60, pointerEvents: 'none',
      background: `repeating-conic-gradient(from 0deg at 50% 50%, rgba(${o.rgb ?? '255,255,255'},0) 0deg 5deg, rgba(${o.rgb ?? '255,255,255'},.55) 5deg 6.2deg)`,
      WebkitMaskImage: `radial-gradient(circle, transparent ${o.hole ?? 36}%, black ${o.edge ?? 74}%)` });
    return t => { const en = _fxEnv(o.on ?? 'always', t, ctx, o.decay ?? 5) * (o.amp ?? 1);
      e.style.opacity = en * .9; e.style.transform = `rotate(${t * (o.spin ?? 16)}deg)`; };
  },
  // ベタフラッシュ(漫画の放射ベタ) — イベント瞬間だけ出る
  manga_flash(root, o, ctx) {
    const spikes = [];
    const rnd = rng32(o.seed ?? 11);
    let path = '';
    for (let i = 0; i < (o.n ?? 26); i++) { const a0 = (i / (o.n ?? 26)) * 360 + rnd() * 6;
      const a1 = a0 + 2.4 + rnd() * 3.6, R = 1600;
      const x0 = 960 + R * Math.cos(a0 * Math.PI / 180), y0 = 540 + R * Math.sin(a0 * Math.PI / 180);
      const x1 = 960 + R * Math.cos(a1 * Math.PI / 180), y1 = 540 + R * Math.sin(a1 * Math.PI / 180);
      path += `M960 540 L${x0.toFixed(0)} ${y0.toFixed(0)} L${x1.toFixed(0)} ${y1.toFixed(0)} Z `; }
    const e = svgEl(root, W, H, `<path d="${path}" fill="${o.color ?? '#111'}"/>`,
      { inset: 0, zIndex: o.zi ?? 61, pointerEvents: 'none' });
    return t => { const en = _fxEnv(o.on, t, ctx, o.decay ?? 10) * (o.amp ?? 1);
      e.style.opacity = en > .25 ? .95 : 0;
      e.style.transform = `scale(${1 + (1 - Math.min(en, 1)) * .25}) rotate(${Math.floor(t * 18) % 2 ? 3 : 0}deg)`; };
  },
  // 画面シェイク
  shake(root, o, ctx) {
    const r = rng32(o.seed ?? 5);
    const jx = [], jy = []; for (let i = 0; i < 64; i++) { jx.push((r() - .5) * 2); jy.push((r() - .5) * 2); }
    return t => { const e = _fxEnv(o.on, t, ctx, o.decay ?? 9) * (o.amp ?? 1);
      const k = Math.floor(t * 60) % 64;
      root.style.translate = e > .02 ? `${jx[k] * e * (o.px ?? 22)}px ${jy[k] * e * (o.px ?? 22)}px` : ''; };
  },
  // 衝撃波リング
  shockwave(root, o, ctx) {
    const ring = el(root, { left: (o.x ?? 960) + 'px', top: (o.y ?? 540) + 'px', width: '120px', height: '120px',
      margin: '-60px', borderRadius: '50%', zIndex: o.zi ?? 59, pointerEvents: 'none',
      border: `${o.w ?? 16}px solid ${o.color ?? 'rgba(255,255,255,.9)'}` });
    const times = Array.isArray(o.on) ? o.on.map(T) : DBS;
    return t => { let u = 1; for (const tv of times) if (t >= tv) u = Math.min(u, (t - tv) / (o.dur ?? .5));
      ring.style.opacity = u < 1 ? (1 - u) : 0; ring.style.transform = `scale(${1 + outCubic(Math.min(u, 1)) * (o.grow ?? 11)})`; };
  },
  // フィルムグレイン
  grain(root, o, ctx) {
    const id = `mkfx${_fxSeq++}`;
    _fxSvg().innerHTML += `<filter id="${id}"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0.6 0"/></filter>`;
    const e = el(root, { inset: '-80px', zIndex: o.zi ?? 70, pointerEvents: 'none',
      filter: `url(#${id})`, opacity: o.amp ?? .14, mixBlendMode: 'overlay' });
    return t => { const k = Math.floor(t * 24);
      e.style.transform = `translate(${(k * 37) % 60 - 30}px, ${(k * 53) % 60 - 30}px)`; };
  },
  // ビネット明滅
  vignette_pulse(root, o, ctx) {
    const e = el(root, { inset: 0, zIndex: o.zi ?? 58, pointerEvents: 'none',
      background: `radial-gradient(circle, transparent 52%, ${o.color ?? 'rgba(120,10,40,.55)'})` });
    return t => { e.style.opacity = .4 + _fxEnv(o.on ?? 'db', t, ctx, o.decay ?? 5) * .6 * (o.amp ?? 1); };
  },
};
// attach: fxリストをshot rootへ。テンプレupdateの後に呼ぶ更新関数を返す
function fxAttach(root, list, ctx) {
  const ups = (list || []).map(o => (FXS[o.kind] || (() => () => {}))(root, o, ctx)).filter(Boolean);
  return t => ups.forEach(u => u(t));
}

/* templates continue in mad-kit-scenes.js (bespoke: intro/title/peak/breakdown/outro) */
return { K, W, H, PAL, EASE, clamp, lerp, map, rng32, el, img, txt, vid, VIDEO_WAITS, svgEl, starPts, HEART, tag,
  patternBG, PATTERNS, AMBIENTS, confettiLayer, petalLayer, sparkleLayer, floaterLayer,
  nameplate, pill, cardEl, cornerRibbons, dotsRow,
  ENTERS, IDLES, EMPHS, motorize, TEMPLATES, autoEnter, ambientOf, kenburns,
  cameraRig, CAM_PRESETS, FXS, fxAttach,
  BEATS, DBS, db, T, beatAfter, beatPulse, dbPulse, beatsFloat, lastLE,
  stage, scenesRoot, flashEl, lbT, lbB, irisEl, FLASHES, BANDCUTS, flashAt, updateBands, updateFlash };
})();
