// 📱 スマホむけの出し分け(編集画面のタイムライン・プレビューの操作部)。
// スマホ = 幅 640px 以下、または、指で触る機械で高さ 500px 以下(横持ち)。PC・タブレットでは false のまま。

import { useEffect, useState } from 'react'

const PHONE_QUERY = '(max-width: 640px), ((pointer: coarse) and (max-height: 500px))'
const COARSE_QUERY = '(pointer: coarse)'

const mm = (q: string) => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(q).matches

/** 今スマホの並びか(その場で調べる) */
export const isPhoneUi = () => mm(PHONE_QUERY)
/** 指で触る機械か(その場で調べる) */
export const isCoarse = () => mm(COARSE_QUERY)

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => mm(query))
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const m = window.matchMedia(query)
    const upd = () => setOn(m.matches)
    upd()
    m.addEventListener?.('change', upd)
    return () => m.removeEventListener?.('change', upd)
  }, [query])
  return on
}

/** スマホの並びか(向きを変えた・窓を変えたら追従) */
export const usePhoneUi = () => useMedia(PHONE_QUERY)
/** 指で触る機械か */
export const useCoarse = () => useMedia(COARSE_QUERY)

// 覚えておく値(localStorage は使えないことがある: プライベート窓など)
export function loadPref(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}
export function savePref(key: string, value: string) {
  try { window.localStorage.setItem(key, value) } catch { /* 覚えられなくても動く */ }
}

