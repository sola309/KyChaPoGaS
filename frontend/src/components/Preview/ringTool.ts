/**
 * 💍 指輪の位置ツールの状態と保存(ストアに依存する部分)。純粋な計算は ../Timeline/ringMarks.ts。
 *
 * 保存はふつうのクリップ PATCH(attrs_json)だけ。PATCH は attrs_json を丸ごと置き換えるので、
 * 送る直前にサーバーのいまのクリップを読み、ring_marks / ring_marks_meta だけを差し替えて送る
 * (雨の設定など、ほかのキーを古い値で上書きしない)。同じクリップの保存は 1 本ずつ順番に。
 */
import { create } from 'zustand'
import type { AxiosRequestConfig } from 'axios'
import { api, type Clip, type Track } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useCollabStore } from '../../store/collabStore'
import { useUIStore } from '../../store/uiStore'
import {
  type RingMark, type RingMeta, parseRingMarks, parseRingMeta, withRingMarks, sliceRingMarks, headShiftFrames,
} from '../Timeline/ringMarks'

/** 取り消しの 1 回。inF = そのときのクリップの頭出し(左端のトリムで印のコマがずれたら、この取り消しは使えない) */
interface Edit { clipId: number; inF: number; before: RingMark[]; after: RingMark[]; tag?: string; at: number }

interface RingToolState {
  on: boolean
  /** 印を付けるレイヤー(ON にしたときに決める。既定は選択中の映像クリップのレイヤー → Shots) */
  trackId: number | null
  saving: number                 // 送信中・待ちの保存の数
  error: string                  // 直近の保存の失敗('' = なし)
  savedAt: number                // 直近の保存の成功(Date.now())
  hint: string                   // 操作の一言(数秒で消える)
  undo: Edit[]
  redo: Edit[]
  start: (trackId?: number | null) => void
  stop: () => void
  toggle: (trackId?: number | null) => void
}

const silent = { __silent: true } as unknown as AxiosRequestConfig
const MAX_UNDO = 100

const isFilterKind = (k: string | undefined) => k === 'solid' || k === 'blur' || k === 'rain' || k === 'satsuei'

/** 印を付けられるクリップか(映像レイヤーの素材つきクリップ。単色・ぼかし・雨の層・撮影は除く) */
export function isRingTargetClip(c: Clip, tracks: Track[]): boolean {
  if (c.asset_id == null || isFilterKind(c.kind)) return false
  const t = tracks.find(x => x.id === c.track_id)
  return !!t && t.track_type === 'video'
}

/** ON にするときのレイヤー: 選択中の映像クリップ → 「Shots」 → 再生位置にある一番上の映像クリップ */
export function pickRingTrack(): number | null {
  const st = useTimelineStore.getState()
  const sel = st.selectedClipId != null ? st.clips.find(c => c.id === st.selectedClipId) : undefined
  if (sel && isRingTargetClip(sel, st.tracks)) return sel.track_id
  const shots = st.tracks.find(t => t.track_type === 'video' && t.name === 'Shots')
  if (shots) return shots.id
  const f = st.currentFrame
  const vt = [...st.tracks].filter(t => t.track_type === 'video' && !t.hidden).sort((a, b) => a.order - b.order)
  for (const t of vt) {
    if (st.clips.some(c => c.track_id === t.id && isRingTargetClip(c, st.tracks)
      && c.start_frame <= f && f < c.start_frame + c.duration_frames)) return t.id
  }
  return null
}

/** そのレイヤーで、再生位置 frame を覆うクリップ(重なり遷移では後から始まる方) */
export function ringClipAt(clips: Clip[], tracks: Track[], trackId: number | null, frame: number): Clip | null {
  if (trackId == null) return null
  let best: Clip | null = null
  for (const c of clips) {
    if (c.track_id !== trackId || !isRingTargetClip(c, tracks)) continue
    if (c.start_frame <= frame && frame < c.start_frame + c.duration_frames) {
      if (!best || c.start_frame > best.start_frame) best = c
    }
  }
  return best
}

export const metaOf = (c: Pick<Clip, 'asset_id' | 'asset_in_frame'>): RingMeta =>
  ({ asset_id: c.asset_id ?? null, asset_in_frame: c.asset_in_frame ?? 0 })

export const useRingTool = create<RingToolState>((set, get) => ({
  on: false,
  trackId: null,
  saving: 0,
  error: '',
  savedAt: 0,
  hint: '',
  undo: [],
  redo: [],
  start: (trackId) => set({ on: true, trackId: trackId ?? pickRingTrack(), error: '' }),
  stop: () => { flushAll(); set({ on: false }) },
  toggle: (trackId) => { if (get().on) get().stop(); else get().start(trackId) },
}))

// ── 保存(クリップごとに 400ms まとめてから 1 本ずつ) ──────────────────────────
// ack = ring_marks_meta をいまの素材に書き直す(「確かめた」)。ふつうの編集では、すでにある meta は残す
// (テイクが替わったあと一部のキーを直しても、残りのキーを確かめたことにはしないため)。
// inF / assetId = 印を確定したときのクリップの頭出しと素材。送る前に左端のトリムで頭出しが変わっていたら
// (素材は同じ)、待っていた印はトリムの前のコマなので、トリムと同じだけずらしてから送る。
const pending = new Map<number, { marks: RingMark[]; ack: boolean; inF: number; assetId: number | null }>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()
const chains = new Map<number, Promise<void>>()
let running = 0                                     // 送信中の保存の数
const waits = new Map<number, number>()            // ドラッグ中で保存を待った回数
/** 「保存中…」の数 = 待っている保存 + 送信中(数え直すので、まとめた保存で数がずれない) */
const refreshSaving = () => useRingTool.setState({ saving: pending.size + running })
const inFOf = (c: Pick<Clip, 'asset_in_frame'> | undefined) => c?.asset_in_frame ?? 0

/** 書き込む meta: 確かめた / まだ meta がない / 印が空だった → いまの素材。それ以外は元の meta のまま */
function metaFor(c: Clip, ack: boolean): RingMeta {
  const old = parseRingMeta(c.attrs_json)
  return !ack && old && parseRingMarks(c.attrs_json).length ? old : metaOf(c)
}

function applyLocal(clipId: number, marks: RingMark[], ack: boolean) {
  useTimelineStore.setState(s => ({
    clips: s.clips.map(c => {
      if (c.id !== clipId) return c
      const attrs = withRingMarks(c.attrs_json, marks, metaFor(c, ack))
      return attrs == null ? c : { ...c, attrs_json: attrs }
    }),
  }))
}

function enqueue(clipId: number, marks: RingMark[], ack: boolean, delay: number) {
  const prev = pending.get(clipId)
  const local = useTimelineStore.getState().clips.find(c => c.id === clipId)
  pending.set(clipId, { marks, ack: ack || !!prev?.ack, inF: inFOf(local), assetId: local?.asset_id ?? null })
  refreshSaving()
  schedule(clipId, delay)
}

async function persist(clipId: number): Promise<void> {
  const job = pending.get(clipId)
  if (!job) return
  pending.delete(clipId)
  running++
  refreshSaving()
  const { ack } = job
  let { marks } = job
  try {
    const local0 = useTimelineStore.getState().clips.find(c => c.id === clipId)
    if (!local0) {
      // 分割(印は手元の値のまま新しい 2 本へ引き継がれている)・削除のあと。送る先がないので何もしない
      ringHint('印を付けたクリップが分割・削除されたので、そのクリップへの保存は省きました')
      return
    }
    // 送る直前にサーバーのいまの値を読む(ほかのキーを古い値で上書きしない)
    const rows = await api.get<Clip[]>('/clips/', { ...silent, params: { track_id: local0.track_id } }).then(r => r.data)
    const server = rows.find(c => c.id === clipId)
    if (!server) throw new Error('クリップが見つかりません(消された可能性があります)')
    if (server.locked) throw new Error('🔒 ロック中のクリップには保存できません(ロックを外してください)')
    // 印を付けたあと、送る前に左端をトリムした(同じ素材で頭出しだけ変わった): トリムが手元の印をずらしたのと同じだけ、
    // 待っていた印もずらす(ずらさずに送ると、トリムの保存のあとに古いコマの印で上書きしてしまう)
    const local = useTimelineStore.getState().clips.find(c => c.id === clipId) ?? local0
    if (inFOf(local) !== job.inF && (local.asset_id ?? null) === job.assetId) {
      marks = sliceRingMarks(marks, headShiftFrames(inFOf(local) - job.inF, local.speed, local.remap_json), local.duration_frames, true)
    }
    const attrs = withRingMarks(server.attrs_json, marks, metaFor(server, ack))
    if (attrs == null) throw new Error('このクリップの attrs_json が読めないため保存しませんでした')
    const upd = await api.patch<Clip>(`/clips/${clipId}`, { attrs_json: attrs }, silent).then(r => r.data)
    // 送っている間に次の編集が来ていなければ、サーバーの返り値で合わせる
    if (!pending.has(clipId)) useTimelineStore.setState(s => ({ clips: s.clips.map(c => c.id === clipId ? upd : c) }))
    try { useCollabStore.getState().broadcastEdit() } catch { /* noop */ }
    useRingTool.setState({ error: '', savedAt: Date.now() })
  } catch (e) {
    const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
    const msg = typeof detail === 'string' ? detail : (e as Error)?.message ?? '保存できませんでした'
    useRingTool.setState({ error: msg })
    useUIStore.getState().pushToast(`💍 指輪の位置を保存できませんでした: ${msg}`, 'error')
  } finally {
    running--
    refreshSaving()
  }
}

function schedule(clipId: number, delay: number) {
  const t = timers.get(clipId)
  if (t) clearTimeout(t)
  timers.set(clipId, setTimeout(() => {
    timers.delete(clipId)
    // そのクリップをタイムラインでドラッグ・トリム中なら、終わるまで待つ(トリムの保存と食い違わないように)。
    // ドラッグの終わりを取りこぼしても保存が止まったままにならないよう、待つのは 10 秒まで
    const w = waits.get(clipId) ?? 0
    if (useTimelineStore.getState().editingClipId === clipId && w < 25) { waits.set(clipId, w + 1); schedule(clipId, 400); return }
    waits.delete(clipId)
    const prev = chains.get(clipId) ?? Promise.resolve()
    const next = prev.then(() => persist(clipId)).finally(() => {
      if (chains.get(clipId) === next) chains.delete(clipId)
    })
    chains.set(clipId, next)
  }, delay))
}

/** 待っている保存をすぐ送る(ツールを閉じるとき) */
export function flushAll() {
  for (const id of [...timers.keys()]) schedule(id, 0)
}

/**
 * 印を確定する: すぐ画面に反映し(楽観的)、少し待ってからサーバーへ。
 * undoable=false は取り消し・やり直しの適用(履歴に積まない)。
 * tag: 同じ tag の操作が 1 秒以内に続いたら(ホイール・キーの押しっぱなし)取り消しの 1 回にまとめる。
 */
export function commitMarks(clipId: number, marks: RingMark[], opts: { undoable?: boolean; tag?: string } = {}) {
  const undoable = opts.undoable ?? true
  const c = useTimelineStore.getState().clips.find(x => x.id === clipId)
  if (!c) return
  const before = parseRingMarks(c.attrs_json)
  if (JSON.stringify(before) === JSON.stringify(marks)) return
  if (undoable) {
    const now = Date.now()
    const inF = inFOf(c)
    useRingTool.setState(s => {
      const last = s.undo[s.undo.length - 1]
      if (opts.tag && last && last.clipId === clipId && last.inF === inF && last.tag === opts.tag && now - last.at < 1000) {
        return { undo: [...s.undo.slice(0, -1), { ...last, after: marks, at: now }], redo: [] }
      }
      return { undo: [...s.undo.slice(-(MAX_UNDO - 1)), { clipId, inF, before, after: marks, tag: opts.tag, at: now }], redo: [] }
    })
  }
  applyLocal(clipId, marks, false)
  enqueue(clipId, marks, false, 400)
}

/**
 * 印はそのままで、ring_marks_meta だけをいまの素材(テイク)・頭出しに書き直す。
 * テイクを替えたあと(雨なし版への差し替えなど)、印の位置を確かめた人が「この素材で合っている」と記録するため。
 */
export function ringAckMeta(clipId: number) {
  const c = useTimelineStore.getState().clips.find(x => x.id === clipId)
  if (!c) return
  const marks = parseRingMarks(c.attrs_json)
  if (!marks.length) return
  applyLocal(clipId, marks, true)
  enqueue(clipId, marks, true, 0)
}

/** その取り消しがもう使えないか: クリップが分割・削除された / 左端のトリム・テイクの差し替えで頭出しが変わった
 *  (印のコマがずれているので、前の印に戻すと別のコマに付いてしまう) */
function staleEdit(e: Edit): boolean {
  const c = useTimelineStore.getState().clips.find(x => x.id === e.clipId)
  return !c || inFOf(c) !== e.inF
}
const STALE_HINT = 'この印の操作のあとでクリップが分割・トリム・差し替えされたので、取り消し・やり直しの履歴から外しました'

export function ringUndo(): boolean {
  const { undo } = useRingTool.getState()
  const e = undo[undo.length - 1]
  if (!e) return false
  if (staleEdit(e)) {
    useRingTool.setState(s => ({ undo: s.undo.filter(x => x.clipId !== e.clipId || !staleEdit(x)) }))
    ringHint(STALE_HINT)
    return true
  }
  useRingTool.setState(s => ({ undo: s.undo.slice(0, -1), redo: [...s.redo, e] }))
  commitMarks(e.clipId, e.before, { undoable: false })
  return true
}

export function ringRedo(): boolean {
  const { redo } = useRingTool.getState()
  const e = redo[redo.length - 1]
  if (!e) return false
  if (staleEdit(e)) {
    useRingTool.setState(s => ({ redo: s.redo.filter(x => x.clipId !== e.clipId || !staleEdit(x)) }))
    ringHint(STALE_HINT)
    return true
  }
  useRingTool.setState(s => ({ redo: s.redo.slice(0, -1), undo: [...s.undo, e] }))
  commitMarks(e.clipId, e.after, { undoable: false })
  return true
}

let hintTimer: ReturnType<typeof setTimeout> | null = null
/** HUD に一言(2.5 秒で消える) */
export function ringHint(text: string) {
  if (hintTimer) clearTimeout(hintTimer)
  useRingTool.setState({ hint: text })
  hintTimer = setTimeout(() => { hintTimer = null; useRingTool.setState({ hint: '' }) }, 2500)
}
