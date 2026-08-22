import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset, Clip, Track } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { deriveCutsWithScene } from './SceneLane'

/**
 * 🗺 設計マップ — 全カットの設計を1枚で見渡し、カット間のリンクを可視化する。
 *
 * 作った理由: 設計が「docsのmarkdown」と「ピンのattrs_json」に分散し、
 * どちらが正かを人が管理できなくなって、実際に29カットの未反映を見落とした(2026-08-23)。
 * **ピンのattrs_jsonを唯一の正**として、そこから機械的に描画する。
 * 表示されないものは存在しない ── それがこのパネルの契約。
 *
 * リンクの抽出はすべて自動:
 *   ・intent本文中の「C12」形式の参照 → カット間リンク(93本)
 *   ・同じ歌詞を共有するカット → 歌詞グループ(離れていれば「韻」)
 *   ・⚠マーカー → 設計上の注意点
 */
interface Props {
  tracks: Track[]
  clips: Clip[]
  assets: Asset[]
  fps: number
  onClose: () => void
}

interface CutInfo {
  n: number; s: number; e: number; dur: number
  intent: string; lyrics: string; pin: Clip
  refs: number[]          // このカットが言及している他カット
  noPerson: boolean
  warns: string[]
}

const ACTS: Array<{ name: string; from: number; to: number; cls: string }> = [
  { name: '序', from: 1, to: 3, cls: 'bg-zinc-800 text-zinc-300' },
  { name: '幕1', from: 4, to: 15, cls: 'bg-sky-950 text-sky-300' },
  { name: '幕2', from: 16, to: 34, cls: 'bg-amber-950 text-amber-300' },
  { name: '間奏', from: 35, to: 42, cls: 'bg-emerald-950 text-emerald-300' },
  { name: '幕3', from: 43, to: 59, cls: 'bg-rose-950 text-rose-300' },
  { name: '終', from: 60, to: 67, cls: 'bg-violet-950 text-violet-300' },
]
const actOf = (n: number) => ACTS.find(a => n >= a.from && n <= a.to) ?? ACTS[0]

export function DesignMap({ tracks, clips, assets, fps, onClose }: Props) {
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const [sel, setSel] = useState<number | null>(null)
  const [filter, setFilter] = useState<'all' | 'noPerson' | 'warn'>('all')

  const cuts = useMemo<CutInfo[]>(() => {
    const base = deriveCutsWithScene(tracks, clips, assets)
    return base.map(c => {
      let intent = ''; let lyrics = ''
      try {
        const a = c.pin.attrs_json ? JSON.parse(c.pin.attrs_json) : {}
        intent = String(a?.intent ?? '')
        lyrics = String(a?.scene?.board?.lyrics ?? '')
      } catch { /* 壊れたattrsは空扱い */ }
      const refs = [...new Set(
        [...intent.matchAll(/C(\d+)/g)]
          .map(m => Number(m[1]))
          .filter(x => x !== c.idx && x >= 1 && x <= base.length))]
      // ⚠から次の句点/改行までを注意点として拾う
      const warns = [...intent.matchAll(/⚠([^。\n]{4,80})/g)].map(m => m[1].trim())
      return {
        n: c.idx, s: c.s, e: c.e, dur: (c.e - c.s + 1) / fps,
        intent, lyrics, pin: c.pin, refs,
        noPerson: intent.includes('人物なし'), warns,
      }
    })
  }, [tracks, clips, assets, fps])

  const byN = useMemo(() => new Map(cuts.map(c => [c.n, c])), [cuts])

  /** 同じ歌詞を共有するグループ。離れていれば「韻」として強調する。 */
  const lyricGroups = useMemo(() => {
    const m = new Map<string, number[]>()
    for (const c of cuts) {
      const k = c.lyrics.trim()
      if (!k) continue
      m.set(k, [...(m.get(k) ?? []), c.n])
    }
    return [...m.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([k, v]) => ({ lyric: k, cuts: v, far: Math.max(...v) - Math.min(...v) > 5 }))
      .sort((a, b) => Number(b.far) - Number(a.far) || a.cuts[0] - b.cuts[0])
  }, [cuts])

  /** 選択中カットに繋がる相手(双方向) */
  const linked = useMemo(() => {
    if (sel == null) return new Set<number>()
    const out = new Set<number>(byN.get(sel)?.refs ?? [])
    for (const c of cuts) if (c.refs.includes(sel)) out.add(c.n)
    const g = lyricGroups.find(g => g.cuts.includes(sel))
    if (g) for (const n of g.cuts) if (n !== sel) out.add(n)
    return out
  }, [sel, cuts, byN, lyricGroups])

  const shown = cuts.filter(c =>
    filter === 'all' ? true : filter === 'noPerson' ? c.noPerson : c.warns.length > 0)

  const selCut = sel != null ? byN.get(sel) : undefined

  return createPortal(
    <div className="fixed inset-0 z-[120] bg-zinc-950 flex flex-col" onClick={onClose}>
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 flex-shrink-0"
           onClick={e => e.stopPropagation()}>
        <span className="text-sm text-zinc-200">🗺 設計マップ</span>
        <span className="text-[11px] text-zinc-500">
          {cuts.length}カット / 人物なし {cuts.filter(c => c.noPerson).length} / リンク {cuts.reduce((a, c) => a + c.refs.length, 0)}本
        </span>
        <div className="flex gap-1 ml-2">
          {([['all', 'すべて'], ['noPerson', '人物なし'], ['warn', '⚠あり']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)}
                    className={`text-[11px] px-2 py-0.5 rounded border ${
                      filter === k ? 'bg-zinc-700 text-zinc-100 border-zinc-500'
                                   : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:bg-zinc-800'}`}>
              {l}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-zinc-600 ml-auto">
          カットをクリック=詳細と繋がり / ダブルクリック=その時刻へ移動
        </span>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
      </div>

      <div className="flex-1 overflow-auto p-3 flex gap-3" onClick={e => e.stopPropagation()}>
        {/* 左: カットのグリッド(幕ごと) */}
        <div className="flex-1 min-w-0">
          {ACTS.map(act => {
            const list = shown.filter(c => c.n >= act.from && c.n <= act.to)
            if (!list.length) return null
            return (
              <div key={act.name} className="mb-4">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${act.cls}`}>{act.name}</span>
                  <span className="text-[10px] text-zinc-600">
                    C{act.from}-C{act.to} / {cuts.filter(c => c.n >= act.from && c.n <= act.to)
                      .reduce((a, c) => a + c.dur, 0).toFixed(1)}秒
                  </span>
                </div>
                <div className="grid gap-1.5"
                     style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(132px,1fr))' }}>
                  {list.map(c => {
                    const isSel = sel === c.n
                    const isLinked = linked.has(c.n)
                    return (
                      <button key={c.n}
                              onClick={() => setSel(isSel ? null : c.n)}
                              onDoubleClick={() => { setCurrentFrame(c.s); onClose() }}
                              className={`text-left rounded border p-1.5 transition-colors ${
                                isSel ? 'border-amber-400 bg-amber-950/40'
                                : isLinked ? 'border-amber-700 bg-amber-950/20'
                                : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600'}`}>
                        <div className="flex items-center gap-1">
                          <span className="text-[11px] text-zinc-200 font-medium">C{c.n}</span>
                          <span className="text-[9px] text-zinc-500">{c.dur.toFixed(1)}s</span>
                          {c.noPerson && <span className="text-[9px] text-teal-400" title="人物なしカット">◻</span>}
                          {c.warns.length > 0 && (
                            <span className="text-[9px] text-amber-500" title={`${c.warns.length}件の注意`}>
                              ⚠{c.warns.length}
                            </span>
                          )}
                          {c.refs.length > 0 && (
                            <span className="text-[9px] text-zinc-600 ml-auto" title="他カットへの参照">
                              →{c.refs.length}
                            </span>
                          )}
                        </div>
                        {c.lyrics && (
                          <div className="text-[9px] text-sky-300/80 truncate mt-0.5" title={c.lyrics}>
                            {c.lyrics}
                          </div>
                        )}
                        <div className="text-[9px] text-zinc-500 mt-0.5 line-clamp-3 leading-tight">
                          {c.intent.replace(/[⚠*]/g, '')}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {/* 歌詞のグループ(韻) */}
          <div className="mt-5 border-t border-zinc-800 pt-3">
            <div className="text-[11px] text-zinc-300 mb-1.5">🎵 同じ歌詞を共有するカット</div>
            <div className="flex flex-col gap-1">
              {lyricGroups.map(g => (
                <div key={g.lyric}
                     className={`flex items-center gap-2 text-[10px] px-2 py-1 rounded border ${
                       g.far ? 'border-fuchsia-800 bg-fuchsia-950/30' : 'border-zinc-800 bg-zinc-900'}`}>
                  {g.far && <span className="text-fuchsia-400" title="離れた位置での再使用=韻">韻</span>}
                  <span className="flex gap-1">
                    {g.cuts.map(n => (
                      <button key={n} onClick={() => setSel(n)}
                              className={`px-1 rounded ${sel === n ? 'bg-amber-700 text-amber-100'
                                : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}>C{n}</button>
                    ))}
                  </span>
                  <span className="text-zinc-500 truncate">{g.lyric}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 右: 選択カットの詳細 */}
        <div className="w-[340px] flex-shrink-0">
          {selCut ? (
            <div className="sticky top-0 rounded border border-zinc-800 bg-zinc-900 p-2.5">
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-zinc-100">C{selCut.n}</span>
                <span className={`text-[10px] px-1.5 rounded ${actOf(selCut.n).cls}`}>{actOf(selCut.n).name}</span>
                <span className="text-[10px] text-zinc-500">
                  {selCut.dur.toFixed(2)}秒 / f{selCut.s}-{selCut.e}
                </span>
              </div>
              {selCut.lyrics && (
                <div className="mt-2 text-[11px] text-sky-300 bg-sky-950/30 rounded px-2 py-1">
                  {selCut.lyrics}
                </div>
              )}
              {selCut.warns.length > 0 && (
                <div className="mt-2">
                  <div className="text-[10px] text-amber-500 mb-0.5">⚠ 設計上の注意</div>
                  <ul className="flex flex-col gap-0.5">
                    {selCut.warns.map((w, i) => (
                      <li key={i} className="text-[10px] text-amber-200/90 bg-amber-950/20 rounded px-1.5 py-0.5">
                        {w}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {linked.size > 0 && (
                <div className="mt-2">
                  <div className="text-[10px] text-zinc-400 mb-0.5">🔗 繋がっているカット</div>
                  <div className="flex flex-wrap gap-1">
                    {[...linked].sort((a, b) => a - b).map(n => (
                      <button key={n} onClick={() => setSel(n)}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">
                        C{n}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="mt-2 text-[11px] text-zinc-300 whitespace-pre-wrap leading-relaxed max-h-[52vh] overflow-y-auto">
                {selCut.intent}
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-zinc-600 p-3 border border-dashed border-zinc-800 rounded">
              カットを選ぶと、設計・歌詞・⚠注意点・繋がっているカットが出ます。
              <div className="mt-2 text-zinc-700">
                ◻ = 人物なしカット / ⚠n = 注意点の数 / →n = 他カットへの参照数
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
