import { useEffect, useRef, useState } from 'react'

// ── WebAudioストリーミング用の型 ──────────────────────────────────────────
const SEG_SEC = 10          // wavセグメント長(秒)
const AHEAD_SEC = 20        // 再生位置から先読みする秒数
interface WavMeta {
  sr: number; ch: number; blockAlign: number; dataStart: number
  totalSamples: number; fmt: 's16' | 's24' | 'f32'
  // raw: 取得済みの生PCMバイト(null=取得中)。一度読んだ区間は保持し続ける
  // (曲全体でもファイルサイズ相当なので破棄しない — 再訪時は再取得なしで即デコード)。
  raw: Map<number, ArrayBuffer | null>
  // segs: デコード済みAudioBuffer。メモリが大きいので再生窓の周辺のみ保持。
  segs: Map<number, AudioBuffer>
}
interface PlayEntry {
  assetId: number
  gain: GainNode
  kind: 'full' | 'stream'
  anchorCtx: number         // アンカー: ctx時刻 anchorCtx にアセット位置 anchorPos 秒
  anchorPos: number
  full?: AudioBufferSourceNode
  segSrcs: Map<number, AudioBufferSourceNode>
}
import { useTimelineStore } from '../../store/timelineStore'
import { useProjectStore } from '../../store/projectStore'
import { useUIStore } from '../../store/uiStore'
import type { Asset } from '../../api/client'
import { assetsApi } from '../../api/client'
import { evalTransform, parseElement, type TextProps, type XForm } from './transformEval'

interface Props {
  assets: Asset[]
  onAsset?: (asset: Asset) => void
}

// 速度エンベロープ("curve:r1,..,rN")のプレビュー適用ヘルパ。
// rel(u)=その位置の相対速度 / integ(u)=0..uの正規化積分(=ソース消費割合)。
function parseSpeedCurve(ease: string | undefined): number[] | null {
  if (!ease || !ease.startsWith('curve:')) return null
  const rel = ease.slice(6).split(';')[0].split(',').map(Number).filter(v => v > 0)
  return rel.length >= 2 ? rel : null
}
function curveRelAt(rel: number[], u: number): number {
  const x = Math.max(0, Math.min(0.9999, u)) * rel.length
  return rel[Math.floor(x)]
}
function curveIntegralAt(rel: number[], u: number): number {
  // 区分一定積分(平均1に正規化済み想定)。I(1)=1
  const uu = Math.max(0, Math.min(1, u))
  const n = rel.length
  const x = uu * n
  const full = Math.floor(x)
  let acc = 0
  for (let i = 0; i < full; i++) acc += rel[i]
  if (full < n) acc += rel[full] * (x - full)
  return acc / n
}

export function PreviewPlayer({ assets, onAsset }: Props) {
  const { tracks, clips, currentFrame, projectFps, setCurrentFrame, placeClip, previewHidden } = useTimelineStore()
  const { activeProject } = useProjectStore()
  const videoRef  = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [loadedAssetId, setLoadedAssetId] = useState<number | null>(null)
  const [videoBuffering, setVideoBuffering] = useState(false)
  const [audioBuffering, setAudioBuffering] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const compRef = useRef<HTMLCanvasElement>(null)        // WYSIWYG compositor
  const imgMap = useRef<Map<number, HTMLImageElement>>(new Map())
  const refSel = useTimelineStore(s => s.refSel)         // 選択中のImage(Ref)ピン
  const [redraw, setRedraw] = useState(0)                // bumped when an image loads
  // 直前に確定した動画フレームのキャッシュ。シーク中(readyState低下)に黒フレームを
  // 出さず、前のフレームを描き続けるために使う(シーク完了ごとに更新)。
  const videoCacheRef = useRef<{ canvas: HTMLCanvasElement | null; assetId: number | null }>({ canvas: null, assetId: null })
  // コマ打ちプレビュー: スロット(=ホールド区間)が変わった時だけビデオフレームを取り込む
  const holdCacheRef = useRef<{ clipId: number | null; slot: number; canvas: HTMLCanvasElement | null }>({ clipId: null, slot: -1, canvas: null })
  const [box, setBox] = useState({ w: 0, h: 0 })   // fitted project-frame box (px)
  const [guideMode, setGuideMode] = useState<'off' | 'thirds' | 'safe'>('off')
  const [lightPreview, setLightPreview] = useState(true)   // cap backing-store res
  // 差分再生モード: |今フレーム−前フレーム| を表示し、画面全体の動き量を数値化。
  // カット=鋭いスパイク / カメラ・モーション=持続的な山。音ハメ加速の指標検証用。
  const [diffMode, setDiffMode] = useState(false)
  const prevFrameRef = useRef<HTMLCanvasElement | null>(null)
  const diffTmpRef = useRef<HTMLCanvasElement | null>(null)
  const measRef = useRef<HTMLCanvasElement | null>(null)
  const motionHistRef = useRef<number[]>([])
  const motionTextRef = useRef<HTMLSpanElement | null>(null)
  const sparkRef = useRef<HTMLCanvasElement | null>(null)

  const projW = activeProject?.width  ?? 1280
  const projH = activeProject?.height ?? 720

  // ベースレイヤー選択: 「再生ヘッドにクリップがある」最上位のVideoトラックを使う。
  // 最上段が空白の区間は透明扱いで下のトラックへフォールスルーする(黒塗りにしない)。
  const activeClip = (() => {
    const vTracks = [...tracks]
      .sort((a, b) => a.order - b.order)
      .filter(t => t.track_type === 'video' && !t.hidden)
    for (const t of vTracks) {
      const hit = clips
        .filter(c => c.track_id === t.id)
        .find(c => c.start_frame <= currentFrame && c.start_frame + c.duration_frames > currentFrame)
      if (hit) return hit
    }
    return null
  })()
  const activeAsset = activeClip?.asset_id != null
    ? assets.find(a => a.id === activeClip.asset_id)
    : null

  // "generated" covers both images and videos — disambiguate by duration.
  const isVideoAsset = activeAsset?.asset_type === 'video'
    || (activeAsset?.asset_type === 'generated' && activeAsset?.duration_sec != null)

  // 再生ヘッドに重なる全Audioクリップ(全トラック分をミックス再生する)
  const activeAudioClips = clips.filter(c => {
    const t = tracks.find(tk => tk.id === c.track_id)
    return t?.track_type === 'audio' && !t?.hidden && c.asset_id != null
      && c.start_frame <= currentFrame && c.start_frame + c.duration_frames > currentFrame
  })

  // Load video when the asset changes — prefer the low-res proxy for light preview
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!activeClip || activeClip.asset_id == null) {
      video.src = ''
      setLoadedAssetId(null)
      return
    }
    const url = assetsApi.fileUrl(activeClip.asset_id, !!activeAsset?.proxy_path)
    if (video.getAttribute('src') !== url) {
      video.src = url
      video.load()
      setLoadedAssetId(activeClip.asset_id)
    }
  }, [activeClip?.asset_id, activeAsset?.proxy_path])

  // シーク完了・デコード完了のたびに合成を再描画する(スクラブ時に古いフレームが
  // 残らないように)。video.currentTime代入は非同期なので、seekedを待たないと
  // canvasには前のフレームが描かれたままになる。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const bump = () => {
      // 確定フレームをキャッシュしてから再描画(スクラブ中の黒フレーム対策)
      if (video.readyState >= 2 && video.videoWidth) {
        const c = videoCacheRef.current
        if (!c.canvas) c.canvas = document.createElement('canvas')
        if (c.canvas.width !== video.videoWidth || c.canvas.height !== video.videoHeight) {
          c.canvas.width = video.videoWidth; c.canvas.height = video.videoHeight
        }
        c.canvas.getContext('2d')?.drawImage(video, 0, 0)
        const src = video.getAttribute('src') ?? ''
        const m = src.match(/\/assets\/(\d+)\//)
        c.assetId = m ? Number(m[1]) : c.assetId
      }
      setRedraw(n => n + 1)
    }
    video.addEventListener('seeked', bump)
    video.addEventListener('loadeddata', bump)
    video.addEventListener('canplay', bump)
    // バッファ状態の可視化(音/映像が出ないのがロード中か判別できるように)
    const onWait = () => setVideoBuffering(true)
    const onReady = () => setVideoBuffering(false)
    video.addEventListener('waiting', onWait)
    video.addEventListener('stalled', onWait)
    video.addEventListener('loadstart', onWait)
    video.addEventListener('canplay', onReady)
    video.addEventListener('playing', onReady)
    return () => {
      video.removeEventListener('seeked', bump)
      video.removeEventListener('loadeddata', bump)
      video.removeEventListener('canplay', bump)
      video.removeEventListener('waiting', onWait)
      video.removeEventListener('stalled', onWait)
      video.removeEventListener('loadstart', onWait)
      video.removeEventListener('canplay', onReady)
      video.removeEventListener('playing', onReady)
    }
  }, [])

  // Apply per-clip playback speed to the video element.
  // 速度カーブ("curve:")付きクリップは現在位置の瞬間速度を反映する(プレビューでも
  // 加減速ランプが体感できる)。ブラウザのplaybackRate上限に合わせてクランプ。
  useEffect(() => {
    const video = videoRef.current
    if (!video || !activeClip) return
    const sp = activeClip.speed > 0 ? activeClip.speed : 1
    const rel = parseSpeedCurve(activeClip.speed_ease)
    let rate = sp
    if (rel) {
      const u = (currentFrame - activeClip.start_frame) / Math.max(1, activeClip.duration_frames)
      rate = sp * curveRelAt(rel, u)
    }
    video.playbackRate = Math.max(0.0625, Math.min(16, rate))
  }, [activeClip?.speed, activeClip?.speed_ease, currentFrame, loadedAssetId])

  // Keep the video element playing / seeked in sync with the playhead.
  // The timeline clock (below) is the MASTER; the video follows it — when a new
  // clip's src loads mid-playback we re-play() and re-seek here, so playback
  // doesn't freeze on the new clip's first frame.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!activeClip || !isVideoAsset) {
      if (!video.paused) video.pause()
      return
    }
    const sp = activeClip.speed > 0 ? activeClip.speed : 1
    const relCurve = parseSpeedCurve(activeClip.speed_ease)
    const relFrames = currentFrame - activeClip.start_frame
    const consumed = relCurve
      ? activeClip.duration_frames * sp * curveIntegralAt(relCurve, relFrames / Math.max(1, activeClip.duration_frames))
      : relFrames * sp
    const assetTime = (activeClip.asset_in_frame + consumed) / projectFps
    if (playing) {
      if (Math.abs(video.currentTime - assetTime) > 0.25) video.currentTime = Math.max(0, assetTime)  // drift correction only
      if (video.paused) video.play().catch(() => {})
    } else {
      if (!video.paused) video.pause()
      // フレーム精度スクラブ: 半フレーム許容 + 境界丸め回避の微小オフセット
      const target = Math.max(0, assetTime) + 1e-4
      if (Math.abs(video.currentTime - target) > 0.5 / projectFps) video.currentTime = target
    }
  }, [currentFrame, playing, activeClip, projectFps, loadedAssetId, isVideoAsset])

  // 音声はWebAudioミキサー方式: 重なる全Audioトラックのクリップを同時にミックス再生。
  // wav(PCM)は再生位置優先の窓方式ストリーミング(10秒セグメントをRange取得して自前デコード)。
  // その他形式(mp3/m4a等)は従来どおり全体デコードにフォールバック。
  // AudioBufferSourceNodeは自走クロックなので、rAF側とのずれは閾値超過時のみ張り直す。
  const audioCtxRef = useRef<AudioContext | null>(null)
  const audioBufCacheRef = useRef<Map<number, { buf: AudioBuffer | null, promise: Promise<AudioBuffer | null> }>>(new Map())
  const wavMetaRef = useRef<Map<number, WavMeta | null>>(new Map())   // null = wavではない(要フォールバック)
  const wavHeaderPendingRef = useRef<Set<number>>(new Set())
  const audioSrcRef = useRef<Map<number, PlayEntry>>(new Map())
  const unlockAudioPool = () => {
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || (window as any).webkitAudioContext
      if (AC) audioCtxRef.current = new AC()
    }
    audioCtxRef.current?.resume().catch(() => {})
  }
  // 音声プロキシ(AAC 96k・数MB)があればそれを全体デコードするのが最速+最軽量。
  // proxy_pathが音声形式のときのみtrue(動画プロキシmp4と区別)。
  const assetsRef = useRef(assets)
  assetsRef.current = assets
  const hasAudioProxy = (assetId: number) => {
    const a = assetsRef.current.find(x => x.id === assetId)
    return !!a?.proxy_path && /\.(m4a|aac|mp3|ogg|opus)$/i.test(a.proxy_path)
  }
  const proxyProgRef = useRef<Map<number, number>>(new Map())   // aid → DL進捗0..1
  const loadAudioBuffer = (assetId: number, useProxy = false): Promise<AudioBuffer | null> => {
    const ctx = audioCtxRef.current
    if (!ctx) return Promise.resolve(null)
    const cache = audioBufCacheRef.current
    const hit = cache.get(assetId)
    if (hit) return hit.promise
    const entry: { buf: AudioBuffer | null, promise: Promise<AudioBuffer | null> } = {
      buf: null,
      promise: Promise.resolve(null),
    }
    entry.promise = (async () => {
        const res = await fetch(assetsApi.fileUrl(assetId, useProxy))
        const total = Number(res.headers.get('Content-Length') || 0)
        let ab: ArrayBuffer
        if (res.body && total > 0) {
          // ストリーム読みでDL進捗をバッファバーに反映
          const reader = res.body.getReader()
          const parts: Uint8Array[] = []
          let got = 0
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            parts.push(value)
            got += value.length
            proxyProgRef.current.set(assetId, got / total)
          }
          const all = new Uint8Array(got)
          let o = 0
          for (const p of parts) { all.set(p, o); o += p.length }
          ab = all.buffer
        } else {
          ab = await res.arrayBuffer()
        }
        const buf = await ctx.decodeAudioData(ab)
        entry.buf = buf
        proxyProgRef.current.set(assetId, 1)
        return buf
      })().catch(() => { cache.delete(assetId); proxyProgRef.current.delete(assetId); return null })
    cache.set(assetId, entry)
    // デコード済みバッファは巨大(数十MB)なのでLRUで6件まで
    if (cache.size > 6) {
      for (const k of cache.keys()) {
        if (cache.size <= 6) break
        const inUse = [...audioSrcRef.current.values()].some(s => s.assetId === k)
        if (!inUse) cache.delete(k)
      }
    }
    return entry.promise
  }
  const stopAudioClip = (clipId: number) => {
    const e = audioSrcRef.current.get(clipId)
    if (!e) return
    audioSrcRef.current.delete(clipId)
    try { e.full?.stop(); e.full?.disconnect() } catch { /* already stopped */ }
    for (const s of e.segSrcs.values()) {
      try { s.stop(); s.disconnect() } catch { /* noop */ }
    }
    try { e.gain.disconnect() } catch { /* noop */ }
  }
  // wavヘッダ解析(先頭64KBのRange取得)。PCM s16/s24/f32のみストリーミング対象。
  const parseWavHeader = async (assetId: number): Promise<WavMeta | null> => {
    try {
      const res = await fetch(assetsApi.fileUrl(assetId), { headers: { Range: 'bytes=0-65535' } })
      if (res.status !== 206) return null   // Range非対応なら全体デコードへ
      const dv = new DataView(await res.arrayBuffer())
      if (dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) return null
      let off = 12
      let fmt: WavMeta['fmt'] | null = null
      let sr = 0, ch = 0, blockAlign = 0, dataStart = -1, dataSize = 0
      while (off + 8 <= dv.byteLength) {
        const id = dv.getUint32(off, false)
        const size = dv.getUint32(off + 4, true)
        if (id === 0x666d7420) {          // 'fmt '
          let audioFormat = dv.getUint16(off + 8, true)
          ch = dv.getUint16(off + 10, true)
          sr = dv.getUint32(off + 12, true)
          blockAlign = dv.getUint16(off + 20, true)
          const bits = dv.getUint16(off + 22, true)
          // WAVE_FORMAT_EXTENSIBLE: 実フォーマットはSubFormat GUIDの先頭2バイト
          if (audioFormat === 0xfffe && size >= 40) audioFormat = dv.getUint16(off + 8 + 24, true)
          if (audioFormat === 1 && bits === 16) fmt = 's16'
          else if (audioFormat === 1 && bits === 24) fmt = 's24'
          else if (audioFormat === 3 && bits === 32) fmt = 'f32'
          else return null
        } else if (id === 0x64617461) {   // 'data'
          dataStart = off + 8
          dataSize = size
          break
        }
        off += 8 + size + (size & 1)
      }
      if (!fmt || dataStart < 0 || !sr || !ch || !blockAlign) return null
      // ffmpegパイプ出力等でdataサイズ未確定のときはContent-Rangeの全長から補完
      const total = parseInt(res.headers.get('Content-Range')?.split('/')[1] ?? '', 10)
      if ((!dataSize || dataSize === 0xffffffff) && Number.isFinite(total)) dataSize = total - dataStart
      return { sr, ch, blockAlign, dataStart, totalSamples: Math.floor(dataSize / blockAlign), fmt, raw: new Map(), segs: new Map() }
    } catch { return null }
  }
  const decodeWavSeg = (meta: WavMeta, k: number, ab: ArrayBuffer) => {
    const ctx = audioCtxRef.current
    if (!ctx) return
    const dv = new DataView(ab)
    const n = Math.floor(ab.byteLength / meta.blockAlign)
    const buf = ctx.createBuffer(meta.ch, Math.max(1, n), meta.sr)
    const bytesPer = meta.blockAlign / meta.ch
    for (let c = 0; c < meta.ch; c++) {
      const out = buf.getChannelData(c)
      for (let i = 0; i < n; i++) {
        const p = i * meta.blockAlign + c * bytesPer
        out[i] = meta.fmt === 's16' ? dv.getInt16(p, true) / 32768
          : meta.fmt === 'f32' ? dv.getFloat32(p, true)
          : (dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16)) / 8388608
      }
    }
    meta.segs.set(k, buf)
  }
  const loadWavSeg = (assetId: number, meta: WavMeta, k: number) => {
    if (meta.segs.has(k)) return
    const cached = meta.raw.get(k)
    if (cached === null) return                 // 取得中
    if (cached) { decodeWavSeg(meta, k, cached); return }   // キャッシュ済み→即デコード
    const s0 = k * SEG_SEC * meta.sr
    const s1 = Math.min(meta.totalSamples, s0 + SEG_SEC * meta.sr)
    if (s1 <= s0) return
    meta.raw.set(k, null)
    const b0 = meta.dataStart + s0 * meta.blockAlign
    const b1 = meta.dataStart + s1 * meta.blockAlign - 1
    fetch(assetsApi.fileUrl(assetId), { headers: { Range: `bytes=${b0}-${b1}` } })
      .then(r => r.arrayBuffer())
      .then(ab => {
        meta.raw.set(k, ab)
        decodeWavSeg(meta, k, ab)
      })
      .catch(() => meta.raw.delete(k))
  }
  const clipGainAt = (c: typeof clips[number], frame: number) => {
    const rel = frame - c.start_frame
    let vol = 1
    if (c.fade_in_frames > 0 && rel < c.fade_in_frames) vol = rel / c.fade_in_frames
    const tail = c.duration_frames - rel
    if (c.fade_out_frames > 0 && tail < c.fade_out_frames) vol = Math.min(vol, tail / c.fade_out_frames)
    return Math.max(0, Math.min(1, vol))
  }

  // アイドルプリフェッチ: 停止中・再生前から音声を先回りして読み込む。
  // 優先順 = 再生ヘッド上のクリップ(現在位置→末尾→先頭)、次に前方のクリップ。
  // 常時3並列まで。再生時は取得済みrawから即デコードされるのでコールドスタートが消える。
  const rawInflightRef = useRef(0)
  useEffect(() => {
    const RAW_INFLIGHT_MAX = 3
    const fetchRaw = (aid: number, meta: WavMeta, k: number) => {
      if (meta.raw.has(k)) return
      const s0 = k * SEG_SEC * meta.sr
      const s1 = Math.min(meta.totalSamples, s0 + SEG_SEC * meta.sr)
      if (s1 <= s0) return
      meta.raw.set(k, null)
      rawInflightRef.current++
      const b0 = meta.dataStart + s0 * meta.blockAlign
      const b1 = meta.dataStart + s1 * meta.blockAlign - 1
      fetch(assetsApi.fileUrl(aid), { headers: { Range: `bytes=${b0}-${b1}` } })
        .then(r => r.arrayBuffer())
        .then(ab => { meta.raw.set(k, ab) })
        .catch(() => meta.raw.delete(k))
        .finally(() => { rawInflightRef.current-- })
    }
    const tick = () => {
      if (document.hidden) return   // 非表示タブでは先読みしない
      if (!audioCtxRef.current) {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (AC) audioCtxRef.current = new AC()   // suspendedのままでOK(音はresume後)
      }
      if (!audioCtxRef.current) return
      const { clips: cs, tracks: ts, currentFrame: f, projectFps: fps } = useTimelineStore.getState()
      const pri = (c: typeof cs[number]) =>
        f >= c.start_frame && f < c.start_frame + c.duration_frames ? 0
          : c.start_frame > f ? c.start_frame - f : 1e9   // 再生済み(過去)のクリップは最後
      const tOrder = (c: typeof cs[number]) => ts.find(tk => tk.id === c.track_id)?.order ?? 0
      const audible = cs
        .filter(c => {
          const t = ts.find(tk => tk.id === c.track_id)
          return t?.track_type === 'audio' && !t.hidden && c.asset_id != null
        })
        .sort((a, b) => pri(a) - pri(b) || tOrder(a) - tOrder(b) || a.track_id - b.track_id)
      // 全体デコード型は1本ずつ順番に(帯域を集中→上位トラックから最速で完成させる)
      let fullSlotFree = ![...audioBufCacheRef.current.values()].some(e => !e.buf)
      for (const c of audible) {
        if (rawInflightRef.current >= RAW_INFLIGHT_MAX) return
        const aid = c.asset_id!
        if (hasAudioProxy(aid)) {
          if (!audioBufCacheRef.current.has(aid) && fullSlotFree) {
            loadAudioBuffer(aid, true)
            fullSlotFree = false
          }
          continue
        }
        if (!wavMetaRef.current.has(aid)) {
          if (!wavHeaderPendingRef.current.has(aid)) {
            wavHeaderPendingRef.current.add(aid)
            parseWavHeader(aid).then(m => { wavMetaRef.current.set(aid, m) })
          }
          continue
        }
        const meta = wavMetaRef.current.get(aid)
        if (!meta) {
          // wav以外は全体デコードを先行して温めておく
          if (pri(c) === 0) loadAudioBuffer(aid)
          continue
        }
        const active = pri(c) === 0
        const pos = active ? (f - c.start_frame + c.asset_in_frame) / fps : c.asset_in_frame / fps
        const endPos = Math.min((c.asset_in_frame + c.duration_frames) / fps, meta.totalSamples / meta.sr)
        const kStart = Math.floor(c.asset_in_frame / fps / SEG_SEC)
        const kEnd = Math.floor(Math.max(0, endPos - 1e-6) / SEG_SEC)
        const kPos = Math.min(kEnd, Math.max(kStart, Math.floor(pos / SEG_SEC)))
        const order: number[] = []
        for (let k = kPos; k <= kEnd; k++) order.push(k)
        for (let k = kStart; k < kPos; k++) order.push(k)
        for (const k of order) {
          if (rawInflightRef.current >= RAW_INFLIGHT_MAX) return
          if (!meta.raw.has(k)) fetchRaw(aid, meta, k)
        }
      }
    }
    const iv = setInterval(tick, 400)
    tick()
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    const ctx = audioCtxRef.current
    const srcs = audioSrcRef.current
    if (!playing || !ctx || ctx.state !== 'running') {
      for (const id of [...srcs.keys()]) stopAudioClip(id)
      setAudioBuffering(false)
      return
    }
    const activeIds = new Set(activeAudioClips.map(c => c.id))
    for (const id of [...srcs.keys()]) if (!activeIds.has(id)) stopAudioClip(id)
    let pending = false
    for (const c of activeAudioClips) {
      const aid = c.asset_id!
      const pos = (currentFrame - c.start_frame + c.asset_in_frame) / projectFps
      let entry = srcs.get(c.id)
      if (entry) {
        // ドリフト/シーク検出: アンカー基準の期待位置と0.25s超ずれたら張り直し
        const expected = entry.anchorPos + (ctx.currentTime - entry.anchorCtx)
        if (Math.abs(expected - pos) > 0.25) { stopAudioClip(c.id); entry = undefined }
      }
      const proxied = hasAudioProxy(aid)
      // wavヘッダ判定(初回のみ、プロキシがあれば不要)。判定完了までは保留
      if (!proxied && !wavMetaRef.current.has(aid)) {
        if (!wavHeaderPendingRef.current.has(aid)) {
          wavHeaderPendingRef.current.add(aid)
          parseWavHeader(aid).then(m => { wavMetaRef.current.set(aid, m) })
        }
        pending = true
        continue
      }
      const meta = proxied ? null : wavMetaRef.current.get(aid) ?? null
      if (!entry) {
        const gain = ctx.createGain()
        gain.gain.value = clipGainAt(c, currentFrame)
        gain.connect(ctx.destination)
        entry = {
          assetId: aid, gain, kind: meta ? 'stream' : 'full',
          anchorCtx: ctx.currentTime, anchorPos: pos, segSrcs: new Map(),
        }
        srcs.set(c.id, entry)
      }
      entry.gain.gain.setTargetAtTime(clipGainAt(c, currentFrame), ctx.currentTime, 0.02)
      const clipEndPos = pos + (c.start_frame + c.duration_frames - currentFrame) / projectFps

      if (entry.kind === 'full' || !meta) {
        // 全体デコード: 音声プロキシ(AAC・数MB) / mp3・m4a等 / Range非対応
        if (entry.full) continue
        const cached = audioBufCacheRef.current.get(aid)
        if (!cached?.buf) {
          pending = true
          loadAudioBuffer(aid, proxied)  // デコード完了後のrAF更新で自然に拾われる
          continue
        }
        const src = ctx.createBufferSource()
        src.buffer = cached.buf
        src.connect(entry.gain)
        src.start(0, Math.max(0, pos))
        try { src.stop(ctx.currentTime + Math.max(0, clipEndPos - pos)) } catch { /* noop */ }
        entry.full = src
        entry.anchorCtx = ctx.currentTime
        entry.anchorPos = pos
        continue
      }

      // wavストリーミング: 再生位置〜先読み窓のセグメントを取得し、アンカー時刻に正確に連結
      const endPos = Math.min(clipEndPos, meta.totalSamples / meta.sr)
      const k0 = Math.floor(pos / SEG_SEC)
      const k1 = Math.max(k0, Math.floor(Math.min(endPos - 1e-6, pos + AHEAD_SEC) / SEG_SEC))
      for (let k = k0; k <= k1; k++) {
        let seg = meta.segs.get(k)
        if (!seg) {
          loadWavSeg(aid, meta, k)      // rawキャッシュ済みなら同期デコードされる
          seg = meta.segs.get(k)
        }
        if (!seg) { if (k === k0) pending = true; continue }
        if (entry.segSrcs.has(k)) continue
        const startAt = entry.anchorCtx + (k * SEG_SEC - entry.anchorPos)
        const when = Math.max(ctx.currentTime, startAt)
        const into = when - startAt
        if (into >= seg.duration) continue
        const src = ctx.createBufferSource()
        src.buffer = seg
        src.connect(entry.gain)
        src.start(when, into)
        const stopAt = entry.anchorCtx + (endPos - entry.anchorPos)
        if (stopAt < startAt + seg.duration) { try { src.stop(Math.max(when, stopAt)) } catch { /* noop */ } }
        entry.segSrcs.set(k, src)
      }
      // 窓の外のデコード済みバッファのみ破棄(生バイトキャッシュは保持)
      for (const k of [...meta.segs.keys()]) {
        if (k < k0 - 1 || k > k1 + 1) meta.segs.delete(k)
      }
      for (const k of [...entry.segSrcs.keys()]) {
        if (k < k0 - 1) entry.segSrcs.delete(k)
      }
    }
    setAudioBuffering(pending)
  }, [playing, currentFrame, activeAudioClips, projectFps])

  // Audioトラックが鳴っている間はVideoの内蔵音声をミュート(二重再生防止)
  useEffect(() => {
    const v = videoRef.current
    if (v) v.muted = activeAudioClips.length > 0
  }, [activeAudioClips.length])

  useEffect(() => () => {
    for (const id of [...audioSrcRef.current.keys()]) {
      const e = audioSrcRef.current.get(id)
      audioSrcRef.current.delete(id)
      try { e?.full?.stop() } catch { /* noop */ }
      for (const s of e?.segSrcs.values() ?? []) { try { s.stop() } catch { /* noop */ } }
    }
    audioCtxRef.current?.close().catch(() => {})
  }, [])

  // クリップごとの読み込み済み範囲を集計してストアへ(タイムラインのバッファバー用)。
  // audio=wavセグメント/全体デコードの状態、video=プレビュー中素材のbuffered。
  const setClipBuffered = useTimelineStore(s => s.setClipBuffered)
  const lastBufJsonRef = useRef('')
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.hidden) return
      const { clips: cs, tracks: ts, projectFps: fps } = useTimelineStore.getState()
      const m: Record<number, [number, number][]> = {}
      for (const c of cs) {
        if (c.asset_id == null) continue
        const t = ts.find(tk => tk.id === c.track_id)
        if (!t || t.track_type === 'reference') continue
        const a0 = c.asset_in_frame / fps
        const span = Math.max(0.01, (c.duration_frames / fps) * (c.speed ?? 1))
        const a1 = a0 + span
        const ranges: [number, number][] = []
        if (t.track_type === 'audio') {
          const meta = hasAudioProxy(c.asset_id) ? null : wavMetaRef.current.get(c.asset_id)
          if (meta) {
            // バーは「取得済み(rawキャッシュ)」基準 — 一度読んだ区間は維持されて見える
            for (const [k, ab] of meta.raw) {
              if (!ab) continue
              const s = k * SEG_SEC
              const e = s + ab.byteLength / meta.blockAlign / meta.sr
              if (e > a0 && s < a1) ranges.push([Math.max(0, (s - a0) / span), Math.min(1, (e - a0) / span)])
            }
          } else if (audioBufCacheRef.current.get(c.asset_id)?.buf) {
            ranges.push([0, 1])
          } else {
            const pr = proxyProgRef.current.get(c.asset_id)
            if (pr) ranges.push([0, pr])   // 全体デコード型のDL進捗
          }
        } else {
          const v = videoRef.current
          if (v && loadedAssetId === c.asset_id) {
            for (let i = 0; i < v.buffered.length; i++) {
              const s = v.buffered.start(i)
              const e = v.buffered.end(i)
              if (e > a0 && s < a1) ranges.push([Math.max(0, (s - a0) / span), Math.min(1, (e - a0) / span)])
            }
          }
        }
        if (ranges.length) {
          ranges.sort((x, y) => x[0] - y[0])
          const merged: [number, number][] = []
          for (const r of ranges) {
            const last = merged[merged.length - 1]
            if (last && r[0] <= last[1] + 0.005) last[1] = Math.max(last[1], r[1])
            else merged.push([r[0], r[1]])
          }
          m[c.id] = merged.map(r => [Math.round(r[0] * 200) / 200, Math.round(r[1] * 200) / 200])
        }
      }
      const j = JSON.stringify(m)
      if (j !== lastBufJsonRef.current) {
        lastBufJsonRef.current = j
        setClipBuffered(m)
      }
    }, 500)
    return () => clearInterval(iv)
  }, [loadedAssetId, setClipBuffered])

  // 次に再生されるクリップの先頭を軽く先読みしてHTTPキャッシュを温める。
  // (512KBのRange取得のみ=帯域・メモリ負荷は最小。1アセット1回だけ)
  const prefetchedRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    const horizon = currentFrame + projectFps * 10   // 10秒先まで
    const upcoming = clips.filter(c => {
      const t = tracks.find(tk => tk.id === c.track_id)
      return t && !t.hidden && (t.track_type === 'video' || t.track_type === 'audio')
        && c.asset_id != null
        && c.start_frame > currentFrame && c.start_frame <= horizon
    })
    for (const c of upcoming.slice(0, 4)) {
      const aid = c.asset_id!
      if (prefetchedRef.current.has(aid)) continue
      prefetchedRef.current.add(aid)
      const asset = assets.find(a => a.id === aid)
      fetch(assetsApi.fileUrl(aid, !!asset?.proxy_path), {
        headers: { Range: 'bytes=0-524287' },
      }).catch(() => { prefetchedRef.current.delete(aid) })
    }
  }, [currentFrame, clips, tracks, assets, projectFps])

  // ── WYSIWYG compositor ────────────────────────────────────────────────────
  // Preload image assets so the canvas can composite them (file = full quality).
  // タイムラインに配置されている画像のみ。アセットパネルにあるだけの素材は
  // サムネイル表示に任せ、実ファイルはクリップ化された時点で読む(帯域をタイムライン優先に)。
  useEffect(() => {
    const used = new Set(clips.map(c => c.asset_id).filter((id): id is number => id != null))
    for (const a of assets) {
      const isImg = a.asset_type === 'image' || (a.asset_type === 'generated' && a.duration_sec == null)
      if (isImg && used.has(a.id) && !imgMap.current.has(a.id)) {
        const im = new Image()
        im.onload = () => setRedraw(r => r + 1)   // re-run the draw effect with fresh state
        im.src = assetsApi.fileUrl(a.id)
        imgMap.current.set(a.id, im)
      }
    }
  }, [assets, clips])

  // Draw an asset as a LAYER: cover-fit × scale, panned by (x,y), rotated about
  // its anchor. Mirrors the AE-style transform consumed by the render.
  const drawLayer = (ctx: CanvasRenderingContext2D, src: CanvasImageSource,
                     iw: number, ih: number, xf: XForm) => {
    if (!iw || !ih) return
    const s = Math.max(projW / iw, projH / ih) * xf.zoom
    const dw = iw * s, dh = ih * s
    const cx = projW / 2 + xf.x * projW
    const cy = projH / 2 + xf.y * projH
    const [ax, ay] = xf.anchor
    ctx.save()
    ctx.translate(cx, cy)
    if (xf.rotation) ctx.rotate((xf.rotation * Math.PI) / 180)
    ctx.drawImage(src, -dw * ax, -dh * ay, dw, dh)   // anchor maps to (cx,cy)
    ctx.restore()
  }

  const drawText = (ctx: CanvasRenderingContext2D, el: TextProps, prog: number) => {
    const inD = el.inDur ?? 0.3
    const p = inD > 0 ? Math.min(1, prog / inD) : 1
    let alpha = p, dy = 0, scale = 1
    if (el.anim === 'rise') { dy = (1 - p) * 50 }
    else if (el.anim === 'slam') { scale = 1 + (1 - p) * 1.4 }
    ctx.save()
    ctx.globalAlpha *= alpha
    ctx.translate((el.x ?? 0.5) * projW, (el.y ?? 0.5) * projH + dy)
    ctx.scale(scale, scale)
    ctx.textAlign = el.align ?? 'center'; ctx.textBaseline = 'middle'
    ctx.font = `${el.weight ?? 900} ${el.size ?? 90}px "Arial Black",Arial,sans-serif`
    if (el.glow) { ctx.shadowColor = el.glow; ctx.shadowBlur = (el.size ?? 90) * 0.55 }
    ctx.fillStyle = el.color ?? '#fff'
    ctx.fillText(el.text, 0, 0)
    ctx.restore()
  }

  const drawComposite = () => {
    const cv = compRef.current; if (!cv) return
    const ctx = cv.getContext('2d'); if (!ctx) return
    // 軽量プレビュー: cap the backing-store resolution (fill cost ∝ pixels). All
    // draw code stays in project-frame coordinates; a base transform scales down.
    const capW = lightPreview ? 1280 : 3840
    const s = Math.min(1, capW / projW)
    const cw = Math.max(1, Math.round(projW * s)), ch = Math.max(1, Math.round(projH * s))
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch }
    ctx.setTransform(s, 0, 0, s, 0, 0)                 // draw in projW×projH space
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, projW, projH)
    // 🎬 カット割り背景: Imageトラックのピン(時刻順2個ペア=カット)の現在カット
    // 開始画像を最背面に敷く。プレースホルダの色がプレビューに出るため、
    // 音とカット割りの一致を再生しながら確認できる。実素材レイヤーがあれば隠れる。
    {
      const imgTrack = tracks.find(t => t.track_type === 'reference' && t.name === 'Image' && !t.hidden)
      if (imgTrack) {
        const pins = clips
          .filter(c => c.track_id === imgTrack.id && c.asset_id != null)
          .sort((a, b) => a.start_frame - b.start_frame)
        for (let i = 0; i + 1 < pins.length; i += 2) {
          // 終端ピン=カット最終フレーム(包含)
          if (currentFrame >= pins[i].start_frame && currentFrame <= pins[i + 1].start_frame) {
            const im = imgMap.current.get(pins[i].asset_id!)
            if (im && im.complete && im.naturalWidth) {
              const cs = Math.max(projW / im.naturalWidth, projH / im.naturalHeight)
              const dw = im.naturalWidth * cs, dh = im.naturalHeight * cs
              ctx.drawImage(im, (projW - dw) / 2, (projH - dh) / 2, dw, dh)
            }
            break
          }
        }
      }
    }
    // UI上で上にあるトラック(order小)ほど最前面 → 下から順に描き、最後に上を重ねる
    const vts = tracks.filter(t => t.track_type === 'video' && !t.hidden).sort((a, b) => b.order - a.order)
    for (const tr of vts) {
      if (previewHidden.includes(tr.id)) continue   // hidden in preview (not render)
      const clip = clips.filter(c => c.track_id === tr.id)
        .find(c => c.start_frame <= currentFrame && c.start_frame + c.duration_frames > currentFrame)
      if (!clip) continue
      const prog = (currentFrame - clip.start_frame) / Math.max(1, clip.duration_frames)
      const xf = evalTransform(clip.transform_json, prog, currentFrame)
      ctx.save()
      ctx.globalAlpha = (clip.opacity ?? 1) * (clip.asset_id == null ? 1 : xf.opacity)
      ctx.globalCompositeOperation = clip.blend === 'screen' ? 'screen'
        : clip.blend === 'add' ? 'lighter' : clip.blend === 'multiply' ? 'multiply' : 'source-over'
      if (clip.asset_id == null) {
        const el = parseElement(clip.transform_json)
        if (el) drawText(ctx, el, prog)
      } else {
        const asset = assets.find(a => a.id === clip.asset_id)
        const isImg = asset && (asset.asset_type === 'image' || (asset.asset_type === 'generated' && asset.duration_sec == null))
        if (isImg) {
          const im = imgMap.current.get(clip.asset_id)
          if (im && im.complete && im.naturalWidth) drawLayer(ctx, im, im.naturalWidth, im.naturalHeight, xf)
        } else {
          const v = videoRef.current
          const cache = videoCacheRef.current
          const holdFps = clip.posterize_fps ?? 0
          if (v && loadedAssetId === clip.asset_id && v.readyState >= 2 && !v.seeking) {
            if (holdFps > 0.5) {
              // 🎞 コマ打ち: 出力時間をホールド間隔で量子化し、区間が変わった時だけ取り込む
              const outSec = (currentFrame - clip.start_frame) / projectFps
              const slot = Math.floor(outSec * holdFps)
              const hc = holdCacheRef.current
              if (hc.clipId !== clip.id || hc.slot !== slot || !hc.canvas) {
                if (!hc.canvas) hc.canvas = document.createElement('canvas')
                hc.canvas.width = v.videoWidth; hc.canvas.height = v.videoHeight
                hc.canvas.getContext('2d')?.drawImage(v, 0, 0)
                hc.clipId = clip.id; hc.slot = slot
              }
              drawLayer(ctx, hc.canvas, hc.canvas.width, hc.canvas.height, xf)
            } else {
              drawLayer(ctx, v, v.videoWidth, v.videoHeight, xf)
            }
            // 最後に描いたライブフレームを常にキャッシュ(クリップ境界の切替中も
            // 下層素材へフォールスルーせず、直前フレームでホールドするため)
            if (!cache.canvas) cache.canvas = document.createElement('canvas')
            if (cache.canvas.width !== v.videoWidth || cache.canvas.height !== v.videoHeight) {
              cache.canvas.width = v.videoWidth; cache.canvas.height = v.videoHeight
            }
            cache.canvas.getContext('2d')?.drawImage(v, 0, 0)
            cache.assetId = clip.asset_id
          } else if (cache.canvas && cache.canvas.width) {
            // シーク中・ロード中・クリップ切替中は直前の確定フレームで埋める。
            // アセットが変わる境界でも下層(Video/Imageトラック)を一瞬見せない。
            drawLayer(ctx, cache.canvas, cache.canvas.width, cache.canvas.height, xf)
          }
        }
      }
      ctx.restore()
    }

    // Image(Ref)ピン選択中はその画像をcontainでフル表示(小サムネ確認の代替)。
    // 最後に選択したピンを優先。選択解除で通常の合成表示に戻る。
    if (refSel.length > 0) {
      const selClip = [...refSel].reverse()
        .map(id => clips.find(c => c.id === id))
        .find(c => c && c.asset_id != null)
      const im = selClip?.asset_id != null ? imgMap.current.get(selClip.asset_id) : undefined
      if (im && im.complete && im.naturalWidth) {
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, projW, projH)
        const cs = Math.min(projW / im.naturalWidth, projH / im.naturalHeight)
        const dw = im.naturalWidth * cs, dh = im.naturalHeight * cs
        ctx.drawImage(im, (projW - dw) / 2, (projH - dh) / 2, dw, dh)
      }
    }

    if (diffMode) applyDiffView(cv, ctx)
  }

  // 差分ビュー: comp を |cur - prev| に置換し、動き量(平均輝度差)を計測する
  const applyDiffView = (cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    const w = cv.width, h = cv.height
    const ensure = (ref: React.MutableRefObject<HTMLCanvasElement | null>, ww: number, hh: number) => {
      if (!ref.current) ref.current = document.createElement('canvas')
      if (ref.current.width !== ww || ref.current.height !== hh) { ref.current.width = ww; ref.current.height = hh }
      return ref.current
    }
    const tmp = ensure(diffTmpRef, w, h)
    const prev = ensure(prevFrameRef, w, h)
    // tmp ← 今フレーム(合成結果)
    const tctx = tmp.getContext('2d')!
    tctx.setTransform(1, 0, 0, 1, 0, 0)
    tctx.globalCompositeOperation = 'source-over'
    tctx.drawImage(cv, 0, 0)
    // comp ← |今 − 前| を増幅表示
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'difference'
    ctx.drawImage(prev, 0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
    ctx.save()
    ctx.filter = 'brightness(3.2) grayscale(0.2)'
    ctx.drawImage(cv, 0, 0)
    ctx.restore()
    // 動き量: 64x36に縮小した差分の平均輝度(0-100スケール)
    const m = ensure(measRef, 64, 36)
    const mctx = m.getContext('2d', { willReadFrequently: true })!
    mctx.filter = 'none'
    mctx.drawImage(cv, 0, 0, 64, 36)
    const d = mctx.getImageData(0, 0, 64, 36).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]
    const val = sum / (d.length / 4) / 3 / 255 * 100 / 3.2   // 増幅ぶんを戻す
    const hist = motionHistRef.current
    hist.push(val); if (hist.length > 240) hist.shift()
    if (motionTextRef.current) motionTextRef.current.textContent = val.toFixed(1)
    // スパークライン(直近240フレーム)
    const sp = sparkRef.current
    if (sp) {
      const sctx = sp.getContext('2d')!
      sctx.clearRect(0, 0, sp.width, sp.height)
      const vmax = Math.max(8, ...hist)
      sctx.strokeStyle = '#f0a8bc'; sctx.lineWidth = 1; sctx.beginPath()
      hist.forEach((v2, i) => {
        const x = (i / 239) * sp.width, y = sp.height - (v2 / vmax) * (sp.height - 2)
        i === 0 ? sctx.moveTo(x, y) : sctx.lineTo(x, y)
      })
      sctx.stroke()
    }
    // prev ← 今フレーム
    const pctx = prev.getContext('2d')!
    pctx.setTransform(1, 0, 0, 1, 0, 0)
    pctx.globalCompositeOperation = 'source-over'
    pctx.drawImage(tmp, 0, 0)
  }

  useEffect(() => { drawComposite() }, [currentFrame, clips, tracks, assets, loadedAssetId, projW, projH, redraw, previewHidden, lightPreview, diffMode, refSel])

  // Measure the fitted project-frame box (object-contain) for the frame guides
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ar = projW / projH
    const update = () => {
      const cw = el.clientWidth, ch = el.clientHeight
      let w = cw, h = cw / ar
      if (h > ch) { h = ch; w = ch * ar }
      setBox({ w: Math.round(w), h: Math.round(h) })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [projW, projH])

  const cycleGuide = () =>
    setGuideMode(m => (m === 'off' ? 'thirds' : m === 'thirds' ? 'safe' : 'off'))

  // ── Timeline master clock ─────────────────────────────────────────────
  // Wall-clock drives currentFrame; the <video>/<audio> elements follow it
  // (see the sync effects above). This survives clip changes mid-playback —
  // the old design derived the frame from video.currentTime, so when a new
  // clip's src loaded paused, playback froze on its first frame.
  const lastClipEnd = Math.max(0, ...clips.map(c => c.start_frame + c.duration_frames))
  const lastEndRef = useRef(lastClipEnd)
  lastEndRef.current = lastClipEnd

  useEffect(() => {
    if (!playing) return
    let raf: number
    let last = performance.now()
    let acc = 0   // fractional-frame accumulator
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * projectFps
      last = now
      const adv = Math.floor(acc)
      if (adv > 0) {
        acc -= adv
        const next = useTimelineStore.getState().currentFrame + adv
        if (next >= lastEndRef.current) {           // end of timeline → stop
          setCurrentFrame(Math.max(0, lastEndRef.current - 1))
          setPlaying(false)
          return
        }
        setCurrentFrame(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, projectFps])

  // Space: グローバル再生/停止(入力中は無効)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      unlockAudioPool()
      setPlaying(p => !p)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const togglePlay = () => { unlockAudioPool(); setPlaying(p => !p) }

  const goToStart = () => {
    setPlaying(false)
    setCurrentFrame(0)
  }

  // Extract the currently-previewed video frame and drop it on a Reference track
  // as an I2V keyframe (the playhead acts as the source-frame slider).
  const captureFrame = async () => {
    if (!activeProject || !activeClip || activeClip.asset_id == null || !isVideoAsset || capturing) return
    setCapturing(true)
    try {
      const t = videoRef.current?.currentTime ?? 0
      const img = await assetsApi.extractFrame(activeClip.asset_id, t)
      onAsset?.(img)
      await placeClip(activeProject.id, 'reference', img.id, Math.max(1, Math.round(projectFps * 0.5)), currentFrame)
    } catch { /* extraction failed */ } finally {
      setCapturing(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-black select-none">
      {/* Canvas area */}
      <div ref={canvasRef} className="flex-1 relative flex items-center justify-center min-h-0">
        {/* HTML5 video — hidden frame-source; the compositor draws its frame */}
        <video ref={videoRef} className="hidden" playsInline preload="auto" />

        {/* WYSIWYG compositor: all video tracks composited at the playhead
            (transforms / opacity / blend / text) so the timeline is what-you-see. */}
        <canvas ref={compRef} className="max-w-full max-h-full object-contain" />


        {/* Project frame boundary + design guides (overlaid on the fitted frame) */}
        {box.w > 1 && (
          <div
            className="absolute pointer-events-none border border-white/25"
            style={{ width: box.w, height: box.h, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
          >
            {guideMode === 'thirds' && (
              <>
                <div className="absolute top-0 bottom-0 bg-white/20" style={{ left: '33.333%', width: 1 }} />
                <div className="absolute top-0 bottom-0 bg-white/20" style={{ left: '66.666%', width: 1 }} />
                <div className="absolute left-0 right-0 bg-white/20" style={{ top: '33.333%', height: 1 }} />
                <div className="absolute left-0 right-0 bg-white/20" style={{ top: '66.666%', height: 1 }} />
                <div className="absolute top-0 bottom-0 bg-white/30" style={{ left: '50%', width: 1 }} />
                <div className="absolute left-0 right-0 bg-white/30" style={{ top: '50%', height: 1 }} />
              </>
            )}
            {guideMode === 'safe' && (
              <>
                {/* action-safe ~93% / title-safe ~90% */}
                <div className="absolute border border-white/25" style={{ inset: '3.5%' }} />
                <div className="absolute border border-amber-400/40" style={{ inset: '5%' }} />
              </>
            )}
          </div>
        )}

        {/* Empty state */}
        {!activeClip && (
          <span className="text-zinc-700 text-sm">再生ヘッドにクリップがありません</span>
        )}

        {/* Timecode overlay */}
        {/* 読み込み状態バッジ: 無音/黒画面がロード中かどうかを見分ける */}
        {(videoBuffering || audioBuffering) && (
          <div className="absolute top-2 left-2 flex gap-1.5 pointer-events-none">
            {videoBuffering && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-sky-300 animate-pulse">⏳ 映像読込中</span>
            )}
            {audioBuffering && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-emerald-300 animate-pulse">🎵 音声読込中</span>
            )}
          </div>
        )}
        <div className="absolute bottom-2 right-2 font-mono text-[10px] text-white/50 bg-black/40 px-1.5 py-0.5 rounded pointer-events-none">
          {String(Math.floor(currentFrame / projectFps / 60)).padStart(2, '0')}:
          {String(Math.floor(currentFrame / projectFps) % 60).padStart(2, '0')}:
          {String(currentFrame % projectFps).padStart(2, '0')}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-t border-zinc-800 flex-shrink-0 max-sm:overflow-x-auto max-sm:px-2 max-sm:[&>button]:flex-shrink-0 max-sm:[&>button]:whitespace-nowrap max-sm:[&>button]:py-1.5 max-sm:[&>span]:flex-shrink-0">
        <button
          onClick={goToStart}
          className="text-zinc-400 hover:text-white text-sm w-6 text-center"
          title="先頭へ"
        >⏮</button>
        <button
          onClick={togglePlay}
          className="text-white hover:text-purple-300 text-base w-7 text-center"
          title={playing ? '一時停止 (Space)' : '再生 (Space)'}
        >
          {playing ? '⏸' : '▶'}
        </button>

        {activeAsset && (
          <span className="text-zinc-500 text-[10px] truncate ml-2 max-w-[120px]">
            {activeAsset.name}
          </span>
        )}

        {isVideoAsset && (
          <button
            onClick={captureFrame}
            disabled={capturing}
            className="ml-2 text-[10px] px-2 py-0.5 rounded bg-amber-800 hover:bg-amber-700 text-amber-100 disabled:opacity-40"
            title="現在のフレームを抽出してRef（I2Vキーフレーム）に追加"
          >{capturing ? '抽出中…' : '📷 キーフレーム化'}</button>
        )}

        <button
          onClick={() => { setDiffMode(v => !v); motionHistRef.current = [] }}
          className={`text-[10px] px-2 py-0.5 rounded ${diffMode ? 'bg-rose-900 text-rose-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
          title="差分再生: フレーム間差分を表示し画面全体の動き量を数値化（カット=スパイク/カメラ=持続山）"
        >🔍 差分</button>
        {diffMode && (
          <span className="flex items-center gap-1 text-[10px] text-rose-200 bg-zinc-900 rounded px-1.5 py-0.5">
            動き <span ref={motionTextRef} className="font-mono w-9 text-right">0.0</span>
            <canvas ref={sparkRef} width={120} height={18} className="rounded bg-zinc-950" />
          </span>
        )}

        <button
          onClick={async () => {
            const cv = compRef.current
            if (!cv) return
            const blob: Blob | null = await new Promise(res => cv.toBlob(res, 'image/png'))
            if (!blob) return
            try {
              // secure context(https/localhost)ではクリップボードへ直接コピー
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
              useUIStore.getState().pushToast('現在フレームをクリップボードにコピーしました', 'success')
            } catch {
              // Tailscale等のhttpアクセスではclipboard APIが使えない → 新規タブで開いて長押し/右クリックコピー
              const url = URL.createObjectURL(blob)
              window.open(url, '_blank')
              useUIStore.getState().pushToast('この環境は直接コピー不可のため画像を開きました(長押し/右クリックでコピー)', 'info')
            }
          }}
          className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
          title="現在の合成フレームを画像としてクリップボードへコピー"
        >📋 コピー</button>

        <button
          onClick={() => setLightPreview(v => !v)}
          className={`ml-auto text-[10px] px-2 py-0.5 rounded ${lightPreview ? 'bg-emerald-800 text-emerald-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
          title="軽量プレビュー: 描画解像度を下げて動作を軽く（書き出し画質は不変）"
        >⚡ {lightPreview ? '軽量' : '高画質'}</button>

        <button
          onClick={cycleGuide}
          className={`text-[10px] px-2 py-0.5 rounded ${guideMode !== 'off' ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
          title="フレーム枠ガイド: なし → 三分割 → セーフエリア"
        >⊞ {guideMode === 'off' ? 'ガイド' : guideMode === 'thirds' ? '三分割' : 'セーフ'}</button>

        <span className="text-[10px] text-zinc-600 max-sm:hidden">
          {projW}×{projH}
        </span>
      </div>
    </div>
  )
}
