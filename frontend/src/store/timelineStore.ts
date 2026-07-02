import { create } from 'zustand'
import type { Track, Clip, ClipUpdate, SpeedEase } from '../api/client'
import { tracksApi, clipsApi } from '../api/client'
import { useCollabStore } from './collabStore'

// Tell other collaborators a committed timeline change happened (they re-sync).
const notifyEdit = () => { try { useCollabStore.getState().broadcastEdit() } catch { /* noop */ } }

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
  selectedClipId: number | null
  editingClipId: number | null     // clip this user is actively dragging/trimming (soft lock)
  loading: boolean
  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]
  canUndo: boolean
  canRedo: boolean

  loadTimeline: (projectId: number, fps: number) => Promise<void>
  syncFromServer: (projectId: number) => Promise<void>
  addTrack: (projectId: number, type: 'video' | 'audio' | 'reference', name: string) => Promise<void>
  deleteTrack: (trackId: number) => Promise<void>
  addClip: (trackId: number, assetId: number | null, startFrame: number, durationFrames: number) => Promise<Clip>
  placeClip: (projectId: number, trackType: 'video' | 'audio' | 'reference', assetId: number, durationFrames: number, atFrame?: number) => Promise<Clip>
  moveClip: (clipId: number, prevFrame: number, newFrame: number) => Promise<void>
  trimClip: (clipId: number, before: ClipUpdate, after: ClipUpdate) => Promise<void>
  deleteClip: (clipId: number) => Promise<void>
  splitClip: (clipId: number, splitFrame: number) => Promise<void>
  updateClip: (clipId: number, data: ClipUpdate) => Promise<void>
  // Optimistic + debounced persist — for live slider/keyframe scrubbing in the
  // inspector. Local state updates synchronously (no await → no focus loss / jank);
  // the server PATCH is coalesced to the last value after ~200ms idle.
  liveUpdateClip: (clipId: number, data: ClipUpdate) => void
  setClipSpeed: (clipId: number, speed: number, ease?: SpeedEase) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  setCurrentFrame: (frame: number) => void
  setZoom: (pixelsPerFrame: number) => void
  setSelectedClipId: (id: number | null) => void
  setEditingClipId: (id: number | null) => void
  // Preview-only layer visibility (declutter / lighten preview; does NOT affect render)
  previewHidden: number[]                 // track ids hidden in the compositor
  toggleTrackHidden: (trackId: number) => void
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

  // Debounce state for liveUpdateClip (closure-scoped, not store state).
  const liveTimers: Record<number, ReturnType<typeof setTimeout>> = {}
  const livePending: Record<number, ClipUpdate> = {}

  return {
    tracks: [],
    clips: [],
    currentFrame: 0,
    pixelsPerFrame: 2,
    projectFps: 30,
    selectedClipId: null,
    editingClipId: null,
    loading: false,
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
    previewHidden: [],

    toggleTrackHidden: (trackId) => set(s => ({
      previewHidden: s.previewHidden.includes(trackId)
        ? s.previewHidden.filter(id => id !== trackId)
        : [...s.previewHidden, trackId],
    })),

    loadTimeline: async (projectId, fps) => {
      set({ loading: true, projectFps: fps })
      const [tracks, clips] = await Promise.all([
        tracksApi.list(projectId),
        clipsApi.list(projectId),
      ])
      set({ tracks, clips, loading: false, undoStack: [], redoStack: [], canUndo: false, canRedo: false })
    },

    // Re-pull tracks+clips from the server (source of truth) without touching
    // undo history / playhead / selection. Used to apply remote collaborators' edits.
    syncFromServer: async (projectId) => {
      const [tracks, clips] = await Promise.all([
        tracksApi.list(projectId),
        clipsApi.list(projectId),
      ])
      set({ tracks, clips })
    },

    addTrack: async (projectId, type, name) => {
      const order = get().tracks.filter(t => t.track_type === type).length
      const track = await tracksApi.create({ project_id: projectId, name, track_type: type, order })
      set(s => ({ tracks: [...s.tracks, track] }))
      notifyEdit()
    },

    deleteTrack: async (trackId) => {
      await tracksApi.delete(trackId)
      set(s => ({
        tracks: s.tracks.filter(t => t.id !== trackId),
        clips: s.clips.filter(c => c.track_id !== trackId),
      }))
      notifyEdit()
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

      notifyEdit()
      return clip
    },

    // Place an asset on a track (creating the track if needed). Appends at the
    // track end by default, or at `atFrame` when given. Used to auto-place
    // generated assets and to drop extracted keyframes onto a Reference track.
    placeClip: async (projectId, trackType, assetId, durationFrames, atFrame) => {
      const TRACK_NAME = { video: 'Video', audio: 'Audio', reference: 'Ref' } as const
      let track = get().tracks.find(t => t.track_type === trackType)
      if (!track) {
        const order = get().tracks.filter(t => t.track_type === trackType).length
        track = await tracksApi.create({
          project_id: projectId,
          name: TRACK_NAME[trackType],
          track_type: trackType, order,
        })
        const created = track
        set(s => ({ tracks: [...s.tracks, created] }))
      }
      const trackId = track.id
      const startFrame = atFrame ?? get().clips
        .filter(c => c.track_id === trackId)
        .reduce((m, c) => Math.max(m, c.start_frame + c.duration_frames), 0)
      const clip = await clipsApi.create({
        track_id: trackId, asset_id: assetId,
        start_frame: startFrame, duration_frames: durationFrames, asset_in_frame: 0,
      })
      set(s => ({ clips: [...s.clips, clip] }))
      notifyEdit()
      return clip
    },

    moveClip: async (clipId, prevFrame, newFrame) => {
      await clipsApi.update(clipId, { start_frame: newFrame })
      applyLocal(clipId, { start_frame: newFrame })
      notifyEdit()

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
      notifyEdit()

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
      notifyEdit()

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
      notifyEdit()

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
      notifyEdit()
    },

    liveUpdateClip: (clipId, data) => {
      applyLocal(clipId, data)                                  // instant, no await
      livePending[clipId] = { ...(livePending[clipId] ?? {}), ...data }
      if (liveTimers[clipId]) clearTimeout(liveTimers[clipId])
      liveTimers[clipId] = setTimeout(async () => {
        const d = livePending[clipId]
        delete livePending[clipId]; delete liveTimers[clipId]
        try {
          const updated = await clipsApi.update(clipId, d)
          // reconcile only if no newer edit landed while the PATCH was in flight
          if (!livePending[clipId]) set(s => ({ clips: s.clips.map(c => c.id === clipId ? updated : c) }))
        } catch { /* keep optimistic state */ }
        notifyEdit()
      }, 200)
    },

    // Change playback speed; the source span stays fixed so the timeline
    // duration auto-adjusts (faster → shorter clip).
    setClipSpeed: async (clipId, speed, ease) => {
      const clip = get().clips.find(c => c.id === clipId)
      if (!clip) return
      const sp = Math.max(0.1, Math.min(8, speed))
      const sourceConsumed = clip.duration_frames * (clip.speed || 1)
      const newDuration = Math.max(1, Math.round(sourceConsumed / sp))
      const data: ClipUpdate = { speed: sp, duration_frames: newDuration }
      if (ease) data.speed_ease = ease
      const updated = await clipsApi.update(clipId, data)
      set(s => ({ clips: s.clips.map(c => c.id === clipId ? updated : c) }))
      notifyEdit()
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
      notifyEdit()
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
      notifyEdit()
    },

    setCurrentFrame: (frame) => set({ currentFrame: Math.max(0, frame) }),
    setZoom: (ppf) => set({ pixelsPerFrame: Math.max(0.5, Math.min(10, ppf)) }),
    setSelectedClipId: (id) => set({ selectedClipId: id }),
    setEditingClipId: (id) => set({ editingClipId: id }),
  }
})
