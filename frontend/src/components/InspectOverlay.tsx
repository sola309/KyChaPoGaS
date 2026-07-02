import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useUIStore } from '../store/uiStore'

/**
 * UI inspect mode (🎯) — click any element in the app to record WHAT you are
 * pointing at (React component chain + DOM path + text). The capture is
 * appended to backend/data/inspect_log.jsonl, which the AI agent reads when
 * you say 「さっき選択したUI(#N)を◯◯して」. Esc or 🎯 again to exit.
 */

function fiberChain(el: Element): string[] {
  const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fiber: any = key ? (el as any)[key] : null
  const names: string[] = []
  while (fiber && names.length < 8) {
    const t = fiber.type
    const n = typeof t === 'function' ? (t.displayName || t.name)
      : (t && typeof t === 'object' && 'displayName' in t) ? t.displayName : null
    if (n && names[names.length - 1] !== n) names.push(n)
    fiber = fiber.return
  }
  return names
}

function domPath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur !== document.body && parts.length < 5) {
    let s = cur.tagName.toLowerCase()
    if (cur.id) s += `#${cur.id}`
    else if (cur.classList.length) s += '.' + [...cur.classList].slice(0, 3).join('.')
    parts.unshift(s)
    cur = cur.parentElement
  }
  return parts.join(' > ')
}

export function InspectOverlay() {
  const active = useUIStore(s => s.inspectMode)
  const setInspect = useUIStore(s => s.setInspectMode)
  const pushToast = useUIStore(s => s.pushToast)
  const [box, setBox] = useState<DOMRect | null>(null)
  const [label, setLabel] = useState('')
  const target = useRef<Element | null>(null)

  useEffect(() => {
    if (!active) { setBox(null); return }
    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (!el || el.closest('#inspect-hud')) return
      target.current = el
      setBox(el.getBoundingClientRect())
      const chain = fiberChain(el)
      setLabel(chain[0] ? `<${chain[0]}>` : el.tagName.toLowerCase())
    }
    const onClick = async (e: MouseEvent) => {
      const el = target.current
      if (!el || (e.target as Element)?.closest?.('#inspect-hud')) return
      e.preventDefault(); e.stopPropagation()
      const chain = fiberChain(el)
      const r = el.getBoundingClientRect()
      try {
        const res = await api.post('/inspect', {
          component_chain: chain,
          dom_path: domPath(el),
          text: ((el as HTMLElement).innerText || '').slice(0, 120),
          title: el.getAttribute('title') ?? '',
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          html: el.outerHTML.slice(0, 400),
          url: location.pathname + location.hash,
        })
        pushToast(`🎯 #${res.data.id} 記録: ${chain[0] ?? el.tagName} — AIには「選択したUI #${res.data.id}」と伝えればOK`, 'success')
      } catch { pushToast('記録に失敗しました', 'error') }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setInspect(false) }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [active, setInspect, pushToast])

  if (!active) return null
  return (
    <>
      {box && (
        <div className="fixed z-[9998] pointer-events-none border-2 border-sky-400 bg-sky-400/10 rounded"
          style={{ left: box.x - 2, top: box.y - 2, width: box.width + 4, height: box.height + 4 }}>
          <span className="absolute -top-6 left-0 text-[11px] bg-sky-500 text-white px-1.5 py-0.5 rounded whitespace-nowrap">
            {label}
          </span>
        </div>
      )}
      <div id="inspect-hud"
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] bg-sky-600 text-white text-xs px-4 py-2 rounded-full shadow-lg">
        🎯 インスペクトモード: 要素をクリックで記録(AIと共有) / Escで終了
      </div>
    </>
  )
}
