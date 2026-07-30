import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api/client'

// 📖 リファレンス: 映像用語カタログ + 実装機能一覧。
// 右パネル幅では読みにくいため、本体は大型モーダルで表示する。

interface VocabItem { key: string; name: string; desc: string }
interface VocabCat { id: string; name: string; hint?: string; items: VocabItem[] }

const CAT_ICON: Record<string, string> = {
  templates: '🎬', fx: '⚡', on: '🎯', enter: '🚪', idle: '〰️', emph: '💥',
  ambient: '❄️', pattern: '🧱', shader: '🌈', camera3d: '🎥', style3d: '🧊',
  grade: '🎨', transition: '🔀', music: '🎵',
}

export function ReferencePanel() {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
      <span className="text-4xl">📖</span>
      <p className="text-xs text-zinc-400 text-center leading-relaxed">
        映像用語カタログと実装機能一覧。<br />
        AIも同じカタログを参照するので、ここの正式名称で指示すると齟齬がありません。
      </p>
      <button onClick={() => setOpen(true)}
        className="px-4 py-2 rounded bg-purple-700 hover:bg-purple-600 text-white text-sm">
        リファレンスを開く
      </button>
      {open && <ReferenceModal onClose={() => setOpen(false)} />}
    </div>
  )
}

function ReferenceModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'vocab' | 'features'>('vocab')
  const [cats, setCats] = useState<VocabCat[]>([])
  const [features, setFeatures] = useState('')
  const [q, setQ] = useState('')
  const [activeCat, setActiveCat] = useState<string | null>(null)
  const mainRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.get('/mad/reference/vocab').then(r => setCats(r.data.categories ?? [])).catch(() => {})
    api.get('/mad/reference/features').then(r => setFeatures(r.data.markdown ?? '')).catch(() => {})
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const filtered = useMemo(() => {
    let base = cats
    if (q.trim()) {
      const needle = q.trim().toLowerCase()
      base = cats.map(c => ({ ...c, items: c.items.filter(i =>
        i.key.toLowerCase().includes(needle) || i.name.includes(q.trim()) || i.desc.includes(q.trim())) }))
        .filter(c => c.items.length > 0)
    } else if (activeCat) {
      base = cats.filter(c => c.id === activeCat)
    }
    return base
  }, [cats, q, activeCat])

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="w-[88vw] h-[86vh] max-w-6xl bg-zinc-925 bg-zinc-900 rounded-xl border border-zinc-700 shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>
        {/* ヘッダー */}
        <div className="flex items-center gap-4 px-5 py-3 border-b border-zinc-800 flex-shrink-0">
          <span className="text-lg font-bold text-zinc-100">📖 リファレンス</span>
          <div className="flex rounded-lg overflow-hidden border border-zinc-700">
            {([['vocab', '映像用語'], ['features', '機能一覧']] as const).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`px-4 py-1.5 text-sm ${tab === id
                  ? 'bg-purple-700 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>
                {label}
              </button>
            ))}
          </div>
          {tab === 'vocab' && (
            <input value={q} onChange={e => setQ(e.target.value)} autoFocus
              placeholder="🔍 検索（例: グリッチ / glitch / 拍 / カメラ）"
              className="flex-1 max-w-md bg-zinc-800 text-sm text-zinc-100 rounded-lg px-3 py-1.5 outline-none border border-zinc-700 focus:border-purple-500" />
          )}
          <button onClick={onClose}
            className="ml-auto w-8 h-8 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 text-lg">✕</button>
        </div>

        <div className="flex flex-1 min-h-0">
          {tab === 'vocab' ? (
            <>
              {/* カテゴリナビ */}
              <div className="w-52 flex-shrink-0 overflow-y-auto border-r border-zinc-800 py-2">
                <button onClick={() => { setActiveCat(null); setQ('') }}
                  className={`w-full text-left px-4 py-2 text-sm ${!activeCat && !q
                    ? 'text-purple-300 bg-purple-950/40' : 'text-zinc-400 hover:bg-zinc-800'}`}>
                  すべて
                </button>
                {cats.map(c => (
                  <button key={c.id} onClick={() => { setActiveCat(c.id); setQ(''); mainRef.current?.scrollTo(0, 0) }}
                    className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2 ${activeCat === c.id
                      ? 'text-purple-300 bg-purple-950/40' : 'text-zinc-400 hover:bg-zinc-800'}`}>
                    <span>{CAT_ICON[c.id] ?? '・'}</span>
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className="text-[10px] text-zinc-600">{c.items.length}</span>
                  </button>
                ))}
              </div>
              {/* 本文 */}
              <div ref={mainRef} className="flex-1 overflow-y-auto px-6 py-4">
                {filtered.length === 0 && (
                  <p className="text-zinc-500 text-sm mt-8 text-center">該当なし</p>
                )}
                {filtered.map(c => (
                  <section key={c.id} className="mb-7">
                    <h2 className="text-base font-semibold text-purple-300 mb-1 flex items-baseline gap-3">
                      <span>{CAT_ICON[c.id] ?? ''} {c.name}</span>
                      {c.hint && <span className="text-xs text-zinc-500 font-normal">{c.hint}</span>}
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2 mt-2">
                      {c.items.map(i => (
                        <div key={i.key} className="bg-zinc-800/60 rounded-lg px-3 py-2.5 border border-zinc-800 hover:border-zinc-600">
                          <div className="flex items-center gap-2 mb-1">
                            <code className="text-[13px] text-emerald-300 font-mono bg-zinc-900 rounded px-1.5 py-0.5">{i.key}</code>
                            <span className="text-sm text-zinc-100 font-medium">{i.name}</span>
                          </div>
                          <p className="text-xs text-zinc-400 leading-relaxed">{i.desc}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </>
          ) : (
            <div className="flex-1 overflow-y-auto px-8 py-5">
              <div className="max-w-3xl">
                {features.split('\n').map((line, i) => {
                  if (line.startsWith('# ')) return <h1 key={i} className="text-xl font-bold text-zinc-100 mb-3">{line.slice(2)}</h1>
                  if (line.startsWith('## ')) return <h2 key={i} className="text-base font-semibold text-purple-300 mt-6 mb-2 pb-1 border-b border-zinc-800">{line.slice(3)}</h2>
                  if (line.startsWith('- ')) return (
                    <p key={i} className="text-sm text-zinc-300 leading-relaxed pl-4 mb-1.5"
                       dangerouslySetInnerHTML={{ __html: '・' + line.slice(2).replace(/\*\*(.+?)\*\*/g, '<b class="text-white">$1</b>').replace(/`(.+?)`/g, '<code class="text-emerald-300 bg-zinc-800 rounded px-1">$1</code>') }} />
                  )
                  if (!line.trim()) return null
                  return <p key={i} className="text-xs text-zinc-500 mb-2">{line}</p>
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
