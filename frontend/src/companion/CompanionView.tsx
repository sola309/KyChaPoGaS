import { useEffect, useRef, useState } from 'react'
import { PuppetStage, type PuppetManifest, type PuppetParams, type Expression } from './PuppetStage'
import { useUIStore } from '../store/uiStore'

// Fixed default base prompt for generating 杏子 images (mirrors backend config;
// editable from the settings panel and persisted to backend settings).
const DEFAULT_BASE_PROMPT = '1girl, sakura kyoko, mahou shoujo madoka magica, aoki ume, masterpiece, best quality, solo, '

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
  const hostRef = useRef<HTMLDivElement>(null)
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
  const [panelOpen, setPanelOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1024)
  const [basePrompt, setBasePrompt] = useState(DEFAULT_BASE_PROMPT)
  const [tutorMode, setTutorMode] = useState(false)   // 英会話モード: Kyoko teaches English
  const tutorRef = useRef(false); tutorRef.current = tutorMode
  // voice input (mic → Whisper ASR → chat)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [asrOk, setAsrOk] = useState(false)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  useEffect(() => {
    fetch('/api/companion/asr/status').then(r => r.json()).then(d => setAsrOk(!!d.available)).catch(() => {})
    fetch('/api/settings/').then(r => r.json()).then(d => {
      const v = d?.settings?.COMPANION_BASE_PROMPT
      if (v) setBasePrompt(v)
    }).catch(() => {})
  }, [])

  // re-fetch the puppet library and (optionally) select a puppet by name —
  // called after a new character is decomposed in-app.
  const reloadPuppets = (selectName?: string) =>
    fetch('/api/puppet/').then(r => r.json()).then(d => {
      const list = (d.puppets ?? []) as { id: string; name: string }[]
      setPuppets(list)
      const hit = selectName ? list.find(p => p.name === selectName) : null
      if (hit) setPid(hit.id)
    }).catch(() => {})

  const saveBasePrompt = (val?: string) => {
    const v = (val ?? basePrompt).trim()
    fetch('/api/settings/', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { COMPANION_BASE_PROMPT: v } }),
    }).catch(() => {})
  }

  useEffect(() => {
    fetch('/api/puppet/').then(r => r.json()).then(d => {
      setPuppets(d.puppets ?? [])
      // ?puppet=<id> で初期パペット指定(QA/深リンク用)
      const want = new URLSearchParams(location.search).get('puppet')
      const hit = want ? (d.puppets ?? []).find((p: { id: string }) => p.id === want) : null
      if (hit) setPid(hit.id)
      else if (d.puppets?.[0]) setPid(d.puppets[0].id)
    }).catch(() => setError('パペット一覧の取得に失敗'))
  }, [])

  // (re)build the stage when the selected puppet changes
  useEffect(() => {
    if (!pid || !hostRef.current) return
    let disposed = false
    setLoading(true); setError(null)
    const stage = new PuppetStage()
    stageRef.current = stage
    ;(async () => {
      try {
        const manifest: PuppetManifest = await fetch(`/api/puppet/${pid}/manifest`).then(r => r.json())
        if (disposed) return
        await stage.init(hostRef.current!, `/api/puppet/${pid}/layer/`, manifest)
        stage.params = params
        // pipe the live canvas into the hidden video for Picture-in-Picture
        try {
          const cap = stage.canvas as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream }
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

  // Pointer interaction (hover-gaze, drag-pan, pinch/wheel-zoom, tap-poke) is owned
  // by PuppetStage on the canvas itself — see bindViewControls.

  // Speak: fetch TTS audio, play it, and drive the puppet's mouth from the live
  // audio — amplitude → open amount, spectral centroid → vowel-ish mouth width.
  // 感情ごとの開口レンジ(テンションが低い感情は口を大きく開けない)と声の感情
  const MOUTH_RANGE: Record<string, number> = {
    neutral: 0.72, smile: 0.85, angry: 1.0, surprised: 1.0, sad: 0.5, smug: 0.7, shy: 0.55,
  }
  const VOICE_EMOJI: Record<string, string> = {
    neutral: '', smile: '😊', angry: '💢', surprised: '😲', sad: '😢', smug: '😏', shy: '😳',
  }
  const applyExpr = (e: string) => {
    set({ expression: e as Expression })
    if (stageRef.current) stageRef.current.mouthRange = MOUTH_RANGE[e] ?? 0.75
  }

  const speak = async (text?: string, segments?: { text: string; expression: string }[], voiceExpr?: string): Promise<void> => {
    const stage = stageRef.current
    const say = (text ?? speech).trim()
    if (!stage || !say) return
    setSpeaking(true)
    try {
      const res = await fetch('/api/puppet/tts/speak', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: say, emoji_style: VOICE_EMOJI[voiceExpr ?? ''] ?? '' }),
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
      // 感情タイムライン: 文字数比で各セグメントの開始時刻を割り当て
      const timers: number[] = []
      if (segments && segments.length > 1) {
        const total = segments.reduce((a, sg) => a + sg.text.length, 0) || 1
        let acc = 0
        for (const sg of segments) {
          const at = (acc / total) * audio.duration * 1000
          timers.push(window.setTimeout(() => applyExpr(sg.expression), at))
          acc += sg.text.length
        }
      }
      await new Promise<void>((resolve) => {
        let raf = 0
        const tick = () => {
          analyser.getByteTimeDomainData(td)
          let sum = 0
          for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; sum += v * v }
          stage.talkLevel = Math.tanh(Math.sqrt(sum / td.length) * 3.0)
          // spectral centroid → mouth width
          analyser.getByteFrequencyData(fd)
          let num = 0, den = 0
          for (let i = 0; i < fd.length; i++) { num += i * fd[i]; den += fd[i] }
          const centroid = den > 0 ? num / den / fd.length : 0.4   // 0..1
          stage.mouthWide = Math.min(1, Math.max(0, (centroid - 0.12) * 2.4))
          raf = requestAnimationFrame(tick)
        }
        src.onended = () => { cancelAnimationFrame(raf); timers.forEach(clearTimeout); stage.talkLevel = 0; ctx.close(); resolve() }
        src.start(); tick()
      })
    } catch {
      stage.talkLevel = 0
      useUIStore.getState().pushToast('TTSサーバが応答しません（Irodori未起動／未対応の可能性）', 'info')
    } finally {
      setSpeaking(false)
    }
  }

  // Voice input: record from the mic, send to Whisper, then chat with the result.
  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        setRecording(false)
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        if (blob.size < 1200) return   // too short to be speech
        setTranscribing(true)
        try {
          const fd = new FormData()
          fd.append('file', blob, 'voice.webm')
          fd.append('language', tutorRef.current ? 'en' : 'ja')   // tutor mode: recognise English
          const r = await fetch('/api/companion/transcribe', { method: 'POST', body: fd })
          if (!r.ok) throw new Error('asr')
          const { text } = await r.json()
          if (text?.trim()) await send(text.trim())
          else useUIStore.getState().pushToast('うまく聞き取れませんでした', 'info')
        } catch {
          useUIStore.getState().pushToast('音声認識に失敗（⚙でWhisperを起動してください）', 'info')
        } finally { setTranscribing(false) }
      }
      recRef.current = rec
      rec.start()
      setRecording(true)
      setTimeout(() => { if (recRef.current?.state === 'recording') recRef.current.stop() }, 20000)  // safety cap
    } catch {
      useUIStore.getState().pushToast('マイクにアクセスできません（ブラウザの権限を許可してください）', 'info')
    }
  }
  const toggleRec = () => {
    if (recording) { if (recRef.current?.state === 'recording') recRef.current.stop() }
    else startRec()
  }

  // Chat: user text → LLM (Kyoko persona) → reply spoken + expression
  const send = async (textArg?: string) => {
    const msg = (textArg ?? chatInput).trim()
    if (!msg || sending) return
    setChatInput(''); setSending(true)
    const hist = [...chatLog, { role: 'user' as const, content: msg }]
    setChatLog(hist)
    if (stageRef.current) stageRef.current.thinking = true   // glance aside while she "thinks"
    try {
      const r = await fetch('/api/companion/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, history: chatLog.slice(-10),
                               mode: tutorRef.current ? 'english_tutor' : 'companion' }),
      })
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || 'chat') }
      const { reply, expression, segments } = await r.json()
      if (stageRef.current) stageRef.current.thinking = false
      setChatLog([...hist, { role: 'assistant', content: reply }])
      applyExpr(segments?.[0]?.expression ?? expression)
      await speak(reply, segments, expression)
    } catch (e) {
      useUIStore.getState().pushToast(`対話に失敗: ${e instanceof Error ? e.message : ''}`, 'info')
    } finally {
      if (stageRef.current) stageRef.current.thinking = false
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
    <div className="relative flex-1 overflow-hidden bg-gradient-to-b from-zinc-900 to-zinc-950">
      {/* Stage — fills the whole view so the model is as large as possible; the
          user can pinch/wheel-zoom and drag to reframe (see PuppetStage). */}
      <div ref={hostRef} className="absolute inset-0 flex items-center justify-center" />
      {/* hidden video carries the canvas stream for Picture-in-Picture */}
      <video ref={videoRef} playsInline muted className="hidden" />
      {loading && <span className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm">読み込み中…</span>}
      {error && <span className="absolute inset-0 flex items-center justify-center text-red-400 text-sm">{error}</span>}

      {/* zoom / reset controls (top-left) */}
      <div className="absolute top-2 left-2 flex flex-col gap-1">
        {([['＋', () => stageRef.current?.zoomIn(), '拡大'],
           ['－', () => stageRef.current?.zoomOut(), '縮小'],
           ['⟲', () => stageRef.current?.resetView(), '表示をリセット']] as const).map(([t, fn, title]) => (
          <button key={t} onClick={fn} title={title}
            className="w-8 h-8 rounded bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700 text-base leading-none backdrop-blur">{t}</button>
        ))}
      </div>

      {/* PiP + settings-panel toggle (top-right) */}
      <div className="absolute top-2 right-2 flex gap-1">
        {canPip && !loading && (
          <button onClick={enterPiP} title="ピクチャインピクチャ（他アプリの上に浮かせる）"
            className="text-[11px] px-2 py-1 rounded bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700 backdrop-blur">⧉ PiP</button>
        )}
        <button onClick={() => setPanelOpen(o => !o)} title="設定パネル"
          className={`w-8 h-8 rounded text-base leading-none backdrop-blur ${panelOpen ? 'bg-purple-700 text-white' : 'bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700'}`}>⚙</button>
      </div>

      {/* Bottom input bar — talk WITH the character (always reachable) */}
      <div className="absolute bottom-0 inset-x-0 p-2 bg-gradient-to-t from-zinc-950/95 to-transparent">
        {chatLog.length > 0 && (
          <div className="max-w-2xl mx-auto mb-1.5 max-h-28 overflow-y-auto flex flex-col gap-1 bg-zinc-950/80 rounded p-1.5 border border-zinc-800 backdrop-blur">
            {chatLog.slice(-6).map((m, i) => (
              <div key={i} className={`text-[11px] ${m.role === 'user' ? 'text-zinc-400 text-right' : 'text-purple-200'}`}>{m.content}</div>
            ))}
          </div>
        )}
        <div className="max-w-2xl mx-auto flex gap-1.5">
          <button
            onClick={toggleRec}
            disabled={sending || transcribing}
            title={recording ? '録音を止めて送信' : '声で話しかける（マイク）'}
            className={`text-base px-3 rounded-full transition-colors disabled:opacity-40 ${
              recording ? 'bg-red-600 text-white animate-pulse' : 'bg-zinc-800/90 text-zinc-300 hover:bg-zinc-700'}`}
          >{transcribing ? '…' : recording ? '■' : '🎤'}</button>
          <input
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') send() }}
            placeholder={recording ? (tutorMode ? '英語で話して…' : '聞いています…') : transcribing ? '認識中…' : tutorMode ? '英語で話す / 「教えて」と入力' : '杏子に話しかける…'}
            className="flex-1 bg-zinc-800/90 text-sm text-zinc-100 rounded-full px-4 py-2 outline-none border border-zinc-700 focus:border-purple-500 backdrop-blur"
          />
          <button
            onClick={() => send()}
            disabled={sending || speaking}
            className="text-sm px-4 rounded-full bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40"
          >{sending ? '…' : '送る'}</button>
        </div>
        {!asrOk && (
          <span className="block text-center text-[9px] text-zinc-600 mt-1">🎤を使うには⚙設定でWhisper（音声入力）を起動</span>
        )}
      </div>

      {/* Right collapsible settings panel (same on phone & PC) */}
      <div className={`absolute top-0 right-0 h-full w-[320px] max-w-[88vw] bg-zinc-900/97 border-l border-zinc-800 backdrop-blur flex flex-col transition-transform duration-200 ${panelOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
          <span className="text-[11px] text-zinc-400 font-medium">設定</span>
          <button onClick={() => setPanelOpen(false)} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-1">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">
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

        {/* English-tutor mode: Kyoko teaches in Japanese, examples in native English */}
        <button
          onClick={() => setTutorMode(v => !v)}
          className={`flex items-center justify-between rounded px-3 py-2 text-xs font-medium transition-colors ${
            tutorMode ? 'bg-emerald-700 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
        >
          <span>🎓 英会話モード（杏子先生）</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${tutorMode ? 'bg-emerald-900' : 'bg-zinc-700'}`}>{tutorMode ? 'ON' : 'OFF'}</span>
        </button>
        {tutorMode && (
          <span className="text-[9px] text-emerald-300/80 -mt-2 leading-snug">
            杏子が日本語で教え、英語のお手本はネイティブ音声(Kokoro)。マイクは英語として認識します。「教えて」で開始。
          </span>
        )}

        {/* In-app pipeline: generate → review → decompose → rig → add to library */}
        <GenerateCharacterPanel basePrompt={basePrompt} onCreated={(nm) => reloadPuppets(nm)} />

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
          <div className="grid grid-cols-4 gap-1">
            {(['neutral', 'smile', 'angry', 'surprised', 'sad', 'smug', 'shy'] as const).map(e => (
              <button
                key={e}
                onClick={() => set({ expression: e })}
                className={`text-[11px] rounded py-1.5 ${
                  params.expression === e ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                }`}
              >{({ neutral: '通常', smile: '笑顔', angry: '怒り', surprised: '驚き', sad: '悲しい', smug: 'ドヤ', shy: '照れ' } as const)[e]}</button>
            ))}
          </div>
        </div>

        {/* Generation base prompt — fixed default, editable; used when generating
            new 杏子 character images. Persisted to backend settings. */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-zinc-500">生成ベースプロンプト（杏子）</span>
          <textarea
            value={basePrompt}
            onChange={e => setBasePrompt(e.target.value)}
            onBlur={() => saveBasePrompt()}
            rows={3}
            spellCheck={false}
            className="bg-zinc-800 text-[11px] text-zinc-100 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-purple-500 font-mono leading-snug"
          />
          <button onClick={() => { setBasePrompt(DEFAULT_BASE_PROMPT); saveBasePrompt(DEFAULT_BASE_PROMPT) }}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 self-start">既定に戻す</button>
        </div>

        <p className="text-[10px] text-zinc-600 leading-relaxed mt-auto">
          1枚絵を See-Through で分解し、Rig Compiler v2 が意味ラベルから高精度リグへ自動変換。
          画面はドラッグで移動・ホイール/ピンチで拡大・ダブルクリックでリセット。
        </p>
        </div>
      </div>
    </div>
  )
}

// ── In-app character pipeline: generate → review → decompose → rig → add ───────
// Fallback defaults (mirror backend config); real values are loaded from settings.
const DEF_SCENE = 'flat color, vibrant colors, even lighting, full body, standing, looking at viewer, arms at sides, straight-on view, symmetrical, simple background, light grey background'
const DEF_NEG = 'greyscale, monochrome, sepia, desaturated, sketch, lineart, depth of field, blurry, multiple views, crossed arms, complex background, hat, headwear, (worst quality, low quality:1.2), bad anatomy, bad hands, extra limbs, cropped'

async function pollJob(id: number, onProg?: (p: number) => void): Promise<{ result_asset_ids: number[] }> {
  for (;;) {
    await new Promise(r => setTimeout(r, 1500))
    const j = await fetch(`/api/jobs/${id}`).then(r => r.json())
    onProg?.(j.progress ?? 0)
    if (j.status === 'completed') return j
    if (j.status === 'failed' || j.status === 'cancelled') throw new Error(j.error || `ジョブ${j.status}`)
  }
}

function GenerateCharacterPanel({ basePrompt, onCreated }:
  { basePrompt: string; onCreated: (name: string) => void }) {
  const [projectId, setProjectId] = useState<number | null>(null)
  const [outfit, setOutfit] = useState('magical girl, red dress, detached sleeves, pink pleated skirt')
  // scene/quality tail + negative are fully visible & editable (no hidden terms),
  // loaded from / persisted to backend settings.
  const [scene, setScene] = useState(DEF_SCENE)
  const [negative, setNegative] = useState(DEF_NEG)
  const [name, setName] = useState('杏子（新規）')
  const [phase, setPhase] = useState<'idle' | 'generating' | 'candidate' | 'decomposing'>('idle')
  const [asset, setAsset] = useState<number | null>(null)
  const [prog, setProg] = useState(0)
  const [err, setErr] = useState<string | null>(null)

  // ensure a dedicated project + load editable scene/negative from settings
  useEffect(() => {
    fetch('/api/projects/').then(r => r.json()).then(async (list) => {
      const found = (list as { id: number; name: string }[]).find(p => p.name === 'AIコンパニオン')
      if (found) { setProjectId(found.id); return }
      const created = await fetch('/api/projects/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'AIコンパニオン', width: 832, height: 1216, fps: 30 }),
      }).then(r => r.json())
      setProjectId(created.id)
    }).catch(() => setErr('プロジェクト準備に失敗'))
    fetch('/api/settings/').then(r => r.json()).then(d => {
      const s = d?.settings || {}
      if (s.COMPANION_GEN_SCENE) setScene(s.COMPANION_GEN_SCENE)
      if (s.COMPANION_GEN_NEGATIVE) setNegative(s.COMPANION_GEN_NEGATIVE)
    }).catch(() => {})
  }, [])

  const saveSetting = (key: string, val: string) =>
    fetch('/api/settings/', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { [key]: val.trim() } }),
    }).catch(() => {})

  // EXACTLY what gets sent — base + outfit + scene, nothing hidden.
  const finalPrompt = `${basePrompt}${outfit}${scene ? ', ' + scene : ''}`

  const generate = async () => {
    if (!projectId) return
    setErr(null); setAsset(null); setPhase('generating'); setProg(0)
    try {
      const job = await fetch('/api/generation/image', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, prompt: finalPrompt, negative_prompt: negative,
                               model: 'waiIllustrious', width: 832, height: 1216 }),
      }).then(r => r.json())
      const done = await pollJob(job.id, setProg)
      const aid = done.result_asset_ids?.[0]
      if (!aid) throw new Error('生成画像が取得できませんでした')
      setAsset(aid); setPhase('candidate')
    } catch (e) { setErr(String((e as Error).message || e)); setPhase('idle') }
  }

  const decompose = async () => {
    if (!projectId || asset == null) return
    setErr(null); setPhase('decomposing'); setProg(0)
    try {
      const res = await fetch('/api/puppet/decompose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, asset_id: asset, name: name.trim() || '杏子（新規）' }),
      }).then(r => r.json())
      await pollJob(res.job_id, setProg)
      onCreated(name.trim() || '杏子（新規）')
      setPhase('idle'); setAsset(null)
    } catch (e) { setErr(String((e as Error).message || e)); setPhase('candidate') }
  }

  const busy = phase === 'generating' || phase === 'decomposing'
  return (
    <div className="flex flex-col gap-1.5 border border-zinc-800 rounded p-2 bg-zinc-950/40">
      <span className="text-[11px] text-purple-300 font-medium">✨ キャラを生成 → 分解 → 追加</span>

      <span className="text-[9px] text-zinc-500">① 指定プロンプト（衣装・特徴）</span>
      <textarea value={outfit} onChange={e => setOutfit(e.target.value)} rows={2} spellCheck={false}
        placeholder="例: school uniform, pleated skirt"
        className="bg-zinc-800 text-[11px] text-zinc-100 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-purple-500" />

      <span className="text-[9px] text-zinc-500">② シーン・品質（分解向け／編集可・リッチにしたいなら flat color 等を削除）</span>
      <textarea value={scene} onChange={e => setScene(e.target.value)} onBlur={() => saveSetting('COMPANION_GEN_SCENE', scene)}
        rows={2} spellCheck={false}
        className="bg-zinc-800 text-[10px] text-zinc-300 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-purple-500 font-mono leading-snug" />

      <span className="text-[9px] text-zinc-500">③ ネガティブ（編集可）</span>
      <textarea value={negative} onChange={e => setNegative(e.target.value)} onBlur={() => saveSetting('COMPANION_GEN_NEGATIVE', negative)}
        rows={2} spellCheck={false}
        className="bg-zinc-800 text-[10px] text-zinc-300 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-purple-500 font-mono leading-snug" />
      <button onClick={() => { setScene(DEF_SCENE); setNegative(DEF_NEG); saveSetting('COMPANION_GEN_SCENE', DEF_SCENE); saveSetting('COMPANION_GEN_NEGATIVE', DEF_NEG) }}
        className="text-[10px] text-zinc-500 hover:text-zinc-300 self-start">②③を既定に戻す</button>

      <span className="text-[9px] text-zinc-500">送信される最終プロンプト（ベース＋①＋②）</span>
      <div className="text-[10px] text-emerald-300/90 bg-zinc-950 rounded px-2 py-1.5 border border-zinc-800 font-mono leading-snug break-words max-h-24 overflow-y-auto">{finalPrompt}</div>

      {asset != null && (
        <img src={`/api/assets/${asset}/file`} alt="candidate"
          className="w-full max-h-64 object-contain rounded bg-zinc-900 border border-zinc-800" />
      )}

      {phase === 'candidate' && asset != null ? (
        <div className="flex flex-col gap-1.5">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="モデル名"
            className="bg-zinc-800 text-[11px] text-zinc-100 rounded px-2 py-1.5 outline-none border border-zinc-700 focus:border-purple-500" />
          <div className="flex gap-1.5">
            <button onClick={generate} className="flex-1 text-[11px] rounded py-2 bg-zinc-800 text-zinc-300 hover:bg-zinc-700">再生成</button>
            <button onClick={decompose} className="flex-1 text-[11px] rounded py-2 bg-purple-700 text-white hover:bg-purple-600">この画像で分解→リグ</button>
          </div>
          <span className="text-[9px] text-zinc-600">※分解は約6分かかります（GPU占有）</span>
        </div>
      ) : (
        <button onClick={generate} disabled={busy || !projectId}
          className="text-xs rounded py-2 font-medium bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40">
          {phase === 'generating' ? `生成中… ${Math.round(prog * 100)}%`
            : phase === 'decomposing' ? `分解中… ${Math.round(prog * 100)}%（約6分）`
            : '画像を生成'}
        </button>
      )}
      {busy && <div className="h-1 bg-zinc-800 rounded overflow-hidden"><div className="h-full bg-purple-500 transition-all" style={{ width: `${Math.round(prog * 100)}%` }} /></div>}
      {err && <span className="text-[10px] text-red-400">{err}</span>}
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
