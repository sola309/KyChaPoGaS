// 🎞 編集画面の欄を決める表(スキーマ)。
// エンジンが GET /api/comps/engine/schema.json を出していればそれを使い、無い・足りない所はこの内蔵の表(仕様 v1 の範囲)で補う。
// → エンジンにエフェクトやレイヤーの種類が増えても、編集画面を直さずに欄が出る。

import type { CompSchema, CompSettings, EffectDesc, Layer, LayerTypeDesc, Option, ParamDesc } from './types'
import { isObj } from './docOps'

const n = (label: string, dflt: number, extra: Partial<ParamDesc> = {}): ParamDesc =>
  ({ type: 'number', label, default: dflt, animatable: true, ...extra })
const col = (label: string, dflt: string | null, extra: Partial<ParamDesc> = {}): ParamDesc =>
  ({ type: 'color', label, default: dflt, animatable: true, ...extra })
const sel = (label: string, dflt: string, options: (string | [string, string])[], extra: Partial<ParamDesc> = {}): ParamDesc =>
  ({ type: 'select', label, default: dflt, options: options.map(o => (Array.isArray(o) ? { value: o[0], label: o[1] } : { value: o, label: o })), ...extra })

export const FONTS = [
  'Noto Sans JP', 'Noto Serif JP', 'Noto Sans CJK JP', 'Noto Serif CJK JP', 'Noto Sans Mono CJK JP',
  'sans-serif', 'serif', 'monospace',
]

const EASING_LIST: Option[] = [
  { value: 'linear', label: 'linear(一定)' },
  { value: 'hold', label: 'hold(止め)' },
  { value: 'easeIn', label: 'easeIn' },
  { value: 'easeOut', label: 'easeOut' },
  { value: 'easeInOut', label: 'easeInOut' },
  { value: 'easeInCubic', label: 'easeInCubic' },
  { value: 'easeOutCubic', label: 'easeOutCubic' },
  { value: 'easeInOutCubic', label: 'easeInOutCubic' },
  { value: 'easeOutBack', label: 'easeOutBack(行きすぎて戻る)' },
  { value: 'easeOutElastic', label: 'easeOutElastic(ばね)' },
  { value: 'easeOutBounce', label: 'easeOutBounce(はねる)' },
]

const BLEND_LIST: Option[] = [
  { value: 'normal', label: '通常' }, { value: 'add', label: '加算' }, { value: 'screen', label: 'スクリーン' },
  { value: 'multiply', label: '乗算' }, { value: 'overlay', label: 'オーバーレイ' }, { value: 'lighten', label: '比較(明)' },
  { value: 'darken', label: '比較(暗)' }, { value: 'difference', label: '差の絶対値' },
]

const EFFECTS: Record<string, EffectDesc> = {
  blur: { label: 'ぼかし', group: 'ぼかし・光', params: { radius: n('半径', 10, { min: 0, max: 400 }) } },
  glow: { label: 'グロー', group: 'ぼかし・光', params: {
    radius: n('半径', 20, { min: 0, max: 400 }), strength: n('強さ', 1, { min: 0, max: 10, step: 0.05 }),
    threshold: n('しきい値', 0.5, { min: 0, max: 1, step: 0.01 }) } },
  color: { label: '色調整', group: '色', params: {
    brightness: n('明るさ', 0, { min: -100, max: 100 }), contrast: n('コントラスト', 0, { min: -100, max: 100 }),
    saturation: n('彩度', 0, { min: -100, max: 100 }), hue: { type: 'angle', label: '色相', default: 0, animatable: true },
    tint: col('色かぶせ', null), tint_amount: n('色かぶせの量', 100, { min: 0, max: 100 }) } },
  rgb_shift: { label: 'RGB ずらし', group: 'ゆがみ', params: {
    amount: n('量', 4, { min: 0, max: 200 }), angle: { type: 'angle', label: '向き', default: 90, animatable: true } } },
  wave: { label: '波', group: 'ゆがみ', params: {
    amp: n('振幅', 10, { min: 0, max: 400 }), freq: n('細かさ', 4, { min: 0, max: 100, step: 0.1 }),
    speed: n('速さ', 1, { step: 0.1 }), phase: n('位相', 0, { step: 0.1 }) } },
  noise: { label: 'ノイズ', group: '質感', params: {
    amount: n('量', 10, { min: 0, max: 100 }), color: { type: 'bool', label: '色つき', default: false },
    animated: { type: 'bool', label: '毎コマ変える', default: true }, seed: n('種', 0, { step: 1, animatable: false }) } },
  mosaic: { label: 'モザイク', group: '質感', params: { size: n('大きさ', 16, { min: 1, max: 400 }) } },
  wipe: { label: 'ワイプ', group: '切り替え', params: {
    progress: n('進み(%)', 0, { min: 0, max: 100 }), angle: { type: 'angle', label: '向き', default: 90, animatable: true },
    feather: n('ぼかし幅', 0, { min: 0, max: 400 }) } },
  drop_shadow: { label: 'ドロップシャドウ', group: '縁・影', params: {
    distance: n('距離', 12, { min: 0, max: 400 }), angle: { type: 'angle', label: '向き', default: 135, animatable: true },
    blur: n('ぼかし', 12, { min: 0, max: 200 }), color: col('色', '#000000'), opacity: n('不透明度', 60, { min: 0, max: 100 }) } },
  stroke_outline: { label: '縁取り', group: '縁・影', params: {
    width: n('太さ', 4, { min: 0, max: 100 }), color: col('色', '#000000') } },
}

const ORDER_OPTS: [string, string][] = [['forward', '前から'], ['backward', '後ろから'], ['center', '中央から'], ['edges', '両端から'], ['random', 'ランダム']]

const LAYER_TYPES: Record<string, LayerTypeDesc> = {
  text: {
    label: 'テキスト', icon: '🔤',
    source: {
      text: { type: 'text', label: '文字', default: 'テキスト', group: '文字' },
      font: { type: 'font', label: 'フォント', default: 'Noto Sans JP', group: '文字' },
      weight: sel('太さ', '700', ['100', '300', '400', '500', '700', '900'], { group: '文字', numeric: true }),
      size: n('大きさ', 96, { min: 1, max: 2000, group: '文字' }),
      italic: { type: 'bool', label: '斜体', default: false, group: '文字' },
      fill: col('塗り', '#ffffff', { group: '色', nullable: true }),
      stroke: col('線', null, { group: '色', nullable: true }),
      stroke_width: n('線の太さ', 0, { min: 0, max: 200, group: '色' }),
      stroke_over: { type: 'bool', label: '線を塗りの上に', default: false, group: '色' },
      tracking: n('字間', 0, { group: '組み' }),
      leading: n('行送り(0 = 自動)', 0, { min: 0, group: '組み', animatable: false }),
      align: sel('そろえ', 'center', [['left', '左'], ['center', '中央'], ['right', '右']], { group: '組み' }),
      'per_char.stagger': n('ずらし(コマ)', 2, { min: 0, step: 0.5, group: '1 文字ずつ', animatable: false }),
      'per_char.duration': n('長さ(コマ)', 15, { min: 1, group: '1 文字ずつ', animatable: false }),
      'per_char.at': n('開始(レイヤー頭から)', 0, { min: 0, group: '1 文字ずつ', animatable: false }),
      'per_char.order': sel('順番', 'forward', ORDER_OPTS, { group: '1 文字ずつ' }),
      'per_char.e': { type: 'easing', label: 'イージング', default: 'easeOut', group: '1 文字ずつ' },
      'per_char.from.position': { type: 'vec2', label: '出る前の位置ずれ', default: [0, 0], group: '1 文字ずつ' },
      'per_char.from.scale': { type: 'vec2', label: '出る前の拡大', default: [100, 100], group: '1 文字ずつ' },
      'per_char.from.rotation': { type: 'angle', label: '出る前の回転', default: 0, group: '1 文字ずつ' },
      'per_char.from.opacity': n('出る前の不透明度', 100, { min: 0, max: 100, group: '1 文字ずつ', animatable: false }),
    },
    default_source: { text: 'テキスト', font: 'Noto Sans JP', weight: 700, size: 96, fill: '#ffffff', align: 'center' },
  },
  shape: {
    label: 'シェイプ', icon: '🔷',
    source: {
      kind: sel('形', 'rect', [['rect', '四角'], ['ellipse', '円・楕円'], ['polygon', '多角形'], ['star', '星'], ['line', '線'], ['path', 'パス']], { group: '形' }),
      width: n('幅', 300, { min: 0, group: '形' }),
      height: n('高さ', 300, { min: 0, group: '形' }),
      radius: n('角丸', 0, { min: 0, group: '形' }),
      sides: n('角の数', 5, { min: 3, max: 64, step: 1, group: '形' }),
      inner: n('内径の比(星)', 0.5, { min: 0, max: 1, step: 0.01, group: '形' }),
      points: { type: 'json', label: '点(線・パス)', group: '形' },
      closed: { type: 'bool', label: '閉じる', default: false, group: '形' },
      fill: col('塗り', '#ffffff', { group: '色', nullable: true }),
      stroke: col('線', null, { group: '色', nullable: true }),
      stroke_width: n('線の太さ', 0, { min: 0, max: 400, group: '色' }),
      cap: sel('線の端', 'butt', [['butt', '切り'], ['round', '丸'], ['square', '四角']], { group: '色' }),
      join: sel('線の角', 'miter', [['miter', 'とがり'], ['round', '丸'], ['bevel', '面取り']], { group: '色' }),
      trim: { type: 'vec2', label: 'トリム(%)', default: [0, 100], animatable: true, group: '線の表示' },
      trim_offset: n('トリムのずれ(%)', 0, { group: '線の表示' }),
    },
    default_source: { kind: 'rect', width: 400, height: 300, fill: '#4f9dff' },
  },
  solid: {
    label: '平面', icon: '⬛',
    source: { color: col('色', '#3b82f6'), width: n('幅', 1920, { min: 1, animatable: false }), height: n('高さ', 1080, { min: 1, animatable: false }) },
    default_source: { color: '#3b82f6' },
  },
  image: { label: '画像', icon: '🖼', source: { asset_id: { type: 'asset', label: '素材', kind: 'image' }, url: { type: 'text', label: 'URL(素材の代わり)' } } },
  video: { label: '動画', icon: '🎬', source: { asset_id: { type: 'asset', label: '素材', kind: 'video' } } },
  null: { label: 'ヌル(親用)', icon: '✛', source: {} },
  camera: {
    label: 'カメラ', icon: '🎥',
    source: {
      fov: n('画角(水平・度)', 39.6, { min: 1, max: 170 }),
      zoom: n('ズーム(px。画角の代わり)', 0, { min: 0 }),
      target: { type: 'vec3', label: '注視点', default: [960, 540, 0], animatable: true },
    },
    default_source: { fov: 39.6 },
    default_layer: { three_d: true },
  },
  adjustment: { label: '調整レイヤー', icon: '🎚', source: {} },
  particles: {
    label: 'パーティクル', icon: '✨',
    source: {
      seed: n('種', 1, { step: 1, animatable: false }),
      'emitter.position': { type: 'vec2', label: '出る位置', default: [0, 0], animatable: true, group: '発生' },
      'emitter.area': { type: 'vec3', label: '出る範囲', default: [0, 0, 0], group: '発生' },
      'emitter.rate': n('毎秒の数', 60, { min: 0, group: '発生' }),
      'emitter.burst': n('最初に一度に出す数', 0, { min: 0, step: 1, group: '発生', animatable: false }),
      'emitter.life': n('寿命(秒)', 2, { min: 0.01, step: 0.1, group: '発生', animatable: false }),
      'emitter.life_random': n('寿命のばらつき', 0, { min: 0, max: 1, step: 0.01, group: '発生', animatable: false }),
      'emitter.speed': n('速さ', 300, { group: '動き' }),
      'emitter.speed_random': n('速さのばらつき', 0, { min: 0, max: 1, step: 0.01, group: '動き', animatable: false }),
      'emitter.direction': { type: 'angle', label: '向き(0 = 上)', default: 0, group: '動き', animatable: true },
      'emitter.spread': n('広がり(度)', 360, { min: 0, max: 360, group: '動き' }),
      'emitter.z_speed': n('奥行きの速さ', 0, { group: '動き', animatable: false }),
      'emitter.gravity': { type: 'vec3', label: '重力', default: [0, 0, 0], group: '動き' },
      'emitter.drag': n('空気抵抗', 0, { min: 0, step: 0.1, group: '動き', animatable: false }),
      'emitter.spin': n('回転(度/秒)', 0, { group: '動き', animatable: false }),
      'emitter.size': { type: 'vec2', label: '大きさ(始・終)', default: [20, 4], group: '見た目' },
      'emitter.size_random': n('大きさのばらつき', 0, { min: 0, max: 1, step: 0.01, group: '見た目', animatable: false }),
      'emitter.color': { type: 'colors', label: '色(始・終)', default: ['#ffffff', '#ffffff'], group: '見た目' },
      'emitter.opacity': { type: 'vec2', label: '不透明度(始・終)', default: [100, 0], group: '見た目' },
      'emitter.sprite': sel('粒の形', 'soft', [['soft', 'ぼけ玉'], ['circle', '丸'], ['square', '四角'], ['star', '星'], ['spark', '火花']], { group: '見た目' }),
      'emitter.blend': sel('重ね方', 'add', [['add', '加算'], ['normal', '通常']], { group: '見た目' }),
    },
    default_source: {
      seed: 1,
      emitter: { position: [0, 0], rate: 80, life: 2, speed: 400, speed_random: 0.4, direction: 0, spread: 40, gravity: [0, 500, 0],
        size: [18, 4], color: ['#ffffff', '#7cc4ff'], opacity: [100, 0], sprite: 'soft', blend: 'add' },
    },
  },
  comp: { label: 'コンポジション', icon: '🎞', source: { comp_id: { type: 'comp', label: '中身' } } },
  model: {
    label: '3D モデル(GLB)', icon: '🧊',
    source: {
      asset_id: { type: 'asset', label: '素材', kind: 'model3d' },
      height: n('高さ(px)', 400, { min: 1 }),
      'light.intensity': n('光の強さ', 1, { min: 0, step: 0.05, group: '光' }),
      'light.ambient': n('環境光', 0.5, { min: 0, step: 0.05, group: '光' }),
      'light.color': col('光の色', '#ffffff', { group: '光' }),
      'light.direction': { type: 'vec3', label: '光の向き', default: [0.5, -1, 0.5], group: '光' },
    },
    default_layer: { three_d: true },
  },
}

export const BUILTIN_SCHEMA: CompSchema = {
  version: 1,
  effects: EFFECTS,
  layer_types: LAYER_TYPES,
  layer_common: {},
  blend_modes: BLEND_LIST,
  easings: EASING_LIST,
  presets: { layer: [], text: [] },
}

const optList = (v: unknown, fb: Option[]): Option[] => {
  if (!Array.isArray(v) || !v.length) return fb
  const out = v.map(o => (isObj(o) && o.value != null ? { value: String(o.value), label: typeof o.label === 'string' ? o.label : String(o.value) }
    : typeof o === 'string' ? { value: o, label: o } : null)).filter((o): o is { value: string; label: string } => !!o)
  return out.length ? out : fb
}

/** 取ってきたスキーマを内蔵の表に重ねる。節が無い・形が違うときは内蔵のまま */
export function mergeSchema(remote: unknown): CompSchema {
  const b = BUILTIN_SCHEMA
  if (!isObj(remote)) return b
  const rec = <T,>(v: unknown, fb: Record<string, T>): Record<string, T> => {
    if (!isObj(v)) return fb
    const out: Record<string, T> = { ...fb }
    for (const [k, d] of Object.entries(v)) if (isObj(d)) out[k] = d as T
    return out
  }
  const pr = isObj(remote.presets) ? remote.presets : {}
  const plist = (v: unknown) => (Array.isArray(v) ? v.filter(p => isObj(p) && typeof p.id === 'string') : []) as CompSchema['presets']['layer']
  return {
    version: typeof remote.version === 'number' ? remote.version : b.version,
    effects: rec(remote.effects, b.effects),
    layer_types: rec(remote.layer_types, b.layer_types),
    layer_common: rec(remote.layer_common, b.layer_common),
    blend_modes: optList(remote.blend_modes, b.blend_modes),
    easings: optList(remote.easings, b.easings),
    presets: { layer: plist(pr.layer), text: plist(pr.text) },
  }
}

let schemaPromise: Promise<CompSchema> | null = null
/** 編集画面を開いたときに 1 回だけ取る(404・壊れた JSON は内蔵の表) */
export function loadSchema(force = false): Promise<CompSchema> {
  if (!schemaPromise || force) {
    schemaPromise = fetch('/api/comps/engine/schema.json', { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : null))
      .then(mergeSchema)
      .catch(() => BUILTIN_SCHEMA)
  }
  return schemaPromise
}

let fontsPromise: Promise<string[]> | null = null
/** フォントの一覧。エンジン側の GET /api/comps/fonts があれば足す(形が違えば内蔵の短い一覧だけ) */
export function loadFonts(): Promise<string[]> {
  if (!fontsPromise) {
    fontsPromise = fetch('/api/comps/fonts')
      .then(r => (r.ok ? r.json() : []))
      .then((v: unknown) => {
        const arr = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.fonts) ? v.fonts : []
        const names = arr.map(x => (typeof x === 'string' ? x : isObj(x) ? (x.family ?? x.name ?? x.label) : null))
          .filter((x): x is string => typeof x === 'string' && !!x)
        return [...new Set([...FONTS, ...names])]
      })
      .catch(() => FONTS)
  }
  return fontsPromise
}

export const typeIcon = (schema: CompSchema, type: string) => schema.layer_types[type]?.icon ?? '▫'
export const typeLabel = (schema: CompSchema, type: string) => schema.layer_types[type]?.label ?? type

/** シェイプの形ごとの初期値(追加メニュー用) */
export const SHAPE_KINDS: { kind: string; label: string; source: Record<string, unknown> }[] = [
  { kind: 'rect', label: '四角', source: { kind: 'rect', width: 400, height: 300, radius: 0, fill: '#4f9dff' } },
  { kind: 'ellipse', label: '円・楕円', source: { kind: 'ellipse', width: 300, height: 300, fill: '#ff6b9d' } },
  { kind: 'polygon', label: '多角形', source: { kind: 'polygon', width: 300, height: 300, sides: 6, fill: '#7cff6b' } },
  { kind: 'star', label: '星', source: { kind: 'star', width: 320, height: 320, sides: 5, inner: 0.45, fill: '#ffd23f' } },
  { kind: 'line', label: '線', source: { kind: 'line', points: [[-250, 0], [250, 0]], stroke: '#ffffff', stroke_width: 8, fill: null, cap: 'round' } },
]

/** 新しいレイヤーの初期値。スキーマの default_layer / default_source を使い、位置は画面の中央 */
export function newLayer(schema: CompSchema, type: string, id: string, s: CompSettings, over: Partial<Layer> = {}): Layer {
  const d = schema.layer_types[type]
  const clone = <T,>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)))
  const base: Layer = {
    id, name: d?.label ?? type, type, in: 0, out: s.duration_frames,
    visible: true, blend: 'normal',
    transform: { position: [s.width / 2, s.height / 2], scale: [100, 100], rotation: 0, opacity: 100 },
    effects: [],
  }
  if (type === 'camera') base.transform = {}                 // 位置を書かない = 既定のカメラの位置
  if (type === 'adjustment' || type === 'null') base.transform = type === 'null' ? base.transform : {}
  if (type === 'video' || type === 'comp') { base.start = 0; base.speed = 1 }
  const src = clone(d?.default_source)
  if (src && Object.keys(src).length) base.source = src
  const dl = clone(d?.default_layer) ?? {}
  const merged: Layer = { ...base, ...dl, ...over, id, type }
  if (dl.transform && isObj(dl.transform)) merged.transform = { ...base.transform, ...(dl.transform as object), ...(over.transform ?? {}) }
  if (over.source || src) merged.source = { ...(src ?? {}), ...(over.source ?? {}) }
  return merged
}

/** エフェクトの初期値(スキーマの default を並べる。null の default は書かない) */
export function newEffect(schema: CompSchema, type: string) {
  const params: Record<string, unknown> = {}
  for (const [k, d] of Object.entries(schema.effects[type]?.params ?? {})) {
    if (d.default !== undefined && d.default !== null && !k.includes('.')) params[k] = JSON.parse(JSON.stringify(d.default))
  }
  return { type, enabled: true, params }
}

/** グループ名ごとにまとめる(順番は出てきた順) */
export function groupBy<T>(items: [string, T][], groupOf: (v: T) => string | undefined): [string, [string, T][]][] {
  const map = new Map<string, [string, T][]>()
  for (const it of items) {
    const g = groupOf(it[1]) ?? ''
    if (!map.has(g)) map.set(g, [])
    map.get(g)!.push(it)
  }
  return [...map.entries()]
}
