// 🎞 プレビュー(iframe の中でエンジンが描く)と再生のボタン。
// 文書・再生位置・選択はストアを React の外で購読して postMessage で送る(ここは再生中も描き直さない)。

import { memo, useEffect, useRef, useState } from 'react'
import { compsApi } from '../../api/client'
import { useCompStore, savedChildComps } from './store'
import { findLayer, getPath, setPath, setValueAt, timecode, updateLayer } from './docOps'
import { NumField, iconBtnCls, inputCls } from './fields'

const SET_DEBOUNCE_MS = 40

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

export const PreviewPane = memo(function PreviewPane({ compId }: { compId: number }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [quality, setQuality] = useState(0)
  const [zoom, setZoom] = useState(0)          // 0 = 窓に合わせる
  const playing = useCompStore(s => s.playing)
  const loop = useCompStore(s => s.loop)
  const width = useCompStore(s => s.settings.width)
  const height = useCompStore(s => s.settings.height)
  // 開いたときのコマで最初の絵を出す(src は compId ごとに 1 回だけ決める)
  const [src] = useState(() => compsApi.playerUrl(compId, useCompStore.getState().frame))

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
      return { id: s.comp?.id ?? compId, name: s.comp?.name ?? '', ...s.settings, data: s.doc }
    }
    const sendSet = () => {
      if (setTimer != null) { window.clearTimeout(setTimer); setTimer = null }
      post({ type: 'comp:set', comp: compMsg() })
    }
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
          fromIframe = true
          s.setSel(ids)
          fromIframe = false
          break
        }
        case 'comp:edit': {
          const id = String(m.id), path = String(m.path || '')
          const l = findLayer(s.doc, id)
          const final = !!m.final
          if (!l || !path || l.locked) { iframeDragging = false; if (final) sendSet(); break }
          iframeDragging = !final
          const f = typeof m.frame === 'number' ? m.frame : s.frame
          // キーつきならそのコマにキーを打つ(置き換える)。そうでなければ定数を書く
          s.commit(updateLayer(s.doc, id, x => setPath(x, path, setValueAt(getPath(x, path), f, m.value))), { coalesce: `iframe:${id}:${path}` })
          if (final) { s.endCoalesce(); sendSet() }
          break
        }
      }
    }
    window.addEventListener('message', onMessage)
    // プレビューを押すとキー入力が iframe に行ってしまう(Space や Delete が効かなくなる)ので、編集画面へ戻す
    const refocus = () => {
      if (document.activeElement === iframeRef.current) (document.querySelector('[data-comp-editor]') as HTMLElement | null)?.focus({ preventScroll: true })
    }
    const onBlur = () => window.setTimeout(refocus, 60)
    window.addEventListener('blur', onBlur)

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
      window.removeEventListener('blur', onBlur)
      unsub()
      if (setTimer != null) window.clearTimeout(setTimer)
      cancelAnimationFrame(seekRaf)
      if (st.getState().playing) st.getState().setPlaying(false)
    }
  }, [compId])

  useEffect(() => {
    if (ready) iframeRef.current?.contentWindow?.postMessage({ type: 'comp:quality', scale: quality }, '*')
  }, [quality, ready])

  const st = useCompStore.getState
  const togglePlay = () => {
    const s = st()
    if (!s.playing && s.frame >= s.settings.duration_frames - 1) s.setFrame(0)
    s.setPlaying(!s.playing)
  }
  const step = (d: number) => { const s = st(); if (s.playing) s.setPlaying(false); s.setFrame(s.frame + d) }

  return (
    <div className="flex flex-col min-h-0 min-w-0 flex-1 bg-[#17181c]">
      <div className={`flex-1 min-h-0 relative ${zoom ? 'overflow-auto' : 'overflow-hidden'}`}>
        <iframe
          ref={iframeRef}
          title="コンポジションのプレビュー"
          src={src}
          data-comp-preview
          className="block border-0"
          style={zoom ? { width: Math.max(320, width * zoom + 40), height: Math.max(180, height * zoom + 40) } : { width: '100%', height: '100%' }}
        />
        {!ready && <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500 pointer-events-none">プレビューを読み込み中…</div>}
      </div>
      <div className="flex items-center gap-1 px-2 py-1 border-t border-zinc-800 bg-zinc-900 flex-shrink-0 flex-wrap">
        <button className={iconBtnCls} title="先頭へ(Home)" onClick={() => { const s = st(); s.setPlaying(false); s.setFrame(0) }}>⏮</button>
        <button className={iconBtnCls} title="1 コマ戻る(←)" onClick={() => step(-1)}>◀</button>
        <button className={`${iconBtnCls} text-[13px] w-7 ${playing ? 'text-purple-300' : 'text-zinc-100'}`} title="再生 / 停止(Space)" onClick={togglePlay} data-comp-play>
          {playing ? '⏸' : '▶'}
        </button>
        <button className={iconBtnCls} title="1 コマ進む(→)" onClick={() => step(1)}>▶</button>
        <button className={iconBtnCls} title="最後へ(End)" onClick={() => { const s = st(); s.setPlaying(false); s.setFrame(s.settings.duration_frames - 1) }}>⏭</button>
        <button className={`${iconBtnCls} ${loop ? 'text-purple-300' : ''}`} title="ループ再生" onClick={() => st().setLoop(!loop)}>🔁</button>
        <span className="mx-1"><FrameReadout /></span>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-zinc-500">
          画質
          <select className={inputCls} value={quality} onChange={e => setQuality(Number(e.target.value))} title="プレビューを描く解像度(描き出しは常に 100%)">
            <option value={0}>自動</option><option value={1}>100%</option><option value={0.75}>75%</option><option value={0.5}>50%</option><option value={0.25}>25%</option>
          </select>
          表示
          <select className={inputCls} value={zoom} onChange={e => setZoom(Number(e.target.value))} title="プレビューの大きさ">
            <option value={0}>窓に合わせる</option><option value={0.25}>25%</option><option value={0.5}>50%</option><option value={1}>100%</option><option value={2}>200%</option>
          </select>
        </span>
      </div>
    </div>
  )
})
