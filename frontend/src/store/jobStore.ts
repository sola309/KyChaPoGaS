import { create } from 'zustand'
import type { Job } from '../api/client'
import { jobsApi, generationApi, type ImageGenParams, type AudioGenParams, type VideoI2VParams } from '../api/client'

interface JobState {
  jobs: Job[]
  comfyAvailable: boolean
  loading: boolean
  sseRef: EventSource | null

  loadJobs: (projectId: number) => Promise<void>
  startSSE: (projectId: number) => void
  stopSSE: () => void
  cancelJob: (jobId: number) => Promise<void>
  deleteJob: (jobId: number) => Promise<void>
  generateImage: (params: ImageGenParams) => Promise<Job>
  generateAudio: (params: AudioGenParams) => Promise<Job>
  generateVideoI2V: (params: VideoI2VParams) => Promise<Job>
  checkComfyUI: () => Promise<void>
}

export const useJobStore = create<JobState>((set, get) => ({
  jobs: [],
  comfyAvailable: false,
  loading: false,
  sseRef: null,

  loadJobs: async (projectId) => {
    set({ loading: true })
    const jobs = await jobsApi.list(projectId)
    set({ jobs, loading: false })
  },

  startSSE: (projectId) => {
    get().stopSSE()
    const es = new EventSource(jobsApi.sseUrl(projectId))
    es.onmessage = (e) => {
      try {
        const jobs: Job[] = JSON.parse(e.data)
        set({ jobs })
      } catch { /* ignore malformed frames */ }
    }
    es.onerror = () => {
      // EventSource auto-reconnects; just swallow the error event
    }
    set({ sseRef: es })
  },

  stopSSE: () => {
    const { sseRef } = get()
    if (sseRef) {
      sseRef.close()
      set({ sseRef: null })
    }
  },

  cancelJob: async (jobId) => {
    const updated = await jobsApi.cancel(jobId)
    set(s => ({ jobs: s.jobs.map(j => j.id === jobId ? updated : j) }))
  },

  deleteJob: async (jobId) => {
    await jobsApi.delete(jobId)
    set(s => ({ jobs: s.jobs.filter(j => j.id !== jobId) }))
  },

  generateImage: async (params) => {
    const job = await generationApi.image(params)
    set(s => ({ jobs: [job, ...s.jobs] }))
    return job
  },

  generateAudio: async (params) => {
    const job = await generationApi.audio(params)
    set(s => ({ jobs: [job, ...s.jobs] }))
    return job
  },

  generateVideoI2V: async (params) => {
    const job = await generationApi.videoI2V(params)
    set(s => ({ jobs: [job, ...s.jobs] }))
    return job
  },

  checkComfyUI: async () => {
    try {
      const { available } = await generationApi.comfyStatus()
      set({ comfyAvailable: available })
    } catch {
      set({ comfyAvailable: false })
    }
  },
}))
