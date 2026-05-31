import type { Job, JobStatus } from '../../api/client'
import { jobsApi } from '../../api/client'
import { useJobStore } from '../../store/jobStore'

const STATUS_STYLE: Record<JobStatus, string> = {
  pending:   'bg-zinc-700 text-zinc-300',
  running:   'bg-blue-800 text-blue-200',
  completed: 'bg-green-900 text-green-300',
  failed:    'bg-red-900 text-red-300',
  cancelled: 'bg-zinc-800 text-zinc-500',
}

const TYPE_LABEL: Record<string, string> = {
  generate_image:     '🖼 画像生成',
  generate_audio:     '🎵 音楽生成',
  generate_video_i2v: '🎬 動画生成 (I2V)',
}

function JobCard({ job }: { job: Job }) {
  const { cancelJob, deleteJob } = useJobStore()

  const canCancel  = job.status === 'pending' || job.status === 'running'
  const canDelete  = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
  const elapsed    = job.started_at
    ? ((job.completed_at ? new Date(job.completed_at) : new Date()).getTime()
       - new Date(job.started_at).getTime()) / 1000
    : null

  return (
    <div className="px-3 py-2 border-b border-zinc-800 hover:bg-zinc-900/50">
      {/* Type + status */}
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] text-zinc-300 flex-1 truncate">
          {TYPE_LABEL[job.job_type] ?? job.job_type}
        </span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded ${STATUS_STYLE[job.status]}`}>
          {job.status}
        </span>
      </div>

      {/* Progress bar (running only) */}
      {job.status === 'running' && (
        <div className="w-full bg-zinc-800 rounded h-1 mb-1 overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-500"
            style={{ width: `${Math.round(job.progress * 100)}%` }}
          />
        </div>
      )}

      {/* Error message */}
      {job.error_msg && (
        <p className="text-[10px] text-red-400 truncate">{job.error_msg}</p>
      )}

      {/* Elapsed / result */}
      <div className="flex items-center gap-2 mt-0.5">
        {elapsed !== null && (
          <span className="text-[10px] text-zinc-600">
            {elapsed.toFixed(0)}s
          </span>
        )}
        {job.result_asset_ids.length > 0 && (
          <span className="text-[10px] text-green-500">
            → {job.result_asset_ids.length} asset{job.result_asset_ids.length > 1 ? 's' : ''}
          </span>
        )}

        <div className="ml-auto flex gap-1">
          {/* Download for completed render jobs */}
          {job.status === 'completed' && job.job_type === 'render_final' && (
            <a
              href={jobsApi.downloadUrl(job.id)}
              download={`render_${job.id}.mp4`}
              className="text-[10px] px-1.5 py-0.5 rounded bg-green-900 hover:bg-green-800 text-green-300"
            >⬇ DL</a>
          )}
          {canCancel && (
            <button
              onClick={() => cancelJob(job.id)}
              className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
            >停止</button>
          )}
          {canDelete && (
            <button
              onClick={() => deleteJob(job.id)}
              className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-red-900 text-zinc-500 hover:text-red-300"
            >削除</button>
          )}
        </div>
      </div>
    </div>
  )
}

export function JobQueuePanel() {
  const { jobs, loading, comfyAvailable } = useJobStore()

  const running   = jobs.filter(j => j.status === 'running')
  const pending   = jobs.filter(j => j.status === 'pending')
  const done      = jobs.filter(j => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled')

  return (
    <div className="flex flex-col h-full">
      {/* ComfyUI status */}
      <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${comfyAvailable ? 'bg-green-400' : 'bg-zinc-600'}`} />
        <span className="text-[10px] text-zinc-500">
          ComfyUI {comfyAvailable ? '接続済み' : '未接続'}
        </span>
        {running.length > 0 && (
          <span className="ml-auto text-[10px] text-blue-400 animate-pulse">
            実行中 {running.length}
          </span>
        )}
      </div>

      {/* Job list */}
      <div className="flex-1 overflow-y-auto">
        {loading && jobs.length === 0 && (
          <p className="text-center text-zinc-600 text-xs mt-6">読み込み中…</p>
        )}

        {!loading && jobs.length === 0 && (
          <p className="text-center text-zinc-600 text-xs mt-6">ジョブなし</p>
        )}

        {running.length > 0 && (
          <div>
            <p className="px-3 pt-2 pb-1 text-[10px] text-blue-400 uppercase tracking-wider">実行中</p>
            {running.map(j => <JobCard key={j.id} job={j} />)}
          </div>
        )}

        {pending.length > 0 && (
          <div>
            <p className="px-3 pt-2 pb-1 text-[10px] text-zinc-500 uppercase tracking-wider">待機中</p>
            {pending.map(j => <JobCard key={j.id} job={j} />)}
          </div>
        )}

        {done.length > 0 && (
          <div>
            <p className="px-3 pt-2 pb-1 text-[10px] text-zinc-600 uppercase tracking-wider">完了 / 失敗</p>
            {done.map(j => <JobCard key={j.id} job={j} />)}
          </div>
        )}
      </div>
    </div>
  )
}
