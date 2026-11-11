/**
 * 🔤 字幕クリップの書き換え(字幕パネル・タイムラインの出現/消失のつまみ・フィルター追加から使う)。
 *
 *   editCredit       : attrs_json.credit を書き換える(すぐプレビューに出て、保存は止まってから。元に戻すはつまみごと)。
 *                      保存の仕組みは 🎬 撮影と同じ satsueiEdit.editClipLive(変わった所だけの元に戻す・順番どおりの保存)。
 *                      結果は正規化した字幕を丸ごと持つ(あとで既定値が変わっても、決めた字幕は変わらない)。
 *   addCreditClip    : 字幕クリップを 1 本作る(「字幕」トラックが無ければ一番上に作る)。元に戻す 1 回ぶん。
 *   copyCreditParts  : 時間・屈折・見た目を同じ組 / 全部の字幕へ写す(元に戻す 1 回ぶん)。
 *   extendCredits    : 尺を全部 +N コマ(末尾を伸ばす。元に戻す 1 回ぶん)。
 */
import type { Clip, Track } from '../../api/client'
import { clipsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useCollabStore } from '../../store/collabStore'
import { editClipLive, flushClipEdit, patchClipsUndoable, pushReplaceHistory } from './satsueiEdit'
import {
  type CreditV1, creditOf, withCredit, newCredit, normalizeCredit, isCreditClip, newClipDurationS,
} from '../Preview/creditLook'

export const CREDIT_TRACK = '字幕'
type Obj = Record<string, unknown>
const notifyEdit = () => { try { useCollabStore.getState().broadcastEdit() } catch { /* noop */ } }
const latest = (id: number) => useTimelineStore.getState().clips.find(c => c.id === id)

/** 字幕を書き換える(fn は正規化ずみの写しを受けて新しい字幕を返す)。label = 元に戻すの名前、key = つまみ */
export function editCredit(clipId: number, fn: (c: CreditV1) => CreditV1 | Obj, label = '字幕の調整', key = label) {
  const cur = latest(clipId)
  if (!cur || cur.locked) return
  editClipLive(clipId, { attrs_json: withCredit(cur.attrs_json, fn) }, label, key)
}
/**
 * ドラッグ中(タイムラインの出現/消失のつまみ・プレビューの枠): 手元だけ書き換えてプレビューに出す(保存しない)。
 * 離したら commitCreditDrag で最後の値を 1 回だけ保存する = ゆっくり動かしても「元に戻す」は 1 回
 */
export function previewCredit(clipId: number, fn: (c: CreditV1) => CreditV1 | Obj) {
  useTimelineStore.setState(s => ({ clips: s.clips.map(c => c.id === clipId ? { ...c, attrs_json: withCredit(c.attrs_json, fn) } : c) }))
}
/** 2 つの字幕で値の違う欄の道(配列は丸ごと 1 つの欄) */
function diffPaths(a: unknown, b: unknown, base: string[] = [], out: string[][] = []): string[][] {
  const isO = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
  if (isO(a) && isO(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], [...base, k], out)
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(base)
  return out
}
function getPath(obj: unknown, path: readonly string[]): unknown {
  let v: unknown = obj
  for (const k of path) v = v && typeof v === 'object' ? (v as Obj)[k] : undefined
  return v
}
/**
 * ドラッグを離したとき: ドラッグで動かした欄だけをドラッグ前の値に戻してから(ほかの欄は今の手元のまま = 共同編集の相手が
 * 同じ字幕のほかの欄を変えていても消さない)、最後の値を editCredit で書いてすぐ保存する。元に戻すは 1 回、戻る先はドラッグ前
 */
export function commitCreditDrag(clipId: number, originalAttrs: string, fn: (c: CreditV1) => CreditV1 | Obj, label: string, key: string) {
  const orig = creditOf(originalAttrs)
  const paths = diffPaths(orig, normalizeCredit(fn(JSON.parse(JSON.stringify(orig)) as CreditV1)))
  revertCreditPaths(clipId, orig, paths)
  editCredit(clipId, fn, label, key)
  void flushClipEdit(clipId)
}
/** ドラッグを取りやめたとき(指がほかの操作に取られた・Esc など): 動かした欄だけドラッグ前に戻す(保存しない) */
export function cancelCreditDrag(clipId: number, originalAttrs: string, fn: (c: CreditV1) => CreditV1 | Obj) {
  const orig = creditOf(originalAttrs)
  revertCreditPaths(clipId, orig, diffPaths(orig, normalizeCredit(fn(JSON.parse(JSON.stringify(orig)) as CreditV1))))
}
function revertCreditPaths(clipId: number, orig: CreditV1, paths: string[][]) {
  if (!paths.length) return
  useTimelineStore.setState(s => ({ clips: s.clips.map(c => c.id !== clipId ? c : {
    ...c, attrs_json: withCredit(c.attrs_json, cur => paths.reduce<Obj>((o, p) => setPath(o, p, getPath(orig, p)), cur as unknown as Obj)),
  }) }))
}
/** ドラッグを始めるとき: パネルのつまみの保存待ち(0.3 秒)を先に送る(待ちの保存にドラッグ中の値が混ざらないように) */
export function settleBeforeDrag(clipId: number) { void flushClipEdit(clipId) }

/**
 * 左端のトリム(頭を moved コマ動かす): 決めてあるつやの時刻(クリップ先頭からのコマ)を、同じタイムラインのコマに保つ。
 * 出現・消失はクリップの端から数えるのでそのまま。つやが自動(null)なら何もしない(null を返す)
 */
export function shiftCreditHead(attrsJson: string | null | undefined, moved: number): string | null {
  if (!moved) return null
  const t = creditOf(attrsJson).timing
  if (t.sheen_start == null && t.sheen_end == null) return null
  return withCredit(attrsJson, c => ({ ...c, timing: { ...c.timing,
    sheen_start: c.timing.sheen_start == null ? null : c.timing.sheen_start - moved,
    sheen_end: c.timing.sheen_end == null ? null : c.timing.sheen_end - moved } }))
}

/** 字幕の 1 つの欄を書き換える(path = ['timing', 'appear_frames'] など) */
export function setCreditField(clipId: number, path: readonly string[], value: unknown, label?: string) {
  editCredit(clipId, c => setPath(c as unknown as Obj, path, value), label ?? '字幕の調整', 'credit.' + path.join('.'))
}
export function setPath(obj: Obj, path: readonly string[], value: unknown): Obj {
  if (!path.length) return obj
  const [k, ...rest] = path
  const out: Obj = { ...obj }
  out[k] = rest.length ? setPath((obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k]) ? obj[k] : {}) as Obj, rest, value) : value
  return out
}

/** このプロジェクトの「字幕」トラック(映像トラック。いくつかあれば一番上)。無ければ一番上に作る */
export async function ensureCreditTrack(projectId: number): Promise<Track> {
  const st = useTimelineStore.getState()
  const vt = st.tracks.filter(t => t.project_id === projectId && t.track_type === 'video')
  const ex = vt.filter(t => t.name === CREDIT_TRACK).sort((a, b) => a.order - b.order)[0]
  if (ex) return ex
  const minOrder = Math.min(0, ...st.tracks.filter(t => t.project_id === projectId).map(t => t.order))
  return st.addTrackAt(projectId, 'video', CREDIT_TRACK, minOrder - 1)
}

/**
 * 字幕クリップを 1 本作る。trackId を省けば「字幕」トラック(無ければ作る)。start = 再生位置、長さ = 3 秒(meta の値)。
 * 元に戻す 1 回ぶん(トラックを作った分は戻さない)
 */
export async function addCreditClip(projectId: number, opts: {
  trackId?: number; start?: number; duration?: number; role?: string; name?: string; credit?: CreditV1 | Obj
} = {}): Promise<Clip> {
  const st = useTimelineStore.getState()
  const fps = st.projectFps || 24
  const trackId = opts.trackId ?? (await ensureCreditTrack(projectId)).id
  const start = Math.max(0, Math.round(opts.start ?? st.currentFrame))
  const duration = Math.max(1, Math.round(opts.duration ?? newClipDurationS() * fps))
  const credit = opts.credit ? normalizeCredit(opts.credit) : newCredit(opts.role ?? '役職', opts.name ?? '名前')
  const clip = await clipsApi.create({
    track_id: trackId, asset_id: null, start_frame: start, duration_frames: duration, asset_in_frame: 0,
    kind: 'credit', attrs_json: JSON.stringify({ credit }),
  })
  useTimelineStore.setState(s => ({ clips: [...s.clips, clip] }))
  notifyEdit()
  pushReplaceHistory('字幕を追加', [], [clip])
  return clip
}

/** 写す欄のまとまり */
export type CreditPart = 'timing' | 'refract' | 'look' | 'size'
export const CREDIT_PART_LABEL: Record<CreditPart, string> = { timing: '時間', refract: '屈折', look: '見た目', size: '大きさ' }
const LOOK_KEYS = ['rim', 'edge_rgb', 'shadow', 'glow', 'role_shadow', 'shadow_sigma', 'shadow_off', 'glow_sigma',
  'plate', 'plate_rgb', 'plate_sigma', 'sheen', 'sheen_width', 'glints', 'letter_var'] as const
const SIZE_KEYS = ['name_size', 'role_size', 'line_gap', 'name_track', 'name_ja_scale', 'name_ja_track', 'role_track', 'role_latin_scale'] as const
/** src の選んだ欄を dst に重ねた字幕(つやの時刻は字幕ごとの長さに結びつくので写さない) */
export function mergeParts(dst: CreditV1, src: CreditV1, parts: readonly CreditPart[]): CreditV1 {
  const out = JSON.parse(JSON.stringify(dst)) as CreditV1
  if (parts.includes('timing')) {
    out.timing.appear_frames = src.timing.appear_frames
    out.timing.disappear_frames = src.timing.disappear_frames
    out.refract.g0 = src.refract.g0
    out.refract.fill_q = src.refract.fill_q
  }
  if (parts.includes('refract')) {
    for (const k of ['n_max', 'tube', 'slope_sat', 'letter', 'letter_sigma', 'zoom', 'disp', 'fres', 'fres_pow', 'fres_rgb', 'hl', 'absorb'] as const) {
      (out.refract as Obj)[k] = JSON.parse(JSON.stringify(src.refract[k]))
    }
  }
  if (parts.includes('look')) for (const k of LOOK_KEYS) (out.style as Obj)[k] = JSON.parse(JSON.stringify(src.style[k]))
  if (parts.includes('size')) for (const k of SIZE_KEYS) (out.style as Obj)[k] = src.style[k]
  return out
}
/** from の選んだ欄を targets(字幕クリップ)へ写す。元に戻す 1 回ぶん。写した本数を返す(🔒ロック中は飛ばす) */
export async function copyCreditParts(from: Clip, targets: readonly Clip[], parts: readonly CreditPart[], label: string): Promise<number> {
  const src = creditOf(from.attrs_json)
  const changes = targets
    .filter(c => c.id !== from.id && isCreditClip(c) && !c.locked)
    .map(c => ({ id: c.id, after: { attrs_json: withCredit(c.attrs_json, d => mergeParts(d, src, parts)) } }))
  return patchClipsUndoable(changes, label)
}
/** targets の尺を n コマ伸ばす(末尾。n < 0 なら縮める、1 コマ未満にはしない)。元に戻す 1 回ぶん */
export async function extendCredits(targets: readonly Clip[], n: number, label: string): Promise<number> {
  const changes = targets
    .filter(c => isCreditClip(c) && !c.locked)
    .map(c => ({ id: c.id, after: { duration_frames: Math.max(1, c.duration_frames + n) } }))
  return patchClipsUndoable(changes, label)
}
/** 最後の Shots のクリップの終わり(字幕がこれより後まであると、書き出しが伸びる) */
export function lastShotsEnd(): number | null {
  const st = useTimelineStore.getState()
  const shots = st.tracks.find(t => t.track_type === 'video' && t.name === 'Shots')
  if (!shots) return null
  let end = -1
  for (const c of st.clips) if (c.track_id === shots.id) end = Math.max(end, c.start_frame + c.duration_frames)
  return end >= 0 ? end : null
}
