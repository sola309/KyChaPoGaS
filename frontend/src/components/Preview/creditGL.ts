/**
 * 🔤 字幕のプレビュー描画(WebGL2)。式は設計書 §5.2 = backend credit_fx.compose_rgb(書き出しの正)と同じ。
 *
 *   apply(ctx, src, box, use, sc): 2D キャンバス src(= ここまでに合成した下の絵)を GPU に上げ、字幕の地図の範囲だけ
 *   1 回のフラグメントパスで「屈折した下の絵 + ガラス + 光 + きらめき」を計算して、ctx の同じ場所へ描き戻す。
 *   地図の外の画素は触らない。失敗(WebGL2 なし・コンテキスト喪失・シェーダの失敗)は false を返すだけで投げない
 *   → 呼び手は絵をそのまま残す。
 *
 *   - 地図(7 枚の RGBA float32)は地図のキーごとに 1 回だけ上げる(8 枚の字幕ぶんまで覚える)。読むのは texelFetch だけ
 *     (フィルタなし = 拡張なしで RGBA32F が使える。下の絵の双線形補間も texelFetch 4 回で自分でする = numpy と同じ)。
 *   - 下の絵は RGBA8 のまま上げる(上下反転なし・色空間の変換なし・アルファの掛け算なし)。値は 0..255 で計算する。
 *   - 描いた結果は既定のフレームバッファの左下 W×H。2D へは変換なし・補間なしで写す。
 */
import { type CreditScalars, MAX_LABELS, MAX_GLINTS } from './creditLook'
import type { CreditMaps, CreditMapsUse } from './creditFields'

export interface RectPx { x: number; y: number; w: number; h: number }

const MAX_MAPS = 8
const U_PIC = 0, U_T0 = 1                 // 地図は U_T0..U_T0+6
const U_SCRATCH = 9

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uPic;        // 2D キャンバス全体(RGBA8、行 0 = 上)
uniform sampler2D uT0;         // M, HN, ABSn, RIM
uniform sampler2D uT1;         // TX, TY, LX, LY
uniform sampler2D uT2;         // NC rgb, NA
uniform sampler2D uT3;         // RP rgb, RA
uniform sampler2D uT4;         // OO rgb, OA
uniform sampler2D uT5;         // HL, core, spec, 0
uniform sampler2D uT6;         // l1, w1, l2, w2
uniform int uH;                // 地図の高さ(既定のフレームバッファは下から数えるので反転に使う)
uniform ivec2 uBoxOff;         // 枠の左上(キャンバスの px)
uniform ivec2 uBoxSize;        // 枠の大きさ bw, bh
uniform ivec2 uOrg;            // 地図の左上(枠の px)= x0 + dx, y0 + dy
uniform vec2 uC;               // ズームの中心 cx, cy(地図の画素の番号)
uniform float uTube;
uniform float uLetter;
uniform float uZoom;
uniform vec3 uKc;              // kR, kG, kB
uniform float uAbsw;
uniform float uFresw;
uniform float uF0;
uniform vec3 uFresRgb;
uniform float uHlw;
uniform float uFac[${MAX_LABELS}];
uniform int uSheenOn;
uniform vec4 uSheenP;          // pos, yc, bw, amp
uniform float uSheen;
uniform float uS;
uniform float uFillQ;
uniform float uG;
uniform int uNG;
uniform vec3 uGl[${MAX_GLINTS}];   // gx, gy, inten
uniform float uStarR;
uniform float uKs;             // k(枠 / 2560)
uniform float uO;
out vec4 o;

vec3 pix(ivec2 b) { return texelFetch(uPic, b + uBoxOff, 0).rgb; }
// 双線形(座標は枠の [0, bw-1] × [0, bh-1] に収める)。numpy credit_fx の bilin と同じ
vec3 bil(vec2 q) {
  vec2 mx = vec2(uBoxSize - ivec2(1));
  q = clamp(q, vec2(0.0), mx);
  vec2 f0 = floor(q);
  ivec2 i0 = ivec2(f0);
  ivec2 i1 = min(i0 + ivec2(1), uBoxSize - ivec2(1));
  vec2 fr = q - f0;
  vec3 a = pix(i0);
  vec3 b = pix(ivec2(i1.x, i0.y));
  vec3 c = pix(ivec2(i0.x, i1.y));
  vec3 d = pix(i1);
  return ((a * (1.0 - fr.x) + b * fr.x) * (1.0 - fr.y) + (c * (1.0 - fr.x) + d * fr.x) * fr.y) * 255.0;
}
float facOf(float lf) {
  int l = int(floor(lf + 0.5));
  if (l < 0 || l >= ${MAX_LABELS}) return 1.0;
  return uFac[l];
}
float bandAt(float x, float y) {
  if (uSheenOn == 0) return 0.0;
  float z = ((x - uSheenP.x) + 0.55 * (y - uSheenP.y)) / uSheenP.z;
  return uSheenP.w * exp(-(z * z));
}

void main() {
  int x = int(gl_FragCoord.x);
  int y = uH - 1 - int(gl_FragCoord.y);
  ivec2 ip = ivec2(x, y);
  ivec2 B = ip + uOrg;
  if (B.x < 0 || B.y < 0 || B.x >= uBoxSize.x || B.y >= uBoxSize.y) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 orig = pix(B) * 255.0;
  vec4 t0 = texelFetch(uT0, ip, 0);
  vec4 t4 = texelFetch(uT4, ip, 0);
  float M = t0.x;
  float fx = float(x), fy = float(y);

  // 屈折した下の絵 × 覆い(覆いが 0 の画素は絵を読まない: 掛けると 0)
  vec3 rgbM = vec3(0.0);
  if (M > 0.0) {
    vec4 t1 = texelFetch(uT1, ip, 0);
    float Dx = uTube * t1.x + uLetter * t1.z - uZoom * (fx - uC.x) * M;
    float Dy = uTube * t1.y + uLetter * t1.w - uZoom * (fy - uC.y) * M;
    vec2 Bf = vec2(B);
    vec2 D = vec2(Dx, Dy);
    vec3 rgb = vec3(bil(Bf + D * uKc.x).r, bil(Bf + D * uKc.y).g, bil(Bf + D * uKc.z).b);
    rgbM = rgb * (1.0 - uAbsw * t0.z) * M;
  }
  // 縁の光(F0 の分は覆いを掛けない: v3 のまま)・左上のハイライト
  vec4 t5 = texelFetch(uT5, ip, 0);
  vec3 add = uFresw * (uF0 + (1.0 - uF0) * t0.w) * uFresRgb + uHlw * t5.x;
  vec3 body = rgbM + add;
  // ガラスの色(文字ごとの明るさのゆらぎ・光の帯)
  vec4 t6 = texelFetch(uT6, ip, 0);
  float fm = 1.0 + t6.y * (facOf(t6.x) - 1.0) + t6.w * (facOf(t6.z) - 1.0);
  vec4 t2 = texelFetch(uT2, ip, 0);
  vec3 NC = t2.rgb * fm;
  float band = bandAt(fx, fy);
  NC += 255.0 * band * (0.35 + 0.65 * t5.y) * uSheen * t2.a * vec3(0.92, 0.97, 1.0) + 255.0 * 1.2 * band * t5.z;
  vec4 t3 = texelFetch(uT3, ip, 0);
  vec3 Gpm = NC + t3.rgb;
  float Ga = t2.a + t3.a;
  float kq = clamp(uS * (1.0 + uFillQ) - uFillQ * t0.y, 0.0, 1.0);
  float gm = kq * kq * (3.0 - 2.0 * kq);
  Gpm *= gm; Ga *= gm;
  body = Gpm + (1.0 - clamp(Ga / max(M, 1e-6), 0.0, 1.0)) * body;
  vec3 P = body + t4.rgb * uG;
  float A = M + t4.a * uG;
  // きらめき(4 本の光の星)。4×4 の小さな点の平均。星から遠い画素(1.2r + 2 より外)は飛ばす
  if (uNG > 0 && uG > 0.0) {
    float keep = 1.0;
    float r = uStarR;
    float wc = 0.10 * r + 0.6 * uKs;
    float wr = 0.035 * r + 0.5 * uKs;
    for (int j = 0; j < ${MAX_GLINTS}; j++) {
      if (j >= uNG) break;
      vec3 gl = uGl[j];
      if (gl.z <= 0.0) continue;
      float ddx = fx - gl.x, ddy = fy - gl.y;
      if (sqrt(ddx * ddx + ddy * ddy) > 1.2 * r + 2.6) continue;
      float acc = 0.0;
      for (int v = 0; v < 4; v++) {
        for (int u = 0; u < 4; u++) {
          float dx = fx + (float(u) + 0.5) / 4.0 - 0.5 - gl.x;
          float dy = fy + (float(v) + 0.5) / 4.0 - 0.5 - gl.y;
          float rr = sqrt(dx * dx + dy * dy) + 1e-3;
          float zc = rr / wc;
          float core = exp(-(zc * zc));
          float cl = clamp(1.0 - rr / r, 0.0, 1.0);
          float zy = dy / wr, zx = dx / wr;
          float rays = (exp(-(zy * zy)) + exp(-(zx * zx))) * (cl > 0.0 ? pow(cl, 1.6) : 0.0);
          acc += clamp((core + 0.8 * rays) * gl.z, 0.0, 1.0);
        }
      }
      keep *= 1.0 - acc / 16.0;
    }
    float S = uG * (1.0 - keep);
    P = vec3(255.0, 253.0, 246.0) * S + (1.0 - S) * P;
    A = S + (1.0 - S) * A;
  }
  P = min(P, vec3(255.0 * A));
  P *= uO; A *= uO;
  vec3 outc = clamp(P + (1.0 - A) * orig, 0.0, 255.0);
  o = vec4(outc / 255.0, 1.0);
}`

let PROBLEM = ''
const LOST_MSG = 'WebGL が一時的に止まっています。戻るまで待つか、ページを読み直してください'
/** WebGL で字幕を描けない理由(描けていれば '')。パネルで「この端末ではプレビューに出ない」と知らせる用 */
export const creditGLProblem = (): string => PROBLEM

interface MapTex { key: string; tex: WebGLTexture[]; W: number; H: number }
type Prog = { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> }

export class CreditRenderer {
  private cv: HTMLCanvasElement | null = null
  private gl: WebGL2RenderingContext | null = null
  private lost = false
  private broken = ''
  private warned = false
  private prog: Prog | null = null
  private vao: WebGLVertexArrayObject | null = null
  private picTex: WebGLTexture | null = null
  private picW = 0
  private picH = 0
  private maps = new Map<string, MapTex>()      // 最近使った順
  private fac = new Float32Array(MAX_LABELS)
  private gls = new Float32Array(MAX_GLINTS * 3)
  /** 直近の apply にかかった時間(ms、CPU 側) */
  lastMs = 0
  /** WebGL のコンテキストが戻ったとき(止めている絵を描き直してもらう) */
  onRestored: (() => void) | null = null

  available(): boolean { return this.ensure() }

  /**
   * 字幕 1 枚を src の box(字幕の枠 = キャンバス全体かトラックの配置矩形、キャンバスの px)に描いて ctx へ戻す。
   * ctx の変換は気にしない(画素の位置で描く)。成功 = true。false なら ctx には何も描いていない
   */
  apply(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, box: RectPx, use: CreditMapsUse,
        sc: CreditScalars, refract: { tube: number; letter: number; zoom: number; fill_q: number; fres_rgb: readonly number[] },
        sheenAmt: number): boolean {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0
    try {
      const h = use.maps.header
      if (!sc.active || h.empty || !(h.W > 0 && h.H > 0) || use.maps.tex.length < 7) return true
      if (sc.o <= 0) return true                                          // 効き 0 = 下の絵のまま
      const bx = Math.round(box.x), by = Math.round(box.y), bw = Math.round(box.w), bh = Math.round(box.h)
      if (!(bw >= 2 && bh >= 2)) return false
      if (h.box && (h.box[0] !== bw || h.box[1] !== bh)) return false     // 地図の枠が違う(切り替え直後)
      // 写し戻す範囲(キャンバスの px): 地図 ∩ 枠 ∩ キャンバス
      const ox = h.x0 + use.dx, oy = h.y0 + use.dy
      const cx0 = Math.max(bx + ox, bx, 0), cy0 = Math.max(by + oy, by, 0)
      const cx1 = Math.min(bx + ox + h.W, bx + bw, src.width), cy1 = Math.min(by + oy + h.H, by + bh, src.height)
      if (cx1 <= cx0 || cy1 <= cy0) return true
      if (!this.ensure()) return false
      const gl = this.gl!
      const mt = this.mapTex(use.maps)
      // 下の絵(キャンバス全体)
      gl.activeTexture(gl.TEXTURE0 + U_PIC)
      gl.bindTexture(gl.TEXTURE_2D, this.picTex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
      if (this.picW !== src.width || this.picH !== src.height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src)
        this.picW = src.width; this.picH = src.height
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src)
      }
      for (let t = 0; t < 7; t++) { gl.activeTexture(gl.TEXTURE0 + U_T0 + t); gl.bindTexture(gl.TEXTURE_2D, mt.tex[t]) }
      // 描く先: 既定のフレームバッファ(大きさは今までで一番大きい地図。小さくはしない)
      const W = h.W, H = h.H
      if (this.cv!.width < W || this.cv!.height < H) {
        this.cv!.width = Math.max(this.cv!.width, W); this.cv!.height = Math.max(this.cv!.height, H)
      }
      const P = this.prog!
      gl.useProgram(P.p)
      const u = (n: string) => this.loc(P, n)
      gl.uniform1i(u('uH'), H)
      gl.uniform2i(u('uBoxOff'), bx, by)
      gl.uniform2i(u('uBoxSize'), bw, bh)
      gl.uniform2i(u('uOrg'), ox, oy)
      gl.uniform2f(u('uC'), h.cx, h.cy)
      gl.uniform1f(u('uTube'), refract.tube)
      gl.uniform1f(u('uLetter'), refract.letter)
      gl.uniform1f(u('uZoom'), refract.zoom)
      gl.uniform3f(u('uKc'), sc.kR, sc.kG, sc.kB)
      gl.uniform1f(u('uAbsw'), sc.absw)
      gl.uniform1f(u('uFresw'), sc.fresw)
      gl.uniform1f(u('uF0'), sc.F0)
      gl.uniform3f(u('uFresRgb'), refract.fres_rgb[0], refract.fres_rgb[1], refract.fres_rgb[2])
      gl.uniform1f(u('uHlw'), sc.hlw)
      this.fac.fill(1)
      for (let l = 0; l < sc.fac.length && l < MAX_LABELS; l++) this.fac[l] = sc.fac[l]
      gl.uniform1fv(u('uFac'), this.fac)
      gl.uniform1i(u('uSheenOn'), sc.sheen.on ? 1 : 0)
      gl.uniform4f(u('uSheenP'), sc.sheen.pos, sc.sheen.yc, sc.sheen.bw || 1, sc.sheen.amp)
      gl.uniform1f(u('uSheen'), sheenAmt)
      gl.uniform1f(u('uS'), sc.s)
      gl.uniform1f(u('uFillQ'), refract.fill_q)
      gl.uniform1f(u('uG'), sc.g)
      const glints = h.glints ?? []
      const ng = Math.min(MAX_GLINTS, glints.length, sc.inten.length)
      this.gls.fill(0)
      for (let j = 0; j < ng; j++) { this.gls[j * 3] = glints[j][0]; this.gls[j * 3 + 1] = glints[j][1]; this.gls[j * 3 + 2] = sc.inten[j] }
      gl.uniform1i(u('uNG'), ng)
      gl.uniform3fv(u('uGl'), this.gls)
      gl.uniform1f(u('uStarR'), h.star_r)
      gl.uniform1f(u('uKs'), h.k)
      gl.uniform1f(u('uO'), sc.o)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, W, H)
      gl.bindVertexArray(this.vao)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (gl.isContextLost()) { this.lost = true; return false }
      // 地図の画素 (x, y) は既定のフレームバッファの左下 W×H の行 (H-1-y)。2D キャンバスの上から (cv.h - H + y) 行目
      const sx = cx0 - (bx + ox), sy = cy0 - (by + oy)
      const w = cx1 - cx0, hh = cy1 - cy0
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      ctx.filter = 'none'
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(this.cv!, sx, this.cv!.height - H + sy, w, hh, cx0, cy0, w, hh)
      ctx.restore()
      return true
    } catch (e) {
      this.fail(String((e as Error)?.message ?? e), false)
      return false
    } finally {
      this.lastMs = typeof performance !== 'undefined' ? performance.now() - t0 : 0
    }
  }

  /** GPU の資源を捨てる(次の apply で作り直す) */
  dispose() {
    const gl = this.gl
    if (gl && !gl.isContextLost()) {
      for (const m of this.maps.values()) for (const t of m.tex) gl.deleteTexture(t)
      if (this.picTex) gl.deleteTexture(this.picTex)
      if (this.prog) gl.deleteProgram(this.prog.p)
      if (this.vao) gl.deleteVertexArray(this.vao)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    this.maps.clear()
    this.gl = null; this.cv = null; this.prog = null; this.vao = null; this.picTex = null
    this.picW = this.picH = 0
    this.lost = false
  }

  // ── 準備 ────────────────────────────────────────────────────────────
  private fail(msg: string, permanent: boolean) {
    if (permanent) { this.broken = msg; PROBLEM = msg }
    if (!this.warned) { this.warned = true; console.warn('[字幕プレビュー] WebGL で描けません:', msg) }
  }

  private ensure(): boolean {
    if (this.broken || this.lost) return false
    if (this.gl && this.prog) return !this.gl.isContextLost()
    if (typeof document === 'undefined') { this.broken = 'no document'; return false }
    try {
      const cv = this.cv ?? document.createElement('canvas')
      if (!this.cv) {
        cv.width = 2; cv.height = 2
        cv.addEventListener('webglcontextlost', e => {
          e.preventDefault()
          if (this.cv !== cv) return
          this.lost = true
          if (!PROBLEM) PROBLEM = LOST_MSG
        }, false)
        cv.addEventListener('webglcontextrestored', () => {
          if (this.cv !== cv) return
          this.gl = null; this.prog = null; this.vao = null; this.picTex = null; this.picW = this.picH = 0
          this.maps.clear(); this.lost = false
          if (PROBLEM === LOST_MSG) PROBLEM = ''
          try { this.onRestored?.() } catch { /* 描き直しの頼みだけ */ }
        }, false)
        this.cv = cv
      }
      const gl = this.gl ?? cv.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
        preserveDrawingBuffer: false, powerPreference: 'high-performance',
      })
      if (!gl) { this.fail('WebGL2 がありません', true); return false }
      this.gl = gl
      this.vao = gl.createVertexArray()
      const t = gl.createTexture()!
      gl.activeTexture(gl.TEXTURE0 + U_PIC)
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
      this.texParams()
      this.picTex = t; this.picW = this.picH = 0
      this.prog = this.mkProg(FS)
      gl.useProgram(this.prog.p)
      const set = (n: string, unit: number) => { const l = this.loc(this.prog!, n); if (l) gl.uniform1i(l, unit) }
      set('uPic', U_PIC)
      for (let k = 0; k < 7; k++) set(`uT${k}`, U_T0 + k)
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE)
      return true
    } catch (err) {
      this.fail(String((err as Error)?.message ?? err), true)
      return false
    }
  }

  private texParams() {
    const gl = this.gl!
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  private mkProg(fs: string): Prog {
    const gl = this.gl!
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src); gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error('shader: ' + gl.getShaderInfoLog(s))
      return s
    }
    const p = gl.createProgram()!
    const v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, fs)
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('link: ' + gl.getProgramInfoLog(p))
    gl.deleteShader(v); gl.deleteShader(f)
    return { p, u: new Map() }
  }

  private loc(pr: Prog, name: string): WebGLUniformLocation | null {
    let l = pr.u.get(name)
    if (l === undefined) { l = this.gl!.getUniformLocation(pr.p, name); pr.u.set(name, l) }
    return l
  }

  /** 地図の 7 枚(RGBA32F)。キーごとに 1 回だけ上げる。最近使った 8 枚ぶんまで */
  private mapTex(m: CreditMaps): MapTex {
    const gl = this.gl!
    const key = m.key + '#' + m.header.W + 'x' + m.header.H
    const hit = this.maps.get(key)
    if (hit) { this.maps.delete(key); this.maps.set(key, hit); return hit }
    const W = m.header.W, H = m.header.H
    const tex: WebGLTexture[] = []
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    for (let t = 0; t < 7; t++) {
      const tx = gl.createTexture()!
      gl.activeTexture(gl.TEXTURE0 + U_SCRATCH)
      gl.bindTexture(gl.TEXTURE_2D, tx)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, m.tex[t])
      this.texParams()
      tex.push(tx)
    }
    const mt: MapTex = { key, tex, W, H }
    this.maps.set(key, mt)
    while (this.maps.size > MAX_MAPS) {
      const [k0, m0] = this.maps.entries().next().value as [string, MapTex]
      for (const t of m0.tex) gl.deleteTexture(t)
      this.maps.delete(k0)
    }
    return mt
  }
}
