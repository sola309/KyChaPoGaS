import type { Asset } from '../../api/client'

/** 🔍解像度表示: 素材の解像度と生成ティア(T1/T2/T3)を短く表す。
 *  ネイティブ = 1344×768(H3 の出力上限)。元動画など大きい素材は縮小されるだけなので問題なし。 */
export interface ResInfo {
  label: string        // "1344" / "960" / "1080" など(横幅ではなく短辺基準の呼び名)
  tier: string | null  // "T1" | "T2" | "T3" | null(生成物でない)
  cls: string          // バッジの色クラス
  low: boolean         // ネイティブ未満
  redraw: boolean      // 採用動画を strong_reference にした描き直し(元動画は参照していない)
}

export function resInfo(asset: Asset | undefined): ResInfo | null {
  if (!asset || asset.width == null || asset.height == null) return null
  if (asset.asset_type === 'audio') return null
  const w = asset.width, h = asset.height
  let tier: string | null = null
  let redraw = false
  if (asset.gen_params_json) {
    try {
      const g = JSON.parse(asset.gen_params_json)
      if (typeof g.model === 'string' && g.model.startsWith('minimax-h3')) {
        const steps = Number(g.steps ?? 0)
        const turbo = Number(g.turbo_lora ?? 0) > 0
        tier = steps >= 20 && !turbo ? 'T3' : steps > 4 ? 'T2' : 'T1'
        // refine/描き直し: プロンプトに make_refine.transform の定型文が入る
        const pr = String(g.prompt ?? '')
        redraw = pr.includes('is a strong_reference: it already shows this shot')
          || pr.startsWith('[reference generation]') && pr.includes('only re-drawn at higher resolution')
      }
    } catch { /* 生成パラメータが読めない素材はティアなし */ }
  }
  const native = w >= 1344 && h >= 768
  const larger = w > 1344 || h > 768
  const label = larger ? `${h}` : `${w}`
  const cls = larger ? 'bg-zinc-600 text-zinc-100'
    : native ? 'bg-emerald-600 text-white'
    : w >= 1100 ? 'bg-amber-500 text-black'
    : 'bg-red-600 text-white'
  return { label, tier, cls, low: !native, redraw }
}
