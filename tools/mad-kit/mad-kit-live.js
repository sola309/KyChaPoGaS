// mad-kit-live.js — in-browser player + object picking for the Shot Editor.
// Loaded only when kycha.live is true (never during headless renders).
//
// postMessage protocol (parent ⇄ iframe):
//   → {mk:'seek', t}                 seek to absolute seconds
//   → {mk:'play', from, to, loop}    play range (loop within it)
//   → {mk:'pause'}
//   → {mk:'select', path}            highlight an object programmatically
//   → {mk:'shotlist', shotlist}      hot-swap the shotlist and recompile
//   ← {mk:'pick',  path, label, rect}    user clicked a tagged object
//   ← {mk:'drag',  path, dx, dy}         user dragged a tagged object (stage px)
//   ← {mk:'time',  t, playing}           ~10Hz while playing
//   ← {mk:'ready'}
'use strict';
(() => {
if (!window.kycha.live) return;
const M = window.MK;

// ---- style for pick highlights ----
const st = document.createElement('style');
st.textContent = `
  /* only tagged objects are clickable — particles/overlays never steal hits */
  #stage, #stage * { pointer-events: none; }
  #stage [data-mk] { pointer-events: auto; }
  #stage [data-mk]:hover { outline: 3px dashed rgba(63,160,208,.9); outline-offset: 2px; cursor: pointer; }
  #stage [data-mk].mk-selected { outline: 4px solid rgba(232,68,110,.95); outline-offset: 2px; }
`;
document.head.appendChild(st);

// ---- player ----
let playing = false, t = 0, rangeFrom = 0, rangeTo = window.kycha.duration, looping = true;
let last = null, raf = null;
function tick(now) {
  if (playing) {
    if (last != null) t += (now - last) / 1000;
    if (t >= rangeTo) t = looping ? rangeFrom : rangeTo;
  }
  last = now;
  window.seek(t * 1000);
  raf = requestAnimationFrame(tick);
}
setInterval(() => parent.postMessage({ mk: 'time', t, playing }, '*'), 100);

// ---- picking / dragging ----
let selected = null;
function select(el) {
  document.querySelectorAll('.mk-selected').forEach(e => e.classList.remove('mk-selected'));
  selected = el;
  if (el) el.classList.add('mk-selected');
}
let drag = null;
document.addEventListener('mousedown', e => {
  const el = e.target.closest('[data-mk]');
  if (!el) return;
  const zoom = parseFloat(document.body.style.zoom || 1);
  drag = { el, path: el.dataset.mk, x0: e.clientX / zoom, y0: e.clientY / zoom, moved: false };
  e.preventDefault();
}, true);
document.addEventListener('mousemove', e => {
  if (!drag) return;
  const zoom = parseFloat(document.body.style.zoom || 1);
  const dx = e.clientX / zoom - drag.x0, dy = e.clientY / zoom - drag.y0;
  if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
  if (drag.moved) drag.el.style.translate = `${dx}px ${dy}px`;  // live ghost (composes with transform)
});
document.addEventListener('mouseup', e => {
  if (!drag) return;
  const zoom = parseFloat(document.body.style.zoom || 1);
  const dx = e.clientX / zoom - drag.x0, dy = e.clientY / zoom - drag.y0;
  drag.el.style.translate = '';
  if (drag.moved) {
    parent.postMessage({ mk: 'drag', path: drag.path, dx: Math.round(dx), dy: Math.round(dy) }, '*');
  } else {
    select(drag.el);
    const r = drag.el.getBoundingClientRect();
    parent.postMessage({ mk: 'pick', path: drag.path, label: drag.el.dataset.mkLabel || drag.path,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height } }, '*');
  }
  drag = null;
});

// ---- messages ----
window.addEventListener('message', ev => {
  const m = ev.data || {};
  if (m.mk === 'seek') { t = m.t; playing = false; }
  else if (m.mk === 'play') { rangeFrom = m.from ?? 0; rangeTo = m.to ?? window.kycha.duration;
    looping = m.loop !== false; if (t < rangeFrom || t >= rangeTo) t = rangeFrom; playing = true; }
  else if (m.mk === 'pause') playing = false;
  else if (m.mk === 'select') { const el = document.querySelector(`[data-mk="${m.path}"]`); select(el); }
  else if (m.mk === 'shotlist') {
    window.kycha.shotlist = m.shotlist;
    M.recompile(m.shotlist);
    select(null);
  }
});

// dark letterbox + vertical centering inside the editor iframe
document.documentElement.style.background = document.body.style.background = '#0a0a0a';
function center() { const z = window.innerWidth / 1920;
  document.body.style.zoom = z;
  M.stage.style.top = Math.max(0, (window.innerHeight / z - 1080) / 2) + 'px'; }
center(); window.addEventListener('resize', center);

raf = requestAnimationFrame(tick);
parent.postMessage({ mk: 'ready' }, '*');
})();
