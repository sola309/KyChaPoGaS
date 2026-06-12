import { create } from 'zustand'
import { analysisApi } from '../api/client'
import type {
  BeatAnalysis,
  SceneAnalysis,
  MotionAnalysis,
  MotionCurve,
  AnalysisResult,
} from '../api/client'

interface AnalysisState {
  // Keyed by asset_id
  beats:  Record<number, BeatAnalysis>
  scenes: Record<number, SceneAnalysis>
  motion: Record<number, MotionAnalysis>
  curves: Record<number, MotionCurve>
  loading: Record<number, boolean>

  loadAnalysis: (assetId: number) => Promise<void>
  triggerAudio: (assetId: number) => Promise<number>
  triggerVideo: (assetId: number) => Promise<number>
  clearAsset:   (assetId: number) => void
}

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  beats:   {},
  scenes:  {},
  motion:  {},
  curves:  {},
  loading: {},

  loadAnalysis: async (assetId) => {
    set(s => ({ loading: { ...s.loading, [assetId]: true } }))
    try {
      const results: AnalysisResult[] = await analysisApi.getResults(assetId)
      const beats  = { ...get().beats }
      const scenes = { ...get().scenes }
      const motion = { ...get().motion }
      const curves = { ...get().curves }

      for (const r of results) {
        if (r.analysis_type === 'audio_beats') beats[assetId]  = r.result as BeatAnalysis
        if (r.analysis_type === 'scene_changes') scenes[assetId] = r.result as SceneAnalysis
        if (r.analysis_type === 'motion')        motion[assetId] = r.result as MotionAnalysis
        if (r.analysis_type === 'motion_curve')  curves[assetId] = r.result as unknown as MotionCurve
      }
      set({ beats, scenes, motion, curves })
    } finally {
      set(s => ({ loading: { ...s.loading, [assetId]: false } }))
    }
  },

  triggerAudio: async (assetId) => {
    const r = await analysisApi.triggerAudio(assetId)
    return r.job_id
  },

  triggerVideo: async (assetId) => {
    const r = await analysisApi.triggerVideo(assetId)
    return r.job_id
  },

  clearAsset: (assetId) => {
    set(s => {
      const beats  = { ...s.beats };  delete beats[assetId]
      const scenes = { ...s.scenes }; delete scenes[assetId]
      const motion = { ...s.motion }; delete motion[assetId]
      return { beats, scenes, motion }
    })
  },
}))
