import { useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useJobStore } from '../store/jobStore'
import { jobsApi } from '../api/client'

interface Props {
  onClose: () => void
}

export function RenderDialog({ onClose }: Props) {
  const { activeProject } = useProjectStore()
  const { jobs } = useJobStore()

  const [width,  setWidth]  = useState(activeProject?.width  ?? 1920)
  const [height, setHeight] = useState(activeProject?.height ?? 1080)
  const [fps,    setFps]    = useState(activeProject?.fps    ?? 30)
  const [review, setReview] = useState(false)   // 720pレビュー(高速エンコード)
  const [busy,   setBusy]   = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  if (!activeProject) return null

  const applyPreset = (p: 'review' | 'final') => {
    if (p === 'review') { setWidth(1280); setHeight(720); setReview(true) }
    else { setWidth(activeProject.width ?? 1920); setHeight(activeProject.height ?? 1080); setReview(false) }
  }

  const handleRender = async () => {
    setBusy(true)
    setError(null)
    try {
      await jobsApi.create(activeProject.id, 'render_final', {
        project_id: activeProject.id,
        width, height, fps,
        ...(review ? { encoder: 'x264_fast' } : {}),
      })
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'エラーが発生しました')
    } finally {
      setBusy(false)
    }
  }

  const runningRenders = jobs.filter(j =>
    j.job_type === 'render_final' && (j.status === 'pending' || j.status === 'running')
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-80 p-5"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-sm font-bold text-white mb-4">最終レンダリング</h2>

        {runningRenders.length > 0 && (
          <div className="mb-3 text-[11px] text-amber-400 bg-amber-950/30 border border-amber-800 rounded px-2 py-1.5">
            レンダリング実行中 ({runningRenders.length}件)
          </div>
        )}

        {/* Presets */}
        <div className="flex gap-2 mb-3">
          <button onClick={() => applyPreset('review')}
            className={`flex-1 py-1.5 rounded text-xs border ${review ? 'bg-amber-800/50 border-amber-600 text-amber-200' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'}`}>
            📱 720pレビュー(速い)
          </button>
          <button onClick={() => applyPreset('final')}
            className={`flex-1 py-1.5 rounded text-xs border ${!review ? 'bg-purple-800/50 border-purple-600 text-purple-200' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'}`}>
            🎬 本番品質
          </button>
        </div>

        {/* Settings */}
        <div className="space-y-3">
          <div className="flex gap-2">
            <label className="flex flex-col gap-1 flex-1">
              <span className="text-[10px] text-zinc-500">幅</span>
              <select value={width} onChange={e => setWidth(Number(e.target.value))}
                className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 border border-zinc-700 outline-none">
                <option value={1920}>1920</option>
                <option value={1280}>1280</option>
                <option value={854}>854</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 flex-1">
              <span className="text-[10px] text-zinc-500">高さ</span>
              <select value={height} onChange={e => setHeight(Number(e.target.value))}
                className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 border border-zinc-700 outline-none">
                <option value={1080}>1080</option>
                <option value={720}>720</option>
                <option value={480}>480</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 w-16">
              <span className="text-[10px] text-zinc-500">FPS</span>
              <select value={fps} onChange={e => setFps(Number(e.target.value))}
                className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 border border-zinc-700 outline-none">
                <option value={30}>30</option>
                <option value={24}>24</option>
                <option value={60}>60</option>
              </select>
            </label>
          </div>

          <div className="text-[10px] text-zinc-600 bg-zinc-800/50 rounded px-2 py-1.5">
            コーデック: H.264 MP4　&nbsp;|&nbsp;
            {width}×{height} @ {fps}fps
          </div>
        </div>

        {error && <p className="mt-2 text-[10px] text-red-400">{error}</p>}

        <div className="flex gap-2 mt-4">
          <button onClick={onClose}
            className="flex-1 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm">
            キャンセル
          </button>
          <button onClick={handleRender} disabled={busy}
            className="flex-1 py-2 rounded bg-purple-700 hover:bg-purple-600 text-white text-sm font-medium disabled:opacity-40">
            {busy ? 'キュー追加中…' : '▶ レンダリング開始'}
          </button>
        </div>

        <p className="mt-3 text-[10px] text-zinc-600 text-center">
          ジョブキュー（⚙タブ）で進捗を確認できます
        </p>
      </div>
    </div>
  )
}
