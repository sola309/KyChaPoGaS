import { create } from 'zustand'
import type { Track, Clip, ClipUpdate } from '../api/client'
import { tracksApi, clipsApi } from '../api/client'

interface TimelineState {
  tracks: Track[]
  clips: Clip[]
  currentFrame: number
  pixelsPerFrame: number   // zoom: pixels per 1 frame
  projectFps: number
  loading: boolean

  loadTimeline: (projectId: number, fps: number) => Promise<void>
  addTrack: (projectId: number, type: 'video' | 'audio', name: string) => Promise<void>
  deleteTrack: (trackId: number) => Promise<void>
  addClip: (trackId: number, assetId: number | null, startFrame: number, durationFrames: number) => Promise<Clip>
  updateClip: (clipId: number, data: ClipUpdate) => Promise<void>
  deleteClip: (clipId: number) => Promise<void>
  setCurrentFrame: (frame: number) => void
  setZoom: (pixelsPerFrame: number) => void
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  tracks: [],
  clips: [],
  currentFrame: 0,
  pixelsPerFrame: 2,   // default: 2px per frame (60px/s @ 30fps)
  projectFps: 30,
  loading: false,

  loadTimeline: async (projectId, fps) => {
    set({ loading: true, projectFps: fps })
    const [tracks, clips] = await Promise.all([
      tracksApi.list(projectId),
      clipsApi.list(projectId),
    ])
    set({ tracks, clips, loading: false })
  },

  addTrack: async (projectId, type, name) => {
    const order = get().tracks.filter(t => t.track_type === type).length
    const track = await tracksApi.create({ project_id: projectId, name, track_type: type, order })
    set(s => ({ tracks: [...s.tracks, track] }))
  },

  deleteTrack: async (trackId) => {
    await tracksApi.delete(trackId)
    set(s => ({
      tracks: s.tracks.filter(t => t.id !== trackId),
      clips: s.clips.filter(c => c.track_id !== trackId),
    }))
  },

  addClip: async (trackId, assetId, startFrame, durationFrames) => {
    const clip = await clipsApi.create({
      track_id: trackId, asset_id: assetId,
      start_frame: startFrame, duration_frames: durationFrames, asset_in_frame: 0,
    })
    set(s => ({ clips: [...s.clips, clip] }))
    return clip
  },

  updateClip: async (clipId, data) => {
    const updated = await clipsApi.update(clipId, data)
    set(s => ({ clips: s.clips.map(c => c.id === clipId ? updated : c) }))
  },

  deleteClip: async (clipId) => {
    await clipsApi.delete(clipId)
    set(s => ({ clips: s.clips.filter(c => c.id !== clipId) }))
  },

  setCurrentFrame: (frame) => set({ currentFrame: Math.max(0, frame) }),
  setZoom: (pixelsPerFrame) => set({ pixelsPerFrame: Math.max(0.5, Math.min(10, pixelsPerFrame)) }),
}))
