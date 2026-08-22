import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset, Clip, Track } from '../../api/client'
import { assetsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { deriveCutsWithScene } from './SceneLane'

/**
 * 🗺 設計マップ — 曲を再生しながら、いま鳴っている歌詞・カット・設計上の繋がりを追う。
 *
 * 作った理由: 設計が「docsのmarkdown」と「ピンのattrs_json」に分散し、どちらが正かを
 * 人が管理できなくなって29カットの未反映を見落とした(2026-08-23)。
 * **ピンのattrs_jsonを唯一の正**とし、そこから機械的に描画する。
 * 表示されないものは存在しない ── それがこのパネルの契約。
 *
 * 再生は自前のHTMLAudioElement(音声プロキシ=3.1MB)。映像は読まないので軽い。
 * 曲の時刻 → カット → 歌詞 → 繋がっているカット、が同時に動く。
 */
interface Props {
  tracks: Track[]
  clips: Clip[]
  assets: Asset[]
  fps: number
  onClose: () => void
}

interface CutInfo {
  n: number; s: number; e: number; t0: number; t1: number; dur: number
  intent: string; lyrics: string; refs: number[]
  noPerson: boolean; warns: string[]
}

const ACTS = [
  { name: '序', from: 1, to: 3, bar: '#52525b', chip: 'bg-zinc-700 text-zinc-100' },
  { name: '幕1', from: 4, to: 15, bar: '#0369a1', chip: 'bg-sky-800 text-sky-100' },
  { name: '幕2', from: 16, to: 34, bar: '#b45309', chip: 'bg-amber-800 text-amber-100' },
  { name: '間奏', from: 35, to: 42, bar: '#047857', chip: 'bg-emerald-800 text-emerald-100' },
  { name: '幕3', from: 43, to: 59, bar: '#be123c', chip: 'bg-rose-800 text-rose-100' },
  { name: '終', from: 60, to: 67, bar: '#6d28d9', chip: 'bg-violet-800 text-violet-100' },
]
const actOf = (n: number) => ACTS.find(a => n >= a.from && n <= a.to) ?? ACTS[0]
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

export function DesignMap({ tracks, clips, assets, fps, onClose }: Props) {
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const [sel, setSel] = useState<number | null>(null)
  const [t, setT] = useState(0)            // 再生位置(秒)
  const [playing, setPlaying] = useState(false)
  const [follow, setFollow] = useState(true)   // 再生に合わせて選択を追従
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const laneRef = useRef<HTMLDivElement | null>(null)

  const cuts = useMemo<CutInfo[]>(() => {
    const base = deriveCutsWithScene(tracks, clips, assets)
    return base.map(c => {
      let intent = ''; let lyrics = ''
      try {
        const a = c.pin.attrs_json ? JSON.parse(c.pin.attrs_json) : {}
        intent = String(a?.intent ?? '')
        lyrics = String(a?.scene?.board?.lyrics ?? '')
      } catch { /* 壊れたattrsは空扱い */ }
      const refs = [...new Set([...intent.matchAll(/C(\d+)/g)]
        .map(m => Number(m[1])).filter(x => x !== c.idx && x >= 1 && x <= base.length))]
      const warns = [...intent.matchAll(/⚠([^。\n]{4,80})/g)].map(m => m[1].trim())
      return {
        n: c.idx, s: c.s, e: c.e, t0: c.s / fps, t1: (c.e + 1) / fps,
        dur: (c.e - c.s + 1) / fps, intent, lyrics, refs,
        noPerson: intent.includes('人物なし'), warns,
      }
    })
  }, [tracks, clips, assets, fps])

  const total = cuts.length ? cuts[cuts.length - 1].t1 : 0
  const byN = useMemo(() => new Map(cuts.map(c => [c.n, c])), [cuts])
  const nowCut = useMemo(() => cuts.find(c => t >= c.t0 && t < c.t1) ?? null, [cuts, t])

  /** 音声プロキシ(3.1MB)。元音源トラックの最初のクリップを使う */
  const audioAssetId = useMemo(() => {
    const at = tracks.filter(x => x.track_type === 'audio' && !x.hidden)
      .sort((a, b) => a.order - b.order)
    for (const tr of at) {
      const c = clips.find(x => x.track_id === tr.id && x.asset_id != null)
      if (c?.asset_id != null) return c.asset_id
    }
    return null
  }, [tracks, clips])
  const hasProxy = useMemo(
    () => audioAssetId != null && !!assets.find(a => a.id === audioAssetId)?.proxy_path,
    [assets, audioAssetId])

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const onTime = () => setT(a.currentTime)
    const onEnd = () => setPlaying(false)
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('ended', onEnd)
    return () => { a.removeEventListener('timeupdate', onTime); a.removeEventListener('ended', onEnd) }
  }, [])

  useEffect(() => { if (follow && nowCut) setSel(nowCut.n) }, [follow, nowCut])

  // 再生位置のカットを帯の中央へスクロール
  useEffect(() => {
    if (!follow || !nowCut || !laneRef.current) return
    const el = laneRef.current.querySelector<HTMLElement>(`[data-cut="${nowCut.n}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [follow, nowCut])

  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (playing) { a.pause(); setPlaying(false) }
    else { void a.play(); setPlaying(true) }
  }
  const seek = (sec: number) => {
    const a = audioRef.current
    if (a) a.currentTime = Math.max(0, Math.min(total, sec))
    setT(sec)
  }

  /** 選択中カットに繋がる相手(双方向 + 同じ歌詞) */
  const lyricGroups = useMemo(() => {
    const m = new Map<string, number[]>()
    for (const c of cuts) { const k = c.lyrics.trim(); if (k) m.set(k, [...(m.get(k) ?? []), c.n]) }
    return [...m.entries()].filter(([, v]) => v.length > 1)
      .map(([k, v]) => ({ lyric: k, cuts: v, far: Math.max(...v) - Math.min(...v) > 5 }))
  }, [cuts])

  const linked = useMemo(() => {
    if (sel == null) return new Set<number>()
    const out = new Set<number>(byN.get(sel)?.refs ?? [])
    for (const c of cuts) if (c.refs.includes(sel)) out.add(c.n)
    const g = lyricGroups.find(g => g.cuts.includes(sel))
    if (g) for (const n of g.cuts) if (n !== sel) out.add(n)
    return out
  }, [sel, cuts, byN, lyricGroups])

  const selCut = sel != null ? byN.get(sel) : undefined
  const pct = (x: number) => `${(x / Math.max(1, total)) * 100}%`

  return createPortal(
    <div className="fixed inset-0 z-[120] bg-zinc-950 flex flex-col text-zinc-100">
      {audioAssetId != null && (
        <audio ref={audioRef} src={assetsApi.fileUrl(audioAssetId, hasProxy)} preload="auto" />
      )}

      {/* ── ヘッダ: 再生コントロール ─────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 flex-shrink-0">
        <button onClick={toggle}
                className="text-base px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700">
          {playing ? '⏸' : '▶'}
        </button>
        <span className="text-sm tabular-nums text-zinc-300">{mmss(t)} / {mmss(total)}</span>
        {nowCut && (
          <span className={`text-sm px-2 py-0.5 rounded ${actOf(nowCut.n).chip}`}>
            {actOf(nowCut.n).name} ・ C{nowCut.n}
          </span>
        )}
        <label className="flex items-center gap-1 text-xs text-zinc-400 ml-2">
          <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />
          再生に追従
        </label>
        <span className="text-xs text-zinc-500 ml-auto">帯をクリック=その時刻へ / カードをダブルクリック=タイムラインへ</span>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-xl leading-none px-2">✕</button>
      </div>

      {/* ── 歌詞(大きく) ──────────────────────────────── */}
      <div className="px-6 py-4 border-b border-zinc-800 flex-shrink-0 min-h-[92px] flex flex-col justify-center">
        {nowCut?.lyrics
          ? <div className="text-3xl leading-snug text-sky-200">{nowCut.lyrics}</div>
          : <div className="text-2xl text-zinc-700">— 歌詞なし —</div>}
        {nowCut && (
          <div className="text-sm text-zinc-500 mt-1">
            C{nowCut.n} / {nowCut.dur.toFixed(2)}秒
            {nowCut.noPerson && <span className="ml-2 text-teal-400">◻ 人物なし</span>}
            {nowCut.warns.length > 0 && <span className="ml-2 text-amber-400">⚠ {nowCut.warns.length}件</span>}
          </div>
        )}
      </div>

      {/* ── 時間軸の帯 ────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-zinc-800 flex-shrink-0">
        <div className="relative h-16 rounded bg-zinc-900 overflow-hidden cursor-pointer"
             onClick={e => {
               const r = e.currentTarget.getBoundingClientRect()
               seek(((e.clientX - r.left) / r.width) * total)
             }}>
          {/* 幕の帯 */}
          {ACTS.map(a => {
            const f = cuts.find(c => c.n === a.from), l = cuts.find(c => c.n === a.to)
            if (!f || !l) return null
            return (
              <div key={a.name} className="absolute top-0 h-4 flex items-center justify-center"
                   style={{ left: pct(f.t0), width: pct(l.t1 - f.t0), background: a.bar }}>
                <span className="text-[11px] text-white/90">{a.name}</span>
              </div>
            )
          })}
          {/* カットの区切り */}
          {cuts.map(c => {
            const on = sel === c.n, lk = linked.has(c.n), now = nowCut?.n === c.n
            return (
              <div key={c.n} data-cut={c.n}
                   onClick={e => { e.stopPropagation(); setFollow(false); setSel(c.n); seek(c.t0) }}
                   title={`C${c.n} ${c.dur.toFixed(2)}s`}
                   className="absolute top-4 bottom-0 border-r border-zinc-950 hover:brightness-150"
                   style={{
                     left: pct(c.t0), width: pct(c.dur),
                     background: now ? '#fbbf24' : on ? '#f59e0b' : lk ? '#78350f'
                       : c.noPerson ? '#134e4a' : '#3f3f46',
                   }}>
                {c.dur > 3 && (
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] text-white/80">
                    {c.n}
                  </span>
                )}
              </div>
            )
          })}
          {/* 再生ヘッド */}
          <div className="absolute top-0 bottom-0 w-0.5 bg-white pointer-events-none"
               style={{ left: pct(t) }} />
        </div>
        <div className="text-[11px] text-zinc-600 mt-1">
          黄=再生中 / 橙=選択 / 焦茶=繋がっているカット / 深緑=人物なし
        </div>
      </div>

      {/* ── 下段: 左=繋がり / 右=設計本文 ─────────────── */}
      <div className="flex-1 overflow-hidden flex gap-3 p-3">
        <div ref={laneRef} className="w-[380px] flex-shrink-0 overflow-y-auto">
          <div className="text-sm text-zinc-300 mb-2">
            🔗 C{sel ?? '—'} と繋がっているカット
            {linked.size > 0 && <span className="text-zinc-500 text-xs ml-1">{linked.size}本</span>}
          </div>
          <div className="flex flex-col gap-1.5">
            {[...linked].sort((a, b) => a - b).map(n => {
              const c = byN.get(n)!
              const sameLyric = c.lyrics.trim() && c.lyrics.trim() === selCut?.lyrics.trim()
              return (
                <button key={n} data-cut={n}
                        onClick={() => { setFollow(false); setSel(n); seek(c.t0) }}
                        onDoubleClick={() => { setCurrentFrame(c.s); onClose() }}
                        className="text-left rounded border border-zinc-800 bg-zinc-900 hover:border-amber-600 p-2">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm px-1.5 rounded ${actOf(n).chip}`}>C{n}</span>
                    <span className="text-xs text-zinc-500">{mmss(c.t0)}</span>
                    {sameLyric && <span className="text-xs text-fuchsia-400">同じ歌詞</span>}
                    {c.noPerson && <span className="text-xs text-teal-400">◻</span>}
                  </div>
                  {c.lyrics && <div className="text-xs text-sky-300/90 mt-1 truncate">{c.lyrics}</div>}
                  <div className="text-xs text-zinc-500 mt-1 line-clamp-2 leading-snug">
                    {c.intent.replace(/[⚠*]/g, '')}
                  </div>
                </button>
              )
            })}
            {linked.size === 0 && (
              <div className="text-xs text-zinc-600 border border-dashed border-zinc-800 rounded p-3">
                帯のカットをクリックすると、そのカットと設計上つながっている
                カット(参照・同じ歌詞)がここに出ます。
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 min-w-0 overflow-y-auto">
          {selCut ? (
            <div className="rounded border border-zinc-800 bg-zinc-900 p-4">
              <div className="flex items-baseline gap-3 mb-2">
                <span className="text-xl">C{selCut.n}</span>
                <span className={`text-sm px-2 rounded ${actOf(selCut.n).chip}`}>{actOf(selCut.n).name}</span>
                <span className="text-sm text-zinc-500">
                  {mmss(selCut.t0)}–{mmss(selCut.t1)} / {selCut.dur.toFixed(2)}秒
                </span>
              </div>
              {selCut.warns.length > 0 && (
                <div className="mb-3">
                  <div className="text-sm text-amber-400 mb-1">⚠ 設計上の注意</div>
                  <ul className="flex flex-col gap-1">
                    {selCut.warns.map((w, i) => (
                      <li key={i} className="text-sm text-amber-100/90 bg-amber-950/30 rounded px-2 py-1 leading-snug">
                        {w}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="text-base text-zinc-200 whitespace-pre-wrap leading-relaxed">
                {selCut.intent}
              </div>
            </div>
          ) : (
            <div className="text-sm text-zinc-600 p-4 border border-dashed border-zinc-800 rounded">
              ▶ を押すと曲が流れ、歌詞・カット・繋がりが同時に動きます。
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
