import axios from 'axios'
import type { AxiosRequestConfig } from 'axios'
import { useUIStore } from '../store/uiStore'
import type { SatsueiMeta } from '../components/Preview/satsueiLook'

export const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
})

// Track edit-writes (for the auto-save indicator) and surface errors as toasts.
const WRITE_METHODS = new Set(['post', 'patch', 'put', 'delete'])
const isEditWrite = (cfg: { method?: string; url?: string }) =>
  WRITE_METHODS.has((cfg.method ?? '').toLowerCase()) &&
  /\/(clips|tracks|projects)\b/.test(cfg.url ?? '')

api.interceptors.request.use(cfg => {
  if (isEditWrite(cfg)) useUIStore.getState().beginWrite()
  return cfg
})
api.interceptors.response.use(
  res => { if (isEditWrite(res.config)) useUIStore.getState().endWrite(); return res },
  err => {
    if (err?.config && isEditWrite(err.config)) useUIStore.getState().endWrite()
    const detail = err?.response?.data?.detail
    const msg = typeof detail === 'string' ? detail : (err?.message ?? '通信エラー')
    if (!err?.config?.__silent) useUIStore.getState().pushToast(msg, 'error')
    return Promise.reject(err)
  },
)

export interface Project {
  id: number
  name: string
  description: string | null
  folder?: string | null
  fps: number
  width: number
  height: number
  created_at: string
  updated_at: string
}

export interface ProjectCreate {
  name: string
  description?: string
  fps?: number
  width?: number
  height?: number
}

export interface Asset {
  id: number
  project_id: number
  name: string
  asset_type: 'video' | 'audio' | 'image' | 'generated' | 'model3d'
  file_path: string
  duration_sec: number | null
  width: number | null
  height: number | null
  file_size_bytes: number | null
  proxy_path: string | null
  starred?: boolean
  gen_params_json?: string
  created_at: string
}

export const projectsApi = {
  list:   () => api.get<Project[]>('/projects/').then(r => r.data),
  create: (data: ProjectCreate) => api.post<Project>('/projects/', data).then(r => r.data),
  get:    (id: number) => api.get<Project>(`/projects/${id}`).then(r => r.data),
  delete: (id: number) => api.delete(`/projects/${id}`),
  /** 生成単位のプロンプト全文。単位を開いたときだけ取りに来る(数百KBあるため) */
  unitPrompt: (id: number, unitId: string) =>
    api.get<UnitPrompt>(`/projects/${id}/unit-prompt/${unitId}`).then(r => r.data),
}

export interface UnitPrompt {
  unit: string
  raw: string        // プレースホルダのまま(名簿の記述が {{HOMU_ID}} 等で入る)
  expanded: string   // 展開後 = H3へ実際に渡る文面
  words: number
  error?: string
}

export interface Track {
  id: number
  project_id: number
  name: string
  track_type: 'video' | 'audio' | 'reference'
  order: number
  hidden?: boolean
  /** レイヤーの配置(コンポジション)。JSON文字列 {x,y,w,h,fit}。空なら全画面 */
  layout_json?: string
}

export type TransitionType = '' | 'cross' | 'white' | 'black'
/** Speed accel curve: preset or custom bezier control points */
export type SpeedEase = 'linear' | 'in' | 'out' | 'inout' | `cubic:${string}`

export interface Clip {
  id: number
  track_id: number
  asset_id: number | null
  start_frame: number
  duration_frames: number
  asset_in_frame: number
  speed: number
  speed_ease: SpeedEase
  /** Transition into this clip: '' cut | crossfade | white flash | dip to black */
  transition_in: TransitionType
  transition_frames: number
  /** 重なり遷移のカーブ(linear/ease/ease-in/ease-out)と、白/黒遷移で完全に色になる位置(0..1) */
  transition_ease?: string
  transition_hold?: number
  /** Audio fades (audio clips), in timeline frames */
  fade_in_frames: number
  fade_out_frames: number
  /** Compositing (clips on video tracks above the first overlay onto it) */
  opacity: number
  blend: 'normal' | 'screen' | 'add' | 'multiply'
  /** Animated zoom/pan/shake: preset name or keyframe JSON ('' = none) */
  transform_json: string
  /** 'media' (plain asset) | 'mg_shot' (mad-kit shot — double-click opens the Shot Editor) */
  kind: string
  /** JSON side-data for special kinds (mg_shot: {"shot_id": ...}) */
  attrs_json: string
  /** コマ打ち(アニメ風ホールド): 0=off, 12=2コマ, 8=3コマ */
  posterize_fps: number
  remap_json?: string
  locked?: boolean
}

export interface ClipUpdate {
  start_frame?: number
  duration_frames?: number
  asset_in_frame?: number
  asset_id?: number | null
  track_id?: number
  speed?: number
  speed_ease?: SpeedEase
  transition_in?: TransitionType
  transition_frames?: number
  transition_ease?: string
  transition_hold?: number
  fade_in_frames?: number
  fade_out_frames?: number
  opacity?: number
  blend?: Clip['blend']
  transform_json?: string
  attrs_json?: string
  posterize_fps?: number
  remap_json?: string
  locked?: boolean
}

// extras are optional on create (backend defaults)
export type ClipCreate = Omit<Clip, 'id' | 'speed' | 'speed_ease' | 'transition_in'
  | 'transition_frames' | 'fade_in_frames' | 'fade_out_frames' | 'opacity' | 'blend' | 'transform_json'
  | 'kind' | 'attrs_json' | 'posterize_fps' | 'remap_json'>
  & Partial<Pick<Clip, 'speed' | 'speed_ease' | 'transition_in' | 'transition_frames'
  | 'fade_in_frames' | 'fade_out_frames' | 'opacity' | 'blend' | 'transform_json' | 'kind' | 'attrs_json' | 'posterize_fps' | 'remap_json'>>

export const tracksApi = {
  list:   (projectId: number) =>
    api.get<Track[]>('/tracks/', { params: { project_id: projectId } }).then(r => r.data),
  create: (data: Omit<Track, 'id'>) => api.post<Track>('/tracks/', data).then(r => r.data),
  update: (id: number, data: { name?: string; order?: number; hidden?: boolean; layout_json?: string }) =>
    api.patch<Track>(`/tracks/${id}`, null, { params: data }).then(r => r.data),
  delete: (id: number) => api.delete(`/tracks/${id}`),
  /** Scenes枠をカット割りへ同期(空カットへ枠を敷き、ピン移動に追従させる) */
  scenesSync: (projectId: number) =>
    api.post<{ cuts: number; moved: number; bound: number; created: number }>(
      '/tracks/scenes-sync', null, { params: { project_id: projectId } }).then(r => r.data),
  /** 比較表示: 2つの映像トラックを画面の左右に並べる(enable=false で全画面に戻す) */
  compareLayout: (projectId: number, enable: boolean, leftId?: number, rightId?: number) =>
    api.post('/tracks/compare-layout', null, {
      params: { project_id: projectId, enable, left_track_id: leftId, right_track_id: rightId },
    }).then(r => r.data),
}

export const clipsApi = {
  list:   (projectId: number) =>
    api.get<Clip[]>('/clips/', { params: { project_id: projectId } }).then(r => r.data),
  create: (data: ClipCreate) => api.post<Clip>('/clips/', data).then(r => r.data),
  update: (id: number, data: ClipUpdate) => api.patch<Clip>(`/clips/${id}`, data).then(r => r.data),
  delete: (id: number) => api.delete(`/clips/${id}`),
  autoCutBeats: (id: number) =>
    api.post<{ created: number; cut_frames?: number[]; message?: string }>(`/clips/${id}/auto-cut-beats`).then(r => r.data),
  scatterBeatEffects: (projectId: number, effect: 'flash' | 'punch', every: 'downbeat' | 'beat' = 'downbeat') =>
    api.post<{ count: number; applied_at_frames?: number[]; error?: string }>(
      '/clips/scatter-beat-effects', null, { params: { project_id: projectId, effect, every } }).then(r => r.data),
}

// ── 🎬 撮影レイヤー(backend app/routers/satsuei.py。式は app/services/satsuei_fx.py) ─────────
// 失敗は撮影パネルの中で知らせるので、共通のエラートーストは出さない(__silent)

const silentCfg = { __silent: true } as unknown as AxiosRequestConfig

/** 下の絵の中の切り替わり(タイムラインのコマ)。hard = パッと替わる / dissolve = 溶けて替わる / wipe = 一部から替わる */
export type SatsueiTransition =
  | { kind: 'hard'; at: number; clip_id?: number }
  | { kind: 'dissolve' | 'wipe'; t0: number; t1: number; fit?: number | null; clip_id?: number }

export interface SatsueiDetectBody { track_id: number; start_frame: number; duration_frames: number; k?: number }
export interface SatsueiDetectResult {
  transitions: SatsueiTransition[]
  /** 下の絵のクリップが替わるコマ(範囲の内側だけ) */
  clip_bounds: number[]
  range?: [number, number]
  pieces?: { start_frame: number; end_frame: number; clip_id: number; asset_id: number }[]
}
export interface SatsueiLayBody {
  track_id: number
  start_frame?: number          // 省けば下の絵のクリップ全体
  duration_frames?: number
  preset: string
  auto_fit?: boolean
  split?: boolean
  replace?: boolean
}
export interface SatsueiLayResult { created: Clip[]; deleted: number[]; transitions?: SatsueiTransition[]; range?: [number, number] }
/** 絵の数値(暗部 5%・中間・明部 95%・彩度・白の面積 %・影の色 B−R) */
export interface SatsueiStats { y05: number; y50: number; y95: number; sat: number; white: number; shadowBR: number }
export interface SatsueiAutofitBody { preset?: string; frame?: number; target?: [number, number] }
export interface SatsueiAutofitResult { params: Record<string, unknown>; before: SatsueiStats; after: SatsueiStats; frame: number }
export type SatsueiUserPresets = Record<string, Record<string, unknown>>

/** 既定値・範囲・プリセット(プリセットの正はここ) */
export const getSatsueiMeta = () =>
  api.get<SatsueiMeta>('/satsuei/meta', silentCfg).then(r => r.data)
/** 範囲の下の絵の切り替わりを探す(書き込まない) */
export const detectSatsuei = (body: SatsueiDetectBody) =>
  api.post<SatsueiDetectResult>('/satsuei/detect', body, silentCfg).then(r => r.data)
/** 範囲(既定 = 下の絵のクリップ全体)に撮影クリップを敷く */
export const laySatsuei = (body: SatsueiLayBody) =>
  api.post<SatsueiLayResult>('/satsuei/lay', body, silentCfg).then(r => r.data)
/** このクリップを自動で合わせた設定の案(書き込まない) */
export const autofitSatsuei = (clipId: number, body: SatsueiAutofitBody = {}) =>
  api.post<SatsueiAutofitResult>(`/satsuei/clips/${clipId}/autofit`, body, silentCfg).then(r => r.data)
/** 書き出しと同じ計算(Python)の 1 コマ(JPEG)。frame = タイムラインのコマ */
export const satsueiStillUrl = (clipId: number, frame?: number | null, w = 960) =>
  `/api/satsuei/clips/${clipId}/still?${frame != null ? `frame=${Math.round(frame)}&` : ''}w=${Math.round(w)}&_=${Date.now()}`
/** 自分で保存したプリセット(名前 → 設定) */
export const getSatsueiUserPresets = () =>
  api.get<{ presets: SatsueiUserPresets }>('/satsuei/user-presets', silentCfg).then(r => r.data.presets ?? {})
/** 自分で保存したプリセットをまとめて置き換える */
export const putSatsueiUserPresets = (presets: SatsueiUserPresets) =>
  api.put<{ presets: SatsueiUserPresets }>('/satsuei/user-presets', { presets }, silentCfg).then(r => r.data.presets ?? {})

/**
 * クリップの PATCH(撮影パネルのつまみの保存)。消したクリップ(404 = 消した直後に届いた保存)には
 * エラーのトーストを出さない。ほかの失敗はいつもどおりトーストを出して投げる
 */
export async function updateClipQuiet(id: number, data: ClipUpdate): Promise<Clip> {
  try {
    return (await api.patch<Clip>(`/clips/${id}`, data, silentCfg)).data
  } catch (e) {
    const err = e as { response?: { status?: number; data?: { detail?: unknown } }; message?: string }
    if (err?.response?.status !== 404) {
      const detail = err?.response?.data?.detail
      useUIStore.getState().pushToast(typeof detail === 'string' ? detail : (err?.message ?? '通信エラー'), 'error')
    }
    throw e
  }
}
/** ページを閉じる・読み直す最中のクリップの PATCH(keepalive: ページが消えても送り切る。返事は待てない) */
export function patchClipKeepalive(id: number, data: ClipUpdate) {
  try {
    void fetch(`${api.defaults.baseURL ?? '/api'}/clips/${id}`, {
      method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }).catch(() => undefined)
  } catch { /* 送れない端末は諦める */ }
}

/** 実態ベースの種別: generatedも動画/画像に振り分ける(UI表示・フィルタ用) */
export const assetKind = (a: Asset): 'video' | 'image' | 'audio' | 'model3d' => {
  if (a.asset_type === 'audio') return 'audio'
  if (a.asset_type === 'model3d' || /\.(glb|gltf)$/i.test(a.name)) return 'model3d'
  if ((a.duration_sec ?? 0) > 0 || /\.(mp4|webm|mov)$/i.test(a.name)) return 'video'
  return 'image'
}

export const assetsApi = {
  list:         (projectId?: number) =>
    api.get<Asset[]>('/assets/', { params: projectId ? { project_id: projectId } : {} }).then(r => r.data),
  get:          (id: number) => api.get<Asset>(`/assets/${id}`).then(r => r.data),
  delete:       (id: number) => api.delete(`/assets/${id}`),
  upload:       (projectId: number, file: File) => {
    const form = new FormData()
    form.append('project_id', String(projectId))
    form.append('file', file)
    return api.post<Asset>('/assets/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },
  thumbnailUrl: (assetId: number) => `/api/assets/${assetId}/thumbnail`,
  // 🗂 カット割り編集後にテイクの紐付けを現在のカット開始へ寄せ直す
  remapTakes: (projectId: number, starts: number[], tolerance = 24) =>
    api.post<{ updated: number }>('/assets/remap-takes',
      { project_id: projectId, starts, tolerance }).then(r => r.data),
  filmstripUrl: (assetId: number, count?: number) => `/api/assets/${assetId}/filmstrip${count ? `?count=${count}` : ''}`,
  fileUrl:      (assetId: number, useProxy = false) =>
    `/api/assets/${assetId}/file${useProxy ? '?proxy=1' : ''}`,
  /** 保存用: Content-Disposition: attachment を付けて元ファイルを返す */
  downloadUrl:  (assetId: number) => `/api/assets/${assetId}/file?download=1`,
  extractFrame: (assetId: number, timeSec: number, longEdge?: number) =>
    api.post<Asset>(`/assets/${assetId}/extract-frame`, null, { params: { time_sec: timeSec, ...(longEdge ? { long_edge: longEdge } : {}) } }).then(r => r.data),
  framePreviewUrl: (assetId: number, timeSec: number, height = 360) =>
    `/api/assets/${assetId}/frame-preview?time_sec=${timeSec.toFixed(3)}&height=${height}`,
  extractAudio: (assetId: number) =>
    api.post<Asset>(`/assets/${assetId}/extract-audio`).then(r => r.data),
  /** h3Grid=true: 出力フレーム数を 17k+5 に合わせて後ろへ実フレームを伸ばす(H3 が参照の末尾を捨てない) */
  extractClip: (assetId: number, startSec: number, durSec: number, endSec?: number, padToSec?: number, h3Grid?: boolean) =>
    api.post<Asset>(`/assets/${assetId}/extract-clip`, null, {
      params: {
        start_sec: startSec, dur_sec: durSec,
        ...(endSec != null ? { end_sec: endSec } : {}),
        ...(padToSec != null ? { pad_to_sec: padToSec } : {}),
        ...(h3Grid ? { h3_grid: true } : {}),
      },
    }).then(r => r.data),
  separateVocals: (assetId: number) =>
    api.post<{ job_id: number }>(`/assets/${assetId}/separate-vocals`).then(r => r.data),
  toggleStar: (assetId: number) =>
    api.post<Asset>(`/assets/${assetId}/star`).then(r => r.data),
  makeProxy:    (assetId: number) =>
    api.post<{ job_id: number; status: string }>(`/assets/${assetId}/proxy`).then(r => r.data),
}

// ── Job types ─────────────────────────────────────────────────────────────────

export type JobType   = 'render_final' | 'generate_image' | 'generate_audio' | 'generate_video_i2v' | 'precompose' | 'create_proxy' | 'render_motion_graphics' | 'analyze_audio' | 'analyze_video' | 'decompose_character'
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Job {
  id: number
  project_id: number
  job_type: JobType
  status: JobStatus
  params: Record<string, unknown>
  result_asset_ids: number[]
  progress: number
  phase?: string
  error_msg: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface I2VKeyframe  { time_sec: number; asset_id: number }
export interface PlaceSpec       { track_id: number; start_frame: number; duration_frames?: number; replace_clip_id?: number }
export interface ImageGenParams  { project_id: number; prompt: string; negative_prompt?: string; model?: string; width?: number; height?: number; seed?: number; init_asset_id?: number; denoise?: number; ref_asset_ids?: number[]; use_lightning?: boolean; loras?: [string, number][]; place?: PlaceSpec }
export interface AudioGenParams  { project_id: number; prompt: string; lyrics?: string; duration_sec?: number; vocal_language?: string; instrumental?: boolean | null; model?: string; seed?: number }
export interface VideoI2VParams  { project_id: number; keyframes: I2VKeyframe[]; duration_sec?: number; fps?: number; motion_strength?: number; model?: string; seed?: number; prompt?: string; negative_prompt?: string; width?: number; height?: number; use_lightning?: boolean; steps?: number; ref_video_asset_ids?: number[]; ref_audio_asset_ids?: number[]; scheduler?: string; ref_image_size?: string; easycache?: boolean; turbo_lora?: number; preview_steps?: number; quality?: 't0' | 't1'; place?: PlaceSpec }

/** 投稿用ファイル1件(GET /jobs/uploads) — YouTube/ニコニコ向けに書き出し直したもの */
export interface UploadFile {
  filename: string
  size_bytes: number
  modified_at: string
  download_url: string
  width?: number | null
  height?: number | null
  duration_sec?: number | null
  bitrate_mbps?: number | null
}

/** 書き出し済みファイル1件(GET /jobs/renders) */
export interface RenderFile {
  job_id: number
  filename: string
  size_bytes: number
  created_at: string
  width?: number
  height?: number
  fps?: number
  preset: string
  download_url: string
  /** 軽量なレビュー版(960px/crf30)。本番の1/100前後。無ければ null */
  review_size_bytes?: number | null
  review_url?: string | null
  /** パネル内プレビュー用(inline配信)。レビュー版があればそちら */
  stream_url?: string
}

export interface NightBatchState {
  running?: boolean
  project_id?: number
  weights?: Record<string, number>
  counts?: Record<string, number>
  keep_in_flight?: number
  last_job_id?: number
}

export const jobsApi = {
  list:        (projectId: number) =>
    api.get<Job[]>('/jobs/', { params: { project_id: projectId } }).then(r => r.data),
  get:         (id: number) => api.get<Job>(`/jobs/${id}`).then(r => r.data),
  create:      (projectId: number, jobType: JobType, params: Record<string, unknown>) =>
    api.post<Job>('/jobs/', { project_id: projectId, job_type: jobType, params }).then(r => r.data),
  cancel:      (id: number) => api.post<Job>(`/jobs/${id}/cancel`).then(r => r.data),
  delete:      (id: number) => api.delete(`/jobs/${id}`),
  downloadUrl: (id: number, variant: 'full' | 'review' = 'full') =>
    `/api/jobs/${id}/download${variant === 'review' ? '?variant=review' : ''}`,
  streamUrl:   (id: number, variant: 'full' | 'review' = 'review') =>
    `/api/jobs/${id}/stream?variant=${variant}`,
  listRenders: (projectId: number) =>
    api.get<RenderFile[]>('/jobs/renders', { params: { project_id: projectId } }).then(r => r.data),
  deleteRender: (id: number) => api.delete(`/jobs/renders/${id}`),
  listUploads: (projectId: number) =>
    api.get<UploadFile[]>('/jobs/uploads', { params: { project_id: projectId } }).then(r => r.data),
  nightBatchState: () => api.get<NightBatchState>('/jobs/nightbatch/state').then(r => r.data),
  nightBatchStart: (projectId: number, weights: Record<string, number>, keepInFlight = 2) =>
    api.post<NightBatchState>('/jobs/nightbatch/start', {
      project_id: projectId, weights, keep_in_flight: keepInFlight,
    }).then(r => r.data),
  nightBatchStop: () => api.post<NightBatchState>('/jobs/nightbatch/stop').then(r => r.data),
  sseUrl:      (projectId: number) => `/api/jobs/stream/sse?project_id=${projectId}`,
}

export const generationApi = {
  models:      () => api.get<Record<string, unknown[]>>('/generation/models').then(r => r.data),
  comfyStatus: () => api.get<{ available: boolean; url: string }>('/generation/comfyui/status').then(r => r.data),
  image:       (p: ImageGenParams)  => api.post<Job>('/generation/image', p).then(r => r.data),
  audio:       (p: AudioGenParams)  => api.post<Job>('/generation/audio', p).then(r => r.data),
  videoI2V:    (p: VideoI2VParams)  => api.post<Job>('/generation/video/i2v', p).then(r => r.data),
  model3d:     (p: Model3DParams)   => api.post<Job>('/generation/model3d', p).then(r => r.data),
  model3dOrbit:(p: { project_id: number; asset_id: number; orbit: OrbitSpec }) =>
    api.post<Job>('/generation/model3d/orbit', p).then(r => r.data),
  video3dcam:  (p: Video3DCamParams) => api.post<Job>('/generation/video/3dcam', p).then(r => r.data),
  beatCamera:  (p: { project_id: number; audio_asset_id: number; start_sec: number;
                     end_sec: number; style?: string; intensity?: number }) =>
    api.post<{ camera: Array<Record<string, number | string>> }>('/generation/camera/beat', p).then(r => r.data),
}

export interface Video3DCamParams {
  project_id: number
  model_asset_id: number
  ref_image_asset_id: number
  prompt?: string
  negative_prompt?: string
  camera?: { preset: string; turns?: number } | Array<Record<string, number>>
  length?: number
  width?: number
  height?: number
  seed?: number
  use_lightning?: boolean
  steps?: number
}

export interface OrbitSpec {
  preset: string       // orbit | dolly_in | dolly_out | sway | arc_l | arc_r | parallax
  seconds: number
  fps: number
  width: number
  height: number
  style: string        // standard | toon | wire
  turns?: number
}

export interface Model3DParams {
  project_id: number
  mode: 'object' | 'object_mv' | 'relief'
  image_asset_id?: number
  views?: Record<string, number>
  seed?: number
  steps?: number
  octree_resolution?: number
  resolution_level?: number
  decimation?: number
  orbit?: OrbitSpec
}

// ── Analysis ──────────────────────────────────────────────────────────────────

export interface BeatAnalysis {
  bpm: number
  beats: number[]       // beat times in seconds
  downbeats: number[]
  duration_sec: number
  tempo_label: string
}

export interface SceneSegment {
  start_sec: number
  end_sec: number
  duration_sec: number
}

export interface SceneAnalysis {
  scenes: SceneSegment[]
  scene_count: number
  avg_scene_duration_sec: number
  cut_density_label: string
}

export interface MotionSegment {
  start_sec: number
  end_sec: number
  intensity: number
}

export interface MotionAnalysis {
  segments: MotionSegment[]
  peak_intensity: number
  avg_intensity: number
}

/** Per-frame inter-frame difference (画面変化量) — values[i] = diff(frame i, i+1), 0..1 */
export interface MotionCurve {
  fps: number
  values: number[]
  frame_count: number
}

/** 移動量バジェット — 曲から出した「どれくらい画が動くべきか」。
 *  move_pct は画面幅に対する%(1カットの尺いっぱいで動かす前提の総量)。
 *  sustain/punch/grain は曲内のパーセンタイル順位(0-1)。 */
export interface AudioMotion {
  fps: number
  /** 何フレームごとに1点か(送信量削減のための間引き)。配列添字 = frame / decim */
  decim: number
  frames: number
  duration_sec: number
  move_pct: number[]
  sustain: number[]
  punch: number[]
  grain: number[]
  /** 打撃の離散点(HPSSで打楽器を分離してオンセット検出)。t=秒, v=強さ0-1 */
  hits?: { t: number; v: number }[]
  /** 歌唱の濃さ(芝居の密度) 0-1。ステムがある場合のみ */
  voice?: number[]
  base_max_pct: number
  structure_applied?: boolean
}

/** ドラム個別打点(ADTOF 5クラス)。t=秒, v=強さ0-1 */
export interface AudioDrums {
  fps: number
  engine: string
  classes: {
    kick?: { t: number; v: number }[]
    snare?: { t: number; v: number }[]
    tom?: { t: number; v: number }[]
    hihat?: { t: number; v: number }[]
    cymbal?: { t: number; v: number }[]
  }
}

/** 楽曲構造 — 区間ラベルと「サビ前の盛り上げ」 */
export interface AudioStructure {
  /** 'allin1' のときは副(参考)。未設定なら主(自作) */
  engine?: string
  /** 副のみ: allin1が返すBPM。この曲では倍テンポを誤り(103 vs 実測214.29)なので使わない */
  bpm?: number | null
  bar_count: number
  sections: { label: string; start_sec: number; end_sec: number; bars: number
              raw_label?: string
              energy?: number; vocal?: number; repeat?: number }[]
  buildups: { start_sec: number; end_sec: number; target: string
              slope: number; break: number; kind: '上昇' | '下降' | '抜き' | '平坦' }[]
  has_vocal_stem: boolean
  has_inst_stem: boolean
}

export interface AnalysisResult {
  id: number
  asset_id: number
  analysis_type: 'audio_beats' | 'scene_changes' | 'motion' | 'motion_curve'
    | 'audio_motion' | 'audio_structure' | 'audio_structure_alt'
    | 'audio_structure_override' | 'audio_drums'
  result: BeatAnalysis | SceneAnalysis | MotionAnalysis | AudioMotion | AudioStructure | AudioDrums
  created_at: string
}

export interface ProjectAnalysisSummary {
  summary: string
  details: {
    audio?: { bpm: number; beat_count: number; downbeat_count: number; duration_sec: number; tempo_label: string }
    scenes?: { total_scene_count: number; avg_scene_duration_sec: number; cut_density_labels: string[] }
    motion?: { peak_intensity: number; avg_intensity: number }
  }
}

export interface BeatMatchResult {
  score: number
  beats_total: number
  beats_hit: number
  cuts_total: number
  cuts_on_beat: number
  analyzed_clips: number
  unanalyzed_clips: number
  weak_beats: { frame: number; sec: number; peak: number; hit: boolean }[]
  hint?: string
  error?: string
}

export const analysisApi = {
  /** 盛り上げ判定などの手動上書き。解析を再実行しても消えない別種別で保存される */
  putOverride: (assetId: number, kind: string, body: unknown) =>
    api.put(`/analysis/${assetId}/override/${kind}`, body).then(r => r.data),
  clearOverride: (assetId: number, kind: string) =>
    api.delete(`/analysis/${assetId}/override/${kind}`).then(r => r.data),

  triggerAudio:  (assetId: number) =>
    api.post<{ job_id: number; status: string }>(`/analysis/audio/${assetId}`).then(r => r.data),
  triggerVideo:  (assetId: number) =>
    api.post<{ job_id: number; status: string }>(`/analysis/video/${assetId}`).then(r => r.data),
  getResults:    (assetId: number) =>
    api.get<AnalysisResult[]>(`/analysis/${assetId}`).then(r => r.data),
  getResultsBatch: (assetIds: number[]) =>
    api.get<Record<number, AnalysisResult[]>>(`/analysis/batch/by-assets`, { params: { asset_ids: assetIds.join(',') } }).then(r => r.data),
  getSummary:    (projectId: number) =>
    api.get<ProjectAnalysisSummary>(`/analysis/project/${projectId}/summary`).then(r => r.data),
  getBeatMatch:  (projectId: number) =>
    api.get<BeatMatchResult>(`/analysis/project/${projectId}/beat-match`).then(r => r.data),
}

// ── GPU / System ─────────────────────────────────────────────────────────────

export interface GpuInfo {
  index: number
  name: string
  vram_total_mb: number
  vram_used_mb: number
  vram_free_mb: number
  utilization_pct: number
  temperature_c: number
  power_draw_w: number
  power_limit_w: number
  unified_memory: boolean   // true on shared-memory GPUs (e.g. DGX Spark GB10)
}

export interface GpuStatus {
  available: boolean
  error: string
  gpus: GpuInfo[]
}

export const systemApi = {
  gpu:       () => api.get<GpuStatus>('/system/gpu').then(r => r.data),
  gpuSseUrl: () => '/api/system/gpu/stream',
}

// ── LLM chat ──────────────────────────────────────────────────────────────────

export interface LLMChatMessage { role: 'user' | 'assistant'; content: string }
export interface LLMActionLog   { tool: string; input: Record<string,unknown>; result: Record<string,unknown> }
export interface LLMChatResponse { reply: string; actions: LLMActionLog[]; error?: string }

export const llmApi = {
  status: () => api.get<{ configured: boolean; model: string }>('/llm/status').then(r => r.data),
  chat:   (project_id: number, message: string, history: LLMChatMessage[]) =>
    api.post<LLMChatResponse>('/llm/chat', { project_id, message, history }).then(r => r.data),
}
