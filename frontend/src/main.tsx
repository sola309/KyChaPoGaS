import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Safe Area 検出: env(safe-area-inset-*) のいずれかが正なら <html class="has-notch">。
// ノッチ機ではモーダル(.fixed.inset-0)へ一括で env() パディングを効かせ、
// 平面環境(desktop/Android/通常Safari縦)では既存レイアウトに一切触れない。
// 回転でインセットが上→側面へ移動するため、向きの変化ごとに再判定する。
function detectNotch() {
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;visibility:hidden;' +
    'padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);' +
    'padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px)'
  document.body.appendChild(el)
  const cs = getComputedStyle(el)
  const has = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']
    .some(prop => parseFloat(cs.getPropertyValue(prop)) > 0)
  document.body.removeChild(el)
  document.documentElement.classList.toggle('has-notch', has)
}
detectNotch()
window.addEventListener('orientationchange', () => setTimeout(detectNotch, 300))
window.visualViewport?.addEventListener('resize', () => detectNotch())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
