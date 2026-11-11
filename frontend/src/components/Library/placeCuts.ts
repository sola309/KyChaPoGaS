// 📚 ライブラリのカットをタイムラインへ置く。
// 普通のメディアクリップ(asset_id = ライブラリの素材、asset_in_frame = カットの頭)として作り、
// 何本置いても「元に戻す」1 回で全部消えるよう、履歴は 1 件だけ積む。
//
// 作るのはサーバーの POST /library/place(1 回の書き込み・1 件の操作ログ)。
// 1 本ずつ POST /clips/ で作ると、Image ピンのあるプロジェクトでは clips.py のカット境界の切り詰め
// (_clamp_duration_to_cut: 後ろのクリップがまだ無いと尺を切る)が 1 本ごとに掛かり、尺が縮んで隙間が
// 空いた(10/17 レビューで実測)。/library/place はその切り詰めをしないので、画面とサーバー(LLM/MCP)の
// 置き方が同じ結果になる。返ってきたクリップの尺が計画より短いときは、そのまま利用者に知らせる。
//
// timelineStore.ts は編集しない: 履歴の積み方(pushHistory)と共同編集の通知(broadcastEdit)は
// ストアの中と同じ形を外から行う(useTimelineStore.setState)。
import type { Clip, Track } from '../../api/client'
import type { LibraryCut } from '../../api/library'
import { errorStatus, errorText, libraryApi } from '../../api/library'
import { useTimelineStore } from '../../store/timelineStore'
import { useCollabStore } from '../../store/collabStore'
import { useUIStore } from '../../store/uiStore'

/** timelineStore の MAX_HISTORY と同じ(書き出されていないため値を写す) */
const MAX_HISTORY = 50
/** まとめて消すときに同時に投げる数(一斉に投げるとブラウザが ERR_INSUFFICIENT_RESOURCES で落とす) */
const DELETE_CONCURRENCY = 6
/** これより多いカットを置くときは確かめる */
export const PLACE_CONFIRM_OVER = 100

export interface PlannedClip {
  cutId: number
  cut: { idx: number; start: number; end: number }   // 素材側(素材の fps)
  start_frame: number      // タイムライン(プロジェクト fps)
  duration_frames: number
  asset_in_frame: number   // asset_in_frame / プロジェクト fps = 素材の頭からの秒
}

/** 素材のコマ [srcStart, srcEnd) → (asset_in_frame, duration_frames)(プロジェクトの fps)。
 *  バックエンドの routers/library.py to_project_frames と同じ規則(/library/place と同じクリップになる):
 *  プレビュー・書き出しは時刻 t に floor(t × 素材fps) のコマを出すので、asset_in_frame は
 *  「最初に出るコマが srcStart になる最小の値」(切り上げ)、尺は長さを fps で直して丸め、
 *  最後のコマが次のカットへはみ出さないよう詰める(1 以上)。 */
export function toProjectFrames(srcStart: number, srcEnd: number, srcFps: number, projFps: number): [number, number] {
  const r = projFps / Math.max(1e-6, srcFps)
  const aIn = Math.ceil(srcStart * r - 1e-9)
  let dur = Math.max(1, pyRound((srcEnd - srcStart) * r))
  while (dur > 1 && Math.floor((aIn + dur - 1) / r + 1e-6) >= srcEnd) dur -= 1
  return [aIn, dur]
}

/** Python の round と同じ丸め(ちょうど .5 は偶数へ)。サーバーの式と 1 コマも違わないように */
export function pyRound(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d === 0.5) return f % 2 === 0 ? f : f + 1
  return d < 0.5 ? f : f + 1
}

/** 置く位置の計画。カットは時間順に、start から隙間 gap で続けて並べる */
export function planPlacement(cuts: LibraryCut[], srcFps: number, projFps: number,
                              start: number, gap = 0): PlannedClip[] {
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  let at = Math.max(0, Math.round(start))
  return sorted.map(c => {
    const [aIn, dur] = toProjectFrames(c.start, c.end, srcFps, projFps)
    const p: PlannedClip = {
      cutId: c.id,
      cut: { idx: c.idx, start: c.start, end: c.end },
      start_frame: at,
      duration_frames: dur,
      asset_in_frame: aIn,
    }
    at += dur + Math.max(0, gap)
    return p
  })
}

/** 計画と重なる既存クリップ(そのトラック上)。/library/place と同じく、計画のクリップ 1 本ずつと比べる */
export function overlapsOnTrack(clips: Clip[], trackId: number, plan: PlannedClip[]): Clip[] {
  if (plan.length === 0) return []
  const s = plan[0].start_frame
  const e = plan[plan.length - 1].start_frame + plan[plan.length - 1].duration_frames
  return clips.filter(c => {
    if (c.track_id !== trackId) return false
    const c0 = c.start_frame, c1 = c.start_frame + c.duration_frames
    if (c1 <= s || c0 >= e) return false
    return plan.some(p => c0 < p.start_frame + p.duration_frames && c1 > p.start_frame)
  })
}

const FILTER_KINDS = new Set(['solid', 'blur'])
const FILTER_TRACK_NAMES = new Set(['filter', 'solid'])

/** 置き先の既定に選ばない映像トラックか: 非表示・Shots(生成テイクの層)・フィルターレイヤー
 *  (名前が Filter / Solid、または単色/ぼかしのクリップだけを持つ)。ほかの画面の選び方
 *  (Timeline.tsx / ShotPanel.tsx の `name !== 'Shots' && !hidden`、FilterLayerPopover の Solid/Filter)に合わせる */
export function trackSkipReason(t: Track, clips: Clip[]): string | null {
  if (t.hidden) return '非表示'
  if (t.name === 'Shots') return '生成テイク'
  if (FILTER_TRACK_NAMES.has(t.name.trim().toLowerCase())) return 'フィルター'
  const own = clips.filter(c => c.track_id === t.id)
  if (own.length > 0 && own.every(c => FILTER_KINDS.has(c.kind ?? ''))) return 'フィルター'
  return null
}

/** 既定の置き先: 選択中クリップのトラック → 「Video」→ 一番上の映像トラック の順に、
 *  置く範囲が空いているもの(非表示・Shots・フィルターレイヤーは選ばない)。
 *  どこも空いていなければ null(= 新しいトラックを作って置く) */
export function defaultTrackId(tracks: Track[], clips: Clip[], selectedClipId: number | null,
                               plan: PlannedClip[]): number | null {
  const vids = tracks
    .filter(t => t.track_type === 'video' && trackSkipReason(t, clips) == null)
    .sort((a, b) => a.order - b.order)
  if (vids.length === 0) return null
  const isFree = (id: number) => overlapsOnTrack(clips, id, plan).length === 0
  const sel = selectedClipId != null ? clips.find(c => c.id === selectedClipId) : undefined
  if (sel && !FILTER_KINDS.has(sel.kind ?? '') && vids.some(t => t.id === sel.track_id) && isFree(sel.track_id)) {
    return sel.track_id
  }
  const main = vids.find(t => t.name === 'Video' && isFree(t.id))
  if (main) return main.id
  return vids.find(t => isFree(t.id))?.id ?? null
}

/** クリップをまとめて消す(同時に DELETE_CONCURRENCY 本まで)。404 はもう無いので消えた扱い */
export async function deleteClipsBatched(ids: number[]): Promise<{ done: number[]; failed: number[]; locked: number }> {
  const done: number[] = []
  const failed: number[] = []
  let locked = 0
  let next = 0
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]
      try {
        await libraryApi.deleteClipQuiet(id)
        done.push(id)
      } catch (e) {
        const code = errorStatus(e)
        if (code === 404) done.push(id)
        else { failed.push(id); if (code === 409) locked += 1 }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, ids.length) }, worker))
  return { done, failed, locked }
}

type HistoryEntry = ReturnType<typeof useTimelineStore.getState>['undoStack'][number]

/** ストアの undo()/redo() は関数を呼ぶ前に履歴を積み替えるので、失敗したら元の側へ戻す */
function putBack(entry: HistoryEntry, to: 'undo' | 'redo') {
  useTimelineStore.setState(s => {
    const undo = s.undoStack.filter(e => e !== entry)
    const redo = s.redoStack.filter(e => e !== entry)
    if (to === 'undo') undo.push(entry); else redo.push(entry)
    return { undoStack: undo.slice(-MAX_HISTORY), redoStack: redo, canUndo: undo.length > 0, canRedo: redo.length > 0 }
  })
}

function dropEntry(entry: HistoryEntry) {
  useTimelineStore.setState(s => {
    const undo = s.undoStack.filter(e => e !== entry)
    const redo = s.redoStack.filter(e => e !== entry)
    return { undoStack: undo, redoStack: redo, canUndo: undo.length > 0, canRedo: redo.length > 0 }
  })
}

const toast = (text: string, kind: 'error' | 'info' = 'error') => {
  try { useUIStore.getState().pushToast(text, kind) } catch { /* noop */ }
}

function addToStore(made: Clip[]) {
  const ids = new Set(made.map(c => c.id))
  // 共同編集の読み直しが先に来ていても二重にならないように
  useTimelineStore.setState(s => ({ clips: [...s.clips.filter(c => !ids.has(c.id)), ...made] }))
}

export interface PlaceResult {
  clips: Clip[]
  /** 計画より短く作られた本数(サーバーがカット境界などで詰めたとき) */
  shortened: number
  /** 置いた範囲 [start, end)(返ってきたクリップの実際の位置) */
  start: number
  end: number
}

/** 置く。重なるときは置かずにエラー(バックエンドの /library/place と同じ扱い) */
export async function placeCutsOnTrack(opts: {
  projectId: number
  trackId: number
  plan: PlannedClip[]
  label?: string
}): Promise<PlaceResult> {
  const { projectId, trackId, plan } = opts
  if (plan.length === 0) return { clips: [], shortened: 0, start: 0, end: 0 }
  const st = useTimelineStore.getState()
  const hit = overlapsOnTrack(st.clips, trackId, plan)
  if (hit.length) {
    throw new Error(`置き先のトラックに重なるクリップが ${hit.length} 本あります(別のトラックを選ぶか、再生ヘッドを動かしてください)`)
  }
  const req = {
    project_id: projectId, track_id: trackId, start_frame: plan[0].start_frame,
    cut_ids: plan.map(p => p.cutId), gap_frames: 0, keep_order: true,
  }
  const create = async (): Promise<Clip[]> => {
    const made = await libraryApi.place(req, true)
    return [...made].sort((a, b) => a.start_frame - b.start_frame)
  }
  let created: Clip[]
  try {
    created = await create()
  } catch (e) {
    throw new Error(errorText(e, 'タイムラインに置けませんでした'))
  }
  addToStore(created)

  // 計画との違い(サーバーの決まりで尺が変わったとき)を数える
  const planned = new Map(plan.map(p => [p.cutId, p.duration_frames]))
  const cutIdOf = (c: Clip): number | null => {
    try { const a = JSON.parse(c.attrs_json || '{}'); return typeof a?.library_cut?.cut_id === 'number' ? a.library_cut.cut_id : null } catch { return null }
  }
  const shortened = created.filter((c, i) => {
    const want = planned.get(cutIdOf(c) ?? plan[i]?.cutId ?? -1)
    return want != null && c.duration_frames < want
  }).length

  let liveIds = created.map(c => c.id)
  let running = false
  const entry: HistoryEntry = {
    label: opts.label ?? `ライブラリから ${created.length} カット配置`,
    undoFn: async () => {
      if (running) { putBack(entry, 'undo'); toast('まだ前の操作の途中です。少し待ってからもう一度押してください', 'info'); return }
      running = true
      try {
        const ids = liveIds
        const { done, failed, locked } = await deleteClipsBatched(ids)
        const gone = new Set(done)
        useTimelineStore.setState(s => ({ clips: s.clips.filter(c => !gone.has(c.id)) }))
        liveIds = failed
        if (failed.length) {
          // 消せなかった分は残す: 履歴を「元に戻す」側へ戻し、もう一度押せば残りを消す
          putBack(entry, 'undo')
          toast(locked
            ? `配置の取り消しで ${failed.length} / ${ids.length} 本を消せませんでした(🔒ロック中 ${locked} 本。解除してからもう一度「元に戻す」)`
            : `配置の取り消しで ${failed.length} / ${ids.length} 本を消せませんでした。もう一度「元に戻す」を押してください`)
        }
      } finally { running = false }
    },
    redoFn: async () => {
      if (running) { putBack(entry, 'redo'); toast('まだ前の操作の途中です。少し待ってからもう一度押してください', 'info'); return }
      running = true
      try {
        const again = await create()
        liveIds = again.map(c => c.id)
        addToStore(again)
      } catch (e) {
        const code = errorStatus(e)
        if (code === 404) {
          // カットをつないだ/分けたなどで元のカットが無い: やり直しはできない
          dropEntry(entry)
          toast('ライブラリのカットが変わったため、配置をやり直せません(もう一度ライブラリから置いてください)')
        } else {
          putBack(entry, 'redo')
          toast(`配置をやり直せませんでした: ${errorText(e, '通信エラー')}`)
        }
      } finally { running = false }
    },
  }
  useTimelineStore.setState(s => ({
    undoStack: [...s.undoStack.slice(-(MAX_HISTORY - 1)), entry],
    redoStack: [],
    canUndo: true,
    canRedo: false,
  }))
  try { useCollabStore.getState().broadcastEdit() } catch { /* noop */ }
  const start = created.length ? created[0].start_frame : plan[0].start_frame
  const end = created.reduce((m, c) => Math.max(m, c.start_frame + c.duration_frames), start)
  return { clips: created, shortened, start, end }
}
