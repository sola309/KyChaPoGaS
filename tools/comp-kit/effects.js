// 「重い」エフェクト = まわりの画素を読むもの(ぼかし・光・縁・ずらし)。RT → 新しい RT のパスで掛ける。
// 軽いもの(切る・色)は ops.js にあり、RT を使わない。
// 長さの単位はレイヤーの px(info.res = RT の 1px あたりの倍率を掛けて合わせる)。角度は 0° = 上、時計回り。
import { num, toColor, clamp } from './props.js'
import { THREE } from './gfx.js'

const HEAD = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uRes; varying vec2 vUv;
vec2 P(){ return vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y); }
vec4 S(vec2 p){ return texture2D(tSrc, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)); }
vec3 unpm(vec4 c){ return c.a > 1e-5 ? c.rgb / c.a : vec3(0.0); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float H2(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float VN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(H2(i), H2(i + vec2(1.0, 0.0)), f.x), mix(H2(i + vec2(0.0, 1.0)), H2(i + vec2(1.0, 1.0)), f.x), f.y); }
`
const F = {
  // ガウスぼかし(1 方向)。隣り合う 2 画素を線形補間の 1 回読みでまとめる(中心 + 5 組 × 2 = 11 回読み。半径 10 画素まで)
  blur: HEAD + /* glsl */ `
    uniform vec2 uDir; uniform float uW0; uniform vec4 uOffA, uWA; uniform vec2 uOffB, uWB;
    void main(){
      vec2 p = P();
      vec4 acc = S(p) * uW0;
      acc += (S(p + uDir * uOffA.x) + S(p - uDir * uOffA.x)) * uWA.x;
      acc += (S(p + uDir * uOffA.y) + S(p - uDir * uOffA.y)) * uWA.y;
      acc += (S(p + uDir * uOffA.z) + S(p - uDir * uOffA.z)) * uWA.z;
      acc += (S(p + uDir * uOffA.w) + S(p - uDir * uOffA.w)) * uWA.w;
      acc += (S(p + uDir * uOffB.x) + S(p - uDir * uOffB.x)) * uWB.x;
      gl_FragColor = acc;
    }`,
  // 小さなぼかしを 1 回で(斜め 4 点。各点は線形補間の 1 回読み)。σ = uD 画素にあたる
  blur4: HEAD + /* glsl */ `
    uniform float uD;
    void main(){
      vec2 p = P();
      gl_FragColor = (S(p + vec2(uD, uD)) + S(p + vec2(-uD, uD)) + S(p + vec2(uD, -uD)) + S(p - vec2(uD, uD))) * 0.25;
    }`,
  bright: HEAD + /* glsl */ `
    uniform float uThreshold;
    void main(){
      vec4 c = texture2D(tSrc, vUv);
      float l = luma(unpm(c));
      gl_FragColor = c * smoothstep(uThreshold - 0.05, uThreshold + 0.15, l + 1e-4);
    }`,
  glowAdd: HEAD + /* glsl */ `
    uniform sampler2D tGlow; uniform float uStrength;
    void main(){
      vec4 c = texture2D(tSrc, vUv), g = texture2D(tGlow, vUv) * uStrength;
      vec3 rgb = c.rgb + g.rgb;
      float a = clamp(max(c.a + g.a * (1.0 - c.a), max(rgb.r, max(rgb.g, rgb.b))), 0.0, 1.0);
      gl_FragColor = vec4(min(rgb, vec3(a)), a);
    }`,
  // 拡散光(AviUtl): ぼかした絵との「明るいほう」へ strength ぶん寄せる。平らな色は変わらず、明るい所がまわりへにじむ
  glowDiffuse: HEAD + /* glsl */ `
    uniform sampler2D tGlow; uniform float uStrength;
    void main(){
      vec4 c = texture2D(tSrc, vUv), g = texture2D(tGlow, vUv);
      gl_FragColor = c + clamp(uStrength, 0.0, 1.0) * (max(c, g) - c);
    }`,
  rgb_shift: HEAD + /* glsl */ `
    uniform vec2 uOff;
    void main(){
      vec2 p = P();
      vec4 a = S(p + uOff), b = S(p), c = S(p - uOff);
      gl_FragColor = vec4(a.r, b.g, c.b, max(b.a, max(a.a, c.a)));
    }`,
  wave: HEAD + /* glsl */ `
    uniform float uAmp, uK, uPhase, uVertical;
    void main(){
      vec2 p = P();
      if (uVertical > 0.5) p.y += uAmp * sin(6.2831853 * (p.x * uK + uPhase));
      else p.x += uAmp * sin(6.2831853 * (p.y * uK + uPhase));
      gl_FragColor = S(p);
    }`,
  mosaic: HEAD + /* glsl */ `
    uniform float uSize; uniform vec2 uOrg;
    void main(){ vec2 p = P() - uOrg; gl_FragColor = S((floor(p / uSize) + 0.5) * uSize + uOrg); }`,
  shadow: HEAD + /* glsl */ `
    uniform sampler2D tBlur; uniform vec2 uOff; uniform vec4 uColor;
    void main(){
      vec4 c = texture2D(tSrc, vUv);
      vec2 p = P() - uOff;
      float a = texture2D(tBlur, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)).a * uColor.a;
      gl_FragColor = c + vec4(uColor.rgb * a, a) * (1.0 - c.a);
    }`,
  inner_shadow: HEAD + /* glsl */ `
    uniform sampler2D tBlur; uniform vec2 uOff; uniform vec4 uColor;
    void main(){
      vec4 c = texture2D(tSrc, vUv);
      vec2 p = P() - uOff;
      float k = (1.0 - texture2D(tBlur, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)).a) * uColor.a;
      gl_FragColor = vec4(mix(c.rgb, uColor.rgb * c.a, k), c.a);
    }`,
  // アルファを広げる(uInv = 1 で縮める)。α だけを返す
  dilate: HEAD + /* glsl */ `
    uniform float uWidth, uInv, uTh, uN, uHalf;
    float A(vec2 p){ float a = S(p).a; if (uTh > 0.0) a = smoothstep(uTh - 0.02, uTh + 0.02, a); return uInv > 0.5 ? 1.0 - a : a; }
    void main(){
      vec2 p = P(); float a = A(p);
      float st = 6.2831853 / uN;
      for (float i = 0.0; i < 16.0; i += 1.0){
        if (i >= uN) break;
        float t = i * st; vec2 d = vec2(cos(t), sin(t));
        a = max(a, A(p + d * uWidth));
        if (uHalf > 0.5) a = max(a, A(p + d * uWidth * 0.5));
      }
      gl_FragColor = vec4(uInv > 0.5 ? 1.0 - a : a);
    }`,
  // 縁取りの仕上げ。tOut = 外へ広げた α、tIn = 内へ縮めた α
  outline: HEAD + /* glsl */ `
    uniform sampler2D tOut, tIn; uniform vec4 uColor; uniform float uOnly, uUseIn, uUseOut;
    void main(){
      vec4 c = texture2D(tSrc, vUv);
      float ao = uUseOut > 0.5 ? texture2D(tOut, vUv).a : c.a;
      float ai = uUseIn > 0.5 ? texture2D(tIn, vUv).a : c.a;
      float inner = clamp(c.a - ai, 0.0, 1.0) * uColor.a;
      float outer = clamp(ao - c.a, 0.0, 1.0);
      vec4 base = uOnly > 0.5 ? vec4(0.0) : c;
      base = vec4(mix(base.rgb, uColor.rgb * max(base.a, inner), inner), max(base.a, inner));
      float oa = (uOnly > 0.5 ? outer : ao) * uColor.a;
      gl_FragColor = base + vec4(uColor.rgb * oa, oa) * (1.0 - base.a);
    }`,
  // 細い外側の縁取りを 1 パスで(広げる + 仕上げ。8 方向)。dilate → outline の 2 パスと同じ式
  outline_thin: HEAD + /* glsl */ `
    uniform vec4 uColor; uniform float uOnly, uWidth;
    void main(){
      vec2 p = P(); vec4 c = texture2D(tSrc, vUv); float ao = c.a;
      for (float i = 0.0; i < 8.0; i += 1.0){ float t = i * 0.7853982; ao = max(ao, S(p + vec2(cos(t), sin(t)) * uWidth).a); }
      float outer = clamp(ao - c.a, 0.0, 1.0);
      vec4 base = uOnly > 0.5 ? vec4(0.0) : c;
      float oa = (uOnly > 0.5 ? outer : ao) * uColor.a;
      gl_FragColor = base + vec4(uColor.rgb * oa, oa) * (1.0 - base.a);
    }`,
  trace: HEAD + /* glsl */ `
    uniform sampler2D tOut, tIn; uniform vec4 uColor; uniform float uOnly, uProgress, uStart; uniform vec2 uC, uDash;
    void main(){
      vec4 c = texture2D(tSrc, vUv);
      float band = clamp(texture2D(tOut, vUv).a - texture2D(tIn, vUv).a, 0.0, 1.0);
      vec2 q = P() - uC;
      float t = fract(atan(q.x, -q.y) / 6.2831853 - uStart);
      float k = uProgress >= 1.0 ? 1.0 : uProgress <= 0.0 ? 0.0 : clamp((uProgress - t) * length(q) * 6.2831853 + 0.5, 0.0, 1.0);
      // 破線(uDash = 周期・すき間。1 周 = 1)。fract(t / 周期) × 周期 <= 周期 − すき間 の所だけ描く。境目は 1 画素でならす
      if (uDash.x > 0.0 && uDash.y > 0.0) {
        float u = fract(t / uDash.x) * uDash.x, px = length(q) * 6.2831853;
        k *= clamp((uDash.x - uDash.y - u) * px + 0.5, 0.0, 1.0) * clamp(min(u, uDash.x - u) * px + 0.5, 0.0, 1.0);
      }
      float a = band * k * uColor.a;
      vec4 base = uOnly > 0.5 ? vec4(0.0) : c;
      gl_FragColor = vec4(uColor.rgb * a, a) + base * (1.0 - a);
    }`,
  radial_blur: HEAD + /* glsl */ `
    uniform vec2 uC; uniform float uAmt, uSpin;
    void main(){
      vec2 q = P() - uC; vec4 acc = vec4(0.0);
      for (float i = 0.0; i < 24.0; i += 1.0){
        float t = (i / 23.0 - 0.5) * uAmt;
        vec2 r;
        if (uSpin > 0.5) { float cs = cos(t), sn = sin(t); r = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs); }
        else r = q * (1.0 + t);
        acc += S(uC + r);
      }
      gl_FragColor = acc / 24.0;
    }`,
  halftone: HEAD + /* glsl */ `
    uniform vec2 uC, uCS; uniform float uSize, uMin, uMax, uStagger, uSelf, uUseColor, uInvert; uniform vec4 uFg, uBg;
    void main(){
      vec2 p = P(); vec2 d = p - uC;
      vec2 q = vec2(d.x * uCS.x + d.y * uCS.y, -d.x * uCS.y + d.y * uCS.x) / uSize;
      float row = floor(q.y); float sh = uStagger > 0.5 ? 0.5 * mod(row, 2.0) : 0.0;
      vec2 cell = vec2(floor(q.x + sh) + 0.5 - sh, row + 0.5);
      vec2 cc = cell * uSize; vec2 pc = uC + vec2(cc.x * uCS.x - cc.y * uCS.y, cc.x * uCS.y + cc.y * uCS.x);
      vec4 sc = S(pc); vec4 own = texture2D(tSrc, vUv);
      float dark = 1.0 - luma(unpm(sc)); if (uInvert > 0.5) dark = 1.0 - dark;
      dark *= step(0.004, sc.a);
      float r = mix(uMin, uMax, dark) * 0.7071 * uSize;
      float k = r <= 0.01 ? 0.0 : clamp(0.5 - (length(q - cell) * uSize - r), 0.0, 1.0);
      vec4 fg = uUseColor > 0.5 ? vec4(unpm(sc), 1.0) : uFg;
      vec4 o = mix(vec4(uBg.rgb * uBg.a, uBg.a), vec4(fg.rgb * fg.a, fg.a), k);
      gl_FragColor = o * (uSelf > 0.5 ? own.a : 1.0);
    }`,
  glitch: HEAD + /* glsl */ `
    uniform float uAmt, uBlock, uSeed, uRate, uShift;
    void main(){
      vec2 p = P(); float row = floor(p.y / uBlock);
      float on = step(1.0 - uRate, H2(vec2(row, uSeed + 7.0)));
      float sub = floor(p.x / (uBlock * 6.0));
      float dx = (H2(vec2(row, uSeed)) - 0.5) * 2.0 * uAmt * on;
      float dy = on * step(0.85, H2(vec2(row + sub, uSeed + 3.0))) * (H2(vec2(sub, uSeed + 9.0)) - 0.5) * uBlock * 2.0;
      vec2 o = vec2(dx, dy);
      vec4 a = S(p + o + vec2(uShift * on, 0.0)), b = S(p + o), c = S(p + o - vec2(uShift * on, 0.0));
      gl_FragColor = vec4(a.r, b.g, c.b, max(b.a, max(a.a, c.a)));
    }`,
  smear: HEAD + /* glsl */ `
    uniform vec2 uStep; uniform float uFade, uN;
    void main(){
      vec2 p = P(); float a = 0.0;
      for (float i = 0.0; i <= 32.0; i += 1.0){
        if (i > uN) break;
        a = max(a, S(p - uStep * i).a * (1.0 - uFade * i / max(uN, 1.0)));
      }
      gl_FragColor = vec4(a);
    }`,
  turbulent: HEAD + /* glsl */ `
    uniform float uAmt, uSize, uSeed, uEvo, uOct;
    float fbm(vec2 g){ float n = 0.0, am = 0.5, tot = 0.0; for (int k = 0; k < 4; k++){ if (float(k) >= uOct) break; n += VN(g) * am; tot += am; g = g * 2.03 + 11.7; am *= 0.5; } return n / tot; }
    void main(){
      vec2 p = P(); vec2 g = p / uSize + uSeed * 13.7;
      vec2 d = vec2(fbm(g + vec2(uEvo, 0.0)), fbm(g + vec2(37.2, 17.9 + uEvo))) - 0.5;
      gl_FragColor = S(p + d * 2.0 * uAmt);
    }`,
  feather: HEAD + /* glsl */ `
    uniform sampler2D tBlur;
    void main(){ gl_FragColor = texture2D(tSrc, vUv) * clamp((texture2D(tBlur, vUv).a - 0.5) * 2.0, 0.0, 1.0); }`,
  mirror: HEAD + /* glsl */ `
    uniform vec2 uC, uN;
    void main(){ vec2 p = P(); float d = dot(p - uC, uN); if (d > 0.0) p -= 2.0 * d * uN; gl_FragColor = S(p); }`,
  polar: HEAD + /* glsl */ `
    uniform vec2 uC; uniform float uR, uInvP;
    void main(){
      vec2 p = P(); vec2 q = p - uC;
      if (uInvP > 0.5) { float a = (p.x / uRes.x) * 6.2831853, r = (1.0 - p.y / uRes.y) * uR; gl_FragColor = S(uC + vec2(sin(a), -cos(a)) * r); }
      else { float a = fract(atan(q.x, -q.y) / 6.2831853), r = length(q) / uR; gl_FragColor = r > 1.0 ? vec4(0.0) : S(vec2(a * uRes.x, (1.0 - r) * uRes.y)); }
    }`,
  // 周辺ボケ光量: 中心から離れるほど、ぼかした絵に寄せて暗くする。色ずれは外向きに R と B をずらす
  vblur: HEAD + /* glsl */ `
    uniform sampler2D tBlur; uniform vec2 uC, uInv; uniform float uR, uSoft, uAmt, uShift, uLin, uBri; uniform vec4 uColor;
    vec4 Bl(vec2 p){ return texture2D(tBlur, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)); }
    void main(){
      vec2 p = P(); vec2 q = (p - uC) * uInv;
      float rr = length(q) * 0.70711;
      float k = uLin > 0.5 ? clamp((rr - uR) / (uSoft + 1e-4), 0.0, 1.0) : smoothstep(uR, uR + uSoft + 1e-4, rr);
      vec4 c = texture2D(tSrc, vUv), b = Bl(p);
      if (uShift > 0.0) { vec2 d = normalize(q + 1e-6) * uShift * k; b = vec4(Bl(p - d).r, b.g, Bl(p + d).b, b.a); }
      // brightness: ぼかした側の明るさ(足し算。AviUtl の 光量。0 = そのまま)
      if (uBri != 0.0) b.rgb = clamp(b.rgb + uBri * b.a, 0.0, b.a);
      vec4 o = mix(c, b, k);
      float dk = k * uAmt * uColor.a;
      gl_FragColor = vec4(mix(o.rgb, uColor.rgb * o.a, dk), o.a);
    }`,
  sharpen: HEAD + /* glsl */ `
    uniform float uAmt;
    void main(){ vec2 p = P(); vec4 c = S(p);
      vec4 n = S(p + vec2(1.0, 0.0)) + S(p - vec2(1.0, 0.0)) + S(p + vec2(0.0, 1.0)) + S(p - vec2(0.0, 1.0));
      vec4 o = c + (c * 4.0 - n) * uAmt; gl_FragColor = vec4(clamp(o.rgb, 0.0, c.a), c.a); }`,
  // 極座標変換(項目つき)。uTop = 絵の上の端を中心へ、uClamp = 半径の外は端の色を伸ばす、uHole = 中心の穴、uRot・uSwirl = 回転・渦(1 周 = 1)
  polar2: HEAD + /* glsl */ `
    uniform vec2 uC; uniform vec4 uBox; uniform float uR, uInvP, uHole, uRot, uSwirl, uTop, uClamp;
    void main(){
      vec2 p = P(); vec2 q = p - uC; vec2 bs = uBox.zw - uBox.xy;
      float span = max(uR - uHole, 1e-3);
      if (uInvP > 0.5) {
        vec2 t = (p - uBox.xy) / bs;
        if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) { gl_FragColor = vec4(0.0); return; }
        float v = uTop > 0.5 ? t.y : 1.0 - t.y;
        float a = (t.x + uRot + uSwirl * v) * 6.2831853, r = uHole + v * span;
        gl_FragColor = S(uC + vec2(sin(a), -cos(a)) * r);
      } else {
        float rn = (length(q) - uHole) / span;
        float a = fract(atan(q.x, -q.y) / 6.2831853 - uRot - uSwirl * rn);
        if (rn < 0.0 || (rn > 1.0 && uClamp < 0.5) || p.x < uBox.x || p.y < uBox.y || p.x > uBox.z || p.y > uBox.w) { gl_FragColor = vec4(0.0); return; }
        rn = min(rn, 1.0);
        // 箱の端の半画素は内側へ寄せる(箱の外の透明と混ざらないように)
        vec2 t = vec2(a, uTop > 0.5 ? rn : 1.0 - rn) * bs;
        gl_FragColor = S(uBox.xy + clamp(t, vec2(0.5), bs - 0.5));
      }
    }`,
  // ラフエッジ: 絵をノイズでずらして読み、アルファをしきい値で切り直す(縁がちぎれる・島になる)。uOrg = 箱の左上(模様を箱に固定する)
  rough: HEAD + /* glsl */ `
    uniform vec2 uOrg; uniform float uAmt, uSize, uSeed, uEvo, uOct, uTh, uSoft;
    float fbm(vec2 g){ float n = 0.0, am = 0.5, tot = 0.0; for (int k = 0; k < 4; k++){ if (float(k) >= uOct) break; n += VN(g) * am; tot += am; g = g * 2.03 + 11.7; am *= 0.5; } return n / tot; }
    void main(){
      vec2 p = P(); vec2 g = (p - uOrg) / uSize + uSeed * 13.7;
      vec2 d = vec2(fbm(g + vec2(uEvo, 0.0)), fbm(g + vec2(37.2, 17.9 + uEvo))) - 0.5;
      vec4 c = S(p + d * 2.0 * uAmt);
      if (uTh > 0.0) { float a = smoothstep(uTh - uSoft, uTh + uSoft, c.a); c = c.a > 1e-5 ? vec4(c.rgb / c.a * a, a) : vec4(0.0); }
      gl_FragColor = c;
    }`,
  // ブロックノイズ: 四角い区画を uN 個えらび、その中の絵をずらして読む(あとの区画が上書き)
  blocks: HEAD + /* glsl */ `
    uniform vec2 uOrg, uSz; uniform float uN, uSeed; uniform vec4 uW, uSh;
    void main(){
      vec2 p = P(); vec2 o = vec2(0.0);
      for (float i = 0.0; i < 32.0; i += 1.0){
        if (i >= uN) break;
        vec2 c = uOrg + vec2(H2(vec2(i, uSeed)), H2(vec2(i + 0.5, uSeed + 3.0))) * uSz;
        vec2 hs = 0.5 * vec2(mix(uW.x, uW.y, H2(vec2(i, uSeed + 5.0))), mix(uW.z, uW.w, H2(vec2(i, uSeed + 7.0))));
        vec2 d = abs(p - c);
        if (d.x < hs.x && d.y < hs.y) o = vec2(mix(uSh.x, uSh.y, H2(vec2(i, uSeed + 11.0))), mix(uSh.z, uSh.w, H2(vec2(i, uSeed + 13.0))));
      }
      gl_FragColor = S(p - o);
    }`,
  // レンズフレア: 芯(白)+ にじみ(色)+ 光芒(uRays 本。中心を通る線)+ 輪。元の絵に足す
  flare: HEAD + /* glsl */ `
    uniform vec2 uC; uniform float uR, uLen, uWid, uRays, uAng, uInt, uCore, uRing; uniform vec4 uColor;
    void main(){
      vec4 c = texture2D(tSrc, vUv);
      vec2 q = P() - uC; float r = length(q);
      float core = exp(-r * r / (0.08 * uR * uR + 1e-4)) * uCore;
      float gl = pow(clamp(1.0 - r / (uR * 2.5 + 1e-4), 0.0, 1.0), 2.5) * 0.6;
      float st = 0.0;
      for (float i = 0.0; i < 8.0; i += 1.0){
        if (i >= uRays) break;
        float t = uAng + i * 3.14159265 / max(uRays, 1.0); vec2 d = vec2(sin(t), -cos(t));
        float al = abs(dot(q, d)), ac = abs(q.x * d.y - q.y * d.x);
        float k = clamp(1.0 - al / (uLen + 1e-4), 0.0, 1.0);
        st += exp(-ac / (uWid * (0.25 + 0.75 * k) + 1e-4)) * k * k;
      }
      float ring = uRing > 0.0 ? exp(-pow((r - uR * 1.6) / (uR * 0.12 + 1e-4), 2.0)) * uRing : 0.0;
      vec3 fl = (uColor.rgb * (gl + st + ring) + vec3(core + st * 0.6)) * uInt * uColor.a;
      vec3 rgb = c.rgb + fl;
      float a = clamp(max(c.a, max(rgb.r, max(rgb.g, rgb.b))), 0.0, 1.0);
      gl_FragColor = vec4(min(rgb, vec3(a)), a);
    }`,
  // ガラスの屈折。uKind 0 = レンズ(だ円の中をふくらませて映す)、1 = すりガラス(細かい乱れ)。uAb = 色ごとのずれ、uHl = 映り込みの白、uShade = 縁の暗さ
  refract: HEAD + /* glsl */ `
    uniform vec2 uC, uRad, uOrg; uniform float uKind, uAmt, uAb, uHl, uShade, uSize, uSeed; uniform vec4 uTint;
    void main(){
      vec2 p = P();
      if (uKind > 0.5) {
        vec2 g = (p - uOrg) / uSize + uSeed * 7.3;
        vec2 d = (vec2(VN(g), VN(g + vec2(31.7, 12.3))) - 0.5) * 2.0 * uAmt;
        vec4 a = S(p + d * (1.0 + uAb)), b = S(p + d), c = S(p + d * (1.0 - uAb));
        vec4 o = vec4(a.r, b.g, c.b, b.a);
        gl_FragColor = vec4(mix(o.rgb, uTint.rgb * o.a, uTint.a), o.a);
        return;
      }
      vec2 n = (p - uC) / uRad; float r = length(n);
      vec4 own = texture2D(tSrc, vUv);
      if (r >= 1.0) { gl_FragColor = own; return; }
      float h = sqrt(1.0 - r * r);
      vec2 q = p - uC;
      vec4 a = S(uC + q * (1.0 - uAmt * (1.0 + uAb) * h)), b = S(uC + q * (1.0 - uAmt * h)), c = S(uC + q * (1.0 - uAmt * (1.0 - uAb) * h));
      vec4 o = vec4(a.r, b.g, c.b, max(b.a, max(a.a, c.a)));
      o.rgb = mix(o.rgb, uTint.rgb * o.a, uTint.a);
      o.rgb *= 1.0 - uShade * pow(1.0 - h, 2.0);
      float sp = pow(max(dot(normalize(vec3(n.x, n.y, h)), normalize(vec3(-0.45, -0.6, 0.66))), 0.0), 24.0) * uHl;
      o = vec4(o.rgb + vec3(sp), max(o.a, sp)); o.rgb = min(o.rgb, vec3(o.a));
      float e = clamp((1.0 - r) * min(uRad.x, uRad.y), 0.0, 1.0);
      gl_FragColor = mix(own, o, e);
    }`,
  // 減色(パレット): いちばん近い色に置き換える(RGB の距離)
  palette: HEAD + /* glsl */ `
    uniform vec3 uPal[32]; uniform float uN, uAmt;
    void main(){
      vec4 c = texture2D(tSrc, vUv); vec3 s = unpm(c); float bd = 1e9; vec3 best = s;
      for (int i = 0; i < 32; i++){ if (float(i) >= uN) break; vec3 d = s - uPal[i]; float dd = dot(d, d); if (dd < bd) { bd = dd; best = uPal[i]; } }
      gl_FragColor = vec4(mix(s, best, uAmt) * c.a, c.a);
    }`,
}

const D2R = Math.PI / 180
// ぼかしを縮小して掛け始める σ(画素)。被写界深度は 1 枚ごとに掛かって重いので、早めに縮小する
export const BLUR_THR = 3.5, DOF_THR = 1.2
const dirOf = (deg) => [Math.sin(deg * D2R), -Math.cos(deg * D2R)]
const pct = (v, d) => { const x = num(v, d); return x > 1.0001 ? x / 100 : x } // 0〜1 でも 0〜100 でも受ける
const V2 = () => new THREE.Vector2(), V4 = () => new THREE.Vector4()

// type → はみ出す量(レイヤーの px)。RT の余白を決めるのに使う
const PAD = {
  blur: (p) => num(p.radius, 10) * 1.3 + 1,
  glow: (p) => num(p.radius, 20) * 1.3 + 1,
  rgb_shift: (p) => Math.abs(num(p.amount, 4)) + 1,
  wave: (p) => Math.abs(num(p.amp, 10)) + 1,
  raster: (p) => Math.abs(num(p.amp, 10)) + 1,
  mosaic: () => 0,
  drop_shadow: (p) => (p.x != null || p.y != null ? Math.hypot(num(p.x, 0), num(p.y, 0)) : Math.abs(num(p.distance, 12))) + num(p.blur, 12) * 1.3 + 1,
  inner_shadow: () => 0,
  stroke_outline: (p) => (p.position === 'inner' ? 0 : num(p.width, 4) + num(p.blur ?? p.softness, 0) + 2),
  outline: (p) => (p.position === 'inner' ? 0 : num(p.width ?? p.size, 4) + num(p.blur ?? p.softness, 0) + 2),
  trace_outline: (p) => num(p.width, 8) / 2 + 2,
  directional_blur: (p) => num(p.length, 40) * 0.65 + 1,
  radial_blur: (p, r) => (p.kind === 'spin' || p.mode === 'spin' ? 0 : (Math.abs(num(p.amount, 20)) / 100) * Math.hypot(r.w, r.h) * 0.3),
  halftone: () => 0,
  glitch: (p) => Math.abs(num(p.amount, 40)) + Math.abs(num(p.rgb_shift, 6)) + 1,
  long_shadow: (p) => num(p.length, 100) + 1,
  turbulent_displace: (p) => Math.abs(num(p.amount, 20)) + 1,
  feather: () => 0,
  mirror: () => 0,
  polar: () => 0,
  sharpen: () => 0,
  vignette_blur: () => 0,
  rough_edges: (p) => Math.abs(num(p.amount, 20)) + 1,
  block_noise: (p) => Math.max(...rng(p.shift_x, -30, 30).map(Math.abs), ...rng(p.shift_y, -30, 30).map(Math.abs)) + 1,
  lens_flare: () => 0,
  refract: () => 0,
  palette: () => 0,
}
// [最小, 最大] の組(数 1 個なら ± その数)
function rng(v, a, b) { return Array.isArray(v) ? [num(v[0], a), num(v[1] ?? v[0], b)] : v == null ? [a, b] : [-Math.abs(num(v, 0)), Math.abs(num(v, 0))] }
function rngPos(v, a, b) { return Array.isArray(v) ? [num(v[0], a), num(v[1] ?? v[0], b)] : v == null ? [a, b] : [num(v, a), num(v, a)] }
// まわりの画素だけで決まるパス(あとに続く切り抜きの範囲 + はみ出しぶんだけ描けば、同じ絵になる)
export const LOCAL_PASS = new Set(['blur', 'glow', 'rgb_shift', 'drop_shadow', 'inner_shadow', 'stroke_outline', 'outline', 'directional_blur', 'long_shadow', 'feather', 'sharpen'])
export const isPass = (type) => type in PAD
export const PASS_TYPES = Object.keys(PAD)

export class Effects {
  constructor(gfx) {
    this.g = gfx
    this.mats = {}
    this.v2 = V2()
  }
  mat(name, extra) {
    return (this.mats[name] ??= this.g.passMaterial('fx_' + name, F[name], { tSrc: null, uRes: V2(), ...extra }))
  }
  run1(name, extra, src, values, dstW, dstH) {
    const dst = this.g.acquire(dstW ?? src.width, dstH ?? src.height)
    const m = this.mat(name, extra)
    m.uniforms.uRes.value.set(src.width, src.height)
    this.g.pass(m, dst, { tSrc: src.texture, ...values })
    return dst
  }
  pad(type, p, rect) { const f = PAD[type]; return f ? Math.max(0, f(p, rect) || 0) : 0 }

  // ガウスぼかし。大きい半径は縮小してから掛ける(ソフトウェア GL でも重くならないように)。
  // dir = [x,y] を渡すとその向きだけ
  // keepSmall = 縮小したままの RT を返す(呼び出し側が、小さい RT を引き伸ばして使えるとき)
  // thr = 縮小を始める σ(画素)。小さいほど早く縮小する(被写界深度のぼかしは 1.8、ふつうは 3.5)
  blur(src, radius, dirX = 1, dirY = 1, dir = null, keepSmall = false, thr = BLUR_THR) {
    const g = this.g
    if (!(radius > 0.05)) { const d = g.acquire(src.width, src.height); g.copy(src.texture, d); return d }
    let ds = 1
    while (radius / 2 / ds > thr && ds < 16) ds *= 2
    let cur = src, own = false
    for (let s = 2; s <= ds; s *= 2) {
      const nx = g.acquire(Math.ceil(src.width / s), Math.ceil(src.height / s))
      g.copy(cur.texture, nx)
      if (own) g.release(cur)
      cur = nx; own = true
    }
    const sigma = Math.max(0.3, radius / 2 / ds)
    // 被写界深度の小さなぼかし(縮小しない大きさ): 2 方向 × 11 回読みの代わりに、4 回読みの 1 パスで済ませる
    if (thr < BLUR_THR && ds === 1 && !dir && dirX > 0 && dirY > 0) return this.run1('blur4', { uD: 1 }, src, { uD: sigma })
    // 重み: w(i) = exp(-i²/2σ²)。(1,2)(3,4)…(9,10) を 1 組ずつにまとめ、合計が 1 になるよう割る
    const w = (i) => Math.exp((-0.5 * i * i) / (sigma * sigma))
    const offs = [], ws = []
    let tot = 1
    for (let k = 0; k < 5; k++) {
      const a = w(2 * k + 1), b = w(2 * k + 2), sum = a + b
      offs.push(sum > 1e-12 ? (a * (2 * k + 1) + b * (2 * k + 2)) / sum : 2 * k + 1.5); ws.push(sum); tot += 2 * sum
    }
    const m = this.mat('blur', { uDir: V2(), uW0: 1, uOffA: V4(), uWA: V4(), uOffB: V2(), uWB: V2() })
    m.uniforms.uW0.value = 1 / tot
    m.uniforms.uOffA.value.set(offs[0], offs[1], offs[2], offs[3]); m.uniforms.uWA.value.set(ws[0] / tot, ws[1] / tot, ws[2] / tot, ws[3] / tot)
    m.uniforms.uOffB.value.set(offs[4], 0); m.uniforms.uWB.value.set(ws[4] / tot, 0)
    const step = (x, y) => {
      const a = this.run1('blur', null, cur, { uDir: this.v2.set(x, y) })
      if (own) g.release(cur)
      cur = a; own = true
    }
    if (dir) step(dir[0], dir[1])
    else { if (dirX > 0) step(dirX, 0); if (dirY > 0) step(0, dirY) }
    if (!keepSmall && (cur.width !== src.width || cur.height !== src.height)) {
      const up = g.acquire(src.width, src.height)
      g.copy(cur.texture, up)
      g.release(cur)
      cur = up
    }
    return cur
  }
  // α を w px 広げる(inv で縮める)。太いときは何回かに分ける(角が多角形にならないように)
  dilate(src, w, inv, th = 0) {
    const g = this.g
    // 太い縁は半分の解像度で広げる(33 回読むパスなので、画素数を 1/4 にすると効く。境目は 1px ほど甘くなる)
    const half = w >= 5 && src.width * src.height > 120000
    let cur = src, own = false
    if (half) { cur = g.acquire(Math.ceil(src.width / 2), Math.ceil(src.height / 2)); g.copy(src.texture, cur); own = true; w /= 2 }
    const n = clamp(Math.ceil(w / 10), 1, 6)
    for (let i = 0; i < n; i++) {
      // 細い縁は読む回数を減らす(1〜2 画素なら 8 方向で足りる)
      const ww = w / n
      const nx = this.run1('dilate', { uWidth: 1, uInv: 0, uTh: 0, uN: 16, uHalf: 1 }, cur, { uWidth: ww, uInv: inv ? 1 : 0, uTh: i === 0 ? th : 0, uN: ww <= 2.5 ? 8 : ww <= 6 ? 12 : 16, uHalf: ww <= 2.5 ? 0 : 1 })
      if (own) g.release(cur)
      cur = nx; own = true
    }
    return cur
  }

  // 1 つ掛ける。p = 評価済みの値。src は解放しない。新しい RT を返す(効かないときは null)。
  // info: {res, f, fps, rect:[x0,y0,x1,y1](レイヤーの箱。RT の px)}
  apply(type, p, src, info) {
    const rs = info.res, g = this.g, b = info.rect
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2
    switch (type) {
      case 'blur': {
        const r = num(p.radius, 10) * rs
        if (r < 0.05) return null
        const dir = p.direction // 'h' | 'v' で片方向だけ
        return this.blur(src, r, dir === 'v' ? 0 : 1, dir === 'h' ? 0 : 1, null, !!info.small, p.dof ? DOF_THR : BLUR_THR)
      }
      case 'directional_blur': {
        const r = num(p.length, 40) * rs
        if (r < 0.05) return null
        return this.blur(src, r, 1, 1, dirOf(num(p.angle, 90)))
      }
      case 'glow': {
        if (p.variant === 'diffuse') {
          const bd = this.blur(src, num(p.radius, 20) * rs)
          const od = this.run1('glowDiffuse', { tGlow: null, uStrength: 1 }, src, { tGlow: bd.texture, uStrength: num(p.strength, 1) })
          g.release(bd)
          return od
        }
        const br = this.run1('bright', { uThreshold: 0 }, src, { uThreshold: pct(p.threshold, 0.5) })
        const bl = this.blur(br, num(p.radius, 20) * rs)
        g.release(br)
        const out = this.run1('glowAdd', { tGlow: null, uStrength: 1 }, src, { tGlow: bl.texture, uStrength: num(p.strength, 1) })
        g.release(bl)
        return out
      }
      case 'rgb_shift': {
        const d = dirOf(num(p.angle, 90)), a = num(p.amount, 4) * rs
        return this.run1('rgb_shift', { uOff: V2() }, src, { uOff: this.v2.set(d[0] * a, d[1] * a) })
      }
      case 'wave':
      case 'raster': {
        const vert = p.direction === 'v' || !!p.vertical
        // freq = コンポジションの高さ(縦波は幅)あたりの山の数(v1 と同じ)。wavelength(px)を書けばそちら
        const k = p.wavelength != null ? 1 / Math.max(1, num(p.wavelength, 100) * rs) : num(p.freq, 4) / Math.max(1, (vert ? info.W : info.H) * rs)
        return this.run1('wave', { uAmp: 0, uK: 1, uPhase: 0, uVertical: 0 }, src, {
          uAmp: num(p.amp, 10) * rs, uK: k, uPhase: num(p.speed, 1) * (info.f / info.fps) + num(p.phase, 0) - (vert ? b[0] : b[1]) * k,
          uVertical: vert ? 1 : 0,
        })
      }
      case 'mosaic':
        return this.run1('mosaic', { uSize: 8, uOrg: V2() }, src, { uSize: Math.max(1, num(p.size, 16) * rs), uOrg: this.v2.set(b[0], b[1]) })
      case 'drop_shadow':
      case 'inner_shadow': {
        const inner = type === 'inner_shadow'
        const br = num(p.blur, 12) * rs
        const bl = br > 0.05 ? this.blur(src, br) : null // ぼかさない影は元の絵のアルファをそのまま使う
        let ox, oy
        if (p.x != null || p.y != null) { ox = num(p.x, 0) * rs; oy = num(p.y, 0) * rs }
        else { const d = dirOf(num(p.angle, 135)), dist = num(p.distance, inner ? 6 : 12) * rs; ox = d[0] * dist; oy = d[1] * dist }
        const c = toColor(p.color ?? '#000000'), op = clamp(num(p.opacity, 60) / 100, 0, 1) * c[3]
        const name = inner ? 'inner_shadow' : 'shadow'
        const m = this.mat(name, { tBlur: null, uOff: V2(), uColor: V4() })
        const out = this.run1(name, null, src, { tBlur: (bl || src).texture, uOff: this.v2.set(ox, oy), uColor: m.uniforms.uColor.value.set(c[0], c[1], c[2], op) })
        g.release(bl)
        return out
      }
      case 'stroke_outline':
      case 'outline': {
        const c = toColor(p.color ?? '#000000')
        const w = Math.max(0, num(p.width ?? p.size, 4) * rs)
        if (w <= 0.01) return null
        const pos = p.position || 'outer'
        const soft0 = num(p.blur ?? p.softness, 0) * rs
        if (pos === 'outer' && w <= 2.5 && soft0 <= 1.5) {
          // 細い縁(名札の枠・文字の細い縁など): 1 パスで済ませる
          const m1 = this.mat('outline_thin', { uColor: V4(), uOnly: 0, uWidth: 1 })
          return this.run1('outline_thin', null, src, { uWidth: w, uOnly: p.only || num(p.mix, 100) < 0 ? 1 : 0, uColor: m1.uniforms.uColor.value.set(c[0], c[1], c[2], c[3] * clamp(num(p.opacity, 100) / 100, 0, 1)) })
        }
        const wo = pos === 'inner' ? 0 : pos === 'center' ? w / 2 : w, wi = pos === 'inner' ? w : pos === 'center' ? w / 2 : 0
        let ao = wo > 0 ? this.dilate(src, wo, false) : null
        const ai = wi > 0 ? this.dilate(src, wi, true) : null
        const soft = num(p.blur ?? p.softness, 0) * rs
        if (ao && soft > 1.5) { const t = this.blur(ao, soft); g.release(ao); ao = t }
        const m = this.mat('outline', { tOut: null, tIn: null, uColor: V4(), uOnly: 0, uUseIn: 0, uUseOut: 0 })
        const out = this.run1('outline', null, src, {
          tOut: ao ? ao.texture : src.texture, tIn: ai ? ai.texture : src.texture, uUseOut: ao ? 1 : 0, uUseIn: ai ? 1 : 0, uOnly: p.only || num(p.mix, 100) < 0 ? 1 : 0, // mix < 0(縁取りT の合成量)= 縁だけ
          uColor: m.uniforms.uColor.value.set(c[0], c[1], c[2], c[3] * clamp(num(p.opacity, 100) / 100, 0, 1)),
        })
        g.release(ao); g.release(ai)
        return out
      }
      case 'trace_outline': {
        const c = toColor(p.color ?? '#ffffff')
        const w = Math.max(0.5, (num(p.width, 8) * rs) / 2)
        const th = clamp(num(p.threshold, 128) / 255, 0.02, 0.98)
        const ao = this.dilate(src, w, false, th), ai = this.dilate(src, w, true, th)
        const m = this.mat('trace', { tOut: null, tIn: null, uColor: V4(), uOnly: 0, uProgress: 1, uStart: 0, uC: V2(), uDash: V2() })
        // 破線: dash_period(1 周に対する %)・dash_gap(すき間 %)。書かなければ・0 以下なら実線。すき間 >= 周期なら何も描かない
        const dp = Math.max(0, num(p.dash_period, 0)) / 100, dg = dp > 0 ? clamp(num(p.dash_gap, 0) / 100, 0, dp) : 0
        const out = this.run1('trace', null, src, {
          uDash: m.uniforms.uDash.value.set(dp, dg),
          tOut: ao.texture, tIn: ai.texture, uOnly: p.only_line ? 1 : 0, uProgress: clamp(num(p.progress, 100) / 100, 0, 1),
          uStart: num(p.start, 0) / 100, uC: this.v2.set(cx, cy), uColor: m.uniforms.uColor.value.set(c[0], c[1], c[2], c[3]),
        })
        g.release(ao); g.release(ai)
        return out
      }
      case 'radial_blur': {
        const spin = p.kind === 'spin' || p.mode === 'spin'
        const amt = spin ? num(p.amount, 20) * D2R : num(p.amount, 20) / 100
        if (Math.abs(amt) < 1e-4) return null
        return this.run1('radial_blur', { uC: V2(), uAmt: 0, uSpin: 0 }, src, { uC: this.v2.set(cx + num(p.cx, 0) * rs, cy + num(p.cy, 0) * rs), uAmt: amt, uSpin: spin ? 1 : 0 })
      }
      case 'halftone': {
        const a = num(p.angle, 45) * D2R
        const fg = toColor(p.fg ?? p.color ?? '#000000'), bg = toColor(p.bg ?? '#ffffff00', [1, 1, 1, 0])
        const m = this.mat('halftone', { uC: V2(), uCS: V2(), uSize: 8, uMin: 0, uMax: 1, uStagger: 0, uSelf: 1, uUseColor: 0, uInvert: 0, uFg: V4(), uBg: V4() })
        m.uniforms.uCS.value.set(Math.cos(a), Math.sin(a))
        m.uniforms.uBg.value.set(bg[0], bg[1], bg[2], bg[3])
        return this.run1('halftone', null, src, {
          uC: this.v2.set(cx, cy), uSize: Math.max(2, num(p.size, 8) * rs), uMin: num(p.min, 0) / 100, uMax: num(p.max, 100) / 100,
          uStagger: p.stagger ? 1 : 0, uSelf: p.self_mask === false ? 0 : 1, uUseColor: p.use_color ? 1 : 0, uInvert: p.invert ? 1 : 0,
          uFg: m.uniforms.uFg.value.set(fg[0], fg[1], fg[2], fg[3]),
        })
      }
      case 'glitch': {
        const sp = num(p.speed, info.fps)
        return this.run1('glitch', { uAmt: 0, uBlock: 8, uSeed: 0, uRate: 0.3, uShift: 0 }, src, {
          uAmt: num(p.amount, 40) * rs, uBlock: Math.max(1, num(p.block, 24) * rs), uSeed: num(p.seed, 1) * 31 + Math.floor((info.f / info.fps) * sp + 1e-6),
          uRate: clamp(num(p.rate, 35) / 100, 0, 1), uShift: num(p.rgb_shift, 6) * rs,
        })
      }
      case 'long_shadow': {
        const len = Math.max(0, num(p.length, 100) * rs)
        if (len < 0.5) return null
        const d = dirOf(num(p.angle, 135))
        const ex = { uStep: V2(), uFade: 0, uN: 32 }
        const stepPx = len / 32
        let mask = src
        if (stepPx > 1) mask = this.run1('smear', ex, src, { uStep: this.v2.set((d[0] * stepPx) / 8, (d[1] * stepPx) / 8), uFade: 0, uN: 8 })
        const m2 = this.run1('smear', ex, mask, { uStep: this.v2.set(d[0] * stepPx, d[1] * stepPx), uFade: clamp(num(p.fade, 0) / 100, 0, 1), uN: 32 })
        if (mask !== src) g.release(mask)
        const c = toColor(p.color ?? '#000000'), op = clamp(num(p.opacity, 50) / 100, 0, 1) * c[3]
        const m = this.mat('shadow', { tBlur: null, uOff: V2(), uColor: V4() })
        const out = this.run1('shadow', null, src, { tBlur: m2.texture, uOff: this.v2.set(0, 0), uColor: m.uniforms.uColor.value.set(c[0], c[1], c[2], op) })
        g.release(m2)
        return out
      }
      case 'turbulent_displace':
        return this.run1('turbulent', { uAmt: 0, uSize: 100, uSeed: 0, uEvo: 0, uOct: 2 }, src, {
          uAmt: num(p.amount, 20) * rs, uSize: Math.max(1, num(p.size, 100) * rs), uSeed: num(p.seed, 1), uEvo: num(p.evolution, 0), uOct: clamp(Math.round(num(p.octaves, 2)), 1, 4),
        })
      case 'feather': {
        const r = num(p.radius, 10) * rs
        if (r < 0.2) return null
        const bl = this.blur(src, r)
        const out = this.run1('feather', { tBlur: null }, src, { tBlur: bl.texture })
        g.release(bl)
        return out
      }
      case 'mirror': {
        const n = dirOf(num(p.angle, 90))
        const m = this.mat('mirror', { uC: V2(), uN: V2() })
        m.uniforms.uN.value.set(n[0], n[1])
        return this.run1('mirror', null, src, { uC: this.v2.set(cx + num(p.cx, 0) * rs, cy + num(p.cy, 0) * rs) })
      }
      case 'polar': {
        // 項目つき(fit / inner / center_width / scale / rotation / swirl / cx / cy / clamp のどれかを書いたとき)。書かなければ下の、今までどおりの式
        if (p.fit != null || p.inner != null || p.center_width != null || p.scale != null || p.rotation != null || p.swirl != null || p.cx != null || p.cy != null || p.clamp != null) {
          const bw = b[2] - b[0], bh = b[3] - b[1]
          const R0 = p.fit === 'cover' ? Math.hypot(bw, bh) / 2 : p.fit === 'width' ? bw / 2 : p.fit === 'height' ? bh / 2 : Math.min(bw, bh) / 2
          const m = this.mat('polar2', { uC: V2(), uBox: V4(), uR: 1, uInvP: 0, uHole: 0, uRot: 0, uSwirl: 0, uTop: 0, uClamp: 0 })
          m.uniforms.uBox.value.set(b[0], b[1], b[2], b[3])
          return this.run1('polar2', null, src, {
            uC: this.v2.set(cx + num(p.cx, 0) * rs, cy + num(p.cy, 0) * rs), uR: Math.max(1, (R0 * num(p.scale, 100)) / 100), uInvP: p.invert ? 1 : 0,
            uHole: Math.max(0, num(p.center_width, 0)) * rs, uRot: num(p.rotation, 0) / 360, uSwirl: num(p.swirl, 0) / 360, uTop: p.inner === 'top' ? 1 : 0, uClamp: p.fit === 'cover' || p.clamp ? 1 : 0,
          })
        }
        return this.run1('polar', { uC: V2(), uR: 1, uInvP: 0 }, src, { uC: this.v2.set(cx, cy), uR: Math.max(1, Math.min(b[2] - b[0], b[3] - b[1]) / 2), uInvP: p.invert ? 1 : 0 })
      }
      case 'vignette_blur': {
        // amount = 周辺の暗さ %、blur = 周辺のぼかし px、radius = 効き始める位置(%。箱の対角の半分が 100)、softness = 効ききるまでの幅 %
        // shape: 'box'(既定。箱の縦横比のだ円)/ 'circle'(正円。どの向きにも同じ距離)。ramp: 'smooth'(既定)/ 'linear'
        // brightness: 周辺(ぼかした側)の明るさ %。100 = そのまま、100 より上で明るく(色調補正の 明るさ と同じ足し算)
        const br = Math.max(0, num(p.blur, 8)) * rs
        const bl = br > 0.05 ? this.blur(src, br) : null
        const c = toColor(p.color ?? '#000000')
        const m = this.mat('vblur', { tBlur: null, uC: V2(), uInv: V2(), uR: 0.5, uSoft: 0.5, uAmt: 0.5, uShift: 0, uLin: 0, uBri: 0, uColor: V4() })
        const bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1])
        if (p.shape === 'circle') { const k = 2 / (Math.hypot(bw, bh) * 0.70711); m.uniforms.uInv.value.set(k, k) }
        else m.uniforms.uInv.value.set(2 / bw, 2 / bh)
        const out = this.run1('vblur', null, src, {
          tBlur: (bl || src).texture, uC: this.v2.set(cx + num(p.cx, 0) * rs, cy + num(p.cy, 0) * rs),
          uR: clamp(num(p.radius, 50) / 100, 0, 2), uSoft: Math.max(0, num(p.softness, 50)) / 100, uAmt: clamp(num(p.amount, 60) / 100, 0, 1),
          uShift: Math.max(0, num(p.color_shift, 0)) * rs, uLin: p.ramp === 'linear' ? 1 : 0, uBri: (num(p.brightness, 100) - 100) / 100, uColor: m.uniforms.uColor.value.set(c[0], c[1], c[2], c[3]),
        })
        g.release(bl)
        return out
      }
      case 'sharpen':
        return this.run1('sharpen', { uAmt: 0 }, src, { uAmt: num(p.amount, 50) / 100 })
      case 'rough_edges': {
        // amount = ずらす量 px、size = ノイズの大きさ px、threshold = アルファを切り直す位置 %(0 = 切り直さない)、softness = 切り口のやわらかさ %
        const amt = num(p.amount, 20) * rs
        if (Math.abs(amt) < 0.01 && !(num(p.threshold, 50) > 0)) return null
        return this.run1('rough', { uOrg: V2(), uAmt: 0, uSize: 100, uSeed: 0, uEvo: 0, uOct: 2, uTh: 0, uSoft: 0.05 }, src, {
          uOrg: this.v2.set(b[0], b[1]), uAmt: amt, uSize: Math.max(1, num(p.size, 60) * rs), uSeed: num(p.seed, 0), uEvo: num(p.evolution, 0),
          uOct: clamp(Math.round(num(p.octaves, 3)), 1, 4), uTh: clamp(num(p.threshold, 50) / 100, 0, 0.98), uSoft: clamp(num(p.softness, 5) / 100, 0.002, 0.5),
        })
      }
      case 'block_noise': {
        // count = 区画の数([最小, 最大] なら、切り替わるたびに乱数で決める)、width / height = 区画の大きさ px、shift_x / shift_y = ずらす量 px(どれも [最小, 最大])
        // speed = 1 秒あたりの切り替え回数(0 = 止める)、amount = 効く割合 %(区画の数に掛ける)
        const sp = num(p.speed, info.fps), tick = sp > 0 ? Math.floor((info.f / info.fps) * sp + 1e-6) : 0
        const seed = ((Math.round(num(p.seed, 1)) * 31 + tick * 17) % 4096 + 4096) % 4096
        const cn = rngPos(p.count, 5, 15), w = rngPos(p.width, 300, 500), h = rngPos(p.height, 10, 100), sx = rng(p.shift_x, -30, 30), sy = rng(p.shift_y, -30, 30)
        const n = Math.round((cn[0] + (cn[1] - cn[0]) * (((seed * 2654435761) >>> 0) / 4294967296)) * clamp(num(p.amount, 100) / 100, 0, 1))
        if (n <= 0) return null
        const m = this.mat('blocks', { uOrg: V2(), uSz: V2(), uN: 0, uSeed: 0, uW: V4(), uSh: V4() })
        m.uniforms.uSz.value.set(b[2] - b[0], b[3] - b[1])
        m.uniforms.uW.value.set(w[0] * rs, w[1] * rs, h[0] * rs, h[1] * rs)
        m.uniforms.uSh.value.set(sx[0] * rs, sx[1] * rs, sy[0] * rs, sy[1] * rs)
        return this.run1('blocks', null, src, { uOrg: this.v2.set(b[0], b[1]), uN: Math.min(32, n), uSeed: seed })
      }
      case 'lens_flare': {
        // 箱の中心 + (cx, cy) に光を足す。radius = にじみの半径 px、streak_length = 光芒の長さ px(中心から片側)、streak_width = 光芒の太さ px、rays = 光芒の本数(中心を通る線の数。0 = なし)
        const c = toColor(p.color ?? '#9999ff')
        let it = num(p.intensity, 100) / 100
        const fl = clamp(num(p.flicker, 0) / 100, 0, 1)
        if (fl > 0) it *= 1 - fl * (((Math.imul(Math.floor(info.f) + 1, 2654435761) >>> 0) % 1000) / 1000)
        if (it <= 0) return null
        const m = this.mat('flare', { uC: V2(), uR: 1, uLen: 1, uWid: 1, uRays: 1, uAng: 0, uInt: 1, uCore: 1, uRing: 0, uColor: V4() })
        return this.run1('flare', null, src, {
          uC: this.v2.set(cx + num(p.cx, 0) * rs, cy + num(p.cy, 0) * rs), uR: Math.max(0.5, num(p.radius, 100) * rs), uLen: Math.max(0, num(p.streak_length, 600) * rs),
          uWid: Math.max(0.2, num(p.streak_width, 6) * rs), uRays: clamp(Math.round(num(p.rays, 1)), 0, 8), uAng: (num(p.angle, 90) + num(p.spin, 0) * (info.f / info.fps)) * D2R, uInt: it,
          uCore: clamp(num(p.core, 100) / 100, 0, 4), uRing: clamp(num(p.ring, 0) / 100, 0, 2), uColor: m.uniforms.uColor.value.set(c[0], c[1], c[2], c[3]),
        })
      }
      case 'refract': {
        // kind: 'lens'(既定。だ円の中をふくらませて映す)/ 'frost'(すりガラス)。調整レイヤーに掛けると、下の絵がゆがんで映る
        // lens: radius(px。書かなければ箱いっぱいのだ円)・amount(ふくらみ %。正 = 拡大、負 = 縮小)・aberration(色ずれ %)・highlight(映り込み %)・shade(縁の暗さ %)
        // frost: amount(乱れ px)・size(乱れの大きさ px)・seed
        const frost = p.kind === 'frost'
        const t = toColor(p.tint ?? '#ffffff'), ta = clamp(num(p.tint_amount, 0) / 100, 0, 1)
        const m = this.mat('refract', { uC: V2(), uRad: V2(), uOrg: V2(), uKind: 0, uAmt: 0, uAb: 0, uHl: 0, uShade: 0, uSize: 8, uSeed: 0, uTint: V4() })
        const rx = p.radius != null ? num(p.radius, 100) * rs : (b[2] - b[0]) / 2, ry = p.radius != null ? num(p.radius_y ?? p.radius, 100) * rs : (b[3] - b[1]) / 2
        m.uniforms.uRad.value.set(Math.max(1, rx), Math.max(1, ry))
        m.uniforms.uOrg.value.set(b[0], b[1])
        return this.run1('refract', null, src, {
          uC: this.v2.set(cx + num(p.cx, 0) * rs, cy + num(p.cy, 0) * rs), uKind: frost ? 1 : 0, uAmt: frost ? num(p.amount, 8) * rs : clamp(num(p.amount, 35) / 100, -3, 0.95),
          uAb: clamp(num(p.aberration, 0) / 100, 0, 1), uHl: clamp(num(p.highlight, 0) / 100, 0, 2), uShade: clamp(num(p.shade, 0) / 100, 0, 1), uSize: Math.max(0.5, num(p.size, 6) * rs), uSeed: num(p.seed, 1),
          uTint: m.uniforms.uTint.value.set(t[0], t[1], t[2], ta),
        })
      }
      case 'palette': {
        // colors = 使う色(2〜32 色)。いちばん近い色に置き換える。amount = 強さ %
        const cols = Array.isArray(p.colors) ? p.colors.slice(0, 32) : []
        if (cols.length < 1) return null
        const m = this.mat('palette', { uPal: Array.from({ length: 32 }, () => new THREE.Vector3()), uN: 0, uAmt: 1 })
        cols.forEach((v, i) => { const c = toColor(v); m.uniforms.uPal.value[i].set(c[0], c[1], c[2]) })
        return this.run1('palette', null, src, { uN: cols.length, uAmt: clamp(num(p.amount, 100) / 100, 0, 1) })
      }
    }
    return null
  }
}
