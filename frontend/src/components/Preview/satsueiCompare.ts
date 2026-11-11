/**
 * 🎬 撮影の「比べる」の状態(プレビューと撮影パネルで共有する小さな入れ物)。
 *   enabled: 画面を split の位置で左右に分け、左 = 撮影なし(前)・右 = 撮影あり(後)。境目に細い白線
 *   bypass : 撮影クリップを全部止めて素の絵を見る
 * プレビューは subscribeSatsueiCompare で変化を聞いて描き直す。保存はしない(開き直すと元に戻る)。
 */
export interface SatsueiCompare { enabled: boolean; split: number; bypass: boolean }

let state: SatsueiCompare = { enabled: false, split: 0.5, bypass: false }
const subs = new Set<(s: SatsueiCompare) => void>()

export const getSatsueiCompare = (): SatsueiCompare => state

export function setSatsueiCompare(partial: Partial<SatsueiCompare>) {
  const next: SatsueiCompare = {
    enabled: partial.enabled ?? state.enabled,
    split: Math.max(0, Math.min(1, Number.isFinite(partial.split) ? partial.split! : state.split)),
    bypass: partial.bypass ?? state.bypass,
  }
  if (next.enabled === state.enabled && next.split === state.split && next.bypass === state.bypass) return
  state = next
  for (const cb of [...subs]) {
    try { cb(state) } catch { /* 聞き手の失敗はほかに広げない */ }
  }
}

/** 変化を聞く。返り値を呼ぶとやめる */
export function subscribeSatsueiCompare(cb: (s: SatsueiCompare) => void): () => void {
  subs.add(cb)
  return () => { subs.delete(cb) }
}
