import { useRef, useState } from 'react'

// 通しフレーム番号(タイムラインの絶対コマ番号 = 比較版に焼き込む「1600f」と同じ数)。
// 数字を入れて Enter でそのコマへ飛ぶ。Esc・欄の外をクリックで取り消し。
export function FrameJump({ currentFrame, maxFrame, onJump }: {
  currentFrame: number
  maxFrame: number
  onJump: (frame: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const commit = () => {
    const s = (draft ?? '').normalize('NFKC').replace(/[^\d]/g, '')   // 全角数字(日本語入力)も通す
    if (s !== '') onJump(Math.min(Math.max(0, parseInt(s, 10)), Math.max(0, maxFrame)))
    setDraft(null)
  }
  return (
    <span className="flex items-center gap-0.5 font-mono tabular-nums"
      title="通しフレーム番号(比較版の「◯f」と同じ数)。数字を入れて Enter でそのコマへ">
      <input
        ref={ref}
        value={draft ?? String(currentFrame)}
        inputMode="numeric"
        aria-label="通しフレーム番号"
        onFocus={e => { setDraft(String(currentFrame)); e.currentTarget.select() }}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={e => {
          e.stopPropagation()   // 数字・矢印をほかのショートカットに渡さない
          if (e.nativeEvent.isComposing) return   // 変換中の Enter / Esc は日本語入力のもの
          if (e.key === 'Enter') { commit(); ref.current?.blur() }
          else if (e.key === 'Escape') { setDraft(null); ref.current?.blur() }
        }}
        className="w-14 text-right text-[12px] leading-tight bg-zinc-800 border border-zinc-700 rounded px-1 text-yellow-300 focus:outline-none focus:border-yellow-500"
      />
      <span className="text-[11px] text-yellow-300/80">f</span>
    </span>
  )
}

// プレビューの音量(この画面・このブラウザだけ。書き出しの音は変わらない)
export function VolumeControl({ volume, muted, onVolume, onMuted }: {
  volume: number
  muted: boolean
  onVolume: (v: number) => void
  onMuted: (m: boolean) => void
}) {
  const pct = Math.round(volume * 100)
  const silent = muted || pct === 0
  const lastAudible = useRef(volume >= 0.05 ? volume : 1)
  if (volume >= 0.05) lastAudible.current = volume   // ほぼ無音まで下げた値は戻し先にしない
  return (
    <span className="flex items-center gap-1"
      title={`プレビューの音量 ${muted ? 'ミュート' : `${pct}%`}(この画面だけ。書き出しの音は変わりません)`}>
      <button
        onClick={() => {
          if (!silent) { onMuted(true); return }
          if (volume === 0) onVolume(lastAudible.current)
          onMuted(false)
        }}
        className="text-sm w-5 text-center text-zinc-300 hover:text-white"
        aria-label={silent ? 'ミュートを解除' : 'ミュート'}
      >{silent ? '🔇' : pct < 50 ? '🔉' : '🔊'}</button>
      <input
        type="range" min={0} max={100} step={1}
        value={muted ? 0 : pct}
        aria-label="プレビューの音量"
        onChange={e => {
          const v = Number(e.target.value) / 100
          onVolume(v)
          if (muted && v > 0) onMuted(false)
        }}
        className="w-16 max-sm:w-12 h-1 accent-purple-400 cursor-pointer"
      />
      <span className="text-[10px] text-zinc-500 w-8 text-right tabular-nums max-2xl:hidden">{muted ? 0 : pct}%</span>
    </span>
  )
}
