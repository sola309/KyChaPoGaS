import { create } from 'zustand'
import type { Track, Clip, ClipUpdate, SpeedEase } from '../api/client'
import { tracksApi, clipsApi } from '../api/client'
import { useCollabStore } from './collabStore'
import { filterCarry } from '../components/Timeline/filterLayers'
import { isCreditClip } from '../components/Preview/creditLook'
import { useUIStore } from './uiStore'

// Tell other collaborators a committed timeline change happened (they re-sync).
const notifyEdit = () => { try { useCollabStore.getState().broadcastEdit() } catch { /* noop */ } }

export interface HistoryEntry {
  label: string
  undoFn: () => Promise<void>
  redoFn: () => Promise<void>
}

const MAX_HISTORY = 50

function localUpdate(clips: Clip[], clipId: number, data: Partial<Clip>): Clip[] {
  return clips.map(c => c.id === clipId ? { ...c, ...data } : c)
}

// 履歴に 1 つ積んだ状態(上限 50・やり直しの履歴は消える)。ストアの中と外(pushHistory)で同じ
const withHistory = (s: Pick<TimelineState, 'undoStack'>, entry: HistoryEntry) => ({
  undoStack: [...s.undoStack.slice(-(MAX_HISTORY - 1)), entry],
  redoStack: [] as HistoryEntry[],
  canUndo: true,
  canRedo: false,
})

/** 元に戻す・やり直すの履歴へ 1 つ積む(ストアの外の編集 = 🎬 撮影パネルなど用。トリミング・分割と同じ履歴) */
export function pushHistory(entry: HistoryEntry) {
  useTimelineStore.setState(s => withHistory(s, entry))
}

// ── クリップの「つかみ」(元に戻す・やり直すで作り直しても同じクリップを指す)──────────────
// 元に戻す・やり直すでクリップを消して作り直すと id が変わる(しかも SQLite は消した一番大きい id を別のクリップに
// 使い回す)。なので履歴(撮影のつまみ・移動・トリミング)は id でなく、つかみ(ClipRef)を持つ。
// 消して作り直す側(分割・削除・追加・撮影の分ける/敷くの元に戻す・やり直す)は、消すときにつかみを預かり(parkClipRef)、
// 作り直したクリップへ渡す(giveClipRef)。預かっている間に同じ id が別のクリップに使われても、つかみはそちらへ行かない
export interface ClipRef { id: number }
const liveRefs = new Map<number, ClipRef>()      // 今在るクリップ id → つかみ
/** 今在るクリップのつかみ(無ければ作る) */
export function clipRef(id: number): ClipRef {
  let r = liveRefs.get(id)
  if (!r) { r = { id }; liveRefs.set(id, r) }
  return r
}
/** これから消すクリップのつかみを預かる(作り直したら giveClipRef で渡す) */
export function parkClipRef(ref: ClipRef) {
  if (liveRefs.get(ref.id) === ref) liveRefs.delete(ref.id)
}
/** 消すクリップ id のつかみを預かって返す(だれもつかんでいなければ新しいつかみ) */
export function takeClipRef(id: number): ClipRef {
  const r = liveRefs.get(id) ?? { id }
  parkClipRef(r)
  return r
}
/** 預かったつかみを、作り直したクリップ newId へ渡す */
export function giveClipRef(ref: ClipRef, newId: number) {
  const stale = liveRefs.get(newId)
  if (stale && stale !== ref) stale.id = -1      // 使い回された id に残っていた、消えたクリップのつかみ: もうどこも指さない
  ref.id = newId
  liveRefs.set(newId, ref)
}

// ── ストアの外で待っている保存(🎬 撮影パネルのつまみ: 止まってから 300ms 後に保存)──────────
// settle  : 元に戻す・やり直すの前に、待っている保存を送り終える(後から届いた保存が履歴の順を崩さないように)
// overlay : 共同編集の読み直しで、まだ保存していない手元の書き換えを読み直した中身へ重ね直す
let pendingEdits: { settle: () => Promise<void>; overlay: (clips: Clip[]) => Clip[] } | null = null
export function registerPendingEdits(h: { settle: () => Promise<void>; overlay: (clips: Clip[]) => Clip[] }) {
  pendingEdits = h
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
  refSel: number[]                                  // 選択中のRefクリップ(選択順)
  designCut: number | null                          // 🔗設計リンクレーンで注目中のカット番号(nullなら再生位置のカット)
  toggleRefSel: (clipId: number) => void
  clearRefSel: () => void
  setTrackHidden: (trackId: number, hidden: boolean) => Promise<void>
  reorderTrack: (dragId: number, targetId: number) => Promise<void>
  deleteTrack: (trackId: number) => Promise<void>
  addClip: (trackId: number, assetId: number | null, startFrame: number, durationFrames: number) => Promise<Clip>
  /** ■単色/◌ぼかし フィルタークリップを作る(asset_id=null, kind+attrs_json)。アンドゥ可 */
  addFilterClip: (trackId: number, kind: 'solid' | 'blur', startFrame: number, durationFrames: number, attrsJson: string) => Promise<Clip>
  /** 映像トラックを任意の order で作る(最前面に置くなら既存の最小 order - 1) */
  addTrackAt: (projectId: number, type: 'video' | 'audio' | 'reference', name: string, order: number) => Promise<Track>
  placeClip: (projectId: number, trackType: 'video' | 'audio' | 'reference', assetId: number, durationFrames: number, atFrame?: number) => Promise<Clip>
  moveClip: (clipId: number, prevFrame: number, newFrame: number) => Promise<void>
  trimClip: (clipId: number, before: ClipUpdate, after: ClipUpdate) => Promise<void>
  deleteClip: (clipId: number) => Promise<void>
  /** Imageトラックのピンはペア(開始/終了)で削除する。ピンでなければ deleteClip と同じ。
   *  1本だけ消すと以降の全カットのペアがずれる(2026-09-07 の事故)ため、単独削除の入口を塞ぐ */
  deletePin: (clipId: number) => Promise<void>
  splitClip: (clipId: number, splitFrame: number) => Promise<void>
  updateClip: (clipId: number, data: ClipUpdate) => Promise<void>
  // Optimistic + debounced persist — for live slider/keyframe scrubbing in the
  // inspector. Local state updates synchronously (no await → no focus loss / jank);
  // the server PATCH is coalesced to the last value after ~200ms idle.
  liveUpdateClip: (clipId: number, data: ClipUpdate) => void
  setClipSpeed: (clipId: number, speed: number, ease?: SpeedEase) => Promise<void>
  /** 速度エンベロープ適用: ease文字列(curve:サンプル;k=キーポイント)+平均speedで尺を再計算 */
  applySpeedEnvelope: (clipId: number, easeStr: SpeedEase, mean: number, flat: boolean, sourceFrames?: number) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  setCurrentFrame: (frame: number) => void
  setDesignCut: (n: number | null) => void
  setZoom: (pixelsPerFrame: number) => void
  setSelectedClipId: (id: number | null) => void
  setEditingClipId: (id: number | null) => void
  // Preview-only layer visibility (declutter / lighten preview; does NOT affect render)
  previewHidden: number[]                 // track ids hidden in the compositor
  /** クリップ端ドラッグのモード: trim=切り詰め / stretch=素材範囲そのまま尺と速度を同時に変える(Ctrl/⌘で一時反転) */
  edgeStretch: boolean
  /** 🔍解像度表示: クリップに解像度・生成ティアのバッジを出し、ネイティブ未満を赤枠にする */
  showRes: boolean
  setShowRes: (v: boolean) => void
  setEdgeStretch: (v: boolean) => void
  toggleTrackHidden: (trackId: number) => void
  // クリップごとの読み込み済み範囲(クリップ長に対する割合の区間リスト)。
  // PreviewPlayerが定期更新し、TrackLaneが配信サービス風のバッファバーとして描画する。
  clipBuffered: Record<number, [number, number][]>
  setClipBuffered: (m: Record<number, [number, number][]>) => void
  // 高画質(原本)層の読み込み状況(別色バーで表示)
  clipBufferedHQ: Record<number, [number, number][]>
  setClipBufferedHQ: (m: Record<number, [number, number][]>) => void
}

export const useTimelineStore = create<TimelineState>((set, get) => {
  const pushHistory = (entry: HistoryEntry) => {
    set(s => withHistory(s, entry))
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
    showRes: (() => { try { return localStorage.getItem('timeline.showRes') === '1' } catch { return false } })(),
    setShowRes: (v) => { try { localStorage.setItem('timeline.showRes', v ? '1' : '0') } catch { /* ignore */ } ; set({ showRes: v }) },
    edgeStretch: (() => { try { return localStorage.getItem('timeline.edgeStretch') === '1' } catch { return false } })(),
    setEdgeStretch: (v) => { try { localStorage.setItem('timeline.edgeStretch', v ? '1' : '0') } catch { /* ignore */ } ; set({ edgeStretch: v }) },
    clipBuffered: {},
    setClipBuffered: (m) => set({ clipBuffered: m }),
    clipBufferedHQ: {},
    setClipBufferedHQ: (m) => set({ clipBufferedHQ: m }),

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
      set({ tracks, clips: pendingEdits ? pendingEdits.overlay(clips) : clips })
    },

    refSel: [],
    designCut: null,
    toggleRefSel: (clipId) => set(s => ({
      refSel: s.refSel.includes(clipId)
        ? s.refSel.filter(id => id !== clipId)
        : [...s.refSel, clipId],
    })),
    clearRefSel: () => set({ refSel: [] }),

    setTrackHidden: async (trackId, hidden) => {
      await tracksApi.update(trackId, { hidden })
      set(s => ({ tracks: s.tracks.map(t => t.id === trackId ? { ...t, hidden } : t) }))
      notifyEdit()
    },

    // dragIdのトラックをtargetIdの位置へ差し込み、全トラックのorderを振り直す
    reorderTrack: async (dragId, targetId) => {
      if (dragId === targetId) return
      const sorted = [...get().tracks].sort((a, b) => a.order - b.order)
      const from = sorted.findIndex(t => t.id === dragId)
      const to   = sorted.findIndex(t => t.id === targetId)
      if (from < 0 || to < 0) return
      const [moved] = sorted.splice(from, 1)
      sorted.splice(to, 0, moved)
      const prevOrder = new Map(get().tracks.map(t => [t.id, t.order]))
      const renum = sorted.map((t, i) => ({ ...t, order: i }))
      set({ tracks: renum })
      await Promise.all(renum
        .filter(t => prevOrder.get(t.id) !== t.order)
        .map(t => tracksApi.update(t.id, { order: t.order })))
      notifyEdit()
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

      const ref = clipRef(clip.id)
      pushHistory({
        label: 'クリップ追加',
        undoFn: async () => {
          const id = ref.id
          parkClipRef(ref)
          await clipsApi.delete(id)
          set(s => ({ clips: s.clips.filter(c => c.id !== id) }))
        },
        redoFn: async () => {
          const newClip = await clipsApi.create({
            track_id: trackId, asset_id: assetId,
            start_frame: startFrame, duration_frames: durationFrames, asset_in_frame: 0,
          })
          giveClipRef(ref, newClip.id)
          set(s => ({ clips: [...s.clips, newClip] }))
        },
      })

      notifyEdit()
      return clip
    },

    addFilterClip: async (trackId, kind, startFrame, durationFrames, attrsJson) => {
      const data = {
        track_id: trackId, asset_id: null, start_frame: startFrame,
        duration_frames: durationFrames, asset_in_frame: 0, kind, attrs_json: attrsJson,
      }
      const clip = await clipsApi.create(data)
      set(s => ({ clips: [...s.clips, clip] }))
      const ref = clipRef(clip.id)
      pushHistory({
        label: kind === 'solid' ? '単色レイヤー追加' : 'ぼかしレイヤー追加',
        undoFn: async () => {
          const id = ref.id
          parkClipRef(ref)
          await clipsApi.delete(id)
          set(s => ({ clips: s.clips.filter(c => c.id !== id) }))
        },
        redoFn: async () => {
          const c2 = await clipsApi.create(data)
          giveClipRef(ref, c2.id)
          set(s => ({ clips: [...s.clips, c2] }))
        },
      })
      notifyEdit()
      return clip
    },

    addTrackAt: async (projectId, type, name, order) => {
      const track = await tracksApi.create({ project_id: projectId, name, track_type: type, order })
      set(s => ({ tracks: [...s.tracks, track] }))
      notifyEdit()
      return track
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

      const ref = clipRef(clipId)
      pushHistory({
        label: 'クリップ移動',
        undoFn: async () => {
          const id = ref.id
          await clipsApi.update(id, { start_frame: prevFrame })
          applyLocal(id, { start_frame: prevFrame })
        },
        redoFn: async () => {
          const id = ref.id
          await clipsApi.update(id, { start_frame: newFrame })
          applyLocal(id, { start_frame: newFrame })
        },
      })
    },

    trimClip: async (clipId, before, after) => {
      // サーバーは映像クリップを伸ばすとき尺をカット境界で切り詰めることがある
      // (routers/clips.py _clamp_duration_to_cut)。要求値でなく返り値を反映し、
      // 速度伸縮(speed 同時指定)で尺が変わった場合は素材範囲を保つよう速度を再計算する。
      const persist = async (data: ClipUpdate, id = clipId) => {
        let upd = await clipsApi.update(id, data)
        if (data.speed != null && data.duration_frames != null && upd.duration_frames !== data.duration_frames) {
          const span = data.duration_frames * data.speed
          const sp = Math.max(0.05, Math.min(8, span / Math.max(1, upd.duration_frames)))
          upd = await clipsApi.update(id, { speed: Number(sp.toFixed(4)) })
        }
        set(s => ({ clips: s.clips.map(c => c.id === id ? upd : c) }))
      }
      await persist(after)
      notifyEdit()

      const ref = clipRef(clipId)
      pushHistory({
        label: 'トリミング',
        undoFn: async () => {
          const id = ref.id
          await clipsApi.update(id, before)
          applyLocal(id, before as Partial<Clip>)
        },
        redoFn: async () => {
          await persist(after, ref.id)
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
      const ref = takeClipRef(clipId)
      const { id: _id, ...clipData } = clip as Clip & { id: number }
      pushHistory({
        label: 'クリップ削除',
        undoFn: async () => {
          const newClip = await clipsApi.create(clipData)
          giveClipRef(ref, newClip.id)
          restoredId = newClip.id
          set(s => ({ clips: [...s.clips, newClip] }))
        },
        redoFn: async () => {
          if (restoredId === -1) return
          const id = ref.id
          restoredId = -1
          parkClipRef(ref)
          await clipsApi.delete(id)
          set(s => ({ clips: s.clips.filter(c => c.id !== id) }))
        },
      })
    },

    deletePin: async (clipId) => {
      const st = get()
      const clip = st.clips.find(c => c.id === clipId)
      if (!clip) return
      const tr = st.tracks.find(t => t.id === clip.track_id)
      const isPinTrack = !!tr && tr.track_type === 'reference' && tr.name === 'Image'
      if (!isPinTrack) return st.deleteClip(clipId)
      const pins = st.clips.filter(c => c.track_id === clip.track_id && c.asset_id != null)
        .sort((a, b) => a.start_frame - b.start_frame || a.id - b.id)
      const idx = pins.findIndex(c => c.id === clipId)
      const partner = idx < 0 ? undefined : pins[idx % 2 === 0 ? idx + 1 : idx - 1]
      const targets = partner ? [clip, partner] : [clip]
      for (const c of targets) await clipsApi.delete(c.id)
      const ids = new Set(targets.map(c => c.id))
      set(s => ({ clips: s.clips.filter(c => !ids.has(c.id)) }))
      notifyEdit()

      let restored = false
      const refs = targets.map(c => takeClipRef(c.id))
      const datas = targets.map(c => { const { id: _id, ...d } = c as Clip & { id: number }; return d })
      pushHistory({
        label: partner ? 'カット(ピン2本)削除' : 'ピン削除',
        undoFn: async () => {
          const created = await Promise.all(datas.map(d => clipsApi.create(d)))
          created.forEach((c, i) => giveClipRef(refs[i], c.id))
          restored = true
          set(s => ({ clips: [...s.clips, ...created] }))
        },
        redoFn: async () => {
          if (!restored) return
          restored = false
          const ids2 = refs.map(r => r.id)
          refs.forEach(parkClipRef)
          for (const id of ids2) await clipsApi.delete(id)
          set(s => ({ clips: s.clips.filter(c => !ids2.includes(c.id)) }))
        },
      })
    },

    splitClip: async (clipId, splitFrame) => {
      const clip = get().clips.find(c => c.id === clipId)
      if (!clip) return
      // 🔤 字幕は分けない(分けると字幕が 2 枚になり、それぞれが出現・消失する)。長さは端のトリムで
      if (isCreditClip(clip)) {
        try { useUIStore.getState().pushToast('字幕は分割できません(長さはトリムで)', 'info') } catch { /* noop */ }
        return
      }
      if (splitFrame <= clip.start_frame || splitFrame >= clip.start_frame + clip.duration_frames) return

      const leftDuration = splitFrame - clip.start_frame
      const rightDuration = clip.duration_frames - leftDuration

      const [left, right] = await Promise.all([
        clipsApi.create({
          track_id: clip.track_id, asset_id: clip.asset_id,
          start_frame: clip.start_frame, duration_frames: leftDuration,
          asset_in_frame: clip.asset_in_frame,
          ...filterCarry(clip, 0, leftDuration),
        }),
        clipsApi.create({
          track_id: clip.track_id, asset_id: clip.asset_id,
          start_frame: splitFrame, duration_frames: rightDuration,
          asset_in_frame: clip.asset_in_frame + leftDuration,
          ...filterCarry(clip, leftDuration, rightDuration),
        }),
      ])
      await clipsApi.delete(clipId)
      set(s => ({
        clips: [...s.clips.filter(c => c.id !== clipId), left, right],
      }))
      notifyEdit()

      // 分ける前の 1 本・左・右のつかみ(作り直すと id が変わる。古い id を覚えている履歴が今のクリップに届くように)
      const wholeRef = takeClipRef(clipId), leftRef = clipRef(left.id), rightRef = clipRef(right.id)
      let restoredId = -1
      // 元に戻すで作り直すのは分ける前の 1 本そのまま(重なりの溶け transition_*・💍 指輪の位置の印・🎬 撮影の設定なども全部戻す)
      const { id: _wholeId, ...wholeData } = clip as Clip & { id: number }

      pushHistory({
        label: 'クリップ分割',
        undoFn: async () => {
          const lId = leftRef.id, rId = rightRef.id
          parkClipRef(leftRef); parkClipRef(rightRef)
          await Promise.all([clipsApi.delete(lId), clipsApi.delete(rId)])
          const restored = await clipsApi.create(wholeData)
          giveClipRef(wholeRef, restored.id)
          restoredId = restored.id
          set(s => ({
            clips: [...s.clips.filter(c => c.id !== lId && c.id !== rId), restored],
          }))
        },
        redoFn: async () => {
          if (restoredId === -1) return
          const rId = wholeRef.id
          parkClipRef(wholeRef)
          const [newLeft, newRight] = await Promise.all([
            clipsApi.create({
              track_id: clip.track_id, asset_id: clip.asset_id,
              start_frame: clip.start_frame, duration_frames: leftDuration,
              asset_in_frame: clip.asset_in_frame,
              ...filterCarry(clip, 0, leftDuration),
            }),
            clipsApi.create({
              track_id: clip.track_id, asset_id: clip.asset_id,
              start_frame: splitFrame, duration_frames: rightDuration,
              asset_in_frame: clip.asset_in_frame + leftDuration,
              ...filterCarry(clip, leftDuration, rightDuration),
            }),
          ])
          await clipsApi.delete(rId)
          giveClipRef(leftRef, newLeft.id); giveClipRef(rightRef, newRight.id)
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
          // reconcile only if no newer edit landed while the PATCH was in flight — and only the fields we sent
          // (サーバーの写しで丸ごと置き換えると、ほかの欄の保存前の手元の変更(🎬 撮影パネルのつまみ等)が一瞬消える)
          if (!livePending[clipId]) {
            const sent: Partial<Clip> = {}
            for (const k of Object.keys(d) as (keyof Clip)[]) (sent as Record<string, unknown>)[k] = updated[k]
            set(s => ({ clips: s.clips.map(c => c.id === clipId ? { ...c, ...sent } : c) }))
          }
        } catch { /* keep optimistic state */ }
        notifyEdit()
      }, 200)
    },

    // Change playback speed; the source span stays fixed so the timeline
    // duration auto-adjusts (faster → shorter clip).
    applySpeedEnvelope: async (clipId, easeStr, mean, flat, sourceFrames) => {
      const clip = get().clips.find(c => c.id === clipId)
      if (!clip) return
      const sourceConsumed = sourceFrames ?? clip.duration_frames * (clip.speed || 1)
      const sp = Math.max(0.1, Math.min(8, mean))
      const newDuration = Math.max(1, Math.round(sourceConsumed / sp))
      const data: ClipUpdate = {
        speed: sp,
        duration_frames: newDuration,
        speed_ease: flat ? 'linear' : easeStr,
      }
      const updated = await clipsApi.update(clipId, data)
      set(s2 => ({ clips: s2.clips.map(c => c.id === clipId ? updated : c) }))
      notifyEdit()
    },

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
      // 待っている保存(撮影のつまみ)を先に送り切る: 保存の履歴が積まれてから、その 1 つを戻す
      if (pendingEdits) { try { await pendingEdits.settle() } catch { /* 送れなくても戻す */ } }
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
      if (pendingEdits) { try { await pendingEdits.settle() } catch { /* 送れなくてもやり直す */ } }
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
    setDesignCut: (n) => set({ designCut: n }),
    setZoom: (ppf) => set({ pixelsPerFrame: Math.max(0.05, Math.min(10, ppf)) }),
    setSelectedClipId: (id) => set({ selectedClipId: id }),
    setEditingClipId: (id) => set({ editingClipId: id }),
  }
})
