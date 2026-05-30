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
  list: () => api.get<Project[]>('/projects/').then(r => r.data),
  create: (data: ProjectCreate) => api.post<Project>('/projects/', data).then(r => r.data),
  get: (id: number) => api.get<Project>(`/projects/${id}`).then(r => r.data),
  delete: (id: number) => api.delete(`/projects/${id}`),
}

export interface Track {
  id: number
  project_id: number
  name: string
  track_type: 'video' | 'audio'
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
  list: (projectId: number) =>
    api.get<Track[]>('/tracks/', { params: { project_id: projectId } }).then(r => r.data),
  create: (data: Omit<Track, 'id'>) => api.post<Track>('/tracks/', data).then(r => r.data),
  delete: (id: number) => api.delete(`/tracks/${id}`),
}

export const clipsApi = {
  list: (projectId: number) =>
    api.get<Clip[]>('/clips/', { params: { project_id: projectId } }).then(r => r.data),
  create: (data: Omit<Clip, 'id'>) => api.post<Clip>('/clips/', data).then(r => r.data),
  update: (id: number, data: ClipUpdate) => api.patch<Clip>(`/clips/${id}`, data).then(r => r.data),
  delete: (id: number) => api.delete(`/clips/${id}`),
}

export const assetsApi = {
  list: (projectId?: number) =>
    api.get<Asset[]>('/assets/', { params: projectId ? { project_id: projectId } : {} }).then(r => r.data),
  get: (id: number) => api.get<Asset>(`/assets/${id}`).then(r => r.data),
  delete: (id: number) => api.delete(`/assets/${id}`),
  upload: (projectId: number, file: File) => {
    const form = new FormData()
    form.append('project_id', String(projectId))
    form.append('file', file)
    return api.post<Asset>('/assets/upload/', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },
  thumbnailUrl: (assetId: number) => `/api/assets/${assetId}/thumbnail`,
  fileUrl: (assetId: number) => `/api/assets/${assetId}/file`,
}
