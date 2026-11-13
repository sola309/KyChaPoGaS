// 🎞 プレビュー(iframe の中でエンジンが描く)と再生のボタン。
// 文書・再生位置・選択はストアを React の外で購読して postMessage で送る(ここは再生中も描き直さない)。
// エンジンとの約束(tools/comp-kit/README.md の postMessage)に加えて、第 2 期の追加に対応する(届かなければ今までどおり動く):
//   iframe → 親: comp:key(キー操作)/ comp:edit の path = transform.scale・transform.rotation / comp:error(知らせ)
//   親 → iframe: comp:guides {show}(下絵)/ comp:overlay {safe, grid}(セーフ枠・グリッド)

import { memo, useEffect, useRef, useState } from 'react'
import { compsApi } from '../../api/client'
import { useCompStore, savedChildComps } from './store'
import { findLayer, getPath, setPath, setValueAt, timecode, updateLayer } from './docOps'
import { NumField, iconBtnCls, inputCls } from './fields'
import { handleCompKey } from './keys'
import type { CompDoc } from './types'

const SET_DEBOUNCE_MS = 40

/** エンジンが comp:overlay を知っているか(player.html の中身を見て決める。知らなければこの画面で枠を描く) */
let overlayCap: Promise<boolean> | null = null
const engineDrawsOverlay = (src: string) => (overlayCap ??= fetch(src).then(r => (r.ok ? r.text() : '')).then(t => t.includes('comp:overlay')).catch(() => false))

/** 今のコマと時刻(ここだけが再生位置を購読する) */
const FrameReadout = memo(function FrameReadout() {
  const frame = useCompStore(s => s.frame)
  const fps = useCompStore(s => s.settings.fps)
  const dur = useCompStore(s => s.settings.duration_frames)
  const setFrame = useCompStore(s => s.setFrame)
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-zinc-300 font-mono" data-comp-frame={frame}>
      <NumField value={frame} min={0} max={dur - 1} step={1} onChange={setFrame} className="w-[58px]" title="今のコマ(ドラッグ・入力で移動)" />
      <span className="text-zinc-500">/ {dur}</span>
      <span className="text-zinc-400">{timecode(frame, fps)}</span>
    </span>
  )
})

/** スマホ用: 全体をなぞれるスライダー(ここも再生位置を購読する) */
const Scrubber = memo(function Scrubber({ className }: { className?: string }) {
  const frame = useCompStore(s => s.frame)
  const dur = useCompStore(s => s.settings.duration_frames)
  const max = Math.max(1, dur - 1)
  return (
    <input type="range" className={`comp-range ${className ?? ''}`} min={0} max={max} step={1} value={Math.min(frame, max)} data-comp-scrub aria-label="再生位置"
           style={{ '--p': `${(Math.min(frame, max) / max) * 100}%` } as React.CSSProperties}
           onChange={e => { const s = useCompStore.getState(); if (s.playing) s.setPlaying(false); s.setFrame(Number(e.target.value)) }} />
  )
})

/** スマホ用: 今のコマ / 全体 と時刻(文字だけ) */
const FrameText = memo(function FrameText() {
  const frame = useCompStore(s => s.frame)
  const fps = useCompStore(s => s.settings.fps)
  const dur = useCompStore(s => s.settings.duration_frames)
  return (
    <span className="flex flex-col items-end leading-tight font-mono whitespace-nowrap" data-comp-frame={frame}>
      <span className="text-[13px] text-zinc-100">{frame}<span className="text-zinc-500"> / {dur}</span></span>
      <span className="text-[12px] text-zinc-400">{timecode(frame, fps)}</span>
    </span>
  )
})

/** エンジンからの知らせ(comp:error)。押すとそのレイヤーを選ぶ */
const Problems = memo(function Problems() {
  const problems = useCompStore(s => s.problems)
  const [open, setOpen] = useState(false)
  if (!problems.length) return null
  const nErr = problems.filter(p => p.level === 'error').length
  const pick = (id?: string) => {
    if (!id) return
    const s = useCompStore.getState()
    if (!findLayer(s.doc, id)) return
    s.setSel([id]); s.revealLayer(id)
  }
  return (
    <div className="border-t border-zinc-800 bg-zinc-900 flex-shrink-0" data-comp-problems={problems.length}>
      <div className="flex items-center gap-2 px-2 py-0.5">
        <button className={`text-[10px] ${nErr ? 'text-red-300' : 'text-amber-300'} hover:text-white`} onClick={() => setOpen(o => !o)} data-problems-toggle>
          {open ? '▾' : '▸'} ⚠ エンジンからの知らせ {problems.length} 件{nErr ? `(エラー ${nErr})` : ''}
        </button>
        <button className="ml-auto text-[10px] text-zinc-500 hover:text-white" onClick={() => useCompStore.getState().clearProblems()}>消す</button>
      </div>
      {open && (
        <div className="max-h-[110px] overflow-y-auto px-2 pb-1 flex flex-col gap-0.5">
          {problems.map((p, i) => (
            <button key={i} className={`text-left text-[10px] leading-snug px-1 rounded hover:bg-zinc-800 ${p.level === 'error' ? 'text-red-200' : 'text-amber-100/90'} ${p.layer_id ? '' : 'cursor-default'}`}
                    data-problem-layer={p.layer_id ?? ''} title={p.layer_id ? 'このレイヤーを選ぶ' : ''} onClick={() => pick(p.layer_id)}>
              {p.level === 'error' ? '⛔' : '⚠'} {p.layer_id && <span className="font-mono text-zinc-400">[{p.layer_id}] </span>}{p.message}{p.count > 1 && <span className="text-zinc-500"> ×{p.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

/** セーフ枠・グリッド(エンジンが描かないときの、この画面での描画) */
function OverlayFallback({ w, h, safe, grid }: { w: number; h: number; safe: boolean; grid: boolean }) {
  const cell = Math.max(8, Math.round(w / 16))
  const lines: React.ReactNode[] = []
  if (grid) {
    for (let x = w / 2 % cell; x < w; x += cell) lines.push(<line key={`x${x}`} x1={x} y1={0} x2={x} y2={h} />)
    for (let y = h / 2 % cell; y < h; y += cell) lines.push(<line key={`y${y}`} x1={0} y1={y} x2={w} y2={y} />)
  }
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="xMidYMid meet" data-overlay-fallback>
      {grid && <g stroke="rgba(255,255,255,0.22)" strokeWidth={1} vectorEffect="non-scaling-stroke">{lines}</g>}
      {grid && <g stroke="rgba(255,255,255,0.5)" strokeWidth={1}><line x1={w / 2} y1={0} x2={w / 2} y2={h} vectorEffect="non-scaling-stroke" /><line x1={0} y1={h / 2} x2={w} y2={h / 2} vectorEffect="non-scaling-stroke" /></g>}
      {safe && (
        <g fill="none" strokeWidth={1}>
          <rect x={w * 0.05} y={h * 0.05} width={w * 0.9} height={h * 0.9} stroke="rgba(120,220,255,0.8)" vectorEffect="non-scaling-stroke" />
          <rect x={w * 0.1} y={h * 0.1} width={w * 0.8} height={h * 0.8} stroke="rgba(255,210,90,0.8)" vectorEffect="non-scaling-stroke" />
        </g>
      )}
    </svg>
  )
}

interface PreviewProps {
  compId: number
  /** スマホの並び。portrait = 上に固定の高さで置く / landscape = 左に置く。省略 = PC の並び(今までどおり) */
  compact?: 'portrait' | 'landscape'
  /** portrait のときの絵の高さ(px) */
  stageHeight?: number
  /** 最初の画質(0 = 自動)。スマホでは 0.5 から始める */
  defaultQuality?: number
  /** 再生のボタンの段を出さない(画面キーボードが出ている間) */
  hideTransport?: boolean
}

export const PreviewPane = memo(function PreviewPane({ compId, compact, stageHeight, defaultQuality = 0, hideTransport }: PreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [quality, setQuality] = useState(defaultQuality)
  const [menuOpen, setMenuOpen] = useState(false)
  const [zoom, setZoom] = useState(0)          // 0 = 窓に合わせる
  const [guides, setGuides] = useState(true)
  const [safe, setSafe] = useState(false)
  const [grid, setGrid] = useState(false)
  const [engineOverlay, setEngineOverlay] = useState(true)   // 分かるまではエンジンに任せる(二重に描かない)
  const guidesRef = useRef(true)
  const resend = useRef<() => void>(() => undefined)
  const playing = useCompStore(s => s.playing)
  const loop = useCompStore(s => s.loop)
  const width = useCompStore(s => s.settings.width)
  const height = useCompStore(s => s.settings.height)
  const hasGuides = useCompStore(s => s.doc.layers.some(l => l.guide))
  // 開いたときのコマで最初の絵を出す(src は compId ごとに 1 回だけ決める)
  const [src] = useState(() => compsApi.playerUrl(compId, useCompStore.getState().frame))

  useEffect(() => { let on = true; void engineDrawsOverlay(src).then(v => { if (on) setEngineOverlay(v) }); return () => { on = false } }, [src])

  useEffect(() => {
    const st = useCompStore
    let readyNow = false
    let setTimer: number | null = null
    let seekRaf = 0
    let fromIframe = false
    let iframeDragging = false
    let lastPlayFrame = -1
    const post = (m: Record<string, unknown>) => { if (readyNow) iframeRef.current?.contentWindow?.postMessage(m, '*') }
    const compMsg = () => {
      const s = st.getState()
      // 下絵を出さないとき: エンジンが comp:guides を知らなくても消えるよう、下絵のレイヤーを非表示にして送る(文書は変えない)
      const data: CompDoc = guidesRef.current || !s.doc.layers.some(l => l.guide) ? s.doc
        : { ...s.doc, layers: s.doc.layers.map(l => (l.guide ? { ...l, visible: false } : l)) }
      return { id: s.comp?.id ?? compId, name: s.comp?.name ?? '', ...s.settings, data }
    }
    const sendSet = () => {
      if (setTimer != null) { window.clearTimeout(setTimer); setTimer = null }
      post({ type: 'comp:set', comp: compMsg() })
    }
    resend.current = sendSet
    const scheduleSet = () => {
      if (iframeDragging || setTimer != null) return
      setTimer = window.setTimeout(() => { setTimer = null; sendSet() }, SET_DEBOUNCE_MS)
    }

    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return
      const m = ev.data as { type?: string; [k: string]: unknown }
      if (!m || typeof m.type !== 'string') return
      const s = st.getState()
      switch (m.type) {
        case 'comp:ready': {
          readyNow = true
          setReady(true)
          // 保存前の編集があるかもしれないので、今の文書・選択・位置を送り直す
          sendSet()
          post({ type: 'comp:select', ids: s.sel })
          post({ type: 'comp:seek', frame: s.frame })
          // この画面で保存し直した子コンポジションを読み直させる
          for (const id of savedChildComps) if (id !== compId) post({ type: 'comp:invalidate', comp_id: id })
          break
        }
        case 'comp:frame': {
          const f = Number(m.frame) || 0
          if (!s.playing) break
          if (!s.loop && lastPlayFrame >= 0 && f < lastPlayFrame) {
            // ループなし: 最後まで行ったら止める
            lastPlayFrame = -1
            s.setPlaying(false)
            s.setFrame(s.settings.duration_frames - 1)
            break
          }
          lastPlayFrame = f
          fromIframe = true
          s.setFrame(f)
          fromIframe = false
          break
        }
        case 'comp:select': {
          const ids = Array.isArray(m.ids) ? m.ids.map(String) : []
          s.setFocusArea('preview')
          fromIframe = true
          s.setSel(ids)
          fromIframe = false
          // 行を見える所へ(数百レイヤーの文書で、選んだレイヤーの行を探さなくて済むように)
          if (ids.length) s.revealLayer(ids[ids.length - 1])
          break
        }
        case 'comp:edit': {
          const id = String(m.id), path = String(m.path || '')
          const l = findLayer(s.doc, id)
          const final = !!m.final
          if (!l || !path || l.locked) { iframeDragging = false; if (final) sendSet(); break }
          iframeDragging = !final
          s.setFocusArea('preview')
          // path: transform.position / transform.scale / transform.rotation。キーつき(keyframed)ならそのコマにキーを打つ(置き換える)。そうでなければ定数を書く
          const f = typeof m.frame === 'number' ? m.frame : s.frame
          s.commit(updateLayer(s.doc, id, x => setPath(x, path, setValueAt(getPath(x, path), f, m.value))), { coalesce: `iframe:${id}:${path}` })
          if (final) { s.endCoalesce(); sendSet() }
          break
        }
        case 'comp:key': {
          // プレビューにフォーカスがある間のキー操作。window の keydown と同じ処理へ
          // (第 1 期の「押したあとフォーカスを編集画面へ戻す」回避策は、この知らせが届くのを確かめて外した)
          s.setFocusArea('preview')
          handleCompKey({ key: String(m.key ?? ''), code: typeof m.code === 'string' ? m.code : undefined, ctrl: !!m.ctrl, shift: !!m.shift, alt: !!m.alt, meta: !!m.meta })
          break
        }
        case 'comp:error':
          s.addProblem({ level: m.level, message: m.message, layer_id: m.layer_id })
          break
      }
    }
    window.addEventListener('message', onMessage)
    const unsub = st.subscribe((s, p) => {
      if (s.doc !== p.doc || s.settings !== p.settings) scheduleSet()
      if (s.frame !== p.frame && !fromIframe) {
        if (!seekRaf) seekRaf = requestAnimationFrame(() => { seekRaf = 0; post({ type: 'comp:seek', frame: st.getState().frame }) })
      }
      if (s.sel !== p.sel && !fromIframe) post({ type: 'comp:select', ids: s.sel })
      if (s.playing !== p.playing) {
        lastPlayFrame = -1
        post({ type: 'comp:play', playing: s.playing, frame: s.frame })
      }
    })
    return () => {
      window.removeEventListener('message', onMessage)
      unsub()
      if (setTimer != null) window.clearTimeout(setTimer)
      cancelAnimationFrame(seekRaf)
      if (st.getState().playing) st.getState().setPlaying(false)
    }
  }, [compId])

  const postNow = (m: Record<string, unknown>) => iframeRef.current?.contentWindow?.postMessage(m, '*')
  useEffect(() => { if (ready) postNow({ type: 'comp:quality', scale: quality }) }, [quality, ready])
  useEffect(() => { if (ready) postNow({ type: 'comp:overlay', safe, grid }) }, [safe, grid, ready])
  useEffect(() => {
    guidesRef.current = guides
    if (!ready) return
    postNow({ type: 'comp:guides', show: guides })
    resend.current()
  }, [guides, ready])

  const st = useCompStore.getState
  const togglePlay = () => {
    const s = st()
    if (!s.playing && s.frame >= s.settings.duration_frames - 1) s.setFrame(0)
    s.setPlaying(!s.playing)
  }
  const step = (d: number) => { const s = st(); if (s.playing) s.setPlaying(false); s.setFrame(s.frame + d) }
  const tgl = (on: boolean) => `${iconBtnCls} !px-1.5 border ${on ? 'border-purple-500 text-purple-200 bg-purple-950/60' : 'border-transparent'}`
  const fallbackOverlay = !engineOverlay && (safe || grid)

  const qualitySelect = (
    <select className={inputCls} value={quality} data-preview-quality onChange={e => setQuality(Number(e.target.value))} title="プレビューを描く解像度(描き出しは常に 100%)">
      <option value={0}>自動</option><option value={1}>100%</option><option value={0.75}>75%</option><option value={0.5}>50%</option><option value={0.25}>25%</option>
    </select>
  )
  const portrait = compact === 'portrait'
  const bigBtn = 'w-11 h-11 flex items-center justify-center rounded-lg text-[17px] leading-none text-zinc-200 active:bg-zinc-700 flex-shrink-0'

  return (
    <div className={`flex flex-col min-h-0 min-w-0 bg-[#17181c] ${portrait ? 'flex-none' : 'flex-1'}`} data-comp-preview-pane={compact ?? 'desktop'}>
      <div className={`${portrait ? 'flex-none' : 'flex-1'} min-h-0 relative ${zoom ? 'overflow-auto' : 'overflow-hidden'}`} style={portrait ? { height: stageHeight ?? 220 } : undefined}>
        <div className="relative" style={zoom ? { width: Math.max(320, width * zoom + 40), height: Math.max(180, height * zoom + 40) } : { width: '100%', height: '100%' }}>
          <iframe
            ref={iframeRef}
            title="コンポジションのプレビュー"
            src={src}
            data-comp-preview
            className="block border-0 w-full h-full"
          />
          {fallbackOverlay && <OverlayFallback w={width} h={height} safe={safe} grid={grid} />}
        </div>
        {!ready && <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500 pointer-events-none">プレビューを読み込み中…</div>}
      </div>
      <Problems />
      {compact && !hideTransport && (
        <div className="relative flex items-center gap-1 px-2 py-1 border-t border-zinc-800 bg-zinc-900 flex-shrink-0 flex-wrap" data-comp-transport>
          <Scrubber className={portrait ? 'basis-full w-full' : 'order-2 flex-1 min-w-[90px] mx-1'} />
          <button className={bigBtn} aria-label="1 コマ戻る" onClick={() => step(-1)} data-comp-step="-1">◀</button>
          <button className={`${bigBtn} !w-14 !text-[22px] bg-purple-800 text-white active:bg-purple-700`} aria-label="再生 / 停止" onClick={togglePlay} data-comp-play>{playing ? '⏸' : '▶'}</button>
          <button className={bigBtn} aria-label="1 コマ進む" onClick={() => step(1)} data-comp-step="1">▶</button>
          {portrait && <button className={`${bigBtn} ${loop ? '' : 'opacity-40 grayscale'}`} aria-label="ループ再生" aria-pressed={loop} onClick={() => st().setLoop(!loop)}>🔁</button>}
          <span className={`order-3 flex items-center gap-1 ${portrait ? 'ml-auto' : ''}`}>
            <FrameText />
            <button className={`${bigBtn} ${menuOpen ? 'bg-zinc-700' : ''}`} aria-label="プレビューの設定" data-preview-menu-btn onClick={() => setMenuOpen(o => !o)}>⚙</button>
          </span>
          {menuOpen && (<>
            <div className="fixed inset-0 z-[60]" onPointerDown={() => setMenuOpen(false)} />
            <div className="absolute right-2 bottom-full mb-1 z-[61] w-[250px] rounded-lg border border-zinc-600 bg-zinc-900 shadow-2xl p-3 flex flex-col gap-2 text-[13px] text-zinc-200" data-preview-menu>
              <label className="flex items-center justify-between gap-2">画質(軽さ){qualitySelect}</label>
              <label className="flex items-center justify-between gap-2">ループ再生<input type="checkbox" checked={loop} onChange={e => st().setLoop(e.target.checked)} /></label>
              <label className="flex items-center justify-between gap-2">下絵{hasGuides ? '' : '(なし)'}<input type="checkbox" checked={guides} data-toggle-guides={guides ? '1' : '0'} onChange={e => setGuides(e.target.checked)} /></label>
              <label className="flex items-center justify-between gap-2">セーフ枠<input type="checkbox" checked={safe} data-toggle-safe={safe ? '1' : '0'} onChange={e => setSafe(e.target.checked)} /></label>
              <label className="flex items-center justify-between gap-2">グリッド<input type="checkbox" checked={grid} data-toggle-grid={grid ? '1' : '0'} onChange={e => setGrid(e.target.checked)} /></label>
              <div className="flex gap-2">
                <button className="flex-1 rounded border border-zinc-700 text-[13px]" onClick={() => { const s = st(); s.setPlaying(false); s.setFrame(0) }}>⏮ 先頭</button>
                <button className="flex-1 rounded border border-zinc-700 text-[13px]" onClick={() => { const s = st(); s.setPlaying(false); s.setFrame(s.settings.duration_frames - 1) }}>最後 ⏭</button>
              </div>
            </div>
          </>)}
        </div>
      )}
      {!compact && <div className="flex items-center gap-1 px-2 py-1 border-t border-zinc-800 bg-zinc-900 flex-shrink-0 flex-wrap">
        <button className={iconBtnCls} title="先頭へ(Home)" onClick={() => { const s = st(); s.setPlaying(false); s.setFrame(0) }}>⏮</button>
        <button className={iconBtnCls} title="1 コマ戻る(, または ←)" onClick={() => step(-1)}>◀</button>
        <button className={`${iconBtnCls} text-[13px] w-7 ${playing ? 'text-purple-300' : 'text-zinc-100'}`} title="再生 / 停止(Space)" onClick={togglePlay} data-comp-play>
          {playing ? '⏸' : '▶'}
        </button>
        <button className={iconBtnCls} title="1 コマ進む(. または →)" onClick={() => step(1)}>▶</button>
        <button className={iconBtnCls} title="最後へ(End)" onClick={() => { const s = st(); s.setPlaying(false); s.setFrame(s.settings.duration_frames - 1) }}>⏭</button>
        <button className={`${iconBtnCls} ${loop ? 'text-purple-300' : ''}`} title="ループ再生" onClick={() => st().setLoop(!loop)}>🔁</button>
        <span className="mx-1"><FrameReadout /></span>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-zinc-500">
          <button className={tgl(guides)} data-toggle-guides={guides ? '1' : '0'} onClick={() => setGuides(v => !v)}
                  title={`下絵(guide のレイヤー)を出す / 隠す。書き出しには元から出ません${hasGuides ? '' : '(この文書に下絵はありません)'}`}>下絵</button>
          <button className={tgl(safe)} data-toggle-safe={safe ? '1' : '0'} onClick={() => setSafe(v => !v)} title="セーフ枠(外 = 90% / 内 = 80%)">セーフ枠</button>
          <button className={tgl(grid)} data-toggle-grid={grid ? '1' : '0'} onClick={() => setGrid(v => !v)} title="グリッド">グリッド</button>
          <span className="ml-1">画質</span>
          {qualitySelect}
          表示
          <select className={inputCls} value={zoom} data-preview-fit onChange={e => setZoom(Number(e.target.value))} title="プレビューの大きさ">
            <option value={0}>窓に合わせる</option><option value={0.25}>25%</option><option value={0.5}>50%</option><option value={1}>100%</option><option value={2}>200%</option>
          </select>
        </span>
      </div>}
    </div>
  )
})
