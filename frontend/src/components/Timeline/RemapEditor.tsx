import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Clip, Asset } from '../../api/client'
import { assetsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { parseRemapKeys, remapSrcFrame, type RemapKey } from './remap'

/**
 * ⏱ リマップエディタ(Scenes向け) — マルチカット生成物のシーンチェンジ位置を
 * キーで数フレーム単位に補正する。
 *
 * ポップアップの中で完結する:
 *   ・生成動画のフレームを見ながらキーを打つ(左ペイン=リマップ適用後のプレビュー)
 *   ・参照(Videoトラック)を右ペインに同フレーム表示してリアルタイム比較
 *   ・ミニタイムラインにカット割りピン/キー/再生ヘッドを出し、キーはドラッグで動かす
 *   ・ループ再生でコマ打ちのリズムを確認する
 * キーは「素材のフレーム(src)をクリップ内のこの位置(t)に置く」釘。tを動かすと
 * 前後の区間が線形に伸縮する。プレビューとレンダラは同じ規則(remap.ts)。
 */
interface Props {
  clip: Clip
  /** このクリップのアセット(プロキシ有無の判定にだけ使う) */
  asset?: Asset
  fps: number
  onClose: () => void
}

const HOLDS: Array<[number, string]> = [[0, 'なし'], [12, '2コマ'], [8, '3コマ'], [6, '4コマ']]

export function RemapEditor({ clip, asset, fps, onClose }: Props) {
  const { tracks, clips, currentFrame, liveUpdateClip, updateClip } = useTimelineStore()
  const dur = clip.duration_frames

  // アセット一覧(5MB超)は取りに行かない。必要なのは再生URLだけなので、
  // アセットIDから直接URLを組み立てる。プロキシは自素材のみ props で受け取る。

  // 参照 = 自分以外の映像トラックで最背面(order最大)のもの(通常 "Video" = ED)
  const refInfo = useMemo(() => {
    const own = tracks.find(t => t.id === clip.track_id)
    const cands = tracks
      .filter(t => t.track_type === 'video' && t.id !== own?.id)
      .sort((a, b) => b.order - a.order)
    for (const t of cands) {
      const c = clips.find(c2 => c2.track_id === t.id && c2.asset_id != null
        && c2.start_frame <= clip.start_frame
        && c2.start_frame + c2.duration_frames >= clip.start_frame + dur)
      if (c) return { clip: c }
    }
    return null
  }, [tracks, clips, clip.track_id, clip.start_frame, dur])

  // ── キー(remap_json が真実。liveUpdateClip は同期反映なのでドラッグにも追従) ──
  const keys = useMemo<RemapKey[]>(() => {
    try { return ((JSON.parse(clip.remap_json || '{}').keys ?? []) as RemapKey[]).sort((a, b) => a.t - b.t) }
    catch { return [] }
  }, [clip.remap_json])
  const save = (ks: RemapKey[], immediate = false) => {
    const body = ks.length ? JSON.stringify({ keys: [...ks].sort((a, b) => a.t - b.t) }) : ''
    if (immediate) void updateClip(clip.id, { remap_json: body })
    else liveUpdateClip(clip.id, { remap_json: body })
  }
  const full = parseRemapKeys(clip.remap_json, dur, clip.asset_in_frame)
  const srcAt = (rel: number) => (full ? remapSrcFrame(full, rel, fps) : clip.asset_in_frame + rel)

  // ── 再生ヘッド(クリップ内相対フレーム)と再生 ──────────────────────────
  const [cur, setCur] = useState(() => {
    const rel = currentFrame - clip.start_frame
    return rel >= 0 && rel < dur ? rel : 0
  })
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    let raf = 0, last = performance.now(), acc = 0
    const tick = (now: number) => {
      acc += (now - last) * fps / 1000; last = now
      if (acc >= 1) { setCur(c => (c + Math.floor(acc)) % dur); acc -= Math.floor(acc) }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, fps, dur])

  // ── 2つの<video>を現在フレームへシーク ─────────────────────────────
  const sceneVid = useRef<HTMLVideoElement>(null)
  const refVid = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = sceneVid.current
    if (v && v.readyState >= 1) {
      const t = srcAt(cur) / fps + 1e-4
      if (Math.abs(v.currentTime - t) > 0.2 / fps) v.currentTime = t
    }
    const r = refVid.current
    if (r && r.readyState >= 1 && refInfo) {
      const F = clip.start_frame + cur
      const rc = refInfo.clip
      const t = (rc.asset_in_frame + (F - rc.start_frame) * (rc.speed > 0 ? rc.speed : 1)) / fps + 1e-4
      if (Math.abs(r.currentTime - t) > 0.2 / fps) r.currentTime = t
    }
  })

  // ── カット割りピン(Imageトラック)のうちクリップ範囲内のもの ───────────
  const pins = useMemo(() => {
    const img = tracks.find(t => t.track_type === 'reference' && t.name === 'Image')
    if (!img) return []
    return clips
      .filter(c => c.track_id === img.id && c.asset_id != null
        && c.start_frame >= clip.start_frame && c.start_frame <= clip.start_frame + dur - 1)
      .map(c => c.start_frame - clip.start_frame)
      .sort((a, b) => a - b)
  }, [tracks, clips, clip.start_frame, dur])

  // ── ミニタイムライン(スクラブ + キードラッグ) ─────────────────────────
  const stripRef = useRef<HTMLDivElement>(null)
  const dragKey = useRef<{ idx: number } | null>(null)
  const frameAt = (clientX: number) => {
    const el = stripRef.current!
    const r = el.getBoundingClientRect()
    return Math.min(dur - 1, Math.max(0, Math.round((clientX - r.left) / r.width * dur)))
  }
  const onStripPointer = (e: React.PointerEvent) => {
    if (dragKey.current) {
      const ks = keys.map(k => ({ ...k }))
      const i = dragKey.current.idx
      const prev = i > 0 ? ks[i - 1].t : 0
      const next = i < ks.length - 1 ? ks[i + 1].t : dur
      ks[i].t = Math.min(next - 1, Math.max(prev + 1, frameAt(e.clientX)))
      save(ks)
      setCur(ks[i].t)
    } else {
      setCur(frameAt(e.clientX))
    }
  }
  const addKey = (rel: number) => {
    const r = Math.min(dur - 1, Math.max(1, rel))
    if (keys.some(k => k.t === r)) return
    save([...keys, { t: r, src: Math.round(srcAt(r)), hold: 0 }], true)
  }

  const segs = useMemo(() => {
    if (!full) return []
    return full.slice(0, -1).map((k0, i) => {
      const k1 = full[i + 1]
      return { from: k0.t, to: k1.t, speed: (k1.src - k0.src) / Math.max(1e-6, k1.t - k0.t) }
    })
  }, [full])

  const vidUrl = (assetId: number | null | undefined, proxy = false) =>
    assetId != null ? assetsApi.fileUrl(assetId, proxy) : undefined

  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/70 p-2 sm:p-6"
         onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[960px] max-w-full
                      max-h-[92dvh] overflow-y-auto p-4 flex flex-col gap-3"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">
            ⏱ 時間リマップ — f{clip.start_frame}〜f{clip.start_frame + dur - 1}（{dur}f / {(dur / fps).toFixed(2)}秒）
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg px-2">✕</button>
        </div>

        {/* ── プレビュー: 左=リマップ適用後 / 右=参照(Videoトラック) ── */}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-purple-300">Scenes（リマップ適用後）</span>
            <video ref={sceneVid} src={vidUrl(clip.asset_id, !!asset?.proxy_path)} muted playsInline preload="auto"
                   className="w-full aspect-video bg-black rounded border border-zinc-700 object-contain" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-sky-300">参照（{refInfo ? 'Videoトラック' : 'なし'}）</span>
            {refInfo
              ? <video ref={refVid} src={vidUrl(refInfo.clip.asset_id)} muted playsInline preload="auto"
                       className="w-full aspect-video bg-black rounded border border-zinc-700 object-contain" />
              : <div className="w-full aspect-video bg-zinc-950 rounded border border-zinc-800
                                flex items-center justify-center text-[10px] text-zinc-600">
                  このクリップ範囲を覆う参照クリップがありません
                </div>}
          </div>
        </div>

        {/* ── トランスポート ── */}
        <div className="flex items-center gap-1.5 text-xs">
          <button onClick={() => { setPlaying(false); setCur(0) }}
                  className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">⏮</button>
          <button onClick={() => { setPlaying(false); setCur(c => Math.max(0, c - 1)) }}
                  className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">−1f</button>
          <button onClick={() => setPlaying(p => !p)}
                  className={`px-3 py-1 rounded font-medium ${playing
                    ? 'bg-amber-700 hover:bg-amber-600 text-amber-50' : 'bg-purple-700 hover:bg-purple-600 text-white'}`}>
            {playing ? '⏸ 停止' : '▶ ループ再生'}
          </button>
          <button onClick={() => { setPlaying(false); setCur(c => Math.min(dur - 1, c + 1)) }}
                  className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">+1f</button>
          <span className="font-mono text-zinc-300 ml-2">
            f{cur}<span className="text-zinc-600">/{dur}</span>
            <span className="text-zinc-500 ml-2">素材 f{srcAt(cur).toFixed(1)}</span>
          </span>
          <button onClick={() => addKey(cur)}
                  className="ml-auto px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white">
            ＋ この位置にキーを打つ
          </button>
        </div>

        {/* ── ミニタイムライン: ピン▼ / キー◆(ドラッグ可) / 再生ヘッド ── */}
        <div ref={stripRef}
             className="relative h-14 rounded border border-zinc-700 bg-zinc-950 cursor-crosshair select-none touch-none"
             onPointerDown={e => { (e.target as Element).setPointerCapture?.(e.pointerId); onStripPointer(e) }}
             onPointerMove={e => { if (e.buttons) onStripPointer(e) }}
             onPointerUp={() => { dragKey.current = null }}
             onDoubleClick={e => addKey(frameAt(e.clientX))}>
          {/* 秒目盛り */}
          {Array.from({ length: Math.floor(dur / fps) + 1 }, (_, s) => (
            <div key={s} className="absolute top-0 bottom-0 border-l border-zinc-800"
                 style={{ left: `${s * fps / dur * 100}%` }}>
              <span className="absolute top-0 left-0.5 text-[8px] text-zinc-600">{s}s</span>
            </div>
          ))}
          {/* カット割りピン(合わせ先) */}
          {pins.map((f, i) => (
            <div key={`p${i}`} className="absolute top-0 bottom-0 w-px bg-amber-500/70"
                 style={{ left: `${f / dur * 100}%` }}
                 title={`カット割りピン f${clip.start_frame + f}`}>
              <span className="absolute -top-0.5 -translate-x-1/2 text-amber-400 text-[9px]">▼</span>
            </div>
          ))}
          {/* 区間の速度帯(圧縮=琥珀) */}
          {segs.map((s, i) => s.speed > 1.02 && (
            <div key={`s${i}`} className="absolute bottom-0 h-1 bg-amber-600/60"
                 style={{ left: `${s.from / dur * 100}%`, width: `${(s.to - s.from) / dur * 100}%` }} />
          ))}
          {/* キー◆ */}
          {keys.map((k, i) => (
            <div key={`k${i}`}
                 className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-purple-300 text-sm
                            cursor-ew-resize hover:text-purple-100 z-10"
                 style={{ left: `${k.t / dur * 100}%` }}
                 title={`キー t=f${k.t} src=f${Math.round(k.src)} — ドラッグで移動`}
                 onPointerDown={e => { e.stopPropagation();
                   (e.currentTarget.parentElement as Element).setPointerCapture?.(e.pointerId)
                   dragKey.current = { idx: i } }}>
              ◆
            </div>
          ))}
          {/* 再生ヘッド */}
          <div className="absolute top-0 bottom-0 w-px bg-red-500 z-20"
               style={{ left: `${cur / dur * 100}%` }} />
        </div>
        <p className="text-[9px] text-zinc-600 -mt-2">
          クリック/ドラッグ=シーク　◆ドラッグ=キー移動(素材フレームは固定)　ダブルクリック=キー追加　▼=カット割りピン(合わせ先)　下端の琥珀帯=圧縮区間
        </p>

        {/* ── キー一覧(微調整・コマ打ち) ── */}
        {keys.map((k, i) => (
          <div key={`${k.t}-${i}`} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5
                                              flex items-center gap-2 text-xs text-zinc-200 flex-wrap">
            <button onClick={() => { setPlaying(false); setCur(k.t) }}
                    className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px]"
                    title="この位置へシーク">👁</button>
            <span className="font-mono">t: f{k.t}</span>
            {[-5, -1, +1, +5].map(d => (
              <button key={d} onClick={() => {
                        const ks = keys.map(x => ({ ...x }))
                        const prev = i > 0 ? ks[i - 1].t : 0
                        const next = i < ks.length - 1 ? ks[i + 1].t : dur
                        ks[i].t = Math.min(next - 1, Math.max(prev + 1, ks[i].t + d))
                        save(ks); setCur(ks[i].t)
                      }}
                      className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-purple-800 text-[10px] font-mono">
                {d > 0 ? `+${d}` : d}
              </button>
            ))}
            <span className="font-mono text-zinc-400">src: f{Math.round(k.src)}</span>
            {[-1, +1].map(d => (
              <button key={d} onClick={() => {
                        const ks = keys.map(x => ({ ...x }))
                        ks[i].src = Math.max(0, ks[i].src + d)
                        save(ks)
                      }}
                      className="px-1 py-0.5 rounded bg-zinc-800 hover:bg-sky-900 text-[10px] font-mono"
                      title="素材側のフレームを微調整">{d > 0 ? `+${d}` : d}</button>
            ))}
            <span className="text-[10px] text-zinc-500 ml-1">コマ打ち:</span>
            {HOLDS.map(([v, label]) => (
              <button key={v} onClick={() => { const ks = keys.map(x => ({ ...x })); ks[i].hold = v; save(ks, true) }}
                      className={`px-1.5 py-0.5 rounded border text-[10px] ${(k.hold ?? 0) === v
                        ? 'bg-amber-900/60 border-amber-600 text-amber-200'
                        : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-zinc-700'}`}>
                {label}
              </button>
            ))}
            <button onClick={() => save(keys.filter((_, j) => j !== i), true)}
                    className="ml-auto px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-red-900 text-[10px]">🗑</button>
          </div>
        ))}

        <div className="flex items-center gap-3">
          {segs.length > 0 && (
            <div className="text-[10px] text-zinc-500 flex flex-wrap gap-x-3">
              {segs.map((s, i) => (
                <span key={i} className={s.speed > 1.02 ? 'text-amber-400' : ''}>
                  f{s.from}〜f{s.to}: {s.speed.toFixed(2)}x
                  {s.speed > 1.02 ? '(圧縮→コマ打ち推奨)' : s.speed < 0.98 ? '(間延び)' : ''}
                </span>
              ))}
            </div>
          )}
          {keys.length > 0 && (
            <button onClick={() => save([], true)}
                    className="ml-auto shrink-0 text-[10px] px-2 py-1 rounded border border-zinc-700 text-zinc-400
                               hover:text-red-300 hover:border-red-800">
              リマップを全て解除
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
