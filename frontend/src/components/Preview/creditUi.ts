/**
 * 🔤 字幕のパネルとプレビューのつなぎ(どのクリップのパネルが開いているか)と、debug の口(?debug=credit だけ)。
 *   パネルが開いている間: プレビューは字幕の枠を出してドラッグで動かせる(CreditOverlay)・全部の字幕の地図を先に取る。
 */

export const CREDIT_DEBUG = typeof window !== 'undefined'
  && /(?:^|[?&])debug=credit(?:&|$)/.test(window.location.search)

let panelClip: number | null = null
const subs = new Set<() => void>()
const notify = () => { for (const f of subs) { try { f() } catch { /* 描き直しの頼みだけ */ } } }

/** 字幕パネルを開いているクリップ(無ければ null) */
export const creditPanelClipId = (): number | null => panelClip
export function setCreditPanelClipId(id: number | null) {
  if (panelClip === id) return
  panelClip = id
  notify()
}
export function subscribeCreditUi(f: () => void): () => void {
  subs.add(f)
  return () => { subs.delete(f) }
}
/** プレビューに「字幕の枠が変わった(ドラッグ中など)」と知らせる */
export const bumpCreditUi = () => notify()

// ── 「書き出しと同じ計算」: プレビューが次に字幕を描くとき、字幕の枠の「下の絵」と「プレビューの結果」を写す ──
export interface CreditSnapshot { below: string; preview: string; frame: number; box: [number, number] }
let snapReq: { clipId: number; resolve: (v: CreditSnapshot | null) => void } | null = null
/** 次にこのクリップを描くときの絵を写してもらう(4 秒で描かれなければ null = このコマでは字幕が出ていない・地図が来ない) */
export function requestCreditSnapshot(clipId: number): Promise<CreditSnapshot | null> {
  return new Promise(resolve => {
    if (snapReq) snapReq.resolve(null)
    const me = { clipId, resolve }
    snapReq = me
    notify()                                           // プレビューに描き直してもらう
    setTimeout(() => { if (snapReq === me) { snapReq = null; resolve(null) } }, 4000)
  })
}
/** プレビューから: このクリップの写しを頼まれていれば受け取る */
export function takeCreditSnapshot(clipId: number): ((v: CreditSnapshot | null) => void) | null {
  if (!snapReq || snapReq.clipId !== clipId) return null
  const r = snapReq.resolve
  snapReq = null
  return r
}

/** debug(?debug=credit)の状態: 下に敷く静止画・描画時間 */
export const creditDebugState: { underlay: CanvasImageSource | null; lastMs: number; frameMs: number[]; creditMs: number[] } = {
  underlay: null, lastMs: 0, frameMs: [], creditMs: [],
}
/** window.__kychaCredit に口を足す(?debug=credit のときだけ) */
export function installCreditDebug(api: Record<string, unknown>) {
  if (!CREDIT_DEBUG || typeof window === 'undefined') return
  const w = window as unknown as { __kychaCredit?: Record<string, unknown> }
  w.__kychaCredit = { ...(w.__kychaCredit ?? {}), ...api, state: creditDebugState }
}
