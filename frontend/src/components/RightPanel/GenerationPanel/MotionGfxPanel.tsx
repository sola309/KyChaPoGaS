import { useState } from 'react'
import { useProjectStore } from '../../../store/projectStore'
import { jobsApi } from '../../../api/client'
import { useUIStore } from '../../../store/uiStore'

/**
 * Code-based motion graphics (HTML/CSS/JS → 動画クリップ).
 *
 * Templates emit self-contained HTML; a headless browser renders it frame-
 * exactly (CSS/WAAPI アニメは currentTime を直接シーク、JSアニメは
 * window.seek(t_ms) 規約) and the result lands in the asset library.
 */

type Template = 'lyric' | 'title' | 'countdown' | 'beatpulse' | 'custom'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const BASE_CSS = `html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
.full{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.txt{font-family:'Hiragino Sans','Noto Sans JP',sans-serif;font-weight:900;color:#fff}`

function lyricHTML(lines: string[], durPerLine: number, transparent = false): string {
  const items = lines.filter(l => l.trim()).map((l, i) => `
    <div class="full"><span class="txt slam" style="animation-delay:${(i * durPerLine).toFixed(2)}s">${esc(l)}</span></div>`)
  return `<!DOCTYPE html><html><head><style>${BASE_CSS}
  ${transparent ? '' : 'body{background:#110d0f}'}
  .slam{font-size:96px;opacity:0;text-shadow:0 0 30px rgba(214,64,93,.9);
    animation: slam ${durPerLine.toFixed(2)}s cubic-bezier(.2,1.4,.3,1) both}
  @keyframes slam{
    0%{transform:scale(3) rotate(-5deg);opacity:0}
    18%{transform:scale(.96);opacity:1}
    28%{transform:scale(1);opacity:1}
    88%{transform:scale(1);opacity:1}
    100%{transform:scale(1.05);opacity:0}}
  </style></head><body>${items.join('')}</body></html>`
}

function titleHTML(title: string, sub: string, dur: number, transparent = false): string {
  return `<!DOCTYPE html><html><head><style>${BASE_CSS}
  ${transparent ? '' : 'body{background:#110d0f}'}
  .wrap{flex-direction:column;gap:18px}
  .t{font-size:110px;letter-spacing:.08em;color:#f6c2cb;text-shadow:0 0 40px rgba(214,64,93,.8);
     animation: rise ${dur}s cubic-bezier(.16,1,.3,1) both}
  .s{font-size:28px;letter-spacing:.5em;color:#9c878c;animation: rise ${dur}s .25s cubic-bezier(.16,1,.3,1) both}
  .rule{width:0;height:2px;background:#d6405d;animation: grow ${dur}s .15s cubic-bezier(.16,1,.3,1) both}
  @keyframes rise{0%{transform:translateY(60px);opacity:0}30%{transform:none;opacity:1}90%{opacity:1}100%{opacity:0}}
  @keyframes grow{0%{width:0}40%{width:480px}90%{width:480px;opacity:1}100%{opacity:0}}
  </style></head><body>
  <div class="full wrap"><span class="txt t">${esc(title)}</span><div class="rule"></div><span class="txt s">${esc(sub)}</span></div>
  </body></html>`
}

function countdownHTML(from: number, perSec: number, transparent = false): string {
  const digits = Array.from({ length: from }, (_, i) => from - i)
  const items = digits.map((d, i) => `
    <div class="full"><span class="txt n" style="animation-delay:${(i * perSec).toFixed(2)}s">${d}</span></div>`)
  return `<!DOCTYPE html><html><head><style>${BASE_CSS}
  ${transparent ? '' : 'body{background:#110d0f}'}
  .n{font-size:240px;color:#d6405d;opacity:0;text-shadow:0 0 60px rgba(214,64,93,.7);
    animation: pop ${perSec.toFixed(2)}s cubic-bezier(.2,1.2,.4,1) both}
  @keyframes pop{0%{transform:scale(2.4);opacity:0}25%{transform:scale(1);opacity:1}80%{transform:scale(.92);opacity:1}100%{transform:scale(.8);opacity:0}}
  </style></head><body>${items.join('')}</body></html>`
}

/** データ駆動MG: 実際の楽曲ビート (window.kycha.beats) で脈動するビジュアライザ.
 *  canvas を window.seek(t_ms) で毎フレーム描画する — テンプレ自体がデータ駆動MGの作例. */
function beatPulseHTML(transparent = false): string {
  return `<!DOCTYPE html><html><head><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;${transparent ? '' : 'background:#110d0f'}}
canvas{position:absolute;inset:0}
</style></head><body>
<canvas id="c"></canvas>
<script>
const cv = document.getElementById('c')
const ctx = cv.getContext('2d')
const K = window.kycha || { beats: [], downbeats: [], duration: 3 }
function resize(){ cv.width = innerWidth; cv.height = innerHeight }
resize()
window.seek = (tms) => {
  const t = tms / 1000
  ctx.clearRect(0, 0, cv.width, cv.height)
  const cx = cv.width / 2, cy = cv.height / 2
  // 各ビートから衝撃波リングが広がる（直近1秒分）
  for (const b of K.beats) {
    const dt = t - b
    if (dt < 0 || dt > 1.0) continue
    const isDown = K.downbeats.some(d => Math.abs(d - b) < 0.01)
    const r = 60 + dt * 520
    const a = Math.max(0, 1 - dt) * (isDown ? 0.9 : 0.45)
    ctx.strokeStyle = 'rgba(214,64,93,' + a + ')'
    ctx.lineWidth = isDown ? 10 * (1 - dt) + 2 : 4 * (1 - dt) + 1
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke()
  }
  // 中心コア: 直近ビートからの経過で脈動
  let last = -1
  for (const b of K.beats) if (b <= t && b > last) last = b
  const pulse = last >= 0 ? Math.max(0, 1 - (t - last) * 3.5) : 0
  const core = 38 + pulse * 26
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, core * 2.2)
  g.addColorStop(0, 'rgba(246,194,203,' + (0.85 * (0.4 + pulse * 0.6)) + ')')
  g.addColorStop(1, 'rgba(214,64,93,0)')
  ctx.fillStyle = g
  ctx.beginPath(); ctx.arc(cx, cy, core * 2.2, 0, 7); ctx.fill()
}
</script></body></html>`
}

const CUSTOM_PLACEHOLDER = `<!DOCTYPE html>
<html><head><style>
  /* CSSアニメはフレーム単位で正確にキャプチャされます */
  @keyframes spin { to { transform: rotate(360deg) } }
</style></head>
<body>
  <!-- JSで動かす場合は window.seek(t_ms) を定義（毎フレーム呼ばれます） -->
  <script>window.seek = (t) => { /* canvas描画など */ }</script>
</body></html>`

export function MotionGfxPanel() {
  const { activeProject } = useProjectStore()
  const [template, setTemplate] = useState<Template>('lyric')
  const [line1, setLine1] = useState('')
  const [line2, setLine2] = useState('')
  const [line3, setLine3] = useState('')
  const [sub,   setSub]   = useState('')
  const [durPer, setDurPer] = useState(1.0)
  const [count, setCount] = useState(3)
  const [customHtml, setCustomHtml] = useState('')
  const [customDur,  setCustomDur]  = useState(3)
  const [transparent, setTransparent] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!activeProject) return null

  const handleGenerate = async () => {
    if (busy) return
    let html = ''
    let duration = 0
    if (template === 'lyric') {
      const lines = [line1, line2, line3].filter(l => l.trim())
      if (!lines.length) return
      html = lyricHTML(lines, durPer, transparent)
      duration = lines.length * durPer
    } else if (template === 'title') {
      if (!line1.trim()) return
      duration = Math.max(2, durPer * 2)
      html = titleHTML(line1, sub, duration, transparent)
    } else if (template === 'countdown') {
      html = countdownHTML(count, durPer, transparent)
      duration = count * durPer
    } else if (template === 'beatpulse') {
      html = beatPulseHTML(transparent)
      duration = customDur
    } else {
      if (!customHtml.trim()) return
      html = customHtml
      duration = customDur
    }
    setBusy(true)
    try {
      await jobsApi.create(activeProject.id, 'render_motion_graphics', {
        project_id: activeProject.id,
        html,
        duration_sec: duration,
        fps: activeProject.fps,
        width: activeProject.width,
        height: activeProject.height,
        transparent,
      })
      useUIStore.getState().pushToast('モーショングラフィックスを生成中…（完了後ライブラリに追加）', 'info')
    } catch { /* interceptor */ } finally {
      setBusy(false)
    }
  }

  const sel = 'bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1.5 outline-none border border-zinc-700 focus:border-purple-500'

  return (
    <div className="flex flex-col gap-3 p-3">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">テンプレート</span>
        <select value={template} onChange={e => setTemplate(e.target.value as Template)} className={sel}>
          <option value="lyric">歌詞スラム（最大3行）</option>
          <option value="title">タイトルカード</option>
          <option value="countdown">カウントダウン</option>
          <option value="beatpulse">ビートパルス（楽曲ビート同期）</option>
          <option value="custom">カスタムHTML</option>
        </select>
      </label>

      {template === 'lyric' && (
        <>
          {[ [line1, setLine1, '1行目'], [line2, setLine2, '2行目（任意）'], [line3, setLine3, '3行目（任意）'] ].map(([v, set, ph], i) => (
            <input key={i} value={v as string} placeholder={ph as string}
              onChange={e => (set as (s: string) => void)(e.target.value)} className={sel} />
          ))}
        </>
      )}

      {template === 'title' && (
        <>
          <input value={line1} placeholder="タイトル" onChange={e => setLine1(e.target.value)} className={sel} />
          <input value={sub} placeholder="サブタイトル（任意）" onChange={e => setSub(e.target.value)} className={sel} />
        </>
      )}

      {template === 'countdown' && (
        <label className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500">開始数</span>
          <select value={count} onChange={e => setCount(Number(e.target.value))} className={sel}>
            {[3, 5, 10].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}

      {template !== 'custom' && (
        <label className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500">{template === 'title' ? '表示時間の半分' : '1要素あたり'}</span>
          <select value={durPer} onChange={e => setDurPer(Number(e.target.value))} className={sel}>
            {[0.5, 0.7, 1.0, 1.5, 2.0].map(s => <option key={s} value={s}>{s}s</option>)}
          </select>
        </label>
      )}

      {template === 'beatpulse' && (
        <>
          <label className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500">尺(秒)</span>
            <input type="number" min={1} max={60} step={0.5} value={customDur}
              onChange={e => setCustomDur(Number(e.target.value))} className={`${sel} w-20`} />
          </label>
          <p className="text-[10px] text-zinc-600 leading-relaxed">
            タイムラインの楽曲の<b>実ビート</b>（解析結果）で脈動するビジュアライザ。
            透過にしてオーバーレイトラックに置くと映像の上で光ります
          </p>
        </>
      )}

      {template === 'custom' && (
        <>
          <textarea value={customHtml} onChange={e => setCustomHtml(e.target.value)} rows={10}
            placeholder={CUSTOM_PLACEHOLDER}
            className={`${sel} font-mono text-[10px] resize-y`} />
          <label className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500">尺(秒)</span>
            <input type="number" min={0.5} max={60} step={0.5} value={customDur}
              onChange={e => setCustomDur(Number(e.target.value))} className={`${sel} w-20`} />
          </label>
          <p className="text-[10px] text-zinc-600 leading-relaxed">
            CSS/WAAPIアニメはフレーム正確に書き出されます。JSアニメは
            <code className="text-zinc-400"> window.seek(t_ms) </code>を定義してください。
            <code className="text-zinc-400"> window.kycha </code>に
            {'{bpm, beats[], downbeats[], lyrics, duration}'}（楽曲の実データ）が注入されます。
          </p>
        </>
      )}

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={transparent}
          onChange={e => setTransparent(e.target.checked)}
          className="accent-purple-600"
        />
        <span className="text-[11px] text-zinc-300">透過背景（オーバーレイ用）</span>
      </label>
      {transparent && (
        <p className="text-[10px] text-zinc-600 -mt-1">
          映像の上に重ねるテロップ等に。2本目のVideoトラックに置くと書き出しで下のトラックと合成されます
        </p>
      )}

      <button
        onClick={handleGenerate}
        disabled={busy}
        className="bg-purple-700 hover:bg-purple-600 text-white text-xs rounded py-2 font-medium disabled:opacity-40"
      >
        {busy ? '生成中…' : '⚡ MGを生成'}
      </button>

      <p className="text-[10px] text-zinc-600">
        {activeProject.width}×{activeProject.height} @ {activeProject.fps}fps（プロジェクト設定）で書き出し、ライブラリに追加されます
      </p>
    </div>
  )
}
