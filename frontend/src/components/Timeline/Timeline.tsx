import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { Asset, TransitionType, BeatMatchResult } from '../../api/client'
import { clipsApi, jobsApi, analysisApi, assetsApi, tracksApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useAnalysisStore } from '../../store/analysisStore'
import { useCollabStore } from '../../store/collabStore'
import { useUIStore } from '../../store/uiStore'
import { TimeRuler } from './TimeRuler'
import { BeatRuler } from './BeatGrid'
import { TrackLane } from './TrackLane'
import { RenderDialog } from '../RenderDialog'
import { createPortal } from 'react-dom'
import { SpeedCurveEditor, pointsFromEase, samplesFromPoints, easeStringFromPoints } from './SpeedCurveEditor'
import { CutLane } from './CutLane'
import { SceneLane, deriveCutsWithScene } from './SceneLane'
import { BoardSheet } from './BoardSheet'
import { StoryScroll } from './StoryScroll'
import { DesignMap } from './DesignMap'
import { ClipInspector } from './ClipInspector'
import { RegenPanel } from './RegenPanel'
import { ShotTunePopover } from './ShotTunePopover'
import { PinSwapModal } from './PinSwapModal'
import { NightBatchPanel } from './NightBatchPanel'
import { I2VSelPopover } from './I2VSelPopover'
import { RhythmLane } from './RhythmLane'
import { MotionBudgetLane } from './MotionBudgetLane'
import { MB_ROWS, MB_ALL, MB_COMPACT } from './motionBudgetRows'

const LABEL_WIDTH = 112  // px — must match TrackLane w-28 (7rem = 112px)
const MIN_TIMELINE_SECS = 60

interface Props {
  projectId: number
  fps: number
  assets: Asset[]
}

export function Timeline({ projectId, fps, assets }: Props) {
  const {
    tracks, clips, currentFrame, pixelsPerFrame,
    canUndo, canRedo, undoStack, redoStack,
    loadTimeline, addTrack, addClip, placeClip, splitClip,
    deleteClip, setCurrentFrame, setZoom, undo, redo, setClipSpeed, applySpeedEnvelope, updateClip, liveUpdateClip,
    selectedClipId, setSelectedClipId, syncFromServer,
  } = useTimelineStore()

  const scrollRef      = useRef<HTMLDivElement>(null)

  // 再生追従: プレイヘッドが可視範囲から出たらスクロールして追いかける
  // (停止中に手でスクロールして離れても、currentFrameが動かない限り介入しない)
  // 再生ヘッド追従スクロール。ズーム(pixelsPerFrame変更)では発動させない —
  // ズーム時はカーソル位置アンカーが優先で、ここが動くと表示領域が飛ぶ。
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    const ppf = useTimelineStore.getState().pixelsPerFrame
    const x = LABEL_WIDTH + currentFrame * ppf
    const viewL = sc.scrollLeft + LABEL_WIDTH
    const viewR = sc.scrollLeft + sc.clientWidth
    if (x < viewL + 8 || x > viewR - 40) {
      sc.scrollLeft = Math.max(0, x - LABEL_WIDTH - sc.clientWidth * 0.3)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFrame])

  // ズームのアンカー維持: 新しいppfでのレイアウト確定後にscrollLeftを適用する。
  // (レイアウト前に代入すると古いscrollWidthでクランプされて表示領域が飛ぶ)
  const pendingScrollRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const sc = scrollRef.current
    if (sc && pendingScrollRef.current != null) {
      sc.scrollLeft = pendingScrollRef.current
      pendingScrollRef.current = null
    }
  }, [pixelsPerFrame])
  const containerRef   = useRef<HTMLDivElement>(null)
    const [boardSheetOpen, setBoardSheetOpen] = useState(false)   // 🎬 コンテ表
  const [designMapOpen, setDesignMapOpen] = useState(false)     // 🗺 設計マップ
  const [storyOpen, setStoryOpen] = useState(false)             // 📜 ストーリー
const [showRenderDialog, setShowRenderDialog] = useState(false)
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [beatMatch, setBeatMatch] = useState<BeatMatchResult | null>(null)
  const [scoring, setScoring] = useState(false)
  const [showCurveEditor, setShowCurveEditor] = useState(false)
  const [curveSrcFrames, setCurveSrcFrames] = useState(0)   // ∿編集中のソース量(開いた時点で固定)
  const [showInspector, setShowInspector] = useState(false)
  const [showShotTune, setShowShotTune] = useState(false)
  const [showPinSwap, setShowPinSwap] = useState(false)
  const [showNightBatch, setShowNightBatch] = useState(false)
  const refSel = useTimelineStore(s => s.refSel)
  const swapPin = refSel.length >= 1 ? clips.find(c => c.id === refSel[refSel.length - 1]) ?? null : null

  const { beats } = useAnalysisStore()
  const remoteUsers = useCollabStore(s => s.others)

  useEffect(() => { loadTimeline(projectId, fps) }, [projectId, fps])

  // ── カット割りの空き自動補完 & ピン画像の追従 ──────────────────────────
  // ・ピン移動/カット端スライドで隣カットとの間に空き(≥1フレーム)ができたら、
  //   即座に新しいカット(ピンペア)を仮画像で生成し、裏でVideoの実フレームに差し替える。
  // ・自動抽出画像(frame_*)のピンは、移動後に新しい時刻のフレームへ自動で差し替える。
  //   手動で選んだ画像や色ピンは勝手に置き換えない。
  const gapFillBusyRef = useRef(false)
  const remapTimer = useRef<number | null>(null)   // テイク再紐付けのデバウンス
  useEffect(() => {
    const videoFrameAssetAt = async (frame: number): Promise<number | null> => {
      const st = useTimelineStore.getState()
      const videoTracks = st.tracks
        .filter(t => t.track_type === 'video' && t.name !== 'Shots' && !t.hidden)
        .sort((a, b) => a.order - b.order)
      for (const vt of videoTracks) {
        const c = st.clips.find(c => c.track_id === vt.id && c.asset_id != null &&
          c.start_frame <= frame && frame < c.start_frame + c.duration_frames)
        if (c) {
          const t = (frame - c.start_frame + c.asset_in_frame) / fps
          const a = await assetsApi.extractFrame(c.asset_id!, Math.max(0, t), 1280)
          return a.id
        }
      }
      return null
    }
    // 自動抽出画像のピンだけ、現在位置のフレームに画像を差し替える(古い抽出画像は掃除)
    const refreshPinImage = async (clipId: number) => {
      const st = useTimelineStore.getState()
      const clip = st.clips.find(c => c.id === clipId)
      if (!clip || clip.asset_id == null) return
      const asset = assets.find(a => a.id === clip.asset_id)
      if (!asset || !/^frame_\d+_/.test(asset.name)) return   // 手動画像は保持
      const newId = await videoFrameAssetAt(clip.start_frame)
      if (newId == null) return
      const oldId = clip.asset_id
      await st.updateClip(clipId, { asset_id: newId })
      const stillUsed = useTimelineStore.getState().clips.some(c => c.id !== clipId && c.asset_id === oldId)
      if (!stillUsed) { try { await assetsApi.delete(oldId) } catch { /* noop */ } }
      window.dispatchEvent(new Event('kychapogas:assets-changed'))
    }
    const fillGaps = async (aroundClipId: number) => {
      const st = useTimelineStore.getState()
      const imgTrack = st.tracks.find(t => t.track_type === 'reference' && t.name === 'Image' && !t.hidden)
      if (!imgTrack) return
      const pins = st.clips
        .filter(c => c.track_id === imgTrack.id && c.asset_id != null)
        .sort((a, b) => a.start_frame - b.start_frame)
      const idx = pins.findIndex(p => p.id === aroundClipId)
      if (idx < 0) return
      const gaps: Array<{ s: number, e: number }> = []
      for (let i = 1; i + 1 < pins.length; i += 2) {   // 終端ピン(奇数)→次の開始ピン
        const endPin = pins[i]
        const nextStart = pins[i + 1]
        const gap = nextStart.start_frame - (endPin.start_frame + 1)
        if (gap >= 1 && (endPin.id === aroundClipId || nextStart.id === aroundClipId)) {
          gaps.push({ s: endPin.start_frame + 1, e: nextStart.start_frame - 1 })
        }
      }
      for (const g of gaps) {
        // 即時: 隣の画像を仮置きしてピンを立て、裏で実フレームに差し替える。
        // 1フレームカット(g.s === g.e)は開始/終了ピンが同フレームに重なる。
        const fallback = pins[idx].asset_id!
        const c1 = await st.addClip(imgTrack.id, fallback, g.s, 15)
        const c2 = await st.addClip(imgTrack.id, fallback, g.e, 15)
        void (async () => {
          const sAsset = await videoFrameAssetAt(g.s)
          if (sAsset != null) await useTimelineStore.getState().updateClip(c1.id, { asset_id: sAsset })
          const eAsset = g.e === g.s ? sAsset : await videoFrameAssetAt(g.e)
          if (eAsset != null) await useTimelineStore.getState().updateClip(c2.id, { asset_id: eAsset })
          window.dispatchEvent(new Event('kychapogas:assets-changed'))
        })()
      }
    }
    const onPinMoved = async (ev: Event) => {
      const movedClipId = (ev as CustomEvent).detail?.clipId as number | undefined
      if (movedClipId == null || gapFillBusyRef.current) return
      gapFillBusyRef.current = true
      try {
        await fillGaps(movedClipId)
        void refreshPinImage(movedClipId)
      } finally { gapFillBusyRef.current = false }
    }
    // カット端ロール(両カットの境界移動): 双方のピン画像を追従させるだけ(空きは生じない)
    const onPinRoll = (ev: Event) => {
      const ids = ((ev as CustomEvent).detail?.clipIds ?? []) as number[]
      for (const id of ids) void refreshPinImage(id)
    }
    // テイクの紐付け直しは手動操作(kychapogas:remap-takes)でのみ走らせる。
    // ピンを動かすたびに自動で書き換えると、短いカットが隣り合う箇所で
    // 取り違えが起きるうえ、いつ書き換わったかが追えなくなるため。
    const onRemapRequested = () => remapTakesToCuts()
    // 🗂 カット割りが変わったらテイクの紐付けを追従させる。
    // テイクは生成時のplace.start_frameでカットに紐付くため、ピンを動かすと履歴から消える。
    // 連続ドラッグで叩き続けないよう、最後の操作から少し待ってから1回だけ実行する。
    const remapTakesToCuts = () => {
      if (remapTimer.current) window.clearTimeout(remapTimer.current)
      remapTimer.current = window.setTimeout(async () => {
        const st = useTimelineStore.getState()
        const img = st.tracks.find(t => t.track_type === 'reference' && t.name === 'Image')
        if (!img) return
        const pins = st.clips.filter(c => c.track_id === img.id && c.asset_id != null)
          .sort((a, b) => a.start_frame - b.start_frame)
        const starts: number[] = []
        for (let i = 0; i + 1 < pins.length; i += 2) starts.push(pins[i].start_frame)
        if (!starts.length) return
        try {
          const r = await assetsApi.remapTakes(projectId, starts)
          // Scenes枠もカット割りへ追従させる(枠はピンIDに束縛されている)。
          // これでピンを微調整しても、枠の位置と尺が自動で付いてくる。
          const sy = await tracksApi.scenesSync(projectId)
          if (sy.moved || sy.created) await st.syncFromServer(projectId)
          window.dispatchEvent(new CustomEvent('kychapogas:toast',
            { detail: `🗂 テイク${r.updated}件 / 枠 追従${sy.moved}・新設${sy.created}` }))
        } catch { /* 失敗しても編集は妨げない(表示側の±8f照合が保険になる) */ }
      }, 50)
    }
    window.addEventListener('kychapogas:pin-moved', onPinMoved)
    window.addEventListener('kychapogas:pin-roll', onPinRoll)
    window.addEventListener('kychapogas:remap-takes', onRemapRequested)
    return () => {
      window.removeEventListener('kychapogas:pin-moved', onPinMoved)
      window.removeEventListener('kychapogas:pin-roll', onPinRoll)
      window.removeEventListener('kychapogas:remap-takes', onRemapRequested)
    }
  }, [fps, assets])

  // クリップが参照する全アセットの解析（ビート/モーションカーブ等）をロード
  const clipAssetIds = useMemo(
    () => [...new Set(clips.map(c => c.asset_id).filter((x): x is number => x != null))],
    [clips],
  )
  useEffect(() => {
    const st = useAnalysisStore.getState()
    const missing = clipAssetIds.filter(aid => !st.curves[aid] && !st.beats[aid] && !st.loading[aid])
    if (missing.length) void st.loadAnalysisBatch(missing)
  }, [clipAssetIds])

  // Find the first audio clip that has beat analysis
  const beatInfo = useMemo(() => {
    for (const clip of clips) {
      if (!clip.asset_id) continue
      const b = beats[clip.asset_id]
      if (b) return { beat: b, clip }
    }
    return null
  }, [clips, beats])

  // 移動量バジェットの上限(画面幅%)。ここを動かして「音に対して画がどれくらい動くべきか」を
  // 実映像と見比べながら決める。既定18%は4-5秒のカットでゆるいトラック相当。
  const [motionMaxPct, setMotionMaxPct] = useState(
    () => Number(localStorage.getItem('kychapogas:motionMax') ?? 18))
  useEffect(() => { localStorage.setItem('kychapogas:motionMax', String(motionMaxPct)) }, [motionMaxPct])
  // 全系列を出すか、要点だけか。既定は全系列(最終結果だけだと判断できないため)
  const [motionFull, setMotionFull] = useState(
    () => localStorage.getItem('kychapogas:motionFull') !== '0')
  useEffect(() => { localStorage.setItem('kychapogas:motionFull', motionFull ? '1' : '0') }, [motionFull])
  // 打撃の表示下限。0だと検出した全部(毎秒1.3本)が出るので、目立つものへ絞れるようにする
  const [hitMin, setHitMin] = useState(
    () => Number(localStorage.getItem('kychapogas:hitMin') ?? 0.25))
  useEffect(() => { localStorage.setItem('kychapogas:hitMin', String(hitMin)) }, [hitMin])
  const motionRows = motionFull ? MB_ALL : MB_COMPACT

  // 盛り上げの手動編集。レーン側でドラッグ操作を解決し、確定した配列がここに来る。
  // 自動判定は当てにならない場面があるので(実測: allin1の境界では5箇所すべて「平坦」)、
  // 音楽的な「ここは溜め/ここは引き」の判断は人が置けるようにしている。
  const saveBuildups = useCallback(async (next: Array<{ start_sec: number; end_sec: number
                                                        target: string; kind: string
                                                        slope: number; break: number }>) => {
    const songId = beatInfo?.clip.asset_id
    if (songId == null) return
    // 楽観更新してから保存(戻り待ちだと連続操作で取りこぼす)
    useAnalysisStore.setState(s2 => ({ buildupOverride: { ...s2.buildupOverride, [songId]: next } }))
    try {
      if (next.length) await analysisApi.putOverride(songId, 'audio_structure', { buildups: next })
      else await analysisApi.clearOverride(songId, 'audio_structure')
    } catch { /* 失敗してもUIは次の再読込で戻る */ }
  }, [beatInfo])

  // 盛り上げの端を吸着させる小節線(フレーム)。拍だと細かすぎて 音楽的に意味が薄い。
  const downbeatFrames = useMemo(() => {
    if (!beatInfo) return [] as number[]
    const assetInSec = beatInfo.clip.asset_in_frame / fps
    return (beatInfo.beat.downbeats ?? [])
      .map(t => Math.round(beatInfo.clip.start_frame + (t - assetInSec) * fps))
      .filter(f => f >= 0)
  }, [beatInfo, fps])
  // 移動量バジェットは楽曲(=拍解析を持つクリップ)に紐づく
  const motionCuts = useMemo(
    () => deriveCutsWithScene(tracks, clips, assets).map(c => ({ idx: c.idx, s: c.s, e: c.e })),
    [tracks, clips, assets])

  // Beat positions in timeline-frame space (for beat-snapping clip edges)
  const beatFrames = useMemo(() => {
    if (!beatInfo) return [] as number[]
    const assetInSec = beatInfo.clip.asset_in_frame / fps
    return beatInfo.beat.beats
      .map(t => Math.round(beatInfo.clip.start_frame + (t - assetInSec) * fps))
      .filter(f => f >= 0)
  }, [beatInfo, fps])

  // Snap a frame to the nearest beat within ~8px; identity when snapping is off.
  const snapFrame = useCallback((frame: number) => {
    if (!snapEnabled || beatFrames.length === 0) return frame
    const threshold = 8 / pixelsPerFrame
    let best = frame, bestDist = threshold
    for (const bf of beatFrames) {
      const d = Math.abs(bf - frame)
      if (d < bestDist) { bestDist = d; best = bf }
    }
    return best
  }, [snapEnabled, beatFrames, pixelsPerFrame])

  // Selected clip — for speed controls (video clips only)
  const selectedClip = clips.find(c => c.id === selectedClipId) ?? null
  const selTrack = selectedClip ? tracks.find(t => t.id === selectedClip.track_id) : null
  const selAsset = selectedClip ? assets.find(a => a.id === selectedClip.asset_id) : null
  const isVideoClip = selTrack?.track_type === 'video'
    && (selAsset?.asset_type === 'video'
        || (selAsset?.asset_type === 'generated' && selAsset?.duration_sec != null))

  // Beat positions inside the selected clip, in clip-local t (0..1) — for the
  // inspector's beat-snap (音ハメ). Computed from the song's real beat grid.
  const selBeatTs = useMemo(() => {
    if (!selectedClip) return [] as number[]
    const { start_frame, duration_frames } = selectedClip
    const end = start_frame + duration_frames
    return beatFrames
      .filter(bf => bf >= start_frame && bf <= end)
      .map(bf => (bf - start_frame) / Math.max(1, duration_frames))
  }, [selectedClip, beatFrames])

  const totalFrames = Math.max(
    MIN_TIMELINE_SECS * fps,
    ...clips.map(c => c.start_frame + c.duration_frames),
  ) + fps * 10

  const totalWidth = Math.ceil(totalFrames * pixelsPerFrame)

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 入力欄(モーダル内含む)のタイプ中はショートカットを完全停止。
    // portalのイベントもReactツリーを伝播してここに届くため、このガードが無いと
    // プロンプト入力の "s" で分割・Backspaceでクリップ削除が誤発火する。
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    const ctrl = e.ctrlKey || e.metaKey

    if (ctrl && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      undo()
      return
    }
    if ((ctrl && e.key === 'y') || (ctrl && e.shiftKey && e.key === 'z')) {
      e.preventDefault()
      redo()
      return
    }
    const selClip = selectedClipId !== null
      ? useTimelineStore.getState().clips.find(c => c.id === selectedClipId) : undefined
    if ((e.key === 's' || e.key === 'S') && !ctrl) {
      if (selectedClipId !== null && !selClip?.locked) {
        splitClip(selectedClipId, currentFrame)
      }
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1)
      setCurrentFrame(Math.max(0, currentFrame + step))
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedClipId !== null && !selClip?.locked) {   // 🔒ロック中は削除不可
        deleteClip(selectedClipId)
        setSelectedClipId(null)
      }
    }
  }, [selectedClipId, currentFrame, splitClip, deleteClip, undo, redo, setCurrentFrame])

  // ── Wheel zoom ────────────────────────────────────────────────────────
  // Reactのwheelはパッシブ登録になりpreventDefaultが効かない(=Ctrl+ホイールで
  // ブラウザのページ拡大が発動してしまう)ため、ネイティブの非パッシブリスナーで
  // 捕まえる。Ctrl/⌘+ホイール=ズーム(カーソル位置固定)、通常ホイールは素のスクロール。
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const st = useTimelineStore.getState()
      const ppf = st.pixelsPerFrame
      const delta = e.deltaY > 0 ? 0.85 : 1.18
      const next = ppf * delta
      const rect = sc.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const frameAt = (sc.scrollLeft + mouseX - LABEL_WIDTH) / ppf
      pendingScrollRef.current = Math.max(0, frameAt * next - mouseX + LABEL_WIDTH)
      st.setZoom(next)
    }
    sc.addEventListener('wheel', onWheel, { passive: false })
    return () => sc.removeEventListener('wheel', onWheel)
  }, [])

  // ── Pinch zoom (タッチ2本指) ───────────────────────────────────────────
  const pinchRef = useRef<{ d: number; ppf: number; frameAt: number } | null>(null)
  const activePointers = useRef(new Map<number, { x: number; y: number }>())
  const handlePinchDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (activePointers.current.size === 2) {
      const [a, b] = [...activePointers.current.values()]
      const sc = scrollRef.current
      const midX = (a.x + b.x) / 2 - (sc?.getBoundingClientRect().left ?? 0)
      pinchRef.current = {
        d: Math.hypot(a.x - b.x, a.y - b.y), ppf: pixelsPerFrame,
        frameAt: ((sc?.scrollLeft ?? 0) + midX - LABEL_WIDTH) / pixelsPerFrame,
      }
    }
  }, [pixelsPerFrame])
  const handlePinchMove = useCallback((e: React.PointerEvent) => {
    if (!activePointers.current.has(e.pointerId)) return
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const p = pinchRef.current
    if (p && activePointers.current.size === 2) {
      const [a, b] = [...activePointers.current.values()]
      const next = Math.min(20, Math.max(0.05, p.ppf * (Math.hypot(a.x - b.x, a.y - b.y) / p.d)))
      const sc = scrollRef.current
      if (sc) {
        const midX = (a.x + b.x) / 2 - sc.getBoundingClientRect().left
        pendingScrollRef.current = Math.max(0, p.frameAt * next - midX + LABEL_WIDTH)
      }
      setZoom(next)
    }
  }, [setZoom])
  const handlePinchUp = useCallback((e: React.PointerEvent) => {
    activePointers.current.delete(e.pointerId)
    if (activePointers.current.size < 2) pinchRef.current = null
  }, [])

  // ── Drop asset ────────────────────────────────────────────────────────
  const handleDropAsset = async (trackId: number, assetId: number, startFrame: number) => {
    const asset = assets.find(a => a.id === assetId)
    const durationFrames = asset?.duration_sec
      ? Math.round(asset.duration_sec * fps)
      : fps * 5
    await addClip(trackId, assetId, startFrame, durationFrames)
  }

  const handleAutoCut = async () => {
    if (selectedClipId == null) return
    try {
      const res = await clipsApi.autoCutBeats(selectedClipId)
      await syncFromServer(projectId)
      useCollabStore.getState().broadcastEdit()
      useUIStore.getState().pushToast(
        res.created > 0 ? `ビートで ${res.created} 分割しました` : (res.message ?? 'ビートが見つかりません'),
        res.created > 0 ? 'success' : 'info',
      )
      setSelectedClipId(null)
    } catch { /* error toast handled by interceptor */ }
  }

  // 音ハメスコア — beat vs visual-change alignment
  const handleBeatMatch = async () => {
    setScoring(true)
    try {
      const r = await analysisApi.getBeatMatch(projectId)
      if (r.error) {
        useUIStore.getState().pushToast(r.error, 'info')
        setBeatMatch(null)
      } else {
        setBeatMatch(r)
        const weak = r.weak_beats.slice(0, 4).map(b => `${b.sec.toFixed(1)}s`).join(', ')
        useUIStore.getState().pushToast(
          `音ハメスコア ${r.score}点 — ビート一致 ${r.beats_hit}/${r.beats_total}、カット同期 ${r.cuts_on_beat}/${r.cuts_total}`
          + (weak ? `　弱: ${weak}` : ''),
          r.score >= 70 ? 'success' : 'info',
        )
      }
    } catch { /* interceptor */ } finally {
      setScoring(false)
    }
  }

  const handlePrecompose = async () => {
    try {
      await jobsApi.create(projectId, 'precompose', { project_id: projectId })
      useUIStore.getState().pushToast('タイムラインの焼き込みを開始しました（完了後ライブラリに追加）', 'info')
    } catch { /* handled by interceptor */ }
  }

  const undoLabel = undoStack.length > 0 ? undoStack[undoStack.length - 1].label : ''
  const redoLabel = redoStack.length > 0 ? redoStack[redoStack.length - 1].label : ''

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full bg-zinc-950 select-none outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900 flex-shrink-0 flex-nowrap overflow-x-auto [&>button]:flex-shrink-0 [&>button]:whitespace-nowrap [&>span]:flex-shrink-0 [&>div]:flex-shrink-0 max-sm:px-2 max-sm:[&>button]:py-1.5">
        <button
          onClick={() => addTrack(projectId, 'video', `Video ${tracks.filter(t => t.track_type === 'video').length + 1}`)}
          className="text-[11px] px-2 py-0.5 rounded bg-blue-900 hover:bg-blue-800 text-blue-200"
        >+ Video</button>
        <button
          onClick={() => addTrack(projectId, 'audio', `Audio ${tracks.filter(t => t.track_type === 'audio').length + 1}`)}
          className="text-[11px] px-2 py-0.5 rounded bg-green-900 hover:bg-green-800 text-green-200"
        >+ Audio</button>
        <button
          onClick={() => addTrack(projectId, 'reference', `Ref ${tracks.filter(t => t.track_type === 'reference').length + 1}`)}
          className="text-[11px] px-2 py-0.5 rounded bg-amber-900 hover:bg-amber-800 text-amber-200"
          title="参照キーフレームトラック（I2V生成用）"
        >+ Ref</button>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('kychapogas:open-board'))}
          title="📋 絵コンテ（再生ヘッド位置のシーン）— シーンレーンのブロックを右クリック/長押しでも開けます"
          className="text-[11px] px-2 py-0.5 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-200"
        >📋 絵コンテ</button>
        <button
          onClick={() => setBoardSheetOpen(true)}
          title="🎬 コンテ表（全カットの一覧 — 絵コンテ静止画・歌詞・意図・尺。検討用）"
          className="text-[11px] px-2 py-0.5 rounded bg-cyan-900 hover:bg-cyan-800 text-cyan-200"
        >🎬 コンテ表</button>
        <button
          onClick={() => setDesignMapOpen(true)}
          title="🗺 設計マップ（全カットの設計・歌詞・⚠注意点・カット間リンクを1枚で。ピンのattrs_jsonが唯一の正）"
          className="text-[11px] px-2 py-0.5 rounded bg-amber-900 hover:bg-amber-800 text-amber-200"
        >🗺 設計マップ</button>
        <button
          onClick={() => setStoryOpen(true)}
          title="📜 ストーリー（縦スクロールの絵コンテ台本 — Claudeの演出意図・コメント対話）"
          className="text-[11px] px-2 py-0.5 rounded bg-violet-900 hover:bg-violet-800 text-violet-200"
        >📜 ストーリー</button>

        <button
          onClick={() => setSnapEnabled(v => !v)}
          disabled={!beatInfo}
          title={beatInfo ? 'ビートスナップ（クリップ端をビートに吸着）' : '音声のビート解析後に有効'}
          className={`text-[11px] px-2 py-0.5 rounded disabled:opacity-30
            ${snapEnabled && beatInfo
              ? 'bg-emerald-800 text-emerald-100'
              : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
        >🧲 音ハメ{snapEnabled ? 'ON' : 'OFF'}</button>

        <button
          onClick={handleBeatMatch}
          disabled={!beatInfo || scoring}
          title={beatInfo
            ? '音ハメスコア: ビートと映像変化（カット/モーション）の一致度を採点'
            : '音声のビート解析後に有効'}
          className={`text-[11px] px-2 py-0.5 rounded disabled:opacity-30 ${
            beatMatch
              ? beatMatch.score >= 70
                ? 'bg-emerald-900 text-emerald-200'
                : 'bg-amber-900 text-amber-200'
              : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
          }`}
        >♪ {scoring ? '採点中…' : beatMatch ? `${beatMatch.score}点` : 'スコア'}</button>

        <button
          onClick={async () => {
            try {
              const r = await clipsApi.scatterBeatEffects(projectId, 'flash', 'downbeat')
              await syncFromServer(projectId)
              useUIStore.getState().pushToast(
                r.error ?? `小節頭 ${r.count} 箇所に白フラッシュを散布しました`, r.error ? 'info' : 'success')
            } catch { /* interceptor */ }
          }}
          disabled={!beatInfo}
          className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 disabled:opacity-30"
          title="全小節頭に白フラッシュを一括散布（音ハメ一括）"
        >⚡拍フラッシュ</button>
        <button
          onClick={async () => {
            try {
              const r = await clipsApi.scatterBeatEffects(projectId, 'punch', 'downbeat')
              await syncFromServer(projectId)
              useUIStore.getState().pushToast(
                r.error ?? `小節頭 ${r.count} 箇所にパンチインを散布しました`, r.error ? 'info' : 'success')
            } catch { /* interceptor */ }
          }}
          disabled={!beatInfo}
          className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 disabled:opacity-30"
          title="全小節頭にズームパンチを一括散布（静止画MAD風）"
        >⚡拍パンチ</button>

        <div className="w-px h-4 bg-zinc-700 mx-1" />

        {/* Undo / Redo */}
        <button
          onClick={() => undo()}
          disabled={!canUndo}
          title={canUndo ? `元に戻す: ${undoLabel}` : ''}
          className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed"
        >↩ 元に戻す</button>
        <button
          onClick={() => redo()}
          disabled={!canRedo}
          title={canRedo ? `やり直す: ${redoLabel}` : ''}
          className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed"
        >↪ やり直す</button>

        {selectedClipId !== null && (
          <>
            <div className="w-px h-4 bg-zinc-700 mx-1" />
            <button
              onClick={() => { splitClip(selectedClipId, currentFrame) }}
              className="text-[11px] px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200"
              title="再生ヘッドでクリップを分割 (S)"
            >✂ 分割</button>
            <button
              onClick={() => { deleteClip(selectedClipId); setSelectedClipId(null) }}
              className="text-[11px] px-2 py-0.5 rounded bg-red-900 hover:bg-red-800 text-red-200"
              title="クリップを削除 (Del)"
            >✕ 削除</button>

            {isVideoClip && beatInfo && (
              <button
                onClick={handleAutoCut}
                className="text-[11px] px-2 py-0.5 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-200"
                title="クリップ範囲のビートで自動分割（音ハメ）"
              >🎵 ビートで分割</button>
            )}

            {/* Transition into this clip (rendered on the primary video track) */}
            {selTrack?.track_type === 'video' && selectedClip && (
              <>
                <div className="w-px h-4 bg-zinc-700 mx-1" />
                <span className="text-[10px] text-zinc-500">遷移</span>
                <select
                  value={selectedClip.transition_in ?? ''}
                  onChange={e => {
                    const t = e.target.value as TransitionType
                    updateClip(selectedClip.id, {
                      transition_in: t,
                      transition_frames: t ? (selectedClip.transition_frames || Math.round(fps * 0.27)) : 0,
                    })
                  }}
                  className="text-[11px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700"
                  title="前のクリップからの遷移（書き出しに反映・尺は変わらず音ズレしない）"
                >
                  <option value="">カット</option>
                  <option value="cross">クロス</option>
                  <option value="white">白フラッシュ</option>
                  <option value="black">黒</option>
                </select>
                {selectedClip.transition_in && (
                  <select
                    value={String(selectedClip.transition_frames)}
                    onChange={e => updateClip(selectedClip.id, { transition_frames: Number(e.target.value) })}
                    className="text-[11px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700"
                    title="遷移の長さ"
                  >
                    {[
                      [Math.max(2, Math.round(fps * 0.13)), '0.13s'],
                      [Math.round(fps * 0.27), '0.27s'],
                      [Math.round(fps * 0.5),  '0.5s'],
                      [Math.round(fps * 1.0),  '1s'],
                    ].map(([f, label]) => (
                      <option key={String(label)} value={String(f)}>{label}</option>
                    ))}
                    {![Math.max(2, Math.round(fps * 0.13)), Math.round(fps * 0.27), Math.round(fps * 0.5), Math.round(fps * 1.0)]
                      .includes(selectedClip.transition_frames) && (
                      <option value={String(selectedClip.transition_frames)}>
                        {(selectedClip.transition_frames / fps).toFixed(2)}s
                      </option>
                    )}
                  </select>
                )}
              </>
            )}

            {/* Audio fades */}
            {selTrack?.track_type === 'audio' && selectedClip && (
              <>
                <div className="w-px h-4 bg-zinc-700 mx-1" />
                {([['fade_in_frames', 'フェードIN'], ['fade_out_frames', 'フェードOUT']] as const).map(([key, label]) => (
                  <span key={key} className="flex items-center gap-1">
                    <span className="text-[10px] text-zinc-500">{label}</span>
                    <select
                      value={String(selectedClip[key] ?? 0)}
                      onChange={e => updateClip(selectedClip.id, { [key]: Number(e.target.value) })}
                      className="text-[11px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700"
                      title="音声フェード（書き出しに反映）"
                    >
                      {[[0, 'なし'], [Math.round(fps * 0.5), '0.5s'], [fps, '1s'], [fps * 2, '2s'], [fps * 4, '4s']].map(([f, l]) => (
                        <option key={String(l)} value={String(f)}>{l}</option>
                      ))}
                      {![0, Math.round(fps * 0.5), fps, fps * 2, fps * 4].includes(selectedClip[key] ?? 0) && (
                        <option value={String(selectedClip[key])}>{((selectedClip[key] ?? 0) / fps).toFixed(1)}s</option>
                      )}
                    </select>
                  </span>
                ))}
              </>
            )}

            {/* Layer transform inspector: scale/pos/rotation + keyframes + opacity/blend.
                Quick presets stay one click away; the inspector is for precise authoring. */}
            {selectedClip && selTrack?.track_type === 'video' && (
              <>
                <div className="w-px h-4 bg-zinc-700 mx-1" />
                <span className="text-[10px] text-zinc-500">動き</span>
                <select
                  value={(() => {
                    const t = selectedClip.transform_json ?? ''
                    if (!t) return ''
                    try { const d = JSON.parse(t); return (d.preset as string) ?? (d.keyframes ? 'custom' : '') } catch { return t }
                  })()}
                  onChange={e => updateClip(selectedClip.id, { transform_json: e.target.value })}
                  className="text-[11px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700"
                  title="プリセット（ズーム/パン/シェイク）。細かい調整は ⛭ 変形 で。"
                >
                  <option value="">なし</option>
                  <option value="kenburns_in">ズームイン</option>
                  <option value="kenburns_out">ズームアウト</option>
                  <option value="punch_in">パンチイン</option>
                  <option value="punch_out">パンチアウト</option>
                  <option value="pan_lr">パン →</option>
                  <option value="pan_rl">パン ←</option>
                  <option value="shake">シェイク</option>
                  <option value="custom" disabled>カスタム（⛭で編集）</option>
                </select>
                <span className="relative">
                  <button
                    onClick={() => setShowInspector(v => !v)}
                    className={`text-[11px] px-2 py-0.5 rounded border ${
                      showInspector
                        ? 'bg-purple-900/60 text-purple-200 border-purple-700'
                        : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:bg-zinc-700'
                    }`}
                    title="レイヤー変形を数値＆キーフレームで編集（拡大/位置/回転/不透明度）"
                  >⛭ 変形</button>
                  {showInspector && selectedClip && (
                    <ClipInspector
                      clip={selectedClip}
                      isOverlay={tracks.find(t => t.track_type === 'video')?.id !== selTrack.id}
                      localT={(currentFrame - selectedClip.start_frame) / Math.max(1, selectedClip.duration_frames)}
                      beatTs={selBeatTs}
                      onChange={patch => liveUpdateClip(selectedClip.id, patch)}
                      onClose={() => setShowInspector(false)}
                    />
                  )}
                </span>
              </>
            )}

            {isVideoClip && selectedClip && (
              <>
                <div className="w-px h-4 bg-zinc-700 mx-1" />
                <span className="text-[10px] text-zinc-500">速度</span>
                <select
                  value={String(selectedClip.speed)}
                  onChange={e => setClipSpeed(selectedClip.id, Number(e.target.value), selectedClip.speed_ease)}
                  className="text-[11px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700"
                  title="再生速度（フレーム数は自動調整）"
                >
                  {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(s => (
                    <option key={s} value={String(s)}>{s}x</option>
                  ))}
                  {![0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].includes(selectedClip.speed) && (
                    <option value={String(selectedClip.speed)}>{selectedClip.speed.toFixed(2)}x</option>
                  )}
                </select>
                <span>
                  <button
                    onClick={() => {
                      if (!showCurveEditor && selectedClip)
                        setCurveSrcFrames(Math.max(1, Math.round(selectedClip.duration_frames * selectedClip.speed)))
                      setShowCurveEditor(v => !v)
                    }}
                    className={`text-[11px] px-2 py-0.5 rounded border ${
                      showCurveEditor || selectedClip.speed_ease !== 'linear'
                        ? 'bg-purple-900/60 text-purple-200 border-purple-700'
                        : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:bg-zinc-700'
                    }`}
                    title="速度と加減速カーブをまとめて編集"
                  >
                    ∿ {selectedClip.speed_ease === 'linear' ? '一定'
                      : selectedClip.speed_ease === 'in' ? '加速'
                      : selectedClip.speed_ease === 'out' ? '減速'
                      : selectedClip.speed_ease === 'inout' ? '緩急' : 'カスタム'}
                  </button>
                  {showCurveEditor && createPortal(
                    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3"
                         onClick={() => setShowCurveEditor(false)}>
                      <div onClick={e => e.stopPropagation()}
                           className="w-[min(440px,94vw)] rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-4 flex flex-col gap-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-zinc-200">∿ 速度とカーブ</span>
                          <button onClick={() => setShowCurveEditor(false)}
                                  className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
                        </div>
                        {/* 速度カーブ(スピードランプ): 横=クリップ位置 / 縦=速度。
                            カーブの平均速度で出力コマ数が決まる */}
                        <SpeedCurveEditor
                          initial={pointsFromEase(selectedClip.speed_ease, selectedClip.speed)}
                          sourceFrames={curveSrcFrames}
                          fps={fps}
                          onApply={pts2 => {
                            const { rel, mean } = samplesFromPoints(pts2)
                            const flat = rel.every(r => Math.abs(r - 1) < 0.02)
                            applySpeedEnvelope(selectedClip.id, easeStringFromPoints(pts2), mean, flat, curveSrcFrames)
                          }}
                          onLive={pts2 => {
                            // ドラッグ中: APIを叩かず純ローカルで尺を追従(確定はonApply)
                            const { mean } = samplesFromPoints(pts2)
                            const newDur = Math.max(1, Math.round(curveSrcFrames / mean))
                            useTimelineStore.setState(st => ({
                              clips: st.clips.map(c => c.id === selectedClip.id ? { ...c, duration_frames: newDur } : c),
                            }))
                          }}
                        />
                        <p className="text-[9px] text-zinc-600">
                          点をドラッグ: 上=速く(尺が縮む)/下=遅く(尺が伸びる)。曲線上をタップで点を追加、点を選んで✕で削除。両端は固定点(縦のみ)。
                        </p>
                        {/* コマ打ち: 高速化のヌルヌル感をアニメ的なホールドに変換 */}
                        <div className="flex items-center gap-1.5 flex-wrap border-t border-zinc-800 pt-2">
                          <span className="text-[10px] text-zinc-500">🎞 コマ打ち</span>
                          {([[0, 'なし'], [12, '2コマ'], [8, '3コマ'], [6, '4コマ']] as const).map(([v, label]) => (
                            <button key={v}
                                    onClick={async () => {
                                      const updated = await clipsApi.update(selectedClip.id, { posterize_fps: v })
                                      useTimelineStore.setState(st => ({
                                        clips: st.clips.map(c => c.id === selectedClip.id ? updated : c),
                                      }))
                                    }}
                                    className={`text-[10px] px-2 py-1 rounded ${
                                      Math.abs((selectedClip.posterize_fps ?? 0) - v) < 0.05
                                        ? 'bg-amber-800 text-amber-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                                    }`}>{label}</button>
                          ))}
                          {(selectedClip.posterize_fps ?? 0) > 0 && (
                            <span className="text-[10px] text-amber-300 ml-auto">{(selectedClip.posterize_fps ?? 0).toFixed(1)}fps</span>
                          )}
                          {/* 小数指定スライダー(2〜24fps, 0.1刻み): ドラッグ中はローカル反映、離して確定 */}
                          <input type="range" min={2} max={24} step={0.1}
                                 value={Math.max(2, selectedClip.posterize_fps || 12)}
                                 onChange={e => {
                                   const v = Number(e.target.value)
                                   useTimelineStore.setState(st => ({
                                     clips: st.clips.map(c => c.id === selectedClip.id ? { ...c, posterize_fps: v } : c),
                                   }))
                                 }}
                                 onPointerUp={async e => {
                                   const v = Number((e.target as HTMLInputElement).value)
                                   const updated = await clipsApi.update(selectedClip.id, { posterize_fps: v })
                                   useTimelineStore.setState(st => ({
                                     clips: st.clips.map(c => c.id === selectedClip.id ? updated : c),
                                   }))
                                 }}
                                 className="w-full" />
                          <span className="text-[9px] text-zinc-600 w-full">プレビュー再生にも反映されます。速度カーブと併用可(出力タイムベースでホールド)</span>
                        </div>
                      </div>
                    </div>,
                    document.body
                  )}
                </span>
              </>
            )}
          </>
        )}

        {selectedClip && selAsset && selAsset.gen_params_json && (
          <RegenPanel clip={selectedClip} asset={selAsset} projectId={projectId} fps={fps} assets={assets} />
        )}

        {selectedClip && selTrack?.track_type === 'video' && selAsset?.duration_sec != null && (
          <button onClick={() => setShowShotTune(true)}
                  className="text-[11px] px-2 py-0.5 rounded border bg-purple-950/60 text-purple-300 border-purple-700 hover:bg-purple-900/60"
                  title="ソース窓・速度カーブ・分割をポップアップで編集(両隣が埋まっていてもOK)">
            🎛 調整
          </button>
        )}
        {showShotTune && selectedClip && selTrack?.track_type === 'video' && (
          <ShotTunePopover clip={selectedClip} asset={selAsset ?? undefined} fps={fps}
                           onClose={() => setShowShotTune(false)} />
        )}

        <I2VSelPopover projectId={projectId} fps={fps} assets={assets} />

        {swapPin && (
          <button onClick={() => setShowPinSwap(true)}
                  className="text-[11px] px-2 py-0.5 rounded border bg-amber-950/60 text-amber-300 border-amber-700 hover:bg-amber-900/60"
                  title={`選択中ピン(f${swapPin.start_frame})の画像を差し替え — 画像アセット/動画フレームから`}>
            🖼 差し替え
          </button>
        )}
        {showPinSwap && swapPin && (
          <PinSwapModal pin={swapPin} assets={assets} fps={fps} onClose={() => setShowPinSwap(false)} />
        )}

        <button onClick={() => setShowNightBatch(true)}
                className="text-[11px] px-2 py-0.5 rounded border bg-indigo-950/60 text-indigo-300 border-indigo-700 hover:bg-indigo-900/60"
                title="夜間優先生成: 選んだカットを均等にランダムシードで生成し続ける(停止するまで)">
          🌙 夜間生成
        </button>
        {showNightBatch && (
          <NightBatchPanel projectId={projectId} fps={fps} assets={assets}
                           onClose={() => setShowNightBatch(false)} />
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Zoom (touch-friendly — no Ctrl+wheel needed) */}
          <div className="flex items-center">
            <button
              onClick={() => setZoom(pixelsPerFrame * 0.8)}
              className="text-sm w-7 h-6 rounded-l bg-zinc-800 hover:bg-zinc-700 text-zinc-200 leading-none"
              title="ズームアウト"
              aria-label="ズームアウト"
            >−</button>
            <button
              onClick={() => setZoom(pixelsPerFrame * 1.25)}
              className="text-sm w-7 h-6 rounded-r bg-zinc-800 hover:bg-zinc-700 text-zinc-200 leading-none border-l border-zinc-700"
              title="ズームイン"
              aria-label="ズームイン"
            >＋</button>
          </div>
          <span className="text-zinc-600 text-[10px] hidden sm:inline">
            S=分割　Del=削除　Ctrl+Z=元に戻す
          </span>
          <button
            onClick={handlePrecompose}
            className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
            title="タイムライン全体を1本の動画に焼き込み（プリコンポーズ）→ライブラリに追加"
          >🎬 焼き込み</button>
          {/* ⇔ 比較表示: 映像レイヤーをコンポジションとして左右に並べる。
              1回のレンダーの中で並ぶので、2本の動画を突き合わせる必要がなく
              フレームのずれが原理的に生じない。もう一度押すと全画面に戻る。 */}
          <button
            onClick={async () => {
              const vids = tracks.filter(t => t.track_type === 'video').sort((a, b) => a.order - b.order)
              const on = vids.some(t => (t.layout_json ?? '') !== '')
              // 右=最背面(参照)の1本だけ指定し、残りの映像レイヤーは左にまとめる。
              // Scenes等レイヤーが増えても割り当てが崩れない。
              await tracksApi.compareLayout(projectId, !on, undefined, vids[vids.length - 1]?.id)
              await syncFromServer(projectId)   // 編集履歴を消さずにトラックだけ取り直す
              useUIStore.getState().pushToast(on ? '比較表示を解除しました' : '比較表示: 左右に並べました', 'info')
            }}
            className={`text-[11px] px-2 py-0.5 rounded ${
              tracks.some(t => t.track_type === 'video' && (t.layout_json ?? '') !== '')
                ? 'bg-amber-700 hover:bg-amber-600 text-amber-50'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200'}`}
            title="映像レイヤーを左右に並べて比較(最前面=左 / その次=右)。もう一度押すと戻る"
          >⇔ 比較</button>
          <button
            onClick={() => setShowRenderDialog(true)}
            className="text-[11px] px-3 py-0.5 rounded bg-purple-800 hover:bg-purple-700 text-purple-100 font-medium"
            title="MP4にレンダリング"
          >▶ レンダー</button>
        </div>

        <span className="text-[11px] text-zinc-400 font-mono ml-2">
          {String(Math.floor(currentFrame / fps / 60)).padStart(2, '0')}:
          {String(Math.floor(currentFrame / fps) % 60).padStart(2, '0')}:
          {String(currentFrame % fps).padStart(2, '0')}
          <span className="text-zinc-600"> f{currentFrame}</span>
        </span>
      </div>

      {/* Scrollable area */}
      <div className="flex-1 overflow-auto" ref={scrollRef}
        onPointerDown={handlePinchDown} onPointerMove={handlePinchMove}
        onPointerUp={handlePinchUp} onPointerCancel={handlePinchUp}
        style={{ touchAction: 'pan-x pan-y' }}>
        {/* w-max: 各行の包含ブロックを中身(ラベル112px + タイムライン全幅)まで広げる。
            これが無いと行の幅がスクロール表示域までしか無く、ラベル列の
            sticky left-0 に可動域が生まれないため、横スクロールで左に隠れてしまう。 */}
        <div className="flex flex-col min-h-full relative w-max min-w-full">
          {/* Ruler row */}
          <div className="flex flex-shrink-0 sticky top-0 z-10 bg-zinc-900">
            <div className="w-28 flex-shrink-0 border-r border-b border-zinc-700 bg-zinc-900 sticky left-0 z-30" />
            <TimeRuler
              pixelsPerFrame={pixelsPerFrame}
              fps={fps}
              totalWidth={totalWidth}
              currentFrame={currentFrame}
              onSeek={setCurrentFrame}
            />
          </div>

          {/* Beat ruler (shown only when beat analysis is available) */}
          {beatInfo && (
            <div className="flex flex-shrink-0">
              <div className="w-28 flex-shrink-0 border-r border-b border-zinc-800 bg-zinc-950 flex items-center px-2 sticky left-0 z-30">
                <span className="text-[9px] text-zinc-600">beat</span>
              </div>
              <BeatRuler
                beat={beatInfo.beat}
                clipStartFrame={beatInfo.clip.start_frame}
                assetInFrame={beatInfo.clip.asset_in_frame}
                pixelsPerFrame={pixelsPerFrame}
                fps={fps}
                totalWidth={totalWidth}
              />
            </div>
          )}

          {/* 移動量バジェット: 音から出した「どれくらい画が動くべきか」 */}
          {beatInfo && (
            <div className="flex flex-shrink-0 border-b border-zinc-800">
              <div className="w-28 flex-shrink-0 border-r border-zinc-800 bg-zinc-950
                              sticky left-0 z-30 flex flex-col">
                {/* 行の高さをレーンと厳密に揃える(ズレると別の行のラベルに見える) */}
                {motionRows.map((r, i) => (
                  <div key={r} className="flex items-center justify-between px-1.5 leading-none
                                          border-b border-zinc-900/60"
                       style={{ height: MB_ROWS[r].h }}>
                    <span className="text-[8px] text-zinc-500">{MB_ROWS[r].label}</span>
                    {i === 0 && (
                      <button onClick={() => setMotionFull(v => !v)}
                              className="text-[8px] px-1 rounded bg-zinc-800 text-zinc-400
                                         hover:bg-zinc-700 leading-none"
                              title="全系列(構造/盛上げ/移動量/歌唱/粒度/打撃/等級) ⇄ 要点のみ">
                        {motionFull ? '簡易' : '全部'}
                      </button>
                    )}
                    {r === 'snare' && (
                      <span className="flex items-center gap-1">
                        <input type="range" min={0} max={0.9} step={0.05} value={hitMin}
                               onChange={e => setHitMin(Number(e.target.value))}
                               className="w-10 h-1 accent-red-500"
                               title="打撃の表示下限。上げるほど目立つ当たりだけが残る" />
                        <span className="text-[8px] text-red-400 tabular-nums">{hitMin.toFixed(2)}</span>
                      </span>
                    )}
                    {r === 'move' && (
                      <span className="flex items-center gap-1">
                        <input type="range" min={6} max={40} step={1} value={motionMaxPct}
                               onChange={e => setMotionMaxPct(Number(e.target.value))}
                               className="w-10 h-1 accent-sky-500"
                               title="移動量の上限(画面幅%)。実映像と見比べて体感に合う値へ" />
                        <span className="text-[8px] text-sky-400 tabular-nums">{motionMaxPct}%</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <MotionBudgetLane
                songAssetId={beatInfo.clip.asset_id ?? null}
                cuts={motionCuts}
                pixelsPerFrame={pixelsPerFrame}
                totalWidth={totalWidth}
                projectFps={fps}
                maxPct={motionMaxPct}
                hitMin={hitMin}
                rows={motionRows}
                snapFrames={downbeatFrames}
                onBuildupsChange={saveBuildups}
                onSeek={setCurrentFrame}
              />
            </div>
          )}

          {/* Rhythm lane: 合成モーション×ビート（音ハメの見える化） */}
          {beatInfo && (
            <div className="flex flex-shrink-0 border-b border-zinc-800">
              <div className="w-28 flex-shrink-0 border-r border-zinc-800 bg-zinc-950 flex items-center px-2 sticky left-0 z-30">
                <span className="text-[9px] text-zinc-600">rhythm</span>
              </div>
              <RhythmLane
                clips={clips.filter(c => {
                  // 「最初に見つかった映像トラック」だと、そこが空(AniPAFE2026のScenes)のときレーンごと消える。
                  // 画面の変化はどの映像レイヤーで起きても変化なので、映像トラック全部を合成対象にする。
                  const videoIds = new Set(tracks.filter(t => t.track_type === 'video').map(t => t.id))
                  return videoIds.has(c.track_id)
                })}
                beatFrames={beatFrames}
                pixelsPerFrame={pixelsPerFrame}
                totalWidth={totalWidth}
                projectFps={fps}
                onSeek={setCurrentFrame}
              />
            </div>
          )}

          {/* 🏞シーンレーン(同一空間のカット群+ロケーションプレート) */}
          <SceneLane tracks={tracks} clips={clips} assets={assets} pixelsPerFrame={pixelsPerFrame} totalWidth={totalWidth} />
          {boardSheetOpen && (
            <BoardSheet tracks={tracks} clips={clips} assets={assets} fps={fps}
                        onClose={() => setBoardSheetOpen(false)} />
          )}
          {storyOpen && (
            <StoryScroll tracks={tracks} clips={clips} assets={assets} fps={fps}
                         onClose={() => setStoryOpen(false)} />
          )}
          {designMapOpen && (
            <DesignMap tracks={tracks} clips={clips} assets={assets} fps={fps}
                       onClose={() => setDesignMapOpen(false)} />
          )}
          {/* カット割りレーン(Imageトラックのピンから自動導出・ドラッグに連動) */}
          <CutLane tracks={tracks} clips={clips} assets={assets} pixelsPerFrame={pixelsPerFrame} fps={fps} totalWidth={totalWidth} />

          {/* Track lanes */}
          {[...tracks].sort((a, b) => a.order - b.order).map(track => (
            <TrackLane
              key={track.id}
              track={track}
              clips={clips.filter(c => c.track_id === track.id)}
              assets={assets}
              pixelsPerFrame={pixelsPerFrame}
              totalWidth={totalWidth}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
              onDropAsset={handleDropAsset}
              snapFrame={snapFrame}
            />
          ))}

          {tracks.length === 0 && (
            <div
              className="flex-1 flex items-center justify-center text-zinc-700 text-sm py-8"
              onDragOver={e => e.preventDefault()}
              onDrop={async e => {
                e.preventDefault()
                const assetId = Number(e.dataTransfer.getData('assetId'))
                if (!assetId) return
                const asset = assets.find(a => a.id === assetId)
                if (!asset) return
                const durationFrames = asset.duration_sec
                  ? Math.round(asset.duration_sec * fps) : fps * 5
                const type = asset.asset_type === 'audio' ? 'audio' : 'video'
                await placeClip(projectId, type, assetId, durationFrames, 0)
              }}
            >
              ここにアセットをドロップ（トラック自動作成） / または「+ Video」「+ Audio」
            </div>
          )}

          {showRenderDialog && (
            <RenderDialog onClose={() => setShowRenderDialog(false)} />
          )}

          {/* Remote collaborators' playheads */}
          {Object.values(remoteUsers).map(o => (
            o.presence.frame != null && (
              <div
                key={o.user.id}
                className="absolute top-0 bottom-0 w-px pointer-events-none z-20"
                style={{ left: LABEL_WIDTH + o.presence.frame * pixelsPerFrame, background: o.user.color }}
              >
                <span
                  className="absolute top-0 left-0 text-[8px] leading-tight px-0.5 rounded-sm text-black whitespace-nowrap"
                  style={{ background: o.user.color }}
                >{o.user.name}</span>
              </div>
            )
          ))}

          {/* Weak beats (音ハメスコアの改善ポイント) — click to seek */}
          {beatMatch?.weak_beats.map(b => (
            <div
              key={`wb${b.frame}`}
              className="absolute top-0 bottom-0 w-px bg-amber-400/50 cursor-pointer z-10"
              style={{ left: LABEL_WIDTH + b.frame * pixelsPerFrame }}
              title={`弱いビート ${b.sec.toFixed(2)}s — カット/フラッシュ/動きを置くと◎（クリックでシーク）`}
              onClick={() => setCurrentFrame(b.frame)}
            >
              <span className="absolute top-0 left-0.5 text-[8px] text-amber-400/80">▼</span>
            </div>
          ))}

          {/* Playhead — full height */}
          <div
            className="absolute top-0 bottom-0 w-px bg-purple-500/60 pointer-events-none"
            style={{ left: LABEL_WIDTH + currentFrame * pixelsPerFrame }}
          />
        </div>
      </div>
    </div>
  )
}
