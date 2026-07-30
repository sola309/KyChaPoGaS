import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import { PuppetStage, type PuppetManifest } from '../../companion/PuppetStage'
import { KeyframeGraph, type CamKey, type TrackDef } from '../RightPanel/GenerationPanel/KeyframeGraph'
import { useProjectStore } from '../../store/projectStore'

// 🎎 リグスタジオ — パペットの「仕上げ」を一箇所で行う。
//  ①レイヤー順序の修正(分解ミスの手当て) ②揺れモノ設定(ピン位置/強さ)
//  ③口パク・表情差分の位置/スケール調整 ④レイヤー画像の微修正(ブラシ)
//  ⑤動画用モーション(キーフレーム)作成→透過webmクリップ生成

interface PuppetInfo { id: string; name: string; layer_count: number }

const MOTION_TRACKS: TrackDef[] = [
  { key: 'turn', label: '首ふりturn', color: '#c084fc', min: -1, max: 1 },
  { key: 'nod',  label: 'うなずきnod', color: '#60a5fa', min: -1, max: 1 },
  { key: 'talk', label: '口パクtalk', color: '#4ade80', min: 0, max: 1 },
  { key: 'level', label: '声量level', color: '#fbbf24', min: 0, max: 1 },
]

const EXPRESSIONS = ['neutral', 'smile', 'surprised', 'sad', 'smug', 'shy'] as const

export function PuppetStudioView() {
  const { activeProject } = useProjectStore()
  const [puppets, setPuppets] = useState<PuppetInfo[]>([])
  const [pid, setPid] = useState<string>('')
  const [manifest, setManifest] = useState<PuppetManifest | null>(null)
  const [selLayer, setSelLayer] = useState<number>(-1)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<'expr' | 'edit' | 'motion'>('expr')
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState('')
  const hostRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<PuppetStage | null>(null)
  const [expr, setExpr] = useState<string>('neutral')
  const [turn, setTurn] = useState(0)
  const [nod, setNod] = useState(0)
  const [talkTest, setTalkTest] = useState(false)
  // モーション
  const [motionKeys, setMotionKeys] = useState<CamKey[]>([
    { at: 0, turn: 0, nod: 0, talk: 0, level: 0 },
    { at: 0.5, turn: 0.6, nod: 0.2, talk: 1, level: 0.7, ease: 'inOut' },
    { at: 1, turn: 0, nod: 0, talk: 0, level: 0, ease: 'inOut' },
  ])
  const [motionDur, setMotionDur] = useState(4)
  const [scrub, setScrub] = useState(0)
  const [genBusy, setGenBusy] = useState(false)
  // 微修正
  const [brushLayer, setBrushLayer] = useState<string>('')
  const [brushSize, setBrushSize] = useState(24)
  const [brushMode, setBrushMode] = useState<'erase' | 'restore'>('erase')
  const editorRef = useRef<HTMLCanvasElement>(null)
  const editImgRef = useRef<{ cur: HTMLCanvasElement; orig: HTMLImageElement } | null>(null)

  useEffect(() => {
    api.get('/puppet/').then(r => {
      const ps = r.data.puppets ?? []
      setPuppets(ps)
      if (ps.length && !pid) setPid(ps[0].id)
    })
  }, [])

  // manifest取得 & ステージ構築
  const rebuild = async (id: string) => {
    if (!id || !hostRef.current) return
    stageRef.current?.destroy()
    hostRef.current.innerHTML = ''
    const m: PuppetManifest = (await api.get(`/puppet/${id}/manifest`)).data
    // 非表示レイヤーはプレビューから除外(保存には影響しない)
    const mv = { ...m, layers: m.layers.filter(l => !hidden.has(l.file)) }
    setManifest(m)
    const st = new PuppetStage()
    await st.init(hostRef.current, `/api/puppet/${id}/layer/`, mv as PuppetManifest)
    stageRef.current = st
  }
  useEffect(() => { rebuild(pid) }, [pid])
  useEffect(() => { if (manifest) rebuildPreviewOnly() }, [hidden])

  const rebuildPreviewOnly = async () => {
    if (!manifest || !hostRef.current) return
    stageRef.current?.destroy()
    hostRef.current.innerHTML = ''
    const mv = { ...manifest, layers: manifest.layers.filter(l => !hidden.has(l.file)) }
    const st = new PuppetStage()
    await st.init(hostRef.current, `/api/puppet/${pid}/layer/`, mv as PuppetManifest)
    stageRef.current = st
  }

  // テスト操作をステージへ
  useEffect(() => {
    const st = stageRef.current
    if (!st) return
    st.params = { headTurn: turn, headNod: nod, talk: talkTest ? 1 : 0,
                  expression: expr as never }
    st.talkLevel = talkTest ? 0.6 + 0.3 * Math.random() : 0
  }, [turn, nod, expr, talkTest])
  useEffect(() => {
    if (!talkTest) return
    const iv = setInterval(() => {
      const st = stageRef.current
      if (st) { st.talkLevel = Math.max(0, 0.5 + 0.45 * Math.sin(Date.now() / 90)) }
    }, 50)
    return () => clearInterval(iv)
  }, [talkTest])

  // ── manifest編集ヘルパ ──
  const mutate = (fn: (m: PuppetManifest) => void) => {
    if (!manifest) return
    const m = JSON.parse(JSON.stringify(manifest)) as PuppetManifest
    fn(m)
    setManifest(m)
    setDirty(true)
  }
  const moveLayer = (idx: number, dir: -1 | 1) => mutate(m => {
    const sorted = [...m.layers].sort((a, b) => a.z - b.z)
    const j = idx + dir
    if (j < 0 || j >= sorted.length) return
    const zi = sorted[idx].z
    sorted[idx].z = sorted[j].z
    sorted[j].z = zi
    m.layers = sorted
  })
  const setSway = (idx: number, patch: Record<string, unknown>) => mutate(m => {
    const sorted = [...m.layers].sort((a, b) => a.z - b.z)
    const l = sorted[idx]
    if (patch === null) { delete l.sway; return }
    l.sway = { type: 'hair', pin: 'head', amp: 1, ...(l.sway ?? {}), ...patch } as never
  })
  const setAdjust = (kind: 'mouth' | 'eyes', key: string, v: number) => mutate(m => {
    const r = (m.rig ??= {} as never) as { adjust?: Record<string, Record<string, number>> }
    r.adjust = r.adjust ?? {}
    r.adjust[kind] = { ...(r.adjust[kind] ?? {}), [key]: v }
  })

  const save = async () => {
    if (!manifest) return
    await api.put(`/puppet/${pid}/manifest`, manifest)
    setDirty(false)
    setMsg('保存しました')
    setTimeout(() => setMsg(''), 2000)
    rebuildPreviewOnly()
  }
  const undo = async () => {
    await api.post(`/puppet/${pid}/manifest/undo`)
    setDirty(false)
    rebuild(pid)
  }

  // ── モーションプレビュー(スクラブ) ──
  useEffect(() => {
    const st = stageRef.current
    if (!st || tab !== 'motion') return
    const sorted = [...motionKeys].sort((a, b) => a.at - b.at)
    const num = (key: string, dflt: number) => {
      const ks = sorted.filter(k => typeof k[key] === 'number')
      if (!ks.length) return dflt
      let a = ks[0], b = ks[ks.length - 1]
      for (let i = 0; i < ks.length - 1; i++)
        if (scrub >= ks[i].at && scrub <= ks[i + 1].at) { a = ks[i]; b = ks[i + 1]; break }
      const su = b.at === a.at ? 0 : (scrub - a.at) / (b.at - a.at)
      const e = b.ease === 'inOut' ? 0.5 - 0.5 * Math.cos(Math.PI * su)
        : b.ease === 'outCubic' ? 1 - Math.pow(1 - su, 3)
        : b.ease === 'inCubic' ? su ** 3 : su
      return (a[key] as number) + ((b[key] as number) - (a[key] as number)) * e
    }
    st.params = { headTurn: num('turn', 0), headNod: num('nod', 0),
                  talk: num('talk', 0), expression: expr as never }
    st.talkLevel = num('level', 0)
  }, [scrub, motionKeys, tab])

  const generateClip = async () => {
    if (!activeProject) { setMsg('プロジェクトを選択してください(左上)'); return }
    setGenBusy(true)
    try {
      const tracks: Record<string, { at: number; v: number; ease?: string }[]> = {}
      for (const tr of ['turn', 'nod', 'talk', 'level']) {
        tracks[tr] = [...motionKeys].sort((a, b) => a.at - b.at)
          .filter(k => typeof k[tr] === 'number')
          .map(k => ({ at: k.at, v: k[tr] as number, ease: k.ease as string }))
      }
      const r = await api.post(`/puppet/${pid}/clip`, {
        project_id: activeProject.id, motion: 'keyframes',
        duration: motionDur, fps: 30, keyframes: tracks,
      })
      setMsg(`クリップ生成中… job ${r.data.id}(完了するとアセットに入ります)`)
    } finally { setGenBusy(false) }
  }

  // ── 微修正エディタ ──
  const openEditor = async (file: string) => {
    setBrushLayer(file)
    const img = new Image()
    img.src = `/api/puppet/${pid}/layer/${file}?t=${Date.now()}`
    await img.decode()
    const cur = document.createElement('canvas')
    cur.width = img.width; cur.height = img.height
    cur.getContext('2d')!.drawImage(img, 0, 0)
    editImgRef.current = { cur, orig: img }
    drawEditor()
  }
  const drawEditor = () => {
    const cv = editorRef.current, st = editImgRef.current
    if (!cv || !st) return
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, cv.width, cv.height)
    // 市松(透過確認)
    for (let y = 0; y < cv.height; y += 16) for (let x = 0; x < cv.width; x += 16)
      { ctx.fillStyle = ((x + y) / 16) % 2 ? '#2a2a2e' : '#232327'; ctx.fillRect(x, y, 16, 16) }
    ctx.drawImage(st.cur, 0, 0, cv.width, cv.height)
  }
  const brushAt = (e: React.PointerEvent) => {
    const cv = editorRef.current, st = editImgRef.current
    if (!cv || !st || e.buttons !== 1) return
    const r = cv.getBoundingClientRect()
    const sx = st.cur.width / cv.width
    const x = (e.clientX - r.left) * (cv.width / r.width) * sx
    const y = (e.clientY - r.top) * (cv.height / r.height) * sx
    const ctx = st.cur.getContext('2d')!
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, brushSize * sx, 0, Math.PI * 2)
    if (brushMode === 'erase') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fill()
    } else {
      ctx.clip()
      ctx.globalCompositeOperation = 'source-over'
      ctx.drawImage(st.orig, 0, 0)
    }
    ctx.restore()
    drawEditor()
  }
  const saveLayer = async () => {
    const st = editImgRef.current
    if (!st) return
    const blob: Blob = await new Promise(res => st.cur.toBlob(b => res(b!), 'image/png'))
    await fetch(`/api/puppet/${pid}/layer/${brushLayer}`, { method: 'POST', body: blob })
    setMsg('レイヤーを保存しました')
    setTimeout(() => setMsg(''), 2000)
    rebuildPreviewOnly()
  }
  const restoreLayer = async () => {
    await api.post(`/puppet/${pid}/layer/${brushLayer}/restore`)
    openEditor(brushLayer)
    rebuildPreviewOnly()
  }

  const layers = useMemo(() =>
    manifest ? [...manifest.layers].sort((a, b) => a.z - b.z) : [], [manifest])
  const sel = selLayer >= 0 ? layers[selLayer] : null

  return (
    <div className="flex flex-1 min-h-0">
      {/* 左: レイヤー+揺れ */}
      <div className="w-72 flex-shrink-0 border-r border-zinc-800 flex flex-col">
        <div className="p-2 border-b border-zinc-800 flex items-center gap-2">
          <select value={pid} onChange={e => { setPid(e.target.value); setSelLayer(-1); setHidden(new Set()) }}
            className="flex-1 bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 border border-zinc-700">
            {puppets.map(p => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
          </select>
        </div>
        <div className="flex-1 overflow-y-auto">
          <p className="px-2 pt-2 pb-1 text-[10px] text-zinc-500">レイヤー(下=手前) — ↑↓で順序修正</p>
          {layers.map((l, i) => (
            <div key={l.file}
              onClick={() => setSelLayer(i)}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] cursor-pointer ${
                selLayer === i ? 'bg-purple-950/50 text-purple-200' : 'text-zinc-300 hover:bg-zinc-900'}`}>
              <button onClick={e => { e.stopPropagation()
                  setHidden(h => { const n = new Set(h); n.has(l.file) ? n.delete(l.file) : n.add(l.file); return n }) }}
                className={hidden.has(l.file) ? 'opacity-30' : ''}>👁</button>
              <span className="flex-1 truncate">{l.name}</span>
              {l.sway && <span className="text-[9px] text-zinc-500">{l.sway.type}</span>}
              <button onClick={e => { e.stopPropagation(); moveLayer(i, -1) }}
                className="text-zinc-500 hover:text-white px-0.5">↑</button>
              <button onClick={e => { e.stopPropagation(); moveLayer(i, 1) }}
                className="text-zinc-500 hover:text-white px-0.5">↓</button>
            </div>
          ))}
        </div>
        {sel && (
          <div className="border-t border-zinc-800 p-2 flex flex-col gap-1.5 text-[11px]">
            <p className="text-zinc-400 font-medium truncate">揺れ設定: {sel.name}</p>
            <label className="flex items-center gap-2">タイプ
              <select value={sel.sway?.type ?? 'none'}
                onChange={e => e.target.value === 'none'
                  ? mutate(m => { const ls = [...m.layers].sort((a,b)=>a.z-b.z); delete ls[selLayer].sway })
                  : setSway(selLayer, { type: e.target.value })}
                className="flex-1 bg-zinc-800 rounded px-1 py-0.5 border border-zinc-700">
                <option value="none">なし(固定)</option>
                <option value="hair">髪</option>
                <option value="cloth">布</option>
                <option value="neck">首</option>
              </select>
            </label>
            <label className="flex items-center gap-2">ピン先
              <select value={sel.sway?.pin ?? 'head'} onChange={e => setSway(selLayer, { pin: e.target.value })}
                className="flex-1 bg-zinc-800 rounded px-1 py-0.5 border border-zinc-700">
                <option value="head">頭</option>
                <option value="body">体</option>
              </select>
            </label>
            <label className="flex items-center gap-1">強さ
              <input type="range" min={0} max={2} step={0.05} value={sel.sway?.amp ?? 1}
                onChange={e => setSway(selLayer, { amp: Number(e.target.value) })} className="flex-1" />
              <span className="w-8 text-right">{(sel.sway?.amp ?? 1).toFixed(2)}</span>
            </label>
            <label className="flex items-center gap-1" title="どの高さから下を揺らすか(0=てっぺんから, 0.28=既定, 0.5=下半分のみ)">
              ピン位置
              <input type="range" min={0} max={0.8} step={0.02} value={sel.sway?.pinY ?? 0.28}
                onChange={e => setSway(selLayer, { pinY: Number(e.target.value) })} className="flex-1" />
              <span className="w-8 text-right">{(sel.sway?.pinY ?? 0.28).toFixed(2)}</span>
            </label>
          </div>
        )}
      </div>

      {/* 中央: ステージ+テスト操作 */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 text-[11px] flex-wrap">
          <span className="text-zinc-300 font-medium">🎎 リグスタジオ</span>
          {EXPRESSIONS.map(x => (
            <button key={x} onClick={() => setExpr(x)}
              className={`px-1.5 py-0.5 rounded ${expr === x ? 'bg-purple-800 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
              {x}
            </button>
          ))}
          <button onClick={() => setTalkTest(v => !v)}
            className={`px-2 py-0.5 rounded ${talkTest ? 'bg-emerald-800 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
            💬 口パクテスト
          </button>
          <label className="flex items-center gap-1 ml-2">首
            <input type="range" min={-1} max={1} step={0.02} value={turn}
              onChange={e => setTurn(Number(e.target.value))} className="w-24" />
          </label>
          <label className="flex items-center gap-1">頷
            <input type="range" min={-1} max={1} step={0.02} value={nod}
              onChange={e => setNod(Number(e.target.value))} className="w-20" />
          </label>
          <span className="ml-auto flex items-center gap-2">
            {msg && <span className="text-emerald-400">{msg}</span>}
            {dirty && <span className="text-amber-400">未保存</span>}
            <button onClick={undo} className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">↩ 戻す</button>
            <button onClick={save} disabled={!dirty}
              className="px-3 py-0.5 rounded bg-purple-700 text-white disabled:opacity-40 hover:bg-purple-600">保存</button>
          </span>
        </div>
        <div ref={hostRef} className="flex-1 relative bg-[#1a1a1f]" />
      </div>

      {/* 右: 表情/微修正/モーション */}
      <div className="w-80 flex-shrink-0 border-l border-zinc-800 flex flex-col">
        <div className="flex border-b border-zinc-800">
          {([['expr', '😊 表情'], ['edit', '🖌 微修正'], ['motion', '🎬 モーション']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`flex-1 py-2 text-[11px] ${tab === id
                ? 'text-white border-b-2 border-purple-500 bg-zinc-900' : 'text-zinc-500'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-2 text-[11px]">
          {tab === 'expr' && manifest && (
            <div className="flex flex-col gap-2">
              <p className="text-zinc-400">口差分の位置/スケール(保存でmanifestに反映・プレビュー即時)</p>
              {(['mouth', 'eyes'] as const).map(kind => {
                const a = (manifest.rig as { adjust?: Record<string, Record<string, number>> })?.adjust?.[kind] ?? {}
                return (
                  <div key={kind} className="bg-zinc-900 rounded p-2 flex flex-col gap-1">
                    <p className="text-purple-300">{kind === 'mouth' ? '👄 口' : '👀 目'}</p>
                    {([['dx', '横', -60, 60], ['dy', '縦', -60, 60], ['scale', '大きさ', 0.6, 1.5]] as const).map(([k, lbl, mn, mx]) => (
                      <label key={k} className="flex items-center gap-1">
                        <span className="w-10">{lbl}</span>
                        <input type="range" min={mn} max={mx} step={k === 'scale' ? 0.02 : 1}
                          value={a[k] ?? (k === 'scale' ? 1 : 0)}
                          onChange={e => {
                            setAdjust(kind, k, Number(e.target.value))
                            const st = stageRef.current
                            if (st) (st.adj[kind] as Record<string, number>)[k] = Number(e.target.value)
                          }} className="flex-1" />
                        <span className="w-9 text-right">{(a[k] ?? (k === 'scale' ? 1 : 0)).toFixed(k === 'scale' ? 2 : 0)}</span>
                      </label>
                    ))}
                  </div>
                )
              })}
              <p className="text-zinc-500 text-[10px]">
                調整のコツ: 💬口パクテストをONにして、口が顔からズレる/大きすぎる場合にここを動かす。
                笑顔の口は expression=smile で笑いセットに切り替わります。
              </p>
            </div>
          )}

          {tab === 'edit' && (
            <div className="flex flex-col gap-2">
              <select value={brushLayer} onChange={e => openEditor(e.target.value)}
                className="bg-zinc-800 rounded px-2 py-1.5 border border-zinc-700">
                <option value="">— 修正するレイヤー —</option>
                {layers.map(l => <option key={l.file} value={l.file}>{l.name}</option>)}
              </select>
              {brushLayer && (<>
                <div className="flex items-center gap-2">
                  <button onClick={() => setBrushMode('erase')}
                    className={`px-2 py-1 rounded ${brushMode === 'erase' ? 'bg-red-900 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
                    🧹 消す
                  </button>
                  <button onClick={() => setBrushMode('restore')}
                    className={`px-2 py-1 rounded ${brushMode === 'restore' ? 'bg-emerald-900 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
                    ↩ 戻す筆
                  </button>
                  <label className="flex items-center gap-1 flex-1">径
                    <input type="range" min={4} max={80} value={brushSize}
                      onChange={e => setBrushSize(Number(e.target.value))} className="flex-1" />
                  </label>
                </div>
                <canvas ref={editorRef} width={288} height={288}
                  onPointerDown={brushAt} onPointerMove={brushAt}
                  className="w-full rounded border border-zinc-700 touch-none cursor-crosshair" />
                <div className="flex gap-2">
                  <button onClick={saveLayer} className="flex-1 py-1.5 rounded bg-purple-700 text-white hover:bg-purple-600">保存</button>
                  <button onClick={restoreLayer} className="px-3 py-1.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">元画像に戻す</button>
                </div>
                <p className="text-zinc-500 text-[10px]">はみ出し・ゴミ・ハロの除去用。「戻す筆」は元画像から部分復元。</p>
              </>)}
            </div>
          )}

          {tab === 'motion' && (
            <div className="flex flex-col gap-2">
              <KeyframeGraph keys={motionKeys} onChange={setMotionKeys} tracks={MOTION_TRACKS} />
              <label className="flex items-center gap-2">プレビュー
                <input type="range" min={0} max={1} step={0.005} value={scrub}
                  onChange={e => setScrub(Number(e.target.value))} className="flex-1" />
              </label>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1">長さ(秒)
                  <input type="number" min={1} max={30} step={0.5} value={motionDur}
                    onChange={e => setMotionDur(Number(e.target.value))}
                    className="w-16 bg-zinc-800 rounded px-1 py-0.5 border border-zinc-700" />
                </label>
                <button onClick={generateClip} disabled={genBusy}
                  className="flex-1 py-1.5 rounded bg-purple-700 text-white hover:bg-purple-600 disabled:opacity-40">
                  🎬 透過クリップ生成
                </button>
              </div>
              <p className="text-zinc-500 text-[10px]">
                グラフの点をドラッグしてモーションを設計(行ダブルクリックでキー追加)。
                プレビューで確認→生成すると現在のプロジェクトのアセットに透過webmが入ります。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
