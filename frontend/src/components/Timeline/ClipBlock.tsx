import { memo, useRef, useState, useSyncExternalStore } from 'react'
import type { Clip, Asset, ClipUpdate } from '../../api/client'
import { assetsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useUIStore } from '../../store/uiStore'
import { useAnalysisStore } from '../../store/analysisStore'
import { SceneMarkers, MotionHeat } from './SceneMarkers'
import { MotionCanvas } from './MotionCanvas'
import { RemapEditor } from './RemapEditor'
import { resInfo } from './resolutionBadge'
import { allKeyframeTimes, removeKeyframe, TPROPS } from '../Preview/transformEval'
import { isFilterClip, getKeys, filterLabel, solidColor, defaultValue, BLUR_MAX, type FilterKind, shiftFilterHead } from './filterLayers'
import { shiftRainAttrs } from './rainFx'
import { hasRingMarks, sliceRingAttrs, headShiftFrames } from './ringMarks'
import { RingTicks } from './RingTicks'
import { isCreditClip, creditOf, creditLabel, eAt, gOf, holdOf, type CreditV1 } from '../Preview/creditLook'
import { previewCredit, commitCreditDrag, cancelCreditDrag, settleBeforeDrag, shiftCreditHead } from './creditEdit'
import { subscribeCreditMaps, creditMapsErrorFor } from '../Preview/creditFields'

const noSub = () => () => {}
const noErr = () => ''

const CLIP_COLORS: Record<string, string> = {
  video:     'bg-blue-800 border-blue-600',
  audio:     'bg-green-800 border-green-600',
  image:     'bg-orange-800 border-orange-600',
  generated: 'bg-purple-800 border-purple-600',
}

// Trim handles are widened on touch devices (no precise cursor) so they're
// comfortable to grab with a finger.
const COARSE = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches
const HANDLE_PX = COARSE ? 16 : 6  // trim handle width in px

interface Props {
  clip: Clip
  asset: Asset | undefined
  /** 所属トラック名(⏱リマップは Scenes のクリップにだけ出す) */
  trackName?: string
  pixelsPerFrame: number
  trackHeight: number
  onSelect: (id: number) => void
  selected: boolean
  /** 吸着(カット境界・他クリップ端・再生位置 > 拍)。excludeClipId=動かしているクリップ自身 */
  snapFrame?: (frame: number, excludeClipId?: number) => number
  /** Another collaborator has this clip selected (outline color). */
  remoteSelect?: string | null
  /** Another collaborator is actively editing this clip (soft lock). */
  remoteLock?: { name: string; color: string } | null
  /** 同一レイヤーで前クリップと重なるフレーム数(=このクリップへの遷移区間) */
  overlapIn?: number
  /** 同一レイヤーで次クリップと重なるフレーム数(=次クリップへの遷移区間、素材の続きが下に敷かれる) */
  overlapOut?: number
}

export const ClipBlock = memo(function ClipBlock({ clip, asset, pixelsPerFrame, trackHeight, onSelect, selected, snapFrame, remoteSelect, remoteLock, trackName, overlapIn = 0, overlapOut = 0 }: Props) {
  // Alt を押している間は吸着しない。自分自身の端には吸着しない。
  const snapEv = (f: number, ev?: { altKey: boolean }) =>
    (!snapFrame || ev?.altKey) ? f : snapFrame(f, clip.id)
  // 端ドラッグを「速度伸縮」で扱うか(ツールバーの切替、Ctrl/⌘ 押下中は反転)。
  // 伸縮=使う素材範囲(duration×speed)はそのままに尺を変え、速度を自動計算する。動画素材のみ。
  const isStretchDrag = (ev: { ctrlKey: boolean; metaKey: boolean }) => {
    const base = useTimelineStore.getState().edgeStretch
    const on = (ev.ctrlKey || ev.metaKey) ? !base : base
    // 🌧 雨クリップは伸縮しない(雨の層は元動画・下の絵とコマ単位で対応している。速度を変えるとずれる)
    return on && !!asset?.duration_sec && !isFilterClip(clip) && clip.kind !== 'rain'
  }
  // 伸縮後の値: 速度は 0.05〜8 に制限し、リマップのキーは尺の比率で時間方向に伸縮する
  const stretchVals = (newDur: number) => {
    const span = clip.duration_frames * (clip.speed || 1)
    const dur = Math.max(Math.ceil(span / 8), Math.min(Math.floor(span / 0.05), Math.max(1, newDur)))
    const out: Partial<Clip> = { duration_frames: dur, speed: Number((span / dur).toFixed(4)) }
    if ((clip.remap_json ?? '') !== '') {
      try {
        const r = JSON.parse(clip.remap_json!)
        const k = dur / clip.duration_frames
        r.keys = (r.keys ?? []).map((x: { t: number }) => ({ ...x, t: Math.round(x.t * k) }))
        out.remap_json = JSON.stringify(r)
      } catch { /* keep */ }
    }
    return out
  }
  // これだけ動くまではドラッグを開始しない(クリック=選択だけで位置は変えない)
  const DRAG_DEADZONE_PX = 4
  // 個別セレクタ購読(アクション参照は安定)— 全ストア購読だと再生中30fpsの
  // currentFrame更新で全ClipBlockが再レンダされてしまう
  const moveClip = useTimelineStore(s => s.moveClip)
  const trimClip = useTimelineStore(s => s.trimClip)
  const deleteClip = useTimelineStore(s => s.deleteClip)
  const projectFps = useTimelineStore(s => s.projectFps)
  const setEditingClipId = useTimelineStore(s => s.setEditingClipId)
  const updateClip = useTimelineStore(s => s.updateClip)
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const openShotEditor = useUIStore(st => st.openShotEditor)
  // mg_shot detection is defensive: fall back to the asset naming convention so a
  // stale cached Clip object (no `kind` field) can never fall into delete-on-dblclick.
  const isMgShot = clip.kind === 'mg_shot' || (asset?.name ?? '').startsWith('shot:')
  const openEditor = () => {
    try {
      const sid = JSON.parse(clip.attrs_json || '{}').shot_id
        ?? (asset?.name ?? '').replace(/^shot:/, '')
      if (sid) openShotEditor(sid)
    } catch { /* noop */ }
  }
  const hardLocked = !!clip.locked   // 🔒確定カット(ユーザーが明示的にロック)
  const locked = !!remoteLock || hardLocked
  // 自分のアセット分だけ購読: マップ全体を購読すると他アセットの解析が届くたびに
  // 全クリップが再描画され、memo が無効になる
  const assetScenes = useAnalysisStore(s => (asset ? s.scenes[asset.id] : undefined))
  const assetMotion = useAnalysisStore(s => (asset ? s.motion[asset.id] : undefined))

  const toggleLock = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await updateClip(clip.id, { locked: !clip.locked })
  }

  // Video/audio clips have a finite source (duration_sec); images do not and can
  // be stretched freely (freeze-frame / placeholder). For finite sources the
  // right edge is clamped so a clip never runs past the end of its source.
  const sourceFrames = asset?.duration_sec
    ? Math.max(1, Math.floor(asset.duration_sec * projectFps))
    : null
  const isStretchable = sourceFrames == null   // images stretch without limit
  const dragRef = useRef<{ startX: number; origFrame: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [remapOpen, setRemapOpen] = useState(false)   // ⏱リマップエディタ

  const left  = clip.start_frame * pixelsPerFrame
  const width = Math.max(clip.duration_frames * pixelsPerFrame, HANDLE_PX * 2 + 4)
  // ■単色/◌ぼかし(フィルターレイヤー): 素材を持たないので専用の見た目にする
  const isFilter = isFilterClip(clip)
  const showRes = useTimelineStore(s => s.showRes)
  const ri = showRes && !isFilterClip(clip) ? resInfo(asset) : null
  const openFilter = () => window.dispatchEvent(new CustomEvent('kychapogas:open-filter', { detail: { clipId: clip.id } }))
  const isRain = clip.kind === 'rain'   // 🌧 雨フィルター(黒地の雨の層を screen で重ねる)
  const openRain = () => window.dispatchEvent(new CustomEvent('kychapogas:open-rain', { detail: { clipId: clip.id } }))
  // 🎬 撮影(色・パラ・ライトリーク・レンズ・粒子を下の絵にかける調整レイヤー)。ダブルクリックで撮影の調整パネル
  const isSatsuei = clip.kind === 'satsuei'
  const openSatsuei = () => window.dispatchEvent(new CustomEvent('kychapogas:open-satsuei', { detail: { clipId: clip.id } }))
  // 🔤 字幕(素材なし・文字のガラスで下の絵を屈折させる)。ダブルクリックで字幕の調整パネル
  const isCredit = isCreditClip(clip)
  const credit = isCredit ? creditOf(clip.attrs_json) : null
  // 今の字幕で地図を作れない(大きすぎる・フォントが無い)ときの知らせ。プレビューも書き出しもこの字幕を描かないので、
  // パネルを閉じていても気づけるようにクリップに ⚠ を出す(文字列が変わったときだけ描き直す)
  const creditErr = useSyncExternalStore(isCredit ? subscribeCreditMaps : noSub, isCredit ? () => creditMapsErrorFor(clip.id) : noErr)
  const openCredit = () => window.dispatchEvent(new CustomEvent('kychapogas:open-credit', { detail: { clipId: clip.id } }))
  const colorClass = isFilter
    ? (clip.kind === 'blur' ? 'bg-cyan-950 border-cyan-600' : isSatsuei ? 'bg-amber-950 border-amber-500' : 'bg-zinc-800 border-zinc-400')
    : isRain ? 'bg-sky-950 border-sky-500'
    : isCredit ? (creditErr ? 'bg-red-950 border-red-500' : 'bg-slate-900 border-cyan-300')
    : CLIP_COLORS[asset?.asset_type ?? 'video']

  // Interactions use Pointer Events so mouse, touch, and pen all work.
  // タッチは「長押しでドラッグ開始」: 以前は touch-action:none で指の動きが即編集に
  // なり、タイムラインを流し見しようとしたフリックが素材移動になる誤操作が多かった。
  // いまは クリップ上のフリック=スクロール / 長押し(350ms)してから動かす=編集。
  // マウス・ペンは従来どおり即ドラッグ。
  const LONG_PRESS_MS = 350
  const SLOP_PX = 10
  const touchGate = (e: React.PointerEvent, begin: (e: React.PointerEvent) => void) => {
    if (e.pointerType !== 'touch') { begin(e); return }
    e.stopPropagation()
    const x0 = e.clientX, y0 = e.clientY
    let armed = false, moved = false
    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
    const timer = window.setTimeout(() => {
      armed = true
      cleanup()
      navigator.vibrate?.(15)                       // 掴んだ合図(対応端末のみ)
      // 掴んだあとに親のパンスクロールが発火しないよう、指を離すまで抑止
      const blockScroll = (ev: TouchEvent) => ev.preventDefault()
      document.addEventListener('touchmove', blockScroll, { passive: false })
      const unblock = () => {
        document.removeEventListener('touchmove', blockScroll)
        window.removeEventListener('pointerup', unblock)
        window.removeEventListener('pointercancel', unblock)
      }
      window.addEventListener('pointerup', unblock)
      window.addEventListener('pointercancel', unblock)
      begin(e)
    }, LONG_PRESS_MS)
    const onMove = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > SLOP_PX) { moved = true; cleanup() }
    }
    const onEnd = () => {
      cleanup()
      if (!armed && !moved) onSelect(clip.id)       // ただのタップ=選択
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

  // ── Main body: move ──────────────────────────────────────────────────
  // 2026-09-23: クリックしただけで数フレームずれる不具合を修正。以前は押した瞬間に
  // ドラッグを開始し、離したときに動いていなくても拍スナップを通していた。
  // いまは DRAG_DEADZONE_PX 動くまで何もせず、動かしたら始点・終点のうち
  // 吸着先に近い方で合わせる(カット末尾にぴったり付けたい時も効く)。
  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (locked) {                      // 🔒 or 共同編集ロック: 選択のみ許可、移動不可
      if (hardLocked) onSelect(clip.id)
      return
    }
    onSelect(clip.id)
    const origFrame = clip.start_frame
    const dur = clip.duration_frames
    const x0 = e.clientX
    dragRef.current = { startX: x0, origFrame }
    let started = false

    const target = (ev: PointerEvent) => {
      const raw = Math.max(0, Math.round(origFrame + (ev.clientX - x0) / pixelsPerFrame))
      const byStart = snapEv(raw, ev)
      const byEnd = snapEv(raw + dur, ev) - dur
      const dS = Math.abs(byStart - raw), dE = Math.abs(byEnd - raw)
      // 動いた方(=吸着が効いた方)を採る。両方効いたら近い方
      if (byStart !== raw && (byEnd === raw || dS <= dE)) return byStart
      if (byEnd !== raw) return Math.max(0, byEnd)
      return raw
    }

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return
      if (!started) {
        if (Math.abs(ev.clientX - x0) < DRAG_DEADZONE_PX) return
        started = true
        setDragging(true)
        setEditingClipId(clip.id)
      }
      const newFrame = target(ev)
      useTimelineStore.setState(s => ({
        clips: s.clips.map(c => c.id === clip.id ? { ...c, start_frame: newFrame } : c),
      }))
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!dragRef.current) return
      if (started) {
        const newFrame = target(ev)
        if (newFrame !== origFrame) moveClip(clip.id, origFrame, newFrame)
        else useTimelineStore.setState(s => ({   // 元の位置に戻した: 表示だけ戻す
          clips: s.clips.map(c => c.id === clip.id ? { ...c, start_frame: origFrame } : c),
        }))
        setDragging(false)
        setEditingClipId(null)
      }
      dragRef.current = null
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // ── Left trim handle ─────────────────────────────────────────────────
  const handleLeftTrimDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (locked) return
    onSelect(clip.id)
    const startX      = e.clientX
    const origStart   = clip.start_frame
    const origDur     = clip.duration_frames
    const origAssetIn = clip.asset_in_frame
    let started = false

    const origSpeed = clip.speed
    const origRemap = clip.remap_json ?? ''
    const hasRing = hasRingMarks(clip.attrs_json)   // 💍 指輪の位置の印(クリップ先頭基準のコマ)
    const clamp = (ev: PointerEvent): ClipUpdate => {
      const dx = ev.clientX - startX
      const newStart = Math.max(0, snapEv(origStart + Math.round(dx / pixelsPerFrame), ev))
      const moved    = newStart - origStart
      if (isStretchDrag(ev)) {
        // 終点は固定、始点だけ動かす。素材の頭出しは変えない
        const sv = stretchVals(origDur - moved)
        const d = sv.duration_frames!
        return { ...sv, start_frame: origStart + origDur - d, asset_in_frame: origAssetIn }
      }
      // フィルター(単色/ぼかし/撮影)のキーはクリップ先頭基準なので、左端を動かしたら
      // 絶対時刻が変わらないようにずらす(詰めた分は先頭キーにその時点の値を置く)。
      // 🎬 撮影はライトリークの始まり(クリップ先頭基準)も同じタイムラインのコマに保つ
      let filterAttrs: ClipUpdate = {}
      if (isFilterClip(clip)) {
        const a = shiftFilterHead(clip, moved)
        if (a != null) filterAttrs = { attrs_json: a }
      } else if (clip.kind === 'rain') {
        // 🌧 雨クリップ: 「寄りでのぼかし」の開始コマ(クリップ先頭基準)を同じタイムラインのコマに保つ
        const a = shiftRainAttrs(clip.attrs_json, moved, Math.max(1, origDur - moved))
        if (a != null && a !== clip.attrs_json) filterAttrs = { attrs_json: a }
      } else if (isCredit) {
        // 🔤 字幕: 決めてあるつやの時刻(クリップ先頭基準)を同じタイムラインのコマに保つ(出現・消失は端から数えるのでそのまま)
        const a = shiftCreditHead(clip.attrs_json, moved)
        if (a != null) filterAttrs = { attrs_json: a }
      }
      // 💍 指輪の位置の印も同じ理由でずらす。印は素材の絵に付いているので、ずらす量は「同じ絵が何コマ動くか」
      // = 頭出しの変化(素材のコマ)÷ 速度。頭出しが 0 で止まると(素材の頭より前へは伸ばせない)絵が後ろへずれるので、
      // 印もそれに合わせてずれる。終わりより後の印(右端を詰めて隠れているもの)は捨てない
      if (hasRing) {
        const newIn = Math.max(0, origAssetIn + moved)
        const dIn = newIn - origAssetIn
        const off = headShiftFrames(dIn, origSpeed, origRemap)       // 時間リマップは近似(頭出しの変化のまま)
        const ra = sliceRingAttrs(clip.attrs_json, off, Math.max(1, origDur - moved), dIn,
                                  { asset_id: clip.asset_id, asset_in_frame: newIn }, true)
        if (ra != null) filterAttrs = { attrs_json: ra }
      }
      return {
        ...filterAttrs,
        start_frame:     newStart,
        duration_frames: Math.max(1, origDur - moved),
        // 🔤 字幕は素材が無いので頭出しは 0 のまま(出現・消失はクリップの端から数えるので、ずらす物も無い)
        asset_in_frame:  isCredit ? 0 : Math.max(0, origAssetIn + moved),
      }
    }

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - startX) < DRAG_DEADZONE_PX) return
        started = true
        setEditingClipId(clip.id)
      }
      const vals = clamp(ev)
      useTimelineStore.setState(s => ({
        clips: s.clips.map(c => c.id === clip.id ? { ...c, ...vals } : c),
      }))
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!started) return            // クリックだけ: 何も変えない
      const after = clamp(ev)
      trimClip(clip.id,
        { start_frame: origStart, duration_frames: origDur, asset_in_frame: origAssetIn, speed: origSpeed, remap_json: origRemap,
          ...(isFilterClip(clip) || clip.kind === 'rain' || isCredit || hasRing ? { attrs_json: clip.attrs_json } : {}) },
        { speed: origSpeed, remap_json: origRemap, ...after },
      )
      setEditingClipId(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // ── Right trim handle ────────────────────────────────────────────────
  const handleRightTrimDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (locked) return
    onSelect(clip.id)
    const startX  = e.clientX
    const origDur = clip.duration_frames
    // For finite-source clips, cap at the remaining source frames.
    const maxDur  = sourceFrames != null ? Math.max(1, sourceFrames - clip.asset_in_frame) : Infinity
    let started = false

    const clamp = (ev: PointerEvent) => {
      // 終点(start + duration)を吸着させる(カット境界・他クリップ端・拍)
      const snappedEnd = snapEv(clip.start_frame + Math.round(origDur + (ev.clientX - startX) / pixelsPerFrame), ev)
      const dur = snappedEnd - clip.start_frame
      return Math.min(maxDur, Math.max(1, dur))
    }
    const origSpeedR = clip.speed
    const origRemapR = clip.remap_json ?? ''
    const valsR = (ev: PointerEvent): ClipUpdate => {
      if (isStretchDrag(ev)) {
        const snappedEnd = snapEv(clip.start_frame + Math.round(origDur + (ev.clientX - startX) / pixelsPerFrame), ev)
        return stretchVals(snappedEnd - clip.start_frame)
      }
      return { duration_frames: clamp(ev), speed: origSpeedR, remap_json: origRemapR }
    }

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - startX) < DRAG_DEADZONE_PX) return
        started = true
        setEditingClipId(clip.id)
      }
      const v = valsR(ev)
      useTimelineStore.setState(s => ({
        clips: s.clips.map(c => c.id === clip.id ? { ...c, ...(v as Partial<Clip>) } : c),
      }))
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!started) return            // クリックだけ: 何も変えない
      trimClip(clip.id,
        { duration_frames: origDur, speed: origSpeedR, remap_json: origRemapR },
        valsR(ev),
      )
      setEditingClipId(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // ── 🔤 字幕の出現・消失のつまみ ─────────────────────────────────────
  // 出現 = 先頭からのコマ数、消失 = 末尾までのコマ数。0..240 と「出現 + 消失 ≤ 長さ」に収める。すぐプレビューに出て、
  // 保存は止まってから(元に戻すはつまみごとに 1 回)
  const creditHandleDown = (which: 'appear' | 'disappear', e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault()
    if (locked || !credit) return
    onSelect(clip.id)
    settleBeforeDrag(clip.id)                         // パネルのつまみの保存待ちを先に送る(ドラッグ中の値を混ぜない)
    const a0 = credit.timing.appear_frames, d0 = credit.timing.disappear_frames
    const dur = Math.max(1, clip.duration_frames), start = clip.start_frame
    const x0 = e.clientX
    const orig = clip.attrs_json
    const v0 = which === 'appear' ? a0 : d0
    let last = v0
    const setV = (v: number) => (c: CreditV1) => ({ ...c, timing: { ...c.timing, [which === 'appear' ? 'appear_frames' : 'disappear_frames']: v } })
    const onMove = (ev: PointerEvent) => {
      const df = Math.round((ev.clientX - x0) / pixelsPerFrame)
      let v: number
      if (which === 'appear') {
        const abs = snapEv(start + a0 + df, ev)
        v = Math.max(0, Math.min(240, dur - d0, abs - start))
      } else {
        const abs = snapEv(start + dur - d0 + df, ev)
        v = Math.max(0, Math.min(240, dur - a0, start + dur - abs))
      }
      if (v === last) return
      last = v
      previewCredit(clip.id, setV(v))                 // 動かしている間は手元だけ(プレビューにすぐ出る)
    }
    const done = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      setEditingClipId(null)
    }
    const onUp = () => {
      done()
      // 離したら 1 回だけ保存(元に戻す 1 回)
      if (last !== v0) commitCreditDrag(clip.id, orig, setV(last), which === 'appear' ? '字幕の出現' : '字幕の消失', `credit.timing.${which}_frames`)
    }
    // 指の操作がブラウザ(スクロール・ズーム)に取られた: 動かした分を戻して終わる(保存しない)
    const onCancel = () => {
      done()
      if (last !== v0) cancelCreditDrag(clip.id, orig, setV(last))
    }
    setEditingClipId(clip.id)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  return (
    <div
      data-clip-id={clip.id}
      className={`absolute top-1 rounded border text-[10px] text-white overflow-hidden select-none
        ${colorClass} ${selected ? 'ring-2 ring-purple-300' : ''} ${dragging ? 'opacity-80' : ''} ${locked ? 'opacity-70' : ''}`}
      style={{
        left, width, height: trackHeight - 8,
        ...(remoteLock ? { outline: `2px solid ${remoteLock.color}`, outlineOffset: '-1px' }
          : remoteSelect ? { outline: `1px dashed ${remoteSelect}`, outlineOffset: '-1px' }
          : ri?.low ? { outline: '2px solid rgb(220 38 38)', outlineOffset: '-2px' } : {}),
      }}
      onDoubleClick={() => {
        if (isCredit) { openCredit(); return }          // 🔤 字幕は消さない(素材なしのクリップは下の「削除」に落ちる)
        if (isSatsuei) { openSatsuei(); return }
        if (isFilter) { openFilter(); return }
        if (isRain) { openRain(); return }
        if (locked) return
        if (isMgShot) openEditor()
        else deleteClip(clip.id)
      }}
      title={remoteLock ? `${remoteLock.name} が編集中`
        : isCredit && credit ? `${creditErr ? `⚠ この字幕は描けません: ${creditErr}(パネルで文字・大きさを直してください)\n` : ''}${creditLabel(credit)} — 出現 ${credit.timing.appear_frames} / 保持 ${holdOf(credit, clip.duration_frames)} / 消失 ${credit.timing.disappear_frames} コマ`
          + `${credit.label ? `・${credit.label}` : ''}${credit.group ? `・組 ${credit.group}` : ''}`
          + `${holdOf(credit, clip.duration_frames) < 0 ? '(出現と消失が重なっています)' : ''} — ダブルクリックで字幕の調整`
        : isSatsuei ? `${filterLabel(clip)}(効き ${Math.round((clip.opacity ?? 1) * 100)}%) — ダブルクリックで撮影の調整 / 🎚で効きのキー`
        : isFilter ? `${filterLabel(clip)} — ダブルクリック/🎚でキー編集`
        : isRain ? `🌧 雨(元動画の雨筋・強さ ${Math.round((clip.opacity ?? 1) * 100)}%) — ダブルクリックで調整`
        : isMgShot ? `${asset?.name ?? 'shot'} — ダブルクリック/✎でショットエディタ`
        : `${asset?.name ?? 'clip'}${isStretchable ? '（静止画: 自由に引き伸ばし可）' : ''} — ダブルクリックで削除`}
    >
      {/* Shot Editor button (mg_shot clips) — single-click, no dblclick ambiguity */}
      {isMgShot && !locked && (
        <button
          className="absolute top-0.5 right-0.5 z-30 w-5 h-5 rounded bg-pink-600/90 hover:bg-pink-500 text-white text-[11px] leading-none flex items-center justify-center"
          title="ショットエディタを開く"
          onClick={e => { e.stopPropagation(); openEditor() }}
          onDoubleClick={e => e.stopPropagation()}
          onPointerDown={e => e.stopPropagation()}
        >✎</button>
      )}
      {/* Remote editor lock badge */}
      {remoteLock && (
        <span
          className="absolute -top-3 left-0 text-[8px] leading-tight px-0.5 rounded-sm text-black whitespace-nowrap z-30"
          style={{ background: remoteLock.color }}
        >🔒 {remoteLock.name}</span>
      )}
      {/* フィルターレイヤー: キー補間のカーブ(単色=色で塗った不透明度 / ぼかし=強さ) */}
      {isFilter && (() => {
        const ks = getKeys(clip)
        const kind = clip.kind as FilterKind
        const last = Math.max(1, clip.duration_frames - 1)
        const vmax = kind !== 'blur' ? 1 : Math.min(BLUR_MAX, Math.max(10, ...ks.map(k => k.v)))   // 単色・撮影は 0..1
        const fb = defaultValue(kind)
        const pts: [number, number][] = ks.length
          ? [[0, ks[0].v], ...ks.map(k => [Math.min(last, k.t), k.v] as [number, number]), [last, ks[ks.length - 1].v]]
          : [[0, fb], [last, fb]]
        const poly = pts.map(([t, v]) => `${(t / last) * 100},${100 - (v / vmax) * 100}`).join(' ')
        return (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
            {kind === 'solid'
              ? <polygon points={`0,100 ${poly} 100,100`} fill={solidColor(clip)} fillOpacity={0.85}
                         stroke="#a1a1aa" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              : kind === 'satsuei'
              ? <polygon points={`0,100 ${poly} 100,100`} fill="#f59e0b" fillOpacity={0.22}
                         stroke="#fcd34d" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
              : <polygon points={`0,100 ${poly} 100,100`} fill="#22d3ee" fillOpacity={0.25}
                         stroke="#67e8f9" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
          </svg>
        )
      })()}
      {isFilter && selected && getKeys(clip).map(k => (
        <div key={`fk${k.t}`}
          className="absolute z-20 w-2.5 h-2.5 rotate-45 bg-purple-300 border border-purple-600 cursor-pointer hover:bg-white"
          style={{ left: (Math.min(k.t, clip.duration_frames - 1) / Math.max(1, clip.duration_frames - 1)) * width - 5, bottom: 1 }}
          title={`キー +${k.t}f = ${k.v}(クリックでジャンプ)`}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); setCurrentFrame(clip.start_frame + k.t) }}
        />
      ))}

      {/* 🔤 字幕: 出現・消失の進み e(コマごと。濃い線)とガラスの見た目 g(薄い線)。出現と消失が重なる長さは赤み */}
      {isCredit && credit && (() => {
        const dur = Math.max(1, clip.duration_frames)
        const a = credit.timing.appear_frames, d = credit.timing.disappear_frames
        const n = Math.min(dur, 240)
        const ptsE: string[] = [], ptsG: string[] = []
        for (let k = 0; k <= n; k++) {
          const i = Math.min(dur - 1, Math.round(k / n * (dur - 1)))
          const e = eAt(i, dur, a, d), g = gOf(e, credit.refract.g0)
          const x = ((i + 0.5) / dur) * 100
          ptsE.push(`${x},${100 - e * 78}`); ptsG.push(`${x},${100 - g * 78}`)
        }
        const over = a + d > dur
        return (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
            {over && <rect x={0} y={0} width={100} height={100} fill="#ef4444" fillOpacity={0.18} />}
            <polygon points={`0,100 ${ptsE.join(' ')} 100,100`} fill="#22d3ee" fillOpacity={0.16} />
            <polyline points={ptsG.join(' ')} fill="none" stroke="#e0f2fe" strokeOpacity={0.45} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <polyline points={ptsE.join(' ')} fill="none" stroke="#67e8f9" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </svg>
        )
      })()}
      {/* 🔤 出現・消失のつまみ(選んでいるとき): 横に動かすとコマ数が変わる(Alt で吸着なし)。保持は長さ − 出現 − 消失 */}
      {isCredit && credit && selected && !locked && (['appear', 'disappear'] as const).map(which => {
        const dur = Math.max(1, clip.duration_frames)
        const f = which === 'appear' ? credit.timing.appear_frames : dur - credit.timing.disappear_frames
        const x = Math.max(0, Math.min(dur, f)) * pixelsPerFrame
        return (
          <div key={which} data-credit-handle={which}
            className="absolute z-[25] top-0 w-3 h-3 -ml-1.5 rotate-45 bg-cyan-200 border border-cyan-700 cursor-ew-resize hover:bg-white"
            style={{ left: Math.min(Math.max(0, x), width) }}
            title={which === 'appear'
              ? `出現 ${credit.timing.appear_frames} コマ(先頭から屈折 → ガラスになるまで)。左右にドラッグ・Alt で吸着なし`
              : `消失 ${credit.timing.disappear_frames} コマ(ガラス → 屈折 → 消えるまで)。左右にドラッグ・Alt で吸着なし`}
            onPointerDown={e => touchGate(e, ev => creditHandleDown(which, ev))}
            onDoubleClick={e => e.stopPropagation()}
          />
        )
      })}

      {/* Filmstrip background (video clips) — タイルが常に16:9で表示されるよう
          クリップ表示幅からコマ数を逆算(段階量子化でキャッシュ効率を保つ) */}
      {asset && (asset.asset_type === 'video' || (asset.asset_type === 'generated' && asset.duration_sec != null)) && (() => {
        const tileW = trackHeight * 16 / 9
        const STEPS = [2, 3, 4, 6, 8, 12, 16, 24, 32, 40]
        const want = width / Math.max(24, tileW)
        const n = STEPS.find(v => v >= want) ?? 40
        return (
          <div
            className="absolute inset-0 opacity-45 pointer-events-none bg-no-repeat"
            style={{ backgroundImage: `url(${assetsApi.filmstripUrl(asset.id, n)})`,
                     backgroundSize: '100% 100%' }}
          />
        )
      })()}

      {/* Motion waveform (フレーム差分量 — 音声波形の動画版) */}
      {asset && (asset.asset_type === 'video' || (asset.asset_type === 'generated' && asset.duration_sec != null)) && (
        <MotionCanvas
          assetId={asset.id}
          assetInFrame={clip.asset_in_frame}
          durationFrames={clip.duration_frames}
          speed={clip.speed || 1}
          projectFps={projectFps}
          width={Math.round(width)}
          height={Math.max(8, Math.round((trackHeight - 8) * 0.45))}
        />
      )}

      {/* キーフレーム◆マーカー(選択時のみ): クリック=ジャンプ / Shift+クリック=削除 */}
      {selected && allKeyframeTimes(clip.transform_json ?? '').map(kt => (
        <div key={kt}
          className="absolute z-20 w-2.5 h-2.5 rotate-45 bg-purple-300 border border-purple-600 cursor-pointer hover:bg-white"
          style={{ left: kt * width - 5, bottom: 1 }}
          title={`キーフレーム ${(kt * 100).toFixed(0)}% (Shift+クリックで削除)`}
          onClick={e => {
            e.stopPropagation()
            if (e.shiftKey) {
              let tj = clip.transform_json ?? ''
              for (const p of TPROPS) tj = removeKeyframe(tj, p, kt)
              updateClip(clip.id, { transform_json: tj })
            } else {
              setCurrentFrame(clip.start_frame + Math.round(kt * clip.duration_frames))
            }
          }}
        />
      ))}

      {/* 💍 指輪の位置のキー(下辺の刻み・クリックでそのコマへ) */}
      {!isFilter && !isRain && !isCredit && <RingTicks clip={clip} pixelsPerFrame={pixelsPerFrame} />}

      {/* 重なり(遷移)区間: 先頭側=前クリップから溶け込む区間、末尾側=次クリップへ溶け込ませる区間 */}
      {overlapIn > 0 && (
        <div className="absolute left-0 top-0 bottom-0 pointer-events-none z-[21] flex items-start"
          style={{ width: Math.max(8, overlapIn * pixelsPerFrame),
                   background: 'repeating-linear-gradient(135deg, rgba(56,189,248,0.55) 0 4px, rgba(56,189,248,0.15) 4px 8px)',
                   borderRight: '1px solid rgba(56,189,248,0.9)' }}
          title={`前クリップとの重なり ${overlapIn}f(遷移: ${clip.transition_in || 'cross'})`}>
          <span className="text-[9px] leading-none px-0.5 text-white" style={{ background: 'rgba(0,0,0,0.55)' }}>⇄{overlapIn}</span>
        </div>
      )}
      {overlapOut > 0 && (
        <div className="absolute right-0 top-0 bottom-0 pointer-events-none z-[21]"
          style={{ width: Math.max(8, overlapOut * pixelsPerFrame),
                   background: 'repeating-linear-gradient(45deg, rgba(56,189,248,0.35) 0 4px, rgba(56,189,248,0.08) 4px 8px)',
                   borderLeft: '1px dashed rgba(56,189,248,0.8)' }}
          title={`次クリップとの重なり ${overlapOut}f(この区間は素材の続きが下に敷かれる)`} />
      )}

      {/* Transition-in indicator (◣ at the head of the clip) — 重なりが無い旧方式の遷移のみ表示 */}
      {clip.transition_in && overlapIn === 0 && (
        <div
          className="absolute left-0 top-0 bottom-0 pointer-events-none z-20 flex items-end"
          style={{
            width: Math.max(10, clip.transition_frames * pixelsPerFrame),
            background: clip.transition_in === 'white'
              ? 'linear-gradient(to right, rgba(255,255,255,0.75), transparent)'
              : clip.transition_in === 'black'
              ? 'linear-gradient(to right, rgba(0,0,0,0.85), transparent)'
              : 'linear-gradient(to right, rgba(238,152,168,0.7), transparent)',
          }}
          title={`遷移: ${clip.transition_in === 'cross' ? 'クロス(前クリップの続きに溶かす)' : clip.transition_in} ${clip.transition_frames}f`}
        >
          <span className="text-[9px] leading-none px-0.5 text-white drop-shadow" style={{ background: 'rgba(0,0,0,0.45)' }}>
            {clip.transition_in === 'cross' ? '⤳' : clip.transition_in === 'white' ? '☀' : '●'}{clip.transition_frames}
          </span>
        </div>
      )}

      {/* Left trim handle */}
      <div
        className="clip-trim-handle absolute left-0 top-0 bottom-0 z-10 cursor-ew-resize bg-white/0 hover:bg-white/25 transition-colors"
        style={{ width: HANDLE_PX, touchAction: 'pan-x pan-y' }}
        onPointerDown={e => touchGate(e, handleLeftTrimDown)}
      />

      {/* Label (main drag area) */}
      <div
        className={`absolute inset-0 px-2 py-0.5 flex items-center cursor-grab ${dragging ? 'cursor-grabbing' : ''}`}
        style={{ left: HANDLE_PX, right: HANDLE_PX, touchAction: 'pan-x pan-y' }}
        onPointerDown={e => touchGate(e, handlePointerDown)}
      >
        <span className="truncate leading-tight">
          {hardLocked && <span className="mr-0.5">🔒</span>}
          {ri && (
            <span className={`mr-1 px-1 rounded font-mono text-[9px] leading-none py-0.5 ${ri.cls}`}
                  title={`素材 ${asset?.width}×${asset?.height}${ri.tier ? ` / ${ri.tier}` : ''}${ri.low ? '(ネイティブ 1344×768 未満)' : ''}${ri.redraw ? ' / ♻ 採用動画を参照した描き直し(元動画は参照していない)' : ri.tier ? ' / 元動画を参照した生成' : ''}`}>
              {ri.label}{ri.tier ? `·${ri.tier}` : ''}{ri.redraw ? '·♻' : ''}
            </span>
          )}
          {isFilter
            ? <span className="px-1 rounded bg-black/55">{filterLabel(clip)}</span>
            : isCredit && credit ? <span className="px-1 rounded bg-black/55">{creditErr ? '⚠ ' : ''}{creditLabel(credit)}</span>
            : isRain ? <span className="px-1 rounded bg-black/55">🌧 雨 {Math.round((clip.opacity ?? 1) * 100)}%</span>
            : (asset?.name ?? `clip ${clip.id}`)}
        </span>
      </div>

      {/* ⏱リマップ: マルチカット生成のシーンチェンジ位置を補正。
          当初Scenesのみだったが、Sequences(C18-19統合等)にも生成物が載る運用に
          なったため映像3レイヤーすべてに出す(素材が動画のときだけ)。 */}
      {selected && ['Shots', 'Scenes', 'Sequences'].includes(trackName ?? '') && asset?.duration_sec != null && (
        <button
          onClick={e => { e.stopPropagation(); setRemapOpen(true) }}
          onPointerDown={e => e.stopPropagation()}
          className={`absolute top-0 right-12 z-20 text-[11px] leading-none px-1 py-0.5 rounded-bl bg-black/50
                      ${(clip.remap_json ?? '') !== '' ? 'text-amber-300' : 'text-zinc-300 hover:text-amber-300'}`}
          title="⏱時間リマップ — シーンチェンジ位置のズレをキーで補正"
        >⏱</button>
      )}
      {remapOpen && (
        <RemapEditor clip={clip} asset={asset} fps={useTimelineStore.getState().projectFps}
                     onClose={() => setRemapOpen(false)} />
      )}

      {/* 🎚 フィルター編集(単色/ぼかし) */}
      {selected && isFilter && (
        <button
          onClick={e => { e.stopPropagation(); openFilter() }}
          onPointerDown={e => e.stopPropagation()}
          className="absolute top-0 right-6 z-20 text-[11px] leading-none px-1 py-0.5 rounded-bl bg-black/50 text-zinc-300 hover:text-purple-300"
          title={isSatsuei ? '🎚 撮影の効きのキー(時間で効きを変える)を編集' : '🎚 キー(不透明度/ぼかし強さ)と色を編集'}
        >🎚</button>
      )}

      {/* 🗂テイク履歴: このクリップ位置の生成テイクを一覧(選択時に表示)。
          🌧 雨クリップには出さない(採用すると雨の層が生成動画に置き換わる。雨の履歴は調整パネルの「これまでの雨」) */}
      {selected && !isFilter && !isRain && !isCredit && (
        <button
          onClick={e => {
            e.stopPropagation()
            window.dispatchEvent(new CustomEvent('kychapogas:open-takes', {
              detail: { s: clip.start_frame, e: clip.start_frame + clip.duration_frames - 1,
                        clipId: clip.id },   // 採用の書き換え先はこのクリップだけ
            }))
          }}
          onPointerDown={e => e.stopPropagation()}
          className="absolute top-0 right-6 z-20 text-[11px] leading-none px-1 py-0.5 rounded-bl bg-black/50 text-zinc-300 hover:text-amber-300"
          title="🗂テイク履歴 — このカットの生成テイクを見比べて採用/昇格"
        >🗂</button>
      )}

      {/* 🔒ロックトグル: 確定カットを再生成・編集から保護(選択時またはロック中に表示) */}
      {(selected || hardLocked) && (
        <button
          onClick={toggleLock}
          onPointerDown={e => e.stopPropagation()}
          className={`absolute top-0 right-0 z-20 text-[11px] leading-none px-1 py-0.5 rounded-bl
            ${hardLocked ? 'bg-amber-600/90 text-white' : 'bg-black/50 text-zinc-300 hover:text-amber-300'}`}
          title={hardLocked ? '🔒ロック中: 移動/削除/再生成の上書きから保護。クリックで解除' : 'このカットをロック(確定・再生成対象外にする)'}
        >{hardLocked ? '🔒' : '🔓'}</button>
      )}

      {/* Scene change markers (video clips) */}
      {assetScenes && (
        <SceneMarkers
          scenes={assetScenes}
          assetInFrame={clip.asset_in_frame}
          clipDurationFrames={clip.duration_frames}
          pixelsPerFrame={pixelsPerFrame}
          fps={24}
        />
      )}

      {/* Motion heat overlay (video clips) */}
      {assetMotion && (
        <MotionHeat
          motion={assetMotion}
          assetInFrame={clip.asset_in_frame}
          clipDurationFrames={clip.duration_frames}
          pixelsPerFrame={pixelsPerFrame}
          fps={24}
        />
      )}

      {/* Right trim handle */}
      <div
        className="clip-trim-handle absolute right-0 top-0 bottom-0 z-10 cursor-ew-resize bg-white/0 hover:bg-white/25 transition-colors"
        style={{ width: HANDLE_PX, touchAction: 'pan-x pan-y' }}
        onPointerDown={e => touchGate(e, handleRightTrimDown)}
      />
    </div>
  )
})
