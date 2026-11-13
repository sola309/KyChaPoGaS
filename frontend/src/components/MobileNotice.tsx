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
      className="safe-top-pad fixed inset-x-0 top-0 z-[60] bg-purple-900/95 text-purple-50 text-[13px] leading-snug px-3 py-2 flex items-center gap-2 shadow"
      style={{ paddingTop: 'calc(0.5rem + env(safe-area-inset-top))' }}
    >
      <span className="flex-1">
        📱 スマホは<b>確認むけ</b>です(再生・テイクの切り替え・書き出しのダウンロード)。<b>☰</b>＝プロジェクト、<b>✨</b>＝アセット/生成/ジョブ、<b>🎞 コンポ</b>＝コンポジション(スマホ用の画面)。カットを<b>2 回押す</b>とテイク履歴。細かい編集は広い画面や<b>横向き</b>で。
      </span>
      <button
        onClick={() => { sessionStorage.setItem('mobile_notice_dismissed', '1'); setShow(false) }}
        className="px-3 py-1.5 rounded bg-purple-800 hover:bg-purple-700 flex-shrink-0 text-[13px]"
      >閉じる</button>
    </div>
  )
}
