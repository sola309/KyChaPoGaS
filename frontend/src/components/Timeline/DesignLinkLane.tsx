import { useMemo } from 'react'
import type { Asset, Clip, Track } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { deriveCutsWithScene } from './SceneLane'

/**
 * 🔗 設計リンクレーン — 選択中のカットが、設計上どのカットと呼応しているかを弧で描く。
 *
 * 作った理由: 設計が docs と ピンのattrs_json に分散して29カットの未反映を見落とした
 * (2026-08-23)。**ピンのattrs_jsonを唯一の正**とし、そこから機械的に描く。
 * 表示されないものは存在しない。
 *
 * ポップアップの帯ではなくタイムラインに置く理由: **時間軸が本物だから**。
 * 「深まる Distance point」が C23-24 と C58-59 に離れて出ることが、
 * 弧の長さとして体感できる。ズームすれば近くの呼応が、引けば遠くの呼応が見える。
 *
 * リンクの抽出はすべて自動:
 *   ・intent本文中の「C12」形式の参照(双方向)
 *   ・同じ歌詞を共有するカット
 * 描画は選択カットのぶんだけ。全部描くとスパゲッティになる。
 */
interface Props {
  tracks: Track[]
  clips: Clip[]
  assets: Asset[]
  pixelsPerFrame: number
  totalWidth: number
}

const LANE_H = 46          // 弧を描くぶんの高さ
const REF_COLOR = '#f59e0b'   // 参照(intent中のC番号)
const LYRIC_COLOR = '#d946ef' // 同じ歌詞

interface Cut {
  n: number; s: number; e: number
  intent: string; lyrics: string; refs: number[]
  noPerson: boolean; warnCount: number
}

export function DesignLinkLane({ tracks, clips, assets, pixelsPerFrame, totalWidth }: Props) {
  const currentFrame = useTimelineStore(s => s.currentFrame)
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const designCut = useTimelineStore(s => s.designCut)
  const setDesignCut = useTimelineStore(s => s.setDesignCut)

  const cuts = useMemo<Cut[]>(() => {
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
      return {
        n: c.idx, s: c.s, e: c.e, intent, lyrics, refs,
        noPerson: intent.includes('人物なし'),
        warnCount: (intent.match(/⚠/g) ?? []).length,
      }
    })
  }, [tracks, clips, assets])

  const byN = useMemo(() => new Map(cuts.map(c => [c.n, c])), [cuts])
  // 再生位置のカット。選択が無いときはこれを既定の主役にする
  const nowN = useMemo(
    () => cuts.find(c => currentFrame >= c.s && currentFrame <= c.e)?.n ?? null,
    [cuts, currentFrame])
  const focus = designCut ?? nowN

  /** focus と繋がっている相手。種別(参照/同じ歌詞)を保持する */
  const links = useMemo(() => {
    if (focus == null) return [] as Array<{ to: number; kind: 'ref' | 'lyric' }>
    const f = byN.get(focus)
    if (!f) return []
    const out = new Map<number, 'ref' | 'lyric'>()
    for (const r of f.refs) out.set(r, 'ref')
    for (const c of cuts) if (c.refs.includes(focus) && !out.has(c.n)) out.set(c.n, 'ref')
    const key = f.lyrics.trim()
    if (key) for (const c of cuts) {
      if (c.n !== focus && c.lyrics.trim() === key) out.set(c.n, 'lyric')  // 歌詞一致を優先表示
    }
    return [...out].map(([to, kind]) => ({ to, kind }))
  }, [focus, cuts, byN])

  const mid = (c: Cut) => ((c.s + c.e + 1) / 2) * pixelsPerFrame
  const fCut = focus != null ? byN.get(focus) : undefined

  return (
    <div className="flex flex-shrink-0 border-b border-zinc-800 bg-zinc-950/60" style={{ height: LANE_H }}>
      <div className="w-28 flex-shrink-0 border-r border-zinc-800 px-2 flex flex-col justify-center">
        <span className="text-[10px] text-amber-300 leading-tight">🔗 設計リンク</span>
        <span className="text-[9px] text-zinc-600 leading-tight">
          {focus != null ? `C${focus} → ${links.length}本` : 'カットを選択'}
        </span>
      </div>

      <div className="relative flex-1" style={{ width: totalWidth, minWidth: totalWidth }}>
        {/* 各カットの下辺マーカー(人物なし・注意点の数) */}
        {cuts.map(c => {
          const w = (c.e - c.s + 1) * pixelsPerFrame
          if (w < 3) return null
          const isFocus = c.n === focus
          const lk = links.find(l => l.to === c.n)
          return (
            <button key={c.n}
                    onClick={() => { setDesignCut(isFocus ? null : c.n); setCurrentFrame(c.s) }}
                    title={`C${c.n}${c.lyrics ? ` — ${c.lyrics}` : ''}`}
                    className="absolute bottom-0 h-3 border-r border-zinc-950 hover:brightness-150"
                    style={{
                      left: c.s * pixelsPerFrame, width: w,
                      background: isFocus ? REF_COLOR
                        : lk ? (lk.kind === 'lyric' ? LYRIC_COLOR : '#78350f')
                        : c.noPerson ? '#134e4a' : '#3f3f46',
                      opacity: isFocus || lk ? 1 : 0.55,
                    }}>
              {w > 22 && (
                <span className="absolute inset-0 flex items-center justify-center gap-0.5 text-[8px] text-white/85 leading-none pointer-events-none">
                  {c.noPerson && <span>◻</span>}
                  {c.warnCount > 0 && <span>⚠{c.warnCount}</span>}
                </span>
              )}
            </button>
          )
        })}

        {/* 呼応の弧 — 選択カットのぶんだけ */}
        {fCut && links.length > 0 && (
          <svg className="absolute inset-0 pointer-events-none" width={totalWidth} height={LANE_H}>
            {links.map(({ to, kind }) => {
              const t = byN.get(to)
              if (!t) return null
              const x1 = mid(fCut), x2 = mid(t)
              const top = 4
              // 距離が遠いほど弧を高くして、遠い呼応が目立つようにする
              const rise = Math.min(LANE_H - 16, 8 + Math.abs(x2 - x1) * 0.06)
              const cy = LANE_H - 12 - rise
              return (
                <path key={`${to}-${kind}`}
                      d={`M ${x1} ${LANE_H - 12} Q ${(x1 + x2) / 2} ${Math.max(top, cy)} ${x2} ${LANE_H - 12}`}
                      fill="none"
                      stroke={kind === 'lyric' ? LYRIC_COLOR : REF_COLOR}
                      strokeWidth={kind === 'lyric' ? 1.6 : 1}
                      strokeDasharray={kind === 'lyric' ? undefined : '3 2'}
                      opacity={kind === 'lyric' ? 0.9 : 0.6} />
              )
            })}
          </svg>
        )}
      </div>
    </div>
  )
}
