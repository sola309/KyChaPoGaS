import { useEffect, useRef, useState } from 'react'
import { useJobStore } from '../store/jobStore'
import { useTimelineStore } from '../store/timelineStore'
import { jobsApi } from '../api/client'

// 🔄 生成進捗ピル — 実行中/待機中ジョブを画面右下に常時表示する。
// どのタブにいても進捗率とフェーズ(モデル読み込み中など)が見える。

const TYPE_LABEL: Record<string, string> = {
  generate_image: '🖼 画像生成',
  generate_video_i2v: '🎬 動画生成',
  generate_video_s2v: '🎤 歌唱動画',
  generate_video_3dcam: '🧊 3Dカメラ動画',
  generate_audio: '🎵 音楽生成',
  generate_3d: '🧊 3D生成',
  render_final: '📤 書き出し',
  render_motion_graphics: '⚡ MG',
  puppet_clip: '🎎 パペット',
  cutout: '✂ 切り抜き',
  interpolate: '〰 補間',
}

export function JobProgressPill() {
  const jobs = useJobStore(s => s.jobs)
  const [collapsed, setCollapsed] = useState(false)
  const active = jobs.filter(j => j.status === 'running' || j.status === 'pending')

  // どのカットの生成中か表示: SSEはparamsを含まないため、実行中ジョブの詳細を
  // 1回だけ取得してplace.start_frameを取り、Imageトラックのピンペアからカット番号を引く。
  const [cutLabels, setCutLabels] = useState<Record<number, string>>({})
  const fetchedRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    for (const j of active) {
      if (j.job_type !== 'generate_video_i2v' || fetchedRef.current.has(j.id)) continue
      fetchedRef.current.add(j.id)
      void (async () => {
        try {
          const detail = await jobsApi.get(j.id)
          const p = typeof detail.params === 'string' ? JSON.parse(detail.params) : detail.params
          const sf = p?.place?.start_frame
          if (sf == null) return
          const st = useTimelineStore.getState()
          const imgTrack = st.tracks.find(t => t.track_type === 'reference' && t.name === 'Image')
          if (!imgTrack) return
          const pins = st.clips.filter(c => c.track_id === imgTrack.id && c.asset_id != null)
            .map(c => c.start_frame).sort((a, b) => a - b)
          for (let i = 0; i + 1 < pins.length; i += 2) {
            if (pins[i] <= sf && sf <= pins[i + 1]) {
              setCutLabels(m => ({ ...m, [j.id]: `C${i / 2 + 1}` }))
              return
            }
          }
          setCutLabels(m => ({ ...m, [j.id]: `f${sf}` }))
        } catch { /* 表示補助のみ・失敗は無視 */ }
      })()
    }
  }, [active])

  if (active.length === 0) return null

  return (
    <div className="fixed bottom-3 right-3 z-[90] flex flex-col items-end gap-1">
      {collapsed ? (
        <button onClick={() => setCollapsed(false)}
                className="px-3 py-1.5 rounded-full bg-zinc-900/95 border border-purple-700 text-purple-200 text-xs shadow-xl">
          ⏳ {active.length}件 実行中
        </button>
      ) : (
        <div className="w-[min(320px,90vw)] rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl p-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-zinc-400">⏳ 生成ジョブ {active.length}件</span>
            <button onClick={() => setCollapsed(true)}
                    className="text-zinc-500 hover:text-zinc-200 text-xs px-1">—</button>
          </div>
          {active.slice(0, 4).map(j => (
            <div key={j.id} className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-300 truncate">
                  {TYPE_LABEL[j.job_type] ?? j.job_type}
                  {cutLabels[j.id] && <span className="text-amber-300 ml-1 font-medium">{cutLabels[j.id]}</span>}
                  <span className="text-zinc-600 ml-1">#{j.id}</span>
                </span>
                <span className="text-zinc-400 ml-2 flex-shrink-0">
                  {j.status === 'pending' ? '待機中'
                    : (j as { phase?: string }).phase || `${Math.round(j.progress * 100)}%`}
                </span>
              </div>
              <div className="h-1 rounded bg-zinc-800 overflow-hidden">
                <div className={`h-full rounded transition-all duration-500 ${
                       j.status === 'pending' ? 'bg-zinc-600 w-2' : 'bg-purple-500'}`}
                     style={j.status === 'running' ? { width: `${Math.max(4, j.progress * 100)}%` } : undefined} />
              </div>
            </div>
          ))}
          {active.length > 4 && (
            <span className="text-[9px] text-zinc-600">…ほか{active.length - 4}件</span>
          )}
        </div>
      )}
    </div>
  )
}
