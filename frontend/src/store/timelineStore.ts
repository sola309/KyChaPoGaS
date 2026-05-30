import { create } from 'zustand'
import type { Track, Clip, ClipUpdate } from '../api/client'
import { tracksApi, clipsApi } from '../api/client'

interface HistoryEntry {
  label: string
  undoFn: () => Promise<void>
  redoFn: () => Promise<void>
}

const MAX_HISTORY = 50

function localUpdate(clips: Clip[], clipId: number, data: Partial<Clip>): Clip[] {
  return clips.map(c => c.id === clipId ? { ...c, ...data } : c)
}

interface TimelineState {
  tracks: Track[]
  clips: Clip[]
  currentFrame: number
  pixelsPerFrame: number
  projectFps: number
  loading: boolean
  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]
  canUndo: boolean
  canRedo: boolean

  loadTimeline: (projectId: number, fps: number) => Promise<void>
  addTrack: (projectId: number, type: 'video' | 'audio', name: string) => Promise<void>
  deleteTrack: (trackId: number) => Promise<void>
  addClip: (trackId: number, assetId: number | null, startFrame: number, durationFrames: number) => Promise<Clip>
  moveClip: (clipId: number, prevFrame: number, newFrame: number) => Promise<void>
  trimClip: (clipId: number, before: ClipUpdate, after: ClipUpdate) => Promise<void>
  deleteClip: (clipId: number) => Promise<void>
  splitClip: (clipId: number, splitFrame: number) => Promise<void>
  updateClip: (clipId: number, data: ClipUpdate) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  setCurrentFrame: (frame: number) => void
  setZoom: (pixelsPerFrame: number) => void
}

export const useTimelineStore = create<TimelineState>((set, get) => {
  const pushHistory = (entry: HistoryEntry) => {
    set(s => ({
      undoStack: [...s.undoStack.slice(-(MAX_HISTORY - 1)), entry],
      redoStack: [],
      canUndo: true,
      canRedo: false,
    }))
  }

  const applyLocal = (clipId: number, data: Partial<Clip>) => {
    set(s => ({ clips: localUpdate(s.clips, clipId, data) }))
  }

  return {
    tracks: [],
    clips: [],
    currentFrame: 0,
    pixelsPerFrame: 2,
    projectFps: 30,
    loading: false,
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,

    loadTimeline: async (projectId, fps) => {
      set({ loading: true, projectFps: fps })
      const [tracks, clips] = await Promise.all([
        tracksApi.list(projectId),
        clipsApi.list(projectId),
      ])
      set({ tracks, clips, loading: false, undoStack: [], redoStack: [], canUndo: false, canRedo: false })
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

      let liveId = clip.id
      pushHistory({
        label: 'クリップ追加',
        undoFn: async () => {
          const id = liveId
          await clipsApi.delete(id)
          set(s => ({ clips: s.clips.filter(c => c.id !== id) }))
        },
        redoFn: async () => {
          const newClip = await clipsApi.create({
            track_id: trackId, asset_id: assetId,
            start_frame: startFrame, duration_frames: durationFrames, asset_in_frame: 0,
          })
          liveId = newClip.id
          set(s => ({ clips: [...s.clips, newClip] }))
        },
      })

      return clip
    },

    moveClip: async (clipId, prevFrame, newFrame) => {
      await clipsApi.update(clipId, { start_frame: newFrame })
      applyLocal(clipId, { start_frame: newFrame })

      pushHistory({
        label: 'クリップ移動',
        undoFn: async () => {
          await clipsApi.update(clipId, { start_frame: prevFrame })
          applyLocal(clipId, { start_frame: prevFrame })
        },
        redoFn: async () => {
          await clipsApi.update(clipId, { start_frame: newFrame })
          applyLocal(clipId, { start_frame: newFrame })
        },
      })
    },

    trimClip: async (clipId, before, after) => {
      await clipsApi.update(clipId, after)
      applyLocal(clipId, after as Partial<Clip>)

      pushHistory({
        label: 'トリミング',
        undoFn: async () => {
          await clipsApi.update(clipId, before)
          applyLocal(clipId, before as Partial<Clip>)
        },
        redoFn: async () => {
          await clipsApi.update(clipId, after)
          applyLocal(clipId, after as Partial<Clip>)
        },
      })
    },

    deleteClip: async (clipId) => {
      const clip = get().clips.find(c => c.id === clipId)
      if (!clip) return
      await clipsApi.delete(clipId)
      set(s => ({ clips: s.clips.filter(c => c.id !== clipId) }))

      let restoredId = -1
      const { id: _id, ...clipData } = clip as Clip & { id: number }
      pushHistory({
        label: 'クリップ削除',
        undoFn: async () => {
          const newClip = await clipsApi.create(clipData)
          restoredId = newClip.id
          set(s => ({ clips: [...s.clips, newClip] }))
        },
        redoFn: async () => {
          if (restoredId === -1) return
          const id = restoredId
          restoredId = -1
          await clipsApi.delete(id)
          set(s => ({ clips: s.clips.filter(c => c.id !== id) }))
        },
      })
    },

    splitClip: async (clipId, splitFrame) => {
      const clip = get().clips.find(c => c.id === clipId)
      if (!clip) return
      if (splitFrame <= clip.start_frame || splitFrame >= clip.start_frame + clip.duration_frames) return

      const leftDuration = splitFrame - clip.start_frame
      const rightDuration = clip.duration_frames - leftDuration

      const [left, right] = await Promise.all([
        clipsApi.create({
          track_id: clip.track_id, asset_id: clip.asset_id,
          start_frame: clip.start_frame, duration_frames: leftDuration,
          asset_in_frame: clip.asset_in_frame,
        }),
        clipsApi.create({
          track_id: clip.track_id, asset_id: clip.asset_id,
          start_frame: splitFrame, duration_frames: rightDuration,
          asset_in_frame: clip.asset_in_frame + leftDuration,
        }),
      ])
      await clipsApi.delete(clipId)
      set(s => ({
        clips: [...s.clips.filter(c => c.id !== clipId), left, right],
      }))

      let leftId = left.id
      let rightId = right.id
      let restoredId = -1

      pushHistory({
        label: 'クリップ分割',
        undoFn: async () => {
          const lId = leftId, rId = rightId
          await Promise.all([clipsApi.delete(lId), clipsApi.delete(rId)])
          const restored = await clipsApi.create({
            track_id: clip.track_id, asset_id: clip.asset_id,
            start_frame: clip.start_frame, duration_frames: clip.duration_frames,
            asset_in_frame: clip.asset_in_frame,
          })
          restoredId = restored.id
          leftId = -1
          rightId = -1
          set(s => ({
            clips: [...s.clips.filter(c => c.id !== lId && c.id !== rId), restored],
          }))
        },
        redoFn: async () => {
          if (restoredId === -1) return
          const rId = restoredId
          const [newLeft, newRight] = await Promise.all([
            clipsApi.create({
              track_id: clip.track_id, asset_id: clip.asset_id,
              start_frame: clip.start_frame, duration_frames: leftDuration,
              asset_in_frame: clip.asset_in_frame,
            }),
            clipsApi.create({
              track_id: clip.track_id, asset_id: clip.asset_id,
              start_frame: splitFrame, duration_frames: rightDuration,
              asset_in_frame: clip.asset_in_frame + leftDuration,
            }),
          ])
          await clipsApi.delete(rId)
          leftId = newLeft.id
          rightId = newRight.id
          restoredId = -1
          set(s => ({
            clips: [...s.clips.filter(c => c.id !== rId), newLeft, newRight],
          }))
        },
      })
    },

    updateClip: async (clipId, data) => {
      const updated = await clipsApi.update(clipId, data)
      set(s => ({ clips: s.clips.map(c => c.id === clipId ? updated : c) }))
    },

    undo: async () => {
      const { undoStack } = get()
      if (undoStack.length === 0) return
      const entry = undoStack[undoStack.length - 1]
      set(s => ({
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, entry],
        canUndo: s.undoStack.length > 1,
        canRedo: true,
      }))
      await entry.undoFn()
    },

    redo: async () => {
      const { redoStack } = get()
      if (redoStack.length === 0) return
      const entry = redoStack[redoStack.length - 1]
      set(s => ({
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, entry],
        canUndo: true,
        canRedo: s.redoStack.length > 1,
      }))
      await entry.redoFn()
    },

    setCurrentFrame: (frame) => set({ currentFrame: Math.max(0, frame) }),
    setZoom: (ppf) => set({ pixelsPerFrame: Math.max(0.5, Math.min(10, ppf)) }),
  }
})
