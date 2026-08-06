import { useMemo, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { Asset } from '../../api/client'
import { jobsApi, type NightBatchState } from '../../api/client'
import { useJobStore } from '../../store/jobStore'
import { useTimelineStore } from '../../store/timelineStore'

/**
 * 🌙 夜間優先生成 — 選んだカットを「均等ラウンドロビン」でランダムシード生成し続ける。
 * 各カットの直近生成パラメータ(gen_params)を土台に seed だけ変えて回すので、
 * 参照画像・プロンプト・参照動画はそのまま。停止するまで公平に本数を積む。
 * 生成物は自動配置せずテイク蓄積(place.auto=false)→ 朝に🗂テイク履歴から採用。
 * ループはサーバ常駐(ブラウザを閉じても継続・サーバ再起動後も自動再開)。
 * 🔒ロック済みカットは対象から自動除外。
 */
interface Props {
  projectId: number   // ★優先度のlocalStorageキーに使用
  fps: number
  assets: Asset[]
  onClose: () => void
}

interface CutRow {
  n: number
  s: number
  e: number
  clipId?: number
  locked: boolean
  hasParams: boolean
  takes: number
}

export function NightBatchPanel({ projectId, fps, assets, onClose }: Props) {
  const tracks = useTimelineStore(s => s.tracks)
  const clips = useTimelineStore(s => s.clips)
  const jobs = useJobStore(s => s.jobs)
  // 優先度: カット開始フレーム → 重み(1〜3)。未選択カットは対象外。
  // 重みは「投入本数の比率」= ★3は★1の3倍の頻度で回る。
  // パネルを閉じても維持されるようlocalStorageへ永続化(カット番号ではなく
  // 開始フレームをキーにするので、前方のカット増減で★がズレない)。
  const PRIO_KEY = `kychapogas:nightprio:${projectId}`
  const [prioByFrame, setPrioByFrame] = useState<Record<number, number>>(() => {
    try { return JSON.parse(localStorage.getItem(PRIO_KEY) || '{}') } catch { return {} }
  })
  useEffect(() => {
    try { localStorage.setItem(PRIO_KEY, JSON.stringify(prioByFrame)) } catch { /* noop */ }
  }, [PRIO_KEY, prioByFrame])
  const [msg, setMsg] = useState('')

  const shotsTrack = tracks.find(t => t.track_type === 'video' && t.name === 'Shots')
  const imgTrack = tracks.find(t => t.track_type === 'reference' && t.name === 'Image' && !t.hidden)

  const cuts = useMemo<CutRow[]>(() => {
    if (!imgTrack) return []
    const pins = clips.filter(c => c.track_id === imgTrack.id && c.asset_id != null)
      .sort((a, b) => a.start_frame - b.start_frame)
    const out: CutRow[] = []
    for (let i = 0; i + 1 < pins.length; i += 2) {
      const s = pins[i].start_frame
      const e = pins[i + 1].start_frame
      const clip = shotsTrack ? clips.find(c => c.track_id === shotsTrack.id && c.start_frame === s) : undefined
      const asset = clip?.asset_id != null ? assets.find(a => a.id === clip.asset_id) : undefined
      let hasParams = false
      try { hasParams = !!JSON.parse(asset?.gen_params_json || '{}')?.prompt } catch { /* noop */ }
      const takes = assets.filter(a => {
        try {
          const p = JSON.parse(a.gen_params_json || '{}')
          return p?.place?.start_frame === s && a.duration_sec != null
        } catch { return false }
      }).length
      out.push({ n: out.length + 1, s, e, clipId: clip?.id, locked: !!clip?.locked, hasParams, takes })
    }
    return out
  }, [imgTrack, shotsTrack, clips, assets])

  // カット番号→重み(🔒ロック済みは常に対象外 = ★無効)
  const priority = useMemo(() => {
    const m: Record<number, number> = {}
    for (const c of cuts) {
      if (c.locked) continue
      const w = prioByFrame[c.s] ?? 0
      if (w > 0) m[c.n] = w
    }
    return m
  }, [cuts, prioByFrame])
  const selected = useMemo(() => new Set(Object.keys(priority).map(Number)), [priority])

  const eligible = cuts.filter(c => !c.locked && c.hasParams)

  // タップで 無効→★1→★2→★3→無効 と巡回
  const cyclePriority = (frame: number) =>
    setPrioByFrame(prev => {
      const w = (prev[frame] ?? 0) + 1
      const next = { ...prev }
      if (w > 3) delete next[frame]; else next[frame] = w
      return next
    })

  // サーバ常駐ループの状態をポーリング(ブラウザを閉じても生成は継続する)
  const [server, setServer] = useState<NightBatchState>({})
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const st = await jobsApi.nightBatchState()
        if (alive) setServer(st)
      } catch { /* noop */ }
    }
    void tick()
    const iv = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(iv) }
  }, [])
  const running = !!server.running
  const counts = server.counts ?? {}

  const start = async () => {
    if (!selected.size) { setMsg('カットを選択してください'); return }
    const weights: Record<string, number> = {}
    for (const c of cuts) {
      if (c.locked) continue
      const w = prioByFrame[c.s] ?? 0
      if (w > 0 && c.hasParams) weights[String(c.s)] = w
    }
    try {
      setServer(await jobsApi.nightBatchStart(projectId, weights))
      setMsg('🌙 開始しました — ブラウザを閉じてもサーバ側で生成し続けます')
    } catch { setMsg('⚠ 開始に失敗しました') }
  }
  const stop = async () => {
    try {
      setServer(await jobsApi.nightBatchStop())
      setMsg('⏹ 停止しました(投入済みジョブは最後まで実行されます)')
    } catch { setMsg('⚠ 停止に失敗しました') }
  }

  const activeJobs = jobs.filter(j => j.job_type === 'generate_video_i2v' && (j.status === 'running' || j.status === 'pending')).length

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-2 sm:p-6" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[min(720px,96vw)] max-h-[94vh] overflow-y-auto p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-zinc-200">🌙 夜間優先生成 — 選択カットを均等にランダムシード生成</span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
        </div>

        <div className="flex items-center gap-2 flex-wrap text-[10px]">
          <button onClick={() => setPrioByFrame(Object.fromEntries(eligible.map(c => [c.s, 1])))}
                  className="px-2 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">全★1({eligible.length})</button>
          <button onClick={() => setPrioByFrame({})}
                  className="px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700">クリア</button>
          <span className="text-zinc-500">
            選択 {selected.size}件(★3:{Object.values(priority).filter(w => w === 3).length} /
            ★2:{Object.values(priority).filter(w => w === 2).length} /
            ★1:{Object.values(priority).filter(w => w === 1).length}) / 実行中・待機 {activeJobs}件
          </span>
          <div className="ml-auto flex gap-2">
            {!running ? (
              <button onClick={start} disabled={!selected.size}
                      className="text-xs px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40">
                ▶ 開始(停止するまで継続)
              </button>
            ) : (
              <button onClick={stop}
                      className="text-xs px-3 py-1.5 rounded bg-red-800 hover:bg-red-700 text-white">⏹ 停止</button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 max-h-[52vh] overflow-y-auto pr-1">
          {cuts.map(c => {
            const w = priority[c.n] ?? 0
            const disabled = c.locked || !c.hasParams
            return (
              <button key={c.n} onClick={() => !disabled && cyclePriority(c.s)} disabled={disabled}
                      className={`text-left text-[10px] px-2 py-1.5 rounded border flex flex-col gap-0.5
                        ${disabled ? 'border-zinc-800 bg-zinc-950 text-zinc-600'
                          : w === 3 ? 'border-amber-400 bg-amber-950/40 text-amber-100'
                          : w === 2 ? 'border-purple-400 bg-purple-950/40 text-purple-100'
                          : w === 1 ? 'border-zinc-500 bg-zinc-800 text-zinc-200'
                               : 'border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:border-zinc-500'}`}
                      title={c.locked ? '🔒ロック中 — ★は無効(解除すると再び対象になります)'
                        : !c.hasParams ? '生成履歴がないため対象外'
                        : 'タップで優先度: なし→★1→★2→★3(★の比率で本数配分)'}>
                <span className="flex items-center gap-1">
                  {c.locked && '🔒'}
                  <span className={w ? 'text-amber-300' : 'text-zinc-700'}>
                    {c.locked ? '—' : ('★'.repeat(w) || '☆')}
                  </span>
                  C{c.n}
                  <span className="text-zinc-500">{(c.s / fps).toFixed(1)}s</span>
                </span>
                <span className="text-[9px] text-zinc-500">
                  テイク{c.takes}{counts[String(c.s)] ? ` / 今回+${counts[String(c.s)]}` : ''}
                </span>
              </button>
            )
          })}
        </div>

        <p className="text-[9px] text-zinc-600">
          カットをタップで優先度を設定(なし→★1→★2→★3)。<span className="text-amber-300">★の比率で本数が配分</span>されます(★3は★1の3倍)。
          各カットの直近生成条件(プロンプト/参照画像/参照動画)をそのまま使い、seedだけランダムにして回します。ループはサーバ側で動くのでブラウザを閉じても継続します。
          生成物はタイムラインに自動配置されず🗂テイク履歴に蓄積 — 朝に見比べて採用してください。
          🔒ロック済み・生成履歴なしのカットは自動的に対象外です。
        </p>
        {msg && <p className="text-[10px] text-amber-300">{msg}</p>}
      </div>
    </div>,
    document.body
  )
}
