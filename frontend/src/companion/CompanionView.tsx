import { useEffect, useRef, useState } from 'react'
import { PuppetStage, type PuppetManifest, type PuppetParams } from './PuppetStage'
import { useUIStore } from '../store/uiStore'

/**
 * CompanionView — the AI companion app (first slice): a See-Through character
 * rigged into a living puppet (breath / blink / sway), with manual controls to
 * prove Stage③ (rigging) + Stage④ (motion). Conversation/TTS comes later.
 */
// Picture-in-Picture for the puppet: a <canvas> can't go PiP directly, so we
// pipe canvas.captureStream() into a hidden <video> and PiP that. iOS Safari
// uses webkitSetPresentationMode; desktop uses the standard requestPictureInPicture.
interface IOSVideo extends HTMLVideoElement {
  webkitSetPresentationMode?: (m: 'picture-in-picture' | 'inline') => void
  webkitSupportsPresentationMode?: (m: string) => boolean
}
// Accurately report whether THIS video can actually go PiP. iOS Safari does NOT
// support PiP from a canvas captureStream MediaStream (and disables it entirely
// in standalone PWA mode), so webkitSupportsPresentationMode returns false there
// → the button stays hidden instead of looking dead. Desktop Chrome works.
function pipSupported(video: IOSVideo | null): boolean {
  if (!video) return false
  if (typeof video.webkitSupportsPresentationMode === 'function') {
    try { return video.webkitSupportsPresentationMode('picture-in-picture') } catch { return false }
  }
  return !!(document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled
}

export function CompanionView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<PuppetStage | null>(null)
  const [puppets, setPuppets] = useState<{ id: string; name: string }[]>([])
  const [pid, setPid] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [canPip, setCanPip] = useState(false)
  const [speech, setSpeech] = useState('こんにちは。私が喋るとき、口が声に合わせて動くよ。')
  const [speaking, setSpeaking] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [sending, setSending] = useState(false)
  const [chatLog, setChatLog] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
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
        // pipe the live canvas into the hidden video for Picture-in-Picture
        try {
          const cap = (canvasRef.current as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream })
          const v = videoRef.current
          if (cap.captureStream && v) {
            v.srcObject = cap.captureStream(30)
            await v.play().catch(() => {})
            // support is only known once the video has dimensions
            const check = () => setCanPip(pipSupported(v as IOSVideo))
            check()
            v.addEventListener('loadedmetadata', check, { once: true })
          }
        } catch { /* PiP unavailable */ }
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

  // Speak: fetch TTS audio, play it, and drive the puppet's mouth from the live
  // audio — amplitude → open amount, spectral centroid → vowel-ish mouth width.
  const speak = async (text?: string): Promise<void> => {
    const stage = stageRef.current
    const say = (text ?? speech).trim()
    if (!stage || !say) return
    setSpeaking(true)
    try {
      const res = await fetch('/api/puppet/tts/speak', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: say }),
      })
      if (!res.ok) throw new Error('tts')
      const buf = await res.arrayBuffer()
      const ctx = new AudioContext()
      const audio = await ctx.decodeAudioData(buf)
      const src = ctx.createBufferSource(); src.buffer = audio
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512
      src.connect(analyser); analyser.connect(ctx.destination)
      const td = new Uint8Array(analyser.fftSize)
      const fd = new Uint8Array(analyser.frequencyBinCount)
      await new Promise<void>((resolve) => {
        let raf = 0
        const tick = () => {
          analyser.getByteTimeDomainData(td)
          let sum = 0
          for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; sum += v * v }
          stage.talkLevel = Math.min(1, Math.sqrt(sum / td.length) * 3.4)
          // spectral centroid → mouth width
          analyser.getByteFrequencyData(fd)
          let num = 0, den = 0
          for (let i = 0; i < fd.length; i++) { num += i * fd[i]; den += fd[i] }
          const centroid = den > 0 ? num / den / fd.length : 0.4   // 0..1
          stage.mouthWide = Math.min(1, Math.max(0, (centroid - 0.12) * 2.4))
          raf = requestAnimationFrame(tick)
        }
        src.onended = () => { cancelAnimationFrame(raf); stage.talkLevel = 0; ctx.close(); resolve() }
        src.start(); tick()
      })
    } catch {
      stage.talkLevel = 0
      useUIStore.getState().pushToast('TTSサーバが応答しません（Irodori未起動／未対応の可能性）', 'info')
    } finally {
      setSpeaking(false)
    }
  }

  // Chat: user text → LLM (Kyoko persona) → reply spoken + expression
  const send = async () => {
    const msg = chatInput.trim()
    if (!msg || sending) return
    setChatInput(''); setSending(true)
    const hist = [...chatLog, { role: 'user' as const, content: msg }]
    setChatLog(hist)
    try {
      const r = await fetch('/api/companion/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, history: chatLog.slice(-10) }),
      })
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || 'chat') }
      const { reply, expression } = await r.json()
      setChatLog([...hist, { role: 'assistant', content: reply }])
      set({ expression })
      await speak(reply)
    } catch (e) {
      useUIStore.getState().pushToast(`対話に失敗: ${e instanceof Error ? e.message : ''}`, 'info')
    } finally {
      setSending(false)
    }
  }

  const enterPiP = async () => {
    const video = videoRef.current as IOSVideo | null
    if (!video) return
    try {
      if (typeof video.webkitSetPresentationMode === 'function') {
        video.webkitSetPresentationMode('picture-in-picture')   // iOS Safari
      } else if (document.pictureInPictureElement) {
        await document.exitPictureInPicture()
      } else {
        await video.requestPictureInPicture()                   // desktop
      }
    } catch {
      useUIStore.getState().pushToast(
        'この環境ではPiPが使えません（iOSは標準アプリ表示や配信映像のPiPに非対応）', 'info')
    }
  }

  return (
    <div className="flex-1 flex flex-col lg:flex-row overflow-hidden bg-zinc-950">
      {/* Stage */}
      <div className="flex-1 flex items-center justify-center relative bg-gradient-to-b from-zinc-900 to-zinc-950 min-h-0">
        <canvas ref={canvasRef} width={540} height={760} className="max-h-full max-w-full" />
        {/* hidden video carries the canvas stream for Picture-in-Picture */}
        <video ref={videoRef} playsInline muted className="hidden" />
        {canPip && !loading && (
          <button
            onClick={enterPiP}
            className="absolute top-2 right-2 text-[11px] px-2 py-1 rounded bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700"
            title="ピクチャインピクチャ（他アプリの上に浮かせる）"
          >⧉ PiP</button>
        )}
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

        {/* Conversation — talk WITH the character (LLM → speaks back) */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-zinc-500">会話（杏子と話す）</span>
          {chatLog.length > 0 && (
            <div className="max-h-32 overflow-y-auto flex flex-col gap-1 bg-zinc-950 rounded p-1.5 border border-zinc-800">
              {chatLog.slice(-6).map((m, i) => (
                <div key={i} className={`text-[11px] ${m.role === 'user' ? 'text-zinc-400 text-right' : 'text-purple-200'}`}>
                  {m.content}
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-1">
            <input
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') send() }}
              placeholder="話しかける…"
              className="flex-1 bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1.5 outline-none border border-zinc-700 focus:border-purple-500"
            />
            <button
              onClick={send}
              disabled={sending || speaking}
              className="text-xs px-3 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40"
            >{sending ? '…' : '送る'}</button>
          </div>
        </div>

        {/* Speak (TTS → real lip-sync) */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-zinc-500">指定セリフを喋らせる（口が声に同期）</span>
          <textarea
            value={speech}
            onChange={e => setSpeech(e.target.value)}
            rows={2}
            className="bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-purple-500"
          />
          <button
            onClick={() => speak()}
            disabled={speaking}
            className="text-xs rounded py-2 font-medium bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40"
          >{speaking ? '🔊 喋っています…' : '🗣 喋らせる'}</button>
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
