// 🎞 スマホ用の「見るだけ」の画面。一覧のカードを押すと、まずここが開く(編集の欄・レイヤーの一覧は読み込まない)。
// 描き出した動画が今の中身と同じなら、その軽い動画(プロキシ)を <video> で再生する。古い・無いときはエンジンのライブ表示。
// 「編集」で編集画面へ進む。

import { memo, useEffect, useRef, useState } from 'react'
import { assetsApi, compsApi, apiErrorText } from '../../api/client'
import { useUIStore } from '../../store/uiStore'
import { useJobStore } from '../../store/jobStore'
import { useCompListStore } from './compList'
import { timecode } from './docOps'
import type { CompSummary } from './types'

const isStale = (c: CompSummary) => c.stale_deep ?? c.stale

/** エンジンのライブ表示(iframe)と、再生・なぞるだけの最小の操作。編集画面のストアは使わない */
const LivePlayer = memo(function LivePlayer({ comp, wide }: { comp: CompSummary; wide: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [quality, setQuality] = useState(0.5)
  const [src] = useState(() => compsApi.playerUrl(comp.id, 0))
  const post = (m: Record<string, unknown>) => ref.current?.contentWindow?.postMessage(m, '*')
  const max = Math.max(1, comp.duration_frames - 1)

  useEffect(() => {
    const on = (ev: MessageEvent) => {
      if (ev.source !== ref.current?.contentWindow) return
      const m = ev.data as { type?: string; [k: string]: unknown }
      if (!m || typeof m.type !== 'string') return
      if (m.type === 'comp:ready') setReady(true)
      else if (m.type === 'comp:frame') setFrame(Number(m.frame) || 0)
      else if (m.type === 'comp:error' && m.level === 'error') setProblem(String(m.message ?? '').slice(0, 200))
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [])
  useEffect(() => { if (ready) ref.current?.contentWindow?.postMessage({ type: 'comp:quality', scale: quality }, '*') }, [ready, quality])
  // 画面を離れたら止める(裏で描き続けない)
  useEffect(() => {
    const on = () => { if (document.visibilityState !== 'visible') { setPlaying(false); ref.current?.contentWindow?.postMessage({ type: 'comp:play', playing: false }, '*') } }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  const toggle = () => {
    const f = !playing && frame >= max ? 0 : frame
    setFrame(f)
    setPlaying(!playing)
    post({ type: 'comp:play', playing: !playing, frame: f })
  }
  const seek = (f: number) => {
    const x = Math.max(0, Math.min(max, Math.round(f)))
    if (playing) { setPlaying(false); post({ type: 'comp:play', playing: false, frame: x }) }
    setFrame(x)
    post({ type: 'comp:seek', frame: x })
  }
  const btn = 'w-11 h-11 flex items-center justify-center rounded-lg text-[17px] leading-none text-zinc-200 active:bg-zinc-700 flex-shrink-0'
  return (
    <div className={`flex flex-col min-h-0 ${wide ? 'flex-1' : ''}`} data-viewer-live>
      <div className={`relative bg-[#17181c] ${wide ? 'flex-1 min-h-0' : ''}`} style={wide ? undefined : { aspectRatio: `${comp.width} / ${comp.height}`, maxHeight: '52dvh', width: '100%' }}>
        {/* 見るだけなので、指の操作は iframe へ渡さない(ページの縦スクロールを邪魔しない) */}
        <iframe ref={ref} title="コンポジションのライブ表示" src={src} className="absolute inset-0 w-full h-full border-0 block pointer-events-none" data-viewer-iframe />
        {!ready && <div className="absolute inset-0 flex items-center justify-center text-[13px] text-zinc-400 pointer-events-none">プレビューを読み込み中…</div>}
        <button className="absolute inset-0 w-full h-full" aria-label="再生 / 停止" onClick={toggle} />
      </div>
      {problem && <div className="px-3 py-1 text-[12px] text-red-200 bg-red-950/60">⛔ {problem}</div>}
      <div className="flex items-center gap-1 px-2 py-1 bg-zinc-900 border-y border-zinc-800 flex-wrap flex-shrink-0" data-viewer-transport>
        <input type="range" className={`comp-range ${wide ? 'order-2 flex-1 min-w-[90px] mx-1' : 'basis-full w-full'}`} min={0} max={max} step={1} value={Math.min(frame, max)} aria-label="再生位置" data-viewer-scrub
               style={{ '--p': `${(Math.min(frame, max) / max) * 100}%` } as React.CSSProperties} onChange={e => seek(Number(e.target.value))} />
        <button className={btn} aria-label="1 コマ戻る" onClick={() => seek(frame - 1)}>◀</button>
        <button className={`${btn} !w-14 !text-[22px] bg-purple-800 text-white active:bg-purple-700`} aria-label="再生 / 停止" onClick={toggle} data-viewer-play>{playing ? '⏸' : '▶'}</button>
        <button className={btn} aria-label="1 コマ進む" onClick={() => seek(frame + 1)}>▶</button>
        <span className={`order-3 flex items-center gap-2 ${wide ? '' : 'ml-auto'}`}>
          <select className="bg-zinc-800 border border-zinc-700 rounded-lg h-10 px-1 text-[16px] text-zinc-200" value={quality} aria-label="画質" data-viewer-quality onChange={e => setQuality(Number(e.target.value))}>
            <option value={0.25}>画質 25%</option><option value={0.5}>画質 50%</option><option value={0.75}>画質 75%</option><option value={1}>画質 100%</option>
          </select>
          <span className="flex flex-col items-end leading-tight font-mono whitespace-nowrap" data-viewer-frame={frame}>
            <span className="text-[13px] text-zinc-100">{frame}<span className="text-zinc-500"> / {comp.duration_frames}</span></span>
            <span className="text-[12px] text-zinc-400">{timecode(frame, comp.fps)}</span>
          </span>
        </span>
      </div>
    </div>
  )
})

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  // サーバの時刻は UTC(末尾に Z が無い)
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
  if (isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function CompViewer({ compId, wide, onEdit }: { compId: number; wide: boolean; onEdit: () => void }) {
  const comp = useCompListStore(s => s.byId[compId])
  const toast = useUIStore(s => s.pushToast)
  // 描き出し中のジョブ(一覧のストアが、終わったら一覧を取り直す)
  const job = useJobStore(s => s.jobs.find(j => (j.job_type as string) === 'render_comp' && (j.status === 'pending' || j.status === 'running')
    && (j.params as { comp_id?: unknown } | undefined)?.comp_id === compId))
  const [asked, setAsked] = useState(false)
  const [renderedAt, setRenderedAt] = useState<{ id: number; at: string | null } | null>(null)
  const [videoErr, setVideoErr] = useState<{ id: number } | null>(null)
  const [pick, setPick] = useState<'video' | 'live' | null>(null)     // 手で選んだほう(選ぶまでは下の既定)

  const assetId = comp?.rendered_asset_id ?? null
  useEffect(() => {
    if (assetId == null) return
    let on = true
    void assetsApi.get(assetId).then(a => { if (on) setRenderedAt({ id: assetId, at: (a as { created_at?: string | null }).created_at ?? null }) }).catch(() => undefined)
    return () => { on = false }
  }, [assetId])

  if (!comp) return <div className="flex-1 flex items-center justify-center text-[14px] text-zinc-400">読み込み中…</div>
  const stale = isStale(comp)
  const hasVideo = assetId != null && videoErr?.id !== assetId
  const fresh = hasVideo && !stale
  const mode: 'video' | 'live' = hasVideo ? (pick ?? (fresh ? 'video' : 'live')) : 'live'
  const rendering = !!job || asked
  const status = comp.rendered_rev === 0 ? '未描き出し' : stale ? '古い' : '描き出し済み'

  const render = async () => {
    setAsked(true)
    try { await compsApi.render(comp.id); toast('描き出しを始めました(終わると、ここが動画に切り替わります)', 'info') }
    catch (e) { toast(`描き出せません: ${apiErrorText(e)}`, 'error') }
    finally { window.setTimeout(() => setAsked(false), 4000) }
  }

  const seg = (id: 'video' | 'live', label: string, disabled = false) => (
    <button key={id} disabled={disabled} aria-pressed={mode === id} data-viewer-mode={id}
            className={`flex-1 h-10 text-[13px] rounded-lg border ${mode === id ? 'bg-purple-800 border-purple-500 text-white' : 'border-zinc-700 text-zinc-300'} disabled:opacity-40`}
            onClick={() => setPick(id)}>{label}</button>
  )
  const info = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between gap-3 py-2 border-b border-zinc-800 text-[14px]"><span className="text-zinc-400 flex-shrink-0">{k}</span><span className="text-zinc-100 text-right min-w-0 break-words">{v}</span></div>
  )

  const player = mode === 'video' && assetId != null ? (
    <div className={`bg-black flex items-center justify-center ${wide ? 'flex-1 min-h-0' : ''}`} data-viewer-video>
      <video key={`${assetId}:${comp.rendered_rev}`} src={`/api/assets/${assetId}/file?proxy=1`} poster={`/api/comps/${comp.id}/thumb?width=480&r=${comp.rev}`}
             controls playsInline loop muted preload="metadata" className={wide ? 'max-w-full max-h-full' : 'w-full'}
             style={wide ? undefined : { aspectRatio: `${comp.width} / ${comp.height}`, maxHeight: '52dvh' }}
             onError={() => { setVideoErr({ id: assetId }); setPick(null) }} />
    </div>
  ) : <LivePlayer key={`${comp.id}:${comp.rev}`} comp={comp} wide={wide} />

  const side = (
    <>
      <div className="flex gap-2 px-3 pt-3" data-viewer-modes>
        {seg('video', fresh ? '▶ 動画(軽い)' : hasVideo ? '▶ 動画(古い描き出し)' : assetId != null ? '▶ 動画(再生できない)' : '▶ 動画(まだ無い)', !hasVideo)}
        {seg('live', '🎞 ライブ表示')}
      </div>
      <div className="px-3 pt-1 text-[12px] text-zinc-400 leading-relaxed">
        {videoErr?.id === assetId && assetId != null ? 'この端末では描き出した動画を再生できませんでした(透明つきの動画など)。ライブ表示に切り替えています。'
          : mode === 'video' ? (fresh ? '描き出した動画(小さいプロキシ)を再生しています。今の中身と同じ絵です。' : '描き出したあとに中身が変わっています。今の絵は「ライブ表示」で。')
          : 'エンジンがその場で描いています(重いコンポジションはカクつきます。画質を下げると軽くなります)。'}
      </div>
      <div className="flex gap-2 px-3 pt-3">
        <button className="flex-1 h-12 rounded-lg bg-purple-700 active:bg-purple-600 text-white text-[15px] font-bold" onClick={onEdit} data-viewer-edit>✏ 編集</button>
        <button className="flex-1 h-12 rounded-lg border border-zinc-600 text-zinc-100 text-[14px] disabled:opacity-50" disabled={rendering || (!stale && comp.rendered_rev !== 0)} onClick={() => void render()} data-viewer-render>
          {job ? `描き出し中 ${job.status === 'pending' ? '(待機)' : `${Math.round((job.progress ?? 0) * 100)}%`}` : asked ? '描き出し中…' : !stale && comp.rendered_rev !== 0 ? '✓ 描き出し済み' : '🎬 描き出し'}
        </button>
      </div>
      <div className="px-3 pt-2 pb-4" data-viewer-info>
        {info('状態', <span className={`px-2 py-0.5 rounded text-[13px] ${stale ? 'bg-amber-600 text-black' : 'bg-emerald-700 text-white'}`} data-viewer-status>{status}</span>)}
        {info('大きさ', `${comp.width} × ${comp.height}`)}
        {info('長さ', `${comp.duration_frames} コマ(${(comp.duration_frames / Math.max(1, comp.fps)).toFixed(2)} 秒)· ${comp.fps} fps`)}
        {info('レイヤー', `${comp.layer_count ?? '?'} 枚`)}
        {info('最後の描き出し', comp.rendered_rev === 0 ? 'まだ' : `${renderedAt?.id === assetId ? fmtDate(renderedAt?.at) : '…'}(版 r${comp.rendered_rev})`)}
        {info('最後の変更', `${fmtDate(comp.updated_at)}(版 r${comp.rev})`)}
        {info('id', `#${comp.id}`)}
      </div>
    </>
  )

  return wide ? (
    <div className="flex-1 min-h-0 flex" data-comp-viewer={comp.id}>
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">{player}</div>
      <div className="w-[320px] flex-shrink-0 border-l border-zinc-800 comp-scroll comp-safe-bottom">{side}</div>
    </div>
  ) : (
    <div className="flex-1 min-h-0 comp-scroll comp-safe-bottom" data-comp-viewer={comp.id}>
      {player}
      {side}
    </div>
  )
}
