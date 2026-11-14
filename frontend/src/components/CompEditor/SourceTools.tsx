// 🎞 画像・動画・連番レイヤーの「中身」に出す道具。
//   1. 大きさを合わせるワンタップ(source.fit を書く。素材の画素数を調べて % を割り算しなくてよい)
//   2. ✂ 背景を消す(既存の切り抜きジョブ cutout を走らせ、できた透過画像にレイヤーの参照を差し替える。元の素材は残る)
// どちらも文書に項目を足すだけ(取り消し 1 回で戻る)。

import { useSyncExternalStore, useState } from 'react'
import { jobsApi, apiErrorText, type JobType } from '../../api/client'
import { useUIStore } from '../../store/uiStore'
import type { Layer } from './types'
import { isAnimObj, isObj, setPath, unsetPath, updateLayer } from './docOps'
import { useCompStore } from './store'
import { Row, btnCls, inputCls } from './fields'

const toast = (t: string, k: 'info' | 'success' | 'error' = 'info') => useUIStore.getState().pushToast(t, k)

// ── 大きさを合わせる ────────────────────────────────────────────────────────

export type FitTap = 'width' | 'height' | 'cover' | 'contain' | 'off'

/** ワンタップの中身。fit を書き、拡大率を 100 % に、位置を画面のまん中に(キーつき・親つきの値は触らない) */
export function applyFitTap(l: Layer, kind: FitTap, W: number, H: number): { layer: Layer; kept: string[] } {
  const kept: string[] = []
  if (kind === 'off') return { layer: isObj(l.source) && l.source.fit !== undefined ? unsetPath(l, 'source.fit') : l, kept }
  const fit = kind === 'width' ? { width: W } : kind === 'height' ? { height: H } : { mode: kind }
  let n = setPath(l, 'source.fit', fit)
  const t = l.transform ?? {}
  if (isAnimObj(t.scale)) kept.push('拡大率(キーつき)')
  else n = setPath(n, 'transform.scale', Array.isArray(t.scale) && t.scale.length === 2 ? [100, 100] : t.scale === undefined || typeof t.scale === 'number' ? [100, 100] : [100, 100, 100])
  if (l.parent != null && l.parent !== '') kept.push('位置(親つき)')
  else if (isAnimObj(t.position)) kept.push('位置(キーつき)')
  else {
    const p = Array.isArray(t.position) ? [...(t.position as unknown[])] : [W / 2, H / 2]
    if (kind !== 'height') p[0] = W / 2
    if (kind !== 'width') p[1] = H / 2
    n = setPath(n, 'transform.position', p)
  }
  return { layer: n, kept }
}

const FIT_BTNS: { kind: FitTap; label: string; title: string }[] = [
  { kind: 'width', label: '↔ 幅に合わせる', title: 'コンポジションの幅に合わせる(高さは縦横比どおり)。拡大率は 100 % に、横位置はまん中に' },
  { kind: 'height', label: '↕ 高さに合わせる', title: 'コンポジションの高さに合わせる(幅は縦横比どおり)。拡大率は 100 % に、縦位置はまん中に' },
  { kind: 'cover', label: '⛶ 全面を覆う', title: 'コンポジションの全面を覆う(はみ出しは切る)。拡大率は 100 % に、位置はまん中に' },
  { kind: 'contain', label: '▣ 全体を収める', title: 'コンポジションに全体が収まる最大の大きさにする。拡大率は 100 % に、位置はまん中に' },
  { kind: 'off', label: '元の大きさ', title: '合わせるのをやめる(source.fit を消す。素材の画素数 × 拡大率に戻る)' },
]

function fitState(l: Layer, W: number, H: number): FitTap | null {
  const f = isObj(l.source) ? l.source.fit : undefined
  if (f === undefined || f === null) return 'off'
  if (!isObj(f)) return null
  const w = f.width, h = f.height
  if (w === W && h == null) return 'width'
  if (h === H && w == null) return 'height'
  if (w == null && h == null) return f.mode === 'cover' ? 'cover' : f.mode == null || f.mode === 'contain' ? 'contain' : null
  return null
}

function FitButtons({ layer }: { layer: Layer }) {
  const W = useCompStore(s => s.settings.width), H = useCompStore(s => s.settings.height)
  const cur = fitState(layer, W, H)
  const tap = (kind: FitTap) => {
    let kept: string[] = []
    useCompStore.getState().apply(d => updateLayer(d, layer.id, l => { const r = applyFitTap(l, kind, W, H); kept = r.kept; return r.layer }))
    if (kept.length) toast(`大きさを合わせました。${kept.join('・')}はそのままにしてあります`)
  }
  return (
    <Row label="大きさを合わせる" title="素材の画素数を知らなくても、px で大きさを決められます(source.fit)。細かい数字は下の「大きさを合わせる(px)」で">
      {FIT_BTNS.map(b => (
        <button key={b.kind} className={`${btnCls} ${cur === b.kind && b.kind !== 'off' ? '!border-purple-500 !text-purple-200' : ''}`} title={b.title} disabled={!!layer.locked}
                data-fit-tap={b.kind} aria-pressed={cur === b.kind} onClick={() => tap(b.kind)}>{b.label}</button>
      ))}
    </Row>
  )
}

// ── ✂ 背景を消す ────────────────────────────────────────────────────────────

/** 文書に残す控え: 切り抜く前の素材(絵には効かない。「元の絵に戻す」が読む) */
export const CUTOUT_OF = 'cutout_of'

const CUT_MODES = [
  { id: 'anime_white', label: 'アニメ絵・白い背景', model: 'isnet-anime', bg: 'white', title: '白い背景で描いた絵。縁の白かぶりと落ち影も取る' },
  { id: 'anime', label: 'アニメ絵・そのほかの背景', model: 'isnet-anime', bg: 'none', title: '背景が白でない絵' },
  { id: 'photo', label: '写真・汎用(重い)', model: 'birefnet-general', bg: 'none', title: '写真や、アニメ絵でうまく抜けないとき。数十秒かかることがあります' },
] as const

// 走っている切り抜き(レイヤーを選び直しても続く)。キー = `${compId}:${layerId}`
const running = new Map<string, number>()
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
const setRun = (key: string, p: number | null) => { if (p === null) running.delete(key); else running.set(key, p); emit() }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * 切り抜きを走らせて、できた素材にレイヤーの参照を差し替える。
 * 既存の API だけを使う: POST /api/jobs/ {job_type: "cutout"} → GET /api/jobs/{id} → result_asset_ids[0]。
 * crop: false(絵の大きさを変えない)なので、位置・拡大率・エフェクトはそのまま合う。
 */
export async function runCutout(compId: number, layerId: string, assetId: number, mode: (typeof CUT_MODES)[number]): Promise<void> {
  const key = `${compId}:${layerId}`
  if (running.has(key)) return
  setRun(key, 0)
  try {
    const pid = useCompStore.getState().projectId
    const job = await jobsApi.create(pid, 'cutout' as JobType, { project_id: pid, asset_id: assetId, model: mode.model, bg: mode.bg, feather: 1, crop: false })
    const t0 = Date.now()
    for (;;) {
      await sleep(700)
      let j
      try { j = await jobsApi.get(job.id) } catch { if (Date.now() - t0 > 600000) throw new Error('応答がありません'); continue }
      setRun(key, j.progress ?? 0)
      if (j.status === 'failed' || j.status === 'cancelled') throw new Error(j.error_msg ?? j.status)
      if (j.status !== 'completed') { if (Date.now() - t0 > 600000) throw new Error('10 分たっても終わりません(ジョブは続いています)'); continue }
      const newId = j.result_asset_ids?.[0]
      if (typeof newId !== 'number') throw new Error('できた素材が見つかりません')
      window.dispatchEvent(new Event('kychapogas:assets-changed'))
      const s = useCompStore.getState()
      if (s.comp?.id !== compId) { toast(`✂ 切り抜きはできました(素材 #${newId})。コンポジションを閉じたので、レイヤーは差し替えていません`); return }
      let done = false
      s.apply(d => updateLayer(d, layerId, l => {
        if (!isObj(l.source) || l.source.asset_id !== assetId) return l
        done = true
        // 控えは「いちばん元の素材」を保つ(切り抜きを重ねても、元の絵に戻せる)
        const orig = typeof l.source[CUTOUT_OF] === 'number' ? l.source[CUTOUT_OF] : assetId
        return { ...l, source: { ...l.source, asset_id: newId, [CUTOUT_OF]: orig } }
      }))
      toast(done ? `✂ 背景を消しました(素材 #${newId}。元の素材 #${assetId} は残っています。Ctrl+Z か「元の絵に戻す」で戻せます)`
        : `✂ 切り抜きはできました(素材 #${newId})。待つあいだにレイヤーの素材が変わったので、差し替えていません`, done ? 'success' : 'info')
      return
    }
  } catch (e) {
    toast(`✂ 背景を消せませんでした: ${e instanceof Error && !('response' in e) ? e.message : apiErrorText(e)}`, 'error')
  } finally { setRun(key, null) }
}

function CutoutRow({ layer }: { layer: Layer }) {
  const compId = useCompStore(s => s.comp?.id)
  const [modeId, setModeId] = useState<string>(CUT_MODES[0].id)
  const key = `${compId}:${layer.id}`
  const prog = useSyncExternalStore(subscribe, () => running.get(key) ?? -1)
  const src = isObj(layer.source) ? layer.source : {}
  const assetId = typeof src.asset_id === 'number' ? src.asset_id : null
  const orig = typeof src[CUTOUT_OF] === 'number' ? (src[CUTOUT_OF] as number) : null
  const busy = prog >= 0
  const mode = CUT_MODES.find(m => m.id === modeId) ?? CUT_MODES[0]
  const restore = () => {
    if (orig == null) return
    useCompStore.getState().apply(d => updateLayer(d, layer.id, l => {
      if (!isObj(l.source)) return l
      const { [CUTOUT_OF]: _o, ...rest } = l.source
      void _o
      return { ...l, source: { ...rest, asset_id: orig } }
    }))
  }
  return (
    <Row label="切り抜き" title="背景を消した透過画像を新しい素材として作り、このレイヤーの絵をそれに差し替えます。元の素材は消しません">
      <button className={`${btnCls} border-emerald-700 text-emerald-200`} data-cutout-run disabled={busy || assetId == null || !!layer.locked || compId == null}
              title={assetId == null ? '素材を選ぶと使えます(URL の画像には使えません)' : `素材 #${assetId} の背景を消す(${mode.label})`}
              onClick={() => { if (assetId != null && compId != null) void runCutout(compId, layer.id, assetId, mode) }}>
        {busy ? `✂ 切り抜き中… ${Math.round(prog * 100)}%` : '✂ 背景を消す'}
      </button>
      <select className={inputCls} value={modeId} disabled={busy} data-cutout-mode title={mode.title} onChange={e => setModeId(e.target.value)}>
        {CUT_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {orig != null && orig !== assetId && (
        <button className={btnCls} data-cutout-restore disabled={busy || !!layer.locked} title={`切り抜く前の素材 #${orig} に戻す(切り抜いた素材 #${assetId ?? '?'} は素材の一覧に残ります)`} onClick={restore}>↩ 元の絵に戻す(#{orig})</button>
      )}
    </Row>
  )
}

const FIT_TYPES = new Set(['image', 'video', 'sequence'])

/** 「中身」の欄の頭に出す。画像・動画・連番 = 大きさ合わせ、画像 = 切り抜きも */
export function SourceTools({ layer }: { layer: Layer }) {
  if (!FIT_TYPES.has(layer.type)) return null
  return (
    <div className="flex flex-col gap-1 pb-1 mb-1 border-b border-zinc-800" data-source-tools>
      <FitButtons layer={layer} />
      {layer.type === 'image' && <CutoutRow layer={layer} />}
    </div>
  )
}

/** 「中身」の一覧に出さない項目(SourceTools が面倒を見る控え) */
export const skipSourceMemo = (k: string) => k === CUTOUT_OF
