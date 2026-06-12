import axios from 'axios'
import { useUIStore } from '../store/uiStore'

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
  asset_type: 'video' | 'audio' | 'image' | 'generated'
  file_path: string
  duration_sec: number | null
  width: number | null
  height: number | null
  file_size_bytes: number | null
  proxy_path: string | null
  created_at: string
}

export const projectsApi = {
  list:   () => api.get<Project[]>('/projects/').then(r => r.data),
  create: (data: ProjectCreate) => api.post<Project>('/projects/', data).then(r => r.data),
  get:    (id: number) => api.get<Project>(`/projects/${id}`).then(r => r.data),
  delete: (id: number) => api.delete(`/projects/${id}`),
}

export interface Track {
  id: number
  project_id: number
  name: string
  track_type: 'video' | 'audio' | 'reference'
  order: number
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
  /** Audio fades (audio clips), in timeline frames */
  fade_in_frames: number
  fade_out_frames: number
  /** Compositing (clips on video tracks above the first overlay onto it) */
  opacity: number
  blend: 'normal' | 'screen' | 'add' | 'multiply'
}

export interface ClipUpdate {
  start_frame?: number
  duration_frames?: number
  asset_in_frame?: number
  track_id?: number
  speed?: number
  speed_ease?: SpeedEase
  transition_in?: TransitionType
  transition_frames?: number
  fade_in_frames?: number
  fade_out_frames?: number
  opacity?: number
  blend?: Clip['blend']
}

// extras are optional on create (backend defaults)
export type ClipCreate = Omit<Clip, 'id' | 'speed' | 'speed_ease' | 'transition_in'
  | 'transition_frames' | 'fade_in_frames' | 'fade_out_frames' | 'opacity' | 'blend'>
  & Partial<Pick<Clip, 'speed' | 'speed_ease' | 'transition_in' | 'transition_frames'
  | 'fade_in_frames' | 'fade_out_frames' | 'opacity' | 'blend'>>

export const tracksApi = {
  list:   (projectId: number) =>
    api.get<Track[]>('/tracks/', { params: { project_id: projectId } }).then(r => r.data),
  create: (data: Omit<Track, 'id'>) => api.post<Track>('/tracks/', data).then(r => r.data),
  delete: (id: number) => api.delete(`/tracks/${id}`),
}

export const clipsApi = {
  list:   (projectId: number) =>
    api.get<Clip[]>('/clips/', { params: { project_id: projectId } }).then(r => r.data),
  create: (data: ClipCreate) => api.post<Clip>('/clips/', data).then(r => r.data),
  update: (id: number, data: ClipUpdate) => api.patch<Clip>(`/clips/${id}`, data).then(r => r.data),
  delete: (id: number) => api.delete(`/clips/${id}`),
  autoCutBeats: (id: number) =>
    api.post<{ created: number; cut_frames?: number[]; message?: string }>(`/clips/${id}/auto-cut-beats`).then(r => r.data),
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
  filmstripUrl: (assetId: number) => `/api/assets/${assetId}/filmstrip`,
  fileUrl:      (assetId: number, useProxy = false) =>
    `/api/assets/${assetId}/file${useProxy ? '?proxy=1' : ''}`,
  extractFrame: (assetId: number, timeSec: number) =>
    api.post<Asset>(`/assets/${assetId}/extract-frame`, null, { params: { time_sec: timeSec } }).then(r => r.data),
  makeProxy:    (assetId: number) =>
    api.post<{ job_id: number; status: string }>(`/assets/${assetId}/proxy`).then(r => r.data),
}

// ── Job types ─────────────────────────────────────────────────────────────────

export type JobType   = 'render_final' | 'generate_image' | 'generate_audio' | 'generate_video_i2v' | 'precompose' | 'create_proxy' | 'render_motion_graphics' | 'analyze_audio' | 'analyze_video'
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Job {
  id: number
  project_id: number
  job_type: JobType
  status: JobStatus
  params: Record<string, unknown>
  result_asset_ids: number[]
  progress: number
  error_msg: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface I2VKeyframe  { time_sec: number; asset_id: number }
export interface ImageGenParams  { project_id: number; prompt: string; negative_prompt?: string; model?: string; width?: number; height?: number; seed?: number }
export interface AudioGenParams  { project_id: number; prompt: string; lyrics?: string; duration_sec?: number; vocal_language?: string; instrumental?: boolean | null; model?: string; seed?: number }
export interface VideoI2VParams  { project_id: number; keyframes: I2VKeyframe[]; duration_sec?: number; fps?: number; motion_strength?: number; model?: string; seed?: number; prompt?: string; negative_prompt?: string; width?: number; height?: number; use_lightning?: boolean }

export const jobsApi = {
  list:        (projectId: number) =>
    api.get<Job[]>('/jobs/', { params: { project_id: projectId } }).then(r => r.data),
  get:         (id: number) => api.get<Job>(`/jobs/${id}`).then(r => r.data),
  create:      (projectId: number, jobType: JobType, params: Record<string, unknown>) =>
    api.post<Job>('/jobs/', { project_id: projectId, job_type: jobType, params }).then(r => r.data),
  cancel:      (id: number) => api.post<Job>(`/jobs/${id}/cancel`).then(r => r.data),
  delete:      (id: number) => api.delete(`/jobs/${id}`),
  downloadUrl: (id: number) => `/api/jobs/${id}/download`,
  sseUrl:      (projectId: number) => `/api/jobs/stream/sse?project_id=${projectId}`,
}

export const generationApi = {
  models:      () => api.get<Record<string, unknown[]>>('/generation/models').then(r => r.data),
  comfyStatus: () => api.get<{ available: boolean; url: string }>('/generation/comfyui/status').then(r => r.data),
  image:       (p: ImageGenParams)  => api.post<Job>('/generation/image', p).then(r => r.data),
  audio:       (p: AudioGenParams)  => api.post<Job>('/generation/audio', p).then(r => r.data),
  videoI2V:    (p: VideoI2VParams)  => api.post<Job>('/generation/video/i2v', p).then(r => r.data),
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

export interface AnalysisResult {
  id: number
  asset_id: number
  analysis_type: 'audio_beats' | 'scene_changes' | 'motion' | 'motion_curve'
  result: BeatAnalysis | SceneAnalysis | MotionAnalysis
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
  triggerAudio:  (assetId: number) =>
    api.post<{ job_id: number; status: string }>(`/analysis/audio/${assetId}`).then(r => r.data),
  triggerVideo:  (assetId: number) =>
    api.post<{ job_id: number; status: string }>(`/analysis/video/${assetId}`).then(r => r.data),
  getResults:    (assetId: number) =>
    api.get<AnalysisResult[]>(`/analysis/${assetId}`).then(r => r.data),
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
