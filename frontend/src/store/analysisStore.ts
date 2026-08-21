import { create } from 'zustand'
import { analysisApi } from '../api/client'
import type {
  BeatAnalysis,
  SceneAnalysis,
  MotionAnalysis,
  MotionCurve,
  AudioMotion,
  AudioStructure,
  AudioDrums,
  AnalysisResult,
} from '../api/client'

interface AnalysisState {
  // Keyed by asset_id
  beats:  Record<number, BeatAnalysis>
  scenes: Record<number, SceneAnalysis>
  motion: Record<number, MotionAnalysis>
  curves: Record<number, MotionCurve>
  /** 移動量バジェット(音→推奨移動量)。キーは楽曲アセットID */
  audioMotion: Record<number, AudioMotion>
  /** 楽曲構造(区間ラベル/盛り上げ)。キーは楽曲アセットID */
  audioStructure: Record<number, AudioStructure>
  /** 副の構造(自作)。主とズレる所＝手法の限界が出ている所 */
  audioStructureAlt: Record<number, AudioStructure>
  /** 盛り上げ判定の手動上書き(自動判定より優先)。キーは楽曲アセットID */
  buildupOverride: Record<number, AudioStructure['buildups']>
  /** ドラム個別打点(キック/スネア/…)。キーは楽曲アセットID */
  audioDrums: Record<number, AudioDrums>
  loading: Record<number, boolean>

  loadAnalysis: (assetId: number) => Promise<void>
  /** 複数アセットの解析結果を1リクエストで取得(タイムライン初期化用) */
  loadAnalysisBatch: (assetIds: number[]) => Promise<void>
  triggerAudio: (assetId: number) => Promise<number>
  triggerVideo: (assetId: number) => Promise<number>
  clearAsset:   (assetId: number) => void
}

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  beats:   {},
  scenes:  {},
  motion:  {},
  curves:  {},
  audioMotion: {},
  audioStructure: {},
  audioStructureAlt: {},
  buildupOverride: {},
  audioDrums: {},
  loading: {},

  loadAnalysis: async (assetId) => {
    set(s => ({ loading: { ...s.loading, [assetId]: true } }))
    try {
      const results: AnalysisResult[] = await analysisApi.getResults(assetId)
      const beats  = { ...get().beats }
      const scenes = { ...get().scenes }
      const motion = { ...get().motion }
      const curves = { ...get().curves }
      const audioMotion = { ...get().audioMotion }
      const audioStructure = { ...get().audioStructure }
      const audioDrums = { ...get().audioDrums }
      const audioStructureAlt = { ...get().audioStructureAlt }
      const buildupOverride = { ...get().buildupOverride }

      for (const r of results) {
        if (r.analysis_type === 'audio_beats') beats[assetId]  = r.result as BeatAnalysis
        if (r.analysis_type === 'scene_changes') scenes[assetId] = r.result as SceneAnalysis
        if (r.analysis_type === 'motion')        motion[assetId] = r.result as MotionAnalysis
        if (r.analysis_type === 'motion_curve')  curves[assetId] = r.result as unknown as MotionCurve
        if (r.analysis_type === 'audio_motion')  audioMotion[assetId] = r.result as AudioMotion
        if (r.analysis_type === 'audio_structure') audioStructure[assetId] = r.result as AudioStructure
        if (r.analysis_type === 'audio_drums')     audioDrums[assetId] = r.result as AudioDrums
        if (r.analysis_type === 'audio_structure_alt') audioStructureAlt[assetId] = r.result as AudioStructure
        if (r.analysis_type === 'audio_structure_override')
          buildupOverride[assetId] = (r.result as AudioStructure).buildups
      }
      set({ beats, scenes, motion, curves, audioMotion, audioStructure, audioDrums, audioStructureAlt, buildupOverride })
    } finally {
      set(s => ({ loading: { ...s.loading, [assetId]: false } }))
    }
  },

  loadAnalysisBatch: async (assetIds) => {
    if (!assetIds.length) return
    set(s => ({ loading: { ...s.loading, ...Object.fromEntries(assetIds.map(id => [id, true])) } }))
    try {
      const byAsset = await analysisApi.getResultsBatch(assetIds)
      const beats  = { ...get().beats }
      const scenes = { ...get().scenes }
      const motion = { ...get().motion }
      const curves = { ...get().curves }
      const audioMotion = { ...get().audioMotion }
      const audioStructure = { ...get().audioStructure }
      const audioDrums = { ...get().audioDrums }
      const audioStructureAlt = { ...get().audioStructureAlt }
      const buildupOverride = { ...get().buildupOverride }
      for (const [idStr, results] of Object.entries(byAsset)) {
        const id = Number(idStr)
        for (const r of results) {
          if (r.analysis_type === 'audio_beats')   beats[id]  = r.result as BeatAnalysis
          if (r.analysis_type === 'scene_changes') scenes[id] = r.result as SceneAnalysis
          if (r.analysis_type === 'motion')        motion[id] = r.result as MotionAnalysis
          if (r.analysis_type === 'motion_curve')  curves[id] = r.result as unknown as MotionCurve
          if (r.analysis_type === 'audio_motion')  audioMotion[id] = r.result as AudioMotion
          if (r.analysis_type === 'audio_structure') audioStructure[id] = r.result as AudioStructure
          if (r.analysis_type === 'audio_drums')     audioDrums[id] = r.result as AudioDrums
          if (r.analysis_type === 'audio_structure_alt') audioStructureAlt[id] = r.result as AudioStructure
          if (r.analysis_type === 'audio_structure_override')
            buildupOverride[id] = (r.result as AudioStructure).buildups
        }
      }
      set({ beats, scenes, motion, curves, audioMotion, audioStructure, audioDrums, audioStructureAlt, buildupOverride })
    } finally {
      set(s => ({ loading: { ...s.loading, ...Object.fromEntries(assetIds.map(id => [id, false])) } }))
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
