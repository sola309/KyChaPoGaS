// 🎞 コンポジション文書の型(docs/composition-design.md)。
// 手書き・AI が書いた文書も開けるよう、ほとんどの項目は省略可。知らない項目は [k: string]: unknown で持ち回り、保存で落とさない。

export type Easing = string | [number, number, number, number]

export interface Keyframe {
  f: number
  v: unknown
  e?: Easing
  [k: string]: unknown
}

export interface Wiggle { freq?: number; amp?: number | number[]; seed?: number; [k: string]: unknown }

/** キーフレームつきのプロパティ値。{v, wiggle}(定数に揺れだけ足す)もこの形 */
export interface AnimProp {
  k?: Keyframe[]
  v?: unknown
  loop?: 'cycle' | 'pingpong' | null
  wiggle?: Wiggle | null
  [k: string]: unknown
}

/** プロパティ値: 定数(数・配列・色の文字列など)か AnimProp */
export type PropValue = number | string | boolean | null | unknown[] | AnimProp | { [k: string]: unknown }

export interface Transform {
  position?: PropValue
  anchor?: PropValue
  scale?: PropValue
  rotation?: PropValue
  opacity?: PropValue
  [k: string]: unknown
}

export interface Effect {
  type: string
  enabled?: boolean
  params?: Record<string, unknown>
  [k: string]: unknown
}

export interface Mask {
  shape?: string
  x?: PropValue; y?: PropValue; w?: PropValue; h?: PropValue
  points?: unknown
  feather?: PropValue
  invert?: boolean
  opacity?: PropValue
  [k: string]: unknown
}

export interface Matte { layer: string; mode?: string; [k: string]: unknown }

export interface Layer {
  id: string
  name?: string
  type: string
  in?: number
  out?: number
  start?: number
  speed?: number
  visible?: boolean
  locked?: boolean
  solo?: boolean
  parent?: string | null
  three_d?: boolean
  blend?: string
  matte?: Matte | null
  masks?: Mask[]
  transform?: Transform
  source?: Record<string, unknown>
  effects?: Effect[]
  motion_blur?: boolean | number
  [k: string]: unknown
}

export interface CompDoc {
  version?: number
  bg?: string | null
  layers: Layer[]
  [k: string]: unknown
}

/** 大きさ・長さ(文書の外。API の列) */
export interface CompSettings {
  width: number
  height: number
  fps: number
  duration_frames: number
}

/** GET /api/comps/?project_id= の 1 行(data なし) */
export interface CompSummary extends CompSettings {
  id: number
  project_id: number
  name: string
  rev: number
  rendered_rev: number
  rendered_asset_id: number | null
  stale: boolean
  updated_at: string | null
  layer_count?: number
}

export interface CompFull extends CompSummary {
  data: CompDoc
}

/** キーフレーム 1 個の指し方 */
export interface KeyRef { layerId: string; path: string; f: number }

// ── スキーマ(GET /api/comps/engine/schema.json。無ければ schema.ts の内蔵の表) ──

export interface ParamDesc {
  type: string            // number | color | bool | select | vec2 | vec3 | text | angle | percent | …(知らない型は JSON 欄)
  label?: string
  default?: unknown
  min?: number
  max?: number
  step?: number
  options?: { value: string | number; label?: string }[]
  animatable?: boolean
  group?: string
  [k: string]: unknown
}

export interface EffectDesc { label?: string; group?: string; params?: Record<string, ParamDesc> }
export interface LayerTypeDesc {
  label?: string
  icon?: string
  source?: Record<string, ParamDesc>
  default_source?: Record<string, unknown>
  default_layer?: Record<string, unknown>
}
export interface PresetDesc { id: string; label?: string; group?: string; apply?: Record<string, unknown> }
export interface Option { value: string; label?: string }

export interface CompSchema {
  version?: number
  effects: Record<string, EffectDesc>
  layer_types: Record<string, LayerTypeDesc>
  layer_common: Record<string, ParamDesc>
  blend_modes: Option[]
  easings: Option[]
  presets: { layer: PresetDesc[]; text: PresetDesc[] }
}
