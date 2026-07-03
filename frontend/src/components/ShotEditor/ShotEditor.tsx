import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useUIStore } from '../../store/uiStore'

/**
 * Shot Editor — opens a mad-kit shot as a LIVE DOM scene (iframe), not a video.
 *  - full-quality realtime preview (the scene is vector/DOM, plays via rAF)
 *  - click an object to select it (subject / ornament / sticker / text ...)
 *  - drag to move it (writes x/y back to the shotlist)
 *  - natural-language instructions via local LLM (「このオブジェクトを〇〇して」)
 *  - 「このショットを再レンダー」 re-proxies just this shot (fast)
 */

interface Props {
  projectId: number
  shotId: string
  onClose: () => void
}

interface Pick { path: string; label: string }

type Shot = { id: string; template: string; from: unknown; to: unknown; params: Record<string, unknown> }
type Shotlist = { meta: Record<string, unknown>; shots: Shot[] }

/** resolve "params.ornaments[1]" inside a shot object */
function resolvePath(shot: Shot, path: string): { parent: Record<string, unknown> | null; key: string | number } {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let cur: unknown = shot
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return { parent: null, key: '' }
    cur = (cur as Record<string, unknown>)[parts[i]]
  }
  const last = parts[parts.length - 1]
  return { parent: cur as Record<string, unknown>, key: /^\d+$/.test(last) ? Number(last) : last }
}

export function ShotEditor({ projectId, shotId, onClose }: Props) {
  const iframe = useRef<HTMLIFrameElement>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const [shotlist, setShotlist] = useState<Shotlist | null>(null)
  const [range, setRange] = useState<[number, number]>([0, 1])
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [pick, setPick] = useState<Pick | null>(null)
  const [paramsText, setParamsText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [comments, setComments] = useState<Array<Record<string, unknown>>>([])
  const [commentText, setCommentText] = useState('')
  const pushToast = useUIStore(s => s.pushToast)

  const shot = useMemo(() => shotlist?.shots.find(s => s.id === shotId) ?? null, [shotlist, shotId])

  // load shotlist + shot time range
  useEffect(() => {
    Promise.all([
      api.get(`/mad/${projectId}/shotlist`),
      api.get(`/mad/${projectId}/map`),
    ]).then(([sl, m]) => {
      setShotlist(sl.data)
      const e = m.data.shot_map[shotId]
      if (e) setRange([e.t0, e.t1])
    }).catch(() => pushToast('shotlistの読み込みに失敗', 'error'))
  }, [projectId, shotId, pushToast])

  useEffect(() => {
    if (shot) setParamsText(JSON.stringify(shot.params, null, 2))
  }, [shot])

  const loadComments = useCallback(() => {
    api.get(`/comments/${projectId}`).then(r =>
      setComments(r.data.filter((c: Record<string, unknown>) => c.shot_id === shotId)))
      .catch(() => {})
  }, [projectId, shotId])
  useEffect(() => { loadComments() }, [loadComments])

  async function addComment() {
    if (!commentText.trim()) return
    await api.post(`/comments/${projectId}`, {
      t_sec: Math.round(t * 100) / 100, text: commentText, shot_id: shotId,
      object_path: pick ? pick.path.split(':')[1] : null,
    })
    setCommentText(''); loadComments()
  }
  async function resolveComment(cid: unknown) {
    await api.patch(`/comments/${projectId}/${cid}`, { status: 'resolved' })
    loadComments()
  }

  const post = useCallback((msg: Record<string, unknown>) => {
    iframe.current?.contentWindow?.postMessage(msg, '*')
  }, [])

  // iframe messages: ready / time / pick / drag
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data || {}
      if (m.mk === 'ready') post({ mk: 'play', from: range[0], to: range[1], loop: true })
      else if (m.mk === 'time') {
        setT(m.t); setPlaying(m.playing)
        const a = audio.current
        if (a) {
          // keep the song locked to the scene clock (loop jumps included)
          if (m.playing && a.paused) { a.currentTime = m.t; void a.play().catch(() => {}) }
          if (!m.playing && !a.paused) a.pause()
          if (Math.abs(a.currentTime - m.t) > 0.2) a.currentTime = m.t
        }
      }
      else if (m.mk === 'pick') setPick({ path: m.path, label: m.label })
      else if (m.mk === 'drag' && shotlist) {
        const [sid, sub] = (m.path as string).split(':')
        const sh = shotlist.shots.find(s => s.id === sid)
        if (!sh) return
        const { parent } = resolvePath(sh, sub)
        const obj = parent && typeof parent === 'object'
          ? (resolvePath(sh, sub).parent as Record<string, unknown>)[resolvePath(sh, sub).key as never] : null
        if (obj && typeof obj === 'object') {
          const o = obj as Record<string, number>
          o.x = Math.round((o.x ?? 0) + m.dx)
          o.y = Math.round((o.y ?? 0) + m.dy)
          void saveShotlist({ ...shotlist })
        } else {
          pushToast('この要素はドラッグ移動に未対応です', 'info')
        }
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotlist, range, post])

  async function saveShotlist(next: Shotlist) {
    try {
      await api.put(`/mad/${projectId}/shotlist`, next)
      setShotlist(next)
      post({ mk: 'shotlist', shotlist: next })
      setDirty(false)
    } catch (e) {
      pushToast('保存に失敗(検証エラー)', 'error')
    }
  }

  async function applyParams() {
    if (!shotlist || !shot) return
    try {
      const params = JSON.parse(paramsText)
      const next = { ...shotlist, shots: shotlist.shots.map(s => s.id === shotId ? { ...s, params } : s) }
      await saveShotlist(next)
      pushToast('適用しました', 'success')
    } catch {
      pushToast('paramsのJSONが不正です', 'error')
    }
  }

  async function instruct() {
    if (!instruction.trim()) return
    setBusy('AIが編集中…')
    try {
      const res = await api.post(`/mad/${projectId}/instruct`, {
        shot_id: shotId, instruction,
        object_path: pick ? pick.path.split(':')[1] : null,
      })
      const sl = await api.get(`/mad/${projectId}/shotlist`)
      setShotlist(sl.data)
      post({ mk: 'shotlist', shotlist: sl.data })
      setInstruction('')
      pushToast(`編集を適用しました (engine: ${res.data.engine ?? '?'})`, 'success')
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: { error?: string } } } })?.response?.data?.detail
      pushToast(detail?.error ?? 'AI編集に失敗しました', 'error')
    } finally { setBusy(null) }
  }

  async function reproxy() {
    setBusy('再レンダーを投入…')
    try {
      await api.post(`/mad/${projectId}/shots/${shotId}/reproxy`)
      pushToast('このショットの再レンダーJobを投入しました(完了後タイムラインに反映)', 'success')
    } catch { pushToast('Job投入に失敗', 'error') } finally { setBusy(null) }
  }

  const fmt = (x: number) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-neutral-900 border border-neutral-700 rounded-xl w-full max-w-6xl h-[92vh] flex flex-col overflow-hidden">
        {/* header */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-neutral-700">
          <span className="text-pink-300 font-bold">ショットエディタ</span>
          <span className="text-neutral-300 text-sm">{shotId}</span>
          <span className="text-neutral-500 text-xs">{shot?.template}</span>
          {busy && <span className="text-amber-300 text-xs animate-pulse">{busy}</span>}
          <div className="flex-1" />
          <button onClick={reproxy}
            className="px-3 py-1 rounded bg-pink-700 hover:bg-pink-600 text-sm">このショットを再レンダー</button>
          <button onClick={onClose} className="px-3 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-sm">閉じる</button>
        </div>

        <div className="flex flex-col lg:flex-row flex-1 min-h-0 overflow-y-auto lg:overflow-hidden">
          {/* live scene */}
          <div className="flex-1 flex flex-col min-w-0 min-h-[50vh] lg:min-h-0">
            <div className="flex-1 bg-black relative">
              <iframe ref={iframe} title="shot-scene"
                src={`/api/mad/${projectId}/scene.html`}
                className="absolute inset-0 w-full h-full border-0" />
              <audio ref={audio} src={`/api/mad/${projectId}/music`} preload="auto" />
            </div>
            {/* transport */}
            <div className="flex items-center gap-3 px-4 py-2 border-t border-neutral-700">
              <button
                onClick={() => { playing ? post({ mk: 'pause' }) : post({ mk: 'play', from: range[0], to: range[1], loop: true }) }}
                className="w-9 h-9 rounded-full bg-pink-700 hover:bg-pink-600 text-white">
                {playing ? '❚❚' : '▶'}
              </button>
              <span className="text-xs text-neutral-400 w-14">{fmt(t)}</span>
              <input type="range" min={range[0]} max={range[1]} step={0.01} value={Math.min(Math.max(t, range[0]), range[1])}
                onChange={e => post({ mk: 'seek', t: Number(e.target.value) })}
                className="flex-1 accent-pink-500" />
              <span className="text-xs text-neutral-500">{fmt(range[0])} – {fmt(range[1])}</span>
            </div>
          </div>

          {/* inspector */}
          <div className="w-full lg:w-96 border-t lg:border-t-0 lg:border-l border-neutral-700 flex flex-col min-h-0 flex-shrink-0 lg:flex-shrink">
            <div className="px-3 py-2 border-b border-neutral-800">
              <div className="text-xs text-neutral-400">選択中のオブジェクト(クリックで選択・ドラッグで移動)</div>
              <div className="text-sm text-sky-300 mt-1 break-all">
                {pick ? `${pick.label} — ${pick.path.split(':')[1]}` : '（未選択）'}
              </div>
            </div>
            <div className="flex-1 min-h-0 flex flex-col px-3 py-2">
              <div className="text-xs text-neutral-400 mb-1">params(直接編集も可)</div>
              <textarea value={paramsText}
                onChange={e => { setParamsText(e.target.value); setDirty(true) }}
                spellCheck={false}
                className="flex-1 min-h-0 bg-neutral-950 border border-neutral-700 rounded p-2 text-xs font-mono text-neutral-200 resize-none" />
              <button onClick={applyParams} disabled={!dirty}
                className="mt-2 px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-40 text-sm">適用(ライブ反映)</button>
            </div>
            {/* AI instruction */}
            <div className="border-t border-neutral-700 p-3">
              <div className="text-xs text-neutral-400 mb-1">
                AIに指示(ローカルLLM){pick && <span className="text-sky-400"> — 選択中: {pick.label}</span>}
              </div>
              <div className="flex gap-2">
                <input value={instruction} onChange={e => setInstruction(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void instruct() }}
                  placeholder="例: このちびを2倍にして左下へ"
                  className="flex-1 bg-neutral-950 border border-neutral-700 rounded px-2 py-1.5 text-sm" />
                <button onClick={() => void instruct()} disabled={!!busy}
                  className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm">送信</button>
              </div>
              <div className="text-[11px] text-neutral-500 mt-2">
                重い指示(画像の再生成・新演出)はターミナルパネルのClaude Codeへ:
                「プロジェクト{projectId} の shot {shotId} の {pick ? pick.path.split(':')[1] : '…'} を◯◯して」
              </div>
            </div>
            {/* timeline comments (async instruction queue for the agent) */}
            <div className="border-t border-neutral-700 p-3 max-h-56 overflow-y-auto">
              <div className="text-xs text-neutral-400 mb-1">
                📍 コメント(現在時刻{pick ? '+選択オブジェクト' : ''}にピン留め — AIが後でまとめて対応)
              </div>
              <div className="flex gap-2 mb-2">
                <input value={commentText} onChange={e => setCommentText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void addComment() }}
                  placeholder="例: ここ寂しいので何か足して"
                  className="flex-1 bg-neutral-950 border border-neutral-700 rounded px-2 py-1.5 text-sm" />
                <button onClick={() => void addComment()}
                  className="px-3 py-1.5 rounded bg-amber-700 hover:bg-amber-600 text-sm">📍</button>
              </div>
              {comments.map(c => (
                <div key={String(c.id)} className={`text-xs rounded p-2 mb-1.5 border ${c.status === 'resolved' ? 'border-neutral-800 text-neutral-500' : 'border-amber-800/60 text-neutral-200 bg-amber-950/20'}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-amber-400">#{String(c.id)}</span>
                    <span className="text-neutral-500">{Number(c.t_sec).toFixed(1)}s</span>
                    {typeof c.object_path === 'string' && c.object_path && <span className="text-sky-400 truncate">{String(c.object_path)}</span>}
                    <div className="flex-1" />
                    {c.status !== 'resolved' && (
                      <button onClick={() => void resolveComment(c.id)} className="text-neutral-500 hover:text-emerald-400">✓解決</button>
                    )}
                  </div>
                  <div className="mt-1">{String(c.text)}</div>
                  {typeof c.reply === 'string' && c.reply && <div className="mt-1 text-emerald-300/90">↳ {String(c.reply)}</div>}
                </div>
              ))}
              {!comments.length && <div className="text-[11px] text-neutral-600">コメントはまだありません</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
