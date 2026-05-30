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
  list: () => api.get<Project[]>('/projects').then(r => r.data),
  create: (data: ProjectCreate) => api.post<Project>('/projects', data).then(r => r.data),
  get: (id: number) => api.get<Project>(`/projects/${id}`).then(r => r.data),
  delete: (id: number) => api.delete(`/projects/${id}`),
}

export const assetsApi = {
  list: (projectId?: number) =>
    api.get<Asset[]>('/assets', { params: projectId ? { project_id: projectId } : {} }).then(r => r.data),
  get: (id: number) => api.get<Asset>(`/assets/${id}`).then(r => r.data),
  delete: (id: number) => api.delete(`/assets/${id}`),
}
