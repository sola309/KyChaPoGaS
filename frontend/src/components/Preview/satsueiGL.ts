/**
 * 🎬 撮影レイヤーのプレビュー描画(WebGL2)。式は satsueiLook.ts / backend satsuei_fx.py と同じ(設計書 §2)。
 *
 *   apply(ctx, src, rect, layer, f): 2D キャンバス src の rect の範囲(= ここまでに合成した下の絵)を GPU に上げ、
 *   ①空気 → ②レンズ → ③色(LUT)→ ④粒子 → ⑤効きで混ぜる(+ 撮影クリップ同士の溶け A→B)をかけて、ctx の同じ範囲へ描き戻す。
 *   失敗(WebGL2 なし・コンテキスト喪失・シェーダの失敗)は false を返すだけで投げない → 呼び手は絵をそのまま残す。
 *
 * 速さの工夫:
 *   - 大きなぼかし(にじみ・ブルーム 3 段・ハレーション)は縮めた絵(1/2, 1/4, …)で分離ガウス。縮め方は 2×2 平均の段々、
 *     段は「縮めた後のシグマが 2.5〜5px」になる所。拡大は描くときの線形補間。= 試作 looks.py の _blur_pyr と同じ考え。
 *     シグマが 2.5px より小さいぼかしは縮めずに全画面で(縮めて戻す分のぼけ ≈ 1px が足されて、書き出しより太く見えないように。
 *     2.5〜5px は 1/2 のまま: 差は端の数画素だけで、全画面にするとプリセット(雨の夜のハレーションなど)が重くなる)。
 *   - ぼかしの元(にじみ = 空気の後の絵、ブルーム = 線形の光 × 明るさの重み、ハレーション = しきい値を越えた明るさ)は、
 *     1/2 へ縮める 1 回目の中で 4 点ずつ計算する(全画面の中間の絵を作らない)。全画面の中間は色ずれ(ca)と粒子のときだけ。
 *   - LUT(65³、RGB16F の 3D テクスチャ、線形補間)は色の欄が変わったときだけ作り直す(色のキーで最大 16 枚まで覚える)。
 *     次のカットの LUT は prefetch で手の空いたときに先に作る(カットの替わり目のコマで 65³ を作って遅れないように)。
 *   - 途中の絵は半精度の浮動小数(EXT_color_buffer_float / _half_float)。どちらも無い端末は 8bit に √ で詰めて持つ
 *     (暗い所のブルームのすそが少し粗くなるだけで、式は同じ)。
 *   - 大きさごとの GPU の資源は使い回す(大きさごとに 3 つまで覚える: 撮影トラックが 2 本で範囲の大きさが違っても、
 *     毎コマ作り直さない)。毎コマの new は小さな配列も含めてしない。
 */
import {
  buildLut, colorKey, colorIsIdentity, leakEval, hexToRgb, toLin,
  BLOOM_SIGMAS, BLOOM_WEIGHTS, LUT_N, MAX_PARA, MAX_LEAKS,
  type SatsueiLayerSpec, type SatsueiSpec, type SatsueiParams,
} from './satsueiLook'

export interface RectPx { x: number; y: number; w: number; h: number }
export interface SatsueiApplyOpts {
  /** 比べる: 範囲の左から何 px までは描き戻さない(左 = 撮影なしの絵のまま) */
  splitX?: number
}

interface Tex { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }
/** 大きさごとの GPU の資源(levels[0] = 全画面、levels[L] = 1/2^L) */
interface SizeRes {
  w: number; h: number; maxL: number
  levels: (Tex | null)[]; tmps: (Tex | null)[]; outs: Map<string, Tex>
  pre: Tex | null; grain: Tex | null; outA: Tex | null
}
type Prog = { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> }

// テクスチャの番号(サンプラーごとに固定)
const U_SRC = 0, U_DIFF = 1, U_B0 = 2, U_B1 = 3, U_B2 = 4, U_HAL = 5, U_LUT = 6, U_PRE = 7, U_GRAIN = 8, U_PREV = 9, U_TEX = 10
const U_SCRATCH = 11      // 作るときだけに使う(描くときのつなぎを崩さない)
const MAX_LUTS = 16
const MAX_PREFETCH = 6     // 先に作っておく LUT の数(今使っているものを追い出さないよう MAX_LUTS より十分少なく)
const MAX_SIZES = 3        // 覚えておく大きさの数
/** シグマ(px)がこれより小さいぼかしは縮めずに全画面で */
const FULL_RES_SIGMA = 2.5

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const HEAD = (enc: boolean) => `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
#define ENC ${enc ? 1 : 0}
out vec4 o;
// 途中の絵(縮めたぼかし)の持ち方: 8bit のときは √ で詰める
#if ENC
vec4 STORE(vec4 v) { return sqrt(clamp(v, 0.0, 1.0)); }
vec4 LOADV(vec4 e) { return e * e; }
float GSTORE(float n) { return clamp(n * 0.125 + 0.5, 0.0, 1.0); }
float GLOAD(float e) { return (e - 0.5) * 8.0; }
#else
vec4 STORE(vec4 v) { return v; }
vec4 LOADV(vec4 e) { return e; }
float GSTORE(float n) { return n; }
float GLOAD(float e) { return e; }
#endif
// BORDER_REFLECT_101(cv2.GaussianBlur の端と同じ)
int refl(int i, int n) {
  if (n <= 1) return 0;
  int m = 2 * (n - 1);
  i = i % m; if (i < 0) i += m;
  return i < n ? i : m - i;
}
`

/** 1 クリップぶんの絵の流れ(縮める 1 回目・色ずれの前段・最後で共通) */
const STAGES = `
uniform sampler2D uSrc;      // 下の絵(2D キャンバス全体、行 0 = 上)
uniform ivec2 uSrcOff;       // 作用範囲の左上(キャンバスの px)
uniform vec2 uSize;          // 作用範囲の大きさ(px)
uniform int uParaN;
uniform vec4 uParaFT[${MAX_PARA}];    // from.xy, (to-from).xy
uniform vec4 uParaCol[${MAX_PARA}];   // 色.rgb, 量
uniform vec4 uParaMode[${MAX_PARA}];  // 重ね方(0 screen / 1 multiply / 2 normal), |d|²+1e-6
uniform int uLeakN;
uniform vec4 uLeakPos[${MAX_LEAKS}];  // cx, cy, rx, ry
uniform vec4 uLeakCol[${MAX_LEAKS}];  // 線形の色.rgb, 量×包絡線
uniform float uDiffAmt;
uniform sampler2D uDiff;
uniform vec2 uDiffScale;     // 画素 → 縮めた絵の uv
uniform float uBloomAmt;
uniform vec3 uBloomTint;
uniform float uBloomThrL;
uniform float uBloomDen;
uniform sampler2D uB0;
uniform sampler2D uB1;
uniform sampler2D uB2;
uniform vec2 uBScale0;
uniform vec2 uBScale1;
uniform vec2 uBScale2;
uniform vec3 uBW;
uniform float uHalAmt;
uniform float uHalThrL;
uniform sampler2D uHal;
uniform vec2 uHalScale;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec3 toLin(vec3 x) { return pow(clamp(x, 0.0, 1.0), vec3(2.4)); }
vec3 toGam(vec3 x) { return pow(clamp(x, 0.0, 1.0), vec3(1.0 / 2.4)); }
vec3 srcAt(ivec2 ip) { return texelFetch(uSrc, ip + uSrcOff, 0).rgb; }

// ①空気: パラ(グラデーション)とライトリーク(線形の光で足す)。p = 画素の番号(左上 0,0)
vec3 air(vec3 x, vec2 p) {
  vec2 uv = p / uSize;
  for (int i = 0; i < ${MAX_PARA}; i++) {
    if (i >= uParaN) break;
    float t = clamp(dot(uv - uParaFT[i].xy, uParaFT[i].zw) / uParaMode[i].y, 0.0, 1.0);
    float m = (1.0 - t) * uParaCol[i].w;
    vec3 col = uParaCol[i].rgb;
    int bl = int(uParaMode[i].x + 0.5);
    if (bl == 0) x = 1.0 - (1.0 - x) * (1.0 - col * m);
    else if (bl == 1) x = x * (1.0 - m + col * m);
    else x = x * (1.0 - m) + col * m;
  }
  if (uLeakN > 0) {
    vec3 lin = toLin(x);
    for (int i = 0; i < ${MAX_LEAKS}; i++) {
      if (i >= uLeakN) break;
      vec2 q = (uv - uLeakPos[i].xy) / uLeakPos[i].zw;
      lin += uLeakCol[i].w * exp(-dot(q, q)) * uLeakCol[i].rgb;
    }
    x = toGam(lin);
  }
  return clamp(x, 0.0, 1.0);
}
// ②レンズ: にじみ(大きくぼかして screen)
vec3 stageDiff(vec3 x, vec2 p) {
  if (uDiffAmt > 0.0) {
    vec3 d = LOADV(texture(uDiff, (p + 0.5) * uDiffScale)).rgb;
    x = 1.0 - (1.0 - x) * (1.0 - d * uDiffAmt);
  }
  return x;
}
vec3 bloomSrc(vec3 x) {
  vec3 lin = toLin(x);
  float w = clamp((dot(lin, LUMA) - uBloomThrL) / uBloomDen, 0.0, 1.0);
  return lin * (w * w);
}
// 光のにじみ(明るい所だけ、線形の光で足す)
vec3 stageBloom(vec3 x, vec2 p) {
  if (uBloomAmt > 0.0) {
    vec2 q = p + 0.5;
    vec3 acc = uBW.x * LOADV(texture(uB0, q * uBScale0)).rgb
             + uBW.y * LOADV(texture(uB1, q * uBScale1)).rgb
             + uBW.z * LOADV(texture(uB2, q * uBScale2)).rgb;
    x = toGam(toLin(x) + uBloomAmt * acc * uBloomTint);
  }
  return x;
}
float halSrc(vec3 x) { return max(dot(toLin(x), LUMA) - uHalThrL, 0.0); }
// ハレーション(強い光の縁の赤橙)
vec3 stageHal(vec3 x, vec2 p) {
  if (uHalAmt > 0.0) {
    float a = LOADV(texture(uHal, (p + 0.5) * uHalScale)).r;
    x = toGam(toLin(x) + uHalAmt * a * vec3(1.0, 0.35, 0.12));
  }
  return x;
}
vec3 lensChain(ivec2 ip) {
  vec2 p = vec2(ip);
  vec3 x = air(srcAt(ip), p);
  x = stageDiff(x, p);
  x = stageBloom(x, p);
  return stageHal(x, p);
}
`

// 1/2 へ縮める 1 回目: 全画面の 2×2 の 4 点で、ぼかしの元をその場で計算して平均する
// (uFull = 1: 縮めずに全画面のまま 1 点ずつ。小さなシグマのぼかし用)
const FS_DOWN1 = (enc: boolean) => HEAD(enc) + STAGES + `
uniform int uMode;   // 0 = にじみの元(空気の後) / 1 = ブルームの元 / 2 = ハレーションの元
uniform int uFull;
void main() {
  ivec2 d = ivec2(gl_FragCoord.xy);
  ivec2 mx = ivec2(uSize) - 1;
  int n = uFull == 1 ? 1 : 4;
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    if (k >= n) break;
    ivec2 ip = uFull == 1 ? min(d, mx) : min(d * 2 + ivec2(k & 1, k >> 1), mx);
    vec2 p = vec2(ip);
    vec3 x = air(srcAt(ip), p);
    if (uMode == 0) { acc += x; continue; }
    x = stageDiff(x, p);
    if (uMode == 1) { acc += bloomSrc(x); continue; }
    x = stageBloom(x, p);
    acc += vec3(halSrc(x));
  }
  o = STORE(vec4(acc / float(n), 1.0));
}`

// 段々に 1/2 へ(2×2 の平均 = 4 枚の真ん中を線形補間で 1 回読む)
const FS_DOWN = (enc: boolean) => HEAD(enc) + `
uniform sampler2D uTex;
void main() {
  vec2 uv = (2.0 * floor(gl_FragCoord.xy) + 1.0) / vec2(textureSize(uTex, 0));
  o = texture(uTex, uv);
}`

// 分離ガウス(cv2.GaussianBlur と同じ: 半径 ≈ 4σ、端は reflect101)
const FS_BLUR = (enc: boolean) => HEAD(enc) + `
uniform sampler2D uTex;
uniform ivec2 uDir;
uniform float uSigma;
uniform int uRadius;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uTex, 0);
  float k = -0.5 / (uSigma * uSigma);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -uRadius; i <= uRadius; i++) {
    ivec2 q = p + uDir * i;
    q = ivec2(refl(q.x, sz.x), refl(q.y, sz.y));
    float w = exp(float(i * i) * k);
    acc += w * LOADV(texelFetch(uTex, q, 0)); ws += w;
  }
  o = STORE(acc / ws);
}`

const NOISE = `
uniform uint uSeed;
uniform float uGSigma;
uniform int uGR;
// pcg3d(Jarzynski & Olano 2020)→ Box–Muller で 1 画素 1 個の正規乱数
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
float gaussAt(ivec2 p) {
  uvec3 h = pcg3d(uvec3(uvec2(p), uSeed));
  float u1 = (float(h.x >> 8u) + 0.5) / 16777216.0;
  float u2 = float(h.y >> 8u) / 16777216.0;
  return sqrt(-2.0 * log(u1)) * cos(6.28318530718 * u2);
}
`

// 粒子の横のぼかし(全画面)。縦と、ぼかして弱くなった分の戻しは最後の中で
const FS_GRAINH = (enc: boolean) => HEAD(enc) + NOISE + `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float k = -0.5 / (uGSigma * uGSigma);
  float acc = 0.0, ws = 0.0;
  for (int i = -uGR; i <= uGR; i++) {
    float w = exp(float(i * i) * k);
    acc += w * gaussAt(p + ivec2(i, 0)); ws += w;
  }
  o = vec4(GSTORE(acc / ws), 0.0, 0.0, 1.0);
}`

// 色ずれの前段: 空気〜ハレーションまでの絵を全画面に(色ずれは赤と青をずらして読むため)
const FS_PRE = (enc: boolean) => HEAD(enc) + STAGES + `
void main() { o = vec4(lensChain(ivec2(gl_FragCoord.xy)), 1.0); }`

// 最後: 色ずれ → 周辺減光 → LUT → 粒子 → 効きで混ぜる(→ 溶けなら前のクリップの結果と混ぜる)
const FS_FINAL = (enc: boolean) => HEAD(enc) + STAGES + NOISE + `
uniform int uCA;
uniform sampler2D uPre;
uniform vec2 uCAs;           // 赤・青の拡大率(1 ± ca/w)
uniform float uVig;
uniform int uLutOn;
uniform sampler3D uLut;
uniform float uLutN;
uniform float uGrainAmt;
uniform float uGNorm;
uniform sampler2D uGrain;
uniform float uMix;
uniform float uK;            // > 0: 前のクリップの結果と (1-k):k で混ぜる
uniform int uPrevSrc;        // 1: 前のクリップの結果 = 下の絵のまま
uniform sampler2D uPrev;
uniform int uFlip;           // 1: 画面(既定のフレームバッファ)へ描く = 上下を返す
float grainAt(ivec2 ip) {
  if (uGR == 0) return gaussAt(ip);
  float k = -0.5 / (uGSigma * uGSigma);
  float acc = 0.0, ws = 0.0;
  int H = int(uSize.y);
  for (int j = -uGR; j <= uGR; j++) {
    float w = exp(float(j * j) * k);
    acc += w * GLOAD(texelFetch(uGrain, ivec2(ip.x, refl(ip.y + j, H)), 0).r); ws += w;
  }
  return acc / ws * uGNorm;
}
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  if (uFlip == 1) ip.y = int(uSize.y) - 1 - ip.y;
  vec2 p = vec2(ip);
  vec3 x0 = srcAt(ip);
  vec3 x;
  if (uCA == 1) {
    vec2 c = uSize * 0.5;
    vec2 qr = c + (p - c) / uCAs.x, qb = c + (p - c) / uCAs.y;
    x = vec3(texture(uPre, (qr + 0.5) / uSize).r, texelFetch(uPre, ip, 0).g, texture(uPre, (qb + 0.5) / uSize).b);
  } else {
    x = lensChain(ip);
  }
  if (uVig > 0.0) {
    vec2 c = uSize * 0.5;
    float r = length((p - c) / c) / 1.41421356237;
    x *= 1.0 - uVig * pow(clamp(r, 0.0, 1.0), 2.2);
  }
  x = clamp(x, 0.0, 1.0);
  if (uLutOn == 1) x = texture(uLut, (x * (uLutN - 1.0) + 0.5) / uLutN).rgb;
  if (uGrainAmt > 0.0) {
    float Y = dot(x, LUMA);
    x += uGrainAmt * (0.35 + 2.6 * Y * (1.0 - Y)) * grainAt(ip);
  }
  x = clamp(x, 0.0, 1.0);
  vec3 r = x0 + (x - x0) * uMix;
  if (uK > 0.0) {
    vec3 pa = uPrevSrc == 1 ? x0 : texelFetch(uPrev, ip, 0).rgb;
    r = mix(pa, r, uK);
  }
  o = vec4(r, 1.0);
}`

/** cv2.getGaussianKernel(CV_32F)と同じ半径: ksize = round(8σ+1)|1 */
const radiusOf = (sigma: number) => Math.min(64, ((Math.round(sigma * 8 + 1) | 1) - 1) >> 1)

let PROBLEM = ''
const LOST_MSG = 'WebGL が一時的に止まっています。戻るまで待つか、ページを読み直してください'
/** WebGL で撮影を描けない理由(描けていれば '')。撮影パネルで「この端末ではプレビューに出ない」と知らせる用 */
export const satsueiGLProblem = (): string => PROBLEM

export class SatsueiRenderer {
  private cv: HTMLCanvasElement | null = null
  private gl: WebGL2RenderingContext | null = null
  private lost = false
  private broken = ''                    // 使えない理由(以後は何もしない)
  private warned = false
  private enc = false                    // 途中の絵を 8bit(√ 詰め)で持つ
  private fmt = 0                        // 途中の絵の内部形式
  private progs: Record<'down1' | 'down' | 'blur' | 'grainH' | 'pre' | 'final', Prog> | null = null
  private vao: WebGLVertexArrayObject | null = null
  private srcTex: WebGLTexture | null = null
  private dummy2: WebGLTexture | null = null
  private dummy3: WebGLTexture | null = null
  private luts = new Map<string, WebGLTexture>()
  private lutQueue: SatsueiParams[] = []       // 先に作る LUT(近い順)
  private lutIdle = false
  // 大きさごと(最近使った順。今の大きさは S)
  private sizes = new Map<string, SizeRes>()
  private S: SizeRes | null = null
  private get w() { return this.S?.w ?? 0 }
  private get h() { return this.S?.h ?? 0 }
  // 毎コマ使い回す uniform の入れ物
  private paraFT = new Float32Array(MAX_PARA * 4)
  private paraCol = new Float32Array(MAX_PARA * 4)
  private paraMode = new Float32Array(MAX_PARA * 4)
  private leakPos = new Float32Array(MAX_LEAKS * 4)
  private leakCol = new Float32Array(MAX_LEAKS * 4)
  /** 直近の apply にかかった時間(ms、CPU 側。GPU は非同期) */
  lastMs = 0
  /** WebGL のコンテキストが戻ったとき(止めている絵を描き直してもらう) */
  onRestored: (() => void) | null = null

  /** WebGL2 が使えるか(初回に作ってみる) */
  available(): boolean { return this.ensure() }

  /**
   * layer(1 本の撮影トラックのこのコマの指定)を src の rect にかけて ctx へ描き戻す。
   * ctx の変換は気にしない(画素の位置で描く)。成功 = true。false なら ctx には何も描いていない。
   */
  apply(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, rectPx: RectPx,
        layer: SatsueiLayerSpec, timelineFrame: number, opts?: SatsueiApplyOpts): boolean {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0
    try {
      const x = Math.max(0, Math.round(rectPx.x)), y = Math.max(0, Math.round(rectPx.y))
      const w = Math.min(src.width - x, Math.round(rectPx.w)), h = Math.min(src.height - y, Math.round(rectPx.h))
      if (!(w >= 2 && h >= 2)) return false
      // 溶けの 2 本のうち効く方だけを流す(片方が効かない = 下の絵なので、もう片方の効きを (1-k) / k 倍にする)
      const k = layer.b ? Math.max(0, Math.min(1, layer.k)) : 0
      const live = (s: SatsueiSpec | undefined, wt: number) => !!s && wt > 0 && s.mix * wt > 0.001
      const la = live(layer.a, 1 - k), lb = live(layer.b, k)
      if (!la && !lb) return true                                   // 何も変わらない
      if (!this.ensure()) return false
      const gl = this.gl!
      this.ensureSize(w, h)
      gl.activeTexture(gl.TEXTURE0 + U_SRC)
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src)
      const off: [number, number] = [x, y]
      if (la && lb) {
        this.runClip(layer.a, layer.a.mix, off, timelineFrame, this.outATex(), 0, false)
        this.runClip(layer.b!, layer.b!.mix, off, timelineFrame, null, k, false)
      } else if (la) {
        this.runClip(layer.a, layer.a.mix * (1 - k), off, timelineFrame, null, 0, false)
      } else {
        this.runClip(layer.b!, layer.b!.mix * k, off, timelineFrame, null, 0, false)
      }
      if (gl.isContextLost()) { this.lost = true; return false }
      const sx = Math.max(0, Math.min(w, Math.round(opts?.splitX ?? 0)))
      if (sx < w) {
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'
        ctx.filter = 'none'
        ctx.imageSmoothingEnabled = false
        // 描いたのは既定のフレームバッファの左下 w×h(キャンバスは覚えている大きさの一番大きいもの)
        ctx.drawImage(this.cv!, sx, this.cv!.height - h, w - sx, h, x + sx, y, w - sx, h)
        ctx.restore()
      }
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
      for (const r of this.sizes.values()) this.dropSize(r)
      for (const t of this.luts.values()) gl.deleteTexture(t)
      for (const t of [this.srcTex, this.dummy2, this.dummy3]) if (t) gl.deleteTexture(t)
      if (this.progs) for (const p of Object.values(this.progs)) gl.deleteProgram(p.p)
      if (this.vao) gl.deleteVertexArray(this.vao)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    this.luts.clear(); this.lutQueue = []
    this.gl = null; this.cv = null; this.progs = null; this.vao = null
    this.srcTex = this.dummy2 = this.dummy3 = null
    this.sizes.clear(); this.S = null
    this.lost = false
  }

  /**
   * 次に使いそうな撮影の設定(近い順)の LUT を、手の空いたとき(requestIdleCallback)に先に作っておく。
   * 作り終えていれば何もしない。毎コマ呼んでよい(キーを比べるだけ)
   */
  prefetch(list: readonly SatsueiParams[]) {
    if (this.broken || this.lost || !this.gl) return
    const want: SatsueiParams[] = []
    const keys = new Set<string>()
    for (const p of list) {
      if (want.length >= MAX_PREFETCH) break
      if (colorIsIdentity(p)) continue
      const k = colorKey(p)
      if (keys.has(k) || this.luts.has(k)) continue
      keys.add(k); want.push(p)
    }
    this.lutQueue = want
    if (!want.length || this.lutIdle) return
    this.lutIdle = true
    const ric = (globalThis as { requestIdleCallback?: (cb: (d: { timeRemaining(): number; didTimeout: boolean }) => void, o?: { timeout: number }) => number }).requestIdleCallback
    const run = (d?: { timeRemaining(): number; didTimeout: boolean }) => {
      this.lutIdle = false
      try {
        // 1 枚 ≈ 15〜30ms(JS で 65³ を計算 + GPU へ上げる)。手が空いている間に 1 枚ずつ
        while (this.lutQueue.length) {
          if (d && !d.didTimeout && d.timeRemaining() < 12) break
          const p = this.lutQueue.shift()!
          if (!this.gl || this.lost || this.gl.isContextLost()) { this.lutQueue = []; return }
          if (!this.luts.has(colorKey(p))) { this.lut(p); if (d) break }
        }
      } catch { this.lutQueue = []; return }
      if (this.lutQueue.length) this.prefetch(this.lutQueue)
    }
    if (ric) ric(run, { timeout: 400 }); else setTimeout(() => run(), 50)
  }

  // ── 準備 ────────────────────────────────────────────────────────────
  private fail(msg: string, permanent: boolean) {
    if (permanent) { this.broken = msg; PROBLEM = msg }
    if (!this.warned) { this.warned = true; console.warn('[撮影プレビュー] WebGL で描けません:', msg) }
  }

  private ensure(): boolean {
    if (this.broken) return false
    if (this.lost) return false
    if (this.gl && this.progs) return !this.gl.isContextLost()
    if (typeof document === 'undefined') { this.broken = 'no document'; return false }
    try {
      const cv = this.cv ?? document.createElement('canvas')
      if (!this.cv) {
        cv.width = 2; cv.height = 2
        cv.addEventListener('webglcontextlost', e => {
          e.preventDefault()
          if (this.cv !== cv) return
          this.lost = true
          if (!PROBLEM) PROBLEM = LOST_MSG                         // 撮影パネルで知らせる(戻れば消える)
        }, false)
        cv.addEventListener('webglcontextrestored', () => {
          if (this.cv !== cv) return
          // 古い資源は全部無効。次の apply で作り直す
          this.gl = null; this.progs = null; this.vao = null; this.srcTex = this.dummy2 = this.dummy3 = null
          this.luts.clear(); this.lutQueue = []; this.sizes.clear(); this.S = null; this.lost = false
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
      // 途中の絵の形式: 半精度が描ければそれ、だめなら 8bit(√ 詰め)
      const half = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))
      this.fmt = half ? gl.RGBA16F : gl.RGBA8
      this.enc = !half
      if (half && !this.fboWorks(gl.RGBA16F)) { this.fmt = gl.RGBA8; this.enc = true }
      this.vao = gl.createVertexArray()
      this.srcTex = this.mkTex2D(1, 1, gl.RGBA8, gl.NEAREST, gl.CLAMP_TO_EDGE)
      this.dummy2 = this.mkTex2D(1, 1, gl.RGBA8, gl.NEAREST, gl.CLAMP_TO_EDGE)
      this.dummy3 = gl.createTexture()
      gl.activeTexture(gl.TEXTURE0 + U_SCRATCH)
      gl.bindTexture(gl.TEXTURE_3D, this.dummy3)
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)      // ミップマップ無しでも「完全」なテクスチャに
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      const e = this.enc
      this.progs = {
        down1: this.mkProg(FS_DOWN1(e)), down: this.mkProg(FS_DOWN(e)), blur: this.mkProg(FS_BLUR(e)),
        grainH: this.mkProg(FS_GRAINH(e)), pre: this.mkProg(FS_PRE(e)), final: this.mkProg(FS_FINAL(e)),
      }
      // サンプラーの番号は固定
      for (const pr of Object.values(this.progs)) {
        gl.useProgram(pr.p)
        const set = (n: string, unit: number) => { const l = this.loc(pr, n); if (l) gl.uniform1i(l, unit) }
        set('uSrc', U_SRC); set('uDiff', U_DIFF); set('uB0', U_B0); set('uB1', U_B1); set('uB2', U_B2); set('uHal', U_HAL)
        set('uLut', U_LUT); set('uPre', U_PRE); set('uGrain', U_GRAIN); set('uPrev', U_PREV); set('uTex', U_TEX)
      }
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE)
      return true
    } catch (err) {
      this.fail(String((err as Error)?.message ?? err), true)
      return false
    }
  }

  private fboWorks(internal: number): boolean {
    const gl = this.gl!
    const t = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0 + U_SCRATCH)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, 4, 4)
    const fb = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fb); gl.deleteTexture(t)
    return ok
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

  private mkTex2D(w: number, h: number, internal: number, filter: number, wrap: number): WebGLTexture {
    const gl = this.gl!
    const t = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0 + U_SCRATCH)
    gl.bindTexture(gl.TEXTURE_2D, t)
    if (internal === gl.RGBA8 && w === 1 && h === 1) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
    } else {
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h)
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
    return t
  }

  private mkTarget(w: number, h: number, internal: number, wrap?: number): Tex {
    const gl = this.gl!
    const tex = this.mkTex2D(w, h, internal, gl.LINEAR, wrap ?? gl.CLAMP_TO_EDGE)
    const fb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { tex, fb, w, h }
  }

  private dropTex(t: Tex | null) {
    if (!t || !this.gl) return
    this.gl.deleteFramebuffer(t.fb); this.gl.deleteTexture(t.tex)
  }

  private dropSize(r: SizeRes) {
    for (const t of r.levels) this.dropTex(t)
    for (const t of r.tmps) this.dropTex(t)
    for (const t of r.outs.values()) this.dropTex(t)
    this.dropTex(r.pre); this.dropTex(r.grain); this.dropTex(r.outA)
    r.levels = []; r.tmps = []; r.outs.clear(); r.pre = r.grain = r.outA = null
  }

  private ensureSize(w: number, h: number) {
    if (this.S && this.S.w === w && this.S.h === h) return
    const key = `${w}x${h}`
    let r = this.sizes.get(key)
    if (r) this.sizes.delete(key)                                  // 最近使った順へ
    else {
      r = { w, h, maxL: Math.max(1, Math.floor(Math.log2(Math.max(2, Math.min(w, h)) / 4))),
            levels: [], tmps: [], outs: new Map(), pre: null, grain: null, outA: null }
      while (this.sizes.size >= MAX_SIZES) {
        const [k0, r0] = this.sizes.entries().next().value as [string, SizeRes]
        this.dropSize(r0); this.sizes.delete(k0)
      }
    }
    this.sizes.set(key, r)
    this.S = r
    // 既定のフレームバッファ(描き戻す元)は覚えている大きさの一番大きいものに(大きさを替えるたびに作り直さない)
    let cw = 2, ch = 2
    for (const q of this.sizes.values()) { cw = Math.max(cw, q.w); ch = Math.max(ch, q.h) }
    if (this.cv!.width !== cw || this.cv!.height !== ch) { this.cv!.width = cw; this.cv!.height = ch }
  }

  private lvlSize(L: number): [number, number] {
    const s = 2 ** L
    return [Math.max(1, Math.ceil(this.w / s)), Math.max(1, Math.ceil(this.h / s))]
  }
  private level(L: number): Tex {
    const S = this.S!
    let t = S.levels[L]
    if (!t) { const [w, h] = this.lvlSize(L); t = this.mkTarget(w, h, this.fmt); S.levels[L] = t }
    return t
  }
  private tmp(L: number): Tex {
    const S = this.S!
    let t = S.tmps[L]
    if (!t) { const [w, h] = this.lvlSize(L); t = this.mkTarget(w, h, this.fmt); S.tmps[L] = t }
    return t
  }
  private out(slot: string, L: number): Tex {
    const S = this.S!
    const key = `${slot}:${L}`
    let t = S.outs.get(key)
    if (!t) { const [w, h] = this.lvlSize(L); t = this.mkTarget(w, h, this.fmt); S.outs.set(key, t) }
    return t
  }
  private outATex(): Tex {
    const S = this.S!
    if (!S.outA) S.outA = this.mkTarget(this.w, this.h, this.gl!.RGBA8)
    return S.outA
  }
  private preTex(): Tex {
    // 色ずれは端で鏡に折り返して読む(cv2 BORDER_REFLECT と同じ)
    const S = this.S!
    if (!S.pre) S.pre = this.mkTarget(this.w, this.h, this.enc ? this.gl!.RGBA8 : this.fmt, this.gl!.MIRRORED_REPEAT)
    return S.pre
  }
  private grainTex(): Tex {
    const S = this.S!
    if (!S.grain) S.grain = this.mkTarget(this.w, this.h, this.fmt)
    return S.grain
  }

  /** ぼかしを描く段(0 = 全画面)。縮めた後のシグマが 2.5〜5px になる段(最低 1/2)。2.5px より小さければ全画面 */
  private levelFor(sigma: number): number {
    if (!(sigma >= FULL_RES_SIGMA)) return 0
    const L = Math.floor(Math.log2(sigma / 2.5))
    return Math.max(1, Math.min(this.S!.maxL, L))
  }

  private lut(p: SatsueiParams): WebGLTexture {
    const gl = this.gl!
    const key = colorKey(p)
    let t = this.luts.get(key)
    if (t) { this.luts.delete(key); this.luts.set(key, t); return t }          // 最近使った順
    const data = buildLut(p, LUT_N)
    t = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0 + U_SCRATCH)
    gl.bindTexture(gl.TEXTURE_3D, t)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, LUT_N, LUT_N, LUT_N, 0, gl.RGB, gl.FLOAT, data)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    this.luts.set(key, t)
    while (this.luts.size > MAX_LUTS) {
      const [k0, t0] = this.luts.entries().next().value as [string, WebGLTexture]
      gl.deleteTexture(t0); this.luts.delete(k0)
    }
    return t
  }

  // ── 描く ────────────────────────────────────────────────────────────
  private bind(unit: number, tex: WebGLTexture | null, target?: number) {
    const gl = this.gl!
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(target ?? gl.TEXTURE_2D, tex ?? this.dummy2)
  }

  private draw(target: Tex | null) {
    const gl = this.gl!
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb); gl.viewport(0, 0, target.w, target.h) }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.w, this.h) }
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** 縮めた絵の uv の倍率(画素の中心 + 0.5 に掛ける) */
  private scaleOf(t: Tex, L: number): [number, number] {
    const s = 2 ** L
    return [1 / (s * t.w), 1 / (s * t.h)]
  }

  /** 1 クリップぶんの全段。target = null なら画面へ(上下を返す)。k > 0 なら outA(または下の絵)と混ぜる */
  private runClip(spec: SatsueiSpec, mix: number, off: [number, number], f: number, target: Tex | null, k: number, prevSrc: boolean) {
    const gl = this.gl!, P = this.progs!
    const p = spec.params, L = p.lens, W = this.w, H = this.h, sc = H / 1080
    const i = spec.clipFrame
    // 空気
    let nP = 0
    for (const pa of p.para) {
      if (nP >= MAX_PARA || !(pa.amt > 0)) continue
      const dx = pa.to[0] - pa.from[0], dy = pa.to[1] - pa.from[1]
      const col = hexToRgb(pa.color), o4 = nP * 4
      const ft = this.paraFT, pc = this.paraCol, pm = this.paraMode
      ft[o4] = pa.from[0]; ft[o4 + 1] = pa.from[1]; ft[o4 + 2] = dx; ft[o4 + 3] = dy
      pc[o4] = col[0]; pc[o4 + 1] = col[1]; pc[o4 + 2] = col[2]; pc[o4 + 3] = pa.amt
      pm[o4] = pa.blend === 'multiply' ? 1 : pa.blend === 'normal' ? 2 : 0; pm[o4 + 1] = dx * dx + dy * dy + 1e-6
      nP++
    }
    let nL = 0
    for (const lk of leakEval(p, i)) {
      if (nL >= MAX_LEAKS || !(lk.a > 0)) continue
      const o4 = nL * 4, lp = this.leakPos, lc = this.leakCol
      lp[o4] = lk.cx; lp[o4 + 1] = lk.cy; lp[o4 + 2] = lk.rx; lp[o4 + 3] = lk.ry
      lc[o4] = lk.colLin[0]; lc[o4 + 1] = lk.colLin[1]; lc[o4 + 2] = lk.colLin[2]; lc[o4 + 3] = lk.a
      nL++
    }
    const diffOn = L.diffusion.amt > 0, bloomOn = L.bloom.amt > 0, halOn = L.halation.amt > 0
    // 共通の uniform(縮める 1 回目・前段・最後)
    let dScale: [number, number] = [0, 0], bScale: [number, number][] = [[0, 0], [0, 0], [0, 0]], hScale: [number, number] = [0, 0]
    let dTex: Tex | null = null, hTex: Tex | null = null
    const bTex: (Tex | null)[] = [null, null, null]
    const thrL = toLin(L.bloom.thr)
    const bDen = Math.max(1e-4, toLin(Math.min(1, L.bloom.thr + L.bloom.knee)) - thrL)
    const setStage = (pr: Prog) => {
      gl.useProgram(pr.p)
      const u = (n: string) => this.loc(pr, n)
      gl.uniform2i(u('uSrcOff'), off[0], off[1])
      gl.uniform2f(u('uSize'), W, H)
      gl.uniform1i(u('uParaN'), nP)
      if (nP) { gl.uniform4fv(u('uParaFT'), this.paraFT); gl.uniform4fv(u('uParaCol'), this.paraCol); gl.uniform4fv(u('uParaMode'), this.paraMode) }
      gl.uniform1i(u('uLeakN'), nL)
      if (nL) { gl.uniform4fv(u('uLeakPos'), this.leakPos); gl.uniform4fv(u('uLeakCol'), this.leakCol) }
      gl.uniform1f(u('uDiffAmt'), dTex ? L.diffusion.amt : 0)
      gl.uniform2f(u('uDiffScale'), dScale[0], dScale[1])
      gl.uniform1f(u('uBloomAmt'), bTex[2] ? L.bloom.amt : 0)
      gl.uniform3f(u('uBloomTint'), L.bloom.tint[0], L.bloom.tint[1], L.bloom.tint[2])
      gl.uniform1f(u('uBloomThrL'), thrL)
      gl.uniform1f(u('uBloomDen'), bDen)
      gl.uniform2f(u('uBScale0'), bScale[0][0], bScale[0][1])
      gl.uniform2f(u('uBScale1'), bScale[1][0], bScale[1][1])
      gl.uniform2f(u('uBScale2'), bScale[2][0], bScale[2][1])
      gl.uniform3f(u('uBW'), BLOOM_WEIGHTS[0], BLOOM_WEIGHTS[1], BLOOM_WEIGHTS[2])
      gl.uniform1f(u('uHalAmt'), hTex ? L.halation.amt : 0)
      gl.uniform1f(u('uHalThrL'), toLin(L.halation.thr))
      gl.uniform2f(u('uHalScale'), hScale[0], hScale[1])
      this.bind(U_SRC, this.srcTex)
      this.bind(U_DIFF, dTex?.tex ?? null)
      this.bind(U_B0, bTex[0]?.tex ?? null); this.bind(U_B1, bTex[1]?.tex ?? null); this.bind(U_B2, bTex[2]?.tex ?? null)
      this.bind(U_HAL, hTex?.tex ?? null)
      this.bind(U_PRE, null); this.bind(U_GRAIN, null); this.bind(U_PREV, null)
      this.bind(U_LUT, this.dummy3, gl.TEXTURE_3D)
    }
    // ぼかしの元: 1/2 へ縮める 1 回目(いちばん小さい段が全画面なら縮めずに全画面へ)→ 段々に upTo まで
    const pyramid = (mode: number, upTo: number, from = 1) => {
      setStage(P.down1)
      gl.uniform1i(this.loc(P.down1, 'uMode'), mode)
      gl.uniform1i(this.loc(P.down1, 'uFull'), from === 0 ? 1 : 0)
      this.draw(this.level(from === 0 ? 0 : 1))
      gl.useProgram(P.down.p)
      for (let l = from === 0 ? 1 : 2; l <= upTo; l++) {
        this.bind(U_TEX, this.level(l - 1).tex)
        this.draw(this.level(l))
      }
    }
    const blur = (Lv: number, sigmaFull: number, slot: string): Tex => {
      const s = sigmaFull / 2 ** Lv, r = radiusOf(s)
      const src = this.level(Lv), tmp = this.tmp(Lv), out = this.out(slot, Lv)
      gl.useProgram(P.blur.p)
      gl.uniform1f(this.loc(P.blur, 'uSigma'), Math.max(1e-3, s))
      gl.uniform1i(this.loc(P.blur, 'uRadius'), r)
      gl.uniform2i(this.loc(P.blur, 'uDir'), 1, 0)
      this.bind(U_TEX, src.tex); this.draw(tmp)
      gl.uniform2i(this.loc(P.blur, 'uDir'), 0, 1)
      this.bind(U_TEX, tmp.tex); this.draw(out)
      return out
    }
    if (diffOn) {
      const sg = L.diffusion.sigma * sc, Lv = this.levelFor(sg)
      pyramid(0, Lv, Lv === 0 ? 0 : 1)
      dTex = blur(Lv, sg, 'd'); dScale = this.scaleOf(dTex, Lv)
    }
    if (bloomOn) {
      const sgs = BLOOM_SIGMAS.map(s => s * sc), Lvs = sgs.map(s => this.levelFor(s))
      pyramid(1, Math.max(...Lvs), Math.min(...Lvs) === 0 ? 0 : 1)
      for (let j = 0; j < 3; j++) { bTex[j] = blur(Lvs[j], sgs[j], 'b' + j); bScale[j] = this.scaleOf(bTex[j]!, Lvs[j]) }
    }
    if (halOn) {
      const sg = L.halation.sigma * sc, Lv = this.levelFor(sg)
      pyramid(2, Lv, Lv === 0 ? 0 : 1)
      hTex = blur(Lv, sg, 'h'); hScale = this.scaleOf(hTex, Lv)
    }
    // 色ずれ(1920 幅基準の px → この幅)
    const caPx = L.ca * W / 1920
    const caOn = caPx > 1e-3
    let pre: Tex | null = null
    if (caOn) {
      pre = this.preTex()
      setStage(P.pre)
      this.draw(pre)
    }
    // 粒子
    const g = p.grain, grainOn = g.amt > 0
    const gs = 0.5 * g.size * H / 1080, gr = gs < 0.3 ? 0 : radiusOf(gs)
    const seed = (((spec.clipId * 1000003 + f) % 4294967296) + 4294967296) % 4294967296
    let gNorm = 1
    if (grainOn && gr > 0) {
      let sw = 0, s2 = 0
      for (let j = -gr; j <= gr; j++) { const wv = Math.exp(-0.5 * j * j / (gs * gs)); sw += wv; s2 += wv * wv }
      gNorm = (sw * sw) / s2            // ぼかした乱数の標準偏差 = Σk²(k は和 1)→ 1/Σk² で 1 に戻す
      const pr = P.grainH
      gl.useProgram(pr.p)
      gl.uniform1ui(this.loc(pr, 'uSeed'), seed)
      gl.uniform1f(this.loc(pr, 'uGSigma'), gs)
      gl.uniform1i(this.loc(pr, 'uGR'), gr)
      this.draw(this.grainTex())
    }
    // 最後
    const pr = P.final
    setStage(pr)
    const u = (n: string) => this.loc(pr, n)
    gl.uniform1i(u('uCA'), caOn ? 1 : 0)
    gl.uniform2f(u('uCAs'), 1 + caPx / W, 1 - caPx / W)
    gl.uniform1f(u('uVig'), L.vignette)
    const lutOn = !colorIsIdentity(p)
    gl.uniform1i(u('uLutOn'), lutOn ? 1 : 0)
    gl.uniform1f(u('uLutN'), LUT_N)
    gl.uniform1f(u('uGrainAmt'), grainOn ? g.amt : 0)
    gl.uniform1ui(u('uSeed'), seed)
    gl.uniform1f(u('uGSigma'), Math.max(1e-3, gs))
    gl.uniform1i(u('uGR'), grainOn ? gr : 0)
    gl.uniform1f(u('uGNorm'), gNorm)
    gl.uniform1f(u('uMix'), Math.max(0, Math.min(1, mix)))
    gl.uniform1f(u('uK'), k)
    gl.uniform1i(u('uPrevSrc'), prevSrc ? 1 : 0)
    gl.uniform1i(u('uFlip'), target ? 0 : 1)
    if (pre) this.bind(U_PRE, pre.tex)
    if (grainOn && gr > 0) this.bind(U_GRAIN, this.S!.grain!.tex)
    const outA = this.S!.outA
    if (k > 0 && !prevSrc && outA && outA !== target) this.bind(U_PREV, outA.tex)
    if (lutOn) this.bind(U_LUT, this.lut(p), gl.TEXTURE_3D)
    gl.useProgram(pr.p)
    this.draw(target)
  }
}
