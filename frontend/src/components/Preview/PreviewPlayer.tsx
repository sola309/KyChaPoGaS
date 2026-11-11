import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

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
import { parseRemapKeys, remapSrcFrame } from '../Timeline/remap'
import { parsePreviz, drawPrevizBase, drawPrevizFx, type Previz } from '../Timeline/previz'
import { useAnalysisStore } from '../../store/analysisStore'
import { isFilterClip, filterValueAt, solidColor } from '../Timeline/filterLayers'
import { isSatsueiClip, resolveLayer, layerSpecOf, satsueiOf, type SatsueiParams } from './satsueiLook'
import { SatsueiRenderer } from './satsueiGL'
import { getSatsueiCompare, subscribeSatsueiCompare } from './satsueiCompare'
import { isCreditClip, creditOf, frameScalars } from './creditLook'
import { CreditRenderer } from './creditGL'
import { creditMapsFor, prefetchCreditMaps, subscribeCreditMaps, loadCreditMeta, pruneCreditClips } from './creditFields'
import { creditPanelClipId, subscribeCreditUi, CREDIT_DEBUG, installCreditDebug, creditDebugState, takeCreditSnapshot } from './creditUi'
import { CreditOverlay } from './CreditOverlay'
import './creditDebug'
import { CAPTURE, captureState } from '../../capture'
import { RingOverlay, RingToggleButton } from './RingTool'
import { FrameJump, VolumeControl } from './PlayheadControls'

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

/** クリップ内の出力フレーム rel に対応する素材時刻(秒)。本体<video>と同じ規則:
 *  時間リマップ(remap_json) > 速度カーブ(speed_ease) > 一定速度(speed)。 */
function clipAssetTime(clip: { start_frame: number; asset_in_frame: number; speed: number; duration_frames: number
                               remap_json?: string | null; speed_ease?: string | null },
                       rel: number, projectFps: number): number {
  const sp = clip.speed > 0 ? clip.speed : 1
  const rk = parseRemapKeys(clip.remap_json ?? undefined, clip.duration_frames, clip.asset_in_frame)
  if (rk) return remapSrcFrame(rk, rel, projectFps) / projectFps
  const curve = parseSpeedCurve(clip.speed_ease ?? undefined)
  const consumed = curve
    ? clip.duration_frames * sp * curveIntegralAt(curve, rel / Math.max(1, clip.duration_frames))
    : rel * sp
  return (clip.asset_in_frame + consumed) / projectFps
}

/** クリップ内の出力フレーム rel での瞬間再生速度(素材秒/出力秒)。clipAssetTime と同じ規則。
 *  時間リマップ中はその区間の傾き(0=静止, 負=逆再生)。コマ打ち区間は NaN(=コマ単位シークで見せる)。 */
function clipRateAt(clip: { asset_in_frame: number; speed: number; duration_frames: number
                            remap_json?: string | null; speed_ease?: string | null },
                    rel: number, projectFps: number): number {
  const rk = parseRemapKeys(clip.remap_json ?? undefined, clip.duration_frames, clip.asset_in_frame)
  if (rk) {
    let i = 0
    while (i < rk.length - 2 && rel >= rk[i + 1].t) i++
    const k0 = rk[i], k1 = rk[i + 1]
    const hold = k0.hold ?? 0
    if (hold > 0.5 && hold < projectFps) return NaN
    return (k1.src - k0.src) / Math.max(1e-6, k1.t - k0.t)
  }
  const sp = clip.speed > 0 ? clip.speed : 1
  const curve = parseSpeedCurve(clip.speed_ease ?? undefined)
  return curve ? sp * curveRelAt(curve, rel / Math.max(1, clip.duration_frames)) : sp
}

/**
 * <video> をタイムラインの時計(マスター)に追従させる(2026-09-23 一元化)。
 * 再生中は playbackRate をクリップの瞬間速度に合わせ、残ったずれは速度の微調整で
 * 吸収する。強制シークは大きくずれた時だけ(毎回シークするとデコードのやり直しで重く、
 * 速度が合っていないと先行→引き戻しが「巻き戻り」に見えていた)。
 * 停止中や、再生できない速度(静止・逆再生・16倍超・コマ打ち)はコマ単位でシークする。
 */
function syncVideoEl(v: HTMLVideoElement, target: number, rate: number, playing: boolean, fps: number) {
  const t = Math.max(0, target)
  if (!playing || !(rate >= 0.0625 && rate <= 16)) {
    if (!v.paused) v.pause()
    const tt = t + 1e-4                                   // 境界丸め回避の微小オフセット
    if (!v.seeking && Math.abs(v.currentTime - tt) > 0.5 / fps) v.currentTime = tt
    return
  }
  const drift = t - v.currentTime                         // +: 映像が遅れている(素材秒)
  const hardLimit = 0.35 * Math.max(1, rate)              // 出力時間で約0.35秒ぶん
  if (Math.abs(drift) > hardLimit) {
    if (!v.seeking) v.currentTime = t
  } else {
    const adj = Math.max(-0.4 * rate, Math.min(0.4 * rate, drift * 2))   // 約0.5秒で解消
    const want = Math.max(0.0625, Math.min(16, rate + adj))
    if (Math.abs(v.playbackRate - want) > 0.01) v.playbackRate = want
  }
  if (v.paused) v.play().catch(() => {})
}

/**
 * 比較表示など「複数の映像レイヤーを同時に見せる」ときの追加<video>。
 * プレビュー本体は<video>を1つしか持たないため、そのままだと2枚目以降の
 * レイヤーが1枚目の直前フレームで埋められ、左右とも同じ絵になってしまう。
 * トラック1本につき1要素を持たせ、drawComposite から直接読む。
 */
function LayerVideo({ trackId, clip, proxy, projectFps, currentFrame, playing, reg, onFrame }: {
  trackId: number
  clip: { asset_id: number | null; start_frame: number; asset_in_frame: number; speed: number
          duration_frames: number; remap_json?: string | null; speed_ease?: string | null } | null
  proxy: boolean
  projectFps: number
  currentFrame: number
  playing: boolean
  reg: (trackId: number, el: HTMLVideoElement | null) => void
  onFrame: () => void
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const src = clip?.asset_id != null ? assetsApi.fileUrl(clip.asset_id, proxy) : ''

  useEffect(() => {
    reg(trackId, ref.current)
    return () => reg(trackId, null)
  }, [trackId, reg])

  useEffect(() => {
    const v = ref.current
    if (!v || !src) return
    if (v.getAttribute('src') !== src) { v.setAttribute('src', src); v.load() }
  }, [src])

  // タイムラインの時計に追従(本体の<video>と同じ規則: 速度・速度カーブ・リマップの傾きを反映)。
  // 以前は playbackRate を設定せず常に1倍で再生していたため、速度≠1のクリップは
  // 0.25秒ずれるたびに強制シークされ、比較表示が同期せず重かった。
  // クリップ開始前(先読み中)は頭のコマで待機する。
  useEffect(() => {
    const v = ref.current
    if (!v || !clip) return
    const rel = currentFrame - clip.start_frame
    syncVideoEl(v, clipAssetTime(clip, rel, projectFps), clipRateAt(clip, Math.max(0, rel), projectFps),
                playing && rel >= 0, projectFps)
  }, [currentFrame, playing, clip, projectFps])

  useEffect(() => {
    const v = ref.current
    if (!v) return
    const bump = () => onFrame()
    for (const ev of ['seeked', 'loadeddata', 'canplay']) v.addEventListener(ev, bump)
    return () => { for (const ev of ['seeked', 'loadeddata', 'canplay']) v.removeEventListener(ev, bump) }
  }, [onFrame])

  return <video ref={ref} muted playsInline preload="auto" className="hidden" />
}

export function PreviewPlayer({ assets, onAsset }: Props) {
  // useShallow: 使う項目だけ購読。ストア全体を購読すると clipBuffered(0.5秒毎)や
  // 選択/Undoスタックの更新でもプレビュー全体が再描画される。
  const { tracks, clips, currentFrame, projectFps, setCurrentFrame, placeClip, previewHidden } = useTimelineStore(
    useShallow(s => ({
      tracks: s.tracks, clips: s.clips, currentFrame: s.currentFrame, projectFps: s.projectFps,
      setCurrentFrame: s.setCurrentFrame, placeClip: s.placeClip, previewHidden: s.previewHidden,
    })))
  const { activeProject } = useProjectStore()
  const videoRef  = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [loadedAssetId, setLoadedAssetId] = useState<number | null>(null)
  // 高画質Blob到着時にsrc選択effectを再評価させるカウンタ(再生中の画質アップグレード用)
  const [vidTierBump, setVidTierBump] = useState(0)
  const [videoBuffering, setVideoBuffering] = useState(false)
  const [audioBuffering, setAudioBuffering] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const compRef = useRef<HTMLCanvasElement>(null)        // WYSIWYG compositor
  // 合成用画像の2層キャッシュ: preview(640px JPEG)とfull(原本)。
  // 高画質切替時はpreviewを表示したままfullを段階的に読み込む(全消去→再読込だと
  // ピン100枚規模でフルPNG計100MB超の読み直しになり数分固まるため)。
  const imgMapPreview = useRef<Map<number, HTMLImageElement>>(new Map())
  const imgMapFull = useRef<Map<number, HTMLImageElement>>(new Map())
  const lightPreviewRef = useRef(true)
  const refSel = useTimelineStore(s => s.refSel)         // 選択中のImage(Ref)ピン
  const [redraw, setRedraw] = useState(0)                // bumped when an image loads
  // 直前に確定した動画フレームのキャッシュ。シーク中(readyState低下)に黒フレームを
  // 出さず、前のフレームを描き続けるために使う(シーク完了ごとに更新)。
  const videoCacheRef = useRef<{ canvas: HTMLCanvasElement | null; assetId: number | null }>({ canvas: null, assetId: null })
  // 境界フリーズ: 主<video>が次クリップを読み込む間、最後に完成した合成フレーム全体で
  // 画面を固める。レイヤー単位の穴埋め(直前クリップのキャッシュ等)は「別の位置の絵」が
  // 一瞬混ざる事故を起こすため、フレーム全体を凍らせるのが唯一安全。
  const lastGoodRef = useRef<{ canvas: HTMLCanvasElement | null } >({ canvas: null })
  const frozeRef = useRef(false)          // 直近のdrawがフリーズ経路だったか(保存の抑止)

  // 比較表示中か(映像トラックのどれかに配置指定がある)。ONの間だけレイヤーごとに
  // <video>を用意する — 常時やるとデコード本数が増えて重くなるため。
  const bumpRedraw = useRef(() => setRedraw(n => n + 1)).current
  const compareMode = tracks.some(t => t.track_type === 'video' && (t.layout_json ?? '') !== '')
  // 比較表示を切り替えたら保持フレームは捨てる(古い再生位置の絵が一瞬出るのを防ぐ)
  useEffect(() => { layerCacheRef.current.clear() }, [compareMode])
  // 表示範囲(比率 0..1)。比較表示ではレイヤー配置の外接矩形だけを見せる — 左右に並べると
  // 16:9 の出力の上下に黒帯が出るが、プレビューでは帯の分だけ絵が小さくなるので切り落とす。
  // 書き出し(16:9)は変えない。canvas は全画面のまま描き、表示側で切り抜く。
  const view = useMemo(() => {
    const full = { x: 0, y: 0, w: 1, h: 1 }
    if (!compareMode) return full
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0
    for (const t of tracks) {
      if (t.track_type !== 'video' || t.hidden || !(t.layout_json ?? '').trim()) continue
      try {
        const d = JSON.parse(t.layout_json!) as { x?: number; y?: number; w?: number; h?: number }
        const x = d.x ?? 0, y = d.y ?? 0, w = d.w ?? 1, h = d.h ?? 1
        if (w < 0.05 || h < 0.05) continue       // 実質非表示の配置(比較の対象外)
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h)
      } catch { /* 壊れた配置は無視 */ }
    }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1)
    return x1 - x0 > 0.05 && y1 - y0 > 0.05 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : full
  }, [compareMode, tracks])
  const layerVidsRef = useRef<Map<number, HTMLVideoElement>>(new Map())
  // レイヤーごとの直前確定フレーム(読み込み中の黒点滅を防ぐ)
  const layerCacheRef = useRef<Map<number, HTMLCanvasElement>>(new Map())
  const regLayerVid = useRef((trackId: number, el: HTMLVideoElement | null) => {
    if (el) layerVidsRef.current.set(trackId, el)
    else layerVidsRef.current.delete(trackId)
  }).current
  // コマ打ちプレビュー: スロット(=ホールド区間)が変わった時だけビデオフレームを取り込む
  const holdCacheRef = useRef<{ clipId: number | null; slot: number; canvas: HTMLCanvasElement | null }>({ clipId: null, slot: -1, canvas: null })
  // クロス遷移(overlay同士)用: トラックごとに直前クリップの最終ライブフレームを保持(2026-09-19)
  const trackLastRef = useRef<Map<number, { clipId: number; canvas: HTMLCanvasElement }>>(new Map())
  // クロス遷移で直前クリップ素材の「続き」を読むための補助<video>(トラックごと)。
  // ホールドフレームが無い(境界へ直接シークした)場合でも、レンダラーと同じ絵を敷ける。
  const crossVidsRef = useRef<Map<number, HTMLVideoElement>>(new Map())
  const [box, setBox] = useState({ w: 0, h: 0 })   // fitted project-frame box (px)
  const [guideMode, setGuideMode] = useState<'off' | 'thirds' | 'safe'>('off')
  // 撮影パス(共通グレード)のプレビュー近似。書き出しの _GRADE_CHAINS "film"
  // (前ぼかし→黒締め→弱ビネット→グレイン)をCSSで模す。完全一致は書き出しのみだが、
  // 「グレード無しの絵で合否判定してしまう」ズレを消すため既定ON。
  const [gradeOn, setGradeOn] = useState(() => localStorage.getItem('kychapogas:grade') !== 'off')
  // 🎤歌詞オーバーレイ。設計の確認時に使い、撮影確認のときは切る
  const [showLyrics, setShowLyrics] = useState(() => localStorage.getItem('kychapogas:lyrics') === 'on')
  useEffect(() => { localStorage.setItem('kychapogas:grade', gradeOn ? 'film' : 'off') }, [gradeOn])
  // 🔊 プレビューの音量(このブラウザだけ。書き出しの音は変わらない)。0〜1
  const [previewVolume, setPreviewVolume] = useState(() => {
    try {
      const raw = localStorage.getItem('kychapogas:previewVolume')
      const v = raw === null ? 1 : Number(raw)
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
    } catch { return 1 }
  })
  const [previewMuted, setPreviewMuted] = useState(() => {
    try { return localStorage.getItem('kychapogas:previewMuted') === '1' } catch { return false }
  })
  useEffect(() => {
    try {
      localStorage.setItem('kychapogas:previewVolume', String(previewVolume))
      localStorage.setItem('kychapogas:previewMuted', previewMuted ? '1' : '0')
    } catch { /* noop */ }
  }, [previewVolume, previewMuted])
  const [lightPreview, setLightPreview] = useState(true)   // cap backing-store res
  // 🎞プレビズ: ベース映像の代わりに、カットごとの previz 設定(移動/フラッシュ/暗転)を
  // 手続きノイズで描く。絵柄が無くても動きのリズムを試行錯誤するためのモード。
  // 完全にフロントエンドの描画なので、生成キューにもレンダーにも影響しない。
  const [previzMode, setPrevizMode] = useState(false)
  const beatsMap = useAnalysisStore(s => s.beats)
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

  // 現在再生位置のカット番号(CutLaneと同じペアリングから導出 — 表示の唯一のソース)。
  // 歌詞もここで一緒に拾う(ピンのattrs_jsonが唯一の正。字幕は別データを持たない)。
  const currentCut = useMemo(() => {
    const imgTrack = tracks.find(t => t.track_type === 'reference' && t.name === 'Image' && !t.hidden)
    if (!imgTrack) return null
    const pins = clips.filter(c => c.track_id === imgTrack.id && c.asset_id != null)
      .sort((a, b) => a.start_frame - b.start_frame)
    for (let i = 0; i + 1 < pins.length; i += 2) {
      if (pins[i].start_frame <= currentFrame && currentFrame <= pins[i + 1].start_frame) {
        let lyrics = ''
        try {
          const a = pins[i].attrs_json ? JSON.parse(pins[i].attrs_json) : {}
          lyrics = String(a?.scene?.board?.lyrics ?? '')
        } catch { /* 壊れたattrsは空扱い */ }
        return { n: i / 2 + 1, s: pins[i].start_frame, e: pins[i + 1].start_frame, lyrics }
      }
    }
    return null
  }, [tracks, clips, currentFrame])

  // ベースレイヤー選択: 「再生ヘッドにクリップがある」最上位のVideoトラックを使う。
  // 最上段が空白の区間は透明扱いで下のトラックへフォールスルーする(黒塗りにしない)。
  const activeClip = useMemo(() => {
    const vTracks = [...tracks]
      .sort((a, b) => a.order - b.order)
      .filter(t => t.track_type === 'video' && !t.hidden)
    for (const t of vTracks) {
      // asset_id が null の「空枠」(scenes-sync が敷くカット台座)は飛ばす。
      // ここで空枠を拾うと主<video>が解放され、後ろのトラックの実素材が
      // 再生されなくなる。空枠は描画上も存在しない扱いが正しい。
      // 🌧 雨クリップ(黒地の雨の層を screen で重ねる)は本体<video>に載せない。本体は下の絵(Shots)を
      // 担当し続け、雨の層は専用の<video>(下の LayerVideo、-clip.id)で描く
      const hit = clips
        .filter(c => c.track_id === t.id && c.asset_id != null && c.kind !== 'rain')
        .find(c => c.start_frame <= currentFrame && c.start_frame + c.duration_frames > currentFrame)
      if (hit) return hit
    }
    return null
  }, [tracks, clips, currentFrame])
  const activeAsset = activeClip?.asset_id != null
    ? assets.find(a => a.id === activeClip.asset_id)
    : null

  // "generated" covers both images and videos — disambiguate by duration.
  const isVideoAsset = activeAsset?.asset_type === 'video'
    || (activeAsset?.asset_type === 'generated' && activeAsset?.duration_sec != null)

  // 再生ヘッドに重なる全Audioクリップ(全トラック分をミックス再生する)
  const activeAudioClips = useMemo(() => {
    const audioTracks = new Set(tracks.filter(t => t.track_type === 'audio' && !t.hidden).map(t => t.id))
    return clips.filter(c => audioTracks.has(c.track_id) && c.asset_id != null
      && c.start_frame <= currentFrame && c.start_frame + c.duration_frames > currentFrame)
  }, [tracks, clips, currentFrame])

  // Load video when the asset changes — prefer the low-res proxy for light preview
  useEffect(() => {
    const video = videoRef.current
    if (!video || CAPTURE) return          // 🎥 撮影用: 動画は読み込まない(絵は撮影側が差し込む)
    if (!activeClip || activeClip.asset_id == null) {
      video.src = ''
      setLoadedAssetId(null)
      return
    }
    // 軽量: プロキシBlob→プロキシURL。
    // 高画質: 原本Blob→(未ロードなら)軽量Blob/プロキシで先に再生し、原本が届き次第
    //         再生位置を保ったまま差し替える(vidTierBumpで再実行される)。
    const full = vidBlobFullRef.current.get(activeClip.asset_id)
    const light = vidBlobRef.current.get(activeClip.asset_id)
    const direct = assetsApi.fileUrl(activeClip.asset_id, !!activeAsset?.proxy_path)
    // 80MB超の原本は Blob 先読みの対象外(下の先読み処理と同じ閾値)。高画質モードでは
    // 原本URLを直接 <video> に渡して Range ストリーミングで再生する。
    // 以前は「fullBlobが無ければ軽量Blob」に落ちていたため、大きい原本(例: 24fps化した
    // 1080p 116MB)は高画質を選んでもプロキシのままだった(2026-09-08 ユーザー指摘)。
    const tooBigForBlob = (activeAsset?.file_size_bytes ?? 0) > 80e6
    const directFull = assetsApi.fileUrl(activeClip.asset_id, false)
    const sameAsset = loadedAssetId === activeClip.asset_id
    const cur = video.getAttribute('src') ?? ''
    let url = lightPreview
      ? (light?.url ?? direct)
      : (full?.url ?? (tooBigForBlob ? directFull : (light?.url ?? direct)))
    // 貼り替えは「原本(Blob または直接URL)への昇格」のときだけにする。
    // プロキシURL→軽量Blob は中身が同じなのに load() をやり直すことになり、
    // 他アセットのBlob到着(vidTierBump)のたびに読み込みが振り出しに戻って、
    // いつまでも再生可能にならないことがあった(=二重・三重読み込み)。
    // 例外: アセット一覧が届く前に原本URLで始まってしまった軽量モードは、プロキシへ降格を許す
    //       (届く前は proxy_path が分からず direct が原本になる。放置すると軽量モードで原本を流し続ける)
    const startedOnOriginal = lightPreview && cur === directFull && url !== directFull
    if (sameAsset && cur && url !== full?.url && url !== directFull && !startedOnOriginal) url = cur
    if (video.getAttribute('src') !== url) {
      // 同一アセット内の画質アップグレードは再生位置・再生状態を引き継ぐ
      const sameAsset = loadedAssetId === activeClip.asset_id
      const t = sameAsset ? video.currentTime : 0
      const wasPlaying = sameAsset && !video.paused
      video.src = url
      video.load()
      if (sameAsset && t > 0) video.currentTime = t
      if (wasPlaying) video.play().catch(() => {})
      setLoadedAssetId(activeClip.asset_id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClip?.asset_id, activeAsset?.proxy_path, lightPreview, vidTierBump])

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

  // Keep the main <video> in sync with the playhead (timeline clock is the MASTER).
  // 速度・速度カーブ・時間リマップはすべて clipRateAt/clipAssetTime で解釈し、
  // syncVideoEl が playbackRate の追従とずれ補正を行う(2026-09-23: 以前は
  // playbackRate がリマップを無視しており、C6 などで先行→引き戻しの巻き戻りが出ていた)。
  // 比較表示中はレイヤーごとの<video>が描画を担当するので、本体は止めて二重デコードを避ける。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!activeClip || !isVideoAsset || compareMode) {
      if (!video.paused) video.pause()
      return
    }
    const rel = currentFrame - activeClip.start_frame
    syncVideoEl(video, clipAssetTime(activeClip, rel, projectFps), clipRateAt(activeClip, rel, projectFps),
                playing, projectFps)
  }, [currentFrame, playing, activeClip, projectFps, loadedAssetId, isVideoAsset, compareMode])

  // 音声はWebAudioミキサー方式: 重なる全Audioトラックのクリップを同時にミックス再生。
  // wav(PCM)は再生位置優先の窓方式ストリーミング(10秒セグメントをRange取得して自前デコード)。
  // その他形式(mp3/m4a等)は従来どおり全体デコードにフォールバック。
  // AudioBufferSourceNodeは自走クロックなので、rAF側とのずれは閾値超過時のみ張り直す。
  const audioCtxRef = useRef<AudioContext | null>(null)
  const audioBufCacheRef = useRef<Map<number, { buf: AudioBuffer | null, promise: Promise<AudioBuffer | null> }>>(new Map())
  const wavMetaRef = useRef<Map<number, WavMeta | null>>(new Map())   // null = wavではない(要フォールバック)
  const wavHeaderPendingRef = useRef<Set<number>>(new Set())
  const audioSrcRef = useRef<Map<number, PlayEntry>>(new Map())
  // 全クリップの GainNode はこのマスターを通して出す(🔊 プレビューの音量)
  const masterGainRef = useRef<GainNode | null>(null)
  const masterLevelRef = useRef(1)
  const masterOut = (ctx: AudioContext) => {
    let g = masterGainRef.current
    if (!g || g.context !== ctx) {
      g = ctx.createGain()
      g.gain.value = masterLevelRef.current
      g.connect(ctx.destination)
      masterGainRef.current = g
    }
    return g
  }
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
      // デコード中の本数を種別ごとに数える。
      // プロキシ(m4a 数MB)は軽いので**並列で取る** — 本作は音源4本(原音/歌唱/伴奏/クリック)
      // あり、1本ずつ直列にすると400msのポーリング間隔ぶんの空白が毎回入って
      // 「音の読み込み開始が遅い」体感になっていた(実測: 原本67MBに対しプロキシ3.1MB)。
      // 一方、原本の全体デコード(数十MB)は帯域を食うので従来どおり1本に絞る。
      const PROXY_PARALLEL = 4
      const inflight = [...audioBufCacheRef.current.entries()].filter(([, e]) => !e.buf)
      let proxyInflight = inflight.filter(([k]) => hasAudioProxy(k)).length
      let rawFullInflight = inflight.length - proxyInflight
      for (const c of audible) {
        if (rawInflightRef.current >= RAW_INFLIGHT_MAX) return
        const aid = c.asset_id!
        if (hasAudioProxy(aid)) {
          if (!audioBufCacheRef.current.has(aid) && proxyInflight < PROXY_PARALLEL) {
            loadAudioBuffer(aid, true)
            proxyInflight++
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
          // wav以外は全体デコードを先行して温めておく(重いので1本ずつ)
          if (pri(c) === 0 && rawFullInflight === 0 && !audioBufCacheRef.current.has(aid)) {
            loadAudioBuffer(aid)
            rawFullInflight++
          }
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
    // 初回tickはマウント直後に走るが、その時点ではまだclips/tracksがAPIから
    // 届いておらず audible が空 → 次の400msまで何も始まらない。素材が揃うまでは
    // 50msで様子を見て、揃った瞬間に読み込みを開始する(音の出だしの待ち時間対策)。
    // 音声トラックが無いプロジェクトでは永遠に回ってしまうため、5秒で打ち切る。
    const fastStart = performance.now()
    const fast = setInterval(() => {
      if (document.hidden) return
      const { clips: cs, tracks: ts } = useTimelineStore.getState()
      const audioTrack = new Set(ts.filter(t => t.track_type === 'audio').map(t => t.id))
      const ready = cs.some(c => c.asset_id != null && audioTrack.has(c.track_id))
      if (ready) { clearInterval(fast); tick(); return }
      if (performance.now() - fastStart > 5000) clearInterval(fast)
    }, 50)
    return () => { clearInterval(iv); clearInterval(fast) }
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
        gain.connect(masterOut(ctx))
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

  // 🔊 プレビューの音量: WebAudio のマスターと、<video> の内蔵音声の両方に効かせる
  useEffect(() => {
    const level = previewMuted ? 0 : previewVolume
    masterLevelRef.current = level
    const g = masterGainRef.current
    if (g) g.gain.setTargetAtTime(level, g.context.currentTime, 0.02)
    const v = videoRef.current
    if (v) v.volume = Math.min(1, Math.max(0, level))
  }, [previewVolume, previewMuted])

  // Audioトラックが鳴っている間はVideoの内蔵音声をミュート(二重再生防止)
  useEffect(() => {
    const v = videoRef.current
    // 🔊 ミュート・音量 0 も .muted で(iOS Safari は .volume を無視する)
    if (v) v.muted = activeAudioClips.length > 0 || previewMuted || previewVolume === 0
  }, [activeAudioClips.length, previewMuted, previewVolume])

  useEffect(() => () => {
    for (const id of [...audioSrcRef.current.keys()]) {
      const e = audioSrcRef.current.get(id)
      audioSrcRef.current.delete(id)
      try { e?.full?.stop() } catch { /* noop */ }
      for (const s of e?.segSrcs.values() ?? []) { try { s.stop() } catch { /* noop */ } }
    }
    audioCtxRef.current?.close().catch(() => {})
    masterGainRef.current = null
  }, [])

  // クリップごとの読み込み済み範囲を集計してストアへ(タイムラインのバッファバー用)。
  // audio=wavセグメント/全体デコードの状態、video=プレビュー中素材のbuffered。
  const setClipBuffered = useTimelineStore(s => s.setClipBuffered)
  const setClipBufferedHQ = useTimelineStore(s => s.setClipBufferedHQ)
  const lastBufJsonRef = useRef('')
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.hidden) return
      const { clips: cs, tracks: ts, projectFps: fps } = useTimelineStore.getState()
      const m: Record<number, [number, number][]> = {}
      const mh: Record<number, [number, number][]> = {}
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
          // 動画: メモリ(Blob)キャッシュ済み=全区間、取得中=進捗。
          // レイヤーの上下や再生位置に関係なく「メモリに載っているか」を常時表示する。
          if (vidBlobRef.current.has(c.asset_id)) {
            ranges.push([0, 1])
          } else {
            const pr = vidProgRef.current.get(c.asset_id)
            if (pr) ranges.push([0, pr])
            else {
              const v = videoRef.current
              if (v && loadedAssetId === c.asset_id) {
                for (let i = 0; i < v.buffered.length; i++) {
                  const s = v.buffered.start(i)
                  const e = v.buffered.end(i)
                  if (e > a0 && s < a1) ranges.push([Math.max(0, (s - a0) / span), Math.min(1, (e - a0) / span)])
                }
              }
            }
          }
          // 高画質(原本)層 → 別色バー
          if (vidBlobFullRef.current.has(c.asset_id)) mh[c.id] = [[0, 1]]
          else {
            const pf = vidProgFullRef.current.get(c.asset_id)
            if (pf) mh[c.id] = [[0, Math.round(pf * 200) / 200]]
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
      const j = JSON.stringify(m) + '|' + JSON.stringify(mh)
      if (j !== lastBufJsonRef.current) {
        lastBufJsonRef.current = j
        setClipBuffered(m)
        setClipBufferedHQ(mh)
      }
    }, 500)
    return () => clearInterval(iv)
  }, [loadedAssetId, setClipBuffered, setClipBufferedHQ])

  // ── タイムライン最優先の動画ローダ ──────────────────────────────────
  // タイムライン上の動画(プロキシ優先)を再生ヘッド近傍から順にBlobへ先読みし、
  // メモリに保持する。クリップの差し替え/移動で優先度は自動で追従し、
  // タイムラインから消えたアセットのキャッシュ(動画/音声/画像)は即解放する。
  // バッファバーは「メモリに載っているか」を常時反映(レイヤー位置と無関係)。
  const vidBlobRef = useRef<Map<number, { url: string; bytes: number }>>(new Map())
  const vidProgRef = useRef<Map<number, number>>(new Map())
  const vidFetchingRef = useRef<Set<number>>(new Set())
  // 高画質(原本)の第2層Blob: 軽量層が読み切れてから段階取得。バーは別色で表示
  const vidBlobFullRef = useRef<Map<number, { url: string; bytes: number }>>(new Map())
  const vidProgFullRef = useRef<Map<number, number>>(new Map())
  const VID_CACHE_MAX = 400e6   // Blob合計の上限(超過時は再生ヘッドから遠い順に破棄)
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.hidden || CAPTURE) return
      const { clips: cs, tracks: ts, currentFrame: f } = useTimelineStore.getState()
      const all = assetsRef.current

      // タイムラインに存在するアセット集合(非表示トラック含む=消えた時だけ解放)
      const onTimeline = new Set(cs.map(c => c.asset_id).filter((x): x is number => x != null))
      for (const [aid, e] of [...vidBlobRef.current]) {
        if (!onTimeline.has(aid)) {
          URL.revokeObjectURL(e.url)
          vidBlobRef.current.delete(aid)
          vidProgRef.current.delete(aid)
        }
      }
      for (const [aid, e] of [...vidBlobFullRef.current]) {
        if (!onTimeline.has(aid)) {
          URL.revokeObjectURL(e.url)
          vidBlobFullRef.current.delete(aid)
          vidProgFullRef.current.delete(aid)
        }
      }
      for (const aid of [...audioBufCacheRef.current.keys()]) {
        if (!onTimeline.has(aid)) { audioBufCacheRef.current.delete(aid); proxyProgRef.current.delete(aid) }
      }
      for (const aid of [...wavMetaRef.current.keys()]) {
        if (!onTimeline.has(aid)) { wavMetaRef.current.delete(aid); wavHeaderPendingRef.current.delete(aid) }
      }
      for (const aid of [...imgMapPreview.current.keys()]) {
        if (!onTimeline.has(aid)) imgMapPreview.current.delete(aid)
      }
      for (const aid of [...imgMapFull.current.keys()]) {
        if (!onTimeline.has(aid)) imgMapFull.current.delete(aid)
      }

      // 優先度: 再生ヘッドに重なる > 前方(近い順) > 通過済み
      const vClips = cs.filter(c => {
        const t = ts.find(tk => tk.id === c.track_id)
        return t?.track_type === 'video' && !t.hidden && c.asset_id != null
      })
      const pri = new Map<number, number>()
      for (const c of vClips) {
        const p = (c.start_frame <= f && f < c.start_frame + c.duration_frames) ? 0
          : c.start_frame > f ? c.start_frame - f : 1e9 + (f - c.start_frame)
        pri.set(c.asset_id!, Math.min(pri.get(c.asset_id!) ?? Infinity, p))
      }
      const ordered = [...pri.entries()].sort((a, b) => a[1] - b[1]).map(([aid]) => aid)

      // 直列2本まで先読み(ストリーム読みで進捗をバーへ)。
      // 2段階方式: まず軽量層(プロキシ)を全アセット分読み切り、
      // 高画質モード中はその後に原本層を段階取得(別色バー)。
      const lightDone = ordered.every(aid => vidBlobRef.current.has(aid) ||
        !all.find(x => x.id === aid)?.proxy_path)
      const stage2 = !lightPreviewRef.current && lightDone
      const plan: Array<{ aid: number; full: boolean }> = [
        ...ordered.map(aid => ({ aid, full: false })),
        ...(stage2 ? ordered.map(aid => ({ aid, full: true })) : []),
      ]
      for (const { aid, full } of plan) {
        if (vidFetchingRef.current.size >= 2) break
        const key = full ? -aid : aid
        const tierMap = full ? vidBlobFullRef : vidBlobRef
        if (tierMap.current.has(aid) || vidFetchingRef.current.has(key)) continue
        const a = all.find(x => x.id === aid)
        if (!a) continue
        const useProxy = !full && !!a.proxy_path
        if (!useProxy && (a.file_size_bytes ?? Infinity) > (full ? 80e6 : 40e6)) continue  // 巨大原本はRangeストリーミングに任せる
        if (!full && !a.proxy_path && !lightPreviewRef.current) continue  // プロキシなし原本は第2層で扱う
        vidFetchingRef.current.add(key)
        void (async () => {
          // ハング対策: 60秒で中断してスロットを解放(次のtickで再試行される)
          const ac = new AbortController()
          const timer = setTimeout(() => ac.abort(), 60000)
          const progMap = full ? vidProgFullRef : vidProgRef
          try {
            const res = await fetch(assetsApi.fileUrl(aid, useProxy), { signal: ac.signal })
            const total = Number(res.headers.get('Content-Length') || 0)
            let blob: Blob
            if (res.body && total > 0) {
              const reader = res.body.getReader()
              const parts: BlobPart[] = []
              let got = 0
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                parts.push(value)
                got += value.length
                progMap.current.set(aid, got / total)
              }
              blob = new Blob(parts)
            } else {
              blob = await res.blob()
            }
            tierMap.current.set(aid, { url: URL.createObjectURL(blob), bytes: blob.size })
            progMap.current.set(aid, 1)
            // 高画質Blob到着: 再生中でも同一アセットなら位置を保って差し替え
            if (full) setVidTierBump(b => b + 1)
            // 容量上限: 遠いものから破棄(再生中のアセットは残す)。両層合算
            const sumBytes = () =>
              [...vidBlobRef.current.values(), ...vidBlobFullRef.current.values()]
                .reduce((s, e) => s + e.bytes, 0)
            let totalBytes = sumBytes()
            if (totalBytes > VID_CACHE_MAX) {
              // 高画質層の遠いものから先に破棄→次に軽量層
              for (const [tier, prog] of [[vidBlobFullRef, vidProgFullRef], [vidBlobRef, vidProgRef]] as const) {
                const far = [...tier.current.keys()]
                  .sort((x, y) => (pri.get(y) ?? 1e12) - (pri.get(x) ?? 1e12))
                for (const k of far) {
                  if (totalBytes <= VID_CACHE_MAX) break
                  if (k === loadedAssetId) continue
                  const e = tier.current.get(k)!
                  URL.revokeObjectURL(e.url)
                  tier.current.delete(k)
                  prog.current.delete(k)
                  totalBytes -= e.bytes
                }
              }
            }
          } catch { progMap.current.delete(aid) } finally { clearTimeout(timer); vidFetchingRef.current.delete(key) }
        })()
      }
    }, 500)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedAssetId])
  useEffect(() => () => {
    for (const e of vidBlobRef.current.values()) URL.revokeObjectURL(e.url)
    for (const e of vidBlobFullRef.current.values()) URL.revokeObjectURL(e.url)
    vidBlobRef.current.clear()
    vidBlobFullRef.current.clear()
  }, [])

  // ── WYSIWYG compositor ────────────────────────────────────────────────────
  // Preload image assets so the canvas can composite them (file = full quality).
  // タイムラインに配置されている画像のみ・再生ヘッド近傍から2並列の逐次ロード。
  // (以前は全ピンを一斉にnew Image()していたため、100枚規模になるとブラウザの
  //  同時接続枠を画像が占拠し、動画/音声の読み込みが後ろで枯渇していた)
  const imgLoadingRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return
      const { clips: cs, tracks: ts, currentFrame: f } = useTimelineStore.getState()
      const used = new Map<number, number>()   // asset id → 優先度(ヘッドからの距離)
      for (const c of cs) {
        if (c.asset_id == null) continue
        const t = ts.find(tk => tk.id === c.track_id)
        if (!t || t.hidden) continue
        const p = (c.start_frame <= f && f < c.start_frame + c.duration_frames) ? 0
          : Math.abs(c.start_frame - f)
        used.set(c.asset_id, Math.min(used.get(c.asset_id) ?? Infinity, p))
      }
      // まずpreview層(640px)を全対象に読み、高画質モード中はfull層も追加で読む。
      // fullはpreviewが揃った後に段階的に(=切替直後も既存previewで即表示できる)
      const isImgAsset = (a: typeof assetsRef.current[number]) =>
        a.asset_type === 'image' || (a.asset_type === 'generated' && a.duration_sec == null)
      const wantPreview = assetsRef.current.filter(a => isImgAsset(a)
        && used.has(a.id) && !imgMapPreview.current.has(a.id) && !imgLoadingRef.current.has(a.id))
      // 2段階方式: 軽量(preview)を全部読み切ってから高画質(full)を開始する
      const wantFull = (lightPreviewRef.current || wantPreview.length > 0) ? []
        : assetsRef.current.filter(a => isImgAsset(a)
          && used.has(a.id) && !imgMapFull.current.has(a.id) && !imgLoadingRef.current.has(-a.id))
      const candidates = [
        ...wantPreview.map(a => ({ a, full: false })),
        ...wantFull.map(a => ({ a, full: true })),
      ].sort((x, y) => (used.get(x.a.id)! + (x.full ? 1e6 : 0)) - (used.get(y.a.id)! + (y.full ? 1e6 : 0)))
      for (const { a, full } of candidates) {
        if (imgLoadingRef.current.size >= 2) break
        const key = full ? -a.id : a.id      // full層は負キーで進行管理
        imgLoadingRef.current.add(key)
        const im = new Image()
        const done = () => { imgLoadingRef.current.delete(key); setRedraw(r => r + 1) }
        im.onload = done
        im.onerror = done
        im.src = full ? assetsApi.fileUrl(a.id) : `/api/assets/${a.id}/preview`
        ;(full ? imgMapFull : imgMapPreview).current.set(a.id, im)
      }
    }
    const iv = setInterval(tick, 400)
    tick()
    return () => clearInterval(iv)
  }, [])
  useEffect(() => { lightPreviewRef.current = lightPreview; setRedraw(r => r + 1) }, [lightPreview])
  // 合成用画像の取得: 高画質モードではfull優先(未着ならpreviewで代替)、軽量はpreview優先
  const getCompImg = (assetId: number): HTMLImageElement | undefined => {
    const full = imgMapFull.current.get(assetId)
    const prev = imgMapPreview.current.get(assetId)
    const ok = (im?: HTMLImageElement) => (im && im.complete && im.naturalWidth ? im : undefined)
    return lightPreviewRef.current ? (ok(prev) ?? ok(full)) : (ok(full) ?? ok(prev))
  }

  // Draw an asset as a LAYER: cover-fit × scale, panned by (x,y), rotated about
  // its anchor. Mirrors the AE-style transform consumed by the render.
  /** トラックの layout_json → 出力画面内の配置矩形(px)。空/全画面なら null */
  const trackLayout = (raw?: string) => {
    if (!raw || !raw.trim()) return null
    try {
      const d = JSON.parse(raw) as { x?: number; y?: number; w?: number; h?: number; fit?: string }
      const x = d.x ?? 0, y = d.y ?? 0, w = d.w ?? 1, h = d.h ?? 1
      if (x === 0 && y === 0 && w === 1 && h === 1) return null
      return { x: x * projW, y: y * projH, w: Math.max(1, w * projW), h: Math.max(1, h * projH),
               fit: d.fit ?? 'contain' }
    } catch { return null }
  }

  const drawLayer0 = (ctx: CanvasRenderingContext2D, src: CanvasImageSource,
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

  // フィルターレイヤーの描画(書き出し側 ffmpeg_render._filter_parts と同じ規則)。
  //  solid: 全画面を単色で塗る。不透明度 = キー補間 × clip.opacity
  //  blur : ここまでに描いた絵(=下のレイヤー)を複製し、ガウスぼかしを掛けて上書きする。
  //         シグマは 1080p 基準 → キャンバスの実ピクセル高さに比例させる。
  const blurTmpRef = useRef<HTMLCanvasElement | null>(null)
  const blurSmallRef = useRef<HTMLCanvasElement | null>(null)
  // 🎬 撮影レイヤーの WebGL 描画(初めて撮影クリップを描くときに作る)。比べる(左右・素の絵)が変わったら描き直す
  const satsueiRef = useRef<SatsueiRenderer | null>(null)
  // このコマで「比べる」の右側を描いた範囲ごとの境目の白線(キャンバスの px。⇔ 比較表示ではその枠の中だけ)
  const satsueiSplitRef = useRef<{ x: number; y: number; h: number }[]>([])
  useEffect(() => subscribeSatsueiCompare(() => setRedraw(n => n + 1)), [])
  useEffect(() => () => { satsueiRef.current?.dispose(); satsueiRef.current = null }, [])
  //  lay: フィルタートラックの配置矩形(⇔比較表示)。指定があればその範囲にだけ作用させる。
  //       比較表示では右(参照動画)に効かせない — 参照は元から撮影処理済みで二重掛けになる。
  const drawFilterClip = (ctx: CanvasRenderingContext2D, cv: HTMLCanvasElement, clip: typeof clips[number],
                          lay: { x: number; y: number; w: number; h: number } | null) => {
    const v = filterValueAt(clip, currentFrame)
    const r = lay ?? { x: 0, y: 0, w: projW, h: projH }        // 作用範囲(プロジェクト座標)
    if (clip.kind === 'solid') {
      const a = Math.max(0, Math.min(1, v * (clip.opacity ?? 1)))
      if (a <= 0.001) return
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = a
      ctx.fillStyle = solidColor(clip); ctx.fillRect(r.x, r.y, r.w, r.h)
      ctx.restore()
      return
    }
    // 作用範囲をキャンバスの実ピクセルへ。シグマは範囲の高さに比例(全画面なら従来どおり)。
    const ps = cv.width / projW
    const px = Math.round(r.x * ps), py = Math.round(r.y * ps)
    const pw = Math.max(1, Math.min(cv.width - px, Math.round(r.w * ps)))
    const ph = Math.max(1, Math.min(cv.height - py, Math.round(r.h * ps)))
    const sigma = v * ph / 1080
    if (sigma < 0.05) return
    let tmp = blurTmpRef.current
    if (!tmp) { tmp = document.createElement('canvas'); blurTmpRef.current = tmp }
    if (tmp.width !== pw || tmp.height !== ph) { tmp.width = pw; tmp.height = ph }
    const tctx = tmp.getContext('2d'); if (!tctx) return
    tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.globalCompositeOperation = 'copy'; tctx.globalAlpha = 1
    tctx.drawImage(cv, px, py, pw, ph, 0, 0, pw, ph)
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip()    // 範囲の外(比較の右側など)へ滲ませない
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1
    if (typeof ctx.filter === 'string' && !/^((?!chrome|android).)*safari/i.test(navigator.userAgent)) {
      // 端は透明と混ざって薄くなるので、元の(鮮明な)絵の上に重ねる=端だけ僅かに鮮明寄り
      ctx.filter = `blur(${sigma.toFixed(2)}px)`
      ctx.drawImage(tmp, px, py)
    } else {
      // ctx.filter 非対応(Safari): 縮小→拡大の近似ぼかし
      const k = Math.max(1, sigma * 0.9)
      let sm = blurSmallRef.current
      if (!sm) { sm = document.createElement('canvas'); blurSmallRef.current = sm }
      const sw = Math.max(1, Math.round(pw / k)), sh = Math.max(1, Math.round(ph / k))
      if (sm.width !== sw || sm.height !== sh) { sm.width = sw; sm.height = sh }
      const sctx = sm.getContext('2d')
      if (sctx) {
        sctx.imageSmoothingQuality = 'high'
        sctx.drawImage(tmp, 0, 0, sw, sh)
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(sm, px, py, pw, ph)
      }
    }
    ctx.restore()
  }

  // 🎬 撮影レイヤー(調整レイヤー): このトラックで再生位置にかかる撮影クリップをまとめて解き(重なりは溶け A→B)、
  // ここまでに合成した絵へ WebGL で 1 回だけかける。式は satsueiLook / 書き出しの satsuei_fx と同じ。
  //  lay: 配置矩形(⇔比較表示)があればその範囲にだけ。比べる: bypass = かけない / enabled = split より右だけ描き戻す。
  //  WebGL が使えないときは何もしない(素の絵のまま)
  const drawSatsuei = (ctx: CanvasRenderingContext2D, cv: HTMLCanvasElement, laneClips: typeof clips,
                       lay: { x: number; y: number; w: number; h: number } | null, trackId: number) => {
    const cmp = getSatsueiCompare()
    if (cmp.bypass) return
    const spec = layerSpecOf(resolveLayer(laneClips, currentFrame), currentFrame)
    if (!spec) return
    const r = lay ?? { x: 0, y: 0, w: projW, h: projH }
    const ps = cv.width / projW
    const px = Math.round(r.x * ps), py = Math.round(r.y * ps)
    const pw = Math.max(1, Math.min(cv.width - px, Math.round(r.w * ps)))
    const ph = Math.max(1, Math.min(cv.height - py, Math.round(r.h * ps)))
    let R = satsueiRef.current
    if (!R) {
      R = new SatsueiRenderer(); satsueiRef.current = R
      R.onRestored = () => setRedraw(n => n + 1)      // WebGL が戻ったら、止めている絵も撮影つきで描き直す
    }
    // 比べるの境目は撮影がかかる範囲の幅に対する割合(⇔ 比較表示ではその枠の中で左右に分ける)
    const splitX = cmp.enabled ? Math.round(cmp.split * pw) : 0
    if (R.apply(ctx, cv, { x: px, y: py, w: pw, h: ph }, spec, currentFrame, cmp.enabled ? { splitX } : undefined) && cmp.enabled) {
      satsueiSplitRef.current.push({ x: px + splitX, y: py, h: ph })
    }
    // 次のカットの LUT は手の空いたときに先に作る(カットの替わり目のコマで 65³ を作ると、そのコマが遅れる)
    const near: SatsueiParams[] = []
    const onTrack = clips.filter(c => c.track_id === trackId && isSatsueiClip(c))
    const next = onTrack.filter(c => c.start_frame > currentFrame && c.start_frame - currentFrame <= projectFps * 20)
      .sort((a, b) => a.start_frame - b.start_frame).slice(0, 3)
    const prev = onTrack.filter(c => c.start_frame + c.duration_frames <= currentFrame && currentFrame - (c.start_frame + c.duration_frames) < projectFps * 10)
      .sort((a, b) => b.start_frame + b.duration_frames - (a.start_frame + a.duration_frames)).slice(0, 2)
    for (const c of [...next, ...prev]) near.push(satsueiOf(c.attrs_json))
    if (near.length) R.prefetch(near)
  }

  // 🔤 字幕(kind='credit'): ここまでに合成した絵(下のトラック全部)を、字幕の文字の形の中だけ屈折させてガラスの文字を描く。
  // 地図(文字の形・屈折の向き)は backend が作る(creditFields)。コマごとの数は creditLook.frameScalars、画素は creditGL。
  // 枠 = キャンバス全体(⚡軽量 1280×731 / 高画質 1344×768)か、トラックの配置矩形(⇔比較表示。丸めは撮影と同じ)
  const creditRef = useRef<CreditRenderer | null>(null)
  useEffect(() => subscribeCreditMaps(() => setRedraw(n => n + 1)), [])
  useEffect(() => subscribeCreditUi(() => setRedraw(n => n + 1)), [])
  useEffect(() => { void loadCreditMeta() }, [])
  useEffect(() => () => { creditRef.current?.dispose(); creditRef.current = null }, [])
  const creditBoxOf = (cv: HTMLCanvasElement, lay: { x: number; y: number; w: number; h: number } | null) => {
    if (!lay) return { x: 0, y: 0, w: cv.width, h: cv.height }
    const ps = cv.width / projW
    const px = Math.round(lay.x * ps), py = Math.round(lay.y * ps)
    const pw = Math.max(1, Math.min(cv.width - px, Math.round(lay.w * ps)))
    const ph = Math.max(1, Math.min(cv.height - py, Math.round(lay.h * ps)))
    return { x: px, y: py, w: pw, h: ph }
  }
  const drawCredit = (ctx: CanvasRenderingContext2D, cv: HTMLCanvasElement, clip: typeof clips[number],
                      lay: { x: number; y: number; w: number; h: number } | null) => {
    const credit = creditOf(clip.attrs_json)
    if (!credit.name) return
    const b = creditBoxOf(cv, lay)
    // 取れるまでは前の地図(位置だけの変更なら動かして)。何も無ければ描かない(再生は待たない)
    const use = creditMapsFor(clip.id, credit, [b.w, b.h], [projW, projH], { debounce: true })
    if (!use) return
    const sc = frameScalars(credit, use.maps.header, clip, currentFrame, projectFps)
    if (!sc.active) return
    let R = creditRef.current
    if (!R) {
      R = new CreditRenderer(); creditRef.current = R
      R.onRestored = () => setRedraw(n => n + 1)
    }
    // 「書き出しと同じ計算」を頼まれていれば、字幕を描く前と後の枠の絵を写す
    const snap = use.stale ? null : takeCreditSnapshot(clip.id)      // 前の地図の代わりで描いている間は写さない
    const grab = () => {
      const t = document.createElement('canvas'); t.width = b.w; t.height = b.h
      t.getContext('2d')!.drawImage(cv, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h)
      return t.toDataURL('image/png')
    }
    const below = snap ? grab() : ''
    R.apply(ctx, cv, b, use, sc, credit.refract, credit.style.sheen)
    if (snap) snap({ below, preview: grab(), frame: currentFrame, box: [b.w, b.h] })
    creditDebugState.lastMs = R.lastMs
    if (CREDIT_DEBUG) { const cm = creditDebugState.creditMs; cm.push(R.lastMs); if (cm.length > 600) cm.splice(0, cm.length - 600) }
  }
  // 再生で字幕に入るとき地図を待たないように、10 秒以内に始まる字幕の地図を先に取る(パネルを開いている間は全部、近い順)
  const prefetchCredits = (cv: HTMLCanvasElement) => {
    const all = creditPanelClipId() != null
    const horizon = projectFps * 10
    const list: Parameters<typeof prefetchCreditMaps>[0] = []
    const alive = new Set<number>()
    for (const c of clips) {
      if (!isCreditClip(c)) continue
      alive.add(c.id)
      const end = c.start_frame + c.duration_frames
      const dist = c.start_frame > currentFrame ? c.start_frame - currentFrame : end <= currentFrame ? currentFrame - end + 1 : 0
      if (!all && (dist > horizon || end <= currentFrame)) continue
      const tr = tracks.find(t => t.id === c.track_id)
      if (!tr || tr.track_type !== 'video' || tr.hidden) continue
      const b = creditBoxOf(cv, trackLayout(tr.layout_json))
      list.push({ credit: creditOf(c.attrs_json), box: [b.w, b.h], content: [projW, projH], prio: dist })
    }
    if (list.length) prefetchCreditMaps(list)
    pruneCreditClips(alive)                         // 消した字幕の「前の地図」(大きな配列)を握り続けない
  }
  // ▶ 出現から再生(字幕パネル): from から再生して to の手前で止める
  const stopAtRef = useRef<number | null>(null)

  const drawComposite = () => {
    const cv = compRef.current; if (!cv) return
    const ctx = cv.getContext('2d'); if (!ctx) return
    if (CAPTURE) {                          // 🎥 撮影用: 絵は撮影側が <img> で差し込む
      if (cv.width !== 320) { cv.width = 320; cv.height = Math.round(320 * projH / projW) }
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height)
      return
    }
    // 軽量プレビュー: cap the backing-store resolution (fill cost ∝ pixels). All
    // draw code stays in project-frame coordinates; a base transform scales down.
    const capW = lightPreview ? 1280 : 3840
    const s = Math.min(1, capW / projW)
    const cw = Math.max(1, Math.round(projW * s)), ch = Math.max(1, Math.round(projH * s))
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch }
    ctx.setTransform(s, 0, 0, s, 0, 0)                 // draw in projW×projH space
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, projW, projH)
    // 🔤 debug(?debug=credit だけ): 下の絵の代わりに差し込んだ静止画を敷き、字幕だけを描く(ヘッドレスは H.264 を読めない)
    const dbgUnder = CREDIT_DEBUG ? creditDebugState.underlay : null
    const dbgT0 = CREDIT_DEBUG ? performance.now() : 0
    // ── 境界フリーズ判定 ──────────────────────────────────────────
    // 主動画が担当するクリップがこのフレームを覆っているのに、<video>がまだ
    // その素材を表示できる状態でない(読み込み/シーク中)なら、部分的に合成せず
    // 最後の完成フレームをそのまま出す。部分合成は「読み込めたレイヤーだけが
    // 描かれ、下のピンや別位置のキャッシュが覗く」フラッシュの温床になる。
    {
      const vv = videoRef.current
      const needVideo = activeClip && activeClip.asset_id != null && (() => {
        const a = assets.find(x => x.id === activeClip.asset_id)
        return !!a && !(a.asset_type === 'image' || (a.asset_type === 'generated' && a.duration_sec == null))
      })()
      const lvA = activeClip ? layerVidsRef.current.get(-activeClip.id) : undefined
      const videoReady = (!!vv && loadedAssetId === activeClip?.asset_id
        && vv.readyState >= 2 && !vv.seeking)
        || (!!lvA && lvA.readyState >= 2 && !lvA.seeking && lvA.videoWidth > 0)   // 遷移直後: 補助<video>が担当中
      if (!compareMode && !diffMode && !previzMode && needVideo && !videoReady && !dbgUnder) {
        const lg = lastGoodRef.current.canvas
        if (lg && lg.width) {
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.drawImage(lg, 0, 0, cv.width, cv.height)
        }
        frozeRef.current = true
        return                       // 黒のまま(初回)か、直前の完成フレームで固定
      }
      frozeRef.current = false
    }
    // 🎬 カット割り背景: Imageトラックのピン(時刻順2個ペア=カット)の現在カット
    // 開始画像を最背面に敷く。プレースホルダの色がプレビューに出るため、
    // 音とカット割りの一致を再生しながら確認できる。
    //
    // ⚠ 「実素材レイヤーがあれば隠れる」前提は再生中に破れる。クリップ境界で
    //    <video>が次の素材を読み込む数フレームは上のレイヤーが何も描けず、
    //    このピン背景が一瞬露出してフラッシュに見える(コマ送りでは読み込みが
    //    追いつくので起きない。スマホは読み込みが遅いぶん顕著)。
    //    素材クリップがこのフレームを覆っているなら、読み込み中でもピンは
    //    描かない — 覆っているのに下が見えるのはレイヤー順として誤りだから。
    {
      const imgTrack = tracks.find(t => t.track_type === 'reference' && t.name === 'Image' && !t.hidden)
      const covered = clips.some(c => {
        if (c.asset_id == null) return false
        const tr = tracks.find(t => t.id === c.track_id)
        if (!tr || tr.track_type !== 'video' || tr.hidden) return false
        return c.start_frame <= currentFrame && currentFrame < c.start_frame + c.duration_frames
      })
      // 比較表示中は敷かない(左右のパネルの後ろに透けて比較の邪魔になる)
      if (imgTrack && !compareMode && !covered) {
        const pins = clips
          .filter(c => c.track_id === imgTrack.id && c.asset_id != null)
          .sort((a, b) => a.start_frame - b.start_frame)
        for (let i = 0; i + 1 < pins.length; i += 2) {
          // 終端ピン=カット最終フレーム(包含)
          if (currentFrame >= pins[i].start_frame && currentFrame <= pins[i + 1].start_frame) {
            const im = getCompImg(pins[i].asset_id!)
            if (im) {
              const cs = Math.max(projW / im.naturalWidth, projH / im.naturalHeight)
              const dw = im.naturalWidth * cs, dh = im.naturalHeight * cs
              ctx.drawImage(im, (projW - dw) / 2, (projH - dh) / 2, dw, dh)
            }
            break
          }
        }
      }
    }
    // 🎞プレビズ: 現在フレームが属するカットの previz 設定を引く
    let pvCut: { s: number; e: number; idx: number; pv: Previz | null; intent: string } | null = null
    if (previzMode) {
      const imgTrack = tracks.find(t => t.track_type === 'reference' && t.name === 'Image' && !t.hidden)
      if (imgTrack) {
        const pins = clips
          .filter(c => c.track_id === imgTrack.id && c.asset_id != null)
          .sort((a, b) => a.start_frame - b.start_frame)
        for (let i = 0; i + 1 < pins.length; i += 2) {
          if (currentFrame >= pins[i].start_frame && currentFrame <= pins[i + 1].start_frame) {
            let intent = ''
            try { intent = JSON.parse(pins[i].attrs_json || '{}').intent ?? '' } catch { /* noop */ }
            pvCut = { s: pins[i].start_frame, e: pins[i + 1].start_frame, idx: i / 2 + 1,
                      pv: parsePreviz(pins[i].attrs_json), intent }
            break
          }
        }
      }
      // ノイズ地(共有モジュール — ポップアップのプレビューと同一の描画)
      const rel = pvCut ? currentFrame - pvCut.s : currentFrame
      const dur = pvCut ? Math.max(1, pvCut.e - pvCut.s) : 60
      drawPrevizBase(ctx, projW, projH, pvCut?.pv ?? null, rel, dur)
      // カット番号と意図を薄く重ねる(脳内書き出しの手がかり)
      if (pvCut) {
        ctx.save()
        ctx.fillStyle = 'rgba(255,255,255,0.14)'
        ctx.font = `900 ${Math.round(projH * 0.28)}px Arial`
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
        ctx.fillText(`C${pvCut.idx}`, projW * 0.03, projH * 0.98)
        if (pvCut.intent) {
          ctx.fillStyle = 'rgba(255,255,255,0.5)'
          ctx.font = `${Math.round(projH * 0.032)}px sans-serif`
          const txt = pvCut.intent.slice(0, 42)
          ctx.fillText(txt, projW * 0.03, projH * 0.07)
        }
        ctx.restore()
      }
    }

    // UI上で上にあるトラック(order小)ほど最前面 → 下から順に描き、最後に上を重ねる
    // 🎞プレビズ中はベース(最背面)の映像トラックをノイズで置き換えるので描かない
    const vtsAll = tracks.filter(t => t.track_type === 'video' && !t.hidden).sort((a, b) => b.order - a.order)
    const vts = previzMode ? vtsAll.slice(1) : vtsAll
    satsueiSplitRef.current = []
    if (dbgUnder) { ctx.drawImage(dbgUnder, 0, 0, projW, projH) }
    for (const tr of vts) {
      if (previewHidden.includes(tr.id)) continue   // hidden in preview (not render)
      // 同一レイヤーで重なるクリップは開始順に全て描く(後のクリップが上、重なり区間は遷移として alpha ランプ)
      // 🔤 字幕どうしは (開始, id) の順(書き出しと同じ。後の字幕は前の字幕を描いた絵を屈折させる)
      let laneClips = clips.filter(c => c.track_id === tr.id && c.start_frame <= currentFrame && c.start_frame + c.duration_frames > currentFrame)
        .sort((a, b) => a.start_frame - b.start_frame || (isCreditClip(a) && isCreditClip(b) ? a.id - b.id : 0))
      if (laneClips.length === 0) continue
      // 🎬 いちばん下のトラック(書き出しのベース)に撮影があるときは、フィルターを素材のあとにまとめて掛ける。
      // 書き出しはベースの素材をつないでから、ベースのフィルターを開始順に掛ける(後から始まる素材にも撮影がかかる)
      if (tr === vtsAll[0] && laneClips.some(isSatsueiClip)) {
        laneClips = [...laneClips.filter(c => !isFilterClip(c)), ...laneClips.filter(c => isFilterClip(c))]
      }
      // 直前(下)のクリップの絵が描けたか。描けていない重なり区間では後クリップのランプを
      // 止めて不透明で描く(半透明の下に更に下のレイヤーが透けるのを防ぐ)。
      let prevDrawn = true
      let satsueiDone = false
      for (const clip of laneClips) {
      // 🔤 字幕: ここまでの絵(下のトラック全部 + このトラックで先に描いたもの)を屈折させてガラスの文字を描く
      if (isCreditClip(clip)) {
        drawCredit(ctx, cv, clip, trackLayout(tr.layout_json))
        prevDrawn = true
        continue
      }
      if (dbgUnder) continue
      // 🎬 撮影: このレイヤーの撮影クリップはまとめて 1 回(重なりの溶けも中で解く)。順番は最初の撮影クリップの位置
      if (isSatsueiClip(clip)) {
        if (!satsueiDone) { satsueiDone = true; drawSatsuei(ctx, cv, laneClips, trackLayout(tr.layout_json), tr.id) }
        prevDrawn = true
        continue
      }
      // ■単色 / ◌ぼかし(フィルターレイヤー): 素材を持たず、ここまでの合成結果に作用する
      if (isFilterClip(clip)) {
        drawFilterClip(ctx, cv, clip, trackLayout(tr.layout_json))
        prevDrawn = true
        continue
      }
      let drawn = false
      const drawLayer = (...args: Parameters<typeof drawLayer0>) => { drawn = true; drawLayer0(...args) }
      const prog = (currentFrame - clip.start_frame) / Math.max(1, clip.duration_frames)
      const xf = evalTransform(clip.transform_json, prog, currentFrame)
      ctx.save()
      // レイヤー(トラック)の配置。比較表示で左右に分けるのはここ。
      // 矩形へ縮小し、はみ出しは切る。レンダラーの _layout_pass と同じ見え方。
      const lay = trackLayout(tr.layout_json)
      if (lay) {
        ctx.beginPath(); ctx.rect(lay.x, lay.y, lay.w, lay.h); ctx.clip()
        const k = lay.fit === 'cover'
          ? Math.max(lay.w / projW, lay.h / projH)
          : Math.min(lay.w / projW, lay.h / projH)
        ctx.translate(lay.x + (lay.w - projW * k) / 2, lay.y + (lay.h - projH * k) / 2)
        ctx.scale(k, k)
      }
      // overlay の fade_in/out(フレーム)を alpha に反映 — レンダラーの _composite_one と同じ
      const relF = currentFrame - clip.start_frame
      const fiF = clip.fade_in_frames ?? 0, foF = clip.fade_out_frames ?? 0
      let fadeA = 1
      if (fiF > 0 && relF < fiF) fadeA = Math.max(0, relF / fiF)
      if (foF > 0 && clip.duration_frames - relF <= foF) fadeA = Math.min(fadeA, Math.max(0, (clip.duration_frames - relF) / foF))
      // 重なり遷移: このクリップが前クリップと重なっている区間では、前クリップ(下)の上に
      // カーブに従って不透明度を上げる。白/黒は hold 位置で色を挟む(色はレンダラーと同じ扱い)。
      const tfF = clip.transition_in ? (clip.transition_frames ?? 0) : 0
      if (tfF > 0 && relF < tfF && laneClips[0] !== clip && prevDrawn) {
        const t = Math.max(0, Math.min(1, relF / tfF))
        const ease = clip.transition_ease ?? 'linear'
        const k = ease === 'ease' ? (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
          : ease === 'ease-in' ? t * t : ease === 'ease-out' ? 1 - (1 - t) * (1 - t) : t
        if (clip.transition_in === 'white' || clip.transition_in === 'black') {
          const hold = clip.transition_hold ?? 0.5
          // 前半: 前クリップ(既に描画済み)の上に色を被せる / 後半: 色の上にこのクリップを出す
          const col = clip.transition_in === 'white' ? '255,255,255' : '0,0,0'
          const cover = t < hold ? t / hold : 1
          ctx.save(); ctx.globalCompositeOperation = 'source-over'
          ctx.fillStyle = `rgba(${col},${cover.toFixed(3)})`; ctx.fillRect(0, 0, projW, projH); ctx.restore()
          fadeA = Math.min(fadeA, t < hold ? 0 : (t - hold) / (1 - hold))
        } else {
          fadeA = Math.min(fadeA, k)
        }
      }
      ctx.globalAlpha = (clip.opacity ?? 1) * (clip.asset_id == null ? 1 : xf.opacity) * fadeA
      ctx.globalCompositeOperation = clip.blend === 'screen' ? 'screen'
        : clip.blend === 'add' ? 'lighter' : clip.blend === 'multiply' ? 'multiply' : 'source-over'
      if (clip.asset_id == null) {
        const el = parseElement(clip.transform_json)
        if (el) drawText(ctx, el, prog)
      } else {
        const asset = assets.find(a => a.id === clip.asset_id)
        const isImg = asset && (asset.asset_type === 'image' || (asset.asset_type === 'generated' && asset.duration_sec == null))
        if (isImg) {
          const im = getCompImg(clip.asset_id)
          if (im) drawLayer(ctx, im, im.naturalWidth, im.naturalHeight, xf)
        } else {
          const v = videoRef.current
          const cache = videoCacheRef.current
          const holdFps = clip.posterize_fps ?? 0
          const lv = layerVidsRef.current.get(tr.id)
          // 比較表示(トラックに layout あり)でも、同一レイヤーで重なるクリップは
          // トラック1本の<video>では両方が同じ絵になるので、クリップ専用の<video>(-clip.id)を使う
          const lvClip = layerVidsRef.current.get(-clip.id)
          if (compareMode && lv && !lvClip) {
            // 比較表示中: このレイヤー専用の<video>だけを使う。
            // 本体<video>やその直前フレームへ落とすと、他レイヤーと同じ絵になる。
            const lc = layerCacheRef.current
            if (lv.readyState >= 2 && lv.videoWidth) {
              drawLayer(ctx, lv, lv.videoWidth, lv.videoHeight, xf)
              // カットが変わると<video>は読み込み直しになり readyState が落ちる。
              // その間を直前の確定フレームで埋めないと黒く点滅するのでキャッシュする。
              let cc = lc.get(tr.id)
              if (!cc) { cc = document.createElement('canvas'); lc.set(tr.id, cc) }
              if (cc.width !== lv.videoWidth || cc.height !== lv.videoHeight) {
                cc.width = lv.videoWidth; cc.height = lv.videoHeight
              }
              cc.getContext('2d')?.drawImage(lv, 0, 0)
            } else {
              const cc = lc.get(tr.id)
              if (cc && cc.width) drawLayer(ctx, cc, cc.width, cc.height, xf)
            }
          } else if (!compareMode && v && loadedAssetId === clip.asset_id && v.readyState >= 2 && !v.seeking) {
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
            {
              // クロス遷移用: このトラックで最後に描いたライブフレームをクリップIDと共に保持
              let tl = trackLastRef.current.get(tr.id)
              if (!tl || tl.clipId !== clip.id) { tl = { clipId: clip.id, canvas: document.createElement('canvas') }; trackLastRef.current.set(tr.id, tl) }
              if (tl.canvas.width !== v.videoWidth || tl.canvas.height !== v.videoHeight) { tl.canvas.width = v.videoWidth; tl.canvas.height = v.videoHeight }
              tl.canvas.getContext('2d')?.drawImage(v, 0, 0)
            }
          } else if (!compareMode && clip.id === activeClip?.id && cache.canvas && cache.canvas.width && !layerVidsRef.current.get(-clip.id)) {
            // 直前フレームのキャッシュは本体<video>のもの。別レイヤーに流用すると
            // そのレイヤーが上のレイヤーと同じ絵になってしまうので、本体が担当する
            // クリップにだけ使う。
            // シーク中・ロード中・クリップ切替中は直前の確定フレームで埋める。
            // アセットが変わる境界でも下層(Video/Imageトラック)を一瞬見せない。
            drawLayer(ctx, cache.canvas, cache.canvas.width, cache.canvas.height, xf)
          } else if (asset && asset.duration_sec != null) {
            // 本体<video>が担当しない映像レイヤー(下敷きトラック等)は、トラック専用の
            // 補助<video>で描く(2026-09-19)。これが無いと、上のクリップが alpha フェード
            // している間の下層が描かれず、黒へのフェードに見えてしまう。
            // 重なり遷移中のクリップには <LayerVideo>(再生中は play() で追従)が
            // -clip.id で登録されている。毎フレーム seek する補助<video>は再生に
            // 追いつけず、遷移側のクリップが描かれない=遷移が見えない原因だった(2026-09-21)。
            // 時間リマップ/速度カーブ付きクリップも本体と同じ規則で素材時刻を出す
            // (一定速度だけで計算すると許容誤差を外れて描かれなかった: 2026-09-21)
            const target = clipAssetTime(clip, currentFrame - clip.start_frame, projectFps)
            const lvOv = layerVidsRef.current.get(-clip.id)
            let hv: HTMLVideoElement
            let tol = 1.5 / projectFps
            if (lvOv) {
              hv = lvOv
              // 素材秒での許容幅。高速クリップ(124f を 12f に詰める等)は 1 出力コマで
              // 素材が 10 コマ進むので、速度に比例させないと合っていても不一致扱いになる
              const r = clipRateAt(clip, currentFrame - clip.start_frame, projectFps)
              tol = playing ? 0.3 * Math.max(1, Number.isFinite(r) ? Math.abs(r) : 1) : 1.5 / projectFps
            } else {
              let hv0 = crossVidsRef.current.get(-clip.id)
              if (!hv0) { hv0 = document.createElement('video'); hv0.muted = true; hv0.playsInline = true; hv0.preload = 'auto'; crossVidsRef.current.set(-clip.id, hv0) }
              hv = hv0
              const hurl = assetsApi.fileUrl(asset.id, !!asset.proxy_path)
              if (hv.getAttribute('src') !== hurl) { hv.src = hurl; hv.load() }
              if (hv.readyState >= 1 && Math.abs(hv.currentTime - target) > 0.5 / projectFps && !hv.seeking) hv.currentTime = target
            }
            let lc2 = layerCacheRef.current.get(-clip.id)
            if (hv.readyState >= 2 && !hv.seeking && hv.videoWidth && Math.abs(hv.currentTime - target) <= tol) {
              drawLayer(ctx, hv, hv.videoWidth, hv.videoHeight, xf)
              if (!lc2) { lc2 = document.createElement('canvas'); layerCacheRef.current.set(-clip.id, lc2) }
              if (lc2.width !== hv.videoWidth || lc2.height !== hv.videoHeight) { lc2.width = hv.videoWidth; lc2.height = hv.videoHeight }
              lc2.getContext('2d')?.drawImage(hv, 0, 0)
            } else if (lc2 && lc2.width) {
              drawLayer(ctx, lc2, lc2.width, lc2.height, xf)
            }
          }
        }
      }
      ctx.restore()
      prevDrawn = drawn || clip.asset_id == null
      }
    }
    prefetchCredits(cv)
    if (CREDIT_DEBUG) {
      const fm = creditDebugState.frameMs
      fm.push(performance.now() - dbgT0)
      if (fm.length > 600) fm.splice(0, fm.length - 600)
    }
    // 🎬 比べる: 撮影なし(左)と撮影あり(右)の境目に細い白線(撮影をかけた範囲ごと)
    if (satsueiSplitRef.current.length) {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 0.9
      ctx.fillStyle = '#fff'
      for (const ln of satsueiSplitRef.current) ctx.fillRect(ln.x - (cv.width > 1600 ? 1 : 0), ln.y, cv.width > 1600 ? 2 : 1, ln.h)
      ctx.restore()
    }

    // Image(Ref)ピン選択中はその画像をcontainでフル表示(小サムネ確認の代替)。
    // 最後に選択したピンを優先。選択解除で通常の合成表示に戻る。
    if (refSel.length > 0) {
      const selClip = [...refSel].reverse()
        .map(id => clips.find(c => c.id === id))
        .find(c => c && c.asset_id != null)
      const im = selClip?.asset_id != null ? getCompImg(selClip.asset_id) : undefined
      if (im) {
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, projW, projH)
        const cs = Math.min(projW / im.naturalWidth, projH / im.naturalHeight)
        const dw = im.naturalWidth * cs, dh = im.naturalHeight * cs
        ctx.drawImage(im, (projW - dw) / 2, (projH - dh) / 2, dw, dh)
      }
    }

    // 🎞プレビズ: フラッシュ/暗転は全画面効果として最後に重ねる(共有モジュール)
    if (previzMode && pvCut) {
      const rel = currentFrame - pvCut.s
      const dur = Math.max(1, pvCut.e - pvCut.s)
      // カット内ビート(拍フラッシュ用)
      const beatRel: number[] = []
      if (pvCut.pv?.flash === 'beat') {
        for (const c of clips) {
          const b = c.asset_id != null ? beatsMap[c.asset_id] : undefined
          if (!b) continue
          const inSec = c.asset_in_frame / projectFps
          for (const bt of b.beats) {
            const bf = Math.round(c.start_frame + (bt - inSec) * projectFps) - pvCut.s
            if (bf >= 0 && bf < dur) beatRel.push(bf)
          }
          break
        }
      }
      drawPrevizFx(ctx, projW, projH, pvCut.pv, rel, dur, beatRel)
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

  // 完成フレームの保存(境界フリーズ用)。通常表示で最後まで合成できたフレームだけを
  // 残す。差分/比較/プレビズ/ピン全画面は合成結果が特殊なので保存しない。
  const snapshotGood = () => {
    const cv = compRef.current
    if (!cv || !cv.width) return
    if (diffMode || compareMode || previzMode || refSel.length > 0) return
    if (frozeRef.current) return    // フリーズ描画は「完成フレーム」ではない
    const lg = lastGoodRef.current
    if (!lg.canvas) lg.canvas = document.createElement('canvas')
    if (lg.canvas.width !== cv.width || lg.canvas.height !== cv.height) {
      lg.canvas.width = cv.width; lg.canvas.height = cv.height
    }
    lg.canvas.getContext('2d')?.drawImage(cv, 0, 0)
  }

  useEffect(() => { drawComposite(); snapshotGood() }, [currentFrame, clips, tracks, assets, loadedAssetId, projW, projH, redraw, previewHidden, lightPreview, diffMode, refSel, previzMode, beatsMap])

  // Measure the fitted project-frame box (object-contain) for the frame guides
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ar = (projW * view.w) / (projH * view.h)     // 比較表示は帯の縦横比
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
  }, [projW, projH, view.w, view.h])

  // 🎥 撮影用モード: 撮影スクリプトから再生位置を動かす口
  useEffect(() => {
    if (!CAPTURE) return
    ;(window as unknown as { __kycha?: unknown }).__kycha = {
      setFrame: (f: number) => useTimelineStore.getState().setCurrentFrame(f),
      store: useTimelineStore,                                   // クリップ選択・拡大率など
      setAutoFit: (v: boolean) => { captureState.autoFit = v },   // false で全尺合わせを止める
    }
  }, [])

  const cycleGuide = () =>
    setGuideMode(m => (m === 'off' ? 'thirds' : m === 'thirds' ? 'safe' : 'off'))

  // ── Timeline master clock ─────────────────────────────────────────────
  // Wall-clock drives currentFrame; the <video>/<audio> elements follow it
  // (see the sync effects above). This survives clip changes mid-playback —
  // the old design derived the frame from video.currentTime, so when a new
  // clip's src loaded paused, playback froze on its first frame.
  const lastClipEnd = useMemo(() => clips.reduce((m, c) => Math.max(m, c.start_frame + c.duration_frames), 0), [clips])
  const lastEndRef = useRef(lastClipEnd)
  lastEndRef.current = lastClipEnd

  useEffect(() => {
    if (!playing) { stopAtRef.current = null; return }
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
        const stopAt = stopAtRef.current
        if (stopAt != null && next >= stopAt) {     // 🔤 ▶ 出現から再生: 字幕の終わりで止める
          setCurrentFrame(Math.max(0, stopAt - 1))
          stopAtRef.current = null
          setPlaying(false)
          return
        }
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
      // 文字を打つ欄だけ除く(🔊 音量のスライダー = range にフォーカスがあっても再生/停止できるように)
      if (t && ((t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range') || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      unlockAudioPool()
      setPlaying(p => !p)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const togglePlay = () => { unlockAudioPool(); setPlaying(p => !p) }

  // 🔤 字幕パネルの「▶ 出現から再生」: from から再生して to(含まない)の手前で止める
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ from: number; to: number }>).detail
      if (!d || !Number.isFinite(d.from)) return
      setCurrentFrame(Math.max(0, Math.round(d.from)))
      stopAtRef.current = Number.isFinite(d.to) ? Math.round(d.to) : null
      unlockAudioPool()
      setPlaying(true)
    }
    window.addEventListener('kychapogas:play-range', on)
    return () => window.removeEventListener('kychapogas:play-range', on)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // 🔤 debug(?debug=credit): ヘッドレスの確かめ用の口(静止画の差し込み・再生・描画時間)
  useEffect(() => {
    if (!CREDIT_DEBUG) return
    installCreditDebug({
      store: useTimelineStore,
      projects: useProjectStore,
      setUnderlay: (img: CanvasImageSource | null) => { creditDebugState.underlay = img; setRedraw(n => n + 1) },
      play: (v: boolean) => setPlaying(v),
      canvas: () => compRef.current,
      redraw: () => setRedraw(n => n + 1),
      setLight: (v: boolean) => setLightPreview(v),
    })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

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
      const t = clipAssetTime(activeClip, currentFrame - activeClip.start_frame, projectFps)
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
        {/* 比較表示中は映像レイヤーごとに<video>を持たせる(本体1本だと全レイヤーが同じ絵になる) */}
        {compareMode && !CAPTURE && tracks
          .filter(t => t.track_type === 'video' && !t.hidden && !previewHidden.includes(t.id))
          .map(t => {
            const c = clips.find(c2 => c2.track_id === t.id
              && c2.start_frame <= currentFrame && c2.start_frame + c2.duration_frames > currentFrame)
            const a = c?.asset_id != null ? assets.find(x => x.id === c.asset_id) : null
            const isVid = a?.asset_type === 'video'
              || (a?.asset_type === 'generated' && a?.duration_sec != null)
            return (
              <LayerVideo
                key={t.id}
                trackId={t.id}
                clip={isVid && c ? c : null}
                proxy={lightPreview && !!a?.proxy_path}
                projectFps={projectFps}
                currentFrame={currentFrame}
                playing={playing}
                reg={regLayerVid}
                onFrame={bumpRedraw}
              />
            )
          })}

        {/* 同一レイヤーの重なり遷移: 本体<video>が担当しない側のクリップにも再生追従する
            <video>を持たせる(-clip.id で登録)。少し手前(12f)から用意して読み込みを済ませる */}
        {!CAPTURE && clips
          .filter(c => {
            if (c.asset_id == null) return false
            if (c.kind === 'rain') return false        // 🌧 雨クリップは下の専用ブロックで持つ(同じ key を作らない)
            const t = tracks.find(x => x.id === c.track_id)
            if (!t || t.track_type !== 'video' || t.hidden || previewHidden.includes(t.id)) return false
            const cEnd = c.start_frame + c.duration_frames
            // 重なり区間 [max(start), min(end)) の 48f(2秒)手前から区間の終わりまで、
            // 本体<video>の担当に関係なく用意しておく(担当が切り替わった瞬間に穴を開けない)。
            // 12f 前だと読み込みとシークが遷移の直前に重なり、C7/C9 が重かった
            return clips.some(o => {
              if (o.id === c.id || o.track_id !== c.track_id || o.asset_id == null) return false
              const rs = Math.max(c.start_frame, o.start_frame), re = Math.min(cEnd, o.start_frame + o.duration_frames)
              return rs < re && currentFrame >= rs - 48 && currentFrame < re
            })
          })
          .map(c => {
            const a = assets.find(x => x.id === c.asset_id)
            const isVid = a?.asset_type === 'video' || (a?.asset_type === 'generated' && a?.duration_sec != null)
            if (!isVid) return null
            return (
              <LayerVideo
                key={-c.id}
                trackId={-c.id}
                clip={c}
                proxy={lightPreview && !!a?.proxy_path}
                projectFps={projectFps}
                currentFrame={currentFrame}
                playing={playing}
                reg={regLayerVid}
                onFrame={bumpRedraw}
              />
            )
          })}

        {/* 🌧 雨クリップ: 雨の層(黒地に雨だけ)を再生に追従する専用の<video>で持つ(-clip.id で登録)。
            合成は drawComposite の screen + globalAlpha(=不透明度)。書き出しの blend=screen:all_opacity と同じ式。
            原本を使う: 640px のプロキシでは 1〜2px の雨筋が消え、書き出しと見た目が合わなくなる。48f 手前から用意する */}
        {!CAPTURE && clips
          .filter(c => c.kind === 'rain' && c.asset_id != null
            && currentFrame >= c.start_frame - 48 && currentFrame < c.start_frame + c.duration_frames)
          .filter(c => {
            const t = tracks.find(x => x.id === c.track_id)
            return !!t && t.track_type === 'video' && !t.hidden && !previewHidden.includes(t.id)
          })
          .map(c => (
            <LayerVideo
              key={-c.id}
              trackId={-c.id}
              clip={c}
              proxy={false}
              projectFps={projectFps}
              currentFrame={currentFrame}
              playing={playing}
              reg={regLayerVid}
              onFrame={bumpRedraw}
            />
          ))}

        {/* WYSIWYG compositor: all video tracks composited at the playhead
            (transforms / opacity / blend / text) so the timeline is what-you-see. */}
        {/* 表示範囲(view)の枠。canvas は全画面の比率のまま大きく置き、枠で切り抜く
            (比較表示では上下の黒帯が枠の外に出る)。通常表示では枠=全画面 */}
        <div className="relative overflow-hidden flex-shrink-0" style={{ width: box.w, height: box.h }}>
          <canvas ref={compRef} className="absolute max-w-none"
                  style={{
                    width: box.w / view.w, height: box.h / view.h,
                    left: -view.x * box.w / view.w, top: -view.y * box.h / view.h,
                    // 撮影パス近似: gblur0.35→blur / 黒締め→contrast+brightness
                    ...(gradeOn && !CAPTURE ? { filter: 'blur(0.35px) contrast(1.035) brightness(0.985)' } : {}),
                  }} />
          {/* 🎥 撮影用: 書き出し済みの映像のフレームをここへ差し込む(capture.mjs) */}
          {CAPTURE && <img data-capture-frame="" alt="" className="absolute inset-0 w-full h-full" />}
        </div>
        {/* 撮影パス近似の残り2段: 弱ビネット + 静的グレイン(SVG feTurbulence)。
            書き出しのグレインは時間変化するが、プレビューは負荷を避け100%静止。 */}
        {gradeOn && !CAPTURE && box.w > 1 && (
          <div className="absolute pointer-events-none"
               style={{
                 width: box.w, height: box.h, left: '50%', top: '50%',
                 transform: 'translate(-50%, -50%)',
                 background: 'radial-gradient(ellipse 105% 105% at 50% 50%, transparent 62%, rgba(0,0,0,0.22) 100%)',
               }}>
            <div className="absolute inset-0"
                 style={{
                   opacity: 0.05, mixBlendMode: 'overlay',
                   backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='309'/></filter><rect width='128' height='128' filter='url(%23n)'/></svg>")`,
                 }} />
          </div>
        )}


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

        {/* 💍 指輪の位置: ON の間だけ、プレビュー全体を受け口で覆って印を付ける(クリックはほかへ漏らさない) */}
        {!CAPTURE && box.w > 1 && <RingOverlay box={box} view={view} assets={assets} projH={projH} />}
        {/* 🔤 字幕パネルを開いている間: 字幕の枠(ドラッグで位置・ホイールで大きさ) */}
        {!CAPTURE && box.w > 1 && <CreditOverlay box={box} view={view} projW={projW} projH={projH} canvasRef={compRef} />}

        {/* Empty state */}
        {!activeClip && (
          <span className="text-zinc-700 text-sm">再生ヘッドにクリップがありません</span>
        )}

        {/* Timecode overlay */}
        {/* 読み込み状態バッジ: 無音/黒画面がロード中かどうかを見分ける */}
        {!CAPTURE && (videoBuffering || audioBuffering) && (
          <div className="absolute top-2 left-2 flex gap-1.5 pointer-events-none">
            {videoBuffering && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-sky-300 animate-pulse">⏳ 映像読込中</span>
            )}
            {audioBuffering && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-emerald-300 animate-pulse">🎵 音声読込中</span>
            )}
          </div>
        )}
        {/* 🎤歌詞オーバーレイ: 下辺に字幕位置で重ねる(絵を隠さない)。🎤トグルで消せる */}
        {showLyrics && currentCut?.lyrics && (
          <div className="absolute inset-x-0 bottom-8 flex justify-center px-6 pointer-events-none">
            <span className="text-center text-[clamp(14px,2.4vw,30px)] leading-snug text-sky-100
                             [text-shadow:0_2px_6px_rgba(0,0,0,0.95),0_0_18px_rgba(0,0,0,0.8)]">
              {currentCut.lyrics}
            </span>
          </div>
        )}
        {/* 現在カットバッジ(CutLaneと同一採番) */}
        {currentCut && (
          <span className="absolute bottom-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-black/50 text-amber-300 pointer-events-none font-mono">
            C{currentCut.n} <span className="text-white/40">f{currentCut.s}-{currentCut.e}</span>
          </span>
        )}
        <div className="absolute bottom-2 right-2 font-mono text-[10px] text-white/50 bg-black/40 px-1.5 py-0.5 rounded pointer-events-none">
          {/* 通しフレーム番号(比較版に焼き込む「1600f」と同じ数) */}
          {!CAPTURE && <span className="text-yellow-300 text-[12px] font-semibold mr-1.5">{currentFrame}f</span>}
          {String(Math.floor(currentFrame / projectFps / 60)).padStart(2, '0')}:
          {String(Math.floor(currentFrame / projectFps) % 60).padStart(2, '0')}:
          {String(currentFrame % projectFps).padStart(2, '0')}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-t border-zinc-800 flex-shrink-0 overflow-x-auto max-sm:px-2 [&>button]:flex-shrink-0 [&>button]:whitespace-nowrap max-sm:[&>button]:py-1.5 [&>span]:flex-shrink-0">
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
        <FrameJump
          currentFrame={currentFrame}
          maxFrame={Math.max(0, lastClipEnd - 1)}
          onJump={f => setCurrentFrame(f)}
        />
        <VolumeControl
          volume={previewVolume}
          muted={previewMuted}
          onVolume={setPreviewVolume}
          onMuted={setPreviewMuted}
        />

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
          onClick={async () => {
            const cv = compRef.current
            if (!cv) return
            const blob: Blob | null = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.95))
            if (!blob) return
            const f = useTimelineStore.getState().currentFrame
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `frame_${String(f).padStart(5, '0')}.jpg`
            document.body.appendChild(a)
            a.click()
            a.remove()
            setTimeout(() => URL.revokeObjectURL(url), 10000)
          }}
          className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
          title="現在の合成フレームを JPEG として保存(ダウンロード)"
        >💾 保存</button>

        <button
          onClick={() => setLightPreview(v => !v)}
          className={`ml-auto text-[10px] px-2 py-0.5 rounded ${lightPreview ? 'bg-emerald-800 text-emerald-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
          title="軽量プレビュー: 描画解像度を下げて動作を軽く（書き出し画質は不変）"
        >⚡ {lightPreview ? '軽量' : '高画質'}</button>
        <button
          onClick={() => setPrevizMode(v => !v)}
          className={`text-[11px] px-2 py-0.5 rounded ${previzMode
            ? 'bg-fuchsia-800 hover:bg-fuchsia-700 text-fuchsia-100'
            : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'}`}
          title="🎞プレビズ: ベース映像をノイズ表現に置き換え、カットごとの移動/フラッシュ/暗転設定(カット割りを右クリック)を確かめる"
        >🎞</button>

        <button
          onClick={() => setGradeOn(v => !v)}
          className={`text-[10px] px-2 py-0.5 rounded ${gradeOn
            ? 'bg-violet-800 hover:bg-violet-700 text-violet-100'
            : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
          title="撮影(共通グレード): 書き出し時の統一処理(黒締め/ビネット/グレイン)をプレビューでも近似表示。OFFは素の絵"
        >🎛 {gradeOn ? '撮影' : '素'}</button>

        <button
          onClick={() => setShowLyrics(v => { localStorage.setItem('kychapogas:lyrics', v ? 'off' : 'on'); return !v })}
          className={`text-[10px] px-2 py-0.5 rounded ${showLyrics
            ? 'bg-sky-800 hover:bg-sky-700 text-sky-100'
            : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
          title="歌詞オーバーレイ: 再生位置のカットの歌詞を字幕位置に重ねる(ピンのattrs_jsonが唯一の正)。撮影確認時は切る"
        >🎤 {showLyrics ? '歌詞' : '歌詞'}</button>

        {!CAPTURE && <RingToggleButton />}

        <button
          onClick={cycleGuide}
          className={`text-[10px] px-2 py-0.5 rounded ${guideMode !== 'off' ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
          title="フレーム枠ガイド: なし → 三分割 → セーフエリア"
        >⊞ {guideMode === 'off' ? 'ガイド' : guideMode === 'thirds' ? '三分割' : 'セーフ'}</button>

        {/* 解像度は見出しにも出ているので、広い画面だけ(番号・音量の欄のぶん場所をあける) */}
        <span className="text-[10px] text-zinc-600 max-2xl:hidden">
          {projW}×{projH}
        </span>
      </div>
    </div>
  )
}
