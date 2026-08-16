import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjectStore } from '../store/projectStore'
import { useJobStore } from '../store/jobStore'
import { jobsApi, type RenderFile } from '../api/client'

interface Props {
  onClose: () => void
}

const fmtSize = (b: number) =>
  b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.round(b / (1 << 20))} MB`

const fmtWhen = (iso: string) => {
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z')
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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

  // 📥 書き出し履歴 — 実在するファイルだけをAPIから取る。
  // レンダリングが完了したら自動で並び直すよう、完了本数の変化を見て取り直す。
  const [renders, setRenders] = useState<RenderFile[]>([])
  const doneCount = jobs.filter(j => j.job_type === 'render_final' && j.status === 'completed').length
  const projectId = activeProject.id
  const loadRenders = useCallback(() => {
    jobsApi.listRenders(projectId).then(setRenders).catch(() => setRenders([]))
  }, [projectId])
  useEffect(() => { loadRenders() }, [loadRenders, doneCount])

  const removeRender = async (id: number) => {
    if (!window.confirm(`書き出しファイル render_${id}.mp4 を削除しますか？`)) return
    await jobsApi.deleteRender(id)
    loadRenders()
  }

  // body直下に出す。タイムライン内に描くと、祖先が作る重なり文脈に閉じ込められ、
  // 端末やブラウザによってはツールバーやジョブ一覧の下に潜ってしまう(スマホで発生)。
  // z は他のモーダルより上の層にして、生成ジョブ一覧(z-[90])にも確実に勝たせる。
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-2 sm:p-6"
         onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-80 max-w-full p-5
                   max-h-[85dvh] overflow-y-auto overscroll-contain"
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

        {/* 書き出し履歴 — ここから選んでダウンロードする */}
        <div className="mt-4 pt-3 border-t border-zinc-800">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-zinc-300">📥 書き出し履歴</span>
            <span className="text-[10px] text-zinc-600">{renders.length}件</span>
          </div>
          {renders.length === 0 ? (
            <p className="text-[10px] text-zinc-600">まだ書き出したファイルはありません。</p>
          ) : (
            <div className="flex flex-col gap-1 max-h-44 overflow-y-auto pr-0.5">
              {renders.map(r => (
                <div key={r.job_id}
                     className="flex items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-zinc-200 truncate">{r.filename}</div>
                    <div className="text-[9px] text-zinc-500">
                      {fmtWhen(r.created_at)}　{r.width}×{r.height}
                      {r.fps ? `@${r.fps}` : ''}　{r.preset}　{fmtSize(r.size_bytes)}
                    </div>
                  </div>
                  <a href={jobsApi.downloadUrl(r.job_id)} download={r.filename}
                     className="text-[10px] px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white flex-shrink-0"
                     title="このファイルをダウンロード">⬇ 保存</a>
                  <button onClick={() => void removeRender(r.job_id)}
                          className="text-zinc-600 hover:text-red-400 text-xs px-0.5 flex-shrink-0"
                          title="書き出しファイルを削除">✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="mt-3 text-[10px] text-zinc-600 text-center">
          ジョブキュー（⚙タブ）で進捗を確認できます
        </p>
      </div>
    </div>,
    document.body,
  )
}
