// 📚 ライブラリのカットをタイムラインへドラッグするときの受け渡し(TrackLane が受け取る)。
import type { Track } from '../../api/client'
import type { LibraryCut } from '../../api/library'
import { useProjectStore } from '../../store/projectStore'
import { useTimelineStore } from '../../store/timelineStore'
import { useUIStore } from '../../store/uiStore'
import { PLACE_CONFIRM_OVER, planPlacement, placeCutsOnTrack } from './placeCuts'

export const LIBRARY_CUTS_MIME = 'application/x-kychapogas-library-cuts'

export interface LibraryCutsDrag {
  assetId: number
  fps: number
  cuts: { id: number; idx: number; start: number; end: number }[]
}

export function hasLibraryCuts(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes(LIBRARY_CUTS_MIME)
}

/** TrackLane の drop から呼ぶ。映像トラックの落とした位置から続けて置く(元に戻す 1 回で消える) */
export async function dropLibraryCuts(dt: DataTransfer, track: Track, startFrame: number): Promise<boolean> {
  const raw = dt.getData(LIBRARY_CUTS_MIME)
  if (!raw) return false
  const toast = useUIStore.getState().pushToast
  if (track.track_type !== 'video') {
    toast('ライブラリのカットは映像トラックに置いてください', 'error')
    return true
  }
  let d: LibraryCutsDrag
  try { d = JSON.parse(raw) as LibraryCutsDrag } catch { return false }
  if (!Array.isArray(d?.cuts) || d.cuts.length === 0) return false
  // たくさんのカットは確かめてから置く(ドロップには確かめの場所がないので、画面の「タイムラインに置く」から)
  if (d.cuts.length > PLACE_CONFIRM_OVER) {
    toast(`${d.cuts.length} カットはドラッグでは置きません(${PLACE_CONFIRM_OVER} 本まで)。ライブラリの「タイムラインに置く」から確かめて置いてください`, 'error')
    return true
  }
  const projFps = useProjectStore.getState().activeProject?.fps ?? useTimelineStore.getState().projectFps
  const cuts = d.cuts.map(c => ({ id: c.id, idx: c.idx, start: c.start, end: c.end }) as LibraryCut)
  const plan = planPlacement(cuts, d.fps, projFps, startFrame)
  try {
    const r = await placeCutsOnTrack({ projectId: track.project_id, trackId: track.id, plan })
    const short = r.shortened > 0 ? `(${r.shortened} 本は計画より短くなりました)` : ''
    toast(`📚 ${r.clips.length} カットを「${track.name}」に置きました${short}`, r.shortened > 0 ? 'info' : 'success')
  } catch (e) {
    toast(e instanceof Error ? e.message : '置けませんでした', 'error')
  }
  return true
}
