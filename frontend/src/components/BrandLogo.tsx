import { useEffect, useRef, useState } from 'react'

/**
 * BrandLogo — the "KyChaPoGaS" wordmark with a hidden easter egg.
 *
 * Long-press (1.5s) OR tap it 5× quickly to reveal what the name stands for:
 *   Ky·Cha·Po·Ga·S → Kyoko Chan to Pocky Game Shitai
 *   （杏子ちゃんとポッキーゲームしたい / 元ネタ: 佐倉杏子）
 * The segments light up one by one and expand into their words.
 */

const SEGMENTS = [
  { letters: 'Ky',  word: 'Kyoko',  jp: '杏子' },
  { letters: 'Cha', word: 'Chan',   jp: 'ちゃん' },
  { letters: 'Po',  word: 'Pocky',  jp: 'ポッキー' },
  { letters: 'Ga',  word: 'Game',   jp: 'ゲーム' },
  { letters: 'S',   word: 'Shitai', jp: 'したい' },
]

const TAP_TARGET   = 5      // taps to trigger
const TAP_WINDOW   = 1200   // ms — taps must be this close together
const PRESS_MS     = 1500   // long-press duration

interface Props {
  className?: string
}

export function BrandLogo({ className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)

  const taps    = useRef(0)
  const tapT    = useRef<number | undefined>(undefined)
  const pressT  = useRef<number | undefined>(undefined)
  const fired   = useRef(false)

  // Staggered reveal once the egg is open
  useEffect(() => {
    if (!open) { setStep(0); return }
    let i = 0
    setStep(0)
    const id = window.setInterval(() => {
      i += 1
      setStep(i)
      if (i > SEGMENTS.length) window.clearInterval(id)
    }, 340)
    return () => window.clearInterval(id)
  }, [open])

  // Escape to close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const trigger = () => { fired.current = true; taps.current = 0; setOpen(true) }

  const onPointerDown = () => {
    fired.current = false
    window.clearTimeout(pressT.current)
    pressT.current = window.setTimeout(trigger, PRESS_MS)   // long-press
  }
  const cancelPress = () => window.clearTimeout(pressT.current)

  const onPointerUp = () => {
    window.clearTimeout(pressT.current)
    if (fired.current) return            // long-press already handled it
    taps.current += 1                    // count a quick tap
    window.clearTimeout(tapT.current)
    tapT.current = window.setTimeout(() => { taps.current = 0 }, TAP_WINDOW)
    if (taps.current >= TAP_TARGET) trigger()
  }

  return (
    <>
      <span
        className={`cursor-pointer select-none ${className}`}
        style={{ touchAction: 'manipulation', WebkitUserSelect: 'none', userSelect: 'none' }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={e => e.preventDefault()}
        title="KyChaPoGaS"
      >
        KyChaPoGaS
      </span>

      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative mx-4 max-w-[92vw] rounded-2xl border border-purple-700/60 bg-gradient-to-b from-zinc-900 to-zinc-950 px-6 py-8 sm:px-10 sm:py-10 shadow-2xl"
            style={{ boxShadow: '0 0 60px -10px rgba(214,64,93,0.45)' }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setOpen(false)}
              className="absolute top-2 right-3 text-zinc-500 hover:text-zinc-200 text-lg"
              aria-label="閉じる"
            >✕</button>

            <p className="text-center text-[11px] uppercase tracking-[0.3em] text-purple-400/80 mb-6">
              the name stands for
            </p>

            {/* Acronym segments lighting up one by one */}
            <div className="flex items-end justify-center gap-3 sm:gap-5">
              {SEGMENTS.map((s, i) => {
                const lit = step > i
                return (
                  <div key={i} className="flex flex-col items-center">
                    <span
                      className={`text-3xl sm:text-4xl font-bold tracking-tight transition-all duration-300
                        ${lit ? 'text-purple-400 scale-110' : 'text-zinc-500'}`}
                      style={lit ? { textShadow: '0 0 18px rgba(227,103,126,0.7)' } : undefined}
                    >
                      {s.letters}
                    </span>
                    <span
                      className={`mt-2 text-sm font-medium transition-all duration-300
                        ${lit ? 'text-purple-200 opacity-100 translate-y-0' : 'text-zinc-700 opacity-0 -translate-y-1'}`}
                    >
                      {s.word}
                    </span>
                    <span
                      className={`text-[11px] transition-opacity duration-500
                        ${lit ? 'text-zinc-400 opacity-100' : 'opacity-0'}`}
                    >
                      {s.jp}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Full phrase */}
            <div
              className={`mt-8 text-center transition-all duration-700
                ${step > SEGMENTS.length ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'}`}
            >
              <p className="text-lg sm:text-xl font-bold text-purple-200">
                🥢 杏子ちゃんとポッキーゲームしたい
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                元ネタ: 佐倉杏子（魔法少女まどか☆マギカ）　·　A MAD Video Creation Studio
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
