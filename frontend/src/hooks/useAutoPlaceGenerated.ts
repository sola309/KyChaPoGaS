import { useEffect, useRef } from 'react'
import { useJobStore } from '../store/jobStore'
import { useTimelineStore } from '../store/timelineStore'
import { assetsApi, type Asset } from '../api/client'

const GEN_JOB_TYPES = ['generate_image', 'generate_video_i2v', 'generate_audio']

/**
 * Watches generation jobs and, when one completes during this session, fetches
 * its result asset(s), adds them to the library, and appends them to the
 * timeline (image/video → video track, music → audio track).
 *
 * Jobs already completed when the project opened are seeded as "seen" so we
 * don't re-place the whole history on load.
 */
export function useAutoPlaceGenerated(
  projectId: number | undefined,
  fps: number,
  onAsset: (asset: Asset) => void,
) {
  const jobs = useJobStore(s => s.jobs)
  const placeClip = useTimelineStore(s => s.placeClip)
  // Only place a job we WATCHED transition pending/running → completed in this
  // session. Merely "completed and not seen before" is unsafe: a partial jobs
  // snapshot (SSE reconnect, server restart) would mass-place the entire
  // generation history onto the timeline.
  const activeRef = useRef<Set<number>>(new Set())
  const placedRef = useRef<Set<number>>(new Set())

  // Reset per project
  useEffect(() => {
    activeRef.current = new Set()
    placedRef.current = new Set()
  }, [projectId])

  useEffect(() => {
    if (!projectId) return

    for (const job of jobs) {
      if (!GEN_JOB_TYPES.includes(job.job_type)) continue
      if (job.status === 'pending' || job.status === 'running') {
        activeRef.current.add(job.id)
        continue
      }
      if (job.status !== 'completed') continue
      if (!activeRef.current.has(job.id)) continue   // never saw it run → history
      if (placedRef.current.has(job.id)) continue
      const ids = job.result_asset_ids ?? []
      if (ids.length === 0) continue
      placedRef.current.add(job.id)

      const isAudio = job.job_type === 'generate_audio'
      void (async () => {
        for (const aid of ids) {
          try {
            const asset = await assetsApi.get(aid)
            onAsset(asset)
            const dur = asset.duration_sec
              ? Math.max(1, Math.round(asset.duration_sec * fps))
              : Math.round(3 * fps)   // images: default 3s
            await placeClip(projectId, isAudio ? 'audio' : 'video', aid, dur)
          } catch {
            /* asset fetch / placement failed — skip */
          }
        }
      })()
    }
  }, [jobs, projectId, fps, placeClip, onAsset])
}
