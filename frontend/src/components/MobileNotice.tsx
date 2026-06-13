import { useEffect, useState } from 'react'

/**
 * KyChaPoGaS' timeline editor is built for desktop/tablet. On small/portrait
 * screens we show a dismissible banner setting expectations (rather than a
 * broken cramped layout).
 */
export function MobileNotice() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const check = () => {
      const small = window.innerWidth < 760
      const dismissed = sessionStorage.getItem('mobile_notice_dismissed') === '1'
      setShow(small && !dismissed)
    }
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  if (!show) return null
  return (
    <div
      className="fixed inset-x-0 top-0 z-[60] bg-purple-900/95 text-purple-50 text-xs px-3 py-2 flex items-center gap-2 shadow"
      style={{ paddingTop: 'calc(0.5rem + env(safe-area-inset-top))' }}
    >
      <span className="flex-1">
        📱 スマホでも編集できます。上部の <b>☰</b>＝プロジェクト、<b>✨</b>＝アセット/生成。広い画面や<b>横向き</b>だとより快適です。
      </span>
      <button
        onClick={() => { sessionStorage.setItem('mobile_notice_dismissed', '1'); setShow(false) }}
        className="px-2 py-0.5 rounded bg-purple-800 hover:bg-purple-700"
      >閉じる</button>
    </div>
  )
}
