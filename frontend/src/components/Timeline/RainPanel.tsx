// 🌧 雨フィルターの調整パネル(kind='rain' のクリップ)。ClipInspector から開く。
//  強さ = クリップの不透明度(すぐ反映)。ほかの設定は「雨を作り直す」で層を作り直して反映する
//  (CPU のジョブ、1 カット 10〜30 秒ほど)。作り直す前の層は「これまでの雨」から戻せる。
//  雨はいつもそのカットの元動画の雨筋だけを使う(使い回し・一様な雨は作らない)。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Clip } from '../../api/client'
import { jobsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import {
  type RainSettings, type RainTake, type RainKey, rainOf, sameLook, lookOnly, rainApi, rainSummary, parseAttrs,
} from './rainFx'

interface Props {
  clip: Clip
  onChange: (patch: Partial<Clip>) => void     // 不透明度(強さ)のすぐ反映用(liveUpdateClip)
  onClose: () => void
}

interface RowDef {
  key: RainKey; label: string; hint: string
  min: number; max: number; step: number
  ends?: [string, string]
  fmt: (v: number) => string
}

// ユーザーが目で見て言う言葉で並べる(10/15「雨粒が大きかったり目立ちすぎていたり」)
const MAIN_ROWS: RowDef[] = [
  { key: 'wmax', label: '粒の細さ', hint: 'これより太い筋は消す(幅の上限)', min: 1, max: 10, step: 1,
    ends: ['細い粒だけ', '太いのも'], fmt: v => `幅≤${v}px` },
  { key: 'hmax', label: '粒の長さ', hint: 'これより長い筋は消す(長さの上限)', min: 10, max: 200, step: 5,
    ends: ['短い粒だけ', '長いのも'], fmt: v => `≤${v}px` },
  { key: 't0', label: '量', hint: '淡い筋から消える。右ほど少ない', min: 0.5, max: 15, step: 0.5,
    ends: ['多い', '少ない'], fmt: v => v.toFixed(1) },
  { key: 'blur', label: 'ぼかし', hint: '筋をやわらかく', min: 0, max: 4, step: 0.1, fmt: v => `σ${v.toFixed(1)}` },
  { key: 'glint', label: 'きらめき', hint: 'しずくが光を返す小さな光の点', min: 0, max: 1.5, step: 0.05, fmt: v => v.toFixed(2) },
  { key: 'glow', label: 'にじむ光', hint: '筋のまわりのやわらかな光', min: 0, max: 2, step: 0.05, fmt: v => v.toFixed(2) },
  { key: 'twinkle', label: 'ちらつき', hint: '筋 1 本ずつの明るさのばらつき', min: 0, max: 1, step: 0.05, fmt: v => v.toFixed(2) },
  { key: 'lit', label: '明かりで光る', hint: '明るい所の近くの筋ほど明るく(夜)', min: 0, max: 1, step: 0.05, fmt: v => v.toFixed(2) },
]
const DETAIL_ROWS: RowDef[] = [
  { key: 'k', label: '濃さの上限', hint: '層に焼き込む濃さ(強さ 100% のときの濃さ。光の頭打ちにも効く)', min: 0.2, max: 3, step: 0.05, fmt: v => `×${v.toFixed(2)}` },
  { key: 't1', label: '濃くなる明るさ', hint: 'この明るさの筋で濃さが最大。上げると全体に淡く', min: 1, max: 40, step: 0.5, fmt: v => v.toFixed(1) },
  { key: 'L', label: '短い筋の下限', hint: 'これより短い縦の線は雨とみなさない', min: 3, max: 31, step: 1, fmt: v => `${v}px` },
  { key: 'gap', label: '比べるコマ', hint: '2 コマ打ちの雨は 2(前後のコマにも出る柱などを外す)', min: 1, max: 3, step: 1, fmt: v => `±${v}` },
]

const STATUS_JA: Record<string, string> = { pending: '順番待ち', running: '作り直し中', completed: '完了', failed: '失敗', cancelled: '取り消し' }

export function RainPanel({ clip, onChange, onClose }: Props) {
  const tracks = useTimelineStore(s => s.tracks)
  const clips = useTimelineStore(s => s.clips)
  const syncFromServer = useTimelineStore(s => s.syncFromServer)
  const updateClip = useTimelineStore(s => s.updateClip)
  const projectId = tracks.find(t => t.id === clip.track_id)?.project_id

  const current = useMemo(() => rainOf(clip), [clip])
  const [draft, setDraft] = useState<RainSettings>(current)
  const [showDetail, setShowDetail] = useState(false)
  const [job, setJob] = useState<{ id: number; status: string; progress: number; phase?: string; error?: string | null } | null>(null)
  const [msg, setMsg] = useState('')
  const [takes, setTakes] = useState<RainTake[]>([])
  const [sent, setSent] = useState<RainSettings | null>(null)    // 最後に「作り直す」で送った設定

  // 層が作り直された(attrs が変わった)ら、手元の設定をそれに合わせる。ただし作り直しの間に
  // さらに動かしていたら、その続きは残す(描画中に前の値と比べて合わせる: React の推奨の書き方)。
  const curKey = JSON.stringify(lookOnly(current))
  const [seen, setSeen] = useState<{ key: string; cur: RainSettings }>({ key: curKey, cur: current })
  if (seen.key !== curKey) {
    setSeen({ key: curKey, cur: current })
    if (sameLook(draft, seen.cur) || (sent && sameLook(draft, sent))) setDraft(current)
  }

  const loadTakes = useCallback(() => {
    rainApi.takes(clip.id).then(setTakes).catch(() => setTakes([]))
  }, [clip.id])
  useEffect(() => { loadTakes() }, [loadTakes, clip.asset_id])

  // ジョブの見張り(1 秒ごと)
  useEffect(() => {
    if (!job || !['pending', 'running'].includes(job.status)) return
    let stop = false
    const t = setTimeout(async () => {
      try {
        const j = await jobsApi.get(job.id)
        if (stop) return
        setJob({ id: j.id, status: j.status, progress: j.progress, phase: j.phase, error: j.error_msg })
        if (j.status === 'completed') {
          if (projectId != null) await syncFromServer(projectId)
          loadTakes()
          let note = ''
          try { note = JSON.parse((j as unknown as { result_json?: string }).result_json || '{}').note ?? '' } catch { /* noop */ }
          setMsg(note ? `⚠ ${note}` : '✓ 作り直しました(前の雨は「これまでの雨」から戻せます)')
        } else if (j.status === 'failed') {
          setMsg(`⚠ 作り直しに失敗しました: ${j.error_msg ?? ''}`)
        }
      } catch { if (!stop) setJob(s => (s ? { ...s } : s)) }   // 次の見張りへ
    }, 1000)
    return () => { stop = true; clearTimeout(t) }
  }, [job, projectId, syncFromServer, loadTakes])

  const busy = !!job && ['pending', 'running'].includes(job.status)
  const dirty = !sameLook(draft, current)
  const set = (k: RainKey, v: number | null) => setDraft(d => {
    const n = { ...d, [k]: v } as RainSettings
    if (k === 't0' && typeof v === 'number') {   // 量: しきい値の幅(t1 − t0)は保つ
      n.t1 = Math.round((d.t1 + (v - d.t0)) * 100) / 100
    }
    if (k === 't1' && typeof v === 'number' && v <= n.t0) n.t1 = n.t0 + 0.5
    return n
  })

  const rerender = async () => {
    setMsg('')
    try {
      setSent(draft)
      const j = await rainApi.render(clip.id, lookOnly(draft))
      setJob({ id: j.id, status: j.status, progress: j.progress })
    } catch (e) {
      const d = (e as { response?: { status?: number; data?: { detail?: unknown } } })?.response
      const det = d?.data?.detail as { error?: string; job_id?: number } | string | undefined
      if (d?.status === 409 && typeof det === 'object' && det?.job_id) {
        setJob({ id: det.job_id, status: 'running', progress: 0 })   // 作り直し中のジョブを見張る
        setMsg('作り直し中のジョブがあります。終わるまで待ってください')
      } else {
        setMsg(`⚠ ${typeof det === 'string' ? det : det?.error ?? '作り直しを始められませんでした'}`)
      }
    }
  }

  const cancel = async () => { if (job) { try { await jobsApi.cancel(job.id) } catch { /* noop */ } } }

  const adoptTake = async (t: RainTake) => {
    const attrs = parseAttrs(clip.attrs_json)
    attrs.rain = { ...t.rain, asset_id: t.asset_id, job_id: t.job_id ?? undefined, base_asset_ids: t.base_asset_ids ?? [] }
    await updateClip(clip.id, {
      asset_id: t.asset_id,
      asset_in_frame: Math.max(0, clip.start_frame - (t.start_frame ?? clip.start_frame)),
      attrs_json: JSON.stringify(attrs),
    })
    setMsg(`この雨に戻しました(#${t.job_id ?? t.asset_id})`)
  }

  // 下の絵が作ったときと変わっていないか(雨の色と「明かりで光る」は下の絵から作る)
  const baseChanged = useMemo(() => {
    const was = current.base_asset_ids
    if (!was || !was.length) return false
    const me = tracks.find(t => t.id === clip.track_id)
    if (!me) return false
    const below = tracks.filter(t => t.track_type === 'video' && !t.hidden && t.order > me.order).sort((a, b) => a.order - b.order)
    const at = (f: number) => {
      for (const t of below) {
        const hit = clips.filter(c => c.track_id === t.id && c.asset_id != null && !['rain', 'solid', 'blur', 'satsuei'].includes(c.kind)
          && c.start_frame <= f && f < c.start_frame + c.duration_frames).sort((a, b) => b.start_frame - a.start_frame)[0]
        if (hit) return hit.asset_id
      }
      return null
    }
    const s = clip.start_frame, e = clip.start_frame + clip.duration_frames - 1
    return [s, Math.round((s + e) / 2), e].some(f => { const a = at(f); return a != null && !was.includes(a) })
  }, [current.base_asset_ids, tracks, clips, clip.track_id, clip.start_frame, clip.duration_frames])

  const row = (r: RowDef) => {
    const v = Number(draft[r.key] ?? 0)
    const changed = Number(current[r.key] ?? 0) !== v
    return (
      <div key={r.key} className="mb-1.5" title={r.hint}>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] w-[5.5rem] flex-shrink-0 ${changed ? 'text-sky-300' : 'text-zinc-400'}`}>{r.label}</span>
          <input type="range" min={r.min} max={r.max} step={r.step} value={v}
                 onChange={e => set(r.key, Number(e.target.value))}
                 className="flex-1 h-1 accent-sky-500" />
          <span className={`text-[10px] w-14 text-right tabular-nums ${changed ? 'text-sky-300' : 'text-zinc-400'}`}>{r.fmt(v)}</span>
        </div>
        {r.ends && (
          <div className="flex justify-between text-[9px] text-zinc-600 pl-[6rem] pr-14 -mt-0.5"><span>{r.ends[0]}</span><span>{r.ends[1]}</span></div>
        )}
      </div>
    )
  }

  const opacity = clip.opacity ?? 1
  const cutOn = (draft.cut ?? 0) > 0
  const blur2 = draft.blur2 ?? draft.blur
  // ツールバー(横スクロール)の中に置くと切れて見えないので body へ出す。プレビューを隠さないよう右下に浮かべる
  // (背景を暗くしない = 再生・コマ送りしながら調整できる)
  return createPortal(
    <div className="fixed right-3 bottom-3 w-[340px] max-w-[calc(100vw-1.5rem)] max-h-[80dvh] overflow-y-auto overscroll-contain rounded-lg border border-sky-800 bg-zinc-900/95 shadow-2xl backdrop-blur p-3 z-[110] text-zinc-200"
         onKeyDown={e => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-semibold text-sky-200">🌧 雨(f{clip.start_frame}〜{clip.start_frame + clip.duration_frames - 1})</span>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-xs leading-none">✕</button>
      </div>
      <p className="text-[9px] text-zinc-500 mb-2 leading-tight">
        元動画のこのカットの雨筋だけを使っています。強さはすぐ変わります。ほかは「雨を作り直す」で反映(10〜30 秒)。
      </p>

      {/* 強さ = 不透明度(すぐ反映)。下限は 1%: 書き出しは不透明度 0 を 1.0(100%)として扱う
          (ffmpeg_render の `opacity or 1.0`)ので、0% にするとプレビューは雨なし・書き出しは雨 100% になる */}
      <div className="flex items-center gap-2 mb-2" title="雨全体の濃さ(クリップの不透明度)。すぐ反映されます(雨を消すときはクリップを消すか、プレビューで隠す)">
        <span className="text-[10px] font-semibold text-zinc-200 w-[5.5rem] flex-shrink-0">強さ(すぐ反映)</span>
        <input type="range" min={1} max={100} step={1} value={Math.max(1, Math.round(opacity * 100))}
               onChange={e => onChange({ opacity: Math.max(1, Number(e.target.value)) / 100 })}
               className="flex-1 h-1 accent-sky-400" />
        <span className="text-[10px] w-14 text-right tabular-nums text-zinc-300">{Math.round(opacity * 100)}%</span>
      </div>
      <div className="h-px bg-zinc-800 mb-2" />

      {MAIN_ROWS.map(row)}

      {/* 寄りでのぼかし(背景がぼけた寄りでは雨も手前でぼける) */}
      <div className="mb-1.5 mt-1" title="このコマから先(寄り)は筋を強くぼかす">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-[10px] w-[5.5rem] flex-shrink-0 cursor-pointer select-none">
            <input type="checkbox" checked={cutOn} className="accent-sky-500 w-3 h-3"
                   onChange={e => {
                     if (!e.target.checked) { set('cut', 0); return }
                     const f = useTimelineStore.getState().currentFrame - clip.start_frame
                     set('cut', Math.max(1, Math.min(clip.duration_frames - 1, f > 0 ? f : Math.round(clip.duration_frames / 2))))
                   }} />
            <span className={(draft.cut ?? 0) !== (current.cut ?? 0) || (draft.blur2 ?? draft.blur) !== (current.blur2 ?? current.blur) ? 'text-sky-300' : 'text-zinc-400'}>寄りでのぼかし</span>
          </label>
          <input type="range" min={0} max={5} step={0.1} value={blur2} disabled={!cutOn}
                 onChange={e => set('blur2', Number(e.target.value))} className="flex-1 h-1 accent-sky-500 disabled:opacity-30" />
          <span className="text-[10px] w-14 text-right tabular-nums text-zinc-400">{cutOn ? `σ${blur2.toFixed(1)}` : 'なし'}</span>
        </div>
        {cutOn && (
          <div className="flex items-center gap-1 pl-[6rem] text-[9px] text-zinc-500">
            <span>{draft.cut} コマ目(f{clip.start_frame + draft.cut})から</span>
            <button className="ml-auto px-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                    title="再生ヘッドの位置から強くぼかす"
                    onClick={() => {
                      const f = useTimelineStore.getState().currentFrame - clip.start_frame
                      if (f >= 1 && f < clip.duration_frames) set('cut', f)
                    }}>◆ 再生ヘッドから</button>
          </div>
        )}
      </div>

      <button onClick={() => setShowDetail(v => !v)} className="text-[10px] text-zinc-500 hover:text-zinc-300 mb-1">
        {showDetail ? '▾' : '▸'} 細かい設定
      </button>
      {showDetail && (
        <div className="pl-1 mb-1">
          {DETAIL_ROWS.map(row)}
          <p className="text-[9px] text-zinc-600 leading-tight">
            元動画: 素材 #{current.src_asset_id ?? '?'} の f{clip.start_frame + (current.src_offset ?? 0)}〜
            {current.job_id ? ` / 今の層: ジョブ #${current.job_id}` : ''}
          </p>
        </div>
      )}

      {baseChanged && (
        <p className="text-[10px] text-amber-300 mb-1 leading-tight">
          下の絵(Shots)が、この雨を作ったときと変わっています。雨の色と「明かりで光る」を合わせるには作り直してください。
        </p>
      )}

      <div className="flex items-center gap-2 mt-2">
        <button onClick={rerender} disabled={busy || clip.locked}
                className={`text-[11px] px-2.5 py-1 rounded border ${dirty || baseChanged
                  ? 'bg-sky-700 hover:bg-sky-600 text-white border-sky-400'
                  : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-700'} disabled:opacity-40`}
                title={clip.locked ? '🔒ロック中は作り直せません' : 'この設定で雨の層を作り直して差し替える(前の層は残ります)'}>
          🌧 雨を作り直す
        </button>
        <button onClick={() => setDraft(current)} disabled={!dirty || busy}
                className="text-[10px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 disabled:opacity-30"
                title="動かしたつまみを、今の雨の設定に戻す">今の設定に戻す</button>
        {busy && <button onClick={cancel} className="text-[10px] text-zinc-500 hover:text-red-300 ml-auto">取り消す</button>}
      </div>
      {dirty && !busy && <p className="text-[9px] text-sky-400 mt-1">まだ反映されていません(青いつまみ)。「雨を作り直す」で反映します。</p>}
      {job && (
        <div className="mt-1.5">
          <div className="flex justify-between text-[9px] text-zinc-400">
            <span>#{job.id} {STATUS_JA[job.status] ?? job.status}{busy && job.phase ? ` — ${job.phase}` : ''}</span>
            <span className="tabular-nums">{Math.round((job.progress ?? 0) * 100)}%</span>
          </div>
          <div className="h-1 bg-zinc-800 rounded mt-0.5"><div className="h-1 bg-sky-500 rounded" style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} /></div>
        </div>
      )}
      {msg && <p className="text-[10px] text-zinc-300 mt-1 leading-tight">{msg}</p>}

      {takes.length > 0 && (
        <div className="mt-2 border-t border-zinc-800 pt-1.5">
          <div className="text-[10px] text-zinc-400 mb-1">これまでの雨({takes.length})</div>
          {takes.slice(0, 12).map(t => (
            <div key={t.asset_id} className={`flex items-center gap-1.5 text-[9px] py-0.5 ${t.current ? 'text-sky-200' : 'text-zinc-400'}`}>
              <span className="w-12 flex-shrink-0 tabular-nums">#{t.job_id ?? t.asset_id}</span>
              <span className="flex-1 truncate" title={rainSummary(t.rain)}>{rainSummary(t.rain)}</span>
              {t.current
                ? <span className="text-sky-400">使用中</span>
                : <button onClick={() => { void adoptTake(t) }} disabled={busy || clip.locked}
                          className="px-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-30">使う</button>}
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}
