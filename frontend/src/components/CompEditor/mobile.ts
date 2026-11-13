// 🎞 コンポジション編集画面の、画面の大きさごとの出し分け(スマホ・横向きスマホ・タブレット・PC)。
// PC の見た目は変えない。スマホは専用の並び、タブレットは PC の並びのまま指で押せる大きさにする。

import { createContext, useContext, useEffect, useState } from 'react'

/**
 * phone      = 縦持ちのスマホ(幅 640px 以下)。プレビューが上、下にタブの欄
 * phoneWide  = 横持ちのスマホ(高さ 500px 以下)。プレビューが左、右にタブの欄
 * tablet     = 指で触る広い画面(iPad)。PC の並びのまま、押す所を大きく
 * desktop    = PC(今までどおり)
 */
export type CompLayout = 'phone' | 'phoneWide' | 'tablet' | 'desktop'

const coarse = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches

/** 読み込んだときに指で触る機械か(タイムラインの行の高さなど、途中で変えない値に使う) */
export const COARSE = coarse()

export function detectLayout(): CompLayout {
  if (typeof window === 'undefined') return 'desktop'
  const w = window.innerWidth, h = window.innerHeight
  if (w <= 640) return 'phone'
  if (h <= 500 && w <= 1000) return 'phoneWide'
  return coarse() ? 'tablet' : 'desktop'
}

/** 画面の大きさに合わせた並び。向きを変えた・窓を変えたときは少し待ってから切り替える(連続して作り直さない) */
export function useCompLayout(): CompLayout {
  const [layout, setLayout] = useState<CompLayout>(detectLayout)
  useEffect(() => {
    let t: number | null = null
    const on = () => {
      if (t != null) window.clearTimeout(t)
      t = window.setTimeout(() => { t = null; setLayout(detectLayout()) }, 150)
    }
    window.addEventListener('resize', on)
    window.addEventListener('orientationchange', on)
    return () => {
      if (t != null) window.clearTimeout(t)
      window.removeEventListener('resize', on)
      window.removeEventListener('orientationchange', on)
    }
  }, [])
  return layout
}

export const isPhoneLayout = (l: CompLayout) => l === 'phone' || l === 'phoneWide'

/** 指で触る並びか(数値欄に − / + を出す・ラベルを上に置く、など)。fields.tsx の部品が読む */
export const TouchUI = createContext(false)
export const useTouchUI = () => useContext(TouchUI)

/**
 * 画面キーボードが出ているか(iOS は窓の高さを変えずにキーボードを重ねるので、visualViewport で見る)。
 * ついでに、見えている高さを CSS 変数 --comp-vvh に入れる(編集画面の高さに使う。無ければ 100dvh)。
 */
export function useKeyboardInset(on: boolean): boolean {
  const [kb, setKb] = useState(false)
  useEffect(() => {
    const vv = window.visualViewport
    const root = document.documentElement
    if (!on || !vv) return
    let raf = 0
    const upd = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const open = window.innerHeight - vv.height > 140 && vv.scale <= 1.05
        setKb(open)
        if (open) {
          root.style.setProperty('--comp-vvh', `${Math.round(vv.height)}px`)
          // iOS は入力欄を見せるためにページごと上へ送る。固定の画面なので元へ戻す
          if (window.scrollY !== 0 || vv.offsetTop !== 0) window.scrollTo(0, 0)
        } else root.style.removeProperty('--comp-vvh')
      })
    }
    vv.addEventListener('resize', upd)
    vv.addEventListener('scroll', upd)
    upd()
    return () => {
      cancelAnimationFrame(raf)
      vv.removeEventListener('resize', upd)
      vv.removeEventListener('scroll', upd)
      root.style.removeProperty('--comp-vvh')
    }
  }, [on])
  return kb
}
