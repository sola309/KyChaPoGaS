/**
 * ⏱ 時間リマップ(Scenes向け) — 複数カットを一度に生成したときの
 * シーンチェンジ位置のわずかなズレを、キーで手動補正する。
 *
 * remap_json: {"keys": [{"t": 出力フレーム(クリップ先頭=0), "src": 素材フレーム,
 *                        "hold": コマ打ちfps(0=なし, 次のキーまでの区間に適用)}]}
 * キー間は線形。先頭は暗黙 {t:0, src:asset_in_frame}、最終キー以降は等速で継続。
 * バックエンドの parse_remap / _extract_remap_segment と同じ規則。
 */
export interface RemapKey { t: number; src: number; hold?: number }

/** remap_json → 暗黙の端点を補った完全なキー列。無効/空なら null */
export function parseRemapKeys(raw: string | undefined, durFrames: number,
                               assetInFrame: number): RemapKey[] | null {
  if (!raw || !raw.trim()) return null
  let keys: RemapKey[]
  try { keys = (JSON.parse(raw).keys ?? []) as RemapKey[] } catch { return null }
  const ks = keys
    .filter(k => k && Number.isFinite(k.t) && Number.isFinite(k.src) && k.t >= 0 && k.t <= durFrames)
    .sort((a, b) => a.t - b.t)
    // 同一tは後勝ち(線形補間の分母0を防ぐ)
    .filter((k, i, arr) => i === arr.length - 1 || arr[i + 1].t !== k.t)
  if (!ks.length) return null
  const out = [...ks]
  if (out[0].t > 0) out.unshift({ t: 0, src: assetInFrame, hold: 0 })
  const last = out[out.length - 1]
  if (last.t < durFrames) out.push({ t: durFrames, src: last.src + (durFrames - last.t), hold: last.hold })
  return out.length >= 2 ? out : null
}

/** クリップ内の出力フレーム rel → 素材フレーム(コマ打ち量子化込み) */
export function remapSrcFrame(keys: RemapKey[], rel: number, fps: number): number {
  let i = 0
  while (i < keys.length - 2 && rel >= keys[i + 1].t) i++
  const k0 = keys[i], k1 = keys[i + 1]
  const hold = k0.hold ?? 0
  let r = rel
  if (hold > 0.5 && hold < fps) {
    // コマ打ちは出力タイムベースで量子化(レンダラのfpsフィルタと同じ見え方)
    const step = fps / hold
    r = k0.t + Math.floor((rel - k0.t) / step) * step
  }
  const span = Math.max(1e-6, k1.t - k0.t)
  return k0.src + (r - k0.t) * (k1.src - k0.src) / span
}
