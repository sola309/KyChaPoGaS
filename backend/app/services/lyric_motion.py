"""
自動リリックモーション (kinetic typography) — HTML template.

The template is data-driven: at render time the MG pipeline injects
`window.kycha = {bpm, beats[], downbeats[], lyrics, duration, offset}` (the
project's REAL beat grid + the song lyrics). The page distributes the lyric
lines across the song proportionally, snaps each line/word onset to the nearest
beat, and animates the words with `window.seek(t_ms)` so the capture is
frame-exact.

No forced phoneme alignment (impossible for arbitrary vocals); instead lines
are spread evenly across the track and words pop on the beats inside each
line's span — the rhythmic, MAD-friendly approach.

Styles:
  pop      — words scale-pop in with a crimson glow (default)
  slide    — words slide up from below
  karaoke  — whole line shown, color sweeps word-by-word on the beat
  typewriter — characters appear one per beat
"""

STYLES = ("pop", "slide", "karaoke", "typewriter")


def build_lyric_motion_html(style: str = "pop") -> str:
    if style not in STYLES:
        style = "pop"
    style_js = style.upper()
    # Note: doubled braces escape Python str.format; we are NOT using .format,
    # this is a plain f-string only for STYLE — everything else is literal JS/CSS.
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'><style>"
        "html,body{margin:0;width:100%;height:100%;overflow:hidden;"
        "font-family:'Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif}"
        "#stage{position:absolute;inset:0;display:flex;align-items:flex-end;"
        "justify-content:center;padding-bottom:8%}"
        ".line{display:flex;gap:.32em;font-weight:900;white-space:nowrap}"
        ".w{color:#fff;-webkit-text-stroke:3px #7e1a31;paint-order:stroke fill;"
        "display:inline-block;transform-origin:center bottom;will-change:transform,opacity}"
        "</style></head><body><div id='stage'></div><script>\n"
        f"const STYLE='{style_js}';\n"
        + _SCRIPT +
        "</script></body></html>"
    )


_SCRIPT = r"""
const K = window.kycha || {beats:[],downbeats:[],lyrics:'',duration:30,bpm:120};
const DUR = K.duration || 30;
const stage = document.getElementById('stage');

// ── parse lyric lines (drop [section] tags / blanks) ─────────────────────────
const lines = String(K.lyrics||'').split('\n').map(s=>s.trim())
  .filter(s => s && !/^\[.*\]$/.test(s));

// ── beats covering [0, DUR] (synth from bpm if analysis missing) ─────────────
let beats = (K.beats && K.beats.length) ? K.beats.slice().sort((a,b)=>a-b) : [];
if (!beats.length) {
  const dt = 60 / (K.bpm || 120);
  for (let t=0; t<DUR; t+=dt) beats.push(t);
}
const nearestBeat = (t) => {
  let best=t, bd=1e9;
  for (const b of beats){ const d=Math.abs(b-t); if(d<bd){bd=d;best=b;} }
  return best;
};

// split a line into tokens (space-separated bunsetsu; long unspaced runs → ~3char chunks)
function tokenize(line){
  const parts = line.split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of parts){
    if (p.length <= 6) { out.push(p); continue; }
    for (let i=0;i<p.length;i+=3) out.push(p.slice(i, i+3));
  }
  return out;
}

// ── assign each line a [t0,t1) span (proportional, snapped to beats) ─────────
const L = Math.max(1, lines.length);
const lineSpans = lines.map((ln, i) => {
  const t0 = nearestBeat(i / L * DUR);
  const t1 = (i+1 < L) ? nearestBeat((i+1) / L * DUR) : DUR;
  const words = tokenize(ln);
  const inner = beats.filter(b => b >= t0 && b < t1);
  const wordTimes = words.map((w, wi) => {
    let wt;
    if (inner.length >= words.length && words.length > 0) {
      wt = inner[Math.floor(wi * inner.length / words.length)];
    } else {
      wt = t0 + (wi / Math.max(1, words.length)) * (t1 - t0);
    }
    return { w, t: wt };
  });
  return { text: ln, t0, t1, words: wordTimes };
});

// responsive font size so long lines fit ~1180px
function fontPx(text){
  return Math.max(34, Math.min(78, Math.floor(1180 / Math.max(7, text.length * 0.92))));
}
const easeOut = (x) => 1 - Math.pow(1 - x, 3);

// ── per-frame render ─────────────────────────────────────────────────────────
window.seek = (tms) => {
  const t = tms / 1000;
  let li = -1;
  for (let i=0;i<lineSpans.length;i++){
    if (t >= lineSpans[i].t0 && t < lineSpans[i].t1){ li = i; break; }
  }
  stage.innerHTML = '';
  if (li < 0) return;
  const line = lineSpans[li];
  const div = document.createElement('div');
  div.className = 'line';
  div.style.fontSize = fontPx(line.text) + 'px';
  const fadeIn  = Math.min(1, (t - line.t0) / 0.12);
  const fadeOut = Math.min(1, (line.t1 - t) / 0.25);
  div.style.opacity = String(Math.max(0, Math.min(fadeIn, fadeOut)));

  for (const wd of line.words){
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = wd.w;
    const age = t - wd.t;       // seconds since this word's beat

    if (STYLE === 'POP'){
      if (age < 0){ span.style.opacity='0'; }
      else {
        const k = Math.min(1, age/0.18);
        const scale = 2.2 - 1.2*easeOut(k);
        span.style.transform = 'scale('+scale.toFixed(3)+')';
        span.style.opacity = String(Math.min(1, age/0.06));
        const glow = Math.max(0, 1 - age/0.45);
        span.style.textShadow = '0 0 '+(8+glow*34).toFixed(0)+'px rgba(214,64,93,'+(0.4+glow*0.6).toFixed(2)+')';
        span.style.color = glow>0.3 ? '#fff' : '#f6c2cb';
      }
    } else if (STYLE === 'SLIDE'){
      if (age < 0){ span.style.opacity='0'; span.style.transform='translateY(46px)'; }
      else {
        const k = easeOut(Math.min(1, age/0.26));
        span.style.transform = 'translateY('+(46*(1-k)).toFixed(1)+'px)';
        span.style.opacity = String(Math.min(1, age/0.14));
        const glow = Math.max(0, 1 - age/0.5);
        span.style.textShadow = '0 4px '+(10+glow*22).toFixed(0)+'px rgba(0,0,0,.6),0 0 '+(glow*26).toFixed(0)+'px rgba(214,64,93,'+glow.toFixed(2)+')';
        span.style.color = glow>0.35 ? '#fff' : '#f6c2cb';
      }
    } else if (STYLE === 'KARAOKE'){
      // whole line visible from line start; color sweeps as each beat passes
      span.style.opacity = '1';
      if (age >= 0){
        const glow = Math.max(0, 1 - age/0.35);
        span.style.color = '#f6c2cb';
        span.style.textShadow = '0 0 '+(6+glow*30).toFixed(0)+'px rgba(214,64,93,'+(0.35+glow*0.55).toFixed(2)+')';
        const k = Math.min(1, age/0.14);
        span.style.transform = 'scale('+(1 + 0.12*(1-k)).toFixed(3)+')';
      } else {
        span.style.color = 'rgba(255,255,255,0.5)';
        span.style.textShadow = '0 2px 8px rgba(0,0,0,.55)';
      }
    } else { // TYPEWRITER
      if (age < 0){ span.style.opacity='0'; span.style.transform='scale(.6)'; }
      else {
        span.style.opacity='1';
        const k = Math.min(1, age/0.1);
        span.style.transform = 'scale('+(0.6+0.4*easeOut(k)).toFixed(3)+')';
        const glow = Math.max(0, 1 - age/0.3);
        span.style.textShadow = '0 0 '+(6+glow*20).toFixed(0)+'px rgba(214,64,93,'+(0.4+glow*0.5).toFixed(2)+')';
      }
    }
    div.appendChild(span);
  }
  stage.appendChild(div);
};
"""
