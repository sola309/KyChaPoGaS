/**
 * 🎬 撮影クリップの書き換え(撮影パネル・フィルター追加から使う)。
 *
 *   editClipLive : つまみを動かすたびに手元のクリップをすぐ書き換え(プレビューは次のコマで変わる)、
 *                  保存(PATCH)は 300ms 止まってから 1 回。保存は同じクリップでは順番に送る(後から送った値が必ず最後に残る)。
 *                  送るのは「このつまみで変えた所」を今の手元の中身に重ねたもの(待っている間に共同編集の読み直しで手元が
 *                  置き換わっても、🎚 効きのキーなどほかの所の変更と重なっても、どちらも消さない)。
 *                  「元に戻す」は保存の回数でなく一続きの操作で 1 回: 同じクリップの同じつまみ(key)の保存が 1.5 秒以内に
 *                  続けば 1 つにまとめる(重い端末でドラッグの途中に保存が挟まっても、戻すのは動かす前の値まで)。
 *                  別のつまみに移ったら別の「元に戻す」。戻す・やり直すは変わった所だけを今の中身へ書き戻す(後からした別の変更は残る)。
 *   replaceClips : いくつかのクリップを消して別のクリップを作る(✂ 境目で分ける)を、元に戻す 1 回ぶんにする。
 *   addSatsueiClip : 撮影クリップを 1 本作る(自動で合わせるまで含めて元に戻す 1 回ぶん)。
 *   pushReplaceHistory : サーバーが作った・消した(🎬 全カットに敷く)ものを、元に戻せるように履歴へ積む。
 *   ensureSatsueiTrack : 撮影トラックが無ければ Shots・Scenes の上に作る(上のトラックは 1 つずつ上へずらす)。
 *
 * 元に戻す・やり直すの履歴は timelineStore の履歴(pushHistory。トリミング・分割と同じもの)へ積む。
 * 元に戻す・やり直すで作り直したクリップは id が替わる(SQLite は消した id を使い回すこともある)ので、履歴は id でなく
 * timelineStore のつかみ(ClipRef)を持つ。消して作り直す側はつかみを預かり、作り直したクリップへ渡す。
 * 元に戻す・やり直すの前には待っている保存を送り切る(timelineStore.registerPendingEdits)。
 */
import type { Clip, ClipCreate, ClipUpdate, Track, SatsueiAutofitBody, SatsueiAutofitResult } from '../../api/client'
import { clipsApi, tracksApi, getSatsueiMeta, autofitSatsuei, updateClipQuiet, patchClipKeepalive } from '../../api/client'
import {
  useTimelineStore, pushHistory, registerPendingEdits, clipRef, parkClipRef, takeClipRef, giveClipRef,
  type HistoryEntry, type ClipRef,
} from '../../store/timelineStore'
import { useCollabStore } from '../../store/collabStore'
import { registerSatsueiMeta, satsueiOf, type SatsueiMeta } from '../Preview/satsueiLook'
import {
  satsueiTrackPlacement, SATSUEI_TRACK, applyFitted, diffAttrs, applyChangesToAttrs, type PathChange,
} from './satsueiUi'

const notifyEdit = () => { try { useCollabStore.getState().broadcastEdit() } catch { /* noop */ } }
const setLocal = (fn: (cs: Clip[]) => Clip[]) => useTimelineStore.setState(s => ({ clips: fn(s.clips) }))
const putLocal = (c: Clip) => setLocal(cs => cs.map(x => x.id === c.id ? c : x))
const latestClip = (id: number) => useTimelineStore.getState().clips.find(c => c.id === id)

/** 元に戻す・やり直すの履歴へ 1 つ積む(timelineStore の pushHistory と同じ)。積んだ項目を返す */
export function pushTimelineHistory(label: string, undoFn: () => Promise<void>, redoFn: () => Promise<void>): HistoryEntry {
  const item: HistoryEntry = { label, undoFn, redoFn }
  pushHistory(item)
  return item
}

// ── 書き換えの記録(変わった所だけ)──────────────────────────────────
type Fields = Record<string, unknown>
/** 1 回の書き換え: attrs_json の中は変わった所の一覧、ほかの欄(不透明度・溶けなど)は前後の値 */
interface Rec { before: Fields; after: Fields; changes: PathChange[] }

/** 欄ごとの前・後の値 → 記録(attrs_json は変わった所の一覧へ。変わっていない欄は入れない) */
function recOf(before: Fields, after: Fields): Rec {
  const rec: Rec = { before: {}, after: {}, changes: [] }
  for (const k of Object.keys(after)) {
    if (k === 'attrs_json') rec.changes = diffAttrs(before[k] as string | null | undefined, after[k] as string | null | undefined)
    else if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) { rec.before[k] = before[k]; rec.after[k] = after[k] }
  }
  return rec
}
const recEmpty = (r: Rec) => !r.changes.length && !Object.keys(r.after).length
/** 記録を今の中身 cur に当てた PATCH の中身(attrs_json は cur の attrs_json に変わった所だけを書き戻したもの) */
function payloadOf(cur: Pick<Clip, 'attrs_json'>, r: Rec, dir: 'before' | 'after'): ClipUpdate {
  const out: Fields = { ...r[dir] }
  if (r.changes.length) out.attrs_json = applyChangesToAttrs(cur.attrs_json, r.changes, dir)
  return out as ClipUpdate
}
/** 記録を元に戻す(before)・やり直す(after)。クリップはつかみの今の id で(作り直していれば作り直したクリップ) */
async function applyRec(ref: ClipRef, r: Rec, dir: 'before' | 'after') {
  const id = ref.id
  const cur = latestClip(id)
  if (!cur) throw new Error(`撮影クリップ ${id} が見つかりません`)
  putLocal(await clipsApi.update(id, payloadOf(cur, r, dir)))
}
/** 続きの記録をまとめる(戻す先は最初の値のまま、やり直す先は後の値へ) */
function mergeRec(into: Rec, r: Rec) {
  for (const k of Object.keys(r.after)) {
    if (!(k in into.before)) into.before[k] = r.before[k]
    into.after[k] = r.after[k]
  }
  for (const ch of r.changes) {
    const same = into.changes.find(c => c.path.length === ch.path.length && c.path.every((p, i) => p === ch.path[i]))
    if (same) same.after = ch.after
    else into.changes.push(ch)
  }
}

// ── つまみの書き換え(すぐ反映 + まとめて保存)──────────────────────────
interface Pending {
  before: Fields                // 欄ごとの、最初に動かす前の値
  vals: Fields                  // 欄ごとの、最後に動かした値
  label: string
  key: string                   // つまみ(まとめる単位)
  timer: ReturnType<typeof setTimeout> | null
}
/** 送ると決めて、返事がまだの保存(閉じる・読み直すときに keepalive で送り直す・共同編集の読み直しで重ね直す) */
interface Queued { body: ClipUpdate; rec: Rec }
const pending = new Map<number, Pending>()
const queued = new Map<number, Queued[]>()
const chains = new Map<number, Promise<unknown>>()
const saveSeq = new Map<number, number>()
const SAVE_MS = 300
const MERGE_MS = 1500
/** 直前に積んだつまみの履歴(続けて保存したらこれにまとめる) */
let lastLive: { clipId: number; label: string; key: string; at: number; rec: Rec; item: HistoryEntry } | null = null

/** 同じクリップの保存を順番に送る */
function inOrder<T>(clipId: number, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(clipId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(clipId, next.catch(() => undefined))
  return next
}

/**
 * つまみの値をすぐ手元に反映し、300ms 止まったら保存する。label = 元に戻すの名前、key = つまみ(既定は label)。
 * 止まるまでの間の変更は 1 回の保存に、同じクリップ・同じつまみの保存が 1.5 秒以内に続けば 1 つの「元に戻す」に
 * まとまる(戻す先 = 最初に動かす前の値)。別のつまみを動かしたら、前のつまみの分はすぐ保存して別の「元に戻す」にする
 */
export function editClipLive(clipId: number, patch: ClipUpdate, label = '撮影の調整', key = label) {
  const cur = latestClip(clipId)
  if (!cur) return
  let p = pending.get(clipId)
  if (p && p.key !== key) { void flushClipEdit(clipId); p = undefined }
  if (!p) { p = { before: {}, vals: {}, label, key, timer: null }; pending.set(clipId, p) }
  const curF = cur as unknown as Fields
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in p.before)) p.before[k] = curF[k]
    p.vals[k] = v
  }
  p.label = label
  setLocal(cs => cs.map(c => c.id === clipId ? { ...c, ...(patch as Partial<Clip>) } : c))
  if (p.timer) clearTimeout(p.timer)
  p.timer = setTimeout(() => { void flushClipEdit(clipId) }, SAVE_MS)
}

/** 待っている保存をすぐ送る(パネルを閉じる・分ける・敷く前に呼ぶ)。送り終わるまで待てる */
export function flushClipEdit(clipId: number): Promise<void> {
  const p = pending.get(clipId)
  if (!p) return (chains.get(clipId) as Promise<void> | undefined)?.then(() => undefined) ?? Promise.resolve()
  if (p.timer) clearTimeout(p.timer)
  pending.delete(clipId)
  const cur = latestClip(clipId)
  if (!cur) return Promise.resolve()          // 消された
  const rec = recOf(p.before, p.vals)
  if (recEmpty(rec)) return Promise.resolve()
  // 送るのは、このつまみで変えた所を今の手元の中身に重ねたもの
  const q: Queued = { body: payloadOf(cur, rec, 'after'), rec }
  const label = p.label, key = p.key
  const seq = (saveSeq.get(clipId) ?? 0) + 1
  saveSeq.set(clipId, seq)
  queued.set(clipId, [...(queued.get(clipId) ?? []), q])
  return inOrder(clipId, async () => {
    try {
      const upd = await updateClipQuiet(clipId, q.body) as unknown as Fields
      // 送っている間に次の変更が無く、これが最後に送ると決めた保存なら、送った欄だけサーバーの値に合わせる
      // (先の保存の返事で、後から動かした値を一瞬戻さない)
      if (!pending.has(clipId) && saveSeq.get(clipId) === seq) {
        const sent: Fields = {}
        for (const k of Object.keys(q.body)) sent[k] = upd[k]
        setLocal(cs => cs.map(c => c.id === clipId ? { ...c, ...(sent as Partial<Clip>) } : c))
      }
    } catch { return }                           // 手元はそのまま(消されたクリップ以外はトーストで出る)
    finally {
      const rest = (queued.get(clipId) ?? []).filter(x => x !== q)
      if (rest.length) queued.set(clipId, rest); else queued.delete(clipId)
    }
    notifyEdit()
    const now = Date.now()
    const L = lastLive
    if (L && L.clipId === clipId && L.key === key && L.label === label && now - L.at < MERGE_MS
        && useTimelineStore.getState().undoStack.at(-1) === L.item) {
      mergeRec(L.rec, rec)                       // 続きの保存: 戻す先は最初の値のまま、やり直す先だけ今の値へ
      L.at = now
      return
    }
    const r: Rec = { before: { ...rec.before }, after: { ...rec.after }, changes: [...rec.changes] }
    const ref = clipRef(clipId)
    const item = pushTimelineHistory(label, () => applyRec(ref, r, 'before'), () => applyRec(ref, r, 'after'))
    lastLive = { clipId, label, key, at: now, rec: r, item }
  })
}

/** 待っている保存を全部送る */
export function flushAllClipEdits(): Promise<void> {
  return Promise.all([...pending.keys()].map(id => flushClipEdit(id))).then(() => undefined)
}
/** 待っている保存を全部送り、返事まで待つ(元に戻す・やり直すの前: 保存の履歴が積まれてから動かす) */
export async function settleClipEdits(): Promise<void> {
  await flushAllClipEdits()
  await Promise.all([...chains.values()])
}
/** 共同編集の読み直しで届いた clips に、返事がまだの保存と待っている保存を重ね直す(つまみが一瞬戻らない・保存が消えない) */
function overlayPending(clips: Clip[]): Clip[] {
  if (!pending.size && !queued.size) return clips
  return clips.map(c => {
    const qs = queued.get(c.id), p = pending.get(c.id)
    if (!qs && !p) return c
    let out: Clip = c
    for (const q of qs ?? []) out = { ...out, ...(payloadOf(out, q.rec, 'after') as Partial<Clip>) }
    if (p) {
      const rec = recOf(p.before, p.vals)
      if (!recEmpty(rec)) out = { ...out, ...(payloadOf(out, rec, 'after') as Partial<Clip>) }
    }
    return out
  })
}
registerPendingEdits({ settle: settleClipEdits, overlay: overlayPending })

/**
 * ページを閉じる・読み直すとき: 待っている保存と返事がまだの保存を keepalive で送り(普通の通信はページと一緒に切られる)、
 * 同じものをこのタブの sessionStorage にも書いておく(読み直しでは、新しいページの読み込みに押されて keepalive が
 * 届かないことがある → 読み直したページが起きたところでサーバーの今の中身に書き直す。同じ値を 2 回書いても結果は同じ)
 */
const STASH_KEY = 'satsuei.unsaved.v1'
const STASH_MS = 10 * 60 * 1000
interface Stash { project_id: number; id: number; track_id: number; kind: string; at: number; rec: Rec }
function flushOnUnload() {
  const stash: Stash[] = []
  const tracks = useTimelineStore.getState().tracks
  for (const id of new Set([...pending.keys(), ...queued.keys()])) {
    const cur = latestClip(id)
    if (!cur) continue
    const body: Fields = {}
    const recs: Rec[] = []
    for (const q of queued.get(id) ?? []) { Object.assign(body, q.body); recs.push(q.rec) }
    const p = pending.get(id)
    if (p) {
      if (p.timer) clearTimeout(p.timer)
      const rec = recOf(p.before, p.vals)
      if (!recEmpty(rec)) { Object.assign(body, payloadOf(cur, rec, 'after')); recs.push(rec) }
    }
    if (!Object.keys(body).length) continue
    patchClipKeepalive(id, body as ClipUpdate)
    const project_id = tracks.find(t => t.id === cur.track_id)?.project_id
    if (project_id == null) continue
    for (const rec of recs) stash.push({ project_id, id, track_id: cur.track_id, kind: cur.kind, at: Date.now(), rec })
  }
  pending.clear()
  if (stash.length) { try { sessionStorage.setItem(STASH_KEY, JSON.stringify(stash)) } catch { /* 保存できない端末は keepalive だけ */ } }
}
/** 前のページが閉じる前に送り切れなかった書き換え(sessionStorage)を、サーバーの今の中身へ書き直す(1 回だけ試す) */
async function replayStash() {
  let list: Stash[] = []
  try { list = JSON.parse(sessionStorage.getItem(STASH_KEY) || '[]'); sessionStorage.removeItem(STASH_KEY) } catch { list = [] }
  if (!Array.isArray(list)) return
  list = list.filter(s => s && typeof s.id === 'number' && typeof s.project_id === 'number' && s.rec && Date.now() - (s.at ?? 0) < STASH_MS)
  for (const pid of new Set(list.map(s => s.project_id))) {
    let clips: Clip[]
    try { clips = await clipsApi.list(pid) } catch { continue }
    for (const s of list.filter(x => x.project_id === pid)) {
      const cur = clips.find(c => c.id === s.id)
      // 消された・同じ id の別のクリップ(id の使い回し)・ロック中は書かない
      if (!cur || cur.track_id !== s.track_id || cur.kind !== s.kind || cur.locked) continue
      const rec: Rec = { before: s.rec.before ?? {}, after: s.rec.after ?? {}, changes: Array.isArray(s.rec.changes) ? s.rec.changes : [] }
      if (recEmpty(rec)) continue
      try {
        const upd = await updateClipQuiet(cur.id, payloadOf(cur, rec, 'after'))
        clips = clips.map(c => c.id === upd.id ? upd : c)
        putLocal(upd)
        notifyEdit()
      } catch { /* つながらない */ }
    }
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushOnUnload)
  void replayStash()
}

/**
 * いくつかのクリップの書き換えをまとめて保存し、元に戻す 1 回ぶんにする(「このトラックの全部へ」・自動で合わせる)。
 * changes: [{id, after}](before は今の値から取る)。戻す・やり直すは変わった所だけを今の中身へ書き戻す
 */
export async function patchClipsUndoable(changes: { id: number; after: ClipUpdate }[], label: string): Promise<number> {
  const done: { ref: ClipRef; rec: Rec }[] = []
  for (const ch of changes) {
    await flushClipEdit(ch.id)
    const cur = latestClip(ch.id)
    if (!cur || cur.locked) continue
    const curF = cur as unknown as Fields
    const before: Fields = {}
    for (const k of Object.keys(ch.after)) before[k] = curF[k]
    const rec = recOf(before, ch.after as Fields)
    if (recEmpty(rec)) continue
    putLocal(await clipsApi.update(ch.id, ch.after))
    done.push({ ref: clipRef(ch.id), rec })
  }
  if (!done.length) return 0
  notifyEdit()
  pushTimelineHistory(label,
    async () => { for (const d of done) await applyRec(d.ref, d.rec, 'before') },
    async () => { for (const d of done) await applyRec(d.ref, d.rec, 'after') })
  return done.length
}

// ── 作る・消すをまとめて元に戻せるように ─────────────────────────────
const snapshot = (c: Clip): ClipCreate => { const { id: _id, ...d } = c; return d as ClipCreate }
async function deleteQuiet(id: number) {
  try { await clipsApi.delete(id) } catch (e) {
    if ((e as { response?: { status?: number } })?.response?.status !== 404) throw e   // もう無いものは飛ばす
  }
}

/**
 * removed を消して created を作った操作(サーバー側でもこちらでも)を、元に戻す 1 回ぶんとして積む。
 * 戻す = created を消して removed を作り直す / やり直す = その逆(同じ中身で作り直す)。
 * 両側のクリップのつかみを持ち、消すときに預かって、作り直したクリップへ渡す(つまみの履歴が今のクリップに届くように)
 */
export function pushReplaceHistory(label: string, removed: readonly Clip[], created: readonly Clip[]) {
  const oldData = removed.map(snapshot), newData = created.map(snapshot)
  const oldRefs = removed.map(c => takeClipRef(c.id))      // 消した側(今は無い: つかみを預かる)
  const newRefs = created.map(c => clipRef(c.id))          // 作った側(今在る)
  const swap = async (dropRefs: ClipRef[], datas: ClipCreate[], makeRefs: ClipRef[]) => {
    const drop = new Set(dropRefs.map(r => r.id))          // ほかの元に戻す(分割など)で作り直されていればその id
    dropRefs.forEach(parkClipRef)
    for (const id of drop) await deleteQuiet(id)
    const made: Clip[] = []
    for (const d of datas) made.push(await clipsApi.create(d))
    made.forEach((c, i) => giveClipRef(makeRefs[i], c.id))
    setLocal(cs => [...cs.filter(c => !drop.has(c.id)), ...made])
  }
  pushTimelineHistory(label,
    () => swap(newRefs, oldData, oldRefs),
    () => swap(oldRefs, newData, newRefs))
}

/**
 * サーバーが消した(deletedIds)・作った(created)クリップを手元に反映し、元に戻す 1 回ぶんとして積む(🎬 全カットに敷く)
 */
export function adoptServerReplace(label: string, deletedIds: readonly number[], created: readonly Clip[]) {
  const drop = new Set(deletedIds)
  const removed = useTimelineStore.getState().clips.filter(c => drop.has(c.id))
  setLocal(cs => [...cs.filter(c => !drop.has(c.id)), ...created])
  notifyEdit()
  if (removed.length || created.length) pushReplaceHistory(label, removed, created)
}

/**
 * removed を消して datas を作る(作るのが先。途中で失敗したら作った分を消して元のまま)。元に戻す 1 回ぶん。
 * onLocal = 手元を置き換えた直後に呼ぶ(パネルが分けたクリップへすぐ移れるように)。
 * after = 作ったあとの仕上げ(自動で合わせるなど)。返したクリップの姿で「やり直す」が作り直す。作ったクリップを返す
 */
export async function replaceClips(removed: readonly Clip[], datas: readonly ClipCreate[], label: string,
                                   after?: (made: Clip[]) => Promise<Clip[]>, onLocal?: (made: Clip[]) => void): Promise<Clip[]> {
  for (const c of removed) await flushClipEdit(c.id)
  let made: Clip[] = []
  try {
    for (const d of datas) made.push(await clipsApi.create(d))
  } catch (e) {
    for (const c of made) await deleteQuiet(c.id)
    throw e
  }
  for (const c of removed) await deleteQuiet(c.id)
  const drop = new Set(removed.map(c => c.id))
  setLocal(cs => [...cs.filter(c => !drop.has(c.id)), ...made])
  if (onLocal) { try { onLocal(made) } catch { /* 表示だけ */ } }
  if (after) {
    try { made = await after(made) } catch { /* 仕上げに失敗しても分けた結果は残す */ }
  }
  notifyEdit()
  pushReplaceHistory(label, removed, made)
  return made
}

/**
 * 撮影クリップの設定を自動で合わせて保存する(元に戻すの履歴は積まない。積む側で 1 回にまとめる)。
 * 合わせて変わった所(黒の持ち上げ・中間・彩度など)だけを今の手元の中身へ書く(知らない欄・合わせている間の変更は残す)。
 * 返り値 = 保存後のクリップと、合わせた結果(前後の数値・測ったコマ)
 */
export async function autofitAndSave(clip: Clip, body: SatsueiAutofitBody = {}): Promise<{ clip: Clip; res: SatsueiAutofitResult }> {
  await flushClipEdit(clip.id)
  const base = satsueiOf((latestClip(clip.id) ?? clip).attrs_json)       // サーバーが読む、合わせる前の設定
  const res = await autofitSatsuei(clip.id, body)
  await flushClipEdit(clip.id)
  const attrs_json = applyFitted((latestClip(clip.id) ?? clip).attrs_json, base, res.params)
  const upd = await clipsApi.update(clip.id, { attrs_json })
  putLocal(upd)
  return { clip: upd, res }
}

/**
 * 撮影クリップを 1 本作る(timelineStore.addFilterClip の撮影版)。autofit なら作ってから自動で合わせる
 * (合わせられなくても作ったクリップは残す)。どちらも元に戻す 1 回ぶん
 */
export async function addSatsueiClip(data: ClipCreate, opts: { autofit?: boolean; label?: string } = {}): Promise<Clip> {
  let clip = await clipsApi.create({ ...data, kind: 'satsuei', asset_id: null })
  setLocal(cs => [...cs, clip])
  if (opts.autofit) {
    try { clip = (await autofitAndSave(clip)).clip } catch { /* 下に絵が無いなど: そのまま */ }
  }
  notifyEdit()
  pushReplaceHistory(opts.label ?? '撮影レイヤー追加', [], [clip])
  return clip
}

// ── 時間のかかる仕事(分けて合わせる・敷く)の表示 ───────────────────────
// 分ける・置き換えて敷くとパネルのクリップが作り直され、パネルも付け直しになるので、表示はパネルの外に持つ
let busyText: string | null = null
const busySubs = new Set<() => void>()
export const satsueiBusy = (): string | null => busyText
export function setSatsueiBusy(t: string | null) {
  busyText = t
  for (const f of busySubs) f()
}
export function subscribeSatsueiBusy(f: () => void): () => void {
  busySubs.add(f)
  return () => { busySubs.delete(f) }
}

// ── 撮影トラック ─────────────────────────────────────────────────────
/**
 * このプロジェクトの撮影トラック(名前「撮影」の映像トラック。いくつかあれば一番上)。無ければ作る:
 * 素材のトラック(Shots・Scenes など)のすぐ上。上のトラック(ロゴ・単色・フィルター)は order を 1 つずつ上へずらす
 */
export async function ensureSatsueiTrack(projectId: number): Promise<Track> {
  const st = useTimelineStore.getState()
  const vt = st.tracks.filter(t => t.project_id === projectId && t.track_type === 'video')
  const ex = vt.filter(t => t.name === SATSUEI_TRACK).sort((a, b) => a.order - b.order)[0]
  if (ex) return ex
  const pl = satsueiTrackPlacement(vt, st.clips)
  // 上のトラックから順にずらす(同じ order が一時的にも重ならないように)
  for (const s of [...pl.shift].sort((a, b) => a.order - b.order)) {
    await tracksApi.update(s.id, { order: s.order })
    useTimelineStore.setState(x => ({ tracks: x.tracks.map(t => t.id === s.id ? { ...t, order: s.order } : t) }))
  }
  return st.addTrackAt(projectId, 'video', SATSUEI_TRACK, pl.order)
}

// ── プリセットの正(backend)を読む ───────────────────────────────────
let metaP: Promise<SatsueiMeta | null> | null = null
/** GET /api/satsuei/meta を 1 度だけ読んで satsueiLook に登録する(失敗したら次に呼ばれたとき読み直す。写しで動く) */
export function loadSatsueiMeta(): Promise<SatsueiMeta | null> {
  if (!metaP) {
    metaP = getSatsueiMeta()
      .then(m => { registerSatsueiMeta(m); return m })
      .catch(() => { metaP = null; return null })
  }
  return metaP
}
