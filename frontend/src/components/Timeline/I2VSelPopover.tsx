import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset } from '../../api/client'
import { useJobStore } from '../../store/jobStore'
import { useTimelineStore } from '../../store/timelineStore'

// 🎬 選択キーフレーム→i2v — Imageトラック上で2枚以上のRefクリップを選択すると
// ツールバーに現れる。キーフレーム=各クリップの左端(打点)。
// 範囲は自動: 最初の打点→最後の打点。2枚=FLF2V / 3枚以上=VACE。
// 連続ショットは境界の1枚を次ショットの開始として共有する運用。

const VID_PRESETS = [
  { label: '横 1280×720(推奨)', w: 1280, h: 720 },
  { label: '縦 720×1280',       w: 720, h: 1280 },
  { label: '横 832×480(高速)',  w: 832, h: 480 },
  { label: '縦 480×832(高速)',  w: 480, h: 832 },
  { label: '正方 640',          w: 640, h: 640 },
] as const

// H3ネイティブ: 短辺768・上限768×1344・32の倍数
const H3_PRESETS = [
  { label: '横 1344×768(ネイティブ推奨)', w: 1344, h: 768 },
  { label: '縦 768×1344(ネイティブ推奨)', w: 768, h: 1344 },
  { label: '横 1152×640(高速)',           w: 1152, h: 640 },
  { label: '縦 640×1152(高速)',           w: 640, h: 1152 },
  { label: '正方 960',                    w: 960, h: 960 },
] as const

export function I2VSelPopover({ projectId, fps, assets }: { projectId: number; fps: number; assets: Asset[] }) {
  const { generateVideoI2V, jobs } = useJobStore()
  const { refSel, clearRefSel, clips, addTrack, loadTimeline } = useTimelineStore()
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [sizeIdx, setSizeIdx] = useState(0)   // 既定=横1280×720
  const [frames, setFrames] = useState(81)    // Wanフレーム数(16fps, 4n+1)
  const [engine, setEngine] = useState<'wan' | 'h3'>('wan')
  const [h3Steps, setH3Steps] = useState(15)
  const snapH3 = (n: number) => { const m = Math.max(124, Math.min(362, n)); return Math.min(362, m + (5 - (m % 17)) % 17) }   // 訓練域124-362
  const [msg, setMsg] = useState('')
  const snap4n1 = (n: number) => Math.max(5, Math.round((n - 1) / 4) * 4 + 1)
  const watched = useRef<Set<number>>(new Set())

  // 選択クリップ→打点順(start_frame昇順)。同一フレームは後勝ちで重複排除。
  const kfs = useMemo(() => {
    const sel = refSel
      .map(id => clips.find(c => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c && c.asset_id != null)
      .sort((a, b) => a.start_frame - b.start_frame)
    const seen = new Set<number>()
    return sel.filter(c => (seen.has(c.start_frame) ? false : (seen.add(c.start_frame), true)))
  }, [refSel, clips])

  useEffect(() => {
    for (const j of jobs) {
      if (!watched.current.has(j.id)) continue
      if (j.status === 'completed' || j.status === 'failed') {
        watched.current.delete(j.id)
        if (j.status === 'completed') {
          loadTimeline(projectId, fps)
          setMsg('✅ 完了 — Shotsトラックに配置しました')
        } else setMsg('❌ 失敗(ジョブログ参照)')
      }
    }
  }, [jobs, projectId, fps, loadTimeline])

  const first = kfs[0], last = kfs[kfs.length - 1]
  const spanSec = kfs.length >= 2 ? (last.start_frame - first.start_frame) / fps : 0
  useEffect(() => {
    if (kfs.length >= 2) setFrames(snap4n1(Math.round(spanSec * 16)))
  }, [kfs.length, first?.start_frame, last?.start_frame])

  if (kfs.length < 2) return null

  const genFps = engine === 'h3' ? 24 : 16
  const snapFn = engine === 'h3' ? snapH3 : snap4n1
  const durSec = snapFn(frames) / genFps   // 実出力の長さ
  const model = engine === 'h3' ? 'minimax-h3'
    : kfs.length >= 3 ? 'wan2.2-vace' : 'wan2.2-flf2v'
  const modeLabel = engine === 'h3'
    ? `H3 音声付き(開始→終了${kfs.length > 2 ? `・中間${kfs.length - 2}枚は無視` : ''})`
    : kfs.length >= 3 ? `VACE(中間${kfs.length - 2}枚を位置固定)` : 'FLF2V(開始→終了)'

  const handleGen = async () => {
    setMsg('')
    try {
      let shots = useTimelineStore.getState().tracks.find(t => t.name === 'Shots' && t.track_type === 'video')
      if (!shots) {
        await addTrack(projectId, 'video', 'Shots')
        shots = useTimelineStore.getState().tracks.find(t => t.name === 'Shots' && t.track_type === 'video')
      }
      if (!shots) throw new Error('Shotsトラックを作成できませんでした')
      const presets = engine === 'h3' ? H3_PRESETS : VID_PRESETS
      const sz = presets[sizeIdx] ?? presets[0]
      // タイムライン上の相対位置を保ったまま、出力長へスケール
      const scale = spanSec > 0 ? durSec / spanSec : 1
      const useKfs = engine === 'h3' && kfs.length > 2 ? [kfs[0], kfs[kfs.length - 1]] : kfs
      const job = await generateVideoI2V({
        project_id: projectId,
        keyframes: useKfs.map(c => ({ time_sec: (c.start_frame - first.start_frame) / fps * scale, asset_id: c.asset_id! })),
        duration_sec: durSec,
        model, prompt: prompt.trim(),
        width: sz.w, height: sz.h, seed: -1, use_lightning: true,
        ...(engine === 'h3' ? { steps: h3Steps } : {}),
        place: { track_id: shots.id, start_frame: first.start_frame,
                 duration_frames: Math.round(durSec * fps) },
      })
      watched.current.add(job.id)
      setMsg(`⏳ ${modeLabel} 生成中(job ${job.id})`)
    } catch (e) { setMsg(e instanceof Error ? e.message : 'エラー') }
  }

  const inputCls = 'bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700 focus:border-purple-500'

  return (
    <span className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={`text-[11px] px-2 py-0.5 rounded border ${
          open ? 'bg-amber-900/60 text-amber-200 border-amber-600'
               : 'bg-amber-950/60 text-amber-300 border-amber-700 hover:bg-amber-900/60'
        }`}
        title="選択したキーフレーム画像から動画を生成(打点=各画像の左端)"
      >🎬 選択KF→i2v ({kfs.length})</button>

      {open && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-2 sm:p-6"
             onClick={() => setOpen(false)}>
        <div onClick={e => e.stopPropagation()}
             className="w-[min(560px,94vw)] max-h-[92vh] overflow-y-auto p-4 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-200">🎬 選択KF→i2v</span>
            <button onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
          </div>
          <div className="text-[10px] text-zinc-400">
            {kfs.map((c, i) => {
              const a = assets.find(x => x.id === c.asset_id)
              return <div key={c.id}>{i + 1}. f{c.start_frame} — {a?.name ?? `#${c.asset_id}`}</div>
            })}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
            <span>エンジン</span>
            <button onClick={() => { setEngine('wan'); setSizeIdx(0) }}
                    className={`px-2 py-1 rounded ${engine === 'wan' ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 hover:bg-zinc-700'}`}>Wan2.2</button>
            <button onClick={() => { setEngine('h3'); setSizeIdx(0) }}
                    className={`px-2 py-1 rounded ${engine === 'h3' ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 hover:bg-zinc-700'}`}>H3 音声付き</button>
            {engine === 'h3' && (
              <label className="flex items-center gap-1 ml-auto">steps
                <input type="number" min={8} max={40} value={h3Steps}
                       onChange={e => setH3Steps(Math.max(8, Math.min(40, Number(e.target.value))))}
                       className={inputCls + ' w-14'} />
              </label>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
            <span>フレーム数</span>
            <input type="number" step={engine === 'h3' ? 17 : 4} min={5} value={frames}
                   onChange={e => setFrames(snapFn(Number(e.target.value)))}
                   className={inputCls + ' w-20'} />
            {(engine === 'h3' ? [124, 226, 362] : [41, 81, 121]).map(n => (
              <button key={n} onClick={() => setFrames(n)}
                      className={`px-1.5 py-0.5 rounded ${frames === n ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 hover:bg-zinc-700'}`}>{n}</button>
            ))}
            <span className="ml-auto">= {durSec.toFixed(2)}秒({genFps}fps) → <span className="text-amber-400">{modeLabel}</span></span>
          </div>
          <p className="text-[9px] text-zinc-600">タイムライン上のKF間隔({spanSec.toFixed(2)}秒)と違う場合、動きは出力長に合わせて伸縮します。{engine === 'h3' ? 'H3: 24fps・訓練域124〜362(5.2〜15.1秒)・音声同時生成(プロンプトに音の指示可)。推奨124。' : '推奨81(4n+1)。'}</p>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2}
                    placeholder="モーションプロンプト" className={inputCls + ' resize-none'} />
          <div className="flex gap-2">
            <select value={sizeIdx} onChange={e => setSizeIdx(Number(e.target.value))} className={inputCls + ' flex-1'}>
              {(engine === 'h3' ? H3_PRESETS : VID_PRESETS).map((s, i) => <option key={i} value={i}>{s.label}</option>)}
            </select>
            <button onClick={handleGen}
                    className="text-xs px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white">▶ 生成</button>
          </div>
          <button onClick={() => { clearRefSel(); setOpen(false) }}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 self-start">選択解除</button>
          {msg && <p className="text-[10px] text-zinc-400">{msg}</p>}
        </div>
        </div>,
        document.body
      )}
    </span>
  )
}
