import { useEffect, useRef, useState } from 'react'
import { PuppetStage, type PuppetManifest, type PuppetParams } from './PuppetStage'

/**
 * CompanionView — the AI companion app (first slice): a See-Through character
 * rigged into a living puppet (breath / blink / sway), with manual controls to
 * prove Stage③ (rigging) + Stage④ (motion). Conversation/TTS comes later.
 */
export function CompanionView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<PuppetStage | null>(null)
  const [puppets, setPuppets] = useState<{ id: string; name: string }[]>([])
  const [pid, setPid] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [params, setParams] = useState<PuppetParams>({ headTurn: 0, headNod: 0, talk: 0, expression: 'neutral' })

  useEffect(() => {
    fetch('/api/puppet/').then(r => r.json()).then(d => {
      setPuppets(d.puppets ?? [])
      if (d.puppets?.[0]) setPid(d.puppets[0].id)
    }).catch(() => setError('パペット一覧の取得に失敗'))
  }, [])

  // (re)build the stage when the selected puppet changes
  useEffect(() => {
    if (!pid || !canvasRef.current) return
    let disposed = false
    setLoading(true); setError(null)
    stageRef.current?.destroy()
    const stage = new PuppetStage()
    stageRef.current = stage
    ;(async () => {
      try {
        const manifest: PuppetManifest = await fetch(`/api/puppet/${pid}/manifest`).then(r => r.json())
        if (disposed) return
        await stage.init(canvasRef.current!, `/api/puppet/${pid}/layer/`, manifest)
        stage.params = params
      } catch {
        if (!disposed) setError('パペットの読み込みに失敗しました')
      } finally {
        if (!disposed) setLoading(false)
      }
    })()
    return () => { disposed = true; stage.destroy() }
  }, [pid])

  // push control changes into the live stage
  useEffect(() => { if (stageRef.current) stageRef.current.params = params }, [params])

  const set = (patch: Partial<PuppetParams>) => setParams(p => ({ ...p, ...patch }))

  return (
    <div className="flex-1 flex flex-col lg:flex-row overflow-hidden bg-zinc-950">
      {/* Stage */}
      <div className="flex-1 flex items-center justify-center relative bg-gradient-to-b from-zinc-900 to-zinc-950 min-h-0">
        <canvas ref={canvasRef} width={540} height={760} className="max-h-full max-w-full" />
        {loading && <span className="absolute text-zinc-500 text-sm">読み込み中…</span>}
        {error && <span className="absolute text-red-400 text-sm">{error}</span>}
        {!loading && !error && (
          <span className="absolute bottom-2 text-[10px] text-zinc-600">
            See-Through 分解 → リギング → 手続き動作（呼吸・瞬き・首振り）
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="w-full lg:w-72 border-t lg:border-t-0 lg:border-l border-zinc-800 bg-zinc-900 p-3 flex flex-col gap-4 overflow-y-auto">
        <div>
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">キャラクター</span>
          <select
            value={pid ?? ''}
            onChange={e => setPid(e.target.value)}
            className="mt-1 w-full bg-zinc-800 text-sm text-zinc-100 rounded px-2 py-1.5 border border-zinc-700 focus:border-purple-500 outline-none"
          >
            {puppets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <Slider label="首振り（左右）" min={-1} max={1} value={params.headTurn} onChange={v => set({ headTurn: v })} />
        <Slider label="うなずき（上下）" min={-1} max={1} value={params.headNod} onChange={v => set({ headNod: v })} />

        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-zinc-500">口（リップシンク）</span>
          <button
            onMouseDown={() => set({ talk: 1 })}
            onMouseUp={() => set({ talk: 0 })}
            onMouseLeave={() => set({ talk: 0 })}
            onTouchStart={() => set({ talk: 1 })}
            onTouchEnd={() => set({ talk: 0 })}
            className={`text-xs rounded py-2 font-medium transition-colors ${
              params.talk > 0 ? 'bg-purple-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            }`}
          >押している間 話す</button>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-zinc-500">表情</span>
          <div className="grid grid-cols-2 gap-1">
            {(['neutral', 'smile', 'angry', 'surprised'] as const).map(e => (
              <button
                key={e}
                onClick={() => set({ expression: e })}
                className={`text-[11px] rounded py-1.5 ${
                  params.expression === e ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                }`}
              >{({ neutral: '通常', smile: '笑顔', angry: '怒り', surprised: '驚き' } as const)[e]}</button>
            ))}
          </div>
        </div>

        <p className="text-[10px] text-zinc-600 leading-relaxed mt-auto">
          1枚絵を See-Through で23パーツに分解し、PixiJSでリギング。呼吸・瞬き・首振り・髪パララックスは
          手続き生成。次段で TTS と対話を接続予定。
        </p>
      </div>
    </div>
  )
}

function Slider({ label, min, max, value, onChange }:
  { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-[10px] text-zinc-500">
        <span>{label}</span><span>{value.toFixed(2)}</span>
      </div>
      <input type="range" min={min} max={max} step={0.01} value={value}
        onChange={e => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(0)}
        className="accent-purple-600" />
    </div>
  )
}
