import axios from 'axios'

export const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
})

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

export interface Clip {
  id: number
  track_id: number
  asset_id: number | null
  start_frame: number
  duration_frames: number
  asset_in_frame: number
}

export interface ClipUpdate {
  start_frame?: number
  duration_frames?: number
  asset_in_frame?: number
  track_id?: number
}

export const tracksApi = {
  list:   (projectId: number) =>
    api.get<Track[]>('/tracks/', { params: { project_id: projectId } }).then(r => r.data),
  create: (data: Omit<Track, 'id'>) => api.post<Track>('/tracks/', data).then(r => r.data),
  delete: (id: number) => api.delete(`/tracks/${id}`),
}

export const clipsApi = {
  list:   (projectId: number) =>
    api.get<Clip[]>('/clips/', { params: { project_id: projectId } }).then(r => r.data),
  create: (data: Omit<Clip, 'id'>) => api.post<Clip>('/clips/', data).then(r => r.data),
  update: (id: number, data: ClipUpdate) => api.patch<Clip>(`/clips/${id}`, data).then(r => r.data),
  delete: (id: number) => api.delete(`/clips/${id}`),
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
    return api.post<Asset>('/assets/upload/', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },
  thumbnailUrl: (assetId: number) => `/api/assets/${assetId}/thumbnail`,
  fileUrl:      (assetId: number) => `/api/assets/${assetId}/file`,
}

// ── Job types ─────────────────────────────────────────────────────────────────

export type JobType   = 'render_final' | 'generate_image' | 'generate_audio' | 'generate_video_i2v'
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
export interface AudioGenParams  { project_id: number; prompt: string; duration_sec?: number; model?: string; seed?: number }
export interface VideoI2VParams  { project_id: number; keyframes: I2VKeyframe[]; duration_sec?: number; fps?: number; motion_strength?: number; model?: string; seed?: number }

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

export interface AnalysisResult {
  id: number
  asset_id: number
  analysis_type: 'audio_beats' | 'scene_changes' | 'motion'
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

export const analysisApi = {
  triggerAudio:  (assetId: number) =>
    api.post<{ job_id: number; status: string }>(`/analysis/audio/${assetId}`).then(r => r.data),
  triggerVideo:  (assetId: number) =>
    api.post<{ job_id: number; status: string }>(`/analysis/video/${assetId}`).then(r => r.data),
  getResults:    (assetId: number) =>
    api.get<AnalysisResult[]>(`/analysis/${assetId}`).then(r => r.data),
  getSummary:    (projectId: number) =>
    api.get<ProjectAnalysisSummary>(`/analysis/project/${projectId}/summary`).then(r => r.data),
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
